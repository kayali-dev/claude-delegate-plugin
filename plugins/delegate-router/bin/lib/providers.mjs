import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendJobEvent, claimCommands, completeCommand, DeltaRedactor, hashWorkingFile, inspectJob, jobFiles, pathMatchesScope, redact, settleQueuedControl, updateManagedJob } from './control.mjs';
import {
  availableModelIds,
  buildCursorArgs,
  findValue,
  resolveCursorBinary,
  resolveCursorModel,
  runCursor
} from './cursor.mjs';
import { delay, JsonRpcProcess } from './jsonrpc.mjs';
import { terminateProcessTree } from './process.mjs';
import { loadJob, mutateState, setWindow } from './state.mjs';

// The base boundary always applies. allowSensitive only swaps the sensitive-
// path rule for an explicit authorization line; it never removes scope control
// or the preserve-existing-changes rule.
export function securityPreamble(allowSensitive) {
  const sensitiveRule = allowSensitive
    ? '- Sensitive-path access is explicitly authorized for this task; touch only the sensitive paths the task names.'
    : '- Do not read, print, transmit, or modify credentials, private keys, tokens, or .env files unless the task explicitly authorizes the exact path. Running project tooling that consumes them internally (builds, tests, dev servers reading .env) is allowed and expected; never echo, copy, or relocate their contents yourself.';
  return `Security boundary:
${sensitiveRule}
- Preserve pre-existing changes and never revert unrelated work.
- Stay inside the task's allowed scope. Stop and report if required work falls outside it.

`;
}

function promptFor(job) {
  const scope = job.allowedPaths?.length
    ? `Allowed write scope (hard fence): create or modify files only under: ${job.allowedPaths.join(', ')}. If required work falls outside this set, stop and report instead of editing.\n\n`
    : '';
  return `${securityPreamble(job.allowSensitive)}${scope}${fs.readFileSync(job.promptPath, 'utf8')}`;
}

function codexModel(model) {
  return ({ sol: 'gpt-5.6-sol', terra: 'gpt-5.6-terra', luna: 'gpt-5.6-luna' })[model] || (model === 'auto' ? null : model);
}

function readOnly(job) {
  return ['consult', 'plan', 'review'].includes(job.mode);
}

function boundedTimeoutMs(name, fallbackSeconds, maximumSeconds = 86400) {
  const value = Number(process.env[name] || fallbackSeconds);
  const seconds = Number.isFinite(value) ? Math.min(Math.max(value, 10), maximumSeconds) : fallbackSeconds;
  return seconds * 1000;
}

function jobTimeoutMs(job, name, fallbackSeconds, maximumSeconds = 86400) {
  if (Number.isFinite(job?.timeoutSeconds) && job.timeoutSeconds > 0) {
    return Math.min(Math.max(job.timeoutSeconds, 60), maximumSeconds) * 1000;
  }
  return boundedTimeoutMs(name, fallbackSeconds, maximumSeconds);
}

function acpGraceMs() {
  const value = Number(process.env.DELEGATE_ACP_GRACE_MS || 250);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 2000) : 250;
}

function terminal(job, status, phase, extra = {}) {
  // The worker's final message is self-reported and can contradict what it
  // actually did; record the plugin's own observation of changed files so the
  // coordinator's first read of the job record is grounded.
  let changedFiles = null;
  let scopeViolations = null;
  if (['implement', 'verify'].includes(job.mode)) {
    try {
      const files = jobFiles(job.id);
      const names = files.map((file) => file.path);
      changedFiles = { count: names.length, files: names.slice(0, 50) };
      if (job.allowedPaths?.length) {
        const violations = files.filter((file) => !pathMatchesScope(file.path, job.allowedPaths));
        if (violations.length) {
          scopeViolations = violations.slice(0, 50).map((file) => ({
            path: file.path,
            ...(file.preexisting ? { preexisting: true } : {}),
            ...(file.overlapsPreexisting ? { overlapsPreexisting: true } : {})
          }));
          appendJobEvent(job.id, 'scope.violation', { count: violations.length, files: scopeViolations });
        }
      }
    } catch {}
  }
  updateManagedJob(job.id, (current) => {
    current.status = status;
    current.phase = phase;
    current.completedAt = Math.floor(Date.now() / 1000);
    if (changedFiles) current.changedFiles = changedFiles;
    if (scopeViolations) current.scopeViolations = scopeViolations;
    Object.assign(current, redact(extra));
    // Providers return three different result shapes (Codex plain string,
    // Cursor ACP {text, plan, stopReason}, Cursor headless CLI envelope);
    // resultText is the one field consumers can always read.
    const text = current.result == null ? null
      : typeof current.result === 'string' ? current.result
      : typeof current.result.text === 'string' && current.result.text ? current.result.text
      : typeof current.result.result === 'string' ? current.result.result
      : null;
    if (text != null) current.resultText = text;
    // A read-mode turn that ends with a sentence of narration instead of the
    // findings is a recurring provider pattern; flag it so the coordinator
    // resumes with "paste the full findings now" instead of trusting it.
    if (status === 'completed' && ['consult', 'plan', 'review'].includes(job.mode)
      && !current.result?.plan && (!text || text.trim().length < 200)) {
      current.resultSuspect = 'short-final-message';
    }
  });
  appendJobEvent(job.id, status === 'completed' ? 'job.completed' : status === 'cancelled' ? 'job.cancelled' : 'error', extra);
}

