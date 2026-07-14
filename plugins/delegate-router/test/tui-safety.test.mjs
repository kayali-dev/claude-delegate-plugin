import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import { formatDisplayValue } from '../bin/lib/tui/display.mjs';
import { displayWidth } from '../bin/lib/tui/width.mjs';
import { detailViewModel, fleetViewModel } from '../bin/lib/tui/viewmodels.mjs';

const NOW = 1_700_000_000_000;

function nastyStore() {
  const id = 'codex-nasty-journal';
  const job = {
    id, provider: 'codex', transport: 'app-server', model: { requested: 'sol', tier: 4 }, mode: 'review', status: 'completed', phase: 'completed',
    revision: 4, cwd: '/work/nasty', createdAt: NOW / 1000 - 90, updatedAt: NOW / 1000 - 5, completedAt: NOW / 1000 - 5,
    managedBy: 'delegate-control', providerSessionId: 'thread-nasty', checkpoint: { items: [{ state: true }] },
    verification: { exitCode: Number.NaN, output: { tail: ['one', null, 'two'] } }, driftReport: { modified: [{ path: 'src/🙂.mjs' }] },
    resumable: { ok: true }, objectiveMet: false, scopeViolations: [{ path: { nested: 'outside' } }], error: { code: 'SAFE', detail: null }, errorCode: '',
    usage: { total: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }, maxOutputTokens: 100,
    changedFiles: { files: ['src/🙂.mjs'] }
  };
  const events = [
    { v: 1, seq: 1, at: 0, jobId: id, type: 'message.user', redacted: true, data: { text: '' } },
    { v: 1, seq: 2, jobId: id, type: 'message.delta', redacted: true, data: { id: 'awkward', delta: 'emoji 🙂 and '.repeat(20) + 'https://example.test/' + 'x'.repeat(300) } },
    { v: 1, seq: 3, at: NOW - 4000, jobId: id, type: 'tool.started', redacted: true, data: { item: { id: 'argv', type: 'commandExecution', command: ['node', '-e', 'console.log("literal\\n")'], title: null, cwd: '/work/nasty/sub', status: 'inProgress', locations: [{ path: '/work/nasty/src/🙂.mjs' }] } } },
    { v: 1, seq: 4, at: NOW - 3000, jobId: id, type: 'tool.output', redacted: true, data: { id: 'argv', output: { stdout: ['real\nlines', { structured: true }], metadata: null } } },
    { v: 1, seq: 5, at: NOW - 2000, jobId: id, type: 'tool.completed', redacted: true, data: { item: { id: 'argv', type: 'commandExecution', command: ['node', '-e', 'done'], status: 'completed', exitCode: 0, locations: [{ path: { uri: '/work/nasty/src/object.mjs' } }] } } },
    { v: 1, seq: 6, at: NOW - 1000, jobId: id, type: 'plan.updated', redacted: true, data: { plan: [{ step: { object: 'plan' }, status: null }] } },
    { v: 1, seq: 7, at: NOW, jobId: id, type: 'error', redacted: true, data: { code: null, message: { nested: ['safe', false] } } }
  ];
  return {
    jobs: [job], eventsByJob: { [id]: events }, hydrationByJob: { [id]: { loaded: true } },
    diffsByJob: { [id]: 'diff --git a/src/🙂.mjs b/src/🙂.mjs\n@@ -1 +1 @@\n-old\n+' + 'x'.repeat(500) },
    diffStatsByJob: { [id]: { files: [{ path: 'src/' + 'p'.repeat(300) + '.mjs', additions: 1, deletions: 1 }], totalAdditions: 1, totalDeletions: 1 } },
    providers: [], writerLocks: [], profiles: [], stats: { since: '7d', groups: [] }
  };
}

test('safe display formatting handles every provider value shape without implicit object coercion', () => {
  assert.equal(formatDisplayValue('literal\\ntext'), 'literal\\ntext');
  assert.equal(formatDisplayValue(['node', '--test']), 'node --test');
  assert.equal(formatDisplayValue(3), '3');
  assert.equal(formatDisplayValue(false), 'false');
  assert.equal(formatDisplayValue(null), '');
  assert.equal(formatDisplayValue(Number.NaN), '');
  assert.equal(formatDisplayValue({ command: ['node'], missing: null }), '{"command":["node"],"missing":""}');
  assert.ok(formatDisplayValue({ value: 'x'.repeat(300) }, { maxLength: 40 }).length <= 40);
});

test('nasty journal renders every detail tab and fleet without coercion artifacts or frame overflow', () => {
  const store = nastyStore();
  const frames = [fleetViewModel(store, { now: NOW }, { width: 100, height: 30 })];
  for (let detailTab = 0; detailTab < 5; detailTab += 1) {
    frames.push(detailViewModel(store, {
      jobId: 'codex-nasty-journal', detailTab, now: NOW, follow: false, transcriptSelection: 0,
      expandedTools: new Set(['argv']),
      ...(detailTab === 1 ? { diffFile: 'src/🙂.mjs', diffPaths: ['src/🙂.mjs'], diffWindow: { diff: store.diffsByJob['codex-nasty-journal'], offset: 0, totalChars: store.diffsByJob['codex-nasty-journal'].length } } : {})
    }, { width: 100, height: 30 }));
  }
  for (const frame of frames) {
    const rendered = renderFrameToString(frame);
    for (const forbidden of ['[object Object]', 'undefined', 'NaN', 'null']) assert.ok(!rendered.includes(forbidden), `${frame.screen} contains ${forbidden}`);
    const grid = paintFrame(frame);
    assert.equal(grid.columns, 100);
    assert.equal(grid.rows, 30);
    for (const line of grid.lines()) assert.ok(displayWidth(line) <= 100, `${frame.screen} line overflowed: ${displayWidth(line)}`);
  }
});
