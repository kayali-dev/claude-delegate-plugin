import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityTransitionEmitter, codexActivitySignal, cursorAcpActivitySignal } from '../bin/lib/providers.mjs';
import { ACTIVITY_CAPABILITIES, deriveJobActivity } from '../bin/lib/tui/activity.mjs';

const NOW = 1_700_000_100_000;
const baseJob = { id: 'job', provider: 'codex', transport: 'app-server', status: 'running', phase: 'running', cwd: '/work', createdAt: NOW / 1000 - 100, updatedAt: NOW / 1000 - 10 };

function event(seq, type, data = {}, ageMs = 1000) {
  return { seq, type, at: NOW - ageMs, data };
}

test('activity precedence ranks approval, input, tool, thinking, streaming, phase, quiet, and stalled', () => {
  const sequences = [
    ['approval', [event(1, 'approval.requested')]],
    ['needs-input', [event(1, 'error', { code: 'USER_INPUT_REQUIRED' })]],
    ['tool', [event(1, 'tool.started', { item: { id: 't', type: 'commandExecution', command: 'bun test' } })]],
    ['thinking', [event(1, 'activity', { kind: 'thinking' })]],
    ['streaming', [event(1, 'message.delta', { id: 'm', delta: 'x' }, 2999)]],
    ['verifying', []],
    ['quiet', [event(1, 'message.completed', { text: 'done' }, 30_001)]],
    ['stalled', [event(1, 'message.completed', { text: 'done' }, 300_001)]]
  ];
  for (const [expected, events] of sequences) {
    const job = expected === 'verifying' ? { ...baseJob, phase: 'verifying' } : baseJob;
    assert.equal(deriveJobActivity(job, events, { now: NOW, stallSeconds: 300 }).kind, expected);
  }
  const all = [
    event(1, 'activity', { kind: 'thinking' }),
    event(2, 'message.delta', { delta: 'x' }),
    event(3, 'tool.started', { item: { id: 't', type: 'commandExecution', command: 'cmd' } }),
    event(4, 'error', { code: 'USER_INPUT_REQUIRED' }),
    event(5, 'approval.requested')
  ];
  assert.equal(deriveJobActivity(baseJob, all, { now: NOW }).kind, 'approval');
});

test('three-second streaming and thirty-second quiet windows honor boundary clocks', () => {
  assert.equal(deriveJobActivity(baseJob, [event(1, 'message.delta', {}, 3000)], { now: NOW }).kind, 'streaming');
  assert.equal(deriveJobActivity(baseJob, [event(1, 'message.delta', {}, 3001)], { now: NOW }).kind, 'working');
  assert.equal(deriveJobActivity(baseJob, [event(1, 'message.completed', {}, 30_000)], { now: NOW }).kind, 'working');
  assert.equal(deriveJobActivity(baseJob, [event(1, 'message.completed', {}, 30_001)], { now: NOW }).kind, 'quiet');
});

test('open first-class and legacy compactions are active until completion', () => {
  const started = event(1, 'compaction.started', { itemId: 'compact' }, 45_000);
  const current = deriveJobActivity(baseJob, [started], { now: NOW });
  assert.equal(current.kind, 'compacting');
  assert.equal(current.label, 'compacting');
  assert.equal(current.sourceSeq, 1);

  const legacy = deriveJobActivity(baseJob, [event(1, 'provider.event', {
    providerEvent: 'item/started', itemType: 'contextCompaction', itemId: 'compact'
  }, 45_000)], { now: NOW });
  assert.equal(legacy.kind, 'compacting');

  const completed = deriveJobActivity(baseJob, [started, event(2, 'compaction.completed', { itemId: 'compact' }, 1000)], { now: NOW });
  assert.equal(completed.kind, 'working');
  assert.notEqual(completed.kind, 'quiet');
});

