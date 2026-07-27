import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cleanupMonitorCorrelation,
  monitorCorrelationDirectory,
  resolveMonitorSession,
  writeSessionCorrelationMarker
} from '../bin/lib/monitor-correlation.mjs';
import {
  detectActionableEdges,
  formatEdgeLine,
  NotificationPolicy
} from '../bin/lib/monitor-policy.mjs';
import {
  DelegateMonitor,
  monitorEnabled,
  monitorScope,
  normalizeMonitorProjectDirectory,
  scopeMonitorSnapshots
} from '../bin/lib/monitor-runtime.mjs';
import { MonitorStore, parseSnoozeUntil, preferenceSnoozed } from '../bin/lib/monitor-store.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = Date.parse('2026-07-26T12:00:00.000Z');

function snapshot(job, events = [], lastEventAt = NOW) {
  return {
    job: {
      provider: 'codex',
      mode: 'implement',
      status: 'running',
      phase: 'running',
      cwd: '/workspace/delegate-router',
      origin: {
        projectDir: '/workspace/delegate-router',
        cwd: '/workspace/delegate-router',
        sessionId: 'session-default',
        workspaceId: '/workspace/delegate-router',
        brokerVersion: '0.29.0',
        launchedAtMs: NOW
      },
      ...job
    },
    events,
    lastEventAt
  };
}

function event(seq, type, data = {}, at = NOW) {
  return { v: 1, seq, at, type, data };
}

test('monitor edge detection covers every actionable class in priority order', () => {
  const cases = [
    [snapshot({ id: 'scope', status: 'completed', scopeViolations: [{ path: 'outside.js' }] }), 'policy-breach:scope'],
    [snapshot({ id: 'budget', status: 'failed', errorCode: 'BUDGET_EXCEEDED', stoppedReason: 'budget' }), 'policy-breach:budget'],
    [snapshot({ id: 'allowance', status: 'failed', errorCode: 'QUOTA_GUARD' }), 'policy-breach:budget'],
    [snapshot({ id: 'input', pendingInput: { requestId: 'q1' }, phase: 'user-input-required' }), 'needs-input:request'],
    [snapshot({ id: 'permission' }, [
      event(1, 'approval.requested', { method: 'session/request_permission' }),
      event(2, 'approval.resolved', { decision: 'reject' })
    ]), 'needs-input:permission'],
    [snapshot({ id: 'direct', status: 'failed', errorCode: 'DIRECT_TRANSPORT' }), 'needs-input:request'],
    [snapshot({
      id: 'write-review',
      status: 'completed',
      changedFiles: { count: 3 },
      acceptance: { state: 'ready-for-review' }
    }), 'ready-for-review:write'],
    [snapshot({
      id: 'read-findings',
      mode: 'review',
      status: 'completed',
      result: { structured: { findings: [{ severity: 'blocking' }, { severity: 'non-blocking' }] } }
    }), 'ready-for-review:findings'],
    [snapshot({ id: 'failed', status: 'failed', errorCode: 'PROVIDER_ERROR' }), 'failure'],
    [snapshot({ id: 'orphaned', status: 'failed', errorCode: 'ORPHANED' }), 'failure'],
    [snapshot({ id: 'cancel-error', status: 'cancelled', errorCode: 'TRANSPORT_ERROR' }), 'failure'],
    [snapshot({ id: 'stalled' }, [], NOW - 10 * 60 * 1000), 'stalled']
  ];
  for (const [value, expected] of cases) {
    const edges = detectActionableEdges(value, { now: NOW, stallMs: 10 * 60 * 1000 });
    assert.equal(edges[0]?.key, expected, value.job.id);
  }
});

test('needs-input monitor line gives both inline TUI and revisioned CLI answer paths', () => {
  const edge = detectActionableEdges(snapshot({
    id: 'question-job',
    revision: 7,
    pendingInput: { requestId: 'question-1' },
    phase: 'user-input-required'
  }), { now: NOW })[0];
  assert.equal(
    formatEdgeLine(edge),
    "delegate[delegate-router]: question-job needs-input (answer in TUI with a, or: delegate-jobs respond question-job --expected-revision 7 --request-id question-1 --answer '<answer>')"
  );
});