function recordSession(jobId, sessionId, turnId = undefined) {
  updateManagedJob(jobId, (job) => {
    if (sessionId) {
      job.providerSessionId = sessionId;
      job.session = sessionId;
    }
    if (turnId !== undefined) job.providerTurnId = turnId;
    job.phase = turnId ? 'running' : job.phase;
  });
  appendJobEvent(jobId, 'session.updated', { sessionId, turnId });
}

function mapCodexItem(jobId, phase, params) {
  const item = params.item || {};
  const options = { sessionId: params.threadId, turnId: params.turnId };
  if (item.type === 'agentMessage' && phase === 'completed') {
    appendJobEvent(jobId, 'message.completed', { id: item.id, text: item.text, phase: item.phase }, options);
    updateManagedJob(jobId, (job) => { job.result = redact(item.text); }, { incrementRevision: false });
  } else if (item.type === 'plan') {
    appendJobEvent(jobId, 'plan.updated', { id: item.id, text: item.text, phase }, options);
  } else if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall') {
    // Collab-agent items mean the thread engaged Codex's multi-agent review
    // flow; such threads refuse direct resume. Mark the job so delegate_resume
    // can fail fast with the recovery instead of a provider round-trip.
    if (item.type === 'collabAgentToolCall') {
      updateManagedJob(jobId, (job) => { job.reviewFlowEngaged = true; }, { incrementRevision: false });
    }
    const type = phase === 'started' ? 'tool.started' : 'tool.completed';
    appendJobEvent(jobId, type, { item }, options);
  } else if (item.type === 'fileChange') {
    appendJobEvent(jobId, 'file.changed', { changes: item.changes || [], status: item.status, phase }, options);
  } else if (item.type !== 'reasoning' && item.type !== 'userMessage') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: `item/${phase}`, itemType: item.type, itemId: item.id }, options);
  }
}

// sandbox: 'off' maps to Codex danger-full-access — the job explicitly needs
// host tools (git, CLIs, live web). Web search follows the same intent: it is
// enabled whenever the job has any form of outside access.
export function codexSandboxMode(job) {
  if (job.sandbox === 'off') return 'danger-full-access';
  return readOnly(job) ? 'read-only' : 'workspace-write';
}

export function codexSpawnArgs(job) {
  return [
    'app-server', '--stdio',
    '-c', 'approval_policy="on-request"',
    '-c', 'approvals_reviewer="auto_review"',
    '-c', `sandbox_workspace_write.network_access=${job.network === true}`,
    '-c', `tools.web_search=${job.network === true || job.sandbox === 'off'}`,
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'
  ];
}

