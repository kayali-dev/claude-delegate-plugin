import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { auditLogPath, avoidPercentFor, effectiveUsage, jobsDir, listJobs, loadJob, loadState, providerEnabled, saveJob, validateProvider } from './state.mjs';
import { isProcessAlive } from './process.mjs';
import { withFileLock } from './lock.mjs';

const EVENT_VERSION = 1;
const MAX_STRING = Number(process.env.DELEGATE_EVENT_MAX_STRING || 65536);
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SENSITIVE_VALUE = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH_?TOKEN|REFRESH_?TOKEN)[A-Z0-9_]*)["']?\s*[:=]\s*["']?[^"'\s,;]+|:\/\/[^/\s:@]+:[^@\s/]+@)/gi;
const USAGE_TOKEN_KEY = /^(?:(?:max|observed)?(?:input|output|total|cached|reasoning|prompt|completion|billable|context)tokens?(?:count|usage)?|tokens?(?:count|usage))$/i;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]+$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const WRITE_MODES = new Set(['implement', 'verify']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertJobId(id) {
  if (!SAFE_JOB_ID.test(id || '')) throw brokerError('INVALID_REQUEST', `Invalid job id: ${id}`);
  return id;
}

function paths(id) {
  assertJobId(id);
  const root = jobsDir();
  return {
    events: path.join(root, `${id}.events.jsonl`),
    finished: path.join(root, `${id}.finished`),
    lock: path.join(root, `${id}.lock`),
    commands: path.join(root, `${id}.commands`),
    done: path.join(root, `${id}.commands`, 'done'),
    artifacts: path.join(root, `${id}.artifacts`),
    prompt: path.join(root, `${id}.prompt`),
    verifyCommand: path.join(root, `${id}.verify`),
    stdout: path.join(root, `${id}.out.log`),
    stderr: path.join(root, `${id}.err.log`)
  };
}

function acquireLock(id) {
  const lock = paths(id).lock;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      return { fd, lock };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 30000) { fs.unlinkSync(lock); continue; }
      } catch {}
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw brokerError('LOCK_TIMEOUT', `Timed out locking job ${id}`);
      sleepSync(LOCK_WAIT_MS);
    }
  }
}

function withLock(id, fn) {
  const held = acquireLock(id);
  try { return fn(); }
  finally {
    try { fs.closeSync(held.fd); } catch {}
    try { fs.unlinkSync(held.lock); } catch {}
  }
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function redact(value, key = '', maxLength = MAX_STRING) {
  const normalizedKey = key.replace(/[_\-\s]/g, '');
  if (SENSITIVE_KEY.test(key) && !(typeof value === 'number' && USAGE_TOKEN_KEY.test(normalizedKey))) return '[REDACTED]';
  if (typeof value === 'string') {
    const replaced = value.replace(SENSITIVE_VALUE, '[REDACTED]');
    return replaced.length > maxLength ? `${replaced.slice(0, maxLength)}\n[TRUNCATED ${replaced.length - maxLength} chars]` : replaced;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, '', maxLength));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name, maxLength)]));
  }
  return value;
}

function containsSensitiveValue(value) {
  const text = String(value || '');
  return redact(text, '', Number.POSITIVE_INFINITY) !== text;
}

function appendTerminalAudit(job) {
  const file = auditLogPath();
  const completedAt = job.completedAt || Math.floor(Date.now() / 1000);
  const record = redact({
    at: Date.now(),
    jobId: job.id,
    who: job.managedBy || 'legacy',
    provider: job.provider || null,
    model: job.resolvedModel || job.model || job.requestedModel || null,
    mode: job.mode || null,
    sandbox: job.sandbox || 'auto',
    network: job.network === true,
    approval: job.approval || 'auto',
    cwd: job.cwd || null,
    changedFilesCount: job.changedFiles?.count || 0,
    scopeViolationsCount: job.scopeViolations?.length || 0,
    outcome: {
      status: job.status,
      stoppedReason: job.stoppedReason || null,
      errorCode: job.errorCode || null,
      error: job.error || null
    },
    usage: job.usage || null,
    durationMs: job.durationMs ?? Math.max(0, (completedAt - (job.createdAt || completedAt)) * 1000)
  });
  withFileLock(`${file}.lock`, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  });
}

function writeTerminalArtifacts(job, wasTerminal) {
  if (wasTerminal || !TERMINAL_STATUSES.has(job.status)) return;
  const sentinel = paths(job.id).finished;
  if (!fs.existsSync(sentinel)) writePrivate(sentinel, `${job.status}\n`);
  appendTerminalAudit(job);
}

export function eventPath(id) { return paths(id).events; }

// Streaming deltas can split a credential across chunk boundaries, evading
// per-chunk regexes. Keep a bounded per-stream tail and suppress any chunk
// whose combination with the tail matches a sensitive pattern, so the journal
// never holds the completing fragment of a secret.
const DELTA_TAIL_CHARS = 256;

export class DeltaRedactor {
  constructor() {
    this.tails = new Map();
  }

  redactDelta(streamId, delta) {
    const key = String(streamId ?? 'default');
    const text = delta == null ? '' : String(delta);
    const tail = this.tails.get(key) || '';
    const combined = `${tail}${text}`;
    this.tails.set(key, combined.slice(-DELTA_TAIL_CHARS));
    if (redact(combined, '', Number.POSITIVE_INFINITY) !== combined) return '[REDACTED]';
    return redact(text);
  }
}

