import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { auditLogPath, avoidPercentFor, dataDir, effectiveUsage, jobsDir, listJobs, loadJob, loadState, providerConfigPath, providerEnabled, saveJob, statePath, validateProvider } from './state.mjs';
import { isProcessAlive } from './process.mjs';
import { withFileLock } from './lock.mjs';
import { assembleProviderPrompt } from './packet.mjs';
import { applyProfile, lintPacket } from './profiles.mjs';
import { ensureSupervisorReady, submitJobToSupervisor } from './supervisor-client.mjs';
import { supervisorBrokerVersion } from './supervisor-common.mjs';
import { acceptanceEvidenceDigest, buildAcceptance } from './acceptance.mjs';
import {
  deriveVerificationProfile,
  verificationRepositoryRevision
} from './verification-profile.mjs';
import {
  ambiguityDefault,
  contractDigest,
  interrogationOutputTokenLimit,
  planFirstDefault,
  planOutputTokenLimit,
  planPrompt
} from './planning.mjs';

const EVENT_VERSION = 1;
const MAX_STRING = Number(process.env.DELEGATE_EVENT_MAX_STRING || 65536);
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SENSITIVE_VALUE = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH_?TOKEN|REFRESH_?TOKEN)[A-Z0-9_]*)["']?\s*[:=]\s*["']?[^"'\s,;]+|:\/\/[^/\s:@]+:[^@\s/]+@)/gi;
// Usage counters often compose several semantic atoms (for example
// cachedInputTokens or reasoningOutputTokens). Keep those numeric counters
// inspectable without weakening the blanket treatment of auth/access tokens.
const USAGE_TOKEN_KEY = /^(?:(?:(?:max|observed|cached|reasoning|billable|prompt|completion|input|output|total|context)+tokens?(?:count|usage)?)|tokens?(?:count|usage))$/i;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]+$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const WRITE_MODES = new Set(['implement', 'verify']);
const READ_MODES = new Set(['consult', 'plan', 'review']);
export const DIRECT_TRANSPORTS = Object.freeze(new Set(['direct-mcp', 'direct-cli', 'direct-acp']));
export const READ_ONLY_TRANSPORTS = Object.freeze(new Set([...DIRECT_TRANSPORTS, 'claude-agent']));
const INGEST_MAX_FILES = 20;
const INGEST_MAX_BYTES = 10 * 1024 * 1024;
const COLLISION_RECORD_CAP = 256;
const COLLISION_OWN_WRITE_CAP = 512;
const COLLISION_SELF_WRITE_WINDOW_MS = 2000;
const COLLISION_EVENTS = new Set(['change', 'add', 'unlink', 'PostToolUse', 'PostToolBatch']);
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private.?key|token)[^/]*|[^/]+\.(?:pem|key|p12|pfx|crt|cer))$/i;
const PACKET_SECTION_ORDER = [
  'Objective',
  'Mode',
  'Allowed scope',
  'Relevant context',
  'Constraints and non-goals',
  'Acceptance criteria',
  'Required verification',
  'Stop and report when',
  'Return'
];

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

