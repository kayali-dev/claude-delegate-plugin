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

test('bracketed paste keeps a two-line payload literal instead of emitting submit keys', () => {
  const pasted = decodeInput('\u001b[200~first line\nsecond line\u001b[201~', { final: true });
  assert.deepEqual(pasted.events, [{ type: 'paste', text: 'first line\nsecond line' }]);
  assert.ok(!pasted.events.includes('enter'));

  const batches = [];
  let scheduled = null;
  const input = new BufferedInput({
    schedule(callback) { scheduled = callback; return 1; },
    cancel() {},
    onFlush(events) { batches.push(events); }
  });
  input.push('\u001b[200~first line\n');
  scheduled();
  assert.deepEqual(batches, [], 'an unfinished bracketed paste never leaks embedded newlines');
  input.push('second line\u001b[201~');
  scheduled();
  assert.deepEqual(batches, [[{ type: 'paste', text: 'first line\nsecond line' }]]);
  input.close();

  const splitOpening = [];
  const fragmented = new BufferedInput({
    schedule(callback) { scheduled = callback; return 2; },
    cancel() {},
    onFlush(events) { splitOpening.push(events); }
  });
  fragmented.push('\u001b[20');
  scheduled();
  assert.deepEqual(splitOpening, [], 'a split opening marker remains buffered');
  fragmented.push('0~left\nright\u001b[201~');
  scheduled();
  assert.deepEqual(splitOpening, [[{ type: 'paste', text: 'left\nright' }]]);
  fragmented.close();
});

test('focus reporting and Ctrl-D decode without ambiguity', () => {
  assert.deepEqual(
    decodeInput('\u001b[I\u001b[O\u0004', { final: true }).events,
    ['focus-in', 'focus-out', 'ctrl-d']
  );
});

// Regression: a lone Escape byte is also a prefix of the bracketed-paste opener
// ESC[200~. Before the escape-timeout hold, the decoder kept it buffered with no
// timer left to drain it, so Esc only reached the controller when the user next
// pressed a key - every Esc-driven screen change appeared to need a second
// keystroke. See bin/lib/tui/input.mjs decodeInput/BufferedInput.

const ESC_BYTE = '\u001b';

function escHarness(options = {}) {
  const batches = [];
  let scheduled = null;
  const state = { clock: 0 };
  const input = new BufferedInput({
    now: () => state.clock,
    schedule(callback) { scheduled = callback; return 1; },
    cancel() {},
    onFlush(events) { batches.push(events); },
    ...options
  });
  return { input, batches, state, fire: () => scheduled() };
}

test('a lone Escape resolves on its own instead of waiting for the next keypress', () => {
  const h = escHarness();
  h.input.push(ESC_BYTE);
  h.state.clock = 16;
  h.fire();
  assert.deepEqual(h.batches, [], 'still ambiguous inside the escape timeout');
  h.state.clock = 60;
  h.fire();
  assert.deepEqual(h.batches, [['escape']], 'the escape timeout resolves it with no further input');
  h.input.close();
});

test('Escape reaches the controller under real timers', async () => {
  const batches = [];
  const input = new BufferedInput({ onFlush: (events) => batches.push(events), escapeTimeoutMs: 20 });
  input.push(ESC_BYTE);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(batches, [['escape']]);
  input.close();
});

test('an escape sequence split across chunks still coalesces instead of emitting a spurious escape', () => {
  const h = escHarness();
  h.input.push(ESC_BYTE);
  h.state.clock = 16;
  h.fire();
  assert.deepEqual(h.batches, [], 'held while the rest of the sequence may still arrive');
  h.state.clock = 30;
  h.input.push('[A');
  h.state.clock = 40;
  h.fire();
  assert.deepEqual(h.batches, [['up']], 'resolved as the arrow key, not escape plus literals');
  h.input.close();
});

test('no input byte can be held indefinitely once the terminal goes quiet', () => {
  const partials = [ESC_BYTE, `${ESC_BYTE}[`, `${ESC_BYTE}[2`, `${ESC_BYTE}[20`, `${ESC_BYTE}[200`, `${ESC_BYTE}[<64;10`];
  for (const raw of partials) {
    const h = escHarness();
    h.input.push(raw);
    h.state.clock = 10_000;
    h.fire();
    assert.ok(h.batches.length > 0, `held forever: ${JSON.stringify(raw)}`);
    assert.equal(h.input.raw, '', `buffer not drained: ${JSON.stringify(raw)}`);
    h.input.close();
  }
});

test('a paste whose terminator never arrives is delivered rather than wedging later keystrokes', () => {
  const h = escHarness();
  h.input.push(`${ESC_BYTE}[200~hello`);
  h.state.clock = 1000;
  h.fire();
  assert.deepEqual(h.batches, [], 'a paste body is held far longer than a keypress');
  h.state.clock = 6000;
  h.fire();
  assert.deepEqual(h.batches, [[{ type: 'paste', text: 'hello' }]]);
  assert.equal(h.input.raw, '');
  h.input.close();
});
