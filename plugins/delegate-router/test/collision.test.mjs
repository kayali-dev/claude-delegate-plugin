import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  createManagedJob,
  readJobEvents,
  recordCollisionWatchDegradation,
  updateManagedJob
} from '../bin/lib/control.mjs';
import {
  buildCollisionWatchPlan,
  COLLISION_WATCH_PATH_CAP
} from '../bin/lib/collision.mjs';
import { NotificationPolicy } from '../bin/lib/monitor-policy.mjs';
import {
  DelegateMonitor,
  scopeMonitorSnapshots
} from '../bin/lib/monitor-runtime.mjs';
import { MonitorStore } from '../bin/lib/monitor-store.mjs';
import { loadJob } from '../bin/lib/state.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const collisionHook = path.join(pluginRoot, 'bin', 'delegate-collision-hook');
const sessionHook = path.join(pluginRoot, 'bin', 'delegate-session-hook');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function origin(workspace, sessionId) {
  return {
    projectDir: workspace,
    cwd: workspace,
    sessionId,
    workspaceId: workspace,
    brokerVersion: 'test',
    launchedAtMs: Date.now()
  };
}

function runHook(hook, payload, env) {
  return spawnSync(process.execPath, [hook], {
    encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env
  });
}

test('live collision hook emits one scoped edge, cools duplicate touches, and stales acceptance evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-collision-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const previousStateFile = process.env.DELEGATE_STATE_FILE;
  t.after(() => {
    if (previousStateFile == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousStateFile;
  });
  process.env.DELEGATE_STATE_FILE = path.join(root, 'usage.json');
  const workspace = path.join(root, 'workspace');
  const owned = path.join(workspace, 'src', 'owned.txt');
  write(owned, 'before\n');
  const sessionId = 'session-collision-owner';
  const job = createManagedJob({
    provider: 'codex',
    mode: 'implement',
    cwd: workspace,
    prompt: 'edit the owned fixture',
    allowedPaths: ['src/owned.txt'],
    origin: origin(workspace, sessionId),
    verify: { command: 'node --version', timeoutSeconds: 60 }
  });
  updateManagedJob(job.id, (current) => {
    current.status = 'running';
    current.phase = 'running';
    current.verification = {
      state: 'passed',
      exitCode: 0,
      inputChanged: false,
      input: { repoRoot: workspace, digest: 'before' },
      completedInput: { repoRoot: workspace, digest: 'before' }
    };
    current.acceptance = {
      state: 'ready-for-review',
      blockedBy: [],
      evidence: {
        verification: current.verification,
        base: { drifted: false, driftPaths: [] }
      }
    };
  }, { incrementRevision: false });
  write(owned, 'attempt-owned version\n');
  appendJobEvent(job.id, 'file.changed', { path: 'src/owned.txt', phase: 'completed' });
  updateManagedJob(job.id, (current) => {
    current.collisionOwnWrites[0].observedAtMs = Date.now() - 3_000;
  }, { incrementRevision: false });

  const commonEnv = {
    ...process.env,
    DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE,
    DELEGATE_MONITOR_SCOPE: 'session',
    CLAUDE_PROJECT_DIR: workspace,
    CLAUDE_CODE_SESSION_ID: sessionId
  };
  const signal = path.join(root, 'collision-watch.signal');
  const session = runHook(sessionHook, {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd: workspace
  }, commonEnv);
  assert.equal(session.status, 0, session.stderr);
  const sessionOutput = JSON.parse(session.stdout);
  assert.deepEqual(sessionOutput.hookSpecificOutput.watchPaths, [signal, owned]);

  const output = [];
  const store = new MonitorStore({
    jobsDirectory: path.join(root, 'jobs'),
    stateDirectory: root
  });
  const monitor = new DelegateMonitor({
    env: commonEnv,
    scope: 'session',
    sessionId,
    projectDir: workspace,
    workspaceId: workspace,
    store,
    emit: (line) => output.push(line),
    debounceMs: 10_000,
    pollMs: 60_000
  });
  monitor.start();
  t.after(() => monitor.stop());

  write(owned, 'coordinator collision\n');
  const first = runHook(collisionHook, {
    hook_event_name: 'FileChanged',
    session_id: sessionId,
    cwd: workspace,
    file_path: owned,
    event: 'change'
  }, commonEnv);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).hookSpecificOutput.watchPaths, [signal, owned]);
  monitor.scan();
  assert.equal(output.length, 1);
  assert.match(output[0], new RegExp(`^delegate\\[workspace\\]: ${job.id} collision detected \\(src/owned\\.txt; base-drift recorded, checks stale\\)$`));

  const stale = loadJob(job.id);
  assert.equal(stale.verification.state, 'stale');
  assert.equal(stale.verification.stateBeforeStale, 'passed');
  assert.equal(stale.verification.inputChanged, true);
  assert.deepEqual(stale.verification.stalePaths, ['src/owned.txt']);
  assert.equal(stale.baseDrift, true);
  assert.deepEqual(stale.baseDriftPaths, ['src/owned.txt']);
  assert.equal(stale.acceptance.state, 'blocked');
  assert.ok(stale.acceptance.blockedBy.includes('base-drift'));
  assert.equal(stale.acceptance.evidence.verification.state, 'stale');

  write(owned, 'second touch inside cooldown\n');
  const second = runHook(collisionHook, {
    hook_event_name: 'FileChanged',
    session_id: sessionId,
    cwd: workspace,
    file_path: owned,
    event: 'change'
  }, commonEnv);
  assert.equal(second.status, 0, second.stderr);
  monitor.scan();
  assert.equal(output.length, 1);
  assert.equal(loadJob(job.id).collisions.length, 1);
  assert.equal(readJobEvents(job.id, { types: ['collision.detected'] }).length, 1);
});

