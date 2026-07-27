import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { brokerError } from './errors.mjs';
import {
  captureVerificationInput,
  deriveVerificationProfile,
  verificationRepositoryRoot
} from './verification-profile.mjs';
import { createWorkSpec, normalizeWorkSpec } from './work-model.mjs';

export const INTENT_SOURCE_KINDS = Object.freeze([
  'sentence',
  'diff',
  'failure',
  'todo',
  'task-record',
  'conventions'
]);

export const NEVER_INFER_FIELDS = Object.freeze([
  'scope widening beyond the stated intent',
  'network access',
  'sandbox disablement',
  'budget increases',
  'allowedPaths',
  'privileges'
]);

const WRITE_MODES = new Set(['implement', 'verify']);
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private.?key|token)[^/]*|[^/]+\.(?:pem|key|p12|pfx|crt|cer))$/i;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_CARD_VALUE = 800;
const CONFIDENCE_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 });

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value, limit = MAX_SOURCE_BYTES) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function provenance(kind, source, detail) {
  return { kind, source: bounded(source, 500), detail: bounded(detail, 500) };
}

function inferredField(value, confidence, sources, options = {}) {
  const confidenceValue = CONFIDENCE_ORDER[confidence] == null ? 'low' : confidence;
  const low = confidenceValue === 'low';
  return {
    value: low ? null : value,
    ...(low && value != null ? { candidate: value } : {}),
    status: low ? 'unresolved' : options.explicit ? 'explicit' : 'inferred',
    confidence: confidenceValue,
    provenance: sources,
    ...(options.note ? { note: options.note } : {})
  };
}

function unresolvedField(sources, note, candidate = null) {
  return {
    value: null,
    ...(candidate != null ? { candidate } : {}),
    status: 'unresolved',
    confidence: 'low',
    provenance: sources,
    note
  };
}

function explicitField(value, source, detail) {
  return inferredField(value, 'high', [provenance('owner-decision', source, detail)], { explicit: true });
}

function normalizeSource(source) {
  if (!isRecord(source) || !INTENT_SOURCE_KINDS.includes(source.kind)) {
    throw brokerError('INVALID_REQUEST', `intent source kind must be one of: ${INTENT_SOURCE_KINDS.join(', ')}`);
  }
  return { ...source };
}

function safeRepositoryFile(root, requested, purpose) {
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw brokerError('INVALID_REQUEST', `${purpose} must be a file inside the repository`);
  }
  if (SENSITIVE_PATH.test(relative)) {
    throw brokerError('INVALID_REQUEST', `${purpose} refuses sensitive path: ${relative}`);
  }
  let stat;
  try { stat = fs.statSync(absolute); }
  catch { throw brokerError('INVALID_REQUEST', `${purpose} does not exist: ${relative}`); }
  if (!stat.isFile()) throw brokerError('INVALID_REQUEST', `${purpose} must be a regular file: ${relative}`);
  if (stat.size > MAX_SOURCE_BYTES) throw brokerError('INVALID_REQUEST', `${purpose} must be at most ${MAX_SOURCE_BYTES} bytes: ${relative}`);
  return { absolute, relative, text: fs.readFileSync(absolute, 'utf8') };
}

