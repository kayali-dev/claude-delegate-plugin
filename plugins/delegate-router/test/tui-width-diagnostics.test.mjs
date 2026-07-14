import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeTuiDiagnostics, readDiagnosticBytes, TuiFlightRecorder } from '../bin/lib/tui/diagnostics.mjs';
import { CHROME_GLYPHS, configureGlyphs, GLYPH_TIERS, glyphConfiguration, normalizeChromePunctuation } from '../bin/lib/tui/glyphs.mjs';
import { decodeInput } from '../bin/lib/tui/input.mjs';
import { CellGrid, Screen } from '../bin/lib/tui/screen.mjs';
import { ReplayVirtualTerminal } from '../bin/lib/tui/vt-model.mjs';
import {
  classifyGraphemeWidth,
  clearGraphemeWidthOverrides,
  EAST_ASIAN_AMBIGUOUS_RANGES,
  graphemeWidth,
  isEastAsianAmbiguousCodePoint,
  isWidthSuspect,
  splitGraphemes,
  setGraphemeWidthOverrides
} from '../bin/lib/tui/width.mjs';
import {
  formatWidthProbeResult,
  probeTerminalWidths,
  terminalWidthIdentity,
  WIDTH_PROBE_GRAPHEMES,
  WIDTH_PROBE_VERSION
} from '../bin/lib/tui/width-probe.mjs';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-diag-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function outputCapture(columns = 60, rows = 6) {
  return { text: '', columns, rows, isTTY: true, write(value) { this.text += String(value); return true; } };
}