function readRawEvents(id) {
  try {
    return fs.readFileSync(eventPath(id), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function resumabilityFor(job) {
  if (job.managedBy !== 'delegate-control') {
    return { ok: false, reason: 'legacy jobs cannot be resumed through delegate_resume', code: 'UNMANAGED_JOB' };
  }
  if (!TERMINAL_STATUSES.has(job.status)) {
    return { ok: false, reason: `job is ${job.status}; only terminal jobs can be resumed`, code: 'PARENT_ACTIVE' };
  }
  if (!job.providerSessionId && !job.session) {
    return { ok: false, reason: 'the job has no provider continuation id', code: 'SESSION_UNAVAILABLE' };
  }
  if (job.provider === 'codex' && job.reviewFlowEngaged === true) {
    return { ok: false, reason: 'the Codex thread engaged the multi-agent review flow and is not directly resumable', code: 'RESUME_UNSUPPORTED' };
  }
  return { ok: true, reason: 'the terminal job has a resumable provider session', code: null };
}

export function jobResumability(job) {
  const result = resumabilityFor(job);
  return { ok: result.ok, reason: result.reason };
}

function checkpointFor(job) {
  const continuationId = job.providerSessionId || job.session || null;
  const lastDiffEventSeq = readRawEvents(job.id).filter((event) => event.type === 'diff.updated').at(-1)?.seq || null;
  const resumable = resumabilityFor(job);
  return {
    failureReason: job.errorCode || job.stoppedReason || (job.status === 'cancelled' ? 'cancelled' : 'failed'),
    continuationId,
    lastDiffEventSeq,
    resumeHint: resumable.ok
      ? 'resume this thread with delegate_resume and a packet folding in the partial diff'
      : 'start fresh; thread not resumable'
  };
}

function ensureCheckpoint(job) {
  if (['failed', 'cancelled'].includes(job.status)) job.checkpoint = checkpointFor(job);
}

function repairAndReadLastEvent(file) {
  let fd;
  try { fd = fs.openSync(file, 'r+'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    let size = fs.fstatSync(fd).size;
    if (!size) return null;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) {
      let position = size;
      let boundary = -1;
      while (position > 0 && boundary < 0) {
        const length = Math.min(8192, position);
        const chunk = Buffer.alloc(length);
        position -= length;
        fs.readSync(fd, chunk, 0, length, position);
        const index = chunk.lastIndexOf(0x0a);
        if (index >= 0) boundary = position + index + 1;
      }
      fs.ftruncateSync(fd, boundary >= 0 ? boundary : 0);
      size = boundary >= 0 ? boundary : 0;
      if (!size) return null;
    }
    let end = size - 1;
    let position = end;
    const chunks = [];
    while (position > 0) {
      const length = Math.min(8192, position);
      const chunk = Buffer.alloc(length);
      position -= length;
      fs.readSync(fd, chunk, 0, length, position);
      const index = chunk.lastIndexOf(0x0a);
      if (index >= 0) {
        chunks.unshift(chunk.subarray(index + 1));
        break;
      }
      chunks.unshift(chunk);
    }
    const line = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(line); } catch { return null; }
  } finally { fs.closeSync(fd); }
}

function previousNewlineOffset(fd, before) {
  let position = before;
  while (position > 0) {
    const length = Math.min(8192, position);
    const chunk = Buffer.allocUnsafe(length);
    position -= length;
    const bytesRead = fs.readSync(fd, chunk, 0, length, position);
    const index = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (index >= 0) return position + index;
  }
  return -1;
}

function readLastCompleteEvent(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const end = previousNewlineOffset(fd, size);
    if (end <= 0) return null;
    const start = previousNewlineOffset(fd, end) + 1;
    const line = Buffer.alloc(end - start);
    const bytesRead = fs.readSync(fd, line, 0, line.length, start);
    if (bytesRead !== line.length) return null;
    try { return JSON.parse(line.toString('utf8')); } catch { return null; }
  } finally { fs.closeSync(fd); }
}

function appendUnlocked(job, type, data = {}, options = {}) {
  const journal = eventPath(job.id);
  const latest = repairAndReadLastEvent(journal)?.seq || 0;
  job.lastSeq = Math.max(job.lastSeq || 0, latest);
  const seq = (job.lastSeq || 0) + 1;
  let eventData = redact(data);
  if (type === 'diff.updated' && typeof data.diff === 'string' && data.diff.length > MAX_STRING) {
    const diff = redact(data.diff, '', Number.POSITIVE_INFINITY);
    const directory = paths(job.id).artifacts;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(directory, `${seq}-diff.patch`);
    writePrivate(artifactPath, diff);
    eventData = {
      ...redact({ ...data, diff: undefined }),
      artifactPath,
      bytes: Buffer.byteLength(diff),
      sha256: crypto.createHash('sha256').update(diff).digest('hex')
    };
  }
  const event = {
    v: EVENT_VERSION,
    seq,
    at: Date.now(),
    jobId: job.id,
    provider: job.provider,
    sessionId: options.sessionId ?? job.providerSessionId ?? job.session ?? null,
    turnId: options.turnId ?? job.providerTurnId ?? null,
    type,
    redacted: true,
    data: eventData
  };
  fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(journal, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  try { fs.chmodSync(journal, 0o600); } catch {}
  job.lastSeq = seq;
  job.updatedAt = Math.floor(Date.now() / 1000);
  return event;
}

export function appendJobEvent(id, type, data = {}, options = {}) {
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    const event = appendUnlocked(job, type, data, options);
    if (options.lifecycle) job.revision = (job.revision || 0) + 1;
    saveJob(job);
    return event;
  });
}

export function updateManagedJob(id, mutate, options = {}) {
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    if (options.expectedRevision != null && job.revision !== options.expectedRevision) {
      throw brokerError('REVISION_CONFLICT', `expected ${options.expectedRevision}, current ${job.revision}`, {
        provider: job.provider,
        currentRevision: job.revision
      });
    }
    const wasTerminal = TERMINAL_STATUSES.has(job.status);
    mutate(job);
    ensureCheckpoint(job);
    if (options.incrementRevision !== false) job.revision = (job.revision || 0) + 1;
    job.updatedAt = Math.floor(Date.now() / 1000);
    saveJob(job);
    writeTerminalArtifacts(job, wasTerminal);
    return job;
  });
}

export function readJobEvents(id, options = {}) {
  assertJobId(id);
  const afterSeq = Number(options.afterSeq || 0);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 1000);
  const types = options.types ? new Set(options.types) : null;
  return readRawEvents(id)
    .filter((event) => event.seq > afterSeq && (!types || types.has(event.type)))
    .slice(0, limit);
}

// Long polls hit readJobEventPage every 200ms for a job's whole lifetime, so
// re-parsing the full journal per call turns quadratic on long heavy jobs.
// Consumers advance afterSeq monotonically, so one byte cursor per job lets a
// quiet poll cost a single stat() and a busy poll parse only the new tail.
const pageCursors = new Map();
const PAGE_CURSOR_LIMIT = 64;

function rememberPageCursor(id, seq, offset) {
  pageCursors.delete(id);
  pageCursors.set(id, { seq, offset });
  if (pageCursors.size > PAGE_CURSOR_LIMIT) {
    pageCursors.delete(pageCursors.keys().next().value);
  }
}

function lastCompleteSeq(text) {
  let end = text.lastIndexOf('\n');
  for (let attempts = 0; attempts < 3 && end >= 0; attempts += 1) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    try {
      const event = JSON.parse(text.slice(start, end));
      if (Number.isFinite(event.seq)) return event.seq;
    } catch {}
    end = start - 1;
  }
  return null;
}