async function runCodex(job) {
  let turnDone = null;
  let turnResolve;
  let cancelled = false;
  const queuedPrompts = [];
  let interruptRequested = false;
  const messages = new Map();
  const deltas = new DeltaRedactor();
  const rpc = new JsonRpcProcess(process.env.DELEGATE_CODEX_BIN || 'codex', codexSpawnArgs(job), {
    cwd: job.cwd,
    onStderr: (text) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text: deltas.redactDelta('stderr', text) }),
    onRequest: async (method, params) => {
      appendJobEvent(job.id, 'approval.requested', { method, params });
      const forced = job.approval === 'force';
      let result;
      if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') result = { decision: forced ? 'accept' : 'decline' };
      else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') result = { decision: forced ? 'accept' : 'decline' };
      else if (method === 'item/tool/requestUserInput') {
        appendJobEvent(job.id, 'error', { code: 'USER_INPUT_REQUIRED', message: 'Codex requested interactive input; managed v1 does not fabricate an answer', request: params });
        throw new Error('USER_INPUT_REQUIRED: inspect the request and resume the job with an explicit answer');
      }
      else throw new Error(`Unsupported app-server request: ${method}`);
      appendJobEvent(job.id, 'approval.resolved', { method, decision: result.decision || 'empty' });
      return result;
    },
    onNotification: async (method, params) => {
      const options = { sessionId: params.threadId, turnId: params.turnId || params.turn?.id };
      if (method === 'turn/started') {
        const turnId = params.turn?.id;
        recordSession(job.id, params.threadId, turnId);
        appendJobEvent(job.id, 'turn.started', { turn: params.turn }, options);
      } else if (method === 'item/agentMessage/delta') {
        const text = `${messages.get(params.itemId) || ''}${params.delta || ''}`;
        messages.set(params.itemId, text);
        appendJobEvent(job.id, 'message.delta', { id: params.itemId, delta: deltas.redactDelta(`message:${params.itemId}`, params.delta) }, options);
      } else if (method === 'item/started') mapCodexItem(job.id, 'started', params);
      else if (method === 'item/completed') mapCodexItem(job.id, 'completed', params);
      else if (method === 'item/commandExecution/outputDelta') appendJobEvent(job.id, 'tool.output', { id: params.itemId, delta: deltas.redactDelta(`tool:${params.itemId}`, params.delta) }, options);
      else if (method === 'turn/plan/updated') appendJobEvent(job.id, 'plan.updated', { explanation: params.explanation, plan: params.plan }, options);
      else if (method === 'turn/diff/updated') appendJobEvent(job.id, 'diff.updated', { diff: params.diff }, options);
      else if (method === 'thread/tokenUsage/updated') {
        appendJobEvent(job.id, 'usage.updated', params.tokenUsage, options);
        updateManagedJob(job.id, (current) => { current.usage = params.tokenUsage; }, { incrementRevision: false });
      } else if (method === 'turn/completed') {
        appendJobEvent(job.id, 'turn.completed', { turn: params.turn }, options);
        updateManagedJob(job.id, (current) => { current.providerTurnId = null; }, { incrementRevision: false });
        turnResolve?.(params.turn);
      } else if (method === 'account/rateLimits/updated') {
        appendJobEvent(job.id, 'provider.event', { providerEvent: method }, options);
        try {
          const limits = params.rateLimits || {};
          mutateState((state) => {
            for (const name of ['primary', 'secondary']) {
              const value = limits[name];
              if (value && Number.isFinite(value.usedPercent)) {
                setWindow(state, 'codex', name, value.usedPercent, { resetsAt: value.resetsAt, source: 'codex-app-server' });
              }
            }
          });
        } catch {}
      } else if (method === 'error') appendJobEvent(job.id, 'error', params, options);
      else if (!method.includes('reasoning')) appendJobEvent(job.id, 'provider.event', { providerEvent: method }, options);
    }
  });

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'delegate-router', title: 'Delegate Router', version: '0.14.1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    rpc.notify('initialized', {});
    const model = codexModel(job.model);
    const common = {
      model,
      cwd: job.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: codexSandboxMode(job),
      developerInstructions: securityPreamble(job.allowSensitive),
      config: job.effort ? { model_reasoning_effort: job.effort } : {}
    };
    let thread;
    try {
      thread = job.providerSessionId
        ? await rpc.request('thread/resume', { threadId: job.providerSessionId, ...common, excludeTurns: true })
        : await rpc.request('thread/start', common);
    } catch (error) {
      throw mapCodexResumeError(error, Boolean(job.providerSessionId));
    }
    const threadId = thread.thread.id;
    recordSession(job.id, threadId, null);
    if (thread.model) {
      updateManagedJob(job.id, (current) => { current.resolvedModel = thread.model; }, { incrementRevision: false });
    }

    const startTurn = async (text) => {
      turnDone = new Promise((resolve) => { turnResolve = resolve; });
      let result;
      try {
        result = await rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          cwd: job.cwd,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          model
        });
      } catch (error) {
        throw mapCodexResumeError(error, Boolean(job.providerSessionId));
      }
      recordSession(job.id, threadId, result.turn.id);
      return result.turn.id;
    };

    await startTurn(promptFor(job));
    const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CODEX_TIMEOUT_SECONDS', 3600);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (Date.now() >= deadline) {
        const active = inspectJob(job.id).providerTurnId;
        if (active) await rpc.request('turn/interrupt', { threadId, turnId: active });
        throw new Error(`TIMEOUT: Codex managed job exceeded ${Math.round(timeoutMs / 1000)}s and was interrupted; raise timeoutSeconds for longer work`);
      }
      const completed = await Promise.race([
        turnDone.then((turn) => ({ turn })),
        rpc.exit.then((outcome) => ({ providerExit: outcome })),
        delay(150).then(() => null)
      ]);
      if (completed?.providerExit) {
        const outcome = completed.providerExit;
        throw outcome.error || new Error(`Codex app-server exited before turn completion (code ${outcome.code}, signal ${outcome.signal || 'none'})`);
      }
      for (const claimed of claimCommands(job.id)) {
        const command = claimed.command;
        try {
          const current = inspectJob(job.id);
          if (command.type === 'cancel') {
            for (const queued of queuedPrompts) {
              appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' });
              settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
            }
            queuedPrompts.length = 0;
            if (current.providerTurnId) await rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId });
            cancelled = true;
            completeCommand(job.id, claimed, { ok: true, appliedAs: 'interrupt' });
          } else if (command.type === 'steer') {
            if (cancelled) {
              completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
              continue;
            }
            const strategy = command.strategy || 'auto';
            if ((strategy === 'auto' || strategy === 'same-turn') && current.providerTurnId) {
              try {
                await rpc.request('turn/steer', {
                  threadId,
                  expectedTurnId: command.expectedTurnId || current.providerTurnId,
                  input: [{ type: 'text', text: command.text, text_elements: [] }]
                });
                appendJobEvent(job.id, 'correction.applied', { commandId: command.commandId, appliedAs: 'same-turn' });
                completeCommand(job.id, claimed, { ok: true, appliedAs: 'same-turn' });
              } catch (error) {
                if (strategy === 'same-turn') throw error;
                queuedPrompts.push({ text: command.text, commandId: command.commandId, appliedAs: 'next-turn' });
                appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, reason: error.message });
                completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'next-turn' });
              }
            } else {
              queuedPrompts.push({ text: command.text, commandId: command.commandId, appliedAs: strategy === 'restart' ? 'restart' : 'next-turn' });
              if (strategy === 'restart' && current.providerTurnId && !interruptRequested) {
                interruptRequested = true;
                await rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId });
              }
              appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy });
              completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: strategy === 'restart' ? 'restart' : 'next-turn' });
            }
          } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
        } catch (error) {
          completeCommand(job.id, claimed, { ok: false, error: error.message });
        }
      }
      if (completed) {
        interruptRequested = false;
        if (cancelled) { terminal(job, 'cancelled', 'cancelled'); break; }
        if (queuedPrompts.length) {
          const next = queuedPrompts.shift();
          settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: next.appliedAs });
          appendJobEvent(job.id, next.appliedAs === 'restart' ? 'correction.restarted' : 'correction.applied', { commandId: next.commandId, appliedAs: next.appliedAs });
          await startTurn(next.text);
          continue;
        }
        const status = completed.turn.status === 'failed' ? 'failed' : 'completed';
        terminal(job, status, status, completed.turn.error ? { error: completed.turn.error } : {});
        break;
      }
    }
  } finally {
    await rpc.stop();
  }
}