test('attempt writes self-suppress while a later coordinator Edit on the same path collides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-collision-self-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const previousStateFile = process.env.DELEGATE_STATE_FILE;
  t.after(() => {
    if (previousStateFile == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousStateFile;
  });
  process.env.DELEGATE_STATE_FILE = path.join(root, 'usage.json');
  const workspace = path.join(root, 'workspace');
  const owned = path.join(workspace, 'owned.txt');
  write(owned, 'attempt write\n');
  const job = createManagedJob({
    provider: 'cursor',
    model: 'composer',
    mode: 'implement',
    cwd: workspace,
    prompt: 'edit the owned fixture',
    allowedPaths: ['owned.txt'],
    origin: origin(workspace, 'session-owner')
  });
  updateManagedJob(job.id, (current) => {
    current.status = 'running';
    current.phase = 'running';
    current.verification = {
      state: 'passed',
      exitCode: 0,
      inputChanged: false,
      input: { repoRoot: workspace, digest: 'before' },
      completedInput: { repoRoot: workspace, digest: 'before' }
    };
    current.acceptance = {
      state: 'ready-for-review',
      blockedBy: [],
      evidence: {
        verification: current.verification,
        base: { drifted: false, driftPaths: [] }
      }
    };
  }, { incrementRevision: false });
  const commonEnv = {
    ...process.env,
    DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE,
    CLAUDE_PROJECT_DIR: workspace
  };
  const unattributedWatcherEvent = runHook(collisionHook, {
    hook_event_name: 'FileChanged',
    session_id: 'session-owner',
    cwd: workspace,
    file_path: owned,
    event: 'change'
  }, commonEnv);
  assert.equal(unattributedWatcherEvent.status, 0, unattributedWatcherEvent.stderr);
  assert.equal(loadJob(job.id).collisions, undefined);

  appendJobEvent(job.id, 'file.changed', { path: 'owned.txt', phase: 'completed' });
  const ownWrite = runHook(collisionHook, {
    hook_event_name: 'FileChanged',
    session_id: 'session-owner',
    cwd: workspace,
    file_path: owned,
    event: 'change'
  }, commonEnv);
  assert.equal(ownWrite.status, 0, ownWrite.stderr);
  assert.equal(loadJob(job.id).collisions, undefined);

  const coordinator = runHook(collisionHook, {
    hook_event_name: 'PostToolUse',
    session_id: 'session-owner',
    cwd: workspace,
    tool_name: 'Edit',
    tool_input: { file_path: owned },
    tool_response: { filePath: owned, success: true }
  }, commonEnv);
  assert.equal(coordinator.status, 0, coordinator.stderr);
  const collided = loadJob(job.id);
  assert.deepEqual(collided.collisions.map((entry) => entry.path), ['owned.txt']);
  assert.equal(collided.verification.state, 'stale');
  assert.equal(collided.verification.inputChanged, true);
  assert.equal(collided.acceptance.state, 'blocked');
});