export function readJobEventPage(id, options = {}) {
  assertJobId(id);
  const afterSeq = Number(options.afterSeq || 0);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 1000);
  const types = options.types ? new Set(options.types) : null;
  return withLock(id, () => {
    if (!loadJob(id)) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    const file = eventPath(id);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!size) return { events: [], nextSeq: afterSeq, latestSeq: afterSeq, hasMore: false };
    const cursor = pageCursors.get(id);
    const resumable = Boolean(cursor && cursor.seq === afterSeq && cursor.offset <= size);
    const offset = resumable ? cursor.offset : 0;
    if (offset === size) return { events: [], nextSeq: afterSeq, latestSeq: afterSeq, hasMore: false };
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const events = [];
    let nextSeq = afterSeq;
    let lineStart = 0;
    let limited = false;
    for (;;) {
      const newline = text.indexOf('\n', lineStart);
      if (newline < 0) break;
      let event = null;
      try { event = JSON.parse(text.slice(lineStart, newline)); } catch {}
      lineStart = newline + 1;
      if (event && Number.isFinite(event.seq) && event.seq > afterSeq) {
        nextSeq = event.seq;
        if (!types || types.has(event.type)) events.push(event);
        if (events.length >= limit) {
          limited = true;
          break;
        }
      }
    }
    rememberPageCursor(id, nextSeq, offset + Buffer.byteLength(text.slice(0, lineStart), 'utf8'));
    let latestSeq = nextSeq;
    if (limited) {
      const last = lastCompleteSeq(text);
      if (last != null) latestSeq = Math.max(latestSeq, last);
    }
    return { events, nextSeq, latestSeq, hasMore: nextSeq < latestSeq };
  });
}

const QUEUED_STALE_SECONDS = 600;

function isOrphaned(job) {
  const now = Math.floor(Date.now() / 1000);
  if (job.status === 'running') return !isProcessAlive(job.workerPid || job.pid);
  if (job.status === 'queued') return !job.pid && !job.workerPid && now - (job.createdAt || 0) > QUEUED_STALE_SECONDS;
  return false;
}

export function reconcileJob(id) {
  const job = loadJob(assertJobId(id));
  if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
  if (!isOrphaned(job)) return job;
  return withLock(id, () => {
    const current = loadJob(id);
    if (!current || !isOrphaned(current)) return current;
    current.status = 'failed';
    current.phase = 'failed';
    current.error ||= 'ORPHANED: worker exited without recording a terminal result';
    current.errorCode = 'ORPHANED';
    current.errorRetryable = true;
    if (current.provider) current.errorProvider = current.provider;
    current.completedAt = Math.floor(Date.now() / 1000);
    current.revision = (current.revision || 0) + 1;
    appendUnlocked(current, 'error', { code: 'ORPHANED', message: current.error, stage: 'reconcile' });
    ensureCheckpoint(current);
    saveJob(current);
    writeTerminalArtifacts(current, false);
    return current;
  });
}

function activityFields(job) {
  const event = readLastCompleteEvent(eventPath(job.id));
  const lastActivityAt = event?.at || (job.createdAt ? job.createdAt * 1000 : null);
  const configured = Number(process.env.DELEGATE_STALL_SECONDS ?? 300);
  const stallSeconds = Number.isFinite(configured) && configured >= 0 ? configured : 300;
  return {
    lastActivityAt,
    stalled: job.status === 'running' && lastActivityAt != null && Date.now() - lastActivityAt > stallSeconds * 1000
  };
}

export function inspectJob(id) {
  const job = reconcileJob(id);
  return {
    ...job,
    ...activityFields(job),
    resumable: jobResumability(job),
    driftReport: driftReportFor(job),
    promptPath: undefined,
    verifyCommandPath: undefined,
    managed: job.managedBy === 'delegate-control',
    legacy: job.managedBy !== 'delegate-control'
  };
}

function driftReportFor(job) {
  const changed = job.changedFiles;
  if (!changed) return { modified: [], newFiles: [], outsideScope: [] };
  const baseline = new Set(job.baselineFiles || []);
  const inventory = new Map(jobFiles(job.id).map((entry) => [entry.path, entry]));
  const entries = Array.isArray(changed.entries) && changed.entries.length
    ? changed.entries
    : (changed.files || []).map((file) => ({ path: file, ...inventory.get(file) }));
  const modified = [];
  const newFiles = [];
  const outsideScope = [];
  for (const entry of entries) {
    const file = entry?.path;
    if (!file) continue;
    const isNew = entry.status === '??' || /^(?:add|added|create|created)$/i.test(entry.kind || '')
      || (!entry.status && !entry.kind && !baseline.has(file));
    (isNew ? newFiles : modified).push(file);
    if (job.allowedPaths?.length && !pathMatchesScope(file, job.allowedPaths)) outsideScope.push(file);
  }
  for (const violation of job.scopeViolations || []) if (violation?.path) outsideScope.push(violation.path);
  const unique = (values) => [...new Set(values)];
  return { modified: unique(modified), newFiles: unique(newFiles), outsideScope: unique(outsideScope) };
}

function rootJobIdOf(job) {
  let current = job;
  const seen = new Set([job.id]);
  while (current.parentJobId && !seen.has(current.parentJobId)) {
    seen.add(current.parentJobId);
    const parent = loadJob(current.parentJobId);
    if (!parent) break;
    current = parent;
  }
  return current.id === job.id ? undefined : current.id;
}

export function listManagedJobs(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 100);
  const statuses = options.status?.length ? new Set([].concat(options.status)) : null;
  const jobs = [];
  for (const raw of listJobs()) {
    let job = raw;
    if (['running', 'queued'].includes(raw.status)) {
      try { job = reconcileJob(raw.id); } catch { job = raw; }
    }
    if (options.activeOnly && TERMINAL_STATUSES.has(job.status)) continue;
    if (statuses && !statuses.has(job.status)) continue;
    jobs.push({
      id: job.id,
      provider: job.provider,
      model: job.model || job.requestedModel || null,
      mode: job.mode || null,
      status: job.status,
      phase: job.phase || null,
      revision: job.revision ?? null,
      cwd: job.cwd || null,
      transport: job.transport || null,
      managed: job.managedBy === 'delegate-control',
      reviewFlowEngaged: job.reviewFlowEngaged === true ? true : undefined,
      scopeViolations: job.scopeViolations?.length ? job.scopeViolations.length : undefined,
      session: job.providerSessionId || job.session || null,
      rootJobId: rootJobIdOf(job),
      parentJobId: job.parentJobId || null,
      providerSessionId: job.providerSessionId || job.session || null,
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
      completedAt: job.completedAt || null,
      ...activityFields(job),
      resultPreview: typeof job.result === 'string'
        ? job.result.slice(0, 200)
        : typeof job.result?.text === 'string' && job.result.text.trim()
          ? job.result.text.slice(0, 200)
          : typeof job.result?.plan === 'string' ? job.result.plan.slice(0, 200) : null,
      changedFiles: job.changedFiles || null,
      resolvedModel: job.resolvedModel || null,
      error: job.error || null
    });
    if (jobs.length >= limit) break;
  }
  return { jobs };
}

