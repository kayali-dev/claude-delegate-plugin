import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendJobEvent, inspectJob, launchOrigin, redact, updateManagedJob } from './control.mjs';
import { listJobs, loadJob, saveJob } from './state.mjs';
import { initializeOutcomeAttempt } from './outcome-ledger.mjs';
import {
  agentMetadataPath,
  encodeClaudeProjectDirectory,
  normalizeTranscriptAgentId,
  resolveStoredAgentTranscriptPath,
  transcriptAgentIdForJob,
  transcriptAgentIdFromPath,
  transcriptPathMatchesAgentId
} from './agent-transcript-paths.mjs';

export {
  encodeClaudeProjectDirectory,
  normalizeTranscriptAgentId,
  resolveStoredAgentTranscriptPath,
  transcriptAgentIdForJob,
  transcriptAgentIdFromPath,
  transcriptPathMatchesAgentId
} from './agent-transcript-paths.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_PROMPT_SUMMARY = 512;
const MAX_AGENT_METADATA_BYTES = 64 * 1024;

function boundedText(value, maximum = MAX_PROMPT_SUMMARY) {
  return String(redact(String(value ?? '').slice(0, maximum)))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

export function agentStubId(sessionId, toolUseId) {
  const digest = crypto.createHash('sha256').update(`${String(sessionId || '')}\0${String(toolUseId || '')}`).digest('hex').slice(0, 24);
  return `claude-agent-${digest}`;
}

export function coordinatorSidecarDirectory(coordinatorTranscriptPath) {
  if (typeof coordinatorTranscriptPath !== 'string' || !path.isAbsolute(coordinatorTranscriptPath)) return null;
  return path.normalize(coordinatorTranscriptPath).replace(/\.jsonl$/i, '');
}

function safeCoordinatorGroup(sessionId) {
  const value = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return value ? `claude-session-${value}` : null;
}

export function createClaudeAgentStub(options = {}) {
  if (!options.toolUseId) throw new Error('Agent hook payload is missing tool_use_id');
  const id = agentStubId(options.sessionId, options.toolUseId);
  const existing = loadJob(id);
  if (existing) {
    const sidecar = typeof options.coordinatorSidecarDir === 'string' && path.isAbsolute(options.coordinatorSidecarDir)
      ? path.normalize(options.coordinatorSidecarDir)
      : null;
    if (sidecar && !existing.coordinatorSidecarDir) {
      updateManagedJob(id, (job) => { job.coordinatorSidecarDir ||= sidecar; }, { incrementRevision: false });
    }
    return inspectJob(id);
  }
  const createdAtMs = Number(options.now ?? Date.now());
  const createdAt = Math.floor(createdAtMs / 1000);
  const cwd = boundedText(path.resolve(String(options.cwd || process.cwd())), 4096);
  const origin = launchOrigin({
    origin: options.origin,
    projectDir: options.projectDir,
    launchCwd: options.originCwd || options.cwd,
    sessionId: options.sessionId,
    launchedAtMs: createdAtMs
  });
  const groupId = safeCoordinatorGroup(options.sessionId);
  const job = {
    schemaVersion: 2,
    id,
    provider: 'claude',
    requestedModel: boundedText(options.model || 'inherited', 128) || 'inherited',
    model: boundedText(options.model || 'inherited', 128) || 'inherited',
    mode: 'agent',
    status: 'running',
    phase: 'running',
    revision: 0,
    lastSeq: 0,
    cwd,
    origin,
    transport: 'claude-agent',
    managedBy: 'delegate-agent-hook',
    readOnly: true,
    capabilities: { events: true, transcript: 'bounded-read-only', correction: 'read-only', cancel: false, resume: false, usage: false },
    toolUseId: boundedText(options.toolUseId, 256),
    coordinatorSessionId: boundedText(options.sessionId, 256) || null,
    groupId,
    agentType: boundedText(options.agentType, 128) || null,
    agentName: boundedText(options.agentName, 128) || null,
    agentId: boundedText(options.agentId, 256) || null,
    transcriptAgentId: normalizeTranscriptAgentId(options.transcriptAgentId),
    agentLifecycle: 'started',
    promptSummary: boundedText(options.prompt),
    coordinatorSidecarDir: typeof options.coordinatorSidecarDir === 'string' && path.isAbsolute(options.coordinatorSidecarDir)
      ? path.normalize(options.coordinatorSidecarDir)
      : null,
    transcriptPath: transcriptPathMatchesAgentId(options.transcriptPath, normalizeTranscriptAgentId(options.transcriptAgentId))
      ? path.normalize(options.transcriptPath)
      : null,
    createdAt,
    createdAtMs,
    updatedAt: createdAt,
    attributionConfidence: 'hook-correlated'
  };
  initializeOutcomeAttempt(job, {
    packet: options.prompt,
    brokerVersion: origin.brokerVersion,
    eventSchemaVersion: 1,
    providerCliVersionSource: 'not-applicable'
  });
  saveJob(job);
  appendJobEvent(id, 'job.created', {
    provider: 'claude',
    model: job.model,
    mode: job.mode,
    transport: job.transport,
    agentType: job.agentType,
    coordinatorSessionId: job.coordinatorSessionId
  }, { lifecycle: true });
  return inspectJob(id);
}

export function completeClaudeAgentStub(options = {}) {
  if (!options.toolUseId) throw new Error('Agent hook payload is missing tool_use_id');
  const id = agentStubId(options.sessionId, options.toolUseId);
  const existing = loadJob(id);
  if (!existing) return null;
  const completedAtMs = Number(options.now ?? Date.now());
  const background = options.lifecycle === 'spawn-returned';
  const alreadyRecorded = background && existing.agentLifecycle === 'spawn-returned';
  const wasTerminal = TERMINAL.has(existing.status);
  const status = options.status === 'failed' ? 'failed' : options.status === 'cancelled' ? 'cancelled' : 'completed';
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId)
    || transcriptAgentIdFromPath(options.transcriptPath);
  updateManagedJob(id, (job) => {
    // Agent tool results expose a fleet/display name. Subagent lifecycle hooks
    // expose the unrelated id used in agent-<id>.jsonl. Never let the former
    // overwrite the latter, regardless of hook ordering.
    if (options.agentId) job.agentId = boundedText(options.agentId, 256) || job.agentId || null;
    if (transcriptAgentId) job.transcriptAgentId = transcriptAgentId;
    if (options.coordinatorSidecarDir && path.isAbsolute(options.coordinatorSidecarDir)) {
      job.coordinatorSidecarDir = path.normalize(options.coordinatorSidecarDir);
    }
    if (transcriptPathMatchesAgentId(options.transcriptPath, transcriptAgentId || transcriptAgentIdForJob(job))) {
      job.transcriptPath = path.normalize(options.transcriptPath);
    }
    if (wasTerminal || alreadyRecorded) return;
    if (background) {
      job.status = 'running';
      job.phase = 'spawn-returned';
      job.agentLifecycle = 'spawn-returned';
      job.spawnReturnedAt = Math.floor(completedAtMs / 1000);
      job.spawnReturnedAtMs = completedAtMs;
      return;
    }
    job.status = status;
    job.phase = status;
    job.agentLifecycle = status;
    job.completedAt = Math.floor(completedAtMs / 1000);
    job.completedAtMs = completedAtMs;
    job.durationMs = Math.max(0, completedAtMs - Number(job.createdAtMs || job.createdAt * 1000 || completedAtMs));
    if (typeof options.resultText === 'string' && options.resultText.trim()) job.resultText = boundedText(options.resultText, 4096);
    if (options.error) {
      job.error = boundedText(options.error, 1024);
      job.errorCode = 'AGENT_TOOL_ERROR';
      job.errorRetryable = false;
    }
  }, { incrementRevision: !wasTerminal && !alreadyRecorded });
  if (wasTerminal || alreadyRecorded) return inspectJob(id);
  if (background) {
    appendJobEvent(id, 'job.spawn-returned', {
      status: 'running',
      lifecycle: 'spawn-returned',
      agentId: boundedText(options.agentId, 256) || null
    }, { lifecycle: true });
  } else {
    appendJobEvent(id, 'job.completed', {
      status,
      ...(options.error ? { code: 'AGENT_TOOL_ERROR', message: boundedText(options.error, 1024) } : {})
    }, { lifecycle: true });
  }
  return inspectJob(id);
}