function cursorCommand(binary, args, interactive = true) {
  if (process.platform !== 'darwin' || process.env.DELEGATE_CURSOR_LOGIN_SHELL === '0') return { command: binary, args };
  const shell = process.env.SHELL || '/bin/zsh';
  // Headless must not use -i: an interactive zsh reads the NDJSON stream as
  // shell commands. ACP keeps -i for keychain-backed login environments.
  const flags = interactive ? '-lic' : '-lc';
  return { command: shell, args: [flags, 'exec "$@"', 'delegate-cursor-shell', binary, ...args] };
}

// Fail closed on unknown model ids: a silent fallback would report
// "completed" for a model the caller never requested. Advertised ACP option
// values may be attribute-serialized ("grok-4.5[effort=high,fast=true]")
// while callers use CLI-style suffixed ids ("grok-4.5-high"), bare bases, or
// shorthands; both sides are normalized to {base, effort, fast} and matched
// structurally. Anything that cannot be matched raises INVALID_MODEL. Without
// an advertised list there is nothing to validate against, so legacy
// resolution applies.
const EFFORT_RANK = { xhigh: 4, high: 3, medium: 2, low: 1 };

function parseCursorModelId(value) {
  const attrMatch = String(value).match(/^(.*?)\[(.*)\]$/);
  let base = attrMatch ? attrMatch[1] : String(value);
  const attrs = {};
  if (attrMatch && attrMatch[2]) {
    for (const pair of attrMatch[2].split(',')) {
      const [key, raw] = pair.split('=');
      if (key) attrs[key.trim()] = (raw ?? '').trim();
    }
  }
  let effort = attrs.effort || null;
  const suffix = base.match(/^(.*)-(xhigh|high|medium|low)$/);
  if (!effort && suffix) {
    base = suffix[1];
    effort = suffix[2];
  }
  let fast = attrs.fast === 'true';
  const fastSuffix = base.match(/^(.*)-fast$/);
  if (fastSuffix) {
    base = fastSuffix[1];
    fast = true;
  }
  return { value: String(value), base, effort, fast };
}

export function cursorModelDetailed(options, requested) {
  const values = options.map((item) => item.value);
  if (!values.length) return { value: resolveCursorModel(requested, []), fastCompromise: false };
  if (values.includes(requested)) return { value: requested, fastCompromise: false };
  const parsed = values.map(parseCursorModelId);
  const isGrokBase = (base) => /^(?:cursor-)?grok-/.test(base);
  // Fast variants are opt-in: the default pool is non-fast, and a fast
  // variant is selected only when the request itself says fast. When the
  // preferred pool is empty the other variant still resolves — fast/non-fast
  // is a latency preference, not a model identity, so it must not fail closed.
  const pick = (candidates, wantEffort, wantFast = false) => {
    let pool = candidates.filter((item) => item.fast === wantFast);
    if (!pool.length) pool = candidates;
    if (wantEffort) {
      pool = pool.filter((item) => item.effort === wantEffort);
      if (!pool.length) return null;
    }
    pool = [...pool].sort((a, b) =>
      ((EFFORT_RANK[b.effort] || 0) - (EFFORT_RANK[a.effort] || 0))
      || b.base.localeCompare(a.base, undefined, { numeric: true }));
    return pool[0] || null;
  };
  if (!requested || requested === 'auto') {
    const value = values.find((item) => item === 'default[]')
      || parsed.find((item) => item.base === 'auto' || item.base === 'default')?.value
      || null;
    return { value, fastCompromise: false };
  }
  let resolved = null;
  let wantFast = false;
  if (requested === 'composer') {
    resolved = pick(parsed.filter((item) => item.base.startsWith('composer-')), null);
  } else if (requested === 'grok' || requested === 'grok-high') {
    resolved = pick(parsed.filter((item) => isGrokBase(item.base)), 'high');
  } else if (requested === 'grok-xhigh') {
    resolved = pick(parsed.filter((item) => isGrokBase(item.base)), 'xhigh');
  } else if (requested === 'grok-fast') {
    wantFast = true;
    resolved = pick(parsed.filter((item) => isGrokBase(item.base)), 'high', true);
  } else {
    const want = parseCursorModelId(requested);
    wantFast = want.fast;
    let family = parsed.filter((item) => item.base === want.base);
    if (!family.length) family = parsed.filter((item) => item.base.startsWith(`${want.base}-`));
    // CLI catalogs prefix first-party Grok ids with "cursor-"; tolerate the
    // documented unprefixed form against a prefixed catalog.
    if (!family.length) family = parsed.filter((item) => item.base === `cursor-${want.base}` || item.base.startsWith(`cursor-${want.base}-`));
    if (family.length) resolved = pick(family, want.effort, want.fast);
  }
  if (resolved) {
    return { value: resolved.value, fastCompromise: resolved.fast === true && wantFast !== true };
  }
  const error = new Error(`INVALID_MODEL: '${requested}' is not in this account's model list; run agent models or cursor-agent models. Available: ${values.slice(0, 25).join(', ')}`);
  error.code = 'INVALID_MODEL';
  throw error;
}