const TRANSCRIPT_TYPES = new Set([
  'message.user', 'message.delta', 'message.completed', 'plan.updated',
  'tool.started', 'tool.output', 'tool.completed',
  'correction.requested', 'correction.applied', 'correction.queued', 'correction.restarted',
  'error'
]);
const TRANSCRIPT_VERBOSE_TYPES = new Set(['message.delta', 'tool.output']);

export function jobTranscriptPage(id, options = {}) {
  assertJobId(id);
  const afterSeq = Number(options.afterSeq || 0);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 1000);
  const verbose = options.verbose === true;
  const all = readRawEvents(id);
  const events = [];
  let nextSeq = afterSeq;
  for (const event of all) {
    if (event.seq <= afterSeq) continue;
    nextSeq = event.seq;
    if (TRANSCRIPT_TYPES.has(event.type) && (verbose || !TRANSCRIPT_VERBOSE_TYPES.has(event.type))) events.push(event);
    if (events.length >= limit) break;
  }
  const latestSeq = all.at(-1)?.seq || afterSeq;
  return { events, nextSeq, latestSeq, hasMore: nextSeq < latestSeq };
}

export function jobTranscript(id, options = {}) {
  return jobTranscriptPage(id, { limit: 1000, verbose: true, ...options }).events;
}

export function jobDiff(id) {
  const events = readRawEvents(id).filter((event) => event.type === 'diff.updated');
  const latest = events.at(-1)?.data || {};
  if (latest.artifactPath) {
    try { return fs.readFileSync(latest.artifactPath, 'utf8'); } catch {}
  }
  return latest.diff || '';
}

export function jobFiles(id) {
  // Providers report the same file inconsistently (ACP tool locations are
  // absolute, the git inventory is repo-relative); normalize to repo-relative
  // and dedupe so one file is one entry.
  let cwd = null;
  try { cwd = loadJob(id)?.cwd || null; } catch {}
  const resolvedCwd = cwd ? path.resolve(cwd) : null;
  const normalize = (file) => {
    if (resolvedCwd && path.isAbsolute(file)) {
      const relative = path.relative(resolvedCwd, file);
      if (relative && !relative.startsWith('..')) return relative;
    }
    return file;
  };
  const files = new Map();
  for (const event of readRawEvents(id)) {
    if (event.type !== 'file.changed') continue;
    const changes = event.data?.changes || [event.data];
    for (const change of changes) {
      const file = change.path || change.file || change.filePath;
      if (!file) continue;
      const normalized = normalize(file);
      files.set(normalized, { ...files.get(normalized), ...change, path: normalized, lastSeq: event.seq });
    }
  }
  return [...files.values()];
}

export function filterDiffPaths(diff, entries) {
  if (!entries?.length) return String(diff || '');
  const blocks = String(diff || '').split(/^(?=diff --git )/m);
  return blocks.filter((block) => {
    const header = block.match(/^diff --git a\/(.+) b\/(.+)$/m);
    return header ? pathMatchesScope(header[2], entries) : false;
  }).join('');
}

export function diffStat(diff) {
  const files = [];
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }
  return {
    files,
    totalFiles: files.length,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0)
  };
}

export function sliceDiff(diff, options = {}) {
  const text = String(diff || '');
  const offset = Math.max(Number(options.offset || 0), 0);
  const maxChars = Math.min(Math.max(Number(options.maxChars || 60000), 1000), 200000);
  const chunk = text.slice(offset, offset + maxChars);
  const nextOffset = offset + chunk.length;
  return {
    diff: chunk,
    offset,
    totalChars: text.length,
    nextOffset: nextOffset < text.length ? nextOffset : null
  };
}

// Bound a tool response by serialized size: verbose tool-output events can
// individually be tens of KB, so an event-count limit alone cannot protect
// MCP clients from oversized replies.
export function capEventsBySize(page, budget = 60000) {
  let used = 0;
  const kept = [];
  for (const event of page.events) {
    const size = JSON.stringify(event).length;
    if (kept.length && used + size > budget) break;
    used += size;
    kept.push(event);
  }
  if (kept.length === page.events.length) return page;
  const nextSeq = kept.at(-1)?.seq ?? page.nextSeq;
  return { events: kept, nextSeq, latestSeq: page.latestSeq, hasMore: true, truncated: 'response-size' };
}

