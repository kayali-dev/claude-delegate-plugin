import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createManagedJob,
  inspectJob,
  launchManagedJob,
  readJobEvents,
  updateManagedJob
} from '../bin/lib/control.mjs';
import {
  supervisorBrokerVersion,
  classifySupervisorLock,
  heartbeatSupervisorLease,
  loadSupervisorLease,
  processInfo,
  removeSupervisorLease,
  saveSupervisorLease,
  supervisorPaths,
  versionSkewDecision
} from '../bin/lib/supervisor-common.mjs';
import { reconcileSupervisorLeases } from '../bin/lib/supervisor-runtime.mjs';
import { auditLogPath, loadJob } from '../bin/lib/state.mjs';
import { waitForChildExit, waitForCondition } from './helpers/wait.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const supervisor = path.join(pluginRoot, 'bin', 'delegate-supervisor');
const workerFixture = path.join(pluginRoot, 'test', 'fixtures', 'supervisor-worker.mjs');
const launcherFixture = path.join(pluginRoot, 'test', 'fixtures', 'supervisor-launcher.mjs');

function runCli(args, env) {
  const child = spawn(process.execPath, [supervisor, ...args, '--json'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return waitForChildExit({
    child,
    description: `delegate-supervisor ${args[0] || 'command'} to exit`
  }).then(({ status, signal }) => {
    let payload = null;
    try { payload = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)); } catch {}
    return { status, signal, stdout, stderr, payload };
  });
}

