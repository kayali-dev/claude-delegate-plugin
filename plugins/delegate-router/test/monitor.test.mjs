import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  detectActionableEdges,
  formatEdgeLine,
  NotificationPolicy
} from '../bin/lib/monitor-policy.mjs';
import { DelegateMonitor, monitorEnabled } from '../bin/lib/monitor-runtime.mjs';
import { MonitorStore, parseSnoozeUntil, preferenceSnoozed } from '../bin/lib/monitor-store.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = Date.parse('2026-07-26T12:00:00.000Z');

function snapshot(job, events = [], lastEventAt = NOW) {
  return { job: { provider: 'codex', mode: 'implement', status: 'running', phase: 'running', ...job }, events, lastEventAt };
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
    'delegate: job-1 ready-for-review (implement, 1 file, checks not run)'
  ]);
  assert.deepEqual(policy.observe([ready], { now: 2000 }), []);
  assert.deepEqual(policy.observe([snapshot({ id: 'job-1' })], { now: 2500 }), []);
  const failed = snapshot({ id: 'job-1', status: 'failed', errorCode: 'PROVIDER_ERROR' }, [], 3000);
  assert.deepEqual(policy.observe([failed], { now: 3000 }), []);
  assert.deepEqual(policy.observe([failed], { now: 11_001 }), [
    'delegate: job-1 failure (PROVIDER_ERROR)'
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
    'delegate: one ready-for-review (implement, 1 file, checks passed)',
    'delegate: two ready-for-review (implement, 1 file, checks passed)'
  ]);
  assert.deepEqual(policy.observe(jobs, { now: 60_002 }), [
    'delegate: 1 actionable notification suppressed (rate limit; inspect delegate_list)'
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
    'delegate: 2 existing jobs need attention (1 input, 1 review; inspect delegate_list)'
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
  assert.equal(line, 'delegate: codex-safe-123 failure (failed)');
  assert.doesNotMatch(line, /super-secret|hunter2|ABCDEFGHIJKLMNOPQRST|Bearer|password|API_KEY/);
});

test('kill switch disables the process and snooze suppresses every non-breach edge', () => {
  assert.equal(monitorEnabled({ DELEGATE_MONITOR: '0' }), false);
  assert.equal(monitorEnabled({}), true);
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
    'delegate: snoozed policy-breach (scope violation, 1 path)'
  ]);

  assert.equal(parseSnoozeUntil('2026-07-26T13:00:00.000Z'), Date.parse('2026-07-26T13:00:00.000Z'));
  assert.equal(preferenceSnoozed({ snoozeUntil: '2026-07-26T13:00:00.000Z' }, NOW), true);
});

test('monitor runtime observes a synthetic store edge without mutating it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = path.join(root, 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const record = path.join(jobs, 'codex-edge.json');
  fs.writeFileSync(record, `${JSON.stringify({
    id: 'codex-edge',
    provider: 'codex',
    mode: 'implement',
    status: 'running',
    phase: 'running',
    createdAt: Math.floor(NOW / 1000)
  })}\n`);
  fs.writeFileSync(path.join(jobs, 'codex-edge.events.jsonl'), `${JSON.stringify(event(1, 'job.state', { status: 'running' }))}\n`);
  const output = [];
  const store = new MonitorStore({ jobsDirectory: jobs, stateDirectory: root });
  const monitor = new DelegateMonitor({
    env: {},
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
    createdAt: Math.floor(NOW / 1000),
    completedAt: Math.floor(NOW / 1000) + 1
  })}\n`);
  fs.appendFileSync(path.join(jobs, 'codex-edge.events.jsonl'), `${JSON.stringify(event(2, 'job.completed', {}, NOW + 1000))}\n`);
  monitor.scan();
  assert.deepEqual(output, [
    'delegate: codex-edge ready-for-review (implement, 3 files, checks not run)'
  ]);
});

test('monitor modules import no broker mutation surface', () => {
  const files = [
    'bin/delegate-monitor',
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