function signalCollisionWatchRefresh() {
  const file = path.join(dataDir(), 'collision-watch.signal');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${Date.now()}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

function canonicalOriginDirectory(value, fallback = process.cwd()) {
  const resolved = path.resolve(String(value || fallback));
  try {
    return (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

function coordinatorSessionIdentity(value) {
  if (value == null || value === '') return null;
  const sessionId = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sessionId) ? sessionId : null;
}

// Capture coordinator identity at the launch boundary. This is intentionally
// separate from job.cwd: coordinators routinely delegate into other trees.
export function launchOrigin(options = {}) {
  if (options.origin && typeof options.origin === 'object' && options.origin.projectDir) {
    return { ...options.origin };
  }
  const launchCwd = canonicalOriginDirectory(options.launchCwd || process.cwd());
  const projectDir = canonicalOriginDirectory(
    options.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? launchCwd,
    launchCwd
  );
  return {
    projectDir,
    cwd: launchCwd,
    sessionId: coordinatorSessionIdentity(
      options.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID
    ),
    workspaceId: canonicalOriginDirectory(options.workspaceId ?? projectDir, projectDir),
    brokerVersion: supervisorBrokerVersion(),
    launchedAtMs: Number(options.launchedAtMs ?? Date.now())
  };
}

export function redact(value, key = '', maxLength = MAX_STRING) {
  const normalizedKey = key.replace(/[_\-\s]/g, '');
  if (SENSITIVE_KEY.test(key)) {
    const usageKey = USAGE_TOKEN_KEY.test(normalizedKey);
    const usageObject = usageKey && value && typeof value === 'object' && !Array.isArray(value);
    if (!(usageKey && typeof value === 'number') && !usageObject) return '[REDACTED]';
  }
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

export function terminalAuditRecord(job, options = {}) {
  const completedAt = job.completedAt || Math.floor(Date.now() / 1000);
  return redact({
    at: Date.now(),
    jobId: job.id,
    who: job.managedBy || 'legacy',
    provider: job.provider || null,
    model: job.resolvedModel || job.model || job.requestedModel || null,
    requestedModel: job.requestedModel || job.model || null,
    mode: job.mode || null,
    effort: job.effort || null,
    transport: job.transport || null,
    executionOwner: job.executionOwner || null,
    attemptLease: job.attemptLease || null,
    executionAttribution: job.executionAttribution || null,
    failureAttribution: job.failureAttribution || null,
    providerSessionId: job.providerSessionId || job.session || null,
    parentJobId: job.parentJobId || null,
    rootJobId: rootJobIdOf(job) || job.id,
    groupId: job.groupId || null,
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
    verification: job.verification || null,
    verificationOrigin: job.verificationOrigin || null,
    acceptance: job.acceptance || null,
    nudgeCount: job.nudgeCount || 0,
    durationMs: job.durationMs ?? Math.max(0, (completedAt - (job.createdAt || completedAt)) * 1000),
    ...(options.backfilled === true ? { backfilled: true } : {})
  });
}

function appendAuditRecordsUnlocked(file, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function appendAuditRecords(records) {
  if (!records.length) return;
  const file = auditLogPath();
  withFileLock(`${file}.lock`, () => {
    appendAuditRecordsUnlocked(file, records);
  });
}

function appendTerminalAudit(job) {
  appendAuditRecords([terminalAuditRecord(job)]);
}

function appendTerminalAuditIfMissing(job) {
  const file = auditLogPath();
  withFileLock(`${file}.lock`, () => {
    let found = false;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          if (JSON.parse(line)?.jobId === job.id) { found = true; break; }
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!found) appendAuditRecordsUnlocked(file, [terminalAuditRecord(job)]);
  });
}

function writeTerminalArtifacts(job, wasTerminal) {
  if (wasTerminal || !TERMINAL_STATUSES.has(job.status)) return;
  const sentinel = paths(job.id).finished;
  if (!fs.existsSync(sentinel)) writePrivate(sentinel, `${job.status}\n`);
  // The resident owns process-exit telemetry. Delay its audit row until the
  // lease is finalized, while keeping the ordinary terminal sentinel and
  // store transition immediate for pull readers and the P2a monitor.
  if (job.executionOwner === 'supervisor' && job.attemptLease && job.executionAttribution?.finalized !== true) return;
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

function comparableLines(value) {
  if (typeof value !== 'string') return null;
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function textLineCounts(oldText, newText) {
  let before = comparableLines(oldText);
  let after = comparableLines(newText);
  if (!before || !after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  before = before.slice(prefix, beforeEnd);
  after = after.slice(prefix, afterEnd);
  if (!before.length || !after.length) return { added: after.length, removed: before.length };
  // Event strings are byte-bounded, but a newline-heavy full-file edit can
  // still create a pathological quadratic line diff. Unknown is safer than
  // stalling journal ingestion or inventing counts for that rare shape.
  if (before.length * after.length > 4_000_000) return null;

  // Myers' shortest-edit-path algorithm gives exact line counts without the
  // quadratic memory cost of an LCS matrix for full-file Cursor edits.
  const maximum = before.length + after.length;
  const offset = maximum + 1;
  const frontier = new Int32Array(maximum * 2 + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  for (let distance = 0; distance <= maximum; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let x;
      if (diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])) x = frontier[index + 1];
      else x = frontier[index - 1] + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x += 1; y += 1; }
      frontier[index] = x;
      if (x >= before.length && y >= after.length) {
        const common = (before.length + after.length - distance) / 2;
        return { added: after.length - common, removed: before.length - common };
      }
    }
  }
  return null;
}

function unifiedDiffLineCounts(diff) {
  if (typeof diff !== 'string' || !diff) return null;
  let added = 0;
  let removed = 0;
  let observed = false;
  for (const line of diff.split(/\r?\n/)) {
    if (/^\+\+\+(?:\s|$)/.test(line) || /^---(?:\s|$)/.test(line)) continue;
    if (line.startsWith('+')) { added += 1; observed = true; }
    else if (line.startsWith('-')) { removed += 1; observed = true; }
  }
  return observed ? { added, removed } : null;
}

function normalizedFilePath(value, cwd = '') {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (cwd && path.isAbsolute(raw)) return (path.relative(path.resolve(cwd), path.resolve(raw)) || '.').replaceAll('\\', '/');
  return raw.replaceAll('\\', '/').replace(/^\.\//, '');
}

function knownLineCounts(change) {
  if (change?.added == null || change?.removed == null) {
    return unifiedDiffLineCounts(change?.diff ?? change?.patch)
      || textLineCounts(change?.oldText ?? change?.old_text, change?.newText ?? change?.new_text);
  }
  const added = Number(change?.added);
  const removed = Number(change?.removed);
  if (Number.isSafeInteger(added) && added >= 0 && Number.isSafeInteger(removed) && removed >= 0) return { added, removed };
  return unifiedDiffLineCounts(change?.diff ?? change?.patch)
    || textLineCounts(change?.oldText ?? change?.old_text, change?.newText ?? change?.new_text);
}

function normalizeFileChange(change, cwd) {
  const source = change && typeof change === 'object' && !Array.isArray(change) ? change : {};
  const kind = String(source.kind || source.operation || source.status || '').toLowerCase();
  const renamed = /rename/.test(kind);
  const moved = /move/.test(kind);
  const deleted = /delete|remove|^d\b/.test(kind);
  const rawPath = source.path ?? source.file ?? source.filePath ?? source.filename;
  const rawNewPath = source.newPath ?? source.new_path ?? source.toPath ?? source.to;
  const rawOldPath = source.oldPath ?? source.old_path ?? source.fromPath ?? source.from ?? ((renamed || moved) && rawNewPath ? rawPath : null);
  const oldPath = normalizedFilePath(rawOldPath, cwd);
  const newPath = normalizedFilePath(rawNewPath, cwd);
  const anchorPath = newPath || normalizedFilePath(rawPath, cwd) || oldPath;
  const counts = knownLineCounts(source);
  const action = renamed ? 'renamed' : moved ? 'moved' : deleted ? 'deleted' : null;
  const label = action === 'renamed' || action === 'moved'
    ? oldPath && anchorPath && oldPath !== anchorPath ? `${oldPath} ${action} → ${anchorPath}` : `${anchorPath || 'file'} ${action}`
    : `${anchorPath || 'file'}${action ? ` ${action}` : ''}`;
  const text = `✎ ${label}${counts ? ` (+${counts.added} −${counts.removed})` : ''}`;
  return {
    ...source,
    ...(anchorPath ? { path: anchorPath } : {}),
    ...(oldPath ? { oldPath } : {}),
    ...(newPath ? { newPath } : {}),
    ...(counts || {}),
    label,
    text
  };
}

function compactFileChange(change) {
  const { diff, patch, oldText, old_text, newText, new_text, ...compact } = change;
  return compact;
}

export function normalizeFileChangedEvent(event, cwd = '', options = {}) {
  if (!event || event.type !== 'file.changed') return event;
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
  const listed = Array.isArray(data.changes) ? data.changes : [data];
  const normalized = listed.map((change) => normalizeFileChange(change, cwd));
  const changes = options.compact === true ? normalized.map(compactFileChange) : normalized;
  const { diff, patch, oldText, old_text, newText, new_text, changes: ignoredChanges, ...outer } = data;
  const single = Array.isArray(data.changes) ? {} : changes[0] || {};
  return {
    ...event,
    data: {
      ...outer,
      ...single,
      changes,
      text: changes.map((change) => change.text).join('\n')
    }
  };
}

function fileChangePaths(data) {
  const changes = Array.isArray(data?.changes) ? data.changes : [data];
  const paths = [];
  for (const change of changes) {
    for (const candidate of [change?.path, change?.oldPath, change?.newPath]) {
      if (typeof candidate !== 'string' || !candidate || path.isAbsolute(candidate)) continue;
      const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
      if (!normalized || normalized === '.' || normalized.split('/').includes('..')) continue;
      paths.push(normalized);
    }
  }
  return [...new Set(paths)];
}

export function fileMetadataFingerprint(cwd, file) {
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(path.resolve(cwd), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.lstatSync(absolute);
    return {
      state: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      size: stat.size,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    };
  } catch (error) {
    return error.code === 'ENOENT' ? { state: 'absent' } : null;
  }
}

function rememberCollisionOwnWrites(job, data, at) {
  const paths = fileChangePaths(data);
  if (!paths.length) return;
  const prior = new Map((job.collisionOwnWrites || []).map((entry) => [entry?.path, entry]));
  for (const file of paths) {
    prior.delete(file);
    prior.set(file, {
      path: file,
      observedAtMs: at,
      phase: typeof data?.phase === 'string' ? data.phase : null,
      fingerprint: fileMetadataFingerprint(job.cwd, file)
    });
  }
  job.collisionOwnWrites = [...prior.values()].slice(-COLLISION_OWN_WRITE_CAP);
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
  if (isReadOnlyTransport(job)) {
    if (!isDirectTransport(job)) return { ok: false, reason: 'hook-observed jobs are read-only in the control plane', code: 'READ_ONLY_TRANSPORT' };
    return { ok: false, reason: 'direct-transport jobs are read-only in the control plane; the caller session owns the provider loop', code: 'DIRECT_TRANSPORT' };
  }
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
    ...(job.stagingDir ? { stagingDir: job.stagingDir, ingested: job.ingested || [] } : {}),
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

export function readLastCompleteEvent(file) {
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
  const normalizedData = type === 'file.changed'
    ? normalizeFileChangedEvent({ type, data }, job.cwd).data
    : data;
  let eventData = redact(normalizedData);
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
  const at = Date.now();
  if (type === 'file.changed') rememberCollisionOwnWrites(job, normalizedData, at);
  const event = {
    v: EVENT_VERSION,
    seq,
    at,
    jobId: job.id,
    provider: job.provider,
    sessionId: options.sessionId ?? job.providerSessionId ?? job.session ?? null,
    turnId: options.turnId ?? job.providerTurnId ?? null,
    type,
    redacted: true,
    data: eventData,
    ...(options.replay === true ? { replay: true } : {})
  };
  fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(journal, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  try { fs.chmodSync(journal, 0o600); } catch {}
  job.lastSeq = seq;
  job.updatedAt = Math.floor(Date.now() / 1000);
  return event;
}

export function appendJobEvent(id, type, data = {}, options = {}) {
  const event = withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    const event = appendUnlocked(job, type, data, options);
    if (options.lifecycle) job.revision = (job.revision || 0) + 1;
    saveJob(job);
    return event;
  });
  if (type === 'file.changed' && !signalCollisionWatchRefresh()) {
    recordCollisionWatchDegradation([id], { reason: 'watch-refresh-signal-unavailable' });
  }
  return event;
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

export function finalizeSupervisorAttempt(id, outcome = {}) {
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    const wasTerminal = TERMINAL_STATUSES.has(job.status);
    const attribution = redact({
      outcome: outcome.outcome || 'unknown',
      exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
      signal: outcome.signal || null,
      pid: outcome.pid || job.attemptLease?.pid || job.workerPid || job.pid || null,
      ppid: outcome.ppid ?? job.attemptLease?.ppid ?? null,
      pgid: outcome.pgid ?? job.attemptLease?.pgid ?? null,
      supervisorBootId: outcome.supervisorBootId || null,
      leaseBootId: outcome.leaseBootId || job.attemptLease?.bootId || null,
      lastHeartbeat: outcome.lastHeartbeat ?? job.attemptLease?.heartbeatAt ?? null,
      leaseExpiresAt: outcome.leaseExpiresAt ?? job.attemptLease?.expiresAt ?? null,
      providerProcessAttachable: outcome.providerProcessAttachable === true,
      finalized: true,
      finalizedAt: outcome.finalizedAt || Date.now()
    });
    job.executionAttribution = attribution;
    job.attemptLease = {
      ...(job.attemptLease || {}),
      heartbeatAt: attribution.lastHeartbeat,
      expiresAt: attribution.leaseExpiresAt,
      finalized: true
    };
    if (!wasTerminal) {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = redact(outcome.reason || 'SUPERVISOR_PROCESS_UNKNOWN: worker outcome could not be established');
      job.errorCode = outcome.errorCode || 'STATE_ERROR';
      job.errorRetryable = outcome.retryable !== false;
      job.stoppedReason = outcome.stoppedReason || 'worker-process';
      job.completedAt = Math.floor(Date.now() / 1000);
      job.failureAttribution = attribution;
      job.revision = (job.revision || 0) + 1;
      appendUnlocked(job, 'error', {
        code: job.errorCode,
        message: job.error,
        stage: 'supervisor',
        attribution
      });
      ensureCheckpoint(job);
    } else if (job.status === 'failed') {
      job.failureAttribution = attribution;
    }
    job.updatedAt = Math.floor(Date.now() / 1000);
    saveJob(job);
    if (TERMINAL_STATUSES.has(job.status)) {
      const sentinel = paths(job.id).finished;
      if (!fs.existsSync(sentinel)) writePrivate(sentinel, `${job.status}\n`);
      appendTerminalAuditIfMissing(job);
    }
    return job;
  });
}

export function completeShadowJob(id, outcome = {}) {
  const status = ['completed', 'failed', 'cancelled'].includes(outcome.status) ? outcome.status : 'failed';
  const files = jobFiles(id);
  const entries = files.slice(0, 1000).map((file) => {
    const finalHash = file.path ? hashWorkingFile(loadJob(id)?.cwd || process.cwd(), file.path) : null;
    return {
      ...file,
      ...(finalHash ? { finalHash } : {})
    };
  });
  const names = [...new Set(entries.map((entry) => entry.path).filter(Boolean))];
  const completedAt = Math.floor(Date.now() / 1000);
  const completed = updateManagedJob(id, (job) => {
    const subagents = Array.isArray(job.result?.subagents) ? job.result.subagents : [];
    job.status = status;
    job.phase = status;
    job.completedAt = completedAt;
    job.durationMs = Math.max(0, completedAt * 1000 - Number(job.createdAt || completedAt) * 1000);
    job.changedFiles = { count: names.length, files: names.slice(0, 50), entries };
    if (outcome.providerSessionId) {
      job.providerSessionId = outcome.providerSessionId;
      job.session = outcome.providerSessionId;
    }
    if (outcome.resolvedModel) job.resolvedModel = outcome.resolvedModel;
    if (Object.hasOwn(outcome, 'result')) {
      const safe = redact(outcome.result);
      if (subagents.length) {
        const base = safe && typeof safe === 'object' && !Array.isArray(safe)
          ? safe : { text: safe == null ? '' : String(safe) };
        job.result = { ...base, subagents };
      } else job.result = safe;
    }
    if (typeof outcome.resultText === 'string') job.resultText = redact(outcome.resultText);
    if (outcome.usage) job.usage = redact(outcome.usage);
    if (outcome.error) job.error = redact(outcome.error);
    if (outcome.errorCode) job.errorCode = outcome.errorCode;
    if (outcome.errorRetryable != null) job.errorRetryable = outcome.errorRetryable === true;
  });
  appendJobEvent(id, status === 'completed' ? 'job.completed' : status === 'cancelled' ? 'job.cancelled' : 'error', {
    status,
    ...(outcome.error ? { error: outcome.error, code: outcome.errorCode || 'PROVIDER_ERROR' } : {})
  });
  return inspectJob(completed.id);
}

export function readJobEvents(id, options = {}) {
  assertJobId(id);
  const afterSeq = Number(options.afterSeq || 0);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 1000);
  const types = options.types ? new Set(options.types) : null;
  const cwd = loadJob(id)?.cwd || '';
  return readRawEvents(id)
    .filter((event) => event.seq > afterSeq && (!types || types.has(event.type)))
    .slice(0, limit)
    .map((event) => normalizeFileChangedEvent(event, cwd));
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
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
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
        if (!types || types.has(event.type)) events.push(normalizeFileChangedEvent(event, job.cwd));
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

export const QUEUED_STALE_SECONDS = 600;

function discoverAgentTranscript(job) {
  const direct = typeof job?.transcriptPath === 'string' && path.isAbsolute(job.transcriptPath)
    ? path.normalize(job.transcriptPath) : null;
  try {
    if (direct && fs.statSync(direct).isFile()) return direct;
  } catch {}
  if (!job?.agentId || typeof job.coordinatorSidecarDir !== 'string' || !path.isAbsolute(job.coordinatorSidecarDir)) return direct;
  const safeId = String(job.agentId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return direct;
  const directory = path.join(path.normalize(job.coordinatorSidecarDir), 'subagents');
  try {
    const candidates = fs.readdirSync(directory, { withFileTypes: true }).slice(0, 200)
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')
        && (entry.name === `agent-${safeId}.jsonl` || entry.name.startsWith(`agent-${safeId}-`)))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
    return candidates[0]?.file || direct;
  } catch {
    return direct;
  }
}

export function agentStubActivity(job, options = {}) {
  if (job?.managedBy !== 'delegate-agent-hook' || job?.transport !== 'claude-agent') return null;
  const now = Number(options.nowMs ?? Date.now());
  const quietSeconds = Number(process.env.DELEGATE_AGENT_STUB_QUIET_SECONDS ?? 1800);
  const activeSeconds = Number(process.env.DELEGATE_AGENT_STUB_ACTIVE_SECONDS ?? 60);
  const quietMs = (Number.isFinite(quietSeconds) && quietSeconds >= 1 ? quietSeconds : 1800) * 1000;
  const activeMs = Math.min(quietMs, (Number.isFinite(activeSeconds) && activeSeconds >= 1 ? activeSeconds : 60) * 1000);
  const transcriptPath = discoverAgentTranscript(job);
  let transcriptMtimeMs = null;
  try { transcriptMtimeMs = transcriptPath ? fs.statSync(transcriptPath).mtimeMs : null; } catch {}
  const lastGrowthAt = Number(transcriptMtimeMs || job.transcriptMtimeMs || job.spawnReturnedAtMs
    || job.createdAtMs || Number(job.updatedAt || job.createdAt || 0) * 1000 || now);
  const quietForMs = Math.max(0, now - lastGrowthAt);
  const state = job.agentLifecycle === 'ended-unknown'
    ? 'ended-unknown'
    : quietForMs >= quietMs ? 'ended-unknown'
      : quietForMs <= activeMs && transcriptMtimeMs != null ? 'active' : 'idle';
  return { state, lastGrowthAt, quietForMs, quietMs, activeMs, transcriptPath, transcriptMtimeMs };
}

function reconcileAgentStub(id, original) {
  const initial = agentStubActivity(original);
  if (!initial || initial.state !== 'ended-unknown' || TERMINAL_STATUSES.has(original.status)) return original;
  return withLock(id, () => {
    const current = loadJob(id);
    const activity = agentStubActivity(current);
    if (!current || !activity || activity.state !== 'ended-unknown' || TERMINAL_STATUSES.has(current.status)) return current;
    const quietMinutes = Math.max(1, Math.floor(activity.quietForMs / 60000));
    const reason = `AGENT_COMPLETION_UNKNOWN: no completion signal; transcript quiet for ${quietMinutes}m`;
    current.status = 'failed';
    current.phase = 'ended-unknown';
    current.agentLifecycle = 'ended-unknown';
    current.agentEndedReason = reason;
    current.error = reason;
    current.errorCode = 'AGENT_COMPLETION_UNKNOWN';
    current.errorRetryable = false;
    current.stoppedReason = 'no-completion-signal';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.completedAtMs = Date.now();
    current.durationMs = Math.max(0, current.completedAtMs - Number(current.createdAtMs || current.createdAt * 1000 || current.completedAtMs));
    if (activity.transcriptPath) current.transcriptPath = activity.transcriptPath;
    current.revision = (current.revision || 0) + 1;
    appendUnlocked(current, 'error', {
      code: current.errorCode,
      message: reason,
      stage: 'agent-reconcile',
      agentLifecycle: current.agentLifecycle,
      quietForMs: activity.quietForMs
    });
    saveJob(current);
    writeTerminalArtifacts(current, false);
    return current;
  });
}

export function jobNeedsReconciliation(job, options = {}) {
  if (job?.transport === 'claude-agent' || job?.managedBy === 'delegate-agent-hook') {
    const activity = agentStubActivity(job, {
      nowMs: Number(options.nowSeconds ?? Date.now() / 1000) * 1000
    });
    return Boolean(activity?.state === 'ended-unknown' && !TERMINAL_STATUSES.has(job?.status));
  }
  // Supervisor-owned jobs are reconciled exclusively from leases created by
  // the supervisor. Generic pid reconciliation cannot recover exit telemetry
  // and must never race the resident into a legacy ORPHANED transition.
  if (job?.executionOwner === 'supervisor') return false;
  const now = Number(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  const pid = job?.workerPid || job?.pid;
  const workerAlive = Object.hasOwn(options, 'workerAlive') ? options.workerAlive === true : isProcessAlive(pid);
  if (job?.status === 'running') return !workerAlive;
  if (job?.status === 'queued') return !workerAlive && now - (job.createdAt || 0) > QUEUED_STALE_SECONDS;
  return false;
}

function isOrphaned(job) {
  return jobNeedsReconciliation(job);
}

export function reconcileJob(id) {
  const job = loadJob(assertJobId(id));
  if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
  if (job.transport === 'claude-agent' || job.managedBy === 'delegate-agent-hook') return reconcileAgentStub(id, job);
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
  const agent = agentStubActivity(job);
  if (agent) {
    return {
      lastActivityAt: agent.lastGrowthAt,
      stalled: false,
      agentActivityState: agent.state,
      transcriptMtimeMs: agent.transcriptMtimeMs ?? job.transcriptMtimeMs ?? null
    };
  }
  let event = readLastCompleteEvent(eventPath(job.id));
  if (event?.replay === true) event = readRawEvents(job.id).findLast((candidate) => candidate.replay !== true) || null;
  const lastActivityAt = event?.at || (job.createdAt ? job.createdAt * 1000 : null);
  const configured = Number(process.env.DELEGATE_STALL_SECONDS ?? 300);
  const stallSeconds = Number.isFinite(configured) && configured >= 0 ? configured : 300;
  return {
    lastActivityAt,
    stalled: job.status === 'running'
      && job.phase !== 'user-input-required'
      && lastActivityAt != null
      && Date.now() - lastActivityAt > stallSeconds * 1000
  };
}

export function inspectJob(id) {
  const job = reconcileJob(id);
  const shadow = job.managedBy === 'delegate-shadow' || isDirectTransport(job);
  return {
    ...job,
    ...activityFields(job),
    resumable: jobResumability(job),
    driftReport: driftReportFor(job),
    promptPath: undefined,
    verifyCommandPath: undefined,
    managed: job.managedBy === 'delegate-control' || job.managedBy === 'delegate-agent-hook' || shadow,
    shadow,
    direct: isDirectTransport(job),
    legacy: job.managedBy !== 'delegate-control' && job.managedBy !== 'delegate-agent-hook' && !shadow
  };
}

export function decideAcceptance(id, decision, options = {}) {
  assertJobId(id);
  if (!['accepted', 'rejected'].includes(decision)) {
    throw brokerError('INVALID_REQUEST', "acceptance decision must be 'accepted' or 'rejected'");
  }
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    if (!WRITE_MODES.has(job.mode) || job.status !== 'completed') {
      throw brokerError('INVALID_REQUEST', 'acceptance decisions require a completed implement or verify job', { provider: job.provider });
    }
    const current = job.acceptance || buildAcceptance(job);
    if (!current) throw brokerError('INVALID_REQUEST', 'acceptance evidence is unavailable', { provider: job.provider });
    if (decision === 'accepted' && current.state !== 'ready-for-review') {
      throw brokerError('ACCEPTANCE_BLOCKED', `job is ${current.state}; resolve ${current.blockedBy?.join(', ') || 'the recorded blockers'} before accepting`, {
        provider: job.provider
      });
    }
    const decidedBy = redact(String(options.decidedBy || 'owner'), '', 160);
    const reason = options.reason == null ? null : redact(String(options.reason), '', 2000);
    const decidedAt = new Date().toISOString();
    const evidenceDigest = acceptanceEvidenceDigest(current);
    job.acceptance = {
      state: decision,
      blockedBy: current.blockedBy || [],
      evidence: current.evidence,
      evidenceDigest,
      decidedBy,
      decidedAt,
      ...(reason ? { reason } : {}),
      priorState: current.state
    };
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = Math.floor(Date.now() / 1000);
    appendUnlocked(job, 'acceptance.decided', {
      state: decision,
      reason,
      decidedBy,
      decidedAt,
      evidenceDigest,
      priorState: current.state
    });
    saveJob(job);
    return {
      id: job.id,
      status: job.status,
      acceptance: job.acceptance,
      revision: job.revision
    };
  });
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
    if (options.groupId && job.groupId !== options.groupId) continue;
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
      managed: job.managedBy === 'delegate-control' || job.managedBy === 'delegate-shadow' || job.managedBy === 'delegate-agent-hook' || isDirectTransport(job),
      readOnly: isReadOnlyTransport(job) ? true : undefined,
      shadow: job.managedBy === 'delegate-shadow' || isDirectTransport(job) ? true : undefined,
      direct: isDirectTransport(job) ? true : undefined,
      overlapsManagedWriter: job.overlapsManagedWriter === true ? true : undefined,
      effort: job.effort || null,
      reviewFlowEngaged: job.reviewFlowEngaged === true ? true : undefined,
      scopeViolations: job.scopeViolations?.length ? job.scopeViolations.length : undefined,
      session: job.providerSessionId || job.session || null,
      rootJobId: rootJobIdOf(job),
      parentJobId: job.parentJobId || null,
      groupId: job.groupId || null,
      coordinatorSessionId: job.coordinatorSessionId || null,
      agentType: job.agentType || null,
      agentLifecycle: job.agentLifecycle || null,
      promptSummary: job.promptSummary || null,
      transcriptAvailable: typeof job.transcriptPath === 'string' ? true : undefined,
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
      verification: job.verification || null,
      verificationOrigin: job.verificationOrigin || null,
      acceptance: job.acceptance || null,
      resolvedModel: job.resolvedModel || null,
      error: job.error || null
    });
    if (jobs.length >= limit) break;
  }
  return { jobs };
}

