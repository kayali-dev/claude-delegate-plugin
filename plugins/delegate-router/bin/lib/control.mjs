import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { avoidPercentFor, effectiveUsage, jobsDir, listJobs, loadJob, loadState, providerEnabled, saveJob, validateProvider } from './state.mjs';
import { isProcessAlive } from './process.mjs';
import { withFileLock } from './lock.mjs';

const EVENT_VERSION = 1;
const MAX_STRING = Number(process.env.DELEGATE_EVENT_MAX_STRING || 65536);
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SENSITIVE_VALUE = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH_?TOKEN|REFRESH_?TOKEN)[A-Z0-9_]*)["']?\s*[:=]\s*["']?[^"'\s,;]+|:\/\/[^/\s:@]+:[^@\s/]+@)/gi;
const USAGE_TOKEN_KEY = /^(?:(?:input|output|total|cached|reasoning|prompt|completion|billable|context)tokens?(?:count|usage)?|tokens?(?:count|usage))$/i;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]+$/;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertJobId(id) {
  if (!SAFE_JOB_ID.test(id || '')) throw new Error(`Invalid job id: ${id}`);
  return id;
}

function paths(id) {
  assertJobId(id);
  const root = jobsDir();
  return {
    events: path.join(root, `${id}.events.jsonl`),
    lock: path.join(root, `${id}.lock`),
    commands: path.join(root, `${id}.commands`),
    done: path.join(root, `${id}.commands`, 'done'),
    artifacts: path.join(root, `${id}.artifacts`),
    prompt: path.join(root, `${id}.prompt`),
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
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out locking job ${id}`);
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
    if (!job) throw new Error(`job not found: ${id}`);
    const event = appendUnlocked(job, type, data, options);
    if (options.lifecycle) job.revision = (job.revision || 0) + 1;
    saveJob(job);
    return event;
  });
}

export function updateManagedJob(id, mutate, options = {}) {
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (options.expectedRevision != null && job.revision !== options.expectedRevision) {
      const error = new Error(`REVISION_CONFLICT: expected ${options.expectedRevision}, current ${job.revision}`);
      error.code = 'REVISION_CONFLICT';
      error.currentRevision = job.revision;
      throw error;
    }
    mutate(job);
    if (options.incrementRevision !== false) job.revision = (job.revision || 0) + 1;
    job.updatedAt = Math.floor(Date.now() / 1000);
    saveJob(job);
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
    if (!loadJob(id)) throw new Error(`job not found: ${id}`);
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
  if (!job) throw new Error(`job not found: ${id}`);
  if (!isOrphaned(job)) return job;
  return withLock(id, () => {
    const current = loadJob(id);
    if (!current || !isOrphaned(current)) return current;
    current.status = 'failed';
    current.phase = 'failed';
    current.error ||= 'ORPHANED: worker exited without recording a terminal result';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.revision = (current.revision || 0) + 1;
    appendUnlocked(current, 'error', { code: 'ORPHANED', message: current.error, stage: 'reconcile' });
    saveJob(current);
    return current;
  });
}

export function inspectJob(id) {
  const job = reconcileJob(id);
  return {
    ...job,
    promptPath: undefined,
    managed: job.managedBy === 'delegate-control',
    legacy: job.managedBy !== 'delegate-control'
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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
      parentJobId: job.parentJobId || null,
      providerSessionId: job.providerSessionId || job.session || null,
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
      completedAt: job.completedAt || null,
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
  const files = new Map();
  for (const event of readRawEvents(id)) {
    if (event.type !== 'file.changed') continue;
    const changes = event.data?.changes || [event.data];
    for (const change of changes) {
      const file = change.path || change.file || change.filePath;
      if (file) files.set(file, { path: file, ...change, lastSeq: event.seq });
    }
  }
  return [...files.values()];
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

export function jobUsage(id) {
  const job = inspectJob(id);
  const events = readRawEvents(id).filter((event) => event.type === 'usage.updated');
  const quota = effectiveUsage(loadState(), job.provider);
  const observed = events.at(-1)?.data || job.usage || null;
  return {
    observed,
    observedAvailable: Boolean(observed),
    ...(observed ? {} : { note: 'the provider did not emit usage data for this job; Cursor ACP does not always report it' }),
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
    usage: true
  };
}

function gitBaseline(cwd) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) return [];
  const entries = result.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (file) files.push(file);
    if (/[RC]/.test(status) && entries[i + 1]) files.push(entries[++i]);
  }
  return [...new Set(files)];
}

const TIMEOUT_MIN_SECONDS = 60;
const TIMEOUT_MAX_SECONDS = 86400;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function validatedEffort(value) {
  if (value == null) return null;
  if (!EFFORT_LEVELS.has(value)) throw new Error(`effort must be one of ${[...EFFORT_LEVELS].join(', ')}`);
  return value;
}

function validatedTimeoutSeconds(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < TIMEOUT_MIN_SECONDS || seconds > TIMEOUT_MAX_SECONDS) {
    throw new Error(`timeoutSeconds must be an integer between ${TIMEOUT_MIN_SECONDS} and ${TIMEOUT_MAX_SECONDS}`);
  }
  return seconds;
}

export function createManagedJob(options) {
  const provider = validateProvider(options.provider);
  if (provider === 'claude') throw new Error('Claude stays in the current session; managed jobs support codex and cursor');
  if (!options.prompt?.trim()) throw new Error('prompt is required');
  const timeoutSeconds = validatedTimeoutSeconds(options.timeoutSeconds);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  const id = jobId(provider);
  const now = Math.floor(Date.now() / 1000);
  const transport = provider === 'cursor' ? (options.transport || 'acp') : 'app-server';
  if (provider === 'cursor' && !['acp', 'headless'].includes(transport)) throw new Error(`Invalid Cursor transport: ${transport}`);
  if (provider === 'codex' && options.transport && options.transport !== 'app-server') throw new Error(`Invalid Codex transport: ${options.transport}`);
  const p = paths(id);
  writePrivate(p.prompt, options.prompt);
  const job = {
    schemaVersion: 2,
    id,
    provider,
    requestedModel: options.model || 'auto',
    model: options.model || 'auto',
    mode: options.mode || 'consult',
    approval: options.approval || 'auto',
    effort: validatedEffort(options.effort || null),
    timeoutSeconds,
    network: options.network === true,
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
    stdoutPath: p.stdout,
    stderrPath: p.stderr,
    providerSessionId: options.providerSessionId || null,
    parentJobId: options.parentJobId || null,
    createdAt: now,
    updatedAt: now,
    isolation: options.isolation || 'shared',
    attributionConfidence: options.isolation === 'worktree' ? 'high' : 'best-effort',
    baselineFiles: gitBaseline(cwd)
  };
  saveJob(job);
  appendJobEvent(id, 'job.created', { provider, model: job.model, mode: job.mode, transport, isolation: job.isolation });
  appendJobEvent(id, 'message.user', { text: options.prompt });
  return inspectJob(id);
}

const WRITE_MODES = new Set(['implement', 'verify']);

function assertNoActiveWriter(options) {
  if (!WRITE_MODES.has(options.mode) || options.isolation === 'worktree' || options.overrideWriter === true) return;
  const cwd = path.resolve(options.cwd || process.cwd());
  for (const other of listJobs()) {
    if (other.managedBy !== 'delegate-control' || !WRITE_MODES.has(other.mode) || other.isolation === 'worktree') continue;
    if (path.resolve(other.cwd || '') !== cwd) continue;
    const current = ['running', 'queued'].includes(other.status) ? reconcileJob(other.id) : other;
    if (TERMINAL_STATUSES.has(current.status)) continue;
    const error = new Error(`WRITER_ACTIVE: job ${current.id} (${current.mode}) is already ${current.status} in ${cwd}; wait for it, cancel it, or pass overrideWriter=true`);
    error.code = 'WRITER_ACTIVE';
    error.activeJobId = current.id;
    throw error;
  }
}

function writerLockPath(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const digest = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return path.join(jobsDir(), `.writer-${digest}.lock`);
}

export function launchManagedJob(options) {
  const provider = validateProvider(options.provider);
  if (!providerEnabled(provider)) throw new Error(`PROVIDER_DISABLED: ${provider} is disabled for this installation`);
  const overrides = String(process.env.DELEGATE_ALLOW_OVER_LIMIT || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const usage = effectiveUsage(loadState(), provider);
  const threshold = options.providerSessionId ? 98 : avoidPercentFor(provider);
  if (!options.overrideLimit && !overrides.includes(provider) && !overrides.includes('all') && usage.known && usage.usedPercent >= threshold) {
    throw new Error(`QUOTA_GUARD: ${provider} is at ${usage.usedPercent}% (threshold ${threshold}%); route to a fallback or explicitly override`);
  }
  try { maybePruneJobs(); } catch {}
  // The guard check and the job-record creation must be atomic per cwd, or two
  // concurrent write-mode launches can both pass the check before either
  // persists its record.
  const job = WRITE_MODES.has(options.mode) && options.isolation !== 'worktree'
    ? withFileLock(writerLockPath(options), () => {
        assertNoActiveWriter(options);
        return createManagedJob(options);
      })
    : createManagedJob(options);
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
      updateManagedJob(job.id, (current) => {
        current.status = 'failed';
        current.phase = 'failed';
        current.error = redact(error.message);
        current.completedAt = Math.floor(Date.now() / 1000);
      });
      appendJobEvent(job.id, 'error', { error: error.message, stage: 'worker-spawn' });
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
  if (!command?.type) throw new Error('control command type is required');
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (job.managedBy !== 'delegate-control') throw new Error('UNMANAGED_JOB: live control is unavailable for this legacy job');
    if (['completed', 'failed', 'cancelled'].includes(job.status)) throw new Error(`JOB_TERMINAL: job is already ${job.status}`);
    const requestedId = command.commandId || command.correctionId || crypto.randomUUID();
    const commandId = /^[a-zA-Z0-9_-]{1,128}$/.test(requestedId)
      ? requestedId
      : `cmd-${crypto.createHash('sha256').update(requestedId).digest('hex').slice(0, 24)}`;
    job.controls ||= {};
    if (job.controls[commandId]) return { duplicate: true, commandId, job };
    if (!Number.isInteger(expectedRevision)) {
      const error = new Error(`expectedRevision is required; current revision is ${job.revision}`);
      error.currentRevision = job.revision;
      throw error;
    }
    if (job.revision !== expectedRevision) {
      const error = new Error(`REVISION_CONFLICT: expected ${expectedRevision}, current ${job.revision}`);
      error.code = 'REVISION_CONFLICT';
      error.currentRevision = job.revision;
      throw error;
    }
    if (command.type === 'steer' && !command.text?.trim()) throw new Error('steering text is required');
    if (command.type === 'steer' && command.strategy === 'same-turn' && job.provider === 'cursor') {
      throw new Error('UNSUPPORTED_STRATEGY: Cursor ACP has no same-turn steering; use strategy=auto or restart (applied as a cancel-and-resume restart)');
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
  if (!['completed', 'failed', 'cancelled'].includes(parent.status)) {
    throw new Error(`PARENT_ACTIVE: cannot resume while ${parent.id} is ${parent.status}`);
  }
  if (!parent.providerSessionId) throw new Error('SESSION_UNAVAILABLE: the original job has no continuation id');
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
    network: options.network ?? parent.network ?? false,
    overrideLimit: options.overrideLimit,
    overrideWriter: options.overrideWriter
  });
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
    for (const file of [p.events, p.prompt, p.stdout, p.stderr, p.lock, path.join(jobsDir(), `${job.id}.json`)]) {
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
