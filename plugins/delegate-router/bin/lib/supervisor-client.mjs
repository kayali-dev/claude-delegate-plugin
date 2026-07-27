import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from './process.mjs';
import { loadSupervisorLease } from './supervisor-common.mjs';

const supervisorExecutable = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'delegate-supervisor');

function invokeSupervisor(args) {
  if (process.env.DELEGATE_SUPERVISOR === '0') {
    return { ok: false, code: 'SUPERVISOR_DISABLED', reason: 'disabled' };
  }
  try {
    const timeout = Number(process.env.DELEGATE_SUPERVISOR_START_TIMEOUT_MS ?? 7000);
    const result = spawnSync(process.execPath, [supervisorExecutable, ...args, '--json'], {
      encoding: 'utf8',
      env: process.env,
      timeout: Number.isFinite(timeout) && timeout >= 250 ? timeout : 7000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const line = String(result.stdout || '').trim().split('\n').filter(Boolean).at(-1);
    let payload = null;
    try { payload = line ? JSON.parse(line) : null; } catch {}
    if (result.status === 0 && payload) return { ok: true, ...payload };
    return {
      ok: false,
      code: payload?.code || result.error?.code || 'SUPERVISOR_UNAVAILABLE',
      reason: payload?.reason || payload?.error || String(result.stderr || '').trim() || 'supervisor command failed',
      ...(payload || {})
    };
  } catch (error) {
    return { ok: false, code: error.code || 'SUPERVISOR_UNAVAILABLE', reason: error.message };
  }
}

export function ensureSupervisorReady() {
  return invokeSupervisor(['start']);
}

export function submitJobToSupervisor(jobId) {
  const result = invokeSupervisor(['submit', jobId]);
  if (result.ok && result.accepted === true) return result;

  // A response can be lost after the resident has durably accepted the job.
  // A live, pid-bearing lease is the idempotent acknowledgement in that case;
  // falling back would launch a competing worker for the same attempt.
  try {
    const lease = loadSupervisorLease(jobId);
    if (lease?.jobId === jobId && Number.isInteger(lease.pid) && isProcessAlive(lease.pid)) {
      return { ok: true, accepted: true, recoveredFromLease: true, lease };
    }
  } catch {}
  return result;
}
