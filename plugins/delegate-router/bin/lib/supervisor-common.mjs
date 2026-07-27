import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir } from './state.mjs';
import { isProcessAlive } from './process.mjs';

export const SUPERVISOR_PROTOCOL_VERSION = 1;

const packageFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

export function supervisorBrokerVersion() {
  try { return JSON.parse(fs.readFileSync(packageFile, 'utf8')).version; }
  catch { return 'unknown'; }
}

export function supervisorPaths() {
  const state = dataDir();
  const root = path.join(state, 'supervisor');
  return {
    state,
    root,
    lock: path.join(root, 'supervisor.lock'),
    startupLock: path.join(root, 'startup.lock'),
    leases: path.join(root, 'leases'),
    runtimeState: path.join(root, 'state.json'),
    stdout: path.join(root, 'supervisor.log'),
    stderr: path.join(root, 'supervisor.err.log'),
    socket: path.join(state, 'supervisor.sock')
  };
}

export function ensureSupervisorDirectories() {
  const locations = supervisorPaths();
  fs.mkdirSync(locations.state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(locations.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(locations.leases, { recursive: true, mode: 0o700 });
  for (const directory of [locations.state, locations.root, locations.leases]) {
    try { fs.chmodSync(directory, 0o700); } catch {}
  }
  return locations;
}

export function atomicWritePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch {}
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function readPrivateJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function safeAttemptId(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value || '')) throw new Error(`invalid attempt id: ${value}`);
  return value;
}

export function leasePath(attemptId) {
  return path.join(supervisorPaths().leases, `${safeAttemptId(attemptId)}.json`);
}

export function saveSupervisorLease(lease) {
  atomicWritePrivateJson(leasePath(lease.attemptId), lease);
  return lease;
}

export function loadSupervisorLease(attemptId) {
  return readPrivateJson(leasePath(attemptId));
}

export function removeSupervisorLease(attemptId) {
  try { fs.unlinkSync(leasePath(attemptId)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function listSupervisorLeases() {
  const directory = supervisorPaths().leases;
  try {
    return fs.readdirSync(directory)
      .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
      .map((name) => readPrivateJson(path.join(directory, name)))
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function heartbeatSupervisorLease(lease, options = {}) {
  const now = Number(options.now ?? Date.now());
  const ttlMs = Number(options.ttlMs ?? 15000);
  const next = {
    ...lease,
    heartbeatAt: now,
    expiresAt: now + Math.max(100, ttlMs)
  };
  saveSupervisorLease(next);
  return next;
}

export function processInfo(pid) {
  if (!isProcessAlive(pid)) return { state: 'gone', info: null };
  try {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status !== 0 || !result.stdout?.trim()) {
      return isProcessAlive(pid) ? { state: 'ambiguous', info: null } : { state: 'gone', info: null };
    }
    const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) return { state: 'ambiguous', info: null };
    return {
      state: 'alive',
      info: {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4]
      }
    };
  } catch {
    return isProcessAlive(pid) ? { state: 'ambiguous', info: null } : { state: 'gone', info: null };
  }
}

function commandHasPair(command, flag, value) {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escapedFlag}(?:=|\\s+)${escapedValue}(?:\\s|$)`).test(command);
}

export function matchesSupervisorIdentity(info, lock) {
  if (!info || Number(info.pid) !== Number(lock?.pid)) return false;
  const command = String(info.command || '');
  return command.includes('delegate-supervisor')
    && /(?:^|\s)--serve(?:\s|$)/.test(command)
    && commandHasPair(command, '--boot-id', lock.bootId);
}

export function matchesWorkerIdentity(info, lease) {
  if (!info || Number(info.pid) !== Number(lease?.pid)) return false;
  const command = String(info.command || '');
  const expectedPath = lease.workerPath ? path.basename(lease.workerPath) : 'delegate-worker';
  return command.includes(expectedPath)
    && commandHasPair(command, '--job-id', lease.jobId);
}

export function classifySupervisorLock(lock, options = {}) {
  if (!lock?.pid || !lock?.bootId) return { state: 'invalid', action: 'leave-alone', identityVerified: false };
  const probe = options.probe || processInfo;
  const observed = probe(lock.pid);
  if (observed.state === 'gone') {
    return { state: 'process-gone', action: 'reclaim-files-only', identityVerified: false };
  }
  if (observed.state !== 'alive' || !matchesSupervisorIdentity(observed.info, lock)) {
    return { state: 'alive-unknown', action: 'leave-alone', identityVerified: false, info: observed.info || null };
  }
  const liveLeases = Number(options.liveLeases ?? listSupervisorLeases().length);
  return {
    state: 'alive-supervisor',
    action: liveLeases === 0 ? 'request-clean-stop' : 'leave-live-leases',
    identityVerified: true,
    liveLeases,
    info: observed.info
  };
}

export function classifyLeaseProcess(lease, options = {}) {
  const probe = options.probe || processInfo;
  const observed = probe(lease.pid);
  if (observed.state === 'gone') return { outcome: 'dead', attachable: false, info: null };
  if (observed.state !== 'alive' || !matchesWorkerIdentity(observed.info, lease)) {
    return { outcome: 'ambiguous', attachable: false, info: observed.info || null };
  }
  return { outcome: 'alive', attachable: true, info: observed.info };
}

export function versionSkewDecision(status, expected = {}) {
  const protocolVersion = expected.protocolVersion ?? SUPERVISOR_PROTOCOL_VERSION;
  const brokerVersion = expected.brokerVersion ?? supervisorBrokerVersion();
  if (Number(status?.protocolVersion) === Number(protocolVersion) && status?.brokerVersion === brokerVersion) {
    return 'compatible';
  }
  return Number(status?.liveLeases || 0) === 0 ? 'drain-restart' : 'fallback-live-leases';
}