async function deliverProbeChunks(chunks, options = {}) {
  const input = new EventEmitter();
  const writes = [];
  const screen = {
    rows: 20, input,
    writeOutput(value, meta) {
      writes.push({ value, meta });
      if (meta.context !== 'probe' || !String(value).includes('\u001b[6n')) return;
      queueMicrotask(async () => {
        for (const chunk of chunks) {
          input.emit('data', chunk);
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
    }
  };
  const result = await probeTerminalWidths({
    screen, input, env: {}, probes: options.probes || ['A', 'B', 'C'], timeoutMs: options.timeoutMs || 30
  });
  return { result, writes };
}

test('width classification is conservative and runtime probe overrides are exact', (t) => {
  t.after(clearGraphemeWidthOverrides);
  for (const glyph of ['A', '+', '|', '⠋', '界']) assert.equal(classifyGraphemeWidth(glyph).kind, 'certain', glyph);
  for (const glyph of ['é', '┌', '·', '…', '–', '—', '°', '±', 'Ω', 'Ж', 'e\u0301', '⚙', '🙂', '✈️', '👩‍💻', '👍🏽', `a\u0301\u0323`, '\u0378']) {
    assert.equal(isWidthSuspect(glyph), true, glyph);
  }
  assert.equal(EAST_ASIAN_AMBIGUOUS_RANGES.length / 2, 198, 'Unicode 17 table contains every explicit Ambiguous range');
  for (const glyph of ['·', '…', '–', '—', '°', '±', 'Ω', 'Ж', '┌']) assert.equal(isEastAsianAmbiguousCodePoint(glyph.codePointAt(0)), true, glyph);
  for (const glyph of ['A', '|', '⠋', '界']) assert.equal(isEastAsianAmbiguousCodePoint(glyph.codePointAt(0)), false, glyph);
  assert.equal(graphemeWidth('⚙'), 2);
  setGraphemeWidthOverrides({ '⚙': 1 });
  assert.equal(graphemeWidth('⚙'), 1);
  assert.equal(graphemeWidth('A'), 1);
});

test('terminal identity distinguishes tmux from the same outer terminal', () => {
  const outer = { TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2' };
  assert.notEqual(terminalWidthIdentity(outer), terminalWidthIdentity({ ...outer, TMUX: '/tmp/tmux-1/default,1,0' }));
  assert.match(terminalWidthIdentity({ ...outer, TMUX: 'present' }), /mux=tmux/);
  assert.match(terminalWidthIdentity({ TERM: 'tmux-256color', TERM_PROGRAM: 'ghostty' }), /mux=tmux/);
  assert.match(terminalWidthIdentity(outer), new RegExp(`probeVersion=${WIDTH_PROBE_VERSION}(?:\\||$)`));
});

test('width probe covers every elegant chrome family before it may be selected', () => {
  const required = [
    '─', '│', '┌', '┐', '└', '┘', '├', '┤', '╭', '╮', '╰', '╯',
    '┃', '░', '█', '▏', '▎', '▍', '▌', '▋', '▊', '▉',
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '·', '…'
  ];
  for (const glyph of required) assert.ok(WIDTH_PROBE_GRAPHEMES.includes(glyph), `probe includes ${JSON.stringify(glyph)}`);
  for (const value of Object.values(GLYPH_TIERS.elegant)) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) for (const glyph of splitGraphemes(candidate)) {
      if (/^[\x20-\x7e]$/.test(glyph)) continue;
      assert.ok(WIDTH_PROBE_GRAPHEMES.includes(glyph), `elegant glyph ${JSON.stringify(glyph)} is measured`);
    }
  }
});

test('sparkline glyph tier is selected as one probe-proven family and never mixed', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  const env = { TERM: 'tmux-256color', LANG: 'en_US.UTF-8' };
  const partial = Object.fromEntries(GLYPH_TIERS.elegant.spark.slice(0, -1).map((glyph) => [glyph, 1]));
  configureGlyphs({ env, widths: partial });
  assert.deepEqual(CHROME_GLYPHS.spark, GLYPH_TIERS.safeUnicode.spark);
  assert.ok(CHROME_GLYPHS.spark.every((glyph) => /^[\x20-\x7e]$/.test(glyph)), 'partial probe falls back to one ASCII family');

  const complete = Object.fromEntries(GLYPH_TIERS.elegant.spark.map((glyph) => [glyph, 1]));
  configureGlyphs({ env, widths: complete });
  assert.deepEqual(CHROME_GLYPHS.spark, GLYPH_TIERS.elegant.spark);
  assert.ok(CHROME_GLYPHS.spark.every((glyph) => GLYPH_TIERS.elegant.spark.includes(glyph)), 'complete probe selects the complete elegant family');
});

test('TUI-owned chrome gates every ambiguous literal behind the measured elegant tier', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'lib', 'tui');
  configureGlyphs({ env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, widths: {} });
  for (const [name, value] of Object.entries(CHROME_GLYPHS)) {
    const values = Array.isArray(value) ? value : [value];
    for (const candidate of values) for (const glyph of splitGraphemes(candidate)) assert.equal(isWidthSuspect(glyph), false, `${name} fallback uses width-certain ${JSON.stringify(glyph)}`);
  }
  for (const tier of ['safeUnicode', 'ascii']) for (const value of Object.values(GLYPH_TIERS[tier])) {
    const values = Array.isArray(value) ? value : [value];
    for (const candidate of values) for (const glyph of splitGraphemes(candidate)) assert.equal(isWidthSuspect(glyph), false, `${tier} owns only certain ${JSON.stringify(glyph)}`);
  }
  for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.mjs') && !['glyphs.mjs', 'width-probe.mjs'].includes(name))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const symbol of Array.from(source)) {
      if (symbol.codePointAt(0) < 0x80) continue;
      assert.equal(isEastAsianAmbiguousCodePoint(symbol.codePointAt(0)), false, `${file} contains no literal Ambiguous code point ${JSON.stringify(symbol)}`);
      assert.equal(isWidthSuspect(symbol), false, `${file} contains no literal suspect code point ${JSON.stringify(symbol)}`);
    }
  }
  const executable = fs.readFileSync(path.join(root, '..', '..', 'delegate-tui'), 'utf8');
  for (const symbol of Array.from(executable)) {
    if (symbol.codePointAt(0) < 0x80) continue;
    assert.equal(isWidthSuspect(symbol), false, `delegate-tui contains no raw suspect chrome ${JSON.stringify(symbol)}`);
  }
  const measured = Object.fromEntries(WIDTH_PROBE_GRAPHEMES.map((glyph) => [glyph, 1]));
  configureGlyphs({ env: { TERM: 'tmux-256color', LANG: 'en_US.UTF-8' }, widths: measured });
  assert.equal(glyphConfiguration().mode, 'probed-elegant');
  assert.equal(CHROME_GLYPHS.cornerTopLeft, GLYPH_TIERS.elegant.cornerTopLeft);
  assert.equal(CHROME_GLYPHS.separator, GLYPH_TIERS.elegant.separator);
  assert.equal(CHROME_GLYPHS.meter[3], GLYPH_TIERS.elegant.meter[3]);
  configureGlyphs({ env: { TERM: 'tmux-256color', LANG: 'en_US.UTF-8', DELEGATE_TUI_ASCII: '1' }, widths: measured });
  assert.equal(glyphConfiguration().mode, 'ascii');
  assert.equal(CHROME_GLYPHS.cornerTopLeft, '+');
  assert.equal(normalizeChromePunctuation('Revert plan \u00b7 id \u2026'), 'Revert plan | id ..');
});