test('progress, deltas, tools, usage, and successful intermediate steps stay silent', () => {
  const events = [
    event(1, 'job.state', { status: 'running', phase: 'running' }),
    event(2, 'message.delta', { delta: 'work' }),
    event(3, 'tool.started', { title: 'test' }),
    event(4, 'tool.output', { delta: 'ok' }),
    event(5, 'tool.completed', { status: 'completed' }),
    event(6, 'usage.updated', { outputTokens: 10 }),
    event(7, 'turn.completed', { status: 'completed' })
  ];
  assert.deepEqual(detectActionableEdges(snapshot({ id: 'quiet' }, events), { now: NOW }), []);
});

test('provider completion alone stays silent until acceptance evidence is ready', () => {
  assert.deepEqual(detectActionableEdges(snapshot({
    id: 'completed-only',
    status: 'completed',
    changedFiles: { count: 2 }
  }), { now: NOW }), []);
  assert.equal(detectActionableEdges(snapshot({
    id: 'acceptance-ready',
    status: 'completed',
    changedFiles: { count: 2 },
    acceptance: { state: 'ready-for-review' }
  }), { now: NOW })[0]?.key, 'ready-for-review:write');
});

test('edge policy deduplicates, permits genuine re-entry, and holds per-job cooldown', () => {
  const policy = new NotificationPolicy({ cooldownMs: 10_000, maxLinesPerMinute: 20 });
  assert.deepEqual(policy.bootstrap([snapshot({ id: 'job-1' })], { now: 0 }), []);
  const ready = snapshot({
    id: 'job-1',
    status: 'completed',
    changedFiles: { count: 1 },
    acceptance: { state: 'ready-for-review' }
  }, [], 1000);
  assert.deepEqual(policy.observe([ready], { now: 1000 }), [
    'delegate[delegate-router]: job-1 ready-for-review (implement, 1 file, checks not run)'
  ]);
  assert.deepEqual(policy.observe([ready], { now: 2000 }), []);
  assert.deepEqual(policy.observe([snapshot({ id: 'job-1' })], { now: 2500 }), []);
  const failed = snapshot({ id: 'job-1', status: 'failed', errorCode: 'PROVIDER_ERROR' }, [], 3000);
  assert.deepEqual(policy.observe([failed], { now: 3000 }), []);
  assert.deepEqual(policy.observe([failed], { now: 11_001 }), [
    'delegate[delegate-router]: job-1 failure (PROVIDER_ERROR)'
  ]);
});

test('simultaneous edges drain in priority order across the per-job cooldown', () => {
  const policy = new NotificationPolicy({ cooldownMs: 1000, maxLinesPerMinute: 20 });
  const quiet = snapshot({ id: 'multi', status: 'running', scopeViolations: 0 });
  policy.bootstrap([quiet], { now: NOW });
  const actionable = snapshot({
    id: 'multi',
    status: 'completed',
    scopeViolations: 1,
    changedFiles: { count: 2 },
    acceptance: { state: 'ready-for-review' }
  });
  assert.match(policy.observe([actionable], { now: NOW + 1 })[0], /policy-breach/);
  assert.equal(policy.observe([actionable], { now: NOW + 500 }).length, 0);
  assert.match(policy.observe([actionable], { now: NOW + 1001 })[0], /ready-for-review/);
  assert.equal(policy.observe([actionable], { now: NOW + 2001 }).length, 0);
});

test('global rate ceiling emits one exact suppressed-count summary', () => {
  const policy = new NotificationPolicy({
    cooldownMs: 0,
    maxLinesPerMinute: 2,
    rateWindowMs: 60_000
  });
  policy.bootstrap([], { now: 0 });
  const jobs = ['one', 'two', 'three'].map((id) => snapshot({
    id,
    status: 'completed',
    changedFiles: { count: 1 },
    acceptance: { state: 'ready-for-review' },
    verification: { exitCode: 0 }
  }));
  assert.deepEqual(policy.observe(jobs, { now: 1 }), [
    'delegate[delegate-router]: one ready-for-review (implement, 1 file, checks passed)',
    'delegate[delegate-router]: two ready-for-review (implement, 1 file, checks passed)'
  ]);
  assert.deepEqual(policy.observe(jobs, { now: 60_002 }), [
    'delegate[delegate-router]: 1 actionable notification suppressed (rate limit; inspect delegate_list)'
  ]);
});