export function cursorModel(options, requested) {
  return cursorModelDetailed(options, requested).value;
}

// Codex threads that engaged the auto-review sub-agent (write-mode approval
// flows) may refuse direct resume with a multi-agent v2 error; surface that as
// an actionable code instead of a cryptic provider message.
function mapCodexResumeError(error, isResume) {
  if (isResume && /multi-agent v2|not allowed for .*sub-agents/i.test(error?.message || '')) {
    const mapped = new Error('RESUME_UNSUPPORTED: this Codex thread cannot be resumed directly (it engaged the multi-agent review flow); start a fresh job with a full task packet that folds in prior findings');
    mapped.code = 'RESUME_UNSUPPORTED';
    return mapped;
  }
  return error;
}

function planEntriesText(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  return entries
    .map((entry, index) => `${index + 1}. ${entry.content ?? entry.title ?? JSON.stringify(entry)}${entry.status ? ` [${entry.status}]` : ''}`)
    .join('\n');
}

function mapAcpUpdate(jobId, update, sessionId, messageParts, deltas, planHolder) {
  const kind = update.sessionUpdate;
  const options = { sessionId };
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text || '';
    messageParts.push(text);
    appendJobEvent(jobId, 'message.delta', { id: update.messageId, delta: deltas.redactDelta(`message:${update.messageId ?? 'acp'}`, text) }, options);
  } else if (kind === 'plan' || kind === 'plan_update') {
    appendJobEvent(jobId, 'plan.updated', update, options);
    // Plan-mode output arrives here, not as agent message chunks; hold the
    // latest entries so the terminal result can carry the actual plan.
    const entries = update.entries || update.plan?.entries || null;
    if (planHolder && entries) planHolder.entries = entries;
  }
  else if (kind === 'tool_call') {
    appendJobEvent(jobId, 'tool.started', update, options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
  } else if (kind === 'tool_call_update') {
    const type = ['completed', 'failed'].includes(update.status) ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, update, options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
  } else if (kind === 'usage_update') {
    appendJobEvent(jobId, 'usage.updated', update, options);
    updateManagedJob(jobId, (job) => { job.usage = update; }, { incrementRevision: false });
  } else if (kind === 'session_info_update') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: 'session/update:session_info_update' }, options);
    if (update.model) {
      // The session's own report is the ground truth for resolvedModel, but a
      // silent overwrite hid fast-variant swaps from coordinators; disagreement
      // with the negotiated value must be loud.
      const current = loadJob(jobId);
      if (current?.resolvedModel && current.resolvedModel !== update.model) {
        appendJobEvent(jobId, 'provider.event', { providerEvent: 'cursor:model-mismatch', negotiated: current.resolvedModel, reported: update.model }, options);
      }
      updateManagedJob(jobId, (job) => { job.resolvedModel = update.model; }, { incrementRevision: false });
    }
  } else if (kind !== 'agent_thought_chunk' && kind !== 'user_message_chunk') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: `session/update:${kind}` }, options);
  }
}

function gitWorkspaceState(job) {
  const cwd = job.cwd;
  const options = { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 };
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  if (status.status !== 0) return { diff: '', files: [], error: (status.stderr || 'git status failed').trim() };
  const entries = status.stdout.split('\0').filter(Boolean);
  const files = [];
  const baseline = new Set(job.baselineFiles || []);
  const sensitive = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private.?key|token)[^/]*|[^/]+\.(?:pem|key|p12|pfx|crt|cer))$/i;
  const internalRoot = job.promptPath ? path.relative(cwd, path.dirname(job.promptPath)) : null;
  const isInternal = (file) => internalRoot && internalRoot !== '..' && !internalRoot.startsWith(`..${path.sep}`)
    && (file === internalRoot || file.startsWith(`${internalRoot}/`));
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const statusCode = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) files.push({ path: file, status: statusCode, preexisting: baseline.has(file), contentExcluded: sensitive.test(file) || isInternal(file) });
    if (/[RC]/.test(statusCode) && entries[i + 1]) {
      const source = entries[++i];
      files.push({ path: source, status: `${statusCode}:source`, preexisting: baseline.has(source), contentExcluded: sensitive.test(source) || isInternal(source) });
    }
  }
  let diff = '';
  let includesPreexisting = false;
  const errors = [];
  const baselineHashes = job.baselineHashes || {};
  const limit = Math.min(files.length, 1000);
  if (files.length > limit) errors.push(`file inventory capped at ${limit} of ${files.length}`);
  for (const item of files.slice(0, limit)) {
    if (item.contentExcluded) continue;
    if (item.preexisting) {
      // A path-only baseline cannot distinguish "job merely read this dirty
      // file" from "job added to it"; the content hash captured at job start
      // can. Unknown hashes (large/unreadable, or pre-upgrade job records)
      // fall through to the old include-everything behavior.
      const before = baselineHashes[item.path];
      const now = before ? hashWorkingFile(cwd, item.path) : null;
      if (before && now && before === now) {
        item.unchangedSinceBaseline = true;
        continue;
      }
      if (before && now) item.overlapsPreexisting = true;
    }
    let result;
    if (item.status === '??') {
      if (item.preexisting && !item.overlapsPreexisting) continue;
      try {
        if (fs.statSync(path.join(cwd, item.path)).size > 5 * 1024 * 1024) {
          errors.push(`untracked file too large to diff: ${item.path}`);
          continue;
        }
      } catch { continue; }
      result = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', item.path], options);
      if (result.status !== 0 && result.status !== 1) errors.push((result.stderr || `cannot diff untracked file ${item.path}`).trim());
    } else {
      result = spawnSync('git', ['diff', '--no-ext-diff', 'HEAD', '--', item.path], options);
      if (result.status !== 0) {
        const cached = spawnSync('git', ['diff', '--no-ext-diff', '--cached', '--', item.path], options);
        const unstaged = spawnSync('git', ['diff', '--no-ext-diff', '--', item.path], options);
        result = { status: cached.status || unstaged.status, stdout: `${cached.stdout || ''}${unstaged.stdout || ''}`, stderr: cached.stderr || unstaged.stderr };
      }
      if (result.status !== 0) errors.push((result.stderr || `cannot diff tracked file ${item.path}`).trim());
    }
    if (result?.stdout) {
      diff += result.stdout;
      if (item.preexisting) includesPreexisting = true;
    }
  }
  return { diff, files, includesPreexisting, error: errors.filter(Boolean).join('; ') || null };
}