test('runtime CPR probe measures the interposed terminal and cached/off modes do not write', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const input = new EventEmitter();
  const writes = [];
  const screen = {
    rows: 20, input,
    writeOutput(value, meta) {
      writes.push({ value, meta });
      if (meta.context === 'probe' && String(value).includes('\u001b[6n')) queueMicrotask(() => input.emit('data', '\u001b[20;2R\u001b[20;3R'));
    }
  };
  const measured = await probeTerminalWidths({ screen, input, env: {}, probes: ['⚙', '🙂'], timeoutMs: 20 });
  assert.deepEqual(measured.widths, { '⚙': 1, '🙂': 2 });
  assert.equal(measured.source, 'probe');
  assert.ok(measured.elapsedMs < 50, `probe took ${measured.elapsedMs}ms`);
  assert.ok(writes.every((write) => write.meta.context === 'probe'));

  writes.length = 0;
  const cached = await probeTerminalWidths({ screen, input, cached: { widths: { '⚙': 1 } } });
  assert.equal(cached.source, 'cache');
  assert.equal(writes.length, 0);
  const off = await probeTerminalWidths({ screen, input, mode: 'off' });
  assert.equal(off.source, 'off');
  assert.equal(writes.length, 0);
});

test('runtime CPR probe parses coalesced, fragmented, and noisy delivery without losing replies', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const coalesced = await deliverProbeChunks(['\u001b[20;2R\u001b[20;3R\u001b[20;2R']);
  assert.deepEqual(coalesced.result.widths, { A: 1, B: 2, C: 1 });
  assert.deepEqual(coalesced.result.outcomes.map((entry) => entry.status), ['measured', 'measured', 'measured']);

  const fragmented = await deliverProbeChunks(['\u001b[20;', '2R\u001b[20;3', 'R\u001b[20;2R']);
  assert.deepEqual(fragmented.result.widths, { A: 1, B: 2, C: 1 });

  const noisy = await deliverProbeChunks([
    '\u001b[I\u001b[<64;20;4Mterminal chatter\u001b[20;2R',
    '\u001b[O\u001b[20;3R\u001b[<65;20;4M\u001b[20;2R'
  ]);
  assert.deepEqual(noisy.result.widths, { A: 1, B: 2, C: 1 });
  assert.deepEqual(noisy.result.outcomes.map((entry) => entry.status), ['measured', 'measured', 'measured']);
});

test('runtime CPR probe isolates malformed and missing replies by ordered outcome', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const malformed = await deliverProbeChunks(['\u001b[20;watR\u001b[20;3R\u001b[20;2R']);
  assert.deepEqual(malformed.result.widths, { B: 2, C: 1 });
  assert.deepEqual(malformed.result.outcomes.map((entry) => entry.status), ['parse', 'measured', 'measured']);

  const missing = await deliverProbeChunks(['\u001b[20;2R\u001b[20;3R'], { probes: ['A', 'B', 'C', 'D'], timeoutMs: 10 });
  assert.deepEqual(missing.result.widths, { A: 1, B: 2 });
  assert.deepEqual(missing.result.outcomes.map((entry) => entry.status), ['measured', 'measured', 'timeout', 'timeout']);
});

test('verbose width-probe result reports measured, parse, and timeout family outcomes', () => {
  const message = formatWidthProbeResult({
    source: 'probe', elapsedMs: 12.5,
    outcomes: [
      { grapheme: '─', status: 'measured', width: 1 },
      { grapheme: '┃', status: 'parse' },
      { grapheme: '▁', status: 'timeout' }
    ]
  });
  assert.match(message, /borders=measured-width\(1\)/);
  assert.match(message, /scrollbar=unproven\(parse\)/);
  assert.match(message, /sparkline=unproven\(timeout\)/);
});

test('the full elegant glyph set proves under one coalesced CPR delivery', async (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  t.after(clearGraphemeWidthOverrides);
  const replies = WIDTH_PROBE_GRAPHEMES.map(() => '\u001b[20;2R').join('');
  const { result } = await deliverProbeChunks([replies], { probes: WIDTH_PROBE_GRAPHEMES });
  assert.equal(Object.keys(result.widths).length, WIDTH_PROBE_GRAPHEMES.length);
  configureGlyphs({ env: { TERM: 'xterm-ghostty', LANG: 'en_US.UTF-8' }, widths: result.widths });
  assert.equal(glyphConfiguration().mode, 'probed-elegant');
  for (const [key, value] of Object.entries(GLYPH_TIERS.elegant)) assert.deepEqual(CHROME_GLYPHS[key], value, key);
});