test('boot baselines history and emits at most one consolidated attention summary', () => {
  const policy = new NotificationPolicy({ cooldownMs: 0, maxLinesPerMinute: 20 });
  const lines = policy.bootstrap([
    snapshot({
      id: 'old-ready',
      status: 'completed',
      needsAttention: true,
      changedFiles: { count: 2 },
      acceptance: { state: 'ready-for-review' }
    }),
    snapshot({ id: 'old-input', pendingInput: { requestId: 'q' }, phase: 'user-input-required' }),
    snapshot({ id: 'ordinary-running' })
  ], { now: NOW });
  assert.deepEqual(lines, [
    'delegate[delegate-router]: 2 existing jobs need attention (1 input, 1 review; inspect delegate_list)'
  ]);
  assert.deepEqual(policy.observe([
    snapshot({
      id: 'old-ready',
      status: 'completed',
      changedFiles: { count: 2 },
      acceptance: { state: 'ready-for-review' }
    }),
    snapshot({ id: 'old-input', pendingInput: { requestId: 'q' }, phase: 'user-input-required' }),
    snapshot({ id: 'ordinary-running' })
  ], { now: NOW + 1000 }), []);
});

test('line formatting redacts hostile fields and never includes prompts, diffs, paths, or secrets', () => {
  const edge = detectActionableEdges(snapshot({
    id: 'codex-safe-123',
    mode: 'API_KEY=super-secret-value',
    status: 'failed',
    errorCode: 'API_KEY=super-secret-value',
    prompt: 'Bearer top-secret-token-value',
    result: 'password=hunter2',
    diff: '+ sk-ABCDEFGHIJKLMNOPQRST',
    scopeViolations: []
  }), { now: NOW })[0];
  const line = formatEdgeLine(edge);
  assert.equal(line, 'delegate[delegate-router]: codex-safe-123 failure (failed)');
  assert.doesNotMatch(line, /super-secret|hunter2|ABCDEFGHIJKLMNOPQRST|Bearer|password|API_KEY/);
});

test('kill switch disables the process and snooze suppresses every non-breach edge', () => {
  assert.equal(monitorEnabled({ DELEGATE_MONITOR: '0' }), false);
  assert.equal(monitorEnabled({ DELEGATE_MONITOR_SCOPE: 'off' }), false);
  assert.equal(monitorEnabled({}), true);
  assert.equal(monitorScope({}), 'session');
  assert.equal(monitorScope({ DELEGATE_MONITOR_SCOPE: 'workspace' }), 'workspace');
  assert.equal(monitorScope({ DELEGATE_MONITOR_SCOPE: 'project' }), 'workspace');
  assert.equal(monitorScope({ DELEGATE_MONITOR_SCOPE: 'all' }), 'all');
  const disabled = spawnSync(process.execPath, [path.join(pluginRoot, 'bin', 'delegate-monitor')], {
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_MONITOR: '0' }
  });
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, '');

  const policy = new NotificationPolicy({ cooldownMs: 0, maxLinesPerMinute: 20 });
  policy.bootstrap([snapshot({ id: 'snoozed' })], { now: NOW });
  assert.deepEqual(policy.observe([
    snapshot({
      id: 'snoozed',
      status: 'completed',
      changedFiles: { count: 1 },
      acceptance: { state: 'ready-for-review' }
    })
  ], { now: NOW + 1, snoozed: true }), []);
  policy.observe([snapshot({ id: 'snoozed' })], { now: NOW + 2, snoozed: true });
  assert.deepEqual(policy.observe([
    snapshot({ id: 'snoozed', scopeViolations: [{ path: 'outside.js' }] })
  ], { now: NOW + 3, snoozed: true }), [
    'delegate[delegate-router]: snoozed policy-breach (scope violation, 1 path)'
  ]);

  assert.equal(parseSnoozeUntil('2026-07-26T13:00:00.000Z'), Date.parse('2026-07-26T13:00:00.000Z'));
  assert.equal(preferenceSnoozed({ snoozeUntil: '2026-07-26T13:00:00.000Z' }, NOW), true);
});