function recordGitState(job, sessionId) {
  const state = gitWorkspaceState(job);
  for (const file of state.files) {
    // Pre-existing files proven byte-identical to the job-start baseline were
    // at most read, never changed — emitting file.changed for them is exactly
    // the attribution noise this filter removes.
    if (file.unchangedSinceBaseline) continue;
    appendJobEvent(job.id, 'file.changed', file, { sessionId });
  }
  if (state.diff) appendJobEvent(job.id, 'diff.updated', { diff: state.diff, includesPreexistingChanges: state.includesPreexisting === true }, { sessionId });
  if (state.error) appendJobEvent(job.id, 'provider.event', { providerEvent: 'git-inventory-warning', error: state.error }, { sessionId });
}

async function runCursorAcp(job) {
  const binary = resolveCursorBinary();
  if (!binary) throw new Error('neither agent nor cursor-agent is executable');
  const sandboxValue = job.sandbox === 'off' ? 'disabled' : 'enabled';
  const rootArgs = readOnly(job) ? ['--sandbox', sandboxValue, 'acp'] : ['--auto-review', '--sandbox', sandboxValue, 'acp'];
  const launch = cursorCommand(binary, rootArgs);
  let sessionId = job.providerSessionId;
  let cancelRequested = false;
  const pendingCorrections = [];
  let cancelSignalSent = false;
  let promptPromise = null;
  const messageParts = [];
  const planHolder = { entries: null };
  const deltas = new DeltaRedactor();
  const rpc = new JsonRpcProcess(launch.command, launch.args, {
    cwd: job.cwd,
    onStderr: (text) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text: deltas.redactDelta('stderr', text) }),
    onNotification: async (method, params) => {
      if (method === 'session/update') mapAcpUpdate(job.id, params.update || {}, params.sessionId, messageParts, deltas, planHolder);
    },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`Unsupported ACP request: ${method}`);
      appendJobEvent(job.id, 'approval.requested', { method, toolCall: params.toolCall, options: params.options }, { sessionId });
      const allow = job.approval === 'force' ? params.options?.find((option) => /allow/i.test(option.kind)) : null;
      const reject = params.options?.find((option) => /reject|deny/i.test(option.kind));
      const selected = allow || reject;
      const outcome = selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' };
      appendJobEvent(job.id, 'approval.resolved', { outcome }, { sessionId });
      return { outcome };
    }
  });

  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'delegate-router', version: '0.14.1' }
    });
    const session = sessionId
      ? await rpc.request('session/load', { sessionId, cwd: job.cwd, mcpServers: [] })
      : await rpc.request('session/new', { cwd: job.cwd, mcpServers: [] });
    sessionId ||= session.sessionId;
    recordSession(job.id, sessionId, null);
    const config = session.configOptions || [];
    const modelOption = config.find((item) => item.id === 'model');
    const modeOption = config.find((item) => item.id === 'mode');
    if (modelOption) {
      let resolvedModel;
      try {
        const detailed = cursorModelDetailed(modelOption.options || [], job.model);
        resolvedModel = detailed.value;
        if (detailed.fastCompromise) {
          // The session advertises this model only as a fast variant. The
          // non-fast contract wins: if the CLI catalog has a non-fast id,
          // fall back to headless with it; otherwise proceed fast, loudly.
          let cliModel = null;
          try {
            const ids = availableModelIds(binary);
            const candidate = resolveCursorModel(job.model, ids);
            if (ids.includes(candidate) && !/-fast(?:-|$)/.test(candidate)) cliModel = candidate;
          } catch {}
          if (cliModel) {
            const fastError = new Error(`ACP_TIER_UNAVAILABLE: this ACP session advertises '${job.model}' only as a fast variant ('${detailed.value}'); the CLI catalog has non-fast '${cliModel}'`);
            fastError.code = 'ACP_TIER_UNAVAILABLE';
            fastError.cliModel = cliModel;
            throw fastError;
          }
          appendJobEvent(job.id, 'provider.event', { providerEvent: 'cursor:fast-fallback', requested: job.model, resolved: detailed.value }, { sessionId });
        }
      } catch (error) {
        if (error.code === 'ACP_TIER_UNAVAILABLE') throw error;
        if (error.code !== 'INVALID_MODEL') throw error;
        // ACP sessions can advertise fewer tiers than the CLI catalog (for
        // example Grok capped at effort=high while the CLI lists -xhigh).
        // When the requested tier exists in the CLI catalog, signal a
        // deliberate transport fallback instead of failing the job.
        let cliModel = null;
        try {
          const ids = availableModelIds(binary);
          const candidate = resolveCursorModel(job.model, ids);
          if (ids.includes(candidate)) cliModel = candidate;
        } catch {}
        if (!cliModel) throw error;
        const tierError = new Error(`ACP_TIER_UNAVAILABLE: '${job.model}' resolves to '${cliModel}' in the CLI catalog, but this ACP session does not advertise that tier`);
        tierError.code = 'ACP_TIER_UNAVAILABLE';
        tierError.cliModel = cliModel;
        throw tierError;
      }
      await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: resolvedModel });
      updateManagedJob(job.id, (current) => {
        current.model = resolvedModel;
        current.resolvedModel = resolvedModel;
      }, { incrementRevision: false });
    }
    if (modeOption) await rpc.request('session/set_config_option', {
      sessionId, configId: 'mode', value: readOnly(job) ? (job.mode === 'consult' ? 'ask' : 'plan') : 'agent'
    });

    const startPrompt = (text) => {
      messageParts.length = 0;
      cancelSignalSent = false;
      appendJobEvent(job.id, 'turn.started', { transport: 'acp' }, { sessionId });
      promptPromise = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600));
    };
    startPrompt(promptFor(job));

    while (true) {
      const completed = await Promise.race([
        promptPromise.then((response) => ({ response }), (error) => ({ error })),
        delay(150).then(() => null)
      ]);
      for (const claimed of claimCommands(job.id)) {
        const command = claimed.command;
        if (command.type === 'cancel') {
          cancelRequested = true;
          for (const queued of pendingCorrections) {
            appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' }, { sessionId });
            settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
          }
          pendingCorrections.length = 0;
          if (!cancelSignalSent) { rpc.notify('session/cancel', { sessionId }); cancelSignalSent = true; }
          completeCommand(job.id, claimed, { ok: true, appliedAs: 'cancel' });
        } else if (command.type === 'steer') {
          if (cancelRequested) {
            completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
          } else if (command.strategy === 'same-turn') {
            completeCommand(job.id, claimed, { ok: false, error: 'UNSUPPORTED_STRATEGY: ACP v1 has no same-turn steering' });
          } else {
            pendingCorrections.push({ text: command.text, commandId: command.commandId });
            if (!cancelSignalSent) { rpc.notify('session/cancel', { sessionId }); cancelSignalSent = true; }
            appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy: 'restart' }, { sessionId });
            completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'restart' });
          }
        } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
      }
      if (!completed) continue;
      if (completed.error) throw completed.error;
      if (acpGraceMs()) await delay(acpGraceMs());
      appendJobEvent(job.id, 'turn.completed', completed.response, { sessionId });
      if (messageParts.length) appendJobEvent(job.id, 'message.completed', { text: messageParts.join('') }, { sessionId });
      if (completed.response.usage) appendJobEvent(job.id, 'usage.updated', completed.response.usage, { sessionId });
      if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); break; }
      if (pendingCorrections.length) {
        const next = pendingCorrections.shift();
        settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
        appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId });
        startPrompt(next.text);
        continue;
      }
      recordGitState(job, sessionId);
      const planText = planEntriesText(planHolder.entries);
      terminal(job, 'completed', 'completed', {
        result: {
          text: messageParts.join(''),
          ...(planText ? { plan: planText } : {}),
          stopReason: completed.response.stopReason
        },
        session: sessionId
      });
      break;
    }
  } finally {
    await rpc.stop();
  }
}

