import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendJobEvent, inspectJob, redact, updateManagedJob } from './control.mjs';
import { loadJob, saveJob } from './state.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_PROMPT_SUMMARY = 512;
const DEFAULT_AGENT_TRANSCRIPT_ENTRY_LIMIT = 200;
const DEFAULT_AGENT_SESSION_LIMIT = 8;
const DEFAULT_AGENT_PROJECT_ENTRY_LIMIT = 200;

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

export function encodeClaudeProjectDirectory(cwd) {
  return path.resolve(String(cwd || path.parse(process.cwd()).root)).split(path.sep).join('-');
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
    agentLifecycle: 'started',
    promptSummary: boundedText(options.prompt),
    coordinatorSidecarDir: typeof options.coordinatorSidecarDir === 'string' && path.isAbsolute(options.coordinatorSidecarDir)
      ? path.normalize(options.coordinatorSidecarDir)
      : null,
    transcriptPath: typeof options.transcriptPath === 'string' && path.isAbsolute(options.transcriptPath)
      ? path.normalize(options.transcriptPath)
      : null,
    createdAt,
    createdAtMs,
    updatedAt: createdAt,
    attributionConfidence: 'hook-correlated'
  };
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
  updateManagedJob(id, (job) => {
    if (options.agentId) job.agentId = boundedText(options.agentId, 256) || job.agentId || null;
    if (options.coordinatorSidecarDir && path.isAbsolute(options.coordinatorSidecarDir)) {
      job.coordinatorSidecarDir = path.normalize(options.coordinatorSidecarDir);
    }
    if (options.transcriptPath && path.isAbsolute(options.transcriptPath)) job.transcriptPath = path.normalize(options.transcriptPath);
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
  const explicit = recursiveValue(result, ['agent_id', 'agentId']);
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const match = resultText(result).match(/\bagent(?:_id|Id)\s*[:=]\s*["']?([a-zA-Z0-9_-]{1,128})/);
  return match?.[1] || null;
}

function boundedPositiveInteger(value, fallback, maximum = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(number)));
}

function transcriptCandidates(directory, agentId, options = {}) {
  const safeId = String(agentId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return [];
  const maxEntries = boundedPositiveInteger(options.maxEntries, DEFAULT_AGENT_TRANSCRIPT_ENTRY_LIMIT);
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, maxEntries); }
  catch { return []; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    && (entry.name === `agent-${safeId}.jsonl` || entry.name.startsWith(`agent-${safeId}-`)))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      try { return [{ file, mtimeMs: fs.statSync(file).mtimeMs }]; } catch { return []; }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
}

function transcriptInSidecar(sidecar, agentId, options = {}) {
  if (typeof sidecar !== 'string' || !path.isAbsolute(sidecar)) return null;
  return transcriptCandidates(path.join(path.normalize(sidecar), 'subagents'), agentId, options)[0]?.file || null;
}

export function resolveStoredAgentTranscriptPath(options = {}) {
  const agentId = String(options.agentId || '').trim();
  if (!agentId) return null;
  const eagerSidecar = transcriptInSidecar(options.coordinatorSidecarDir, agentId, options);
  if (eagerSidecar) return eagerSidecar;
  if (options.coordinatorSidecarDir) return null;
  if (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) return null;
  if (typeof options.projectsDir !== 'string' || !path.isAbsolute(options.projectsDir)) return null;

  const projectDirectory = path.join(path.normalize(options.projectsDir), encodeClaudeProjectDirectory(options.cwd));
  const maxProjectEntries = boundedPositiveInteger(options.maxProjectEntries, DEFAULT_AGENT_PROJECT_ENTRY_LIMIT);
  const maxSessionDirs = boundedPositiveInteger(options.maxSessionDirs, DEFAULT_AGENT_SESSION_LIMIT, 64);
  let entries;
  try { entries = fs.readdirSync(projectDirectory, { withFileTypes: true }); }
  catch { return null; }
  const sessions = entries.filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const directory = path.join(projectDirectory, entry.name);
    try { return [{ directory, mtimeMs: fs.statSync(directory).mtimeMs }]; } catch { return []; }
  }).sort((left, right) => right.mtimeMs - left.mtimeMs || left.directory.localeCompare(right.directory)).slice(0, maxProjectEntries);
  for (const session of sessions.slice(0, maxSessionDirs)) {
    const transcript = transcriptInSidecar(session.directory, agentId, options);
    if (transcript) return transcript;
  }
  return null;
}

export function deriveAgentTranscriptPath(coordinatorTranscriptPath, result, options = {}) {
  if (typeof coordinatorTranscriptPath !== 'string' || !path.isAbsolute(coordinatorTranscriptPath)) return null;
  const coordinator = path.normalize(coordinatorTranscriptPath);
  const direct = recursiveValue(result, ['transcript_path', 'transcriptPath', 'agent_transcript_path', 'agentTranscriptPath']);
  if (typeof direct === 'string' && path.isAbsolute(direct)) {
    const normalized = path.normalize(direct);
    if (normalized.startsWith(`${path.dirname(coordinator)}${path.sep}`)) return normalized;
  }
  const agentId = deriveAgentId(result);
  if (!agentId) return null;
  return transcriptInSidecar(coordinatorSidecarDirectory(coordinator), agentId, options);
}
