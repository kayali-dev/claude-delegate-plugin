import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  finalizeSupervisorAttempt,
  updateManagedJob
} from './control.mjs';
import { jobsDir, loadJob } from './state.mjs';
import { isProcessAlive } from './process.mjs';
import {
  SUPERVISOR_PROTOCOL_VERSION,
  atomicWritePrivateJson,
  classifyLeaseProcess,
  classifySupervisorLock,
  ensureSupervisorDirectories,
  heartbeatSupervisorLease,
  listSupervisorLeases,
  readPrivateJson,
  removeSupervisorLease,
  saveSupervisorLease,
  supervisorBrokerVersion,
  supervisorPaths
} from './supervisor-common.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWorker = path.join(moduleDirectory, '..', 'delegate-worker');

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function leaseTiming() {
  const heartbeatMs = positiveNumber(process.env.DELEGATE_SUPERVISOR_HEARTBEAT_MS, 2000, 50);
  const leaseTtlMs = positiveNumber(process.env.DELEGATE_SUPERVISOR_LEASE_TTL_MS, Math.max(15000, heartbeatMs * 3), heartbeatMs * 2);
  return { heartbeatMs, leaseTtlMs };
}

function idleWindowMs() {
  const testDefault = process.env.NODE_TEST_CONTEXT ? 500 : 30 * 60 * 1000;
  return positiveNumber(process.env.DELEGATE_SUPERVISOR_IDLE_MS, testDefault, 50);
}