function mapHeadlessEvent(jobId, event, deltas) {
  const sessionId = findValue(event, ['session_id', 'sessionId', 'chat_id', 'chatId']);
  if (sessionId) {
    updateManagedJob(jobId, (job) => { job.providerSessionId = sessionId; job.session = sessionId; }, { incrementRevision: false });
  }
  const options = { sessionId };
  if (event.type === 'assistant') {
    const text = findValue(event, ['text', 'content', 'message']) || '';
    appendJobEvent(jobId, 'message.delta', { delta: deltas.redactDelta('message:headless', typeof text === 'string' ? text : JSON.stringify(text)) }, options);
  } else if (event.type === 'tool_call') {
    const type = event.subtype === 'started' ? 'tool.started' : event.subtype === 'completed' ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, { toolCall: event.tool_call, subtype: event.subtype }, options);
  } else if (event.type === 'result') {
    if (event.usage) appendJobEvent(jobId, 'usage.updated', event.usage, options);
    if (event.result) appendJobEvent(jobId, 'message.completed', { text: event.result }, options);
  } else appendJobEvent(jobId, 'provider.event', { providerEvent: `cursor:${event.type || 'unknown'}`, subtype: event.subtype }, options);
}

async function runCursorHeadless(job) {
  const binary = resolveCursorBinary();
  if (!binary) throw new Error('neither agent nor cursor-agent is executable');
  const ids = process.platform === 'darwin' && process.env.DELEGATE_CURSOR_LOGIN_SHELL !== '0'
    ? []
    : availableModelIds(binary);
  const model = resolveCursorModel(job.model, ids);
  let resume = job.providerSessionId;
  let text = promptFor(job);
  let cancelRequested = false;
  const pendingCorrections = [];
  const deltas = new DeltaRedactor();

  while (true) {
    let activeChild = null;
    appendJobEvent(job.id, 'turn.started', { transport: 'headless', resume }, { sessionId: resume });
    const headless = cursorCommand(binary, buildCursorArgs({ mode: job.mode, model, cwd: job.cwd, approval: job.approval, resume, sandbox: job.sandbox }), false);
    const running = runCursor({
      binary: headless.command,
      args: headless.args,
      cwd: job.cwd,
      prompt: text,
      timeoutMs: jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600),
      onChild: (child) => { activeChild = child; },
      onEvent: (event) => mapHeadlessEvent(job.id, event, deltas)
    });
    let outcome;
    while (!outcome) {
      outcome = await Promise.race([running, delay(150).then(() => null)]);
      for (const claimed of claimCommands(job.id)) {
        const command = claimed.command;
        if (command.type === 'cancel') {
          cancelRequested = true;
          for (const queued of pendingCorrections) {
            appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' }, { sessionId: resume });
            settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
          }
          pendingCorrections.length = 0;
          if (activeChild) await terminateProcessTree(activeChild);
          completeCommand(job.id, claimed, { ok: true, appliedAs: 'process-tree-termination' });
        } else if (command.type === 'steer') {
          if (cancelRequested) {
            completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
          } else if (command.strategy === 'same-turn') {
            completeCommand(job.id, claimed, { ok: false, error: 'UNSUPPORTED_STRATEGY: Cursor headless has no same-turn steering' });
          } else {
            const current = inspectJob(job.id);
            if (!current.providerSessionId) {
              completeCommand(job.id, claimed, { ok: false, error: 'SESSION_UNAVAILABLE: Cursor has not exposed a resumable session id' });
            } else {
              pendingCorrections.push({ text: command.text, commandId: command.commandId });
              resume = current.providerSessionId;
              const first = pendingCorrections.length === 1;
              if (first && activeChild) await terminateProcessTree(activeChild);
              appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy: 'restart' }, { sessionId: resume });
              completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'restart' });
            }
          }
        } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
      }
    }
    appendJobEvent(job.id, 'turn.completed', { status: outcome.status, error: outcome.error }, { sessionId: resume });
    if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); return; }
    if (pendingCorrections.length) {
      const next = pendingCorrections.shift();
      settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
      appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId: resume });
      text = next.text;
      continue;
    }
    if (outcome.status !== 0) throw new Error(outcome.error || 'Cursor headless execution failed');
    const sessionId = findValue(outcome.payload, ['session_id', 'sessionId', 'chat_id', 'chatId']);
    if (sessionId) recordSession(job.id, sessionId, null);
    recordGitState(job, sessionId);
    terminal(job, 'completed', 'completed', { result: redact(outcome.payload), session: sessionId });
    return;
  }
}