test('transport capability truth table reflects streamed headless thinking and tools without inventing approvals', () => {
  assert.equal(ACTIVITY_CAPABILITIES['codex:app-server'].visibility, 'full');
  assert.equal(ACTIVITY_CAPABILITIES['cursor:acp'].visibility, 'near-full');
  assert.equal(ACTIVITY_CAPABILITIES['cursor:headless'].visibility, 'near-full');
  const thought = [event(1, 'activity', { kind: 'thinking' })];
  assert.equal(deriveJobActivity(baseJob, thought, { now: NOW }).kind, 'thinking');
  assert.equal(deriveJobActivity({ ...baseJob, provider: 'cursor', transport: 'acp' }, thought, { now: NOW }).kind, 'thinking');
  const headless = deriveJobActivity({ ...baseJob, provider: 'cursor', transport: 'headless' }, thought, { now: NOW });
  assert.equal(headless.kind, 'thinking');
  assert.equal(headless.visibilityNote, undefined);
  const headlessTool = deriveJobActivity({ ...baseJob, provider: 'cursor', transport: 'headless' }, [event(1, 'tool.started', { toolCallId: 'x', title: 'Edit' })], { now: NOW });
  assert.equal(headlessTool.kind, 'tool');
  const sequence = [
    event(1, 'message.delta', { delta: 'x' }, 2000),
    event(2, 'activity', { kind: 'thinking' }, 1000)
  ];
  assert.equal(deriveJobActivity(baseJob, sequence, { now: NOW }).kind, 'thinking');
  assert.equal(deriveJobActivity({ ...baseJob, provider: 'cursor', transport: 'acp' }, sequence, { now: NOW }).kind, 'thinking');
  assert.equal(deriveJobActivity({ ...baseJob, provider: 'cursor', transport: 'headless' }, sequence, { now: NOW }).kind, 'thinking');
  assert.equal(deriveJobActivity({ ...baseJob, provider: 'cursor', transport: 'headless' }, [event(1, 'message.delta', {}, 30_001)], { now: NOW }).kind, 'quiet');
});

test('content-free activity markers emit on transitions only and coalesce bursts', () => {
  let now = 0;
  let scheduled = null;
  const emitted = [];
  const marker = new ActivityTransitionEmitter('job', {
    now: () => now,
    schedule(callback) { scheduled = callback; return { unref() {} }; },
    cancel() {},
    emit(kind, at) { emitted.push({ kind, at }); }
  });
  for (let index = 0; index < 500; index += 1) marker.mark(index % 2 === 0 ? 'thinking' : 'output');
  assert.deepEqual(emitted, [{ kind: 'thinking', at: 0 }]);
  now = 2000;
  scheduled();
  assert.deepEqual(emitted, [{ kind: 'thinking', at: 0 }, { kind: 'output', at: 0 }]);
  assert.ok(emitted.length <= 2, '500 alternating chunks must remain bounded');
  marker.close();
});

test('Codex reasoning and ACP thought chunks drive the same bounded transition marker', () => {
  const run = (signalAt) => {
    let now = 0;
    let scheduled = null;
    const emitted = [];
    const marker = new ActivityTransitionEmitter('job', {
      now: () => now,
      schedule(callback) { scheduled = callback; return { unref() {} }; },
      cancel() {},
      emit(kind, at) { emitted.push({ kind, at }); }
    });
    for (let index = 0; index < 500; index += 1) marker.mark(signalAt(index));
    now = 2000;
    scheduled?.();
    marker.close();
    return emitted;
  };
  const codex = run((index) => codexActivitySignal('', { type: index % 2 === 0 ? 'reasoning' : 'agentMessage' }));
  const acp = run((index) => cursorAcpActivitySignal({ sessionUpdate: index % 2 === 0 ? 'agent_thought_chunk' : 'agent_message_chunk' }));
  assert.deepEqual(acp, codex);
  assert.deepEqual(codex, [{ kind: 'thinking', at: 0 }, { kind: 'output', at: 0 }]);
});
