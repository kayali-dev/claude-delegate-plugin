import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NotificationHandoff, NATIVE_NOTIFICATION_LEASE_MS } from '../bin/lib/notification-handoff.mjs';
import { NotificationPolicy } from '../bin/lib/monitor-policy.mjs';
import { DelegateMonitor } from '../bin/lib/monitor-runtime.mjs';
import { writeSessionCorrelationMarker } from '../bin/lib/monitor-correlation.mjs';

const NOW = 1_800_000_000_000;
const observation = (extra = {}, events = []) => ({ job: { id: 'job-one', provider: 'codex', mode: 'implement',
  status: 'running', phase: 'running', revision: 4, origin: { sessionId: 'owner', workspaceId: '/tmp/project' }, ...extra }, events });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-notification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { stateDirectory: root, sessionId: 'owner', projectDir: '/tmp/project',
    policyOptions: { cooldownMs: 0, maxLinesPerMinute: 20 } };
  return { root, options, next: () => new NotificationHandoff(options) };
}

test('native heartbeat suppresses monitor job scans, then hands off without duplicate alerts', (t) => {
  const { next } = fixture(t);
  next().scan('native', () => [observation()], { now: NOW, recipientSessionId: 'owner' });
  const failed = observation({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
  const delivery = next().scan('native', () => [failed], { now: NOW + 1, recipientSessionId: 'owner' });
  assert.equal(delivery.lines.length, 1);
  next().acknowledge(delivery.deliveryId, NOW + 2);
  assert.deepEqual(next().scan('monitor', () => { assert.fail('standby must not scan jobs'); }, { now: NOW + 3 }), { standby: true, lines: [] });
  const fallback = next().scan('monitor', () => [failed], { now: NOW + NATIVE_NOTIFICATION_LEASE_MS + 3 });
  assert.equal(fallback.standby, false);
  assert.deepEqual(fallback.lines, []);
  assert.deepEqual(next().scan('native', () => [failed], { now: NOW + NATIVE_NOTIFICATION_LEASE_MS + 4 }).lines, []);
});

test('unacknowledged native delivery retries with the same ID and cannot renew its grace forever', (t) => {
  const { next } = fixture(t);
  next().scan('native', () => [], { now: NOW });
  const failed = observation({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
  const first = next().scan('native', () => [failed], { now: NOW + 1 });
  const retry = next().scan('native', () => { assert.fail('retry must reuse its closed delivery'); }, { now: NOW + 10_000 });
  assert.equal(retry.deliveryId, first.deliveryId);
  assert.deepEqual(retry.lines, first.lines);
  const takeover = next().scan('monitor', () => [failed], { now: NOW + 16_000 });
  assert.deepEqual(takeover.lines, first.lines);
  assert.throws(() => next().acknowledge(first.deliveryId, NOW + 16_001), /CAS_CONFLICT/);
});

test('notification checkpoint preserves cooldown, pending edges, rate limiting and input supersession', () => {
  const policy = new NotificationPolicy({ cooldownMs: 1000, maxLinesPerMinute: 20 });
  policy.observe([observation()], { now: NOW });
  const gated = observation({ pendingInput: { requestId: 'q1', kind: 'question' } });
  assert.equal(policy.observe([gated], { now: NOW + 1, recipientSessionId: 'owner' }).length, 1);
  const both = observation({ ...gated.job, scopeViolations: ['outside.txt'] });
  assert.deepEqual(policy.observe([both], { now: NOW + 2 }), []);
  const restored = new NotificationPolicy({ cooldownMs: 1000, maxLinesPerMinute: 20 });
  restored.restore(JSON.parse(JSON.stringify(policy.checkpoint())));
  assert.deepEqual(restored.observe([both], { now: NOW + 999 }), []);
  assert.match(restored.observe([both], { now: NOW + 1002 })[0], /policy-breach/);
  const answered = observation({}, [{ seq: 1, type: 'input.resolved', data: { requestId: 'q1', outcome: 'answered' } }]);
  assert.match(restored.observe([answered], { now: NOW + 1003, recipientSessionId: 'owner' })[0], /superseded/);
  assert.equal(restored.rate.emitted, 3);
});

test('handoff record is private and contains no prompts, hidden reasoning or unredacted paths', (t) => {
  const { next } = fixture(t);
  const handoff = next();
  handoff.scan('native', () => [observation({ status: 'completed', needsAttention: true,
    prompt: 'DO_NOT_STORE_PROMPT', reasoning: 'DO_NOT_STORE_REASONING', scopeViolations: ['secret/path'] })], { now: NOW });
  const serialized = fs.readFileSync(handoff.file, 'utf8');
  for (const value of ['DO_NOT_STORE_PROMPT', 'DO_NOT_STORE_REASONING', 'secret/path']) assert.ok(!serialized.includes(value));
  assert.equal(fs.statSync(handoff.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(handoff.directory).mode & 0o777, 0o700);
});

test('notification recipients are isolated and release keeps the dedupe state', (t) => {
  const { next, options } = fixture(t);
  const handoff = next();
  handoff.scan('native', () => [], { now: NOW });
  const other = new NotificationHandoff({ ...options, sessionId: 'other' });
  assert.notEqual(other.file, handoff.file);
  assert.equal(other.scan('monitor', () => [], { now: NOW + 1 }).standby, false);
  handoff.release();
  assert.equal(next().scan('monitor', () => [], { now: NOW + 2 }).standby, false);
});

test('native wake survives observation acknowledgement, batches only owned enabled edges, and consumes once', (t) => {
  const { next } = fixture(t);
  const snapshots = [observation({ pendingInput: { requestId: 'human', kind: 'plan-confirmation' } }),
    observation({ id: 'foreign', origin: { sessionId: 'other' }, pendingInput: { requestId: 'foreign' } }),
    observation({ id: 'disabled', provider: 'cursor', pendingInput: { requestId: 'cursor' } })];
  const delivery = next().scan('native', () => snapshots, { now: NOW, recipientSessionId: 'owner', enabled: ['codex'] });
  next().acknowledge(delivery.deliveryId, NOW + 1);
  const options = { now: NOW + 2, sessionId: 'owner', enabled: ['codex'], allowed: true };
  assert.equal(next().wake(() => snapshots, { ...options, allowed: false }).deliveryId, null, 'unknown/blocked quota defers without losing the edge');
  const intent = next().wake(() => snapshots, options);
  assert.equal(next().wake(() => snapshots, options).deliveryId, intent.deliveryId, 'one durable outstanding intent');
  assert.deepEqual(next().wake(() => snapshots, { ...options, deliveryId: intent.deliveryId }), { allowed: true, jobIds: ['job-one'] });
  assert.deepEqual(next().wake(() => snapshots, { ...options, deliveryId: intent.deliveryId }), { allowed: false, jobIds: [] });
  assert.equal(next().wake(() => snapshots, options).deliveryId, null);
  assert.ok(!fs.readFileSync(next().file, 'utf8').includes('plan-confirmation'), 'no decision or provider payload stored in wake queue');
});

test('native wake rechecks revision, ownership, live edge, provider enablement, quota and snooze at idle', (t) => {
  const { next } = fixture(t);
  const gated = observation({ pendingInput: { requestId: 'q1', kind: 'question' } });
  const options = { now: NOW, recipientSessionId: 'owner', enabled: ['codex'] };
  next().scan('native', () => [gated], options);
  const wakeOptions = { now: NOW + 1, sessionId: 'owner', enabled: ['codex'], allowed: true };
  let intent = next().wake(() => [gated], wakeOptions);
  assert.equal(next().wake(() => [gated], { ...wakeOptions, deliveryId: intent.deliveryId, allowed: false }).allowed, false);
  intent = next().wake(() => [gated], wakeOptions);
  assert.notEqual(intent.deliveryId, null, 'deferred quota decision can retry');
  assert.equal(next().wake(() => [observation()], { ...wakeOptions, deliveryId: intent.deliveryId }).allowed, false, 'resolved gate does not wake');
  for (const extra of [{ revision: 5 }, { controller: { sessionId: 'other' } }, { provider: 'cursor' }]) {
    const isolated = new NotificationHandoff({ stateDirectory: path.dirname(next().directory), sessionId: 'owner', projectDir: `/tmp/${Object.keys(extra)[0]}` });
    isolated.scan('native', () => [gated], options);
    const pending = isolated.wake(() => [gated], wakeOptions);
    assert.equal(isolated.wake(() => [observation({ ...gated.job, ...extra })], { ...wakeOptions, deliveryId: pending.deliveryId }).allowed, false);
  }
});

test('monitor closes watchers while native owns delivery and resumes fallback after release', (t) => {
  const { root } = fixture(t);
  let scans = 0, closed = false;
  const monitor = new DelegateMonitor({ sessionId: 'owner', projectDir: '/tmp/project',
    env: { DELEGATE_MONITOR: '1' }, store: { stateDirectory: root, directory: root,
      scan: () => { scans++; return []; }, readPreference: () => ({}) } });
  monitor.watchers.set('fake', { close: () => { closed = true; } });
  const native = new NotificationHandoff({ stateDirectory: root, sessionId: 'owner', projectDir: '/tmp/project' });
  native.scan('native', () => [], { now: Date.now() });
  assert.deepEqual(monitor.scan(), []);
  assert.equal(scans, 0);
  assert.equal(closed, true);
  native.release();
  monitor.scan();
  assert.equal(scans, 1);
  monitor.stop();
});

test('workspace and all monitors correlate their recipient without narrowing scope or missing the native lease', (t) => {
  const { root } = fixture(t);
  const now = Date.now();
  const processTable = [{ pid: 9101, ppid: 1, startTimeMs: now - 2000 }];
  assert.equal(writeSessionCorrelationMarker({ stateDirectory: root, sessionId: 'owner',
    workspaceId: '/tmp/project', coordinatorPid: 9101, processTable, now }).ok, true);
  for (const scope of ['workspace', 'all']) {
    let scans = 0;
    const native = new NotificationHandoff({ stateDirectory: root, scope,
      sessionId: 'owner', projectDir: '/tmp/project' });
    native.scan('native', () => [], { now });
    const monitor = new DelegateMonitor({ env: { DELEGATE_MONITOR_SCOPE: scope },
      projectDir: '/tmp/project', parentPid: 9101, processTable,
      store: { stateDirectory: root, directory: root,
        scan: () => { scans++; return []; }, readPreference: () => ({}) } });
    assert.equal(monitor.recipientSessionId, 'owner');
    assert.equal(monitor.effectiveScope, scope);
    assert.equal(monitor.degradation, null);
    assert.equal(monitor.correlation.record.effectiveScope, scope);
    assert.equal(monitor.handoff.file, native.file);
    assert.deepEqual(monitor.scan(), []);
    assert.equal(scans, 0);
    monitor.stop();
  }
});

test('unknown recipient does not narrow an explicitly broad monitor or mute another recipient', (t) => {
  const { root } = fixture(t);
  for (const scope of ['workspace', 'all']) {
    let scans = 0;
    const native = new NotificationHandoff({ stateDirectory: root, scope,
      sessionId: 'owner', projectDir: '/tmp/project' });
    native.scan('native', () => [], { now: Date.now() });
    const monitor = new DelegateMonitor({ env: { DELEGATE_MONITOR_SCOPE: scope },
      projectDir: '/tmp/project', correlation: { ok: false, reason: 'unavailable' },
      store: { stateDirectory: root, directory: root,
        scan: () => { scans++; return []; }, readPreference: () => ({}) } });
    assert.equal(monitor.effectiveScope, scope);
    assert.equal(monitor.recipientSessionId, null);
    assert.equal(monitor.degradation, null);
    assert.notEqual(monitor.handoff.file, native.file);
    assert.deepEqual(monitor.scan(), []);
    assert.equal(scans, 1);
    monitor.stop();
  }
});

test('handoff rejects symlinked and oversized records without touching their targets', (t) => {
  const { next, root } = fixture(t);
  const handoff = next();
  handoff.scan('native', () => [], { now: NOW });
  const target = path.join(root, 'untouched.json');
  fs.writeFileSync(target, '{}', { mode: 0o600 });
  fs.unlinkSync(handoff.file); fs.symlinkSync(target, handoff.file);
  assert.throws(() => handoff.release());
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  fs.unlinkSync(handoff.file);
  fs.writeFileSync(handoff.file, 'x'.repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => handoff.read(), /STATE_ERROR/);
});

test('batched input supersession respects the shared rate ceiling and snooze', () => {
  const policy = new NotificationPolicy({ cooldownMs: 0, maxLinesPerMinute: 6 });
  policy.observe([], { now: NOW });
  const pending = Array.from({ length: 20 }, (_, id) => observation({ id: `input-${id}`, pendingInput: { requestId: `q-${id}` } }));
  assert.equal(policy.observe(pending, { now: NOW + 1 }).length, 6);
  const resolved = pending.map((snapshot, index) => ({ job: { ...snapshot.job, pendingInput: null }, events: [
    { seq: 2, type: 'input.resolved', data: { requestId: `q-${index}`, outcome: 'answered' } }
  ] }));
  assert.deepEqual(policy.observe(resolved, { now: NOW + 2 }), []);
  assert.equal(policy.rate.emitted, 6);
  const quiet = new NotificationPolicy({ cooldownMs: 0, maxLinesPerMinute: 6 });
  quiet.observe([], { now: NOW }); quiet.observe(pending, { now: NOW + 1 });
  assert.deepEqual(quiet.observe(resolved, { now: NOW + 2, snoozed: true }), []);
});