// Read-only introspection of the durable writer guard. This deliberately uses
// job records rather than lock files: launch locks are short-lived admission
// primitives, while active shared-worktree jobs are the ownership record a
// dashboard or CLI should present.
export function activeWriterLocks(records = listJobs()) {
  return records
    .filter((job) => job?.managedBy === 'delegate-control'
      && WRITE_MODES.has(job.mode)
      && job.isolation !== 'worktree'
      && !TERMINAL_STATUSES.has(job.status))
    .map((job) => ({
      cwd: path.resolve(job.cwd || process.cwd()),
      jobId: job.id,
      provider: job.provider || null,
      mode: job.mode,
      status: job.status,
      phase: job.phase || null
    }))
    .sort((left, right) => left.cwd.localeCompare(right.cwd) || left.jobId.localeCompare(right.jobId));
}

export function groupSummary(groupId) {
  const validated = validatedGroupId(groupId);
  const jobs = listJobs().filter((job) => job.groupId === validated).map((job) => {
    if (!TERMINAL_STATUSES.has(job.status)) {
      try { return reconcileJob(job.id); } catch {}
    }
    return job;
  });
  const completed = jobs.filter((job) => job.status === 'completed').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const cancelled = jobs.filter((job) => job.status === 'cancelled').length;
  const running = jobs.length - completed - failed - cancelled;
  return {
    groupId: validated,
    total: jobs.length,
    running,
    completed,
    failed,
    cancelled,
    allTerminal: jobs.length > 0 && running === 0
  };
}

const TRANSCRIPT_TYPES = new Set([
  'message.user', 'message.delta', 'message.completed', 'plan.updated',
  'tool.started', 'tool.status', 'tool.output', 'tool.completed',
  'file.changed',
  'session.updated', 'mode.updated', 'model.updated', 'commands.updated',
  'subagent.activity', 'subagent.started', 'subagent.progress', 'subagent.completed', 'subagent.errored',
  'provider.item', 'artifact.created',
  'network.preflight', 'network.mode-elevated', 'network.policy.materialized', 'network.policy.restored',
  'input.requested', 'input.response.requested', 'input.resolved',
  'compaction.started', 'compaction.completed',
  'correction.requested', 'correction.applied', 'correction.queued', 'correction.restarted',
  'error'
]);
const TRANSCRIPT_VERBOSE_TYPES = new Set(['message.delta', 'tool.output']);

function transcriptProviderLabel(provider) {
  const value = String(provider || 'provider').trim();
  return value ? `${value[0].toUpperCase()}${value.slice(1)} agent` : 'Provider agent';
}

function compactTranscriptEvent(event, cwd) {
  const normalized = normalizeFileChangedEvent(event, cwd, { compact: true });
  if (!normalized.type?.startsWith('subagent.')) return normalized;
  const data = normalized.data || {};
  const status = data.status || normalized.type.slice('subagent.'.length);
  const duration = Number(data.durationMs);
  const durationText = Number.isFinite(duration) && duration >= 0 ? ` (${Math.round(duration)}ms)` : '';
  const task = typeof data.task === 'string' && data.task.trim() ? `: ${data.task.trim()}` : '';
  return {
    ...normalized,
    data: {
      ...data,
      text: `${transcriptProviderLabel(normalized.provider)} ${status}${durationText}${task}`
    }
  };
}