test('PostToolBatch deduplicates repeated Write observations and collision alerts retain session scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-collision-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const previousStateFile = process.env.DELEGATE_STATE_FILE;
  t.after(() => {
    if (previousStateFile == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousStateFile;
  });
  process.env.DELEGATE_STATE_FILE = path.join(root, 'usage.json');
  const workspace = path.join(root, 'workspace');
  const owned = path.join(workspace, 'owned.txt');
  write(owned, 'batch\n');
  const job = createManagedJob({
    provider: 'codex',
    mode: 'implement',
    cwd: workspace,
    prompt: 'edit',
    allowedPaths: ['owned.txt'],
    origin: origin(workspace, 'session-a')
  });
  updateManagedJob(job.id, (current) => {
    current.status = 'running';
    current.phase = 'running';
    current.verification = {
      state: 'passed',
      exitCode: 0,
      inputChanged: false,
      input: { repoRoot: workspace, digest: 'before' },
      completedInput: { repoRoot: workspace, digest: 'before' }
    };
    current.acceptance = {
      state: 'ready-for-review',
      blockedBy: [],
      evidence: {
        verification: current.verification,
        base: { drifted: false, driftPaths: [] }
      }
    };
  }, { incrementRevision: false });
  const result = runHook(collisionHook, {
    hook_event_name: 'PostToolBatch',
    session_id: 'session-b',
    cwd: workspace,
    tool_calls: [
      { tool_name: 'Write', tool_input: { file_path: owned }, tool_response: 'written' },
      { tool_name: 'Write', tool_input: { file_path: owned }, tool_response: 'written again' },
      { tool_name: 'Read', tool_input: { file_path: owned }, tool_response: 'ignored' }
    ]
  }, { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE });
  assert.equal(result.status, 0, result.stderr);
  const collided = loadJob(job.id);
  assert.equal(collided.collisions.length, 1);
  assert.equal(collided.verification.state, 'stale');
  assert.equal(collided.verification.inputChanged, true);
  assert.equal(collided.acceptance.state, 'blocked');
  assert.deepEqual(collided.baseDriftPaths, ['owned.txt']);

  const snapshots = [{
    job: collided,
    events: readJobEvents(job.id),
    lastEventAt: Date.now()
  }];
  assert.equal(scopeMonitorSnapshots(snapshots, {
    scope: 'session',
    sessionId: 'session-b',
    workspaceId: workspace
  }).length, 0);
  const ownedSnapshots = scopeMonitorSnapshots(snapshots, {
    scope: 'session',
    sessionId: 'session-a',
    workspaceId: workspace
  });
  assert.equal(ownedSnapshots.length, 1);
  const policy = new NotificationPolicy({ cooldownMs: 30_000, maxLinesPerMinute: 20 });
  const lines = policy.bootstrap(ownedSnapshots, { now: Date.now() });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /existing job needs attention \(1 collision;/);
});