function finiteValue(object, names) {
  for (const name of names) {
    const value = Number(object?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function usageTotals(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const source = usage.total && typeof usage.total === 'object' ? usage.total : usage;
  const inputTokens = finiteValue(source, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const outputTokens = finiteValue(source, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
  let totalTokens = finiteValue(source, ['totalTokens', 'total_tokens', 'tokenCount', 'token_count']);
  if (totalTokens == null && (inputTokens != null || outputTokens != null)) totalTokens = (inputTokens || 0) + (outputTokens || 0);
  if (inputTokens == null && outputTokens == null && totalTokens == null) return null;
  return { inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, totalTokens: totalTokens || 0 };
}

function observedUsage(job) {
  const events = readRawEvents(job.id).filter((event) => event.type === 'usage.updated');
  return events.at(-1)?.data || job.usage || null;
}

function jobChain(job) {
  const chain = [job];
  const seen = new Set([job.id]);
  let current = job;
  while (current.parentJobId && !seen.has(current.parentJobId)) {
    seen.add(current.parentJobId);
    const parent = loadJob(current.parentJobId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

export function jobUsage(id) {
  const job = inspectJob(id);
  const quota = effectiveUsage(loadState(), job.provider);
  const observed = observedUsage(job);
  const chain = jobChain(job);
  const cumulative = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let observedJobs = 0;
  for (const member of chain) {
    const totals = usageTotals(observedUsage(member));
    if (!totals) continue;
    observedJobs += 1;
    cumulative.inputTokens += totals.inputTokens;
    cumulative.outputTokens += totals.outputTokens;
    cumulative.totalTokens += totals.totalTokens;
  }
  return {
    observed,
    observedAvailable: Boolean(observed),
    ...(observed ? {} : { note: 'the provider did not emit usage data for this job; Cursor ACP does not always report it' }),
    chainCumulative: {
      rootJobId: chain[0].id,
      throughJobId: job.id,
      jobIds: chain.map((member) => member.id),
      observedJobs,
      ...cumulative
    },
    providerAllowance: quota
  };
}

function jobId(provider) {
  return `${provider}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function providerCapabilities(provider, transport) {
  const codex = provider === 'codex';
  return {
    events: true,
    transcript: 'live',
    diff: codex ? 'provider' : 'best-effort',
    files: codex ? 'provider' : 'best-effort',
    correction: codex ? 'same-turn' : transport === 'acp' ? 'cancel-resume' : 'cancel-resume',
    cancel: true,
    resume: true,
    usage: true,
    // Codex app-server loads trusted-project docs/hooks (CLAUDE.md fallback)
    // into the worker itself; Cursor workers do not, so orchestrators must
    // post-review or pre-authorize instead of relying on in-worker gates.
    selfEnforcesProjectHooks: codex
  };
}

const BASELINE_HASH_MAX_BYTES = 10 * 1024 * 1024;

// Content fingerprint of a working-tree file for baseline comparison. 'absent'
// is a real state (deleted at baseline vs deleted now compares equal); null
// means unknown (too large, unreadable), which callers must treat as
// "cannot prove unchanged" and fall back to including the file.
export function hashWorkingFile(cwd, file) {
  const absolute = path.join(cwd, file);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) {
    try { return crypto.createHash('sha256').update(`symlink:${fs.readlinkSync(absolute)}`).digest('hex'); }
    catch { return null; }
  }
  if (!stat.isFile() || stat.size > BASELINE_HASH_MAX_BYTES) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  } catch {
    return null;
  }
}

function gitBaseline(cwd) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) return { files: [], hashes: {} };
  const entries = result.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (file) files.push(file);
    if (/[RC]/.test(status) && entries[i + 1]) files.push(entries[++i]);
  }
  const unique = [...new Set(files)];
  const hashes = {};
  for (const file of unique) {
    const hash = hashWorkingFile(cwd, file);
    if (hash) hashes[file] = hash;
  }
  return { files: unique, hashes };
}

const TIMEOUT_MIN_SECONDS = 60;
const TIMEOUT_MAX_SECONDS = 86400;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scope entries are repo-relative path prefixes; '*' is a wildcard matching
// any characters (including '/'). A file matches an entry when it equals it,
// lives under it as a directory prefix, or matches its wildcard expansion.
export function pathMatchesScope(file, entries) {
  return (entries || []).some((entry) => {
    if (entry.includes('*')) {
      return new RegExp(`^${entry.split('*').map(escapeRegExp).join('.*')}(?:/|$)`).test(file);
    }
    return file === entry || file.startsWith(`${entry}/`);
  });
}

export function validatedAllowedPaths(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw brokerError('INVALID_REQUEST', 'allowedPaths must be a non-empty array of path strings');
  }
  const entries = value.map((item) => item.trim().replace(/^\.\//, '').replace(/\/+$/, ''));
  if (entries.some((item) => !item || item.startsWith('/') || item.split('/').includes('..'))) {
    throw brokerError('INVALID_REQUEST', 'allowedPaths entries must be repo-relative and must not contain ..');
  }
  return entries;
}

// 'off' disables provider sandboxing for the job (Codex danger-full-access,
// Cursor --sandbox disabled) so the worker can use git, host CLIs, and live
// web tools. It is a deliberate, per-job caller decision — never a default.
export function validatedSandbox(value) {
  if (value == null || value === 'auto') return null;
  if (value === 'off') return 'off';
  throw brokerError('INVALID_REQUEST', "sandbox must be 'auto' or 'off'");
}

function validatedEffort(value) {
  if (value == null) return null;
  if (!EFFORT_LEVELS.has(value)) throw brokerError('INVALID_REQUEST', `effort must be one of ${[...EFFORT_LEVELS].join(', ')}`);
  return value;
}

function validatedTimeoutSeconds(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < TIMEOUT_MIN_SECONDS || seconds > TIMEOUT_MAX_SECONDS) {
    throw brokerError('INVALID_REQUEST', `timeoutSeconds must be an integer between ${TIMEOUT_MIN_SECONDS} and ${TIMEOUT_MAX_SECONDS}`);
  }
  return seconds;
}

function validatedMaxOutputTokens(value) {
  if (value == null) return null;
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw brokerError('INVALID_REQUEST', 'maxOutputTokens must be a positive integer');
  }
  return tokens;
}

function validatedIdempotencyKey(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) {
    throw brokerError('INVALID_REQUEST', 'idempotencyKey must be 1-128 characters using letters, numbers, _, ., :, or -');
  }
  return value;
}

function validatedRetryPolicy(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('INVALID_REQUEST', 'retryPolicy must be an object');
  }
  const maxAttempts = Number(value.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw brokerError('INVALID_REQUEST', 'retryPolicy.maxAttempts must be an integer between 1 and 5');
  }
  if (!Array.isArray(value.retryOn)) throw brokerError('INVALID_REQUEST', 'retryPolicy.retryOn must be an array');
  const supported = new Set(['transport', 'rate-limit']);
  if (!value.retryOn.every((item) => supported.has(item))) {
    throw brokerError('INVALID_REQUEST', "retryPolicy.retryOn may contain only 'transport' and 'rate-limit'");
  }
  return { maxAttempts, retryOn: [...new Set(value.retryOn)] };
}

function validatedVerify(value, mode) {
  if (value == null) return null;
  if (!WRITE_MODES.has(mode)) throw brokerError('INVALID_REQUEST', 'verify is available only for write modes (implement and verify)');
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.command !== 'string' || !value.command.trim()) {
    throw brokerError('INVALID_REQUEST', 'verify.command must be a non-empty string');
  }
  const timeoutSeconds = value.timeoutSeconds == null ? 600 : Number(value.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    throw brokerError('INVALID_REQUEST', 'verify.timeoutSeconds must be an integer between 1 and 86400');
  }
  return { command: value.command, timeoutSeconds };
}

export function createManagedJob(options) {
  const provider = validateProvider(options.provider);
  if (provider === 'claude') throw brokerError('INVALID_REQUEST', 'Claude stays in the current session; managed jobs support codex and cursor');
  if (!options.prompt?.trim()) throw brokerError('INVALID_REQUEST', 'prompt is required', { provider });
  const sensitivePromptDetected = containsSensitiveValue(options.prompt);
  if (sensitivePromptDetected && options.allowSensitive !== true) {
    throw brokerError('SECRET_IN_PROMPT', 'the task packet contains a value that looks like a credential; remove it or explicitly set allowSensitive=true', { provider });
  }
  const timeoutSeconds = validatedTimeoutSeconds(options.timeoutSeconds);
  const maxOutputTokens = validatedMaxOutputTokens(options.maxOutputTokens);
  const idempotencyKey = validatedIdempotencyKey(options.idempotencyKey);
  const retryPolicy = validatedRetryPolicy(options.retryPolicy);
  const mode = options.mode || 'consult';
  const verify = validatedVerify(options.verify, mode);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw brokerError('INVALID_REQUEST', `cwd does not exist or is not a directory: ${cwd}`, { provider });
  const id = jobId(provider);
  const now = Math.floor(Date.now() / 1000);
  const transport = provider === 'cursor' ? (options.transport || 'acp') : 'app-server';
  if (provider === 'cursor' && !['acp', 'headless'].includes(transport)) throw brokerError('INVALID_REQUEST', `Invalid Cursor transport: ${transport}`, { provider });
  if (provider === 'codex' && options.transport && options.transport !== 'app-server') throw brokerError('INVALID_REQUEST', `Invalid Codex transport: ${options.transport}`, { provider });
  const p = paths(id);
  const baseline = gitBaseline(cwd);
  writePrivate(p.prompt, options.prompt);
  if (verify) writePrivate(p.verifyCommand, verify.command);
  const job = {
    schemaVersion: 2,
    id,
    provider,
    requestedModel: options.model || 'auto',
    model: options.model || 'auto',
    mode,
    approval: options.approval || 'auto',
    effort: validatedEffort(options.effort || null),
    timeoutSeconds,
    maxOutputTokens,
    idempotencyKey,
    retryPolicy,
    retries: 0,
    verify: verify ? { command: redact(verify.command), timeoutSeconds: verify.timeoutSeconds } : null,
    network: options.network === true,
    sandbox: validatedSandbox(options.sandbox),
    allowedPaths: validatedAllowedPaths(options.allowedPaths),
    allowSensitive: options.allowSensitive === true,
    status: 'queued',
    phase: 'queued',
    revision: 0,
    lastSeq: 0,
    cwd,
    transport,
    managedBy: 'delegate-control',
    capabilities: providerCapabilities(provider, transport),
    promptPath: p.prompt,
    verifyCommandPath: verify ? p.verifyCommand : null,
    stdoutPath: p.stdout,
    stderrPath: p.stderr,
    finishedPath: p.finished,
    providerSessionId: options.providerSessionId || null,
    parentJobId: options.parentJobId || null,
    createdAt: now,
    updatedAt: now,
    isolation: options.isolation || 'shared',
    attributionConfidence: options.isolation === 'worktree' ? 'high' : 'best-effort',
    baselineFiles: baseline.files,
    baselineHashes: baseline.hashes
  };
  saveJob(job);
  appendJobEvent(id, 'job.created', { provider, model: job.model, mode: job.mode, transport, isolation: job.isolation, ...(job.sandbox === 'off' ? { sandbox: 'off' } : {}) });
  if (sensitivePromptDetected) {
    appendJobEvent(id, 'security.warning', {
      code: 'SECRET_IN_PROMPT',
      message: 'Sensitive-value pattern detected in the task packet; allowSensitive=true authorized dispatch'
    });
  }
  if (WRITE_MODES.has(job.mode) && baseline.files.length) {
    appendJobEvent(id, 'baseline.dirty', { count: baseline.files.length, paths: baseline.files.slice(0, 20) });
  }
  appendJobEvent(id, 'message.user', { text: options.prompt });
  return inspectJob(id);
}

function assertNoActiveWriter(options) {
  if (!WRITE_MODES.has(options.mode) || options.isolation === 'worktree' || options.overrideWriter === true) return;
  const cwd = path.resolve(options.cwd || process.cwd());
  for (const other of listJobs()) {
    if (other.managedBy !== 'delegate-control' || !WRITE_MODES.has(other.mode) || other.isolation === 'worktree') continue;
    if (path.resolve(other.cwd || '') !== cwd) continue;
    const current = ['running', 'queued'].includes(other.status) ? reconcileJob(other.id) : other;
    if (TERMINAL_STATUSES.has(current.status)) continue;
    throw brokerError('WRITER_ACTIVE', `job ${current.id} (${current.mode}) is already ${current.status} in ${cwd}; wait for it, cancel it, or pass overrideWriter=true`, {
      provider: options.provider,
      activeJobId: current.id
    });
  }
}

function writerLockPath(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const digest = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return path.join(jobsDir(), `.writer-${digest}.lock`);
}

export function launchManagedJob(options) {
  const provider = validateProvider(options.provider);
  const launchOptions = { ...options, provider, idempotencyKey: validatedIdempotencyKey(options.idempotencyKey) };
  try { maybePruneJobs(); } catch {}

  const create = () => {
    if (launchOptions.idempotencyKey) {
      const cwd = path.resolve(launchOptions.cwd || process.cwd());
      const existing = listJobs().find((job) => job.idempotencyKey === launchOptions.idempotencyKey && path.resolve(job.cwd || '') === cwd);
      if (existing) return { job: inspectJob(existing.id), replayed: true };
    }
    if (!providerEnabled(provider)) throw brokerError('PROVIDER_DISABLED', `${provider} is disabled for this installation`, { provider });
    const overrides = String(process.env.DELEGATE_ALLOW_OVER_LIMIT || '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const usage = effectiveUsage(loadState(), provider);
    const threshold = launchOptions.providerSessionId ? 98 : avoidPercentFor(provider);
    if (!launchOptions.overrideLimit && !overrides.includes(provider) && !overrides.includes('all') && usage.known && usage.usedPercent >= threshold) {
      throw brokerError('QUOTA_GUARD', `${provider} is at ${usage.usedPercent}% (threshold ${threshold}%); route to a fallback or explicitly override`, { provider });
    }
    // GPT models have a native lane (Codex app-server); running them through
    // Cursor burns the Cursor API pool and loses the Codex harness. Allowed
    // only when explicitly requested or the native lane is unavailable.
    if (provider === 'cursor' && /^gpt-/i.test(launchOptions.model || '') && launchOptions.overrideLane !== true && !launchOptions.providerSessionId && providerEnabled('codex')) {
      const codexUsage = effectiveUsage(loadState(), 'codex');
      if (!(codexUsage.known && codexUsage.usedPercent >= avoidPercentFor('codex'))) {
        throw brokerError('WRONG_LANE', `'${launchOptions.model}' routes natively through Codex (provider=codex); use Cursor for GPT models only when the user explicitly asks for that (set overrideLane=true) or Codex is disabled or at its avoid threshold`, { provider });
      }
    }
    assertNoActiveWriter(launchOptions);
    return { job: createManagedJob(launchOptions), replayed: false };
  };
  // Idempotency lookup and writer admission share one per-cwd launch lock, so
  // concurrent retries cannot create or launch a second record.
  const needsLock = Boolean(launchOptions.idempotencyKey)
    || (WRITE_MODES.has(launchOptions.mode) && launchOptions.isolation !== 'worktree');
  const launched = needsLock ? withFileLock(writerLockPath(launchOptions), create) : create();
  if (launched.replayed) return launched.job;
  const job = launched.job;
  const p = paths(job.id);
  const stdout = fs.openSync(p.stdout, 'a', 0o600);
  const stderr = fs.openSync(p.stderr, 'a', 0o600);
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'delegate-worker');
  const child = spawn(process.execPath, [worker, '--job-id', job.id], {
    cwd: job.cwd,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
    env: process.env
  });
  child.once('error', (error) => {
    try {
      const typed = normalizeBrokerError(error, { provider, defaultCode: 'TRANSPORT_ERROR' });
      updateManagedJob(job.id, (current) => {
        current.status = 'failed';
        current.phase = 'failed';
        current.error = redact(typed.message);
        current.errorCode = typed.code;
        current.errorRetryable = typed.retryable;
        current.errorProvider = typed.provider;
        current.completedAt = Math.floor(Date.now() / 1000);
      });
      appendJobEvent(job.id, 'error', { code: typed.code, retryable: typed.retryable, provider: typed.provider, error: typed.message, stage: 'worker-spawn' });
    } catch {}
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  updateManagedJob(job.id, (current) => {
    current.pid = child.pid;
    current.status = 'running';
    current.phase = 'starting';
  });
  child.unref();
  return inspectJob(job.id);
}

export function submitControl(id, command, expectedRevision) {
  assertJobId(id);
  if (!command?.type) throw brokerError('INVALID_REQUEST', 'control command type is required');
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    if (job.managedBy !== 'delegate-control') throw brokerError('UNMANAGED_JOB', 'live control is unavailable for this legacy job', { provider: job.provider });
    if (TERMINAL_STATUSES.has(job.status)) throw brokerError('JOB_TERMINAL', `job is already ${job.status}`, { provider: job.provider });
    const requestedId = command.commandId || command.correctionId || crypto.randomUUID();
    const commandId = /^[a-zA-Z0-9_-]{1,128}$/.test(requestedId)
      ? requestedId
      : `cmd-${crypto.createHash('sha256').update(requestedId).digest('hex').slice(0, 24)}`;
    job.controls ||= {};
    if (job.controls[commandId]) return { duplicate: true, commandId, job };
    if (!Number.isInteger(expectedRevision)) {
      throw brokerError('INVALID_REQUEST', `expectedRevision is required; current revision is ${job.revision}`, {
        provider: job.provider,
        currentRevision: job.revision
      });
    }
    if (job.revision !== expectedRevision) {
      throw brokerError('REVISION_CONFLICT', `expected ${expectedRevision}, current ${job.revision}`, {
        provider: job.provider,
        currentRevision: job.revision
      });
    }
    if (command.type === 'steer' && !command.text?.trim()) throw brokerError('INVALID_REQUEST', 'steering text is required', { provider: job.provider });
    if (command.type === 'steer' && command.strategy === 'same-turn' && job.provider === 'cursor') {
      throw brokerError('UNSUPPORTED_STRATEGY', 'Cursor ACP has no same-turn steering; use strategy=auto or restart (applied as a cancel-and-resume restart)', { provider: job.provider });
    }
    const record = { ...command, commandId, expectedRevision, requestedAt: Date.now() };
    fs.mkdirSync(paths(id).commands, { recursive: true, mode: 0o700 });
    writePrivate(path.join(paths(id).commands, `${commandId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    job.controls[commandId] = { type: command.type, state: 'queued', requestedAt: record.requestedAt };
    job.revision += 1;
    if (command.type === 'cancel') job.phase = 'cancelling';
    const type = command.type === 'steer' ? 'correction.requested' : command.type === 'cancel' ? 'job.cancel.requested' : 'job.resume.requested';
    appendUnlocked(job, type, { commandId, strategy: command.strategy || null, text: command.text || null });
    saveJob(job);
    return { accepted: true, commandId, revision: job.revision, phase: job.phase };
  });
}

export function claimCommands(id) {
  const p = paths(id);
  fs.mkdirSync(p.done, { recursive: true, mode: 0o700 });
  let names = [];
  try {
    names = fs.readdirSync(p.commands).filter((name) => name.endsWith('.json')).map((name) => {
      try {
        const command = JSON.parse(fs.readFileSync(path.join(p.commands, name), 'utf8'));
        return { name, requestedAt: command.requestedAt || 0 };
      } catch { return { name, requestedAt: 0 }; }
    }).sort((a, b) => a.requestedAt - b.requestedAt || a.name.localeCompare(b.name)).map((item) => item.name);
  } catch {}
  const claimed = [];
  for (const name of names) {
    const source = path.join(p.commands, name);
    const target = path.join(p.commands, `.processing-${process.pid}-${name}`);
    try {
      fs.renameSync(source, target);
      claimed.push({ path: target, command: JSON.parse(fs.readFileSync(target, 'utf8')) });
    } catch {}
  }
  return claimed;
}

export function completeCommand(id, claimed, outcome) {
  const commandId = claimed.command.commandId;
  withLock(id, () => {
    const job = loadJob(id);
    if (!job) return;
    job.controls ||= {};
    const state = outcome.state || (outcome.ok === false ? 'rejected' : 'applied');
    job.controls[commandId] = {
      ...job.controls[commandId],
      ...redact(outcome),
      state,
      ...(state === 'queued' ? {} : { completedAt: Date.now() })
    };
    appendUnlocked(job, state === 'queued' ? 'command.queued' : outcome.ok === false ? 'command.rejected' : 'command.applied', { commandId, ...outcome });
    saveJob(job);
  });
  try { fs.renameSync(claimed.path, path.join(paths(id).done, `${commandId}.json`)); } catch { try { fs.unlinkSync(claimed.path); } catch {} }
}

export function settleQueuedControl(id, commandId, outcome) {
  withLock(id, () => {
    const job = loadJob(id);
    if (!job?.controls?.[commandId]) return;
    const state = outcome.ok === false ? 'rejected' : 'applied';
    job.controls[commandId] = {
      ...job.controls[commandId],
      ...redact(outcome),
      state,
      completedAt: Date.now()
    };
    appendUnlocked(job, outcome.ok === false ? 'command.rejected' : 'command.applied', { commandId, ...outcome });
    saveJob(job);
  });
}

export function resumeManagedJob(id, options) {
  const parent = inspectJob(id);
  const resumability = resumabilityFor(parent);
  if (!resumability.ok) throw brokerError(resumability.code, resumability.reason, { provider: parent.provider });
  const storedParent = loadJob(id) || parent;
  let inheritedVerify = null;
  if (storedParent.verify && storedParent.verifyCommandPath) {
    try {
      inheritedVerify = {
        command: fs.readFileSync(storedParent.verifyCommandPath, 'utf8'),
        timeoutSeconds: storedParent.verify.timeoutSeconds
      };
    } catch {}
  }
  return launchManagedJob({
    provider: parent.provider,
    model: options.model || parent.model,
    mode: options.mode || parent.mode,
    approval: options.approval || parent.approval,
    effort: options.effort || parent.effort,
    allowSensitive: options.allowSensitive ?? parent.allowSensitive,
    cwd: options.cwd || parent.cwd,
    prompt: options.prompt,
    providerSessionId: parent.providerSessionId,
    parentJobId: parent.id,
    transport: parent.transport,
    isolation: parent.isolation,
    timeoutSeconds: options.timeoutSeconds ?? parent.timeoutSeconds ?? null,
    maxOutputTokens: options.maxOutputTokens ?? parent.maxOutputTokens ?? null,
    retryPolicy: options.retryPolicy ?? parent.retryPolicy ?? null,
    verify: options.verify ?? inheritedVerify,
    network: options.network ?? parent.network ?? false,
    sandbox: options.sandbox ?? parent.sandbox ?? null,
    allowedPaths: options.allowedPaths ?? parent.allowedPaths ?? null,
    overrideLimit: options.overrideLimit,
    overrideWriter: options.overrideWriter
  });
}

function safeJobFile(file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file)) return null;
  const normalized = path.normalize(file).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function trackedInHead(cwd, file) {
  const result = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', file], {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024
  });
  return result.status === 0 && result.stdout.split('\0').includes(file);
}

function trackedInIndex(cwd, file) {
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024
  }).status === 0;
}

export function revertManagedJob(id, options = {}) {
  const job = inspectJob(id);
  if (job.managedBy !== 'delegate-control') throw brokerError('UNMANAGED_JOB', 'revert is unavailable for legacy jobs', { provider: job.provider });
  if (!TERMINAL_STATUSES.has(job.status)) throw brokerError('INVALID_REQUEST', `job must be terminal before revert; current status is ${job.status}`, { provider: job.provider });
  const eventInventory = new Map(jobFiles(id).map((entry) => [entry.path, entry]));
  const entries = Array.isArray(job.changedFiles?.entries) && job.changedFiles.entries.length
    ? job.changedFiles.entries
    : (job.changedFiles?.files || []).map((file) => ({ path: file, ...eventInventory.get(file), finalHash: job.finalHashes?.[file] }));
  const baseline = new Set(job.baselineFiles || []);
  const dryRun = options.dryRun === true;
  const reverted = [];
  const skipped = [];
  const conflicts = [];

  if ((job.changedFiles?.count || 0) > entries.length) {
    return {
      dryRun,
      reverted,
      skipped,
      conflicts: [{ path: null, reason: `changed-file inventory is truncated (${entries.length} of ${job.changedFiles.count}); no files touched` }]
    };
  }

  for (const raw of entries) {
    const file = safeJobFile(raw?.path);
    if (!file) {
      conflicts.push({ path: raw?.path || null, reason: 'unsafe or invalid job file path' });
      continue;
    }
    const observed = eventInventory.get(file) || {};
    if (raw.preexisting || raw.overlapsPreexisting || observed.preexisting || observed.overlapsPreexisting || baseline.has(file)) {
      skipped.push({ path: file, reason: 'overlaps pre-existing work; manual resolution required' });
      continue;
    }
    const finalHash = raw.finalHash ?? job.finalHashes?.[file] ?? null;
    if (!finalHash) {
      conflicts.push({ path: file, reason: 'job final-state hash is unavailable; refusing unsafe revert' });
      continue;
    }
    const currentHash = hashWorkingFile(job.cwd, file);
    if (currentHash !== finalHash) {
      conflicts.push({ path: file, reason: 'current content changed after the job completed; not touched' });
      continue;
    }
    const tracked = trackedInHead(job.cwd, file);
    const action = tracked ? 'restore-tracked' : 'delete-created';
    if (!dryRun) {
      if (tracked) {
        const restored = spawnSync('git', ['checkout', 'HEAD', '--', file], {
          cwd: job.cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
        });
        if (restored.status !== 0) {
          conflicts.push({ path: file, reason: (restored.stderr || 'git checkout failed').trim() });
          continue;
        }
      } else {
        if (trackedInIndex(job.cwd, file)) {
          const unstaged = spawnSync('git', ['rm', '--cached', '--force', '--ignore-unmatch', '--', file], {
            cwd: job.cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
          });
          if (unstaged.status !== 0) {
            conflicts.push({ path: file, reason: (unstaged.stderr || 'git index cleanup failed').trim() });
            continue;
          }
        }
        try { fs.rmSync(path.join(job.cwd, file), { force: true }); }
        catch (error) {
          conflicts.push({ path: file, reason: error.message });
          continue;
        }
      }
    }
    reverted.push({ path: file, action, ...(dryRun ? { dryRun: true } : {}) });
  }
  return { dryRun, reverted, skipped, conflicts };
}

// Bounded synchronous-ish wait for the provider session id so gated
// orchestration (filing a plan under the delegate's session id) has no race
// between start and the worker's first write.
export async function waitForSessionId(id, timeoutMs = 30000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
  for (;;) {
    const job = inspectJob(id);
    if (job.providerSessionId || ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function pruneJobs(options = {}) {
  const days = Number(options.maxAgeDays ?? process.env.DELEGATE_JOB_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(days) || days <= 0) return { pruned: [], maxAgeDays: days };
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const pruned = [];
  for (const job of listJobs()) {
    if (!TERMINAL_STATUSES.has(job.status)) continue;
    const finishedAt = job.completedAt || job.updatedAt || job.createdAt || 0;
    if (finishedAt > cutoff) continue;
    const p = paths(job.id);
    for (const file of [p.events, p.prompt, p.verifyCommand, p.stdout, p.stderr, p.lock, p.finished, path.join(jobsDir(), `${job.id}.json`)]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    for (const directory of [p.commands, p.artifacts]) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    }
    pruned.push(job.id);
  }
  return { pruned, maxAgeDays: days };
}

const PRUNE_INTERVAL_MS = 6 * 3600 * 1000;

export function maybePruneJobs() {
  const stamp = path.join(jobsDir(), '.last-prune');
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < PRUNE_INTERVAL_MS) return null;
  } catch {}
  fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stamp, `${Date.now()}\n`, { mode: 0o600 });
  return pruneJobs();
}

export function defaultWorkerCommand() {
  return path.join(os.homedir(), '.local', 'state', 'delegate-router');
}