export async function runManagedProvider(job) {
  updateManagedJob(job.id, (current) => { current.status = 'running'; current.phase = 'starting'; current.workerPid = process.pid; });
  appendJobEvent(job.id, 'job.state', { status: 'running', phase: 'starting', transport: job.transport });
  try {
    const current = loadJob(job.id);
    if (job.provider === 'codex') await runCodex(current);
    else if (job.provider === 'cursor' && job.transport === 'headless') await runCursorHeadless(current);
    else if (job.provider === 'cursor') {
      try { await runCursorAcp(current); }
      catch (error) {
        const started = inspectJob(job.id).providerSessionId;
        const tierFallback = error.code === 'ACP_TIER_UNAVAILABLE';
        if (started && !tierFallback) throw error;
        appendJobEvent(job.id, 'provider.event', {
          providerEvent: tierFallback ? 'cursor:acp-tier-fallback' : 'cursor:acp-fallback',
          error: error.message,
          ...(error.cliModel ? { cliModel: error.cliModel } : {})
        });
        updateManagedJob(job.id, (next) => {
          next.transport = 'headless';
          next.capabilities.correction = 'cancel-resume';
          if (tierFallback) {
            // The ACP session id is not a headless chat id; the requested
            // model is honored exactly via the CLI-validated id.
            next.providerSessionId = null;
            next.session = null;
            next.model = error.cliModel;
            next.resolvedModel = error.cliModel;
          }
        });
        await runCursorHeadless(loadJob(job.id));
      }
    }
    else throw new Error(`Unsupported managed provider: ${job.provider}`);
  } catch (error) {
    if (/(?:quota|usage limit|rate limit|allowance)/i.test(error.message || '')) {
      mutateState((state) => setWindow(state, job.provider, 'quota-error', 100, { source: 'quota-error' }));
    }
    const current = inspectJob(job.id);
    if (!['completed', 'cancelled', 'failed'].includes(current.status)) terminal(job, 'failed', 'failed', { error: error.message });
    throw error;
  }
}
