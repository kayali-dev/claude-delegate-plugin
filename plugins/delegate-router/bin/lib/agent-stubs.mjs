import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendJobEvent, inspectJob, redact, updateManagedJob } from './control.mjs';
import { loadJob, saveJob } from './state.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_PROMPT_SUMMARY = 512;

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

function safeCoordinatorGroup(sessionId) {
  const value = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return value ? `claude-session-${value}` : null;
}

export function createClaudeAgentStub(options = {}) {
  if (!options.toolUseId) throw new Error('Agent hook payload is missing tool_use_id');
  const id = agentStubId(options.sessionId, options.toolUseId);
  const existing = loadJob(id);
  if (existing) return inspectJob(id);
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
    promptSummary: boundedText(options.prompt),
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
  if (TERMINAL.has(existing.status)) return inspectJob(id);
  const completedAtMs = Number(options.now ?? Date.now());
  const status = options.status === 'failed' ? 'failed' : options.status === 'cancelled' ? 'cancelled' : 'completed';
  updateManagedJob(id, (job) => {
    job.status = status;
    job.phase = status;
    job.completedAt = Math.floor(completedAtMs / 1000);
    job.completedAtMs = completedAtMs;
    job.durationMs = Math.max(0, completedAtMs - Number(job.createdAtMs || job.createdAt * 1000 || completedAtMs));
    if (options.transcriptPath && path.isAbsolute(options.transcriptPath)) job.transcriptPath = path.normalize(options.transcriptPath);
    if (options.error) {
      job.error = boundedText(options.error, 1024);
      job.errorCode = 'AGENT_TOOL_ERROR';
      job.errorRetryable = false;
    }
  });
  appendJobEvent(id, 'job.completed', {
    status,
    ...(options.error ? { code: 'AGENT_TOOL_ERROR', message: boundedText(options.error, 1024) } : {})
  }, { lifecycle: true });
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
  const failed = explicit === true || /^(?:failed|error|cancelled)$/i.test(String(status || ''))
    || /<tool_use_error>|\btool error\b/i.test(text);
  return { status: failed ? 'failed' : 'completed', error: failed ? boundedText(text, 1024) || 'Agent tool failed' : null };
}

function derivedAgentId(result) {
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
    if (normalized.startsWith(`${path.dirname(coordinator)}${path.sep}`)) return normalized;
  }
  const agentId = derivedAgentId(result);
  if (!agentId) return null;
  const sidecar = coordinator.replace(/\.jsonl$/i, '');
  const directory = path.join(sidecar, 'subagents');
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, Math.max(1, Number(options.maxEntries || 200))); }
  catch { return null; }
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '');
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    && (entry.name === `agent-${safeId}.jsonl` || entry.name.startsWith(`agent-${safeId}-`)))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      try { return [{ file, mtimeMs: fs.statSync(file).mtimeMs }]; } catch { return []; }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
  return candidates[0]?.file || null;
}