function matchingAgentStubs(options = {}) {
  const sessionId = boundedText(options.sessionId, 256);
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId);
  const agentType = boundedText(options.agentType, 128);
  return listJobs().filter((job) => job.managedBy === 'delegate-agent-hook'
    && job.transport === 'claude-agent'
    && (!sessionId || job.coordinatorSessionId === sessionId)
    && (!transcriptAgentId || transcriptAgentIdForJob(job) === transcriptAgentId)
    && (!agentType || !job.agentType || job.agentType === agentType))
    .sort((left, right) => Number(right.createdAtMs || right.createdAt * 1000 || 0)
      - Number(left.createdAtMs || left.createdAt * 1000 || 0));
}

function readAgentMetadata(coordinatorSidecarDir, transcriptAgentId) {
  const file = agentMetadataPath(coordinatorSidecarDir, transcriptAgentId);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AGENT_METADATA_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function correlateCandidate(candidate, options, metadata = null) {
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId);
  const transcriptPath = resolveStoredAgentTranscriptPath({
    transcriptAgentId,
    coordinatorSidecarDir: options.coordinatorSidecarDir
  });
  updateManagedJob(candidate.id, (job) => {
    job.transcriptAgentId = transcriptAgentId;
    if (options.agentType) job.agentType = boundedText(options.agentType, 128) || job.agentType;
    if (options.coordinatorSidecarDir && path.isAbsolute(options.coordinatorSidecarDir)) {
      job.coordinatorSidecarDir = path.normalize(options.coordinatorSidecarDir);
    }
    if (transcriptPath) job.transcriptPath = transcriptPath;
    const spawnDepth = Number(metadata?.spawnDepth);
    if (Number.isSafeInteger(spawnDepth) && spawnDepth >= 0) job.spawnDepth = spawnDepth;
    if (!job.agentName && metadata?.description) job.agentName = boundedText(metadata.description, 128) || null;
    if (!job.agentType && metadata?.agentType) job.agentType = boundedText(metadata.agentType, 128) || null;
  }, { incrementRevision: false });
  return inspectJob(candidate.id);
}