function normalizeRepoPath(root, candidate) {
  let value = String(candidate || '').trim()
    .replace(/^['"`]+|['"`,;:.)\]]+$/g, '')
    .replace(/^\.\//, '');
  if (!value || value.includes('\n') || value.startsWith('-')) return null;
  const hashLine = value.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (hashLine) value = hashLine[1];
  if (SENSITIVE_PATH.test(value.replaceAll('\\', '/'))) return null;
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

function extractNamedPaths(root, text) {
  const candidates = [];
  for (const match of String(text || '').matchAll(/`([^`\n]+)`/g)) candidates.push(match[1]);
  for (const match of String(text || '').matchAll(/(?:^|\s)((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+(?:\.[A-Za-z0-9_-]+)?(?::\d+(?::\d+)?)?)/g)) {
    candidates.push(match[1]);
  }
  return uniqueStrings(candidates.map((candidate) => normalizeRepoPath(root, candidate)).filter(Boolean));
}

function statusPaths(root) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) return [];
  const entries = result.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index].slice(0, 2);
    const file = entries[index].slice(3);
    const normalized = normalizeRepoPath(root, file);
    if (normalized) paths.push(normalized);
    if (/[RC]/.test(status) && entries[index + 1]) {
      const source = normalizeRepoPath(root, entries[++index]);
      if (source) paths.push(source);
    }
  }
  return uniqueStrings(paths);
}

function sectionValue(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(
    `^(?:#{1,6}\\s*)?${escaped}\\s*:\\s*(.*(?:\\n(?!\\s*(?:#{1,6}\\s*)?[A-Za-z][^\\n]{0,60}:).*)*)`,
    'im'
  ));
  return match ? bounded(match[1]).trim() : null;
}

function listValue(text) {
  return uniqueStrings(String(text || '').split(/\r?\n|;/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean));
}

function todoEvidence(root, source) {
  const requested = source.path || source.value;
  if (!requested) throw brokerError('INVALID_REQUEST', 'TODO source requires a repository-relative path');
  const parsed = String(requested).match(/^(.*?)(?::(\d+))?$/);
  const file = safeRepositoryFile(root, parsed?.[1] || requested, 'TODO source');
  const lines = file.text.split(/\r?\n/);
  const requestedLine = source.line ?? (parsed?.[2] ? Number(parsed[2]) : null);
  let index = Number.isSafeInteger(requestedLine) && requestedLine > 0 ? requestedLine - 1 : -1;
  if (index < 0 || index >= lines.length || !/\bTODO\b/i.test(lines[index])) {
    index = lines.findIndex((line) => /\bTODO\b/i.test(line));
  }
  if (index < 0) throw brokerError('INVALID_REQUEST', `TODO source contains no TODO comment: ${file.relative}`);
  const raw = bounded(lines[index], 2_000);
  const text = raw.replace(/^.*?\bTODO\b\s*[:(-]?\s*/i, '').replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
  return {
    kind: 'todo',
    label: `${file.relative}:${index + 1}`,
    text: text || raw.trim(),
    paths: [file.relative],
    acceptanceCriteria: [`The TODO at ${file.relative}:${index + 1} is implemented and the stale TODO marker is removed or updated.`]
  };
}

function taskRecordEvidence(root, source) {
  let record = source.record;
  let label = source.label || 'inline task record';
  if (!isRecord(record)) {
    const file = safeRepositoryFile(root, source.path || source.value, 'task record');
    try { record = JSON.parse(file.text); }
    catch { throw brokerError('INVALID_REQUEST', `task record must contain JSON: ${file.relative}`); }
    label = file.relative;
  }
  if (!isRecord(record)) throw brokerError('INVALID_REQUEST', 'task record must be a JSON object');
  const spec = isRecord(record.workSpec) ? record.workSpec : isRecord(record.spec) ? record.spec : record;
  const objective = bounded(spec.objective || record.objective || record.promptSummary || record.title || '');
  const scopeClaim = Array.isArray(spec.scopeClaim) ? uniqueStrings(spec.scopeClaim)
    : Array.isArray(record.allowedPaths) ? uniqueStrings(record.allowedPaths) : [];
  const acceptanceCriteria = Array.isArray(spec.acceptanceCriteria)
    ? uniqueStrings(spec.acceptanceCriteria)
    : Array.isArray(record.acceptanceCriteria) ? uniqueStrings(record.acceptanceCriteria) : [];
  const verifyRecipe = isRecord(spec.verifyRecipe) ? spec.verifyRecipe
    : isRecord(record.verify) ? record.verify : null;
  const budget = isRecord(spec.budget) ? spec.budget : isRecord(record.budget) ? record.budget : null;
  return {
    kind: 'task-record',
    label,
    text: objective,
    paths: scopeClaim.map((candidate) => normalizeRepoPath(root, candidate)).filter(Boolean),
    acceptanceCriteria,
    verifyRecipe,
    budget,
    recordAllowedPaths: Array.isArray(record.allowedPaths) ? uniqueStrings(record.allowedPaths) : []
  };
}

function failureEvidence(root, source) {
  const text = bounded(source.text || source.value);
  if (!text) throw brokerError('INVALID_REQUEST', 'failure source requires check output text');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.find((line) => /(?:\bFAIL(?:ED|URE)?\b|\bERROR\b|AssertionError|SyntaxError|TypeError)/i.test(line))
    || lines[0]
    || 'failing check';
  return {
    kind: 'failure',
    label: source.label || 'provided failing check output',
    text: bounded(diagnostic, 500),
    paths: extractNamedPaths(root, text),
    acceptanceCriteria: [`The reported failing check no longer reproduces: ${bounded(diagnostic, 300)}`]
  };
}

function sentenceEvidence(root, source) {
  const text = bounded(source.text || source.value);
  if (!text) throw brokerError('INVALID_REQUEST', 'sentence source requires intent text');
  const objective = sectionValue(text, 'Objective') || text;
  const scopeText = sectionValue(text, 'Allowed scope');
  const acceptanceText = sectionValue(text, 'Acceptance criteria');
  return {
    kind: 'sentence',
    label: source.label || 'owner intent',
    text: objective,
    paths: scopeText ? listValue(scopeText).map((candidate) => normalizeRepoPath(root, candidate)).filter(Boolean) : extractNamedPaths(root, text),
    acceptanceCriteria: acceptanceText ? listValue(acceptanceText) : [],
    structuredObjective: Boolean(sectionValue(text, 'Objective')),
    structuredScope: Boolean(scopeText),
    structuredAcceptance: Boolean(acceptanceText)
  };
}

function diffEvidence(root, source) {
  const paths = statusPaths(root);
  return {
    kind: 'diff',
    label: source.label || 'current Git working-tree diff',
    text: paths.length
      ? `Complete the current working-tree change across ${paths.length} observed path${paths.length === 1 ? '' : 's'}.`
      : '',
    paths,
    acceptanceCriteria: []
  };
}

function conventionsEvidence(profile) {
  return {
    kind: 'conventions',
    label: profile.recipe?.source?.path || profile.repoRoot,
    text: '',
    paths: [],
    acceptanceCriteria: []
  };
}

function materializeSources(root, sources, profile) {
  return sources.map(normalizeSource).map((source) => {
    if (source.kind === 'sentence') return sentenceEvidence(root, source);
    if (source.kind === 'diff') return diffEvidence(root, source);
    if (source.kind === 'failure') return failureEvidence(root, source);
    if (source.kind === 'todo') return todoEvidence(root, source);
    if (source.kind === 'task-record') return taskRecordEvidence(root, source);
    return conventionsEvidence(profile);
  });
}

function objectiveField(evidence, explicit) {
  if (explicit) return explicitField(bounded(explicit), 'objective', 'Objective supplied explicitly for this compilation.');
  const priorities = ['sentence', 'task-record', 'todo', 'failure', 'diff'];
  for (const kind of priorities) {
    const source = evidence.find((item) => item.kind === kind && item.text);
    if (!source) continue;
    const confidence = kind === 'sentence' || kind === 'task-record' || kind === 'todo' ? 'high' : 'medium';
    return inferredField(source.kind === 'failure' ? `Fix the failing check: ${source.text}` : source.text, confidence, [
      provenance(`intent:${source.kind}`, source.label, `Objective derived from the ${source.kind} evidence.`)
    ]);
  }
  return unresolvedField(
    evidence.map((source) => provenance(`intent:${source.kind}`, source.label, 'This source does not declare an objective.')),
    'No source states what outcome should be achieved.'
  );
}

function scopeField(root, evidence, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicitField(uniqueStrings(explicit), 'allowedPaths', 'Owner supplied the write fence; WorkSpec scope matches it exactly.');
  }
  const structured = evidence.find((source) => source.kind === 'sentence' && source.structuredScope && source.paths.length);
  if (structured) {
    return inferredField(structured.paths, 'high', [
      provenance('intent:sentence', structured.label, 'Paths were read from the explicit Allowed scope section.')
    ]);
  }
  const record = evidence.find((source) => source.kind === 'task-record' && source.paths.length);
  if (record) {
    return inferredField(record.paths, 'medium', [
      provenance('intent:task-record', record.label, 'Scope claim copied from the task record for owner confirmation.')
    ], { note: 'This does not grant allowedPaths; the write fence remains an explicit owner decision.' });
  }
  const todo = evidence.find((source) => source.kind === 'todo' && source.paths.length);
  if (todo) {
    return inferredField(todo.paths, 'medium', [
      provenance('intent:todo', todo.label, 'The TODO file is the narrowest scope directly implied by the source.')
    ], { note: 'Related implementation paths may be required; confirmation may narrow or explicitly widen this claim.' });
  }
  const diff = evidence.find((source) => source.kind === 'diff' && source.paths.length);
  if (diff) {
    return inferredField(diff.paths, 'medium', [
      provenance('repo:git-status', root, 'Scope candidate is exactly the current changed-path inventory; file contents were not read.')
    ]);
  }
  const sentence = evidence.find((source) => source.kind === 'sentence' && source.paths.length);
  if (sentence) {
    return inferredField(sentence.paths, 'medium', [
      provenance('intent:sentence', sentence.label, 'Only repository-relative paths named by the owner were retained.')
    ]);
  }
  const failure = evidence.find((source) => source.kind === 'failure' && source.paths.length);
  if (failure) {
    return unresolvedField([
      provenance('intent:failure', failure.label, 'Diagnostic paths are evidence, but a failure location does not establish the full safe write scope.')
    ], 'Failure output cannot safely establish a complete scope.', failure.paths);
  }
  return unresolvedField(
    evidence.map((source) => provenance(`intent:${source.kind}`, source.label, 'No safe path boundary was present.')),
    'No scope could be derived without guessing or widening the intent.'
  );
}

function acceptanceField(evidence, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicitField(uniqueStrings(explicit), 'acceptanceCriteria', 'Acceptance criteria supplied explicitly for this compilation.');
  }
  const structured = evidence.find((source) => source.kind === 'sentence' && source.structuredAcceptance && source.acceptanceCriteria.length);
  if (structured) {
    return inferredField(structured.acceptanceCriteria, 'high', [
      provenance('intent:sentence', structured.label, 'Criteria were read from the explicit Acceptance criteria section.')
    ]);
  }
  const record = evidence.find((source) => source.kind === 'task-record' && source.acceptanceCriteria.length);
  if (record) {
    return inferredField(record.acceptanceCriteria, 'high', [
      provenance('intent:task-record', record.label, 'Criteria were copied from the task record.')
    ]);
  }
  const failure = evidence.find((source) => source.kind === 'failure');
  if (failure) {
    return inferredField(failure.acceptanceCriteria, 'medium', [
      provenance('intent:failure', failure.label, 'The concrete reported failure supplies one mechanical criterion.')
    ], { note: 'Add semantic criteria when passing the check alone would not prove the objective.' });
  }
  const todo = evidence.find((source) => source.kind === 'todo');
  if (todo) {
    return inferredField(todo.acceptanceCriteria, 'medium', [
      provenance('intent:todo', todo.label, 'The TODO location supplies a directly observable completion criterion.')
    ]);
  }
  const sentence = evidence.find((source) => source.kind === 'sentence' && source.text);
  if (sentence) {
    const candidate = [`The requested outcome is demonstrably satisfied: ${bounded(sentence.text, 400)}`];
    return unresolvedField([
      provenance('intent:sentence', sentence.label, 'A plain sentence states an objective but not an independently testable success condition.')
    ], 'Acceptance criteria require an explicit owner decision.', candidate);
  }
  return unresolvedField(
    evidence.map((source) => provenance(`intent:${source.kind}`, source.label, 'This evidence does not define semantic success.')),
    'No acceptance criterion could be derived without inventing one.'
  );
}

function verifyField(profile, evidence, explicit) {
  if (isRecord(explicit)) {
    if (explicit.command) {
      return explicitField({
        command: bounded(explicit.command, 8_000),
        timeoutSeconds: Number(explicit.timeoutSeconds || 600)
      }, 'verifyRecipe', 'Verification command supplied explicitly for this compilation.');
    }
    if (explicit.exception) {
      return explicitField({
        exception: bounded(explicit.exception, 1_000),
        reason: bounded(explicit.reason || explicit.exception, 1_000)
      }, 'verifyRecipe', 'No-check exception supplied explicitly for this compilation.');
    }
  }
  const record = evidence.find((source) => source.kind === 'task-record' && isRecord(source.verifyRecipe));
  if (record) {
    const normalized = normalizeWorkSpec({ verifyRecipe: record.verifyRecipe }).verifyRecipe;
    if (normalized) {
      return inferredField(normalized, 'medium', [
        provenance('intent:task-record', record.label, 'Verification recipe copied from the task record for confirmation.')
      ]);
    }
  }
  if (profile.recipe?.commands?.length) {
    const commands = profile.recipe.commands.map((entry) => ({ ...entry }));
    return inferredField({
      command: commands[0].command,
      commands,
      timeoutSeconds: Number(profile.recipe.timeoutSeconds || 600),
      source: profile.recipe.source
    }, 'high', [
      provenance(
        `repo:${profile.recipe.source?.kind || 'profile'}`,
        profile.recipe.source?.path || profile.repoRoot,
        `P3 verification profile precedence selected this recipe${profile.recipe.source?.sections?.length ? ` from ${profile.recipe.source.sections.join(', ')}` : ''}.`
      )
    ]);
  }
  return unresolvedField([
    provenance('repo:verification-profile', profile.repoRoot, profile.noRecipeReason || 'No reliable non-mutating verification command was found.')
  ], 'Choose an explicit verification command or record a no-reliable-check exception.');
}

function validBudget(value) {
  if (!isRecord(value)) return null;
  const budget = {
    wallTimeSeconds: Number(value.wallTimeSeconds),
    maxRounds: Number(value.maxRounds),
    maxOutputTokens: Number(value.maxOutputTokens)
  };
  return Object.values(budget).every((item) => Number.isSafeInteger(item) && item > 0) ? budget : null;
}

function budgetField(evidence, explicit) {
  const explicitBudget = validBudget(explicit);
  if (explicitBudget) {
    return explicitField(explicitBudget, 'budget', 'Wall time, rounds, and output-token cap supplied explicitly for this compilation.');
  }
  const record = evidence.find((source) => source.kind === 'task-record' && validBudget(source.budget));
  if (record) {
    return inferredField(validBudget(record.budget), 'medium', [
      provenance('intent:task-record', record.label, 'Initial budget copied from the task record; any increase remains a new owner decision.')
    ]);
  }
  const candidate = isRecord(explicit) ? {
    wallTimeSeconds: Number(explicit.wallTimeSeconds) || null,
    maxRounds: Number(explicit.maxRounds) || null,
    maxOutputTokens: Number(explicit.maxOutputTokens) || null
  } : null;
  return unresolvedField([
    provenance('owner-decision', 'budget', 'The compiler has no safe repository convention for allowance or work-item round limits.')
  ], 'Set wallTimeSeconds, maxRounds, and maxOutputTokens explicitly; no budget dimension is silently omitted.', candidate);
}

function baseField(cwd) {
  const input = captureVerificationInput(cwd);
  if (!input.revision) {
    return unresolvedField([
      provenance('repo:git', input.repoRoot, 'Git HEAD could not be resolved for an immutable WorkSpec base.')
    ], 'A repository revision is required for the WorkSpec base.');
  }
  return inferredField({
    revision: input.revision,
    dirtyHashes: { '.': input.digest }
  }, 'high', [
    provenance('repo:git', input.repoRoot, 'Base is HEAD plus a metadata-only working-tree digest; source contents were not persisted.')
  ]);
}

function cardValue(value) {
  if (value == null) return '<unresolved>';
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${bounded(item, MAX_CARD_VALUE)}`).join('\n') : '<empty>';
  if (isRecord(value)) return Object.entries(value)
    .filter(([key]) => key !== 'source')
    .map(([key, item]) => `${key}=${typeof item === 'string' ? bounded(item, MAX_CARD_VALUE) : JSON.stringify(item)}`)
    .join(', ');
  return bounded(value, MAX_CARD_VALUE);
}

function fieldCard(label, field) {
  const lines = [`${label} [${field.confidence.toUpperCase()} · ${field.status.toUpperCase()}]`];
  const value = field.value ?? field.candidate;
  for (const line of cardValue(value).split('\n')) lines.push(`  ${line}`);
  for (const source of field.provenance || []) {
    lines.push(`  why: ${source.kind} · ${source.source}${source.detail ? ` — ${source.detail}` : ''}`);
  }
  if (field.note) lines.push(`  note: ${field.note}`);
  return lines;
}

function authorityProjection(authority, mode) {
  const allowedPaths = uniqueStrings(authority.allowedPaths);
  const privilege = [];
  if (authority.approval && authority.approval !== 'auto') privilege.push(`approval=${authority.approval}`);
  if (authority.allowSensitive === true) privilege.push('allowSensitive=true');
  if (authority.overrideLimit === true) privilege.push('overrideLimit=true');
  if (authority.overrideWriter === true) privilege.push('overrideWriter=true');
  if (authority.overrideLane === true) privilege.push('overrideLane=true');
  if (authority.approveMcps === true) privilege.push('approveMcps=true');
  if (authority.cursorWorktree === true) privilege.push('cursorWorktree=true');
  if (authority.isolation === 'worktree') privilege.push('isolation=worktree');
  for (const item of uniqueStrings(authority.pathClaims)) privilege.push(`pathClaim=${item}`);
  for (const item of uniqueStrings(authority.resourceClaims)) privilege.push(`resourceClaim=${item}`);
  for (const item of uniqueStrings(authority.networkAllow)) privilege.push(`networkAllow=${item}`);
  for (const item of uniqueStrings(authority.addDirs)) privilege.push(`addDir=${item}`);
  for (const item of uniqueStrings(authority.ingestFiles)) privilege.push(`ingestFile=${item}`);
  if (authority.cursorWorktreeBase) privilege.push(`cursorWorktreeBase=${authority.cursorWorktreeBase}`);
  return {
    allowedPaths: {
      value: allowedPaths.length ? allowedPaths : null,
      status: allowedPaths.length ? 'explicit' : WRITE_MODES.has(mode) ? 'unresolved' : 'not-required',
      confidence: allowedPaths.length ? 'high' : 'low',
      provenance: [provenance(
        'owner-decision',
        'allowedPaths',
        allowedPaths.length ? 'Explicit write fence supplied by the owner.' : 'The compiler never converts an inferred scope claim into write authority.'
      )]
    },
    network: {
      value: authority.network === true ? 'enabled explicitly' : 'not requested',
      status: authority.network === true ? 'explicit' : 'safe-default',
      provenance: [provenance('owner-decision', 'network', 'Network is never inferred by the compiler.')]
    },
    sandbox: {
      value: authority.sandbox === 'off' ? 'off explicitly' : 'broker default',
      status: authority.sandbox === 'off' ? 'explicit' : 'safe-default',
      provenance: [provenance('owner-decision', 'sandbox', 'Sandbox disablement is never inferred by the compiler.')]
    },
    privileges: {
      value: privilege.length ? privilege : ['none requested'],
      status: privilege.length ? 'explicit' : 'safe-default',
      provenance: [provenance('owner-decision', 'privileges', 'Privilege fields are copied only from explicit launch options.')]
    },
    budgetIncreases: {
      value: 'not authorized',
      status: 'owner-only',
      provenance: [provenance('owner-decision', 'budget increases', 'Confirmation approves only the displayed initial budget.')]
    }
  };
}

function packetFromCompilation(compilation) {
  const spec = compilation.workSpec;
  const criteria = spec.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n');
  const scope = spec.scopeClaim === 'repo-wide' ? 'repo-wide' : spec.scopeClaim.map((item) => `- ${item}`).join('\n');
  const verificationCommands = Array.isArray(spec.verifyRecipe.commands) && spec.verifyRecipe.commands.length
    ? spec.verifyRecipe.commands
    : spec.verifyRecipe.command ? [{ command: spec.verifyRecipe.command, cwd: '.' }] : [];
  const verify = verificationCommands.length
    ? `Run exactly:\n${verificationCommands.map((entry, index) => `${index + 1}. cwd ${entry.cwd || '.'}\n\`\`\`sh\n${entry.command}\n\`\`\``).join('\n')}`
    : `Recorded exception: ${spec.verifyRecipe.exception}\nReason: ${spec.verifyRecipe.reason}`;
  const sourceLines = compilation.sources
    .map((source) => `- ${source.kind}: ${source.label}${source.summary ? ` — ${source.summary}` : ''}`)
    .join('\n');
  return `Objective:
${spec.objective}

Mode:
${compilation.mode}

Allowed scope:
${scope}

Relevant context:
Intent sources:
${sourceLines}
Repository base: ${spec.base.revision}

Constraints and non-goals:
- Preserve pre-existing work and stay inside the confirmed scope.
- Do not widen allowed paths, privileges, network, sandbox, or budget.
- A completed write job with zero changed files is a failed objective.

Acceptance criteria:
${criteria}

Required verification:
${verify}

Budget:
- wall time: ${spec.budget.wallTimeSeconds} seconds
- rounds: ${spec.budget.maxRounds}
- output tokens: ${spec.budget.maxOutputTokens}

Stop and report when:
- The objective requires scope, privilege, network, sandbox, or budget beyond this confirmed WorkSpec.
- A required field or repository fact proves ambiguous or stale.

Return:
Report the outcome, changed files, verification evidence, and any remaining risks or blockers.`;
}

function compilationDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify({
    mode: value.mode,
    workSpec: value.workSpec,
    fields: value.fields,
    authority: value.authority,
    sources: value.sources
  })).digest('hex');
}

export function renderWorkSpecCard(compilation) {
  const lines = [
    '┌─ WorkSpec confirmation ─────────────────────────────────────────',
    ...fieldCard('Objective', compilation.fields.objective),
    ...fieldCard('Scope claim', compilation.fields.scopeClaim),
    ...fieldCard('Acceptance criteria', compilation.fields.acceptanceCriteria),
    ...fieldCard('Verification', compilation.fields.verifyRecipe),
    ...fieldCard('Budget', compilation.fields.budget),
    ...fieldCard('Immutable base', compilation.fields.base),
    'Authority (never inferred)'
  ];
  for (const [key, value] of Object.entries(compilation.authority)) {
    lines.push(`  ${key}: ${cardValue(value.value)} [${value.status.toUpperCase()}]`);
    for (const source of value.provenance || []) lines.push(`    why: ${source.detail}`);
  }
  lines.push(`Never infer: ${NEVER_INFER_FIELDS.join('; ')}`);
  if (compilation.unresolved.length) {
    lines.push(`UNRESOLVED: ${compilation.unresolved.join(', ')}`);
    lines.push('WRITE DISPATCH: BLOCKED');
  } else {
    lines.push('WRITE DISPATCH: READY FOR EXPLICIT CONFIRMATION');
  }
  lines.push(`Spec digest: ${compilation.digest}`, '└─────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

export function compileIntentSpec(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const root = verificationRepositoryRoot(cwd);
  // Compilation is a read-only derivation step. It deliberately bypasses the
  // P3 cache so a confirmation preview never mutates broker state.
  const profile = deriveVerificationProfile(cwd, { cache: false });
  const inputSources = Array.isArray(options.sources) && options.sources.length
    ? options.sources
    : [{ kind: 'conventions' }];
  const evidence = materializeSources(root, inputSources, profile);
  const explicit = isRecord(options.explicit) ? options.explicit : {};
  const authority = authorityProjection(isRecord(options.authority) ? options.authority : {}, options.mode || 'implement');
  const fields = {
    objective: objectiveField(evidence, explicit.objective),
    scopeClaim: scopeField(root, evidence, explicit.scopeClaim),
    acceptanceCriteria: acceptanceField(evidence, explicit.acceptanceCriteria),
    verifyRecipe: verifyField(profile, evidence, explicit.verifyRecipe),
    budget: budgetField(evidence, explicit.budget),
    base: baseField(cwd)
  };
  const unresolved = Object.entries(fields)
    .filter(([, field]) => field.status === 'unresolved' || field.confidence === 'low')
    .map(([name]) => name);
  if (authority.allowedPaths.status === 'unresolved') unresolved.push('authority.allowedPaths');
  const draft = normalizeWorkSpec({
    objective: fields.objective.value,
    scopeClaim: fields.scopeClaim.value,
    acceptanceCriteria: fields.acceptanceCriteria.value || [],
    verifyRecipe: fields.verifyRecipe.value,
    budget: fields.budget.value,
    base: fields.base.value
  });
  const compilation = {
    schemaVersion: 1,
    mode: options.mode || 'implement',
    cwd,
    repoRoot: root,
    sources: evidence.map(({ kind, label, paths, text }) => ({
      kind,
      label,
      paths,
      ...(text ? { summary: bounded(text, 500) } : {})
    })),
    fields,
    authority,
    unresolved: uniqueStrings(unresolved),
    draft,
    workSpec: null,
    ready: unresolved.length === 0,
    confirmed: false,
    confirmation: null,
    packet: null
  };
  if (compilation.ready) {
    compilation.workSpec = createWorkSpec(draft);
    compilation.packet = packetFromCompilation(compilation);
  }
  compilation.digest = compilationDigest(compilation);
  compilation.card = renderWorkSpecCard(compilation);
  return compilation;
}

export function confirmCompiledSpec(compilation, method = 'interactive') {
  if (!isRecord(compilation) || compilation.ready !== true || !compilation.workSpec || !compilation.packet) {
    const unresolved = Array.isArray(compilation?.unresolved) ? compilation.unresolved.join(', ') : 'unknown fields';
    throw brokerError('INVALID_REQUEST', `WorkSpec cannot be confirmed while unresolved: ${unresolved}`);
  }
  if (!['interactive', 'automation-flag', 'tui'].includes(method)) {
    throw brokerError('INVALID_REQUEST', 'WorkSpec confirmation method must be interactive, automation-flag, or tui');
  }
  return {
    ...compilation,
    confirmed: true,
    confirmation: {
      method,
      digest: compilation.digest
    }
  };
}

function compiledLaunchOptions(compilation) {
  if (!compilation?.ready || !compilation?.workSpec || !compilation?.packet) {
    throw brokerError('INVALID_REQUEST', 'compiled WorkSpec is incomplete');
  }
  const explicitVerify = compilation.fields.verifyRecipe.status === 'explicit'
    ? compilation.workSpec.verifyRecipe : null;
  return {
    prompt: compilation.packet,
    workSpec: compilation.workSpec,
    specCompilation: {
      schemaVersion: compilation.schemaVersion,
      digest: compilation.digest,
      confirmed: compilation.confirmed === true,
      confirmation: compilation.confirmation,
      sources: compilation.sources,
      fields: compilation.fields,
      authority: compilation.authority,
      neverInfer: NEVER_INFER_FIELDS
    },
    timeoutSeconds: compilation.workSpec.budget.wallTimeSeconds,
    maxOutputTokens: compilation.workSpec.budget.maxOutputTokens,
    ...(explicitVerify ? { verify: explicitVerify } : {})
  };
}

export function previewOptionsFromCompilation(compilation) {
  return compiledLaunchOptions(compilation);
}

export function launchOptionsFromCompilation(compilation) {
  if (!compilation?.confirmed) throw brokerError('INVALID_REQUEST', 'compiled WorkSpec requires explicit confirmation before launch');
  return compiledLaunchOptions(compilation);
}