test('monitor runtime observes a synthetic store edge without mutating it', (t) => {
  // Timestamps must be relative to the real clock: this test drives the live
  // monitor (no injected now), so a frozen fixture date makes the job look
  // stalled the day after the constant was written.
  const liveNow = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = path.join(root, 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const record = path.join(jobs, 'codex-edge.json');
  const origin = {
    projectDir: root,
    cwd: root,
    sessionId: 'session-edge',
    workspaceId: root,
    brokerVersion: '0.29.0',
    launchedAtMs: liveNow
  };
  fs.writeFileSync(record, `${JSON.stringify({
    id: 'codex-edge',
    provider: 'codex',
    mode: 'implement',
    status: 'running',
    phase: 'running',
    createdAt: Math.floor(liveNow / 1000),
    origin
  })}\n`);
  fs.writeFileSync(path.join(jobs, 'codex-edge.events.jsonl'), `${JSON.stringify(event(1, 'job.state', { status: 'running' }, liveNow))}\n`);
  const output = [];
  const store = new MonitorStore({ jobsDirectory: jobs, stateDirectory: root });
  const monitor = new DelegateMonitor({
    env: {},
    scope: 'workspace',
    projectDir: root,
    store,
    emit: (line) => output.push(line),
    pollMs: 60_000,
    debounceMs: 0
  });
  monitor.start();
  t.after(() => monitor.stop());
  assert.deepEqual(output, []);

  fs.writeFileSync(record, `${JSON.stringify({
    id: 'codex-edge',
    provider: 'codex',
    mode: 'implement',
    status: 'completed',
    phase: 'completed',
    changedFiles: { count: 3 },
    acceptance: { state: 'ready-for-review' },
    verification: null,
    createdAt: Math.floor(liveNow / 1000),
    completedAt: Math.floor(NOW / 1000) + 1,
    origin
  })}\n`);
  fs.appendFileSync(path.join(jobs, 'codex-edge.events.jsonl'), `${JSON.stringify(event(2, 'job.completed', {}, NOW + 1000))}\n`);
  monitor.scan();
  assert.deepEqual(output, [
    `delegate[${path.basename(root)}]: codex-edge ready-for-review (implement, 3 files, checks not run)`
  ]);
});

test('session and workspace scopes isolate sibling sessions and real worktree launch paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manualWorktree = path.join(root, 'manual-worktree');
  const claudeWorktree = path.join(root, 'repo', '.claude', 'worktrees', 'claude-created');
  const delegatedCwd = path.join(root, 'different-target');
  fs.mkdirSync(manualWorktree, { recursive: true });
  fs.mkdirSync(claudeWorktree, { recursive: true });
  fs.mkdirSync(delegatedCwd);
  const owned = snapshot({
    id: 'owned',
    cwd: delegatedCwd,
    origin: {
      projectDir: `${manualWorktree}${path.sep}`,
      cwd: manualWorktree,
      sessionId: 'session-a',
      workspaceId: manualWorktree,
      brokerVersion: '0.29.0',
      launchedAtMs: NOW
    }
  }, [], Date.now());
  const siblingSession = snapshot({
    id: 'sibling-session',
    cwd: manualWorktree,
    origin: {
      projectDir: manualWorktree,
      cwd: manualWorktree,
      sessionId: 'session-b',
      workspaceId: manualWorktree,
      brokerVersion: '0.29.0',
      launchedAtMs: NOW
    }
  }, [], Date.now());
  const claudeCreated = snapshot({
    id: 'claude-created-worktree',
    cwd: claudeWorktree,
    origin: {
      projectDir: claudeWorktree,
      cwd: claudeWorktree,
      sessionId: 'session-c',
      workspaceId: claudeWorktree,
      brokerVersion: '0.29.0',
      launchedAtMs: NOW
    }
  });
  const legacy = snapshot({ id: 'legacy', cwd: delegatedCwd, origin: undefined });
  const values = [owned, siblingSession, claudeCreated, legacy];

  assert.deepEqual(scopeMonitorSnapshots(values, {
    scope: 'session',
    sessionId: 'session-a',
    workspaceId: manualWorktree
  }).map((item) => item.job.id), ['owned']);
  assert.deepEqual(scopeMonitorSnapshots(values, {
    scope: 'session',
    sessionId: 'session-b',
    workspaceId: manualWorktree
  }).map((item) => item.job.id), ['sibling-session']);
  assert.deepEqual(scopeMonitorSnapshots(values, {
    scope: 'workspace',
    workspaceId: manualWorktree
  }).map((item) => item.job.id), ['owned', 'sibling-session']);
  assert.deepEqual(scopeMonitorSnapshots(values, {
    scope: 'workspace',
    workspaceId: claudeWorktree
  }).map((item) => item.job.id), ['claude-created-worktree']);
  assert.deepEqual(scopeMonitorSnapshots(values, {
    scope: 'project',
    projectDir: manualWorktree
  }).map((item) => item.job.id), ['owned', 'sibling-session']);
  assert.deepEqual(scopeMonitorSnapshots(values, { scope: 'all' }).map((item) => item.job.id), [
    'owned', 'sibling-session', 'claude-created-worktree', 'legacy'
  ]);
  assert.deepEqual(scopeMonitorSnapshots(values, { scope: 'off', workspaceId: manualWorktree }), []);
  assert.deepEqual(scopeMonitorSnapshots([legacy], {
    scope: 'session',
    sessionId: 'session-a',
    workspaceId: manualWorktree
  }), []);
  assert.deepEqual(scopeMonitorSnapshots([legacy], {
    scope: 'workspace',
    workspaceId: manualWorktree
  }), []);
  assert.equal(normalizeMonitorProjectDirectory(`${manualWorktree}${path.sep}`), normalizeMonitorProjectDirectory(manualWorktree));

  const actionableOwned = {
    ...owned,
    job: {
      ...owned.job,
      status: 'completed',
      needsAttention: true,
      changedFiles: { count: 0 },
      acceptance: { state: 'ready-for-review' }
    }
  };
  const actionableSibling = {
    ...siblingSession,
    job: {
      ...siblingSession.job,
      status: 'completed',
      needsAttention: true,
      changedFiles: { count: 0 },
      acceptance: { state: 'ready-for-review' }
    }
  };
  let currentSnapshots = [owned, siblingSession];
  const store = {
    directory: root,
    stateDirectory: root,
    scan: () => currentSnapshots,
    readPreference: () => null
  };
  const outputA = [];
  const monitorA = new DelegateMonitor({
    env: {},
    projectDir: manualWorktree,
    workspaceId: manualWorktree,
    store,
    correlation: { ok: true, sessionId: 'session-a', recorded: true },
    emit: (line) => outputA.push(line)
  });
  monitorA.scan();
  const outputB = [];
  const monitorB = new DelegateMonitor({
    env: {},
    projectDir: manualWorktree,
    workspaceId: manualWorktree,
    store,
    correlation: { ok: true, sessionId: 'session-b', recorded: true },
    emit: (line) => outputB.push(line)
  });
  monitorB.scan();
  currentSnapshots = [actionableOwned, actionableSibling];
  monitorA.scan();
  monitorB.scan();
  monitorA.stop();
  monitorB.stop();
  assert.equal(outputA.length, 1);
  assert.match(outputA[0], new RegExp(`^delegate\\[${path.basename(manualWorktree)}\\]: owned\\b`));
  assert.equal(outputB.length, 1);
  assert.match(outputB[0], new RegExp(`^delegate\\[${path.basename(manualWorktree)}\\]: sibling-session\\b`));

  const legacyLine = formatEdgeLine(detectActionableEdges({
    ...legacy,
    job: { ...legacy.job, status: 'failed', errorCode: 'ORPHANED' }
  }, { now: NOW })[0]);
  assert.match(legacyLine, new RegExp(`^delegate\\[legacy@${path.basename(delegatedCwd)}\\]:`));
});

