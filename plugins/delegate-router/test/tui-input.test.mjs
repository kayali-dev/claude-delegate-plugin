import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferedInput, coalesceInputEvents, decodeInput } from '../bin/lib/tui/input.mjs';

test('SGR mouse wheel sequences decode to three-line scroll deltas', () => {
  const decoded = decodeInput('\u001b[<64;12;8M\u001b[<65;12;8M', { final: true });
  assert.deepEqual(decoded.events, ['wheel-up', 'wheel-down']);
  assert.deepEqual(coalesceInputEvents(['wheel-up']), [{ type: 'scroll', delta: -3 }]);
  assert.deepEqual(coalesceInputEvents(['wheel-down']), [{ type: 'scroll', delta: 3 }]);
  assert.deepEqual(decodeInput('\u001b[5~\u001b[6~\u001b[H\u001b[F', { final: true }).events, ['page-up', 'page-down', 'home', 'end']);
});

test('buffered arrows preserve every selection step while rendering once per tick', () => {
  let scheduled = null;
  let state = 0;
  let renders = 0;
  const input = new BufferedInput({
    schedule(callback) { scheduled = callback; return 1; },
    cancel() {},
    onFlush(events) {
      assert.deepEqual(events, Array(20).fill('down'));
      for (const event of events) state += event === 'down' ? 1 : -1;
      renders += 1;
    }
  });
  input.push('\u001b[B'.repeat(20));
  assert.equal(renders, 0);
  scheduled();
  assert.equal(state, 20);
  assert.equal(renders, 1);
  input.close();
});

test('only wheel motion coalesces into viewport scroll while arrows stay logical', () => {
  assert.deepEqual(
    coalesceInputEvents(['down', 'down', 'wheel-down', 'wheel-down', 'up', 'wheel-up']),
    ['down', 'down', { type: 'scroll', delta: 6 }, 'up', { type: 'scroll', delta: -3 }]
  );
});

test('input decoder retains split escape sequences until the next chunk', () => {
  const callbacks = [];
  let scheduled = null;
  const input = new BufferedInput({
    schedule(callback) { scheduled = callback; return 1; },
    cancel() {},
    onFlush(events) { callbacks.push(events); }
  });
  input.push('\u001b[<64;10;');
  input.push('5M');
  scheduled();
  assert.deepEqual(callbacks, [[{ type: 'scroll', delta: -3 }]]);
  input.close();
});