function runCliSync(args, env) {
  const result = spawnSync(process.execPath, [supervisor, ...args, '--json'], {
    env,
    encoding: 'utf8',
    timeout: 5000
  });
  let payload = null;
  try { payload = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch {}
  return { ...result, payload };
}

function waitFor(check, description, timeoutMs = 5_000) {
  return waitForCondition({ description, timeoutMs, intervalMs: 25, observe: check });
}

async function stopResident(env) {
  const status = runCliSync(['status'], env).payload;
  if (status?.ok) runCliSync(['drain'], env);
  await waitFor(() => {
    const lock = supervisorPaths().lock;
    return !fs.existsSync(lock);
  }, 'the supervisor startup lock to disappear', 3_000).catch(() => null);
}

async function isolated(t, fn, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-supervisor-test-'));
  const stateFile = path.join(root, 'state', 'usage.json');
  const keys = [
    'DELEGATE_STATE_FILE', 'DELEGATE_SUPERVISOR', 'DELEGATE_SUPERVISOR_IDLE_MS',
    'DELEGATE_SUPERVISOR_HEARTBEAT_MS', 'DELEGATE_SUPERVISOR_LEASE_TTL_MS',
    'DELEGATE_SUPERVISOR_WORKER_BIN', 'DELEGATE_SUPERVISOR_TEST_WORKER_MODE',
    'DELEGATE_SUPERVISOR_TEST_WORKER_DELAY_MS', 'DELEGATE_SUPERVISOR_LAUNCHER_HOLD_MS',
    'DELEGATE_CODEX_BIN'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const env = {
    ...process.env,
    DELEGATE_STATE_FILE: stateFile,
    DELEGATE_SUPERVISOR_IDLE_MS: '60000',
    DELEGATE_SUPERVISOR_HEARTBEAT_MS: '50',
    DELEGATE_SUPERVISOR_LEASE_TTL_MS: '500',
    DELEGATE_SUPERVISOR_WORKER_BIN: workerFixture,
    ...overrides
  };
  Object.assign(process.env, env);
  try { return await fn({ root, stateFile, env }); }
  finally {
    await stopResident(env);
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    // stopResident asks the supervisor to drain, but the process can still be
    // flushing its lock/socket/log files when rmSync walks the directory —
    // observed twice as ENOTEMPTY. Retry briefly rather than failing teardown,
    // which would report a passing suite as a verification failure.
    await removeDirectoryWithRetry(root);
  }
}

async function removeDirectoryWithRetry(directory, attempts = 20, delayMs = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code) || attempt === attempts - 1) {
        if (attempt === attempts - 1) return; // teardown must never fail the suite
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

test('concurrent lazy starts converge on one resident instance', (t) => isolated(t, async ({ env }) => {
  const [left, right] = await Promise.all([runCli(['start'], env), runCli(['start'], env)]);
  assert.equal(left.status, 0, left.stderr);
  assert.equal(right.status, 0, right.stderr);
  assert.equal(left.payload.pid, right.payload.pid);
  assert.equal(left.payload.bootId, right.payload.bootId);
  assert.notEqual(left.payload.reused, right.payload.reused);
  assert.equal(fs.statSync(supervisorPaths().socket).mode & 0o777, 0o600);
  const lock = JSON.parse(fs.readFileSync(supervisorPaths().lock, 'utf8'));
  assert.deepEqual(Object.keys(lock).sort(), ['bootId', 'brokerVersion', 'pid', 'protocolVersion', 'startedAt']);
}));

test('stale-lock policy signals only a positively identified supervisor and never an unknown PID', () => {
  const lock = { pid: 42, bootId: 'boot-test' };
  const matched = classifySupervisorLock(lock, {
    liveLeases: 0,
    probe: () => ({ state: 'alive', info: { pid: 42, ppid: 1, pgid: 42, command: 'node /plugin/bin/delegate-supervisor --serve --boot-id boot-test' } })
  });
  assert.equal(matched.identityVerified, true);
  assert.equal(matched.action, 'request-clean-stop');
  const leased = classifySupervisorLock(lock, {
    liveLeases: 1,
    probe: () => ({ state: 'alive', info: { pid: 42, ppid: 1, pgid: 42, command: 'node /plugin/bin/delegate-supervisor --serve --boot-id boot-test' } })
  });
  assert.equal(leased.action, 'leave-live-leases');
  const unknown = classifySupervisorLock(lock, {
    liveLeases: 0,
    probe: () => ({ state: 'alive', info: { pid: 42, ppid: 1, pgid: 42, command: '/usr/bin/unrelated' } })
  });
  assert.equal(unknown.identityVerified, false);
  assert.equal(unknown.action, 'leave-alone');
  const gone = classifySupervisorLock(lock, { probe: () => ({ state: 'gone', info: null }) });
  assert.equal(gone.action, 'reclaim-files-only');
});

test('lease heartbeat advances heartbeat and expiry durably', (t) => isolated(t, async () => {
  const lease = {
    jobId: 'codex-heartbeat',
    attemptId: 'codex-heartbeat',
    pid: 123,
    ppid: 1,
    pgid: 123,
    bootId: 'boot',
    heartbeatAt: 100,
    expiresAt: 200
  };
  saveSupervisorLease(lease);
  const updated = heartbeatSupervisorLease(lease, { now: 1000, ttlMs: 500 });
  assert.equal(updated.heartbeatAt, 1000);
  assert.equal(updated.expiresAt, 1500);
  assert.deepEqual(loadSupervisorLease(lease.attemptId), updated);
  removeSupervisorLease(lease.attemptId);
}));

test('boot reconciliation adopts owned live leases and records dead and ambiguous outcomes distinctly', (t) => isolated(t, async ({ root }) => {
  const make = (name, pid) => {
    const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: `inspect ${name}`, reportLint: false });
    updateManagedJob(job.id, (current) => {
      current.status = 'running';
      current.phase = 'working';
      current.executionOwner = 'supervisor';
      current.pid = pid;
      current.workerPid = pid;
    });
    saveSupervisorLease({
      jobId: job.id,
      attemptId: job.id,
      pid,
      ppid: 1,
      pgid: pid,
      bootId: 'old-boot',
      workerPath: '/old/plugin/bin/delegate-worker',
      heartbeatAt: 100,
      expiresAt: 200
    });
    return job.id;
  };
  const alive = make('alive', 101);
  const dead = make('dead', 102);
  const ambiguous = make('ambiguous', 103);
  const outcomes = reconcileSupervisorLeases({
    bootId: 'new-boot',
    probe: (pid) => {
      if (pid === 102) return { state: 'gone', info: null };
      return {
        state: 'alive',
        info: {
          pid,
          ppid: 1,
          pgid: pid,
          command: pid === 101
            ? `node /old/plugin/bin/delegate-worker --job-id ${alive}`
            : '/usr/bin/unrelated'
        }
      };
    }
  });
  assert.deepEqual(outcomes.map((item) => item.outcome).sort(), ['adopted', 'dead', 'unknown']);
  assert.equal(loadJob(alive).status, 'running');
  assert.equal(loadJob(alive).attemptLease.adoptedByBootId, 'new-boot');
  assert.equal(loadJob(dead).status, 'failed');
  assert.equal(loadJob(dead).failureAttribution.outcome, 'dead-on-boot');
  assert.match(loadJob(dead).error, /exit status is unavailable/);
  assert.equal(loadJob(ambiguous).status, 'failed');
  assert.equal(loadJob(ambiguous).failureAttribution.outcome, 'unknown-on-boot');
  assert.match(loadJob(ambiguous).error, /could not be positively identified/);
  removeSupervisorLease(alive);
}));