test('correlation failure records and visibly degrades session scope to workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-degraded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const directory = monitorCorrelationDirectory(root);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), `${JSON.stringify({
    version: 1,
    kind: 'session',
    markerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: 'obsolete-handshake-session',
    coordinatorPid: 999_999_999,
    workspaceId: workspace,
    projectDir: workspace,
    createdAtMs: NOW,
    expiresAtMs: NOW + 60_000
  })}\n`, { mode: 0o600 });
  const output = [];
  const store = {
    directory: path.join(root, 'jobs'),
    stateDirectory: root,
    scan: () => [],
    readPreference: () => null
  };
  const monitor = new DelegateMonitor({
    env: { DELEGATE_MONITOR_SCOPE: 'session' },
    projectDir: workspace,
    workspaceId: workspace,
    parentPid: 401,
    processTable: [
      { pid: 401, ppid: 400, startTimeMs: NOW - 2_000 },
      { pid: 400, ppid: 1, startTimeMs: NOW - 4_000 }
    ],
    store,
    emit: (line) => output.push(line)
  });
  const result = monitor.start();
  monitor.stop();
  assert.equal(result.requestedScope, 'session');
  assert.equal(result.effectiveScope, 'workspace');
  assert.equal(result.degradation.reason, 'no-matching-session-marker');
  assert.deepEqual(output, [
    `delegate[${path.basename(workspace)}]: monitor-scope degraded (session correlation no-matching-session-marker; using workspace scope)`
  ]);
  const records = fs.readdirSync(directory)
    .filter((name) => name.startsWith('resolution-'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(monitorCorrelationDirectory(root), name), 'utf8')));
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'degraded');
  assert.equal(records[0].effectiveScope, 'workspace');
  assert.equal(records[0].reason, 'no-matching-session-marker');
  assert.equal(fs.statSync(path.join(directory, fs.readdirSync(directory).find((name) => name.startsWith('resolution-')))).mode & 0o777, 0o600);
});

test('durable ancestor markers choose the nearest session, then its newest marker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-ancestor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const processTable = [
    { pid: 501, ppid: 500, startTimeMs: NOW - 1_000 },
    { pid: 500, ppid: 400, startTimeMs: NOW - 10_000 },
    { pid: 400, ppid: 1, startTimeMs: NOW - 20_000 },
    { pid: 601, ppid: 500, startTimeMs: NOW - 2_000 },
    { pid: 602, ppid: 400, startTimeMs: NOW - 3_000 }
  ];
  const first = writeSessionCorrelationMarker({
    stateDirectory: root,
    sessionId: 'session-current',
    coordinatorPid: 601,
    ancestorChain: [
      { pid: 601, startTimeMs: NOW - 2_000 },
      { pid: 500, startTimeMs: NOW - 10_000 },
      { pid: 400, startTimeMs: NOW - 20_000 }
    ],
    projectDir: workspace,
    workspaceId: workspace,
    now: NOW
  });
  const newest = writeSessionCorrelationMarker({
    stateDirectory: root,
    sessionId: 'session-current',
    coordinatorPid: 601,
    ancestorChain: [
      { pid: 601, startTimeMs: NOW - 2_000 },
      { pid: 500, startTimeMs: NOW - 10_000 },
      { pid: 400, startTimeMs: NOW - 20_000 }
    ],
    projectDir: workspace,
    workspaceId: workspace,
    now: NOW + 1_000
  });
  assert.equal(first.ok, true);
  assert.equal(newest.ok, true);
  assert.ok(newest.marker.expiresAtMs - newest.marker.createdAtMs >= 60 * 60 * 1000);
  assert.deepEqual(newest.marker.ancestorChain, [
    { pid: 601, startTimeMs: NOW - 2_000 },
    { pid: 500, startTimeMs: NOW - 10_000 },
    { pid: 400, startTimeMs: NOW - 20_000 }
  ]);
  const broader = writeSessionCorrelationMarker({
    stateDirectory: root,
    sessionId: 'session-other',
    coordinatorPid: 602,
    ancestorChain: [
      { pid: 602, startTimeMs: NOW - 3_000 },
      { pid: 400, startTimeMs: NOW - 20_000 }
    ],
    projectDir: workspace,
    workspaceId: workspace,
    now: NOW + 1_500
  });
  assert.equal(broader.ok, true);

  const result = resolveMonitorSession({
    stateDirectory: root,
    workspaceId: workspace,
    parentPid: 501,
    processTable,
    now: NOW + 2_000
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'session-current');
  assert.equal(result.markerId, newest.marker.markerId);
  assert.equal(result.matchDepth, 1);
  assert.deepEqual(result.commonAncestor, { pid: 500, startTimeMs: NOW - 10_000 });
  assert.equal(result.record.status, 'correlated');
  assert.equal(result.record.effectiveScope, 'session');
});

test('equal ancestor matches are ambiguous and PID reuse cannot correlate', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-ambiguous-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const sharedStart = NOW - 10_000;
  const processTable = [
    { pid: 701, ppid: 700, startTimeMs: NOW - 1_000 },
    { pid: 700, ppid: 1, startTimeMs: sharedStart },
    { pid: 711, ppid: 700, startTimeMs: NOW - 2_000 },
    { pid: 712, ppid: 700, startTimeMs: NOW - 3_000 }
  ];
  for (const [sessionId, coordinatorPid, coordinatorStart] of [
    ['session-a', 711, NOW - 2_000],
    ['session-b', 712, NOW - 3_000]
  ]) {
    const marker = writeSessionCorrelationMarker({
      stateDirectory: root,
      sessionId,
      coordinatorPid,
      ancestorChain: [
        { pid: coordinatorPid, startTimeMs: coordinatorStart },
        { pid: 700, startTimeMs: sharedStart }
      ],
      projectDir: workspace,
      workspaceId: workspace,
      now: NOW
    });
    assert.equal(marker.ok, true);
  }
  const ambiguous = resolveMonitorSession({
    stateDirectory: root,
    workspaceId: workspace,
    parentPid: 701,
    processTable,
    now: NOW + 1
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous-session-markers');
  assert.equal(ambiguous.record.status, 'degraded');
  assert.equal(ambiguous.record.effectiveScope, 'workspace');

  const reusedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-reused-'));
  t.after(() => fs.rmSync(reusedRoot, { recursive: true, force: true }));
  const reusedWorkspace = path.join(reusedRoot, 'workspace');
  fs.mkdirSync(reusedWorkspace);
  const reusedMarker = writeSessionCorrelationMarker({
    stateDirectory: reusedRoot,
    sessionId: 'stale-session',
    coordinatorPid: 812,
    ancestorChain: [
      { pid: 812, startTimeMs: NOW - 8_000 },
      { pid: 800, startTimeMs: sharedStart }
    ],
    projectDir: reusedWorkspace,
    workspaceId: reusedWorkspace,
    now: NOW
  });
  const reused = resolveMonitorSession({
    stateDirectory: reusedRoot,
    workspaceId: reusedWorkspace,
    parentPid: 801,
    processTable: [
      { pid: 801, ppid: 800, startTimeMs: NOW - 1_000 },
      { pid: 800, ppid: 1, startTimeMs: sharedStart },
      { pid: 812, ppid: 800, startTimeMs: NOW - 500 }
    ],
    now: NOW + 1
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'no-matching-session-marker');
  assert.equal(fs.existsSync(reusedMarker.file), false);

  const unavailableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-unavailable-'));
  t.after(() => fs.rmSync(unavailableRoot, { recursive: true, force: true }));
  const unavailable = resolveMonitorSession({
    stateDirectory: unavailableRoot,
    workspaceId: workspace,
    parentPid: 900,
    processTable: [],
    now: NOW
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'process-start-time-unavailable');
  assert.equal(unavailable.record.status, 'degraded');
  assert.equal(unavailable.record.effectiveScope, 'workspace');
});

test('correlation garbage collection is bounded and removes expired handshake debris', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-gc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = monitorCorrelationDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 140; index += 1) {
    const requestId = `${String(index).padStart(16, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    fs.writeFileSync(path.join(directory, `request-${requestId}.json`), `${JSON.stringify({
      version: 1,
      kind: 'monitor-request',
      requestId,
      createdAtMs: NOW - 10_000,
      expiresAtMs: NOW - 1
    })}\n`, { mode: 0o600 });
  }
  const result = cleanupMonitorCorrelation(root, NOW, { processes: new Map() });
  assert.equal(result.examined, 128);
  assert.equal(result.removed, 128);
  assert.equal(fs.readdirSync(directory).length, 12);
});