export function correlateClaudeSubagentStart(options = {}) {
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId);
  if (!transcriptAgentId) throw new Error('SubagentStart payload has an invalid transcript agent_id');
  const normalized = { ...options, transcriptAgentId };
  const metadata = readAgentMetadata(options.coordinatorSidecarDir, transcriptAgentId);
  if (metadata) {
    const exactId = metadata.toolUseId ? agentStubId(options.sessionId, metadata.toolUseId) : null;
    const exact = exactId ? loadJob(exactId) : null;
    if (exact?.managedBy === 'delegate-agent-hook'
      && exact.transport === 'claude-agent'
      && (!options.sessionId || exact.coordinatorSessionId === boundedText(options.sessionId, 256))) {
      return correlateCandidate(exact, normalized, metadata);
    }
    // A readable sidecar supplies the only exact correlation key. In
    // particular, nested agents have no coordinator-owned stub of their own;
    // guessing by type here could bind their transcript to an unrelated job.
    return null;
  }
  const already = matchingAgentStubs(normalized).find((job) => transcriptAgentIdForJob(job) === transcriptAgentId);
  if (already) return inspectJob(already.id);
  const candidate = matchingAgentStubs({ sessionId: options.sessionId, agentType: options.agentType })
    .find((job) => !transcriptAgentIdForJob(job) && !TERMINAL.has(job.status));
  if (!candidate) return null;
  return correlateCandidate(candidate, normalized, metadata);
}