export function jobTranscriptPage(id, options = {}) {
  assertJobId(id);
  const afterSeq = Number(options.afterSeq || 0);
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 1000);
  const verbose = options.verbose === true;
  const cwd = loadJob(id)?.cwd || '';
  const all = readRawEvents(id);
  const events = [];
  let nextSeq = afterSeq;
  for (const event of all) {
    if (event.seq <= afterSeq) continue;
    nextSeq = event.seq;
    if (TRANSCRIPT_TYPES.has(event.type) && (verbose || !TRANSCRIPT_VERBOSE_TYPES.has(event.type))) {
      events.push(compactTranscriptEvent(event, cwd));
    }
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

export function sliceResultText(resultText, options = {}) {
  const text = String(resultText || '');
  let offset = Math.max(Number(options.offset || 0), 0);
  if (options.find != null) {
    const find = String(options.find);
    const found = text.indexOf(find);
    if (found < 0) throw brokerError('NOT_FOUND', `result text does not contain: ${find}`);
    offset = found;
  }
  const maxChars = Math.min(Math.max(Number(options.maxChars || 60000), 1000), 200000);
  const result = text.slice(offset, offset + maxChars);
  const nextOffset = offset + result.length;
  return {
    resultText: result,
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

export function recordInterrogationAnswer(id, command, answer, options = {}) {
  const safeAnswer = String(redact(String(answer || '').trim(), '', 32_000));
  if (!safeAnswer) throw brokerError('INVALID_REQUEST', 'interrogation answer is empty');
  const answeredAt = Date.now();
  const baselineOutputTokens = Number(options.baselineOutputTokens || 0);
  updateManagedJob(id, (current) => {
    if (contractDigest(current) !== command.contractDigest) {
      throw brokerError('INVALID_REQUEST', 'the work contract changed while interrogation was pending; evidence was not attached', {
        provider: current.provider
      });
    }
    current.interrogations ||= [];
    const entry = current.interrogations.find((item) => item.id === command.commandId);
    if (!entry) throw brokerError('INVALID_REQUEST', `interrogation record is missing: ${command.commandId}`, { provider: current.provider });
    Object.assign(entry, {
      state: 'answered',
      answer: safeAnswer,
      answeredAt,
      transport: options.transport || current.transport,
      appliedAs: options.appliedAs,
      authority: 'evidence-only',
      constraintsUnchanged: true,
      cost: {
        state: 'pending-provider-usage',
        baselineOutputTokens,
        outputTokenLimit: command.outputTokenLimit
      }
    });
    current.findings ||= [];
    current.findings.push({
      id: `interrogation-${command.commandId}`,
      severity: 'informational',
      criterion: `Worker interrogation: ${String(command.question).slice(0, 512)}`,
      status: 'open',
      introducedBy: current.id,
      evidence: {
        kind: 'worker-interrogation',
        interrogationId: command.commandId,
        question: command.question,
        answer: safeAnswer,
        authority: 'evidence-only',
        constraintsUnchanged: true,
        cost: entry.cost
      }
    });
  }, { incrementRevision: false });
  appendJobEvent(id, 'interrogation.answered', {
    commandId: command.commandId,
    question: command.question,
    answer: safeAnswer,
    authority: 'evidence-only',
    constraintsUnchanged: true,
    cost: {
      state: 'pending-provider-usage',
      baselineOutputTokens,
      outputTokenLimit: command.outputTokenLimit
    },
    transport: options.transport,
    appliedAs: options.appliedAs
  });
  appendJobEvent(id, 'finding.recorded', {
    findingId: `interrogation-${command.commandId}`,
    kind: 'worker-interrogation',
    evidenceOnly: true
  });
  return inspectJob(id).interrogations.find((entry) => entry.id === command.commandId);
}

export function attributeInterrogationUsage(id, usage) {
  const currentOutputTokens = usageTotals(usage)?.outputTokens;
  if (!Number.isFinite(currentOutputTokens)) return 0;
  let attributed = 0;
  updateManagedJob(id, (current) => {
    for (const entry of current.interrogations || []) {
      if (entry.state !== 'answered' || entry.cost?.state !== 'pending-provider-usage') continue;
      const outputTokens = Math.max(0, currentOutputTokens - Number(entry.cost.baselineOutputTokens || 0));
      entry.cost = {
        ...entry.cost,
        state: 'observed',
        outputTokens,
        observedOutputTokens: currentOutputTokens,
        attributedAt: Date.now()
      };
      const finding = (current.findings || []).find((item) => item.id === `interrogation-${entry.id}`);
      if (finding?.evidence) finding.evidence.cost = { ...entry.cost };
      attributed += 1;
    }
  }, { incrementRevision: false });
  if (attributed) {
    appendJobEvent(id, 'interrogation.cost', {
      state: 'observed',
      observedOutputTokens: currentOutputTokens,
      attributedCount: attributed
    });
  }
  return attributed;
}

function observedUsage(job) {
  const events = readRawEvents(job.id).filter((event) => event.type === 'usage.updated');
  return events.at(-1)?.data || job.usage || null;
}

function observedContextOccupancy(job) {
  const events = readRawEvents(job.id).filter((event) => event.type === 'usage.context' && event.replay !== true);
  return events.at(-1)?.data || job.contextOccupancy || null;
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
  const contextOccupancy = observedContextOccupancy(job);
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
    tokenUsage: observed,
    observedAvailable: Boolean(observed),
    ...(observed ? {} : { note: 'the provider did not emit usage data for this job; Cursor ACP does not always report it' }),
    contextOccupancy,
    contextOccupancyAvailable: Boolean(contextOccupancy),
    dimensions: {
      outputBudget: 'provider token usage; maxOutputTokens applies only to outputTokens',
      contextOccupancy: 'ACP context window occupancy; never compared with maxOutputTokens'
    },
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

function hashAbsoluteFile(absolute) {
  let stat;
  try { stat = fs.statSync(absolute); }
  catch { return 'absent'; }
  if (!stat.isFile() || stat.size > BASELINE_HASH_MAX_BYTES) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'); }
  catch { return null; }
}

export function completeIngestedFiles(job) {
  if (!job.stagingDir || !job.ingested?.length) return { copiedBack: [], diverged: [], removed: false };
  const copiedBack = [];
  const diverged = [];
  for (const item of job.ingested) {
    const before = job.baselineHashes?.[item.staged] ?? null;
    const after = hashWorkingFile(job.cwd, item.staged);
    if (after === 'absent' || after == null || before === after) continue;
    const sourceHash = item.sourceHash ?? before;
    const currentSourceHash = hashAbsoluteFile(item.source);
    if (sourceHash && currentSourceHash !== sourceHash) {
      const outcome = { source: item.source, staged: item.staged, divergedTo: `${item.source}.delegate-new` };
      fs.copyFileSync(path.join(job.cwd, item.staged), outcome.divergedTo);
      try { fs.chmodSync(outcome.divergedTo, 0o600); } catch {}
      diverged.push(outcome);
      appendJobEvent(job.id, 'ingest.diverged', outcome);
    } else {
      fs.copyFileSync(path.join(job.cwd, item.staged), item.source);
      copiedBack.push({ source: item.source, staged: item.staged });
    }
  }
  fs.rmSync(path.join(job.cwd, job.stagingDir), { recursive: true, force: true });
  return { copiedBack, diverged, removed: true };
}

function gitBaseline(cwd, options = {}) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) return { files: [], hashes: {} };
  const entries = result.stdout.split('\0').filter(Boolean);
  const files = [];
  const internalState = [
    dataDir() === path.resolve(cwd) ? null : dataDir(),
    jobsDir(),
    auditLogPath(),
    statePath(),
    providerConfigPath(),
    path.join(dataDir(), 'verification-profiles')
  ].filter(Boolean).map((candidate) => path.relative(cwd, candidate).replaceAll('\\', '/').replace(/\/+$/, ''))
    .filter((candidate) => candidate && candidate !== '..' && !candidate.startsWith('../') && !path.isAbsolute(candidate));
  const internal = (file) => internalState.some((candidate) => file === candidate || file.startsWith(`${candidate}/`));
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (file && !internal(file)) files.push(file);
    if (/[RC]/.test(status) && entries[i + 1]) {
      const source = entries[++i];
      if (!internal(source)) files.push(source);
    }
  }
  const unique = [...new Set(files)];
  const hashes = {};
  for (const file of unique) {
    if (options.excludeSensitive === true && SENSITIVE_PATH.test(file.replaceAll('\\', '/'))) continue;
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

function collisionRelativePath(job, absolute) {
  if (!job?.cwd || typeof absolute !== 'string' || !path.isAbsolute(absolute)) return null;
  const relative = path.relative(path.resolve(job.cwd), path.resolve(absolute)).replaceAll('\\', '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

function collisionOwnedPaths(job) {
  return new Set([
    ...(Array.isArray(job.collisionOwnWrites) ? job.collisionOwnWrites.map((entry) => entry?.path) : []),
    ...(Array.isArray(job.changedFiles?.files) ? job.changedFiles.files : []),
    ...(Array.isArray(job.changedFiles?.entries) ? job.changedFiles.entries.map((entry) => entry?.path) : [])
  ].filter((entry) => typeof entry === 'string' && entry));
}

function jobOwnsCollisionPath(job, relative) {
  return pathMatchesScope(relative, job.allowedPaths)
    || collisionOwnedPaths(job).has(relative);
}

function sameFingerprint(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function watcherCollisionDisposition(job, relative, observedAtMs) {
  const own = [...(job.collisionOwnWrites || [])].reverse().find((entry) => entry?.path === relative);
  if (!own) return 'unattributed';
  const current = fileMetadataFingerprint(job.cwd, relative);
  if (sameFingerprint(own.fingerprint, current)) return 'self';
  const recentAttemptWrite = Number.isFinite(own.observedAtMs)
    && observedAtMs - own.observedAtMs >= 0
    && observedAtMs - own.observedAtMs <= COLLISION_SELF_WRITE_WINDOW_MS;
  return recentAttemptWrite ? 'self' : 'collision';
}

function pathInsideDirectory(absolute, directory) {
  if (typeof directory !== 'string' || !directory) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(absolute));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function verificationCoversCollision(job, relative) {
  const verification = job.verification;
  if (!verification || ['pending', 'no-recipe', 'skipped', 'exception'].includes(verification.state)) return false;
  const absolute = path.resolve(job.cwd, relative);
  const roots = [
    verification.input?.repoRoot,
    verification.completedInput?.repoRoot,
    job.verificationProfile?.repoRoot,
    job.cwd
  ].filter((entry) => typeof entry === 'string' && entry);
  return roots.some((root) => pathInsideDirectory(absolute, root));
}

function staleVerificationForCollision(job, relative, observedAtMs) {
  if (!verificationCoversCollision(job, relative)) return false;
  const verification = job.verification;
  const priorState = verification.state === 'stale'
    ? verification.stateBeforeStale || verification.priorState || null
    : verification.state || null;
  job.verification = {
    ...verification,
    state: 'stale',
    stateBeforeStale: priorState,
    inputChanged: true,
    staleReason: 'base-drift',
    stalePaths: [...new Set([...(verification.stalePaths || []), relative])].slice(-COLLISION_RECORD_CAP),
    staleAtMs: observedAtMs
  };
  return true;
}

function invalidateAcceptanceForCollision(job, relative) {
  if (!job.acceptance || ['accepted', 'rejected', 'superseded'].includes(job.acceptance.state)) return;
  const evidence = job.acceptance.evidence || {};
  job.acceptance = {
    ...job.acceptance,
    state: 'blocked',
    blockedBy: [...new Set([...(job.acceptance.blockedBy || []), 'base-drift'])],
    evidence: {
      ...evidence,
      verification: job.verification || evidence.verification || null,
      base: {
        ...(evidence.base || {}),
        drifted: true,
        driftPaths: [...new Set([...(evidence.base?.driftPaths || []), relative])].slice(-COLLISION_RECORD_CAP)
      }
    }
  };
}

function recordCollisionForJob(id, absolute, options) {
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job || !['queued', 'running'].includes(job.status) || !WRITE_MODES.has(job.mode)) return { matched: false };
    const relative = collisionRelativePath(job, absolute);
    if (!relative || !jobOwnsCollisionPath(job, relative)) return { matched: false };
    if (options.source === 'file-watcher') {
      const disposition = watcherCollisionDisposition(job, relative, options.observedAtMs);
      if (disposition !== 'collision') {
        return {
          matched: true,
          selfWrite: disposition === 'self',
          unattributed: disposition === 'unattributed',
          jobId: id,
          path: relative
        };
      }
    }
    if ((job.collisions || []).some((entry) => entry?.path === relative)) {
      return { matched: true, duplicate: true, jobId: id, path: relative };
    }
    const verificationStale = staleVerificationForCollision(job, relative, options.observedAtMs);
    job.baseDrift = true;
    job.baseDriftPaths = [...new Set([...(job.baseDriftPaths || []), relative])].slice(-COLLISION_RECORD_CAP);
    const collision = {
      path: relative,
      detectedAtMs: options.observedAtMs,
      source: options.source,
      event: options.event || null,
      sessionId: coordinatorSessionIdentity(options.sessionId),
      inputChanged: true,
      verificationStale
    };
    job.collisions = [...(job.collisions || []), collision].slice(-COLLISION_RECORD_CAP);
    invalidateAcceptanceForCollision(job, relative);
    appendUnlocked(job, 'collision.detected', {
      path: relative,
      source: collision.source,
      event: collision.event,
      inputChanged: true,
      verificationStale
    });
    saveJob(job);
    return { matched: true, collision: true, jobId: id, path: relative, verificationStale };
  });
}

export function recordPathCollisions(absolutePaths, options = {}) {
  const requestedObservedAtMs = Number(options.observedAtMs ?? Date.now());
  const observedAtMs = Number.isFinite(requestedObservedAtMs) ? requestedObservedAtMs : Date.now();
  const source = options.source === 'coordinator-tool' ? 'coordinator-tool' : 'file-watcher';
  const event = COLLISION_EVENTS.has(String(options.event || '')) ? String(options.event) : null;
  const jobs = listJobs().filter((job) => ['queued', 'running'].includes(job.status) && WRITE_MODES.has(job.mode));
  const results = [];
  for (const absolute of [...new Set(absolutePaths || [])]) {
    if (typeof absolute !== 'string' || !path.isAbsolute(absolute)) continue;
    for (const job of jobs) {
      const relative = collisionRelativePath(job, absolute);
      if (!relative || !jobOwnsCollisionPath(job, relative)) continue;
      results.push(recordCollisionForJob(job.id, absolute, {
        observedAtMs,
        source,
        event,
        sessionId: options.sessionId
      }));
    }
  }
  return {
    collisions: results.filter((entry) => entry.collision).length,
    duplicates: results.filter((entry) => entry.duplicate).length,
    selfWrites: results.filter((entry) => entry.selfWrite).length,
    unattributed: results.filter((entry) => entry.unattributed).length,
    matched: results.filter((entry) => entry.matched).length,
    results
  };
}

export function recordCollisionWatchDegradation(jobIds, details = {}) {
  const reason = String(details.reason || 'watcher-unavailable')
    .replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80) || 'watcher-unavailable';
  const results = [];
  for (const id of [...new Set(jobIds || [])]) {
    if (!SAFE_JOB_ID.test(id)) continue;
    results.push(withLock(id, () => {
      const job = loadJob(id);
      if (!job || !['queued', 'running'].includes(job.status) || !WRITE_MODES.has(job.mode)) return false;
      const next = {
        status: 'degraded',
        reason,
        fallback: 'post-hoc-detection',
        cap: Number.isSafeInteger(details.cap) ? details.cap : undefined,
        totalPathCount: Number.isSafeInteger(details.totalPathCount) ? details.totalPathCount : undefined,
        watchedPathCount: Number.isSafeInteger(details.watchedPathCount) ? details.watchedPathCount : undefined,
        recordedAtMs: Number(details.recordedAtMs ?? Date.now())
      };
      const signature = JSON.stringify({ ...next, recordedAtMs: undefined });
      const prior = JSON.stringify({ ...(job.collisionWatch || {}), recordedAtMs: undefined });
      if (signature === prior) return false;
      job.collisionWatch = next;
      appendUnlocked(job, 'collision.watch.degraded', next);
      saveJob(job);
      return true;
    }));
  }
  return results.filter(Boolean).length;
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

function validatedGroupId(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) {
    throw brokerError('INVALID_REQUEST', 'groupId must be 1-128 characters using letters, numbers, _, ., :, or -');
  }
  return value;
}

function validatedReportSchema(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('INVALID_REQUEST', 'reportSchema must be an object');
  }
  return redact(value);
}

function validatedNetworkAllow(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 64 || !value.every((item) => typeof item === 'string')) {
    throw brokerError('INVALID_REQUEST', 'networkAllow must be an array of at most 64 domain, wildcard-domain, IP, or CIDR strings');
  }
  const entries = [...new Set(value.map((item) => item.trim()))];
  const valid = /^(?:\*\.)?(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$|^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$|^[0-9a-fA-F:]+(?:\/\d{1,3})?$/;
  if (!entries.every((item) => item && valid.test(item) && !item.includes('..'))) {
    throw brokerError('INVALID_REQUEST', 'networkAllow entries must be bare domains, *.wildcards, IP addresses, or CIDRs (no URLs or paths)');
  }
  return entries;
}

function validatedAddDirs(value, cwd) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32 || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw brokerError('INVALID_REQUEST', 'addDirs must be an array of at most 32 paths');
  }
  return [...new Set(value.map((item) => path.resolve(cwd, item)))];
}

