import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  monitorCorrelationDirectory,
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
    [snapshot({ id: 'write-review', status: 'completed', changedFiles: { count: 3 } }), 'ready-for-review:write'],
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

test('edge policy deduplicates, permits genuine re-entry, and holds per-job cooldown', () => {
  const policy = new NotificationPolicy({ cooldownMs: 10_000, maxLinesPerMinute: 20 });
  assert.deepEqual(policy.bootstrap([snapshot({ id: 'job-1' })], { now: 0 }), []);
  const ready = snapshot({ id: 'job-1', status: 'completed', changedFiles: { count: 1 } }, [], 1000);
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
    changedFiles: { count: 2 }
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
    snapshot({ id: 'old-ready', status: 'completed', needsAttention: true, changedFiles: { count: 2 } }),
    snapshot({ id: 'old-input', pendingInput: { requestId: 'q' }, phase: 'user-input-required' }),
    snapshot({ id: 'ordinary-running' })
  ], { now: NOW });
  assert.deepEqual(lines, [
    'delegate[delegate-router]: 2 existing jobs need attention (1 input, 1 review; inspect delegate_list)'
  ]);
  assert.deepEqual(policy.observe([
    snapshot({ id: 'old-ready', status: 'completed', changedFiles: { count: 2 } }),
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
    snapshot({ id: 'snoozed', status: 'completed', changedFiles: { count: 1 } })
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
    job: { ...owned.job, status: 'completed', needsAttention: true, changedFiles: { count: 0 } }
  };
  const actionableSibling = {
    ...siblingSession,
    job: { ...siblingSession.job, status: 'completed', needsAttention: true, changedFiles: { count: 0 } }
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
  writeSessionCorrelationMarker({
    stateDirectory: root,
    sessionId: 'dead-session',
    coordinatorPid: 999_999_999,
    projectDir: workspace,
    workspaceId: workspace,
    responderMs: 1
  });
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
    coordinatorPid: process.pid,
    correlationWaitMs: 0,
    store,
    emit: (line) => output.push(line)
  });
  const result = monitor.start();
  monitor.stop();
  assert.equal(result.requestedScope, 'session');
  assert.equal(result.effectiveScope, 'workspace');
  assert.equal(result.degradation.reason, 'correlation-timeout');
  assert.deepEqual(output, [
    `delegate[${path.basename(workspace)}]: monitor-scope degraded (session correlation correlation-timeout; using workspace scope)`
  ]);
  const records = fs.readdirSync(monitorCorrelationDirectory(root))
    .filter((name) => name.startsWith('request-'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(monitorCorrelationDirectory(root), name), 'utf8')));
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'degraded');
  assert.equal(records[0].effectiveScope, 'workspace');
  assert.equal(records[0].reason, 'correlation-timeout');
  assert.equal(fs.statSync(path.join(monitorCorrelationDirectory(root), `request-${records[0].requestId}.json`)).mode & 0o777, 0o600);
});

test('SessionStart correlation is race-safe when the monitor starts before or after the hook', async (t) => {
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
  const runOrder = async (hookFirst, suffix) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `delegate-monitor-correlation-${suffix}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const stateFile = path.join(root, 'usage.json');
    const sessionId = `session-${suffix}`;
    const common = {
      ...process.env,
      DELEGATE_STATE_FILE: stateFile,
      CLAUDE_PROJECT_DIR: workspace,
      DELEGATE_MONITOR_CORRELATION_RESPONDER_MS: '3000'
    };
    const hook = () => {
      const result = spawnSync(process.execPath, [hookBin], {
        encoding: 'utf8',
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          cwd: workspace
        }),
        env: { ...common, CLAUDE_CODE_SESSION_ID: sessionId }
      });
      assert.equal(result.status, 0, result.stderr);
    };
    if (hookFirst) hook();
    const monitorEnv = {
      ...common,
      DELEGATE_MONITOR_SCOPE: 'session',
      DELEGATE_MONITOR_CORRELATION_WAIT_MS: '1200',
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
      if (!hookFirst) {
        const pending = await waitFor(() => {
          try { return fs.readdirSync(monitorCorrelationDirectory(root)).some((name) => name.startsWith('request-')); }
          catch { return false; }
        });
        assert.equal(pending, true);
        hook();
      }
      const correlated = await waitFor(() => {
        try {
          for (const name of fs.readdirSync(monitorCorrelationDirectory(root))) {
            if (!name.startsWith('request-')) continue;
            const record = JSON.parse(fs.readFileSync(path.join(monitorCorrelationDirectory(root), name), 'utf8'));
            if (record.status === 'correlated') return record;
          }
        } catch {}
        return null;
      });
      assert.ok(correlated, `correlation did not complete: ${stderr}`);
      assert.equal(correlated.sessionId, sessionId);
      assert.equal(correlated.effectiveScope, 'session');
      assert.doesNotMatch(stdout, /monitor-scope degraded/);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        if (child.exitCode != null) resolve();
        else child.once('exit', resolve);
      });
    }
  };

  await runOrder(false, 'monitor-first');
  await runOrder(true, 'hook-first');
});

test('every notification line carries an explicit project label', () => {
  const policy = new NotificationPolicy({ cooldownMs: 0, maxLinesPerMinute: 20 });
  policy.bootstrap([snapshot({ id: 'running' })], { now: NOW });
  const lines = policy.observe([
    snapshot({ id: 'running', status: 'completed', changedFiles: { count: 1 } })
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