export function completeClaudeSubagentByAgentId(options = {}) {
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId);
  if (!transcriptAgentId) throw new Error('SubagentStop payload has an invalid transcript agent_id');
  const normalized = { ...options, transcriptAgentId };
  const candidate = matchingAgentStubs(normalized).find((job) => !TERMINAL.has(job.status))
    || matchingAgentStubs(normalized)[0];
  if (!candidate) return null;
  return completeClaudeAgentStub({
    sessionId: candidate.coordinatorSessionId,
    toolUseId: candidate.toolUseId,
    status: options.status || 'completed',
    transcriptAgentId,
    coordinatorSidecarDir: options.coordinatorSidecarDir || candidate.coordinatorSidecarDir,
    transcriptPath: options.transcriptPath,
    resultText: options.resultText,
    error: options.error,
    now: options.now
  });
}

function recursiveValue(value, names, depth = 0, visits = { count: 0 }) {
  if (depth > 6 || visits.count > 128 || value == null) return null;
  visits.count += 1;
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recursiveValue(item, names, depth + 1, visits);
      if (found != null) return found;
    }
    return null;
  }
  for (const name of names) if (Object.hasOwn(value, name) && value[name] != null) return value[name];
  for (const item of Object.values(value)) {
    const found = recursiveValue(item, names, depth + 1, visits);
    if (found != null) return found;
  }
  return null;
}

function resultText(result) {
  let serialized = '';
  try { serialized = typeof result === 'string' ? result : JSON.stringify(result); }
  catch {}
  return serialized.slice(0, 16384);
}

export function agentResultStatus(result) {
  const explicit = recursiveValue(result, ['is_error', 'isError']);
  const status = recursiveValue(result, ['status']);
  const text = resultText(result);
  if (String(status || '').toLowerCase() === 'async_launched') {
    return { status: 'running', lifecycle: 'spawn-returned', error: null };
  }
  const failed = explicit === true || /^(?:failed|error|cancelled)$/i.test(String(status || ''))
    || /<tool_use_error>|\btool error\b/i.test(text);
  return { status: failed ? 'failed' : 'completed', error: failed ? boundedText(text, 1024) || 'Agent tool failed' : null };
}

export function deriveAgentId(result) {
  // This is the Agent tool result's fleet/display identity. The transcript
  // identity comes only from lifecycle hooks or an explicit transcript path.
  const explicit = recursiveValue(result, ['agent_id', 'agentId']);
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const match = resultText(result).match(/\bagent(?:_id|Id)\s*[:=]\s*["']?([a-zA-Z0-9_-]{1,128})/);
  return match?.[1] || null;
}

export function deriveAgentTranscriptPath(coordinatorTranscriptPath, result, options = {}) {
  if (typeof coordinatorTranscriptPath !== 'string' || !path.isAbsolute(coordinatorTranscriptPath)) return null;
  const coordinator = path.normalize(coordinatorTranscriptPath);
  const direct = recursiveValue(result, ['transcript_path', 'transcriptPath', 'agent_transcript_path', 'agentTranscriptPath']);
  if (typeof direct === 'string' && path.isAbsolute(direct)) {
    const normalized = path.normalize(direct);
    const transcriptAgentId = transcriptAgentIdFromPath(normalized);
    if (transcriptAgentId && normalized.startsWith(`${path.dirname(coordinator)}${path.sep}`)) return normalized;
  }
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId);
  if (!transcriptAgentId) return null;
  return resolveStoredAgentTranscriptPath({
    ...options,
    transcriptAgentId,
    coordinatorSidecarDir: coordinatorSidecarDirectory(coordinator)
  });
}