function validatedIngestFiles(value, cwd, allowSensitive) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > INGEST_MAX_FILES || !value.every((item) => typeof item === 'string' && path.isAbsolute(item))) {
    throw brokerError('INVALID_REQUEST', `ingestFiles must be an array of at most ${INGEST_MAX_FILES} absolute file paths`);
  }
  const cwdReal = fs.realpathSync(cwd);
  return value.map((item) => {
    const source = path.resolve(item);
    let stat;
    try { stat = fs.statSync(source); }
    catch { throw brokerError('INVALID_REQUEST', `ingest file does not exist: ${source}`); }
    if (!stat.isFile()) throw brokerError('INVALID_REQUEST', `ingest path is not a file: ${source}`);
    if (stat.size >= INGEST_MAX_BYTES) throw brokerError('INVALID_REQUEST', `ingest file must be smaller than 10 MB: ${source}`);
    const sourceReal = fs.realpathSync(source);
    const relative = path.relative(cwdReal, sourceReal);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      throw brokerError('INVALID_REQUEST', `ingest file must be outside cwd: ${source}`);
    }
    if (!allowSensitive && SENSITIVE_PATH.test(source.replaceAll('\\', '/'))) {
      throw brokerError('INVALID_REQUEST', `sensitive ingest path requires allowSensitive=true: ${source}`);
    }
    return source;
  });
}

function planIngestFiles(id, sources) {
  if (!sources.length) return { stagingDir: null, ingested: [] };
  const stagingDir = `.delegate-staging/${id}`;
  const used = new Set();
  const ingested = [];
  for (const source of sources) {
    const parsed = path.parse(path.basename(source));
    let name = parsed.base;
    let suffix = 2;
    while (used.has(name)) name = `${parsed.name}-${suffix++}${parsed.ext}`;
    used.add(name);
    ingested.push({ source, staged: `${stagingDir}/${name}` });
  }
  return { stagingDir, ingested };
}

