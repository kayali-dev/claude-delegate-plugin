import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CellGrid, Screen } from '../bin/lib/tui/screen.mjs';
import { TerminalOutputCapture } from '../bin/lib/tui/terminal-output.mjs';
import { assertVtMatchesGrid, ByteVirtualTerminal } from './helpers/tui-vt.mjs';

function fakeTerminal(columns = 20, rows = 4) {
  const vt = new ByteVirtualTerminal(columns, rows);
  const wire = [];
  const stream = (name) => ({
    columns, rows, isTTY: true,
    write(value, _encoding, callback) {
      const text = String(value ?? '');
      wire.push({ name, text });
      vt.apply(text);
      if (typeof callback === 'function') callback();
      return true;
    }
  });
  return { vt, wire, stdout: stream('stdout'), stderr: stream('stderr') };
}

test('terminal ownership captures stray streams and console output until suspend or exit', () => {
  const terminal = fakeTerminal();
  const warnings = new EventEmitter();
  const fakeConsole = {};
  for (const [name, stream] of [['log', terminal.stdout], ['info', terminal.stdout], ['debug', terminal.stdout], ['warn', terminal.stderr], ['error', terminal.stderr]]) {
    fakeConsole[name] = (...args) => stream.write(`${args.join(' ')}\n`);
  }
  const entries = [];
  const originalStdoutWrite = terminal.stdout.write;
  const originalStderrWrite = terminal.stderr.write;
  const capture = new TerminalOutputCapture({
    stdout: terminal.stdout, stderr: terminal.stderr, console: fakeConsole, process: warnings,
    onEntry(entry) { entries.push(entry); }
  });
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {} };
  const screen = new Screen({ outputCapture: capture, input, columns: 20, rows: 4, colorMode: '256' });
  screen.start();
  const grid = new CellGrid(20, 4);
  grid.write(0, 0, 'xunction assistant');
  screen.render(grid);
  const intended = grid.clone();
  intended.set(0, 0, 'f');
  screen.render(intended);
  assertVtMatchesGrid(terminal.vt, intended, 'before captured diagnostic');
  const vulnerable = new ByteVirtualTerminal(20, 4);
  for (const write of terminal.wire) vulnerable.apply(write.text);
  vulnerable.apply('i');
  assert.equal(vulnerable.cells[0].slice(0, 8).map((cell) => cell.char).join(''), 'finction', 'an uncaptured byte at the retained cursor reproduces the owner-reported substitution');

  const wireBefore = terminal.wire.length;
  fakeConsole.error('i');
  terminal.stdout.write('captured stdout\n');
  warnings.emit('warning', { name: 'ScriptedWarning', message: 'safe diagnostic' });
  capture.flush();
  assert.equal(terminal.wire.length, wireBefore, 'active stray writes never reach the TTY bytes');
  assertVtMatchesGrid(terminal.vt, intended, 'stray i cannot turn function into finction');
  assert.deepEqual(entries.map((entry) => [entry.stream, entry.text]), [
    ['stderr', 'i'], ['stdout', 'captured stdout'], ['stderr', '[warning] ScriptedWarning: safe diagnostic']
  ]);

  screen.suspend();
  const suspendedWrites = terminal.wire.length;
  fakeConsole.error('editor diagnostic');
  assert.equal(terminal.wire.length, suspendedWrites + 1, 'suspend restores the child/editor TTY');
  screen.resume();
  fakeConsole.error('captured after resume');
  capture.flush();
  assert.equal(entries.at(-1).text, 'captured after resume');
  screen.stop();
  assert.equal(terminal.stdout.write, originalStdoutWrite);
  assert.equal(terminal.stderr.write, originalStderrWrite);
  const stoppedWrites = terminal.wire.length;
  terminal.stdout.write('shell output\n');
  assert.equal(terminal.wire.length, stoppedWrites + 1, 'exit restores the real stream writer');
});
