import fs from 'node:fs';
import path from 'node:path';
import { dataDir, loadJob } from './state.mjs';
import { withFileLock } from './lock.mjs';
import { atomicWritePrivateJson } from './supervisor-common.mjs';
import { ensureSupervisorReady } from './supervisor-client.mjs';
import { launchManagedJob } from './control.mjs';
import { approvedNativePreview, validateNativePreview } from './native-launch.mjs';
import { providerConcurrencyLimit } from './admission.mjs';
import { brokerError } from './errors.mjs';

const file = () => path.join(dataDir(), 'dispatch-queue.json');
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired', 'needs-reapproval']);
function read() {
  try {
    if (fs.statSync(file()).size > 8 * 1024 * 1024) throw brokerError('STATE_ERROR', 'dispatch queue exceeds size bound');
    const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 128) throw brokerError('STATE_ERROR', 'invalid dispatch queue');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: [] }; throw error; }
}
function mutate(fn) {
  return withFileLock(`${file()}.lock`, () => {
    const state = read();
    const result = fn(state);
    atomicWritePrivateJson(file(), state);
    return result;
  });
}
function publicRow(entry) {
  return { id: entry.id, provider: entry.record.options.provider, model: entry.record.options.model,
    mode: entry.record.options.mode, state: entry.state, reason: entry.reason || null,
    priority: entry.priority, revision: entry.revision, createdAt: entry.createdAt,
    expiresAt: entry.record.expiresAt, sessionId: entry.record.sessionId, projectDir: entry.record.projectDir,
    jobId: entry.jobId || null };
}
export function listDispatchQueue() { return read().entries.map(publicRow); }
export function hasPendingDispatch() { return read().entries.some((entry) => !terminal.has(entry.state)); }

export function enqueueNativePreview(input) {
  const record = approvedNativePreview(input, { deferValidation: true });
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -5 || priority > 5) throw brokerError('INVALID_REQUEST', 'priority must be -5..5');
  const result = mutate((state) => {
    const existing = state.entries.find((entry) => entry.id === record.id);
    if (existing) return publicRow(existing);
    validateNativePreview(record);
    state.entries = state.entries.filter((entry) => !terminal.has(entry.state) || Date.now() - entry.updatedAt < 86400_000);
    if (state.entries.length >= 128) throw brokerError('INVALID_REQUEST', 'pending queue full');
    // The confirmation explicitly authorizes bounded delayed dispatch for up
    // to eight hours. Expiry never grants a larger run budget or a new scope.
    const entry = { id: record.id, record: { ...record, expiresAt: Date.now() + 8 * 3600_000 },
      priority, state: 'pending', reason: 'awaiting-admission', revision: 1,
      createdAt: Date.now(), updatedAt: Date.now() };
    state.entries.push(entry);
    return publicRow(entry);
  });
  // A failed start leaves a durable pending row, not a pretend running job.
  try { ensureSupervisorReady(); } catch {}
  return result;
}

export function controlDispatchQueue(input) {
  if (input.confirmed !== true) throw brokerError('INVALID_REQUEST', 'human queue confirmation required');
  return mutate((state) => {
    const entry = state.entries.find((value) => value.id === input.queueId);
    if (!entry) throw brokerError('NOT_FOUND', 'queue entry not found');
    if (entry.record.sessionId !== input.sessionId || fs.realpathSync(input.projectDir) !== entry.record.projectDir) throw brokerError('INVALID_REQUEST', 'queue belongs to another session/workspace');
    if (entry.revision !== input.expectedRevision) throw brokerError('REVISION_CONFLICT', 'queue revision changed; reinspect');
    if (entry.state !== 'pending') throw brokerError('INVALID_REQUEST', 'only pending entries can be cancelled or reprioritized; use job controls after dispatch');
    if (input.queueAction === 'cancel') { entry.state = 'cancelled'; entry.reason = 'cancelled-before-dispatch'; }
    else if (input.queueAction === 'priority' && Number.isInteger(input.priority) && input.priority >= -5 && input.priority <= 5) entry.priority = input.priority;
    else throw brokerError('INVALID_REQUEST', 'invalid queue action');
    entry.revision += 1; entry.updatedAt = Date.now();
    return publicRow(entry);
  });
}

// Called only by the resident. Reservation is synchronous under the queue
// lock; provider submission happens afterwards. A crash in between is retried
// against the same reserved job, never a new paid invocation.
export async function pumpDispatchQueue(runtime = {}) {
  if (!hasPendingDispatch()) return { reserved: [] };
  const reserved = mutate((state) => {
    const launch = runtime.reserve || ((options) => launchManagedJob(options, {
      deferSubmit: true, concurrencyLimit: providerConcurrencyLimit(options.provider, true)
    }));
    const ids = [];
    const candidates = [...state.entries].sort((a, b) => b.priority - a.priority
      || (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0) || a.createdAt - b.createdAt);
    let checked = 0;
    for (const entry of candidates) {
      if (terminal.has(entry.state)) continue;
      if (entry.jobId) {
        const job = loadJob(entry.jobId);
        if (!job) { entry.state = 'failed'; entry.reason = 'reserved-job-missing'; }
        else if (['completed', 'failed', 'cancelled'].includes(job.status)) { entry.state = job.status; entry.reason = job.errorCode || job.status; }
        else if (job.status === 'queued') ids.push(job.id);
        continue;
      }
      if (entry.record.expiresAt <= Date.now()) { entry.state = 'expired'; entry.reason = 'approval-expired'; entry.revision += 1; continue; }
      // Keep each resident pass bounded. Rotate blocked entries within equal
      // priority so a quota-blocked lane cannot starve another provider.
      if (checked++ >= 4) continue;
      entry.lastCheckedAt = Date.now();
      try {
        (runtime.validate || validateNativePreview)(entry.record);
        const job = launch(entry.record.options);
        entry.jobId = job.id; entry.state = 'dispatched'; entry.reason = null;
        entry.revision += 1; ids.push(job.id);
      } catch (error) {
        const retry = ['WRITER_ACTIVE', 'CLAIM_CONFLICT', 'PROVIDER_BUSY', 'QUOTA_GUARD', 'LOCK_TIMEOUT', 'PROVIDER_DISABLED'].includes(error.code);
        const reason = /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'STATE_ERROR';
        if (entry.reason !== reason) entry.revision += 1;
        entry.reason = reason;
        if (!retry) entry.state = error.code === 'CAS_CONFLICT' || error.code === 'INVALID_REQUEST' ? 'needs-reapproval' : 'failed';
      }
      entry.updatedAt = Date.now();
    }
    return [...new Set(ids)];
  });
  for (const id of reserved) {
    if (runtime.submit) await runtime.submit(id);
  }
  return { reserved };
}