function stageIngestFiles(cwd, plan) {
  if (!plan.ingested.length) return plan;
  const absoluteDir = path.join(cwd, plan.stagingDir);
  fs.mkdirSync(absoluteDir, { recursive: true, mode: 0o700 });
  const ingested = [];
  try {
    for (const item of plan.ingested) {
      const stagedPath = path.join(cwd, item.staged);
      fs.copyFileSync(item.source, stagedPath);
      try { fs.chmodSync(stagedPath, 0o600); } catch {}
      const sourceHash = hashWorkingFile(cwd, item.staged);
      if (!sourceHash || sourceHash === 'absent') throw brokerError('STATE_ERROR', `could not hash staged ingest file: ${item.staged}`);
      ingested.push({ ...item, sourceHash });
    }
    return { stagingDir: plan.stagingDir, ingested };
  } catch (error) {
    try { fs.rmSync(absoluteDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function prepareManagedOptions(options, settings = {}) {
  const prepared = applyProfile(options);
  const missing = lintPacket(prepared.prompt);
  if (missing.length) {
    if (settings.reportLint !== false) {
      const missingSet = new Set(missing);
      const skeleton = PACKET_SECTION_ORDER.filter((section) => missingSet.has(section))
        .map((section) => `${section}:`)
        .join('\n');
      console.error(`delegate-router packet lint: missing ${missing.join(', ')}\n\n${skeleton}`);
    }
    prepared.packetWarnings = missing.map((section) => `missing section: ${section}`);
  }
  return prepared;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('INVALID_REQUEST', 'verify must contain a command or an exception reason');
  }
  const hasCommand = typeof value.command === 'string' && value.command.trim();
  const hasException = typeof value.exception === 'string' && value.exception.trim();
  if (Boolean(hasCommand) === Boolean(hasException)) {
    throw brokerError('INVALID_REQUEST', 'verify must contain exactly one of command or exception');
  }
  if (hasException) {
    if (value.timeoutSeconds != null) throw brokerError('INVALID_REQUEST', 'verify.timeoutSeconds is not valid with verify.exception');
    return { exception: value.exception.trim() };
  }
  const timeoutSeconds = value.timeoutSeconds == null ? 600 : Number(value.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    throw brokerError('INVALID_REQUEST', 'verify.timeoutSeconds must be an integer between 1 and 86400');
  }
  return { command: value.command, timeoutSeconds };
}

function validatedAutoFix(value, mode) {
  if (value == null) return null;
  if (!WRITE_MODES.has(mode)) throw brokerError('INVALID_REQUEST', 'autoFix is available only for write modes (implement and verify)');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('INVALID_REQUEST', 'autoFix must be an object');
  }
  const maxRounds = Number(value.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) {
    throw brokerError('INVALID_REQUEST', 'autoFix.maxRounds must be an integer between 1 and 100; the broker always applies its lower hard cap');
  }
  const internal = value._state && typeof value._state === 'object' ? value._state : {};
  return {
    maxRounds,
    round: Number.isSafeInteger(internal.round) ? internal.round : 0,
    startedAtMs: Number.isFinite(internal.startedAtMs) ? internal.startedAtMs : Date.now(),
    ...(internal.previousMetrics ? { previousMetrics: internal.previousMetrics } : {}),
    ...(internal.rootJobId ? { rootJobId: internal.rootJobId } : {})
  };
}

function resolvedVerification(value, mode, cwd) {
  const explicit = validatedVerify(value, mode);
  if (!WRITE_MODES.has(mode)) return { verify: explicit, verification: null, verificationProfile: null };
  if (String(process.env.DELEGATE_VERIFY || '').trim().toLowerCase() === 'off') {
    return {
      verify: explicit ? { ...explicit, disabled: true } : null,
      verification: {
        state: 'skipped',
        reason: 'Broker verification disabled by DELEGATE_VERIFY=off',
        exception: 'DELEGATE_VERIFY=off',
        recordedAt: new Date().toISOString()
      },
      verificationProfile: null
    };
  }
  if (explicit?.exception) {
    return {
      verify: explicit,
      verification: {
        state: 'exception',
        reason: explicit.exception,
        exception: explicit.exception,
        recordedAt: new Date().toISOString()
      },
      verificationProfile: null
    };
  }
  if (explicit) return { verify: explicit, verification: { state: 'pending' }, verificationProfile: null };
  const profile = deriveVerificationProfile(cwd);
  if (!profile.recipe) {
    return {
      verify: null,
      verification: {
        state: 'no-recipe',
        reason: profile.noRecipeReason,
        source: { repoRoot: profile.repoRoot, cache: profile.cache },
        recordedAt: new Date().toISOString()
      },
      verificationProfile: profile
    };
  }
  const commands = profile.recipe.commands.map((entry) => ({ ...entry }));
  return {
    verify: {
      command: commands[0].command,
      commands,
      timeoutSeconds: profile.recipe.timeoutSeconds,
      origin: 'derived',
      format: 'recipe-v1',
      source: profile.recipe.source
    },
    verification: { state: 'pending' },
    verificationProfile: profile
  };
}

function resolveManagedJobOptions(options, id) {
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
  const groupId = validatedGroupId(options.groupId);
  const retryPolicy = validatedRetryPolicy(options.retryPolicy);
  const mode = options.mode || 'consult';
  const planFirst = options.planFirst === true && WRITE_MODES.has(mode);
  const ambiguityCheck = planFirst && ambiguityDefault(options);
  if (options.autoNudge === true && !READ_MODES.has(mode)) throw brokerError('INVALID_REQUEST', 'autoNudge is available only for read modes');
  const reportSchema = validatedReportSchema(options.reportSchema);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw brokerError('INVALID_REQUEST', `cwd does not exist or is not a directory: ${cwd}`, { provider });
  const { verify, verification, verificationProfile } = resolvedVerification(options.verify, mode, cwd);
  const autoFix = validatedAutoFix(options.autoFix, mode);
  if (provider === 'cursor' && options.transport === 'headless' && options.startPaused === true) {
    throw brokerError('INVALID_REQUEST', 'startPaused requires Cursor ACP; headless cannot establish a session before its first prompt', { provider });
  }
  const networkAllow = validatedNetworkAllow(options.networkAllow);
  if (networkAllow != null && options.network !== true) throw brokerError('INVALID_REQUEST', 'networkAllow requires network=true', { provider });
  const addDirs = validatedAddDirs(options.addDirs, cwd);
  const approveMcps = options.approveMcps === true;
  const cursorWorktree = options.cursorWorktree === true;
  const cursorWorktreeBase = options.cursorWorktreeBase == null ? null : path.resolve(cwd, options.cursorWorktreeBase);
  if (provider !== 'cursor' && (networkAllow != null || addDirs.length || approveMcps || cursorWorktree || cursorWorktreeBase)) {
    throw brokerError('INVALID_REQUEST', 'networkAllow, addDirs, approveMcps, and native Cursor worktree options are available only for Cursor jobs', { provider });
  }
  if (cursorWorktreeBase && !cursorWorktree) throw brokerError('INVALID_REQUEST', 'cursorWorktreeBase requires cursorWorktree=true', { provider });
  const ingestFiles = validatedIngestFiles(options.ingestFiles, cwd, options.allowSensitive === true);
  const transport = provider === 'cursor' ? (options.transport || 'acp') : 'app-server';
  if (provider === 'cursor' && !['acp', 'headless'].includes(transport)) throw brokerError('INVALID_REQUEST', `Invalid Cursor transport: ${transport}`, { provider });
  if (provider === 'codex' && options.transport && options.transport !== 'app-server') throw brokerError('INVALID_REQUEST', `Invalid Codex transport: ${options.transport}`, { provider });
  const originalAllowedPaths = validatedAllowedPaths(options.allowedPaths);
  const ingestPlan = planIngestFiles(id, ingestFiles);
  const allowedPaths = validatedAllowedPaths(originalAllowedPaths == null
    ? null
    : [...originalAllowedPaths, ...(ingestPlan.stagingDir ? [ingestPlan.stagingDir] : [])]);
  return {
    options,
    id,
    provider,
    sensitivePromptDetected,
    timeoutSeconds,
    maxOutputTokens,
    idempotencyKey,
    groupId,
    retryPolicy,
    mode,
    planFirst,
    ambiguityCheck,
    verify,
    verification,
    verificationProfile,
    autoFix,
    reportSchema,
    cwd,
    transport,
    originalAllowedPaths,
    allowedPaths,
    ingestPlan,
    effort: validatedEffort(options.effort || null),
    sandbox: validatedSandbox(options.sandbox),
    networkAllow,
    addDirs,
    approveMcps,
    cursorWorktree,
    cursorWorktreeBase
  };
}

export function previewManagedJob(options) {
  const prepared = prepareManagedOptions(options, { reportLint: false });
  prepared.planFirst = planFirstDefault(prepared.mode || 'consult', prepared);
  prepared.ambiguityCheck = prepared.planFirst && ambiguityDefault(prepared);
  const provider = validateProvider(prepared.provider);
  const resolved = resolveManagedJobOptions(prepared, jobId(provider));
  const packetJob = {
    allowSensitive: prepared.allowSensitive === true,
    allowedPaths: resolved.allowedPaths,
    stagingDir: resolved.ingestPlan.stagingDir,
    reportSchema: resolved.reportSchema
  };
  return {
    dryRun: true,
    provider: resolved.provider,
    profile: prepared.profile || null,
    model: prepared.model || 'auto',
    mode: resolved.mode,
    planFirst: resolved.planFirst,
    ambiguityCheck: resolved.ambiguityCheck,
    effort: resolved.effort,
    approval: prepared.approval || 'auto',
    transport: resolved.transport,
    cwd: resolved.cwd,
    originalAllowedPaths: resolved.originalAllowedPaths,
    allowedPaths: resolved.allowedPaths,
    sandbox: resolved.sandbox || 'auto',
    network: prepared.network === true,
    networkAllow: resolved.networkAllow,
    addDirs: resolved.addDirs,
    approveMcps: resolved.approveMcps,
    cursorWorktree: resolved.cursorWorktree,
    cursorWorktreeBase: resolved.cursorWorktreeBase,
    timeoutSeconds: resolved.timeoutSeconds,
    maxOutputTokens: resolved.maxOutputTokens,
    idempotencyKey: resolved.idempotencyKey,
    groupId: resolved.groupId,
    retryPolicy: resolved.retryPolicy,
    verify: resolved.verify ? redact(resolved.verify) : null,
    verification: resolved.verification,
    verificationProfile: resolved.verificationProfile,
    autoFix: resolved.autoFix,
    startPaused: prepared.startPaused === true,
    isolation: prepared.isolation || 'shared',
    autoNudge: prepared.autoNudge === true,
    allowSensitive: prepared.allowSensitive === true,
    reportSchema: resolved.reportSchema,
    ingestPlan: {
      stagingDir: resolved.ingestPlan.stagingDir,
      files: resolved.ingestPlan.ingested
    },
    packetWarnings: prepared.packetWarnings || [],
    packet: assembleProviderPrompt(packetJob, prepared.prompt)
  };
}

export function createManagedJob(options) {
  options = options._profilePrepared ? options : prepareManagedOptions(options);
  const provider = validateProvider(options.provider);
  const id = jobId(provider);
  const resolved = resolveManagedJobOptions(options, id);
  const {
    sensitivePromptDetected, timeoutSeconds, maxOutputTokens, idempotencyKey, groupId, retryPolicy,
    mode, planFirst, ambiguityCheck, verify, verification, verificationProfile, autoFix, reportSchema, cwd, transport, originalAllowedPaths, allowedPaths, effort, sandbox,
    networkAllow, addDirs, approveMcps, cursorWorktree, cursorWorktreeBase
  } = resolved;
  const now = Math.floor(Date.now() / 1000);
  const origin = launchOrigin({
    origin: options.origin,
    projectDir: options.originProjectDir,
    launchCwd: options.originCwd,
    sessionId: options.originSessionId,
    workspaceId: options.originWorkspaceId,
    launchedAtMs: options.originLaunchedAtMs
  });
  const p = paths(id);
  const staged = stageIngestFiles(cwd, resolved.ingestPlan);
  const baseline = gitBaseline(cwd);
  for (const item of staged.ingested) {
    const hash = hashWorkingFile(cwd, item.staged);
    if (hash) baseline.hashes[item.staged] = hash;
  }
  writePrivate(p.prompt, options.prompt);
  const runnableVerify = verify?.command && verify.disabled !== true;
  if (runnableVerify) {
    writePrivate(p.verifyCommand, verify.format === 'recipe-v1'
      ? `${JSON.stringify(verify.commands)}\n`
      : verify.command);
  }
  const job = {
    schemaVersion: 2,
    id,
    provider,
    requestedModel: options.model || 'auto',
    model: options.model || 'auto',
    mode,
    planFirst,
    ambiguityCheck,
    planning: planFirst ? {
      state: 'pending',
      confirmationRequired: true,
      ambiguity: {
        enabled: ambiguityCheck,
        state: ambiguityCheck ? 'pending' : 'skipped',
        ...(ambiguityCheck ? {} : { reason: 'explicitly-disabled' })
      },
      planOutputTokenLimit: Math.min(planOutputTokenLimit(), maxOutputTokens || planOutputTokenLimit())
    } : null,
    approval: options.approval || 'auto',
    effort,
    timeoutSeconds,
    maxOutputTokens,
    idempotencyKey,
    groupId,
    retryPolicy,
    retries: 0,
    verify: verify ? redact(verify) : null,
    verification,
    verificationProfile: verificationProfile ? redact(verificationProfile) : null,
    autoFix,
    network: options.network === true,
    networkAllow,
    addDirs,
    approveMcps,
    cursorWorktree,
    cursorWorktreeBase,
    sandbox,
    originalAllowedPaths,
    allowedPaths,
    allowSensitive: options.allowSensitive === true,
    profile: options.profile || null,
    packetWarnings: options.packetWarnings || [],
    startPaused: options.startPaused === true,
    autoNudge: options.autoNudge === true,
    nudgeCount: 0,
    reportSchema,
    ingested: staged.ingested,
    stagingDir: staged.stagingDir,
    status: 'queued',
    phase: 'queued',
    revision: 0,
    lastSeq: 0,
    cwd,
    origin,
    transport,
    managedBy: 'delegate-control',
    capabilities: providerCapabilities(provider, transport),
    promptPath: p.prompt,
    verifyCommandPath: runnableVerify ? p.verifyCommand : null,
    stdoutPath: p.stdout,
    stderrPath: p.stderr,
    finishedPath: p.finished,
    providerSessionId: options.providerSessionId || null,
    parentJobId: options.parentJobId || null,
    planningFor: options.planningFor || null,
    createdAt: now,
    updatedAt: now,
    isolation: options.isolation || 'shared',
    attributionConfidence: options.isolation === 'worktree' ? 'high' : 'best-effort',
    baseRevision: verificationRepositoryRevision(cwd),
    baselineFiles: baseline.files,
    baselineHashes: baseline.hashes
  };
  saveJob(job);
  appendJobEvent(id, 'job.created', {
    provider, model: job.model, mode: job.mode, transport, isolation: job.isolation, groupId, startPaused: job.startPaused,
    planFirst: job.planFirst, ambiguityCheck: job.ambiguityCheck,
    network: job.network, networkAllow: job.networkAllow, addDirs: job.addDirs, approveMcps: job.approveMcps,
    cursorWorktree: job.cursorWorktree, cursorWorktreeBase: job.cursorWorktreeBase,
    verification: job.verification,
    verificationProfile: job.verificationProfile
      ? { repoRoot: job.verificationProfile.repoRoot, recipe: job.verificationProfile.recipe, cache: job.verificationProfile.cache }
      : null,
    autoFix: job.autoFix,
    ...(job.sandbox === 'off' ? { sandbox: 'off' } : {})
  });
  if (staged.ingested.length) appendJobEvent(id, 'files.ingested', { stagingDir: staged.stagingDir, files: staged.ingested });
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
  if (!signalCollisionWatchRefresh()) {
    recordCollisionWatchDegradation([id], { reason: 'watch-refresh-signal-unavailable' });
  }
  return inspectJob(id);
}

function ambiguityCandidate(parent) {
  const otherProvider = parent.provider === 'codex' ? 'cursor' : 'codex';
  if (providerEnabled(otherProvider)) {
    return {
      provider: otherProvider,
      model: otherProvider === 'codex' ? 'luna' : 'composer',
      independentBy: 'provider'
    };
  }
  if (parent.provider === 'codex') {
    return {
      provider: 'codex',
      model: ['luna', 'gpt-5.6-luna'].includes(parent.requestedModel || parent.model) ? 'terra' : 'luna',
      independentBy: 'model'
    };
  }
  return {
    provider: 'cursor',
    model: String(parent.requestedModel || parent.model).startsWith('grok') ? 'composer' : 'grok',
    independentBy: 'model'
  };
}

export function startAmbiguityProbe(id) {
  const parent = loadJob(id);
  if (!parent) throw brokerError('NOT_FOUND', `job not found: ${id}`);
  if (!parent.planFirst || parent.ambiguityCheck !== true) return null;
  if (parent.planning?.ambiguity?.jobId) return inspectJob(parent.planning.ambiguity.jobId);
  const configuredLimit = planOutputTokenLimit();
  const budget = parent.maxOutputTokens
    ? Math.min(configuredLimit, Math.floor(parent.maxOutputTokens * 0.2))
    : configuredLimit;
  if (budget < 128) {
    updateManagedJob(id, (current) => {
      current.planning.ambiguity = {
        enabled: true,
        state: 'skipped',
        reason: 'insufficient-output-token-budget'
      };
    }, { incrementRevision: false });
    appendJobEvent(id, 'plan.degraded', {
      stage: 'ambiguity-pass',
      reason: 'insufficient-output-token-budget',
      fallback: 'single-plan-confirmation'
    });
    return null;
  }
  const candidate = ambiguityCandidate(parent);
  let originalPrompt;
  try { originalPrompt = fs.readFileSync(parent.promptPath, 'utf8'); }
  catch (error) {
    updateManagedJob(id, (current) => {
      current.planning.ambiguity = { enabled: true, state: 'skipped', reason: 'prompt-unavailable' };
    }, { incrementRevision: false });
    appendJobEvent(id, 'plan.degraded', {
      stage: 'ambiguity-pass',
      reason: `prompt-unavailable: ${redact(error.message)}`,
      fallback: 'single-plan-confirmation'
    });
    return null;
  }
  try {
    const child = launchManagedJob({
      provider: candidate.provider,
      model: candidate.model,
      mode: 'plan',
      effort: 'low',
      approval: 'auto',
      cwd: parent.cwd,
      prompt: planPrompt(originalPrompt),
      allowSensitive: parent.allowSensitive === true,
      timeoutSeconds: Math.max(60, Math.min(parent.timeoutSeconds || 120, 120)),
      maxOutputTokens: budget,
      idempotencyKey: `ambiguity-${parent.id}`,
      groupId: `ambiguity-${parent.id}`,
      planningFor: parent.id,
      planFirst: false,
      ambiguityCheck: false,
      reportLint: false
    });
    updateManagedJob(id, (current) => {
      current.planning.externalOutputTokensReserved = budget;
      current.planning.ambiguity = {
        enabled: true,
        state: 'running',
        jobId: child.id,
        provider: candidate.provider,
        model: candidate.model,
        independentBy: candidate.independentBy,
        outputTokenLimit: budget
      };
    }, { incrementRevision: false });
    appendJobEvent(id, 'plan.ambiguity.started', {
      jobId: child.id,
      provider: candidate.provider,
      model: candidate.model,
      independentBy: candidate.independentBy,
      outputTokenLimit: budget
    });
    return child;
  } catch (error) {
    updateManagedJob(id, (current) => {
      current.planning.externalOutputTokensReserved = 0;
      current.planning.ambiguity = {
        enabled: true,
        state: 'skipped',
        reason: redact(error.message)
      };
    }, { incrementRevision: false });
    appendJobEvent(id, 'plan.degraded', {
      stage: 'ambiguity-pass',
      reason: redact(error.message),
      fallback: 'single-plan-confirmation'
    });
    return null;
  }
}

export async function awaitAmbiguityProbe(id, options = {}) {
  const parent = inspectJob(id);
  const probeId = parent.planning?.ambiguity?.jobId;
  if (!probeId) return null;
  const waitMs = Math.min(Math.max(Number(options.waitMs ?? 30_000), 0), 120_000);
  const deadline = Date.now() + waitMs;
  let probe = inspectJob(probeId);
  while (!TERMINAL_STATUSES.has(probe.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    probe = inspectJob(probeId);
  }
  const totals = usageTotals(probe.usage);
  const reserved = parent.planning?.ambiguity?.outputTokenLimit || 0;
  const attributed = totals?.outputTokens ?? reserved;
  updateManagedJob(id, (current) => {
    current.planning.externalOutputTokensReserved = attributed;
    current.planning.ambiguity = {
      ...current.planning.ambiguity,
      state: TERMINAL_STATUSES.has(probe.status) ? 'completed' : 'inconclusive',
      probeStatus: probe.status,
      outputTokens: totals?.outputTokens ?? null,
      costBasis: totals ? 'observed' : 'reserved-cap',
      ...(TERMINAL_STATUSES.has(probe.status) ? {} : { reason: 'comparison-pass-wait-timeout' })
    };
  }, { incrementRevision: false });
  if (!TERMINAL_STATUSES.has(probe.status)) {
    appendJobEvent(id, 'plan.degraded', {
      stage: 'ambiguity-comparison',
      reason: 'comparison-pass-wait-timeout',
      fallback: 'inconclusive-non-gating-comparison'
    });
  }
  return TERMINAL_STATUSES.has(probe.status) ? probe : null;
}

export function isDirectTransport(value) {
  const transport = typeof value === 'string' ? value : value?.transport;
  return DIRECT_TRANSPORTS.has(transport);
}

export function isReadOnlyTransport(value) {
  const transport = typeof value === 'string' ? value : value?.transport;
  return READ_ONLY_TRANSPORTS.has(transport);
}

function boundedDirectParams(value) {
  const safe = redact(value || {});
  let serialized;
  try { serialized = JSON.stringify(safe); }
  catch { return { truncated: true, value: '[unserializable direct parameters]' }; }
  if (serialized.length <= MAX_STRING) return safe;
  return { truncated: true, serialized: redact(serialized) };
}

function cleanupShadowCreation(id) {
  const p = paths(id);
  const files = [
    path.join(jobsDir(), `${id}.json`), p.events, p.finished, p.prompt,
    p.verifyCommand, p.stdout, p.stderr, p.lock
  ];
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  for (const directory of [p.commands, p.artifacts]) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
}

function shadowCapabilities(provider) {
  return {
    events: true,
    transcript: 'live',
    diff: provider === 'codex' ? 'provider' : 'best-effort',
    files: provider === 'codex' ? 'provider' : 'best-effort',
    correction: 'read-only',
    cancel: false,
    resume: false,
    usage: true,
    selfEnforcesProjectHooks: provider === 'codex'
  };
}

// Direct transports keep ownership of their provider loop. This creates only
// an observability record: it deliberately skips quota/writer admission and
// never stages inputs or changes provider launch behavior.
export function createShadowJob(options) {
  const provider = validateProvider(options.provider);
  if (!isDirectTransport(options.transport)) {
    throw brokerError('INVALID_REQUEST', `Invalid shadow transport: ${options.transport}`, { provider });
  }
  const id = jobId(provider);
  const createdAtMs = Date.now();
  const now = Math.floor(createdAtMs / 1000);
  const cwd = path.resolve(options.cwd || process.cwd());
  const origin = launchOrigin({
    origin: options.origin,
    projectDir: options.originProjectDir,
    launchCwd: options.originCwd,
    sessionId: options.originSessionId,
    workspaceId: options.originWorkspaceId,
    launchedAtMs: createdAtMs
  });
  const prompt = String(options.prompt || '');
  const p = paths(id);
  const baseline = gitBaseline(cwd, { excludeSensitive: true });
  const writeCapable = options.writeCapable === true || WRITE_MODES.has(options.mode);
  const managedRecords = listJobs().map((candidate) => {
    if (candidate.managedBy !== 'delegate-control' || TERMINAL_STATUSES.has(candidate.status)) return candidate;
    try { return reconcileJob(candidate.id); } catch { return candidate; }
  });
  const overlapsManagedWriter = writeCapable && activeWriterLocks(managedRecords).some((writer) => writer.cwd === cwd);
  const job = {
    schemaVersion: 2,
    id,
    provider,
    requestedModel: options.model || 'auto',
    model: options.model || 'auto',
    resolvedModel: options.resolvedModel || null,
    mode: options.mode || (writeCapable ? 'implement' : 'review'),
    approval: options.approval || 'auto',
    effort: options.effort || null,
    sandbox: options.sandbox || null,
    status: 'running',
    phase: 'running',
    revision: 0,
    lastSeq: 0,
    cwd,
    origin,
    transport: options.transport,
    managedBy: 'delegate-shadow',
    capabilities: shadowCapabilities(provider),
    promptPath: p.prompt,
    stdoutPath: p.stdout,
    stderrPath: p.stderr,
    finishedPath: p.finished,
    providerSessionId: options.providerSessionId || null,
    parentJobId: options.parentJobId || null,
    pid: options.pid || process.pid,
    workerPid: options.workerPid || options.pid || process.pid,
    createdAt: now,
    createdAtMs,
    updatedAt: now,
    isolation: 'shared',
    attributionConfidence: 'best-effort',
    baselineFiles: baseline.files,
    baselineHashes: baseline.hashes,
    directParams: boundedDirectParams(options.params),
    overlapsManagedWriter
  };
  try {
    // Direct calls may contain material the managed admission path would
    // reject. The shadow is observability-only, so persist only its redacted,
    // bounded form and never change the caller's execution decision.
    writePrivate(p.prompt, redact(prompt));
    saveJob(job);
    appendJobEvent(id, 'job.created', {
      provider,
      model: job.model,
      mode: job.mode,
      effort: job.effort,
      transport: job.transport,
      isolation: job.isolation,
      direct: true,
      params: job.directParams,
      ...(job.sandbox ? { sandbox: job.sandbox } : {})
    });
    appendJobEvent(id, 'message.user', { text: prompt });
    if (overlapsManagedWriter) {
      appendJobEvent(id, 'security.warning', {
        code: 'DIRECT_WRITER_OVERLAP',
        message: 'direct write-capable delegation overlaps an active managed writer in this cwd',
        cwd
      });
    }
    appendJobEvent(id, 'job.state', { status: 'running', phase: 'running', transport: job.transport }, { lifecycle: true });
    return inspectJob(id);
  } catch (error) {
    cleanupShadowCreation(id);
    throw error;
  }
}

export function latestShadowJobForSession(provider, providerSessionId) {
  if (!providerSessionId) return null;
  return listJobs().filter((job) => job.provider === provider
    && isDirectTransport(job)
    && (job.providerSessionId === providerSessionId || job.session === providerSessionId))
    .sort((left, right) => Number(right.createdAtMs || Number(right.createdAt || 0) * 1000)
      - Number(left.createdAtMs || Number(left.createdAt || 0) * 1000))[0] || null;
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
  if (options.dryRun === true) return previewManagedJob(options);
  const prepared = prepareManagedOptions(options, { reportLint: options.reportLint });
  prepared.planFirst = planFirstDefault(prepared.mode || 'consult', prepared);
  prepared.ambiguityCheck = prepared.planFirst && ambiguityDefault(prepared);
  const provider = validateProvider(prepared.provider);
  const launchOptions = {
    ...prepared,
    _profilePrepared: true,
    provider,
    idempotencyKey: validatedIdempotencyKey(prepared.idempotencyKey),
    groupId: validatedGroupId(prepared.groupId)
  };
  try { maybePruneJobs(); } catch {}
  // Boot reconciliation happens before writer admission, so a dead leased
  // writer cannot block the first post-restart launch. This call is strictly
  // best-effort: every error is absorbed by the inline launch fallback.
  try { ensureSupervisorReady(); } catch {}

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
  let supervised = null;
  try { supervised = submitJobToSupervisor(job.id); } catch {}
  if (supervised?.ok && supervised.accepted === true) return inspectJob(job.id);
  const afterSupervisor = loadJob(job.id);
  if (afterSupervisor && TERMINAL_STATUSES.has(afterSupervisor.status)) return inspectJob(job.id);
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
    current.executionOwner = 'inline-detached';
  });
  child.unref();
  return inspectJob(job.id);
}

export function submitControl(id, command, expectedRevision) {
  assertJobId(id);
  if (!command?.type) throw brokerError('INVALID_REQUEST', 'control command type is required');
  if (!['steer', 'cancel', 'release', 'respond', 'interrogate'].includes(command.type)) throw brokerError('INVALID_REQUEST', `unsupported control command: ${command.type}`);
  return withLock(id, () => {
    const job = loadJob(id);
    if (!job) throw brokerError('NOT_FOUND', `job not found: ${id}`);
    if (isReadOnlyTransport(job)) {
      if (!isDirectTransport(job)) throw brokerError('READ_ONLY_TRANSPORT', 'hook-observed jobs are read-only in the control plane', { provider: job.provider });
      throw brokerError('DIRECT_TRANSPORT', 'direct-transport jobs are read-only in the control plane; the caller session owns the provider loop', { provider: job.provider });
    }
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
    if (command.type === 'interrogate') {
      const unknown = Object.keys(command).filter((key) => !['type', 'question', 'commandId'].includes(key));
      if (unknown.length) {
        throw brokerError('INVALID_REQUEST', `interrogation carries a question only; rejected fields: ${unknown.join(', ')}`, { provider: job.provider });
      }
      if (typeof command.question !== 'string' || !command.question.trim()) {
        throw brokerError('INVALID_REQUEST', 'interrogation question is required', { provider: job.provider });
      }
      if (command.question.length > 8_192) {
        throw brokerError('INVALID_REQUEST', 'interrogation question exceeds 8192 characters', { provider: job.provider });
      }
      if (!job.providerSessionId) {
        throw brokerError('SESSION_UNAVAILABLE', 'interrogation requires a live provider session', { provider: job.provider });
      }
      if (!job.maxOutputTokens) {
        throw brokerError('BUDGET_EXCEEDED', 'interrogation requires maxOutputTokens so its provider-turn cost is bounded', { provider: job.provider });
      }
      if ((job.interrogations || []).some((entry) => ['queued', 'active'].includes(entry.state))) {
        throw brokerError('USER_INPUT_REQUIRED', 'another interrogation is already queued or active', { provider: job.provider });
      }
      const used = (usageTotals(job.usage)?.outputTokens || 0) + Number(job.planning?.externalOutputTokensReserved || 0);
      const remaining = Math.max(0, job.maxOutputTokens - used);
      if (remaining < Math.min(128, interrogationOutputTokenLimit())) {
        throw brokerError('BUDGET_EXCEEDED', `interrogation has only ${remaining} output tokens remaining in the work-item budget`, {
          provider: job.provider,
          maxOutputTokens: job.maxOutputTokens,
          observedOutputTokens: used
        });
      }
    }
    if (command.type === 'respond') {
      if (!job.pendingInput) throw brokerError('INVALID_REQUEST', 'the job has no pending worker question or plan request', { provider: job.provider });
      if (command.requestId && command.requestId !== job.pendingInput.requestId) {
        throw brokerError('REVISION_CONFLICT', `response targets ${command.requestId}, current pending request is ${job.pendingInput.requestId}`, {
          provider: job.provider, currentRevision: job.revision
        });
      }
      const hasAnswer = typeof command.answer === 'string';
      const hasDecision = typeof command.accept === 'boolean';
      const hasResponse = command.response && typeof command.response === 'object' && !Array.isArray(command.response);
      if (!hasAnswer && !hasDecision && !hasResponse) {
        throw brokerError('INVALID_REQUEST', 'respond requires answer, accept/reject, or a structured response object', { provider: job.provider });
      }
    }
    if (command.type === 'release' && !job.startPaused) throw brokerError('INVALID_REQUEST', 'release is available only for startPaused jobs', { provider: job.provider });
    if (command.type === 'steer' && command.strategy === 'same-turn' && job.provider === 'cursor') {
      throw brokerError('UNSUPPORTED_STRATEGY', 'Cursor ACP has no same-turn steering; use strategy=auto or restart (applied as a cancel-and-resume restart)', { provider: job.provider });
    }
    const record = command.type === 'respond'
      ? redact({ ...command, requestId: command.requestId || job.pendingInput.requestId, commandId, expectedRevision, requestedAt: Date.now() })
      : command.type === 'interrogate'
        ? redact({
            type: 'interrogate',
            question: command.question.trim(),
            commandId,
            expectedRevision,
            requestedAt: Date.now(),
            contractDigest: contractDigest(job),
            outputTokenLimit: Math.min(
              interrogationOutputTokenLimit(),
              Math.max(0, job.maxOutputTokens - (usageTotals(job.usage)?.outputTokens || 0) - Number(job.planning?.externalOutputTokensReserved || 0))
            )
          })
        : { ...command, commandId, expectedRevision, requestedAt: Date.now() };
    fs.mkdirSync(paths(id).commands, { recursive: true, mode: 0o700 });
    writePrivate(path.join(paths(id).commands, `${commandId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    job.controls[commandId] = { type: command.type, state: 'queued', requestedAt: record.requestedAt };
    job.revision += 1;
    if (command.type === 'cancel') job.phase = 'cancelling';
    if (command.type === 'release') job.phase = 'releasing';
    if (command.type === 'respond') job.phase = 'responding';
    if (command.type === 'interrogate') {
      job.interrogations ||= [];
      job.interrogations.push({
        id: commandId,
        question: record.question,
        state: 'queued',
        requestedAt: record.requestedAt,
        contractDigest: record.contractDigest,
        outputTokenLimit: record.outputTokenLimit,
        authority: 'evidence-only'
      });
    }
    const type = command.type === 'steer' ? 'correction.requested'
      : command.type === 'cancel' ? 'job.cancel.requested'
        : command.type === 'release' ? 'job.release.requested'
          : command.type === 'interrogate' ? 'interrogation.requested' : 'input.response.requested';
    appendUnlocked(job, type, command.type === 'respond'
      ? { commandId, requestId: record.requestId, answer: record.answer, accept: record.accept, response: record.response }
      : command.type === 'interrogate'
        ? {
            commandId,
            question: record.question,
            outputTokenLimit: record.outputTokenLimit,
            authority: 'evidence-only',
            constraintsUnchanged: true
          }
        : { commandId, strategy: command.strategy || null, text: command.text || null });
    saveJob(job);
    return { accepted: true, commandId, revision: job.revision, phase: job.phase };
  });
}

export function claimCommands(id, options = {}) {
  const p = paths(id);
  const includeTypes = Array.isArray(options.includeTypes) ? new Set(options.includeTypes) : null;
  const excludeTypes = new Set(Array.isArray(options.excludeTypes) ? options.excludeTypes : []);
  fs.mkdirSync(p.done, { recursive: true, mode: 0o700 });
  let names = [];
  try {
    names = fs.readdirSync(p.commands).filter((name) => name.endsWith('.json')).map((name) => {
      try {
        const command = JSON.parse(fs.readFileSync(path.join(p.commands, name), 'utf8'));
        return { name, requestedAt: command.requestedAt || 0, type: command.type };
      } catch { return { name, requestedAt: 0 }; }
    }).filter((item) => (!includeTypes || includeTypes.has(item.type)) && !excludeTypes.has(item.type))
      .sort((a, b) => a.requestedAt - b.requestedAt || a.name.localeCompare(b.name)).map((item) => item.name);
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
  if (storedParent.verify?.exception) {
    inheritedVerify = { exception: storedParent.verify.exception };
  } else if (storedParent.verify && storedParent.verifyCommandPath && storedParent.verify.origin !== 'derived') {
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
    origin: storedParent.origin || parent.origin || null,
    groupId: options.groupId ?? parent.groupId ?? null,
    transport: parent.transport,
    isolation: parent.isolation,
    timeoutSeconds: options.timeoutSeconds ?? parent.timeoutSeconds ?? null,
    maxOutputTokens: options.maxOutputTokens ?? parent.maxOutputTokens ?? null,
    retryPolicy: options.retryPolicy ?? parent.retryPolicy ?? null,
    verify: options.verify ?? inheritedVerify,
    network: options.network ?? parent.network ?? false,
    networkAllow: options.networkAllow ?? parent.networkAllow ?? null,
    addDirs: options.addDirs ?? parent.addDirs ?? [],
    approveMcps: options.approveMcps ?? parent.approveMcps ?? false,
    cursorWorktree: options.cursorWorktree ?? parent.cursorWorktree ?? false,
    cursorWorktreeBase: options.cursorWorktreeBase ?? parent.cursorWorktreeBase ?? null,
    sandbox: options.sandbox ?? parent.sandbox ?? null,
    allowedPaths: options.allowedPaths ?? parent.originalAllowedPaths ?? parent.allowedPaths ?? null,
    planFirst: options.planFirst,
    ambiguityCheck: options.ambiguityCheck,
    autoNudge: options.autoNudge ?? parent.autoNudge ?? false,
    autoFix: options.autoFix ?? (parent.autoFix ? {
      maxRounds: parent.autoFix.maxRounds,
      _state: {
        round: parent.autoFix.round,
        startedAtMs: parent.autoFix.startedAtMs,
        previousMetrics: parent.autoFix.previousMetrics,
        rootJobId: parent.autoFix.rootJobId
      }
    } : null),
    reportSchema: options.reportSchema ?? parent.reportSchema ?? null,
    overrideLimit: options.overrideLimit,
    overrideWriter: options.overrideWriter,
    reportLint: options.reportLint
  });
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function buildReviewRoundPacket(job, findings, diff = jobDiff(job.id)) {
  const text = String(findings || '').trim();
  if (!text) throw brokerError('INVALID_REQUEST', 'review-round findings prompt is required', { provider: job.provider });
  const stat = diffStat(diff);
  const changedFiles = Array.isArray(job.changedFiles?.entries) && job.changedFiles.entries.length
    ? job.changedFiles.entries.map((entry) => entry?.path).filter(Boolean)
    : (job.changedFiles?.files || []);
  const allowedPaths = job.originalAllowedPaths ?? job.allowedPaths;
  const sections = [
    `Review round for job ${job.id}.`,
    '',
    'Diff stat:',
    '| Path | Additions | Deletions |',
    '| --- | ---: | ---: |',
    ...(stat.files.length
      ? stat.files.map((file) => `| ${markdownCell(file.path)} | ${file.additions} | ${file.deletions} |`)
      : ['| (no recorded files) | 0 | 0 |']),
    '',
    'Changed files:',
    ...(changedFiles.length ? changedFiles.map((file) => `- ${file}`) : ['- (none recorded)'])
  ];
  if (allowedPaths?.length) sections.push('', 'Allowed paths:', ...allowedPaths.map((entry) => `- ${entry}`));
  sections.push('', 'Findings:', text);
  return sections.join('\n');
}

export function reviewRoundManagedJob(id, options) {
  const parent = inspectJob(id);
  const resumability = resumabilityFor(parent);
  if (!resumability.ok) throw brokerError(resumability.code, resumability.reason, { provider: parent.provider });
  const packet = buildReviewRoundPacket(parent, options?.prompt);
  return resumeManagedJob(id, { ...options, prompt: packet });
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
  if (isReadOnlyTransport(job)) {
    if (!isDirectTransport(job)) throw brokerError('READ_ONLY_TRANSPORT', 'hook-observed jobs are read-only in the control plane', { provider: job.provider });
    throw brokerError('DIRECT_TRANSPORT', 'direct-transport jobs are read-only in the control plane; the caller session owns the provider loop', { provider: job.provider });
  }
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

const WAIT_TARGETS = new Set(['session', 'turn', 'first-output']);
const FIRST_OUTPUT_TYPES = new Set(['message.delta', 'message.completed', 'tool.started']);

// One bounded, cursor-driven poller covers all start milestones. The event
// cursor advances through the journal once, so quiet polling never rescans a
// growing history.
export async function waitForJob(id, target = 'session', timeoutMs = 30000) {
  if (!WAIT_TARGETS.has(target)) throw brokerError('INVALID_REQUEST', "waitFor must be 'session', 'turn', or 'first-output'");
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 30000, 10), 120000);
  let afterSeq = 0;
  for (;;) {
    const page = readJobEventPage(id, { afterSeq, limit: 1000 });
    afterSeq = page.nextSeq;
    const job = inspectJob(id);
    const reached = target === 'session'
      ? Boolean(job.providerSessionId || job.session)
      : target === 'turn'
        ? Boolean(job.providerTurnId || page.events.some((event) => event.type === 'turn.started'))
        : page.events.some((event) => FIRST_OUTPUT_TYPES.has(event.type));
    if (reached || TERMINAL_STATUSES.has(job.status) || Date.now() >= deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function waitForSessionId(id, timeoutMs = 30000) {
  return waitForJob(id, 'session', timeoutMs);
}

export function backfillAuditLog() {
  const file = auditLogPath();
  return withFileLock(`${file}.lock`, () => {
    const audited = new Set();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const jobId = JSON.parse(line)?.jobId;
          if (jobId) audited.add(jobId);
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const terminalJobs = listJobs().filter((job) => TERMINAL_STATUSES.has(job.status));
    const missing = terminalJobs
      .filter((job) => !audited.has(job.id))
      .filter((job) => !(job.executionOwner === 'supervisor' && job.attemptLease && job.executionAttribution?.finalized !== true));
    appendAuditRecordsUnlocked(file, missing.map((job) => terminalAuditRecord(job, { backfilled: true })));
    return { scanned: terminalJobs.length, backfilled: missing.length };
  });
}

export function pruneJobs(options = {}) {
  const days = Number(options.maxAgeDays ?? process.env.DELEGATE_JOB_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(days) || days <= 0) return { pruned: [], maxAgeDays: days };
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const pruned = [];
  for (const record of listJobs()) {
    let job = record;
    const staleAgentStubAtRead = record.transport === 'claude-agent'
      && (record.updatedAt || record.createdAt || 0) <= cutoff;
    if (!TERMINAL_STATUSES.has(job.status) && jobNeedsReconciliation(job)) {
      try { job = reconcileJob(job.id) || job; } catch {}
    }
    const staleAgentStub = staleAgentStubAtRead || (job.transport === 'claude-agent'
      && (job.updatedAt || job.createdAt || 0) <= cutoff);
    if (!TERMINAL_STATUSES.has(job.status) && !staleAgentStub) continue;
    const finishedAt = staleAgentStubAtRead
      ? (record.updatedAt || record.createdAt || 0)
      : (job.completedAt || job.updatedAt || job.createdAt || 0);
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