test('watch plans cap at 256 paths and record explicit post-hoc degradation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-collision-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const previousStateFile = process.env.DELEGATE_STATE_FILE;
  t.after(() => {
    if (previousStateFile == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousStateFile;
  });
  process.env.DELEGATE_STATE_FILE = path.join(root, 'usage.json');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const allowedPaths = Array.from({ length: COLLISION_WATCH_PATH_CAP + 2 }, (_, index) => `owned-${String(index).padStart(3, '0')}.txt`);
  const job = createManagedJob({
    provider: 'codex',
    mode: 'implement',
    cwd: workspace,
    prompt: 'edit many bounded paths',
    allowedPaths,
    origin: origin(workspace, 'session-cap')
  });
  updateManagedJob(job.id, (current) => {
    current.status = 'running';
    current.phase = 'running';
  }, { incrementRevision: false });
  const plan = buildCollisionWatchPlan({
    jobs: [loadJob(job.id)],
    scope: 'session',
    sessionId: 'session-cap',
    workspaceId: workspace
  });
  assert.equal(plan.watchPaths.length, COLLISION_WATCH_PATH_CAP);
  assert.equal(plan.totalPathCount, COLLISION_WATCH_PATH_CAP + 3);
  assert.equal(plan.watchedOwnedPathCount, COLLISION_WATCH_PATH_CAP - 1);
  assert.equal(plan.degraded, true);
  assert.equal(plan.reason, 'watch-path-cap-exceeded');
  assert.deepEqual(plan.omittedJobIds, [job.id]);

  assert.equal(recordCollisionWatchDegradation(plan.omittedJobIds, {
    reason: plan.reason,
    cap: plan.cap,
    totalPathCount: plan.totalPathCount,
    watchedPathCount: plan.watchedPathCount
  }), 1);
  const degraded = loadJob(job.id);
  assert.equal(degraded.collisionWatch.status, 'degraded');
  assert.equal(degraded.collisionWatch.reason, 'watch-path-cap-exceeded');
  assert.equal(degraded.collisionWatch.fallback, 'post-hoc-detection');
  assert.equal(degraded.collisionWatch.cap, COLLISION_WATCH_PATH_CAP);
  assert.equal(readJobEvents(job.id, { types: ['collision.watch.degraded'] }).length, 1);

  const signal = path.join(root, 'collision-watch.signal');
  fs.rmSync(signal, { force: true });
  fs.symlinkSync(path.join(root, 'missing-signal-parent', 'signal'), signal);
  const unavailable = runHook(sessionHook, {
    hook_event_name: 'SessionStart',
    session_id: 'session-cap',
    cwd: workspace
  }, {
    ...process.env,
    DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE,
    DELEGATE_MONITOR_SCOPE: 'session',
    CLAUDE_PROJECT_DIR: workspace,
    CLAUDE_CODE_SESSION_ID: 'session-cap'
  });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  const degradationEvents = readJobEvents(job.id, { types: ['collision.watch.degraded'] });
  assert.ok(degradationEvents.some((event) => event.data?.reason === 'watch-refresh-signal-unavailable'));
  assert.ok(degradationEvents.every((event) => event.data?.fallback === 'post-hoc-detection'));
});

test('collision hooks are additive, fast-fail open, and exit zero on malformed payloads', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.ok(hooks.FileChanged);
  assert.ok(hooks.PostCompact);
  assert.ok(hooks.PostToolBatch);
  assert.ok(hooks.PostToolUse.some((group) => group.matcher === '^(Edit|Write)$'));
  const malformedCollision = runHook(collisionHook, '{', { ...process.env });
  const malformedSession = runHook(sessionHook, '{', { ...process.env });
  assert.equal(malformedCollision.status, 0);
  assert.equal(malformedSession.status, 0);
  assert.equal(malformedCollision.stdout, '');
  assert.equal(malformedSession.stdout, '');
});