test('a pre-existing inline job with no lease is untouched by supervisor boot and reconciliation', (t) => isolated(t, async ({ root, env }) => {
  const legacy = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'already running inline', reportLint: false });
  updateManagedJob(legacy.id, (job) => {
    job.status = 'running';
    job.phase = 'working';
    job.executionOwner = 'inline-detached';
    job.pid = process.pid;
    job.workerPid = process.pid;
  });
  const before = loadJob(legacy.id);
  assert.deepEqual(reconcileSupervisorLeases({ bootId: 'boot-no-leases', probe: () => { throw new Error('must not scan processes'); } }), []);
  assert.deepEqual(loadJob(legacy.id), before);
  const started = await runCli(['start'], env);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(loadJob(legacy.id), before);
}));

test('version skew drains only without leases and falls back while old leases remain', () => {
  // Must track the live broker version: pinning a literal here silently turns
  // every release into an apparent skew (v0.23.2 lesson: no version literals).
  assert.equal(versionSkewDecision({ protocolVersion: 1, brokerVersion: supervisorBrokerVersion(), liveLeases: 2 }), 'compatible');
  assert.equal(versionSkewDecision({ protocolVersion: 0, brokerVersion: '0.28.0', liveLeases: 0 }), 'drain-restart');
  assert.equal(versionSkewDecision({ protocolVersion: 0, brokerVersion: '0.28.0', liveLeases: 1 }), 'fallback-live-leases');
  assert.equal(versionSkewDecision({ protocolVersion: 1, brokerVersion: '0.28.0', liveLeases: 1 }), 'fallback-live-leases');
});

test('supervisor-unavailable launch preserves inline behavior and records only inline ownership', (t) => isolated(t, async ({ root }) => {
  process.env.DELEGATE_SUPERVISOR = '0';
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  const job = launchManagedJob({
    provider: 'codex',
    mode: 'review',
    cwd: root,
    prompt: 'fallback read',
    reportLint: false
  });
  assert.equal(job.executionOwner, 'inline-detached');
  assert.equal(Number.isInteger(job.pid), true);
  assert.equal(Object.hasOwn(job, 'attemptLease'), false);
  assert.equal(Object.hasOwn(job, 'executionAttribution'), false);
  assert.deepEqual(readJobEvents(job.id).map((event) => event.type), ['job.created', 'message.user']);
  assert.equal(fs.existsSync(supervisorPaths().lock), false);
}));

test('SIGTERM drains and persists stopped state, and an idle resident exits on policy', (t) => isolated(t, async ({ env }) => {
  const started = await runCli(['start'], env);
  assert.equal(started.status, 0, started.stderr);
  process.kill(started.payload.pid, 'SIGTERM');
  const stopped = await waitFor(() => {
    try {
      const state = JSON.parse(fs.readFileSync(supervisorPaths().runtimeState, 'utf8'));
      return state.status === 'stopped' ? state : null;
    } catch { return null; }
  }, "supervisor runtime state.status === 'stopped'");
  assert.equal(stopped.drainReason, 'SIGTERM');
  assert.equal(fs.existsSync(supervisorPaths().lock), false);

  const idleEnv = { ...env, DELEGATE_SUPERVISOR_IDLE_MS: '100' };
  Object.assign(process.env, idleEnv);
  const idle = await runCli(['start'], idleEnv);
  assert.equal(idle.status, 0, idle.stderr);
  const idleStopped = await waitFor(() => {
    try {
      const state = JSON.parse(fs.readFileSync(supervisorPaths().runtimeState, 'utf8'));
      return state.status === 'stopped' && state.bootId === idle.payload.bootId ? state : null;
    } catch { return null; }
  }, 'the idle supervisor to publish its stopped state');
  assert.equal(idleStopped.drainReason, 'idle');
}));

