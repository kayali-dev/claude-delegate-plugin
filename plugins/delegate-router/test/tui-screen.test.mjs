import assert from 'node:assert/strict';
import test from 'node:test';
import { mouseReportingOff, mouseReportingOn, sequences } from '../bin/lib/tui/ansi.mjs';
import { uiPalette } from '../bin/lib/tui/palette.mjs';
import { CellGrid, Screen, renderGridToString } from '../bin/lib/tui/screen.mjs';

function capture() {
  return {
    text: '', columns: 20, rows: 4, isTTY: true,
    write(value) { this.text += value; return true; }
  };
}

test('cell grids preserve wide glyph columns and expose a deterministic headless rendering', () => {
  const grid = new CellGrid(6, 2);
  grid.write(0, 0, 'A界B');
  grid.write(0, 1, '🙂x');
  assert.equal(renderGridToString(grid), 'A界B  \n🙂x   ');
});

test('screen double buffering emits only the changed run after the first frame', () => {
  const output = capture();
  const screen = new Screen({ output, input: {}, columns: 8, rows: 2, colorMode: '256' });
  const first = new CellGrid(8, 2);
  first.write(0, 0, 'fleet');
  first.write(0, 1, 'steady');
  const initial = screen.render(first);
  assert.match(initial, /fleet/);
  assert.match(initial, /steady/);

  const second = first.clone();
  second.set(2, 0, 'X', uiPalette.running);
  const diff = screen.render(second);
  assert.match(diff, /\u001b\[1;3H/);
  assert.match(diff, /X/);
  assert.doesNotMatch(diff, /steady|fleet/);
});

test('resize invalidates the previous frame and forces a full repaint', () => {
  const output = capture();
  const screen = new Screen({ output, input: {}, columns: 4, rows: 1 });
  const first = new CellGrid(4, 1);
  first.write(0, 0, 'same');
  screen.render(first);
  assert.equal(screen.render(first.clone()), '');
  assert.equal(screen.resize(5, 1), true);
  const resized = new CellGrid(5, 1);
  resized.write(0, 0, 'same');
  const repaint = screen.render(resized);
  assert.match(repaint, new RegExp(sequences.clearScreen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(repaint, /same/);
});

test('normal, signal, and exception exits all disable mouse and restore the terminal', () => {
  for (const [name, invoke, expectedExit] of [
    ['normal', (screen) => screen.stop(), null],
    ['SIGINT', (screen) => screen.boundSigint(), 130],
    ['SIGTERM', (screen) => screen.boundSigterm(), 143],
    ['uncaught exception', (screen) => screen.boundException(new Error('scripted')), 1]
  ]) {
    const output = capture();
    const raw = [];
    const exits = [];
    const input = { isTTY: true, setRawMode(value) { raw.push(value); }, resume() {}, pause() {} };
    const screen = new Screen({ output, input, columns: 8, rows: 2, exit(code) { exits.push(code); }, errorOutput: { write() {} } });
    screen.start();
    assert.match(output.text, new RegExp(mouseReportingOn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} enables mouse reporting`);
    invoke(screen);
    screen.stop();
    assert.deepEqual(raw, [true, false], `${name} restores raw mode once`);
    assert.deepEqual(exits, expectedExit == null ? [] : [expectedExit], `${name} preserves the exit code`);
    assert.ok(output.text.endsWith(`${sequences.reset}${mouseReportingOff}${sequences.cursorShow}${sequences.alternateScreenOff}`), `${name} emits mouse-off before leaving the alternate screen`);
  }
});