test('SessionStart marker survives hook exit and a later real monitor resolves session scope', async (t) => {
  const monitorBin = path.join(pluginRoot, 'bin', 'delegate-monitor');
  const hookBin = path.join(pluginRoot, 'bin', 'delegate-session-hook');
  const waitFor = async (predicate, timeoutMs = 2500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-correlation-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const stateFile = path.join(root, 'usage.json');
  const sessionId = 'session-live-ancestor';
  const common = {
    ...process.env,
    DELEGATE_STATE_FILE: stateFile,
    CLAUDE_PROJECT_DIR: workspace
  };
  const hook = spawnSync(process.execPath, [hookBin], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: workspace
    }),
    env: { ...common, CLAUDE_CODE_SESSION_ID: sessionId }
  });
  assert.equal(hook.status, 0, hook.stderr);
  const markerFiles = fs.readdirSync(monitorCorrelationDirectory(root))
    .filter((name) => name.startsWith('session-'));
  assert.equal(markerFiles.length, 1);
  const marker = JSON.parse(fs.readFileSync(path.join(monitorCorrelationDirectory(root), markerFiles[0]), 'utf8'));
  assert.equal(marker.version, 2);
  assert.equal(marker.sessionId, sessionId);
  assert.ok(marker.ancestorChain.length >= 1);
  assert.ok(marker.ancestorChain.every((identity) => Number.isSafeInteger(identity.pid) && Number.isSafeInteger(identity.startTimeMs)));
  assert.equal(fs.readdirSync(monitorCorrelationDirectory(root)).some((name) => /^(?:request|response)-/.test(name)), false);

  const monitorEnv = {
    ...common,
    DELEGATE_MONITOR_SCOPE: 'session',
    DELEGATE_MONITOR_POLL_MS: '60000'
  };
  delete monitorEnv.CLAUDE_CODE_SESSION_ID;
  delete monitorEnv.CLAUDE_SESSION_ID;
  const child = spawn(process.execPath, [monitorBin], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: monitorEnv
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const correlated = await waitFor(() => {
      try {
        for (const name of fs.readdirSync(monitorCorrelationDirectory(root))) {
          if (!name.startsWith('resolution-')) continue;
          const record = JSON.parse(fs.readFileSync(path.join(monitorCorrelationDirectory(root), name), 'utf8'));
          if (record.status === 'correlated') return record;
        }
      } catch {}
      return null;
    });
    assert.ok(correlated, `correlation did not complete: ${stderr}`);
    assert.equal(correlated.sessionId, sessionId);
    assert.equal(correlated.effectiveScope, 'session');
    assert.ok(correlated.commonAncestor?.pid > 1);
    assert.ok(correlated.commonAncestor?.startTimeMs > 0);
    assert.doesNotMatch(stdout, /monitor-scope degraded/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode != null) resolve();
      else child.once('exit', resolve);
    });
  }
});