test('SIGKILL on an owned worker records precise signal, process, lease, and audit attribution', (t) => isolated(t, async ({ root }) => {
  process.env.DELEGATE_SUPERVISOR_TEST_WORKER_MODE = 'sleep';
  const job = launchManagedJob({
    provider: 'codex',
    mode: 'review',
    cwd: root,
    prompt: 'sleep until killed',
    reportLint: false
  });
  assert.equal(job.executionOwner, 'supervisor');
  assert.equal(job.attemptLease.pid, job.workerPid);
  process.kill(job.workerPid, 'SIGKILL');
  const failed = await waitFor(() => {
    const current = loadJob(job.id);
    return current?.status === 'failed' ? current : null;
  }, "owned worker job.status === 'failed'");
  assert.equal(failed.errorCode, 'PROVIDER_ERROR');
  assert.match(failed.error, /SUPERVISOR_WORKER_SIGNAL.*SIGKILL/);
  assert.equal(failed.failureAttribution.signal, 'SIGKILL');
  assert.equal(failed.failureAttribution.pid, job.workerPid);
  assert.equal(failed.failureAttribution.ppid, job.attemptLease.ppid);
  assert.equal(failed.failureAttribution.pgid, job.attemptLease.pgid);
  assert.equal(failed.failureAttribution.supervisorBootId, job.attemptLease.bootId);
  assert.equal(failed.failureAttribution.providerProcessAttachable, false);
  assert.ok(failed.failureAttribution.lastHeartbeat);
  assert.ok(failed.failureAttribution.leaseExpiresAt);
  const audit = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').map(JSON.parse).find((row) => row.jobId === job.id);
  assert.equal(audit.executionOwner, 'supervisor');
  assert.equal(audit.failureAttribution.signal, 'SIGKILL');
}));

test('killing the launcher shell does not kill a supervisor-owned attempt', (t) => isolated(t, async ({ root, env }) => {
  const launcherEnv = {
    ...env,
    DELEGATE_SUPERVISOR_TEST_WORKER_MODE: 'complete',
    DELEGATE_SUPERVISOR_TEST_WORKER_DELAY_MS: '600',
    DELEGATE_SUPERVISOR_LAUNCHER_HOLD_MS: '10000'
  };
  Object.assign(process.env, launcherEnv);
  const child = spawn(process.execPath, [launcherFixture, root], {
    env: launcherEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let line = '';
  let childError = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { line += chunk; });
  child.once('error', (error) => { childError = error; });
  const launched = await waitForCondition({
    description: 'the supervisor launcher fixture to print its launched job',
    timeoutMs: 5_000,
    observe: () => {
      if (childError) throw childError;
      const newline = line.indexOf('\n');
      if (newline < 0) return null;
      return JSON.parse(line.slice(0, newline));
    },
    summarize: () => `stdout=${JSON.stringify(line.slice(-500))}, exitCode=${child.exitCode ?? 'null'}`
  });
  assert.equal(launched.executionOwner, 'supervisor');
  process.kill(child.pid, 'SIGKILL');
  await waitForChildExit({ child, description: 'the killed supervisor launcher fixture to exit' });
  const terminal = await waitFor(() => {
    const current = loadJob(launched.id);
    return current?.status === 'completed' && current.executionAttribution?.finalized ? current : null;
  }, 'the supervisor-owned job to complete with finalized attribution');
  assert.equal(terminal.resultText, 'supervisor fixture completed');
  assert.equal(terminal.executionAttribution.exitCode, 0);
  assert.equal(terminal.executionAttribution.signal, null);
  const lock = JSON.parse(fs.readFileSync(supervisorPaths().lock, 'utf8'));
  const observed = await waitFor(() => {
    const current = processInfo(lock.pid);
    return current.state === 'alive' && current.info.ppid === 1 ? current : null;
  }, 'the resident supervisor process to be reparented and alive');
  assert.equal(observed.info.pgid, lock.pid);
}));