test('suspect graphemes are isolated by CUP so adversarial width disagreement cannot move neighboring ASCII', () => {
  const output = outputCapture(70, 2);
  const screen = new Screen({ output, input: {}, columns: 70, rows: 2, colorMode: '256' });
  const corpus = 'A⚙function 🙂 assistant 👩‍💻 remains plain ASCII';
  const grid = new CellGrid(70, 2);
  grid.write(0, 0, corpus);
  const bytes = screen.render(grid);
  const terminal = new ReplayVirtualTerminal(70, 2, {
    widthOf(grapheme) {
      const ordinary = graphemeWidth(grapheme);
      return isWidthSuspect(grapheme) ? (ordinary === 1 ? 2 : 1) : ordinary;
    }
  });
  terminal.apply(bytes);
  const suspectCells = new Set();
  for (let x = 0; x < grid.columns; x += 1) {
    const cell = grid.get(x, 0);
    if (!cell.continuation && isWidthSuspect(cell.char)) {
      suspectCells.add(x);
      for (let width = 1; width < graphemeWidth(cell.char); width += 1) suspectCells.add(x + width);
    }
  }
  for (let x = 0; x < grid.columns; x += 1) {
    if (suspectCells.has(x)) continue;
    assert.equal(terminal.cells[0][x].char, grid.get(x, 0).char, `neighbor cell ${x} remains confined`);
  }
  for (const match of bytes.matchAll(/⚙|🙂|👩‍💻/gu)) {
    const suffix = bytes.slice(match.index + match[0].length);
    assert.match(suffix, /^\u001b\[\d+;\d+H/, `${match[0]} is followed by absolute CUP`);
  }
});

test('flight recorder round-trips bytes and frames, and markers land in both logs', (t) => {
  const directory = temporaryDirectory(t);
  const recorder = new TuiFlightRecorder(directory);
  const output = outputCapture(24, 3);
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {} };
  const screen = new Screen({ output, input, columns: 24, rows: 3, colorMode: '256', diagnostics: recorder });
  screen.start();
  const grid = new CellGrid(24, 3);
  grid.write(0, 0, 'assistant 🙂 function');
  screen.render(grid);
  const marker = screen.markDiagnostic();
  screen.stop();
  assert.equal(marker.frame, 1);
  const bytes = readDiagnosticBytes(path.join(directory, 'bytes.log'));
  assert.equal(Buffer.concat(bytes.filter((record) => record.type === 'bytes').map((record) => record.payload)).toString('utf8'), output.text);
  assert.ok(bytes.some((record) => record.type === 'marker' && record.frame === 1));
  const frames = fs.readFileSync(path.join(directory, 'frames.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(frames.some((record) => record.type === 'frame' && record.frame === 1 && record.runs.length));
  assert.ok(frames.some((record) => record.type === 'marker' && record.frame === 1));
  const report = analyzeTuiDiagnostics(directory);
  assert.match(report, /MARKER frame 1: TERMINAL-SIDE INTERPRETATION verdict/);
  assert.match(report, /earlier width-suspect signature: "🙂"/);
});

test('flight analyzer identifies a corrupted emitted byte as a writer bug with a byte window', (t) => {
  const directory = temporaryDirectory(t);
  const recorder = new TuiFlightRecorder(directory);
  const output = outputCapture(24, 2);
  const screen = new Screen({ output, input: {}, columns: 24, rows: 2, colorMode: '256', diagnostics: recorder });
  const grid = new CellGrid(24, 2);
  grid.write(0, 0, 'assistant function');
  screen.render(grid);
  screen.markDiagnostic();
  recorder.close();
  const file = path.join(directory, 'bytes.log');
  const frameRecord = readDiagnosticBytes(file).find((record) => record.type === 'bytes' && record.context === 'frame');
  const relative = frameRecord.payload.indexOf(Buffer.from('function'));
  assert.ok(relative >= 0);
  const descriptor = fs.openSync(file, 'r+');
  fs.writeSync(descriptor, Buffer.from('i'), 0, 1, frameRecord.fileOffset + relative + 1);
  fs.closeSync(descriptor);
  const report = analyzeTuiDiagnostics(directory);
  assert.match(report, /WRITER BUG at \d+:\d+/);
  assert.match(report, /hex:/);
  assert.match(report, /ascii:/);
  assert.match(report, /MARKER frame 1: WRITER BUG verdict/);
});

test('Ctrl-G is decoded as a dedicated snapshot key', () => {
  assert.deepEqual(decodeInput('\u0007', { final: true }).events, ['ctrl-g']);
});