test('every notification line carries an explicit project label', () => {
  const policy = new NotificationPolicy({ cooldownMs: 0, maxLinesPerMinute: 20 });
  policy.bootstrap([snapshot({ id: 'running' })], { now: NOW });
  const lines = policy.observe([
    snapshot({
      id: 'running',
      status: 'completed',
      changedFiles: { count: 1 },
      acceptance: { state: 'ready-for-review' }
    })
  ], { now: NOW + 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^delegate\[delegate-router\]:/);
});

test('monitor modules import no broker mutation surface', () => {
  const files = [
    'bin/delegate-monitor',
    'bin/lib/monitor-correlation.mjs',
    'bin/lib/monitor-policy.mjs',
    'bin/lib/monitor-runtime.mjs',
    'bin/lib/monitor-store.mjs'
  ];
  const forbidden = [
    'appendJobEvent',
    'claimCommands',
    'completeCommand',
    'createManagedJob',
    'launchManagedJob',
    'mutateState',
    'reconcileJob',
    'resumeManagedJob',
    'revertManagedJob',
    'reviewRoundManagedJob',
    'saveJob',
    'saveState',
    'settleQueuedControl',
    'submitControl',
    'updateManagedJob'
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    for (const symbol of forbidden) assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`), `${file} imports ${symbol}`);
    assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\b/, `${file} can start a process`);
  }
});

test('monitors.json uses the documented schema and a space-safe plugin-root command', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'monitors', 'monitors.json'), 'utf8'));
  // The documented format is a bare JSON array of monitor entries. An object
  // wrapper does not load, and a monitor that fails to load fails silently.
  assert.ok(Array.isArray(manifest), 'monitors.json must be a bare array per the plugins reference');
  assert.equal(manifest.length, 1);
  const [monitor] = manifest;
  assert.deepEqual(Object.keys(monitor).sort(), ['command', 'description', 'name', 'when']);
  assert.match(monitor.name, /^[a-zA-Z0-9_-]+$/);
  assert.equal(typeof monitor.description, 'string');
  assert.ok(monitor.description.length > 0);
  assert.equal(monitor.when, 'always');
  assert.equal(monitor.command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/delegate-monitor"');
});