function logLine(file, message, details = {}) {
  const entry = { at: new Date().toISOString(), pid: process.pid, message, ...details };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function workerPaths(jobId) {
  const root = jobsDir();
  return {
    stdout: path.join(root, `${jobId}.out.log`),
    stderr: path.join(root, `${jobId}.err.log`)
  };
}

function liveLeaseCount() {
  return listSupervisorLeases().filter((lease) => Number.isInteger(lease.pid) && isProcessAlive(lease.pid)).length;
}

function attributionFromLease(lease, values = {}) {
  return {
    outcome: values.outcome || 'unknown',
    exitCode: Number.isInteger(values.exitCode) ? values.exitCode : null,
    signal: values.signal || null,
    pid: lease.pid,
    ppid: lease.ppid ?? null,
    pgid: lease.pgid ?? null,
    supervisorBootId: values.supervisorBootId || null,
    leaseBootId: lease.bootId,
    lastHeartbeat: lease.heartbeatAt,
    leaseExpiresAt: lease.expiresAt,
    providerProcessAttachable: values.providerProcessAttachable === true,
    finalizedAt: Date.now(),
    reason: values.reason,
    errorCode: values.errorCode,
    stoppedReason: values.stoppedReason,
    retryable: values.retryable
  };
}

function finalizeLease(lease, values = {}) {
  const outcome = attributionFromLease(lease, values);
  try {
    const job = finalizeSupervisorAttempt(lease.jobId, outcome);
    removeSupervisorLease(lease.attemptId);
    return { finalized: true, job, outcome };
  } catch (error) {
    try {
      saveSupervisorLease({
        ...lease,
        reconciliationOutcome: outcome.outcome,
        reconciliationError: String(error.message || error),
        reconciliationAt: Date.now()
      });
    } catch {}
    return { finalized: false, error, outcome };
  }
}

function recordAdoptedLease(lease, bootId) {
  try {
    updateManagedJob(lease.jobId, (job) => {
      if (TERMINAL.has(job.status)) return;
      job.executionOwner = 'supervisor';
      job.pid = lease.pid;
      job.workerPid = lease.pid;
      job.attemptLease = {
        jobId: lease.jobId,
        attemptId: lease.attemptId,
        pid: lease.pid,
        ppid: lease.ppid,
        pgid: lease.pgid,
        bootId: lease.bootId,
        adoptedByBootId: bootId,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt
      };
    }, { incrementRevision: false });
  } catch {}
}

export function reconcileSupervisorLeases(options = {}) {
  const bootId = options.bootId || crypto.randomUUID();
  const probe = options.probe;
  const results = [];
  for (const lease of listSupervisorLeases()) {
    const classification = classifyLeaseProcess(lease, { ...(probe ? { probe } : {}) });
    if (classification.outcome === 'alive') {
      recordAdoptedLease(lease, bootId);
      results.push({ outcome: 'adopted', lease, info: classification.info });
      continue;
    }
    if (classification.outcome === 'dead') {
      const reason = `SUPERVISOR_PROCESS_GONE: leased worker pid ${lease.pid} was not alive during boot reconciliation; exit status is unavailable`;
      const finalized = finalizeLease(lease, {
        outcome: 'dead-on-boot',
        supervisorBootId: bootId,
        providerProcessAttachable: false,
        reason,
        errorCode: 'ORPHANED',
        stoppedReason: 'leased-process-gone'
      });
      results.push({ outcome: 'dead', lease, finalized });
      continue;
    }
    const reason = `SUPERVISOR_PROCESS_UNKNOWN: pid ${lease.pid} was alive but could not be positively identified as this leased worker`;
    const finalized = finalizeLease(lease, {
      outcome: 'unknown-on-boot',
      supervisorBootId: bootId,
      providerProcessAttachable: false,
      reason,
      errorCode: 'STATE_ERROR',
      stoppedReason: 'leased-process-unknown'
    });
    results.push({ outcome: 'unknown', lease, finalized });
  }
  return results;
}

export class ResidentSupervisor {
  constructor(options = {}) {
    this.bootId = options.bootId || crypto.randomUUID();
    this.brokerVersion = options.brokerVersion || supervisorBrokerVersion();
    this.protocolVersion = options.protocolVersion || SUPERVISOR_PROTOCOL_VERSION;
    this.startedAt = Date.now();
    this.lastWorkAt = this.startedAt;
    this.draining = false;
    this.drainReason = null;
    this.entries = new Map();
    this.server = null;
    this.heartbeatTimer = null;
    this.idleTimer = null;
    this.exitOnShutdown = options.exitOnShutdown === true;
    this.shuttingDown = false;
    this.locations = supervisorPaths();
    const timing = leaseTiming();
    this.heartbeatMs = options.heartbeatMs || timing.heartbeatMs;
    this.leaseTtlMs = options.leaseTtlMs || timing.leaseTtlMs;
    this.idleMs = options.idleMs || idleWindowMs();
    this.workerPath = options.workerPath || process.env.DELEGATE_SUPERVISOR_WORKER_BIN || defaultWorker;
    this.probe = options.probe;
    this.signalHandlers = new Map();
  }

  log(message, details = {}) {
    try { logLine(this.locations.stdout, message, { bootId: this.bootId, ...details }); } catch {}
  }

  snapshot(status = this.shuttingDown ? 'stopping' : this.draining ? 'draining' : 'running') {
    return {
      status,
      pid: process.pid,
      bootId: this.bootId,
      startedAt: this.startedAt,
      brokerVersion: this.brokerVersion,
      protocolVersion: this.protocolVersion,
      draining: this.draining,
      drainReason: this.drainReason,
      liveLeases: this.entries.size,
      lastWorkAt: this.lastWorkAt,
      updatedAt: Date.now()
    };
  }

  persist(status) {
    atomicWritePrivateJson(this.locations.runtimeState, this.snapshot(status));
  }

  acquireInstance() {
    ensureSupervisorDirectories();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.locations.lock, 'wx', 0o600);
        const lock = {
          pid: process.pid,
          bootId: this.bootId,
          startedAt: this.startedAt,
          brokerVersion: this.brokerVersion,
          protocolVersion: this.protocolVersion
        };
        fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
        fs.closeSync(fd);
        try { fs.chmodSync(this.locations.lock, 0o600); } catch {}
        return lock;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readPrivateJson(this.locations.lock);
        const classification = classifySupervisorLock(existing, {
          ...(this.probe ? { probe: this.probe } : {}),
          liveLeases: liveLeaseCount()
        });
        if (classification.action !== 'reclaim-files-only') {
          const conflict = new Error(`supervisor lock is ${classification.state}`);
          conflict.code = classification.state === 'alive-supervisor' ? 'SUPERVISOR_ALREADY_RUNNING' : 'SUPERVISOR_IDENTITY_UNKNOWN';
          conflict.classification = classification;
          throw conflict;
        }
        try { fs.unlinkSync(this.locations.lock); } catch {}
        try { fs.unlinkSync(this.locations.socket); } catch {}
      }
    }
    throw new Error('could not acquire supervisor singleton lock');
  }

  installSignalHandlers() {
    const bind = (signal, handler) => {
      process.on(signal, handler);
      this.signalHandlers.set(signal, handler);
    };
    bind('SIGHUP', () => {
      this.log('signal received; continuing', { signal: 'SIGHUP' });
      try { this.persist(); } catch {}
    });
    for (const signal of ['SIGTERM', 'SIGINT']) {
      bind(signal, () => {
        this.log('signal received; draining', { signal });
        this.requestDrain(signal);
      });
    }
  }

  removeSignalHandlers() {
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers.clear();
  }

  async start() {
    this.acquireInstance();
    const reconciled = reconcileSupervisorLeases({
      bootId: this.bootId,
      ...(this.probe ? { probe: this.probe } : {})
    });
    for (const item of reconciled) {
      if (item.outcome === 'adopted') {
        this.entries.set(item.lease.attemptId, { lease: item.lease, child: null, adopted: true });
      }
    }
    this.persist();
    try { fs.unlinkSync(this.locations.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (error) => {
      this.log('control socket error', { code: error.code, error: error.message });
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.locations.socket);
    });
    try { fs.chmodSync(this.locations.socket, 0o600); } catch {}
    this.installSignalHandlers();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    const idleTick = Math.min(Math.max(50, Math.floor(this.idleMs / 4)), 30000);
    this.idleTimer = setInterval(() => this.checkIdle(), idleTick);
    this.idleTimer.unref?.();
    this.log('supervisor started', { brokerVersion: this.brokerVersion, protocolVersion: this.protocolVersion, adopted: this.entries.size });
    return this.snapshot();
  }

  handleConnection(socket) {
    socket.setEncoding('utf8');
    let body = '';
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) socket.destroy();
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      const line = body.slice(0, newline);
      body = '';
      let request;
      try { request = JSON.parse(line); }
      catch {
        socket.end(`${JSON.stringify({ ok: false, code: 'INVALID_REQUEST', error: 'invalid JSON request' })}\n`);
        return;
      }
      Promise.resolve(this.handleRequest(request))
        .then((response) => socket.end(`${JSON.stringify(response)}\n`))
        .catch((error) => socket.end(`${JSON.stringify({ ok: false, code: error.code || 'SUPERVISOR_ERROR', error: error.message })}\n`));
    });
  }

  statusResponse() {
    return { ok: true, ...this.snapshot() };
  }

  async handleRequest(request) {
    if (request?.method === 'status') return this.statusResponse();
    if (Number(request?.protocolVersion) !== Number(this.protocolVersion)) {
      return {
        ok: false,
        code: 'VERSION_MISMATCH',
        error: 'supervisor protocol version mismatch',
        ...this.snapshot()
      };
    }
    if (request.method === 'drain') {
      this.requestDrain(request.params?.reason || 'control-request');
      return { ok: true, accepted: true, ...this.snapshot() };
    }
    if (request.brokerVersion !== this.brokerVersion) {
      return {
        ok: false,
        code: 'VERSION_MISMATCH',
        error: 'supervisor broker version mismatch',
        ...this.snapshot()
      };
    }
    if (request.method === 'submit') {
      if (this.draining) return { ok: false, code: 'SUPERVISOR_DRAINING', error: 'supervisor is draining', ...this.snapshot() };
      return this.submit(request.params?.jobId);
    }
    return { ok: false, code: 'INVALID_REQUEST', error: `unknown supervisor method: ${request?.method}` };
  }

  async submit(jobId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId || '')) return { ok: false, code: 'INVALID_REQUEST', error: 'invalid job id' };
    const existing = this.entries.get(jobId);
    if (existing && isProcessAlive(existing.lease.pid)) {
      return { ok: true, accepted: true, duplicate: true, lease: existing.lease, ...this.snapshot() };
    }
    const persisted = listSupervisorLeases().find((lease) => lease.attemptId === jobId);
    if (persisted && isProcessAlive(persisted.pid)) {
      this.entries.set(jobId, { lease: persisted, child: null, adopted: true });
      recordAdoptedLease(persisted, this.bootId);
      return { ok: true, accepted: true, duplicate: true, lease: persisted, ...this.snapshot() };
    }
    const job = loadJob(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', error: `job not found: ${jobId}` };
    if (TERMINAL.has(job.status)) return { ok: false, code: 'JOB_TERMINAL', error: `job is already ${job.status}` };

    const logs = workerPaths(jobId);
    const stdout = fs.openSync(logs.stdout, 'a', 0o600);
    const stderr = fs.openSync(logs.stderr, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [this.workerPath, '--job-id', jobId], {
        cwd: job.cwd,
        detached: true,
        stdio: ['ignore', stdout, stderr],
        windowsHide: true,
        env: process.env
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } finally {
      try { fs.closeSync(stdout); } catch {}
      try { fs.closeSync(stderr); } catch {}
    }
    const now = Date.now();
    const lease = {
      jobId,
      attemptId: jobId,
      pid: child.pid,
      ppid: process.pid,
      pgid: child.pid,
      bootId: this.bootId,
      brokerVersion: this.brokerVersion,
      protocolVersion: this.protocolVersion,
      workerPath: this.workerPath,
      origin: job.origin ? { ...job.origin } : null,
      createdAt: now,
      heartbeatAt: now,
      expiresAt: now + this.leaseTtlMs
    };
    saveSupervisorLease(lease);
    updateManagedJob(jobId, (current) => {
      current.executionOwner = 'supervisor';
      current.pid = child.pid;
      current.workerPid = child.pid;
      current.status = 'running';
      current.phase = 'starting';
      current.attemptLease = {
        jobId,
        attemptId: jobId,
        pid: child.pid,
        ppid: process.pid,
        pgid: child.pid,
        bootId: this.bootId,
        origin: job.origin ? { ...job.origin } : null,
        heartbeatAt: now,
        expiresAt: now + this.leaseTtlMs
      };
    });
    const entry = { lease, child, adopted: false };
    this.entries.set(jobId, entry);
    child.once('exit', (code, signal) => this.handleOwnedExit(jobId, code, signal));
    child.once('error', (error) => this.log('worker child error', { jobId, code: error.code, error: error.message }));
    child.unref();
    this.lastWorkAt = now;
    this.persist();
    this.log('attempt accepted', { jobId, pid: child.pid, pgid: child.pid });
    return { ok: true, accepted: true, lease, ...this.snapshot() };
  }

  handleOwnedExit(attemptId, code, signal) {
    const entry = this.entries.get(attemptId);
    if (!entry) return;
    const current = loadJob(entry.lease.jobId);
    let values;
    if (signal) {
      values = {
        outcome: 'signaled',
        exitCode: null,
        signal,
        supervisorBootId: this.bootId,
        providerProcessAttachable: false,
        reason: `SUPERVISOR_WORKER_SIGNAL: worker pid ${entry.lease.pid} exited from signal ${signal}`,
        errorCode: 'PROVIDER_ERROR',
        stoppedReason: 'worker-signaled'
      };
    } else if (Number.isInteger(code) && code !== 0) {
      values = {
        outcome: 'exited-nonzero',
        exitCode: code,
        supervisorBootId: this.bootId,
        providerProcessAttachable: false,
        reason: `SUPERVISOR_WORKER_EXIT: worker pid ${entry.lease.pid} exited with code ${code}`,
        errorCode: 'PROVIDER_ERROR',
        stoppedReason: 'worker-exit'
      };
    } else if (!current || !TERMINAL.has(current.status)) {
      values = {
        outcome: 'exited-without-terminal-record',
        exitCode: Number.isInteger(code) ? code : null,
        supervisorBootId: this.bootId,
        providerProcessAttachable: false,
        reason: `SUPERVISOR_WORKER_EXIT: worker pid ${entry.lease.pid} exited without a terminal store transition`,
        errorCode: 'STATE_ERROR',
        stoppedReason: 'worker-exit-without-record'
      };
    } else {
      values = {
        outcome: 'exited',
        exitCode: Number.isInteger(code) ? code : null,
        supervisorBootId: this.bootId,
        providerProcessAttachable: false
      };
    }
    entry.lease = heartbeatSupervisorLease(entry.lease, { now: Date.now(), ttlMs: this.leaseTtlMs });
    const finalized = finalizeLease(entry.lease, values);
    if (finalized.finalized) this.entries.delete(attemptId);
    this.persist();
    this.log('attempt process exited', { jobId: entry.lease.jobId, pid: entry.lease.pid, code, signal, finalized: finalized.finalized });
    if (this.draining && this.entries.size === 0) setImmediate(() => this.shutdown(this.drainReason || 'drained'));
  }

  heartbeat() {
    for (const [attemptId, entry] of this.entries) {
      if (entry.adopted) {
        const classification = classifyLeaseProcess(entry.lease, { ...(this.probe ? { probe: this.probe } : {}) });
        if (classification.outcome !== 'alive') {
          const unknown = classification.outcome === 'ambiguous';
          const finalized = finalizeLease(entry.lease, {
            outcome: unknown ? 'unknown-after-adoption' : 'gone-after-adoption',
            supervisorBootId: this.bootId,
            providerProcessAttachable: false,
            reason: unknown
              ? `SUPERVISOR_PROCESS_UNKNOWN: adopted worker pid ${entry.lease.pid} no longer matched its lease identity`
              : `SUPERVISOR_PROCESS_GONE: adopted worker pid ${entry.lease.pid} exited; exit status is unavailable after adoption`,
            errorCode: unknown ? 'STATE_ERROR' : 'ORPHANED',
            stoppedReason: unknown ? 'adopted-process-unknown' : 'adopted-process-gone'
          });
          if (finalized.finalized) this.entries.delete(attemptId);
          continue;
        }
      } else if (!isProcessAlive(entry.lease.pid)) {
        // The child exit event normally supplies code/signal. Leave one tick
        // for it to run before treating an impossible missing callback as
        // unknown.
        continue;
      }
      entry.lease = heartbeatSupervisorLease(entry.lease, { now: Date.now(), ttlMs: this.leaseTtlMs });
    }
    try { this.persist(); } catch {}
    if (this.draining && this.entries.size === 0) setImmediate(() => this.shutdown(this.drainReason || 'drained'));
  }

  requestDrain(reason = 'control-request') {
    if (this.draining) return;
    this.draining = true;
    this.drainReason = reason;
    try { this.persist('draining'); } catch {}
    this.log('drain requested', { reason, liveLeases: this.entries.size });
    if (this.entries.size === 0) setImmediate(() => this.shutdown(reason));
  }

  checkIdle() {
    if (this.draining || this.entries.size > 0) return;
    if (Date.now() - this.lastWorkAt >= this.idleMs) this.requestDrain('idle');
  }

  async shutdown(reason = 'shutdown') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.idleTimer);
    this.removeSignalHandlers();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
    try { fs.unlinkSync(this.locations.socket); } catch {}
    try {
      const lock = readPrivateJson(this.locations.lock);
      if (lock?.bootId === this.bootId && Number(lock.pid) === process.pid) fs.unlinkSync(this.locations.lock);
    } catch {}
    try { this.persist('stopped'); } catch {}
    this.log('supervisor stopped', { reason });
    if (this.exitOnShutdown) process.exit(0);
  }
}
