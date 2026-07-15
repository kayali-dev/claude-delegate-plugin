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
import { loadTuiPreferences, saveTuiPreferences } from '../bin/lib/tui/preferences.mjs';
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

class ProbeInput extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isTTY = options.isTTY ?? true;
    this.isRaw = options.isRaw ?? false;
    this.paused = true;
    this.readable = [];
    this.rawModeCalls = [];
  }

  setRawMode(value) {
    this.rawModeCalls.push(Boolean(value));
    this.isRaw = Boolean(value);
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }

  resume() {
    this.paused = false;
    while (this.readable.length) this.emit('data', this.readable.shift());
    return this;
  }

  read() {
    return this.readable.shift() ?? null;
  }

  prebuffer(value) {
    this.readable.push(Buffer.from(String(value), 'utf8'));
  }
}

async function deliverProbeChunks(chunks, options = {}) {
  const input = new ProbeInput();
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
    screen, input, env: {}, probes: options.probes || ['A', 'B', 'C'], timeoutMs: options.timeoutMs || 30,
    backgroundIdleMs: options.backgroundIdleMs, backgroundBudgetMs: options.backgroundBudgetMs
  });
  return { result: options.awaitBackground && result.background ? await result.background.done : result, foreground: result, writes };
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
  const input = new ProbeInput();
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

test('runtime CPR probe owns raw stdin before writes and handles every reply latency', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  for (const delivery of ['synchronous', 'prebuffered', 'delayed']) {
    const input = new ProbeInput();
    const decoderBytes = [];
    const decoder = (chunk) => decoderBytes.push(String(chunk));
    input.on('data', decoder);
    const screen = {
      rows: 20, input,
      writeOutput(value, meta) {
        if (meta.context !== 'probe' || !String(value).includes('\u001b[6n')) return;
        assert.equal(input.isRaw, true, `${delivery}: raw mode precedes the first query`);
        assert.equal(input.listeners('data').includes(decoder), false, `${delivery}: decoder is suspended during the probe`);
        const reply = '\u001b[20;2R\u001b[20;3R';
        if (delivery === 'synchronous') input.emit('data', reply);
        else if (delivery === 'prebuffered') input.prebuffer(reply);
        else setTimeout(() => input.emit('data', reply), 30);
      }
    };
    const result = await probeTerminalWidths({ screen, input, env: {}, probes: ['A', 'B'], timeoutMs: 60 });
    assert.deepEqual(result.widths, { A: 1, B: 2 }, delivery);
    assert.deepEqual(result.outcomes.map((entry) => entry.status), ['measured', 'measured'], delivery);
    assert.deepEqual(decoderBytes, [], `${delivery}: CPR bytes never enter the input decoder`);
    assert.equal(input.listeners('data').includes(decoder), true, `${delivery}: decoder ownership is restored`);
  }

  const input = new ProbeInput();
  const timeout = await probeTerminalWidths({
    screen: { rows: 20, input, writeOutput() {} }, input, env: {}, probes: ['A'], timeoutMs: 10
  });
  assert.deepEqual(timeout.outcomes.map((entry) => entry.status), ['timeout']);
});

test('runtime CPR probe skips visibly when raw input cannot be established', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  const writes = [];
  const result = await probeTerminalWidths({
    screen: { rows: 20, input, writeOutput(value) { writes.push(value); } },
    input, env: {}, probes: ['─', '│']
  });
  assert.equal(result.source, 'fallback');
  assert.deepEqual(result.outcomes.map((entry) => entry.status), ['no-raw-mode', 'no-raw-mode']);
  assert.equal(writes.length, 0, 'canonical-mode terminals are never queried');
  assert.match(formatWidthProbeResult(result), /unproven\(no-raw-mode\)/);
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

  const missing = await deliverProbeChunks(['\u001b[20;2R\u001b[20;3R'], {
    probes: ['A', 'B', 'C', 'D'], timeoutMs: 10, backgroundIdleMs: 15, backgroundBudgetMs: 100, awaitBackground: true
  });
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

test('pipelined probe proves all 57 glyphs at local and ssh-like RTTs', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const replies = WIDTH_PROBE_GRAPHEMES.map(() => '\u001b[20;2R').join('');
  for (const delayMs of [1, 20]) {
    const input = new ProbeInput();
    const screen = {
      rows: 20, input,
      writeOutput(value, meta) {
        if (meta.context === 'probe' && String(value).includes('\u001b[6n')) setTimeout(() => input.emit('data', replies), delayMs);
      }
    };
    const result = await probeTerminalWidths({ screen, input, probes: WIDTH_PROBE_GRAPHEMES, timeoutMs: 40 });
    assert.equal(Object.keys(result.widths).length, 57, `${delayMs}ms batch proves the complete set`);
    assert.ok(result.elapsedMs < (delayMs === 1 ? 15 : 60), `${delayMs}ms RTT completed in ${result.elapsedMs.toFixed(1)}ms`);
  }
});

test('probe budget scales with streamed reply cadence and distinguishes budget exhaustion', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const serialInput = new ProbeInput();
  let serialTimer;
  const serialScreen = {
    rows: 20, input: serialInput,
    writeOutput(value, meta) {
      if (meta.context !== 'probe' || !String(value).includes('\u001b[6n')) return;
      let delivered = 0;
      serialTimer = setInterval(() => {
        serialInput.emit('data', '\u001b[20;2R');
        delivered += 1;
        if (delivered === WIDTH_PROBE_GRAPHEMES.length) clearInterval(serialTimer);
      }, 7);
    }
  };
  t.after(() => clearInterval(serialTimer));
  const serialForeground = await probeTerminalWidths({
    screen: serialScreen, input: serialInput, probes: WIDTH_PROBE_GRAPHEMES, timeoutMs: 45, maxBudgetMs: 500
  });
  const serial = serialForeground.background ? await serialForeground.background.done : serialForeground;
  assert.equal(Object.keys(serial.widths).length, 57, 'a render-cycle-paced terminal completes after the old 45ms cutoff');
  assert.ok(serial.elapsedMs > 45 && serial.elapsedMs < 500, `scaled batch completed in ${serial.elapsedMs.toFixed(1)}ms`);

  const budgetInput = new ProbeInput();
  let budgetTimer;
  const budgetScreen = {
    rows: 20, input: budgetInput,
    writeOutput(value, meta) {
      if (meta.context !== 'probe' || !String(value).includes('\u001b[6n')) return;
      budgetTimer = setInterval(() => budgetInput.emit('data', '\u001b[20;2R'), 10);
    }
  };
  t.after(() => clearInterval(budgetTimer));
  const budgetForeground = await probeTerminalWidths({
    screen: budgetScreen, input: budgetInput, probes: WIDTH_PROBE_GRAPHEMES, timeoutMs: 20, maxBudgetMs: 70
  });
  const budget = budgetForeground.background ? await budgetForeground.background.done : budgetForeground;
  clearInterval(budgetTimer);
  assert.ok(budget.outcomes.some((entry) => entry.status === 'budget'));
  assert.match(formatWidthProbeResult(budget), /unproven\(budget\)/);
});

test('late coalesced CPR batches upgrade atomically in the background at tmux-over-SSH delays', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const replies = WIDTH_PROBE_GRAPHEMES.map(() => '\u001b[20;2R').join('');
  for (const delayMs of [60, 300, 1500]) {
    clearGraphemeWidthOverrides();
    const directory = temporaryDirectory(t);
    const input = new ProbeInput();
    let redraws = 0;
    let persisted = 0;
    const identity = `tmux-delay-${delayMs}`;
    const screen = {
      rows: 20, input,
      writeOutput(value, meta) {
        if (meta.context === 'probe' && String(value).includes('\u001b[6n')) setTimeout(() => input.emit('data', replies), delayMs);
      }
    };
    const foreground = await probeTerminalWidths({
      screen, input, probes: WIDTH_PROBE_GRAPHEMES,
      backgroundIdleMs: 1800, backgroundBudgetMs: 3000,
      onBackgroundComplete(result) {
        if (result.source !== 'probe') return;
        saveTuiPreferences({ widthProbeCache: { [identity]: { widths: result.widths, measuredAt: Date.now() } } }, { directory });
        persisted += 1;
        redraws += 1;
      }
    });
    assert.equal(foreground.source, 'fallback', `${delayMs}ms returns conservative foreground`);
    assert.ok(foreground.elapsedMs < 150, `${delayMs}ms foreground painted in ${foreground.elapsedMs.toFixed(1)}ms`);
    assert.equal(foreground.background.active, true);
    const completed = await foreground.background.done;
    assert.equal(completed.phase, 'background');
    assert.equal(completed.completion, 'complete');
    assert.equal(Object.keys(completed.widths).length, WIDTH_PROBE_GRAPHEMES.length);
    assert.equal(persisted, 1, 'the complete table is persisted once');
    assert.equal(redraws, 1, 'the glyph upgrade requests one redraw');
    assert.deepEqual(loadTuiPreferences({ directory, env: {} }).widthProbeCache[identity].widths, completed.widths);
    assert.equal(foreground.background.active, false);
  }
});

test('immediate CPR completion stays foreground-only with no listener or timer residue', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const input = new ProbeInput();
  const decoder = () => {};
  input.on('data', decoder);
  const screen = {
    rows: 20, input,
    writeOutput(value, meta) {
      if (meta.context === 'probe' && String(value).includes('\u001b[6n')) setTimeout(() => input.emit('data', '\u001b[20;2R\u001b[20;2R'), 5);
    }
  };
  const result = await probeTerminalWidths({ screen, input, probes: ['A', 'B'], foregroundMs: 75 });
  assert.equal(result.source, 'probe');
  assert.equal(result.phase, 'foreground');
  assert.equal(result.background, undefined);
  assert.deepEqual(result.widths, { A: 1, B: 1 });
  assert.deepEqual(input.listeners('data'), [decoder]);
});

test('no-reply background expires cleanly and leaves real key input attached', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const input = new ProbeInput();
  const screen = { rows: 20, input, writeOutput() {} };
  const started = performance.now();
  const foreground = await probeTerminalWidths({
    screen, input, probes: ['A', 'B'], foregroundMs: 60, backgroundIdleMs: 40, backgroundBudgetMs: 200
  });
  assert.ok(performance.now() - started < 150, 'the first frame is not held for the patient deadline');
  const keys = [];
  const appHandler = (chunk) => keys.push(String(chunk));
  foreground.background.attach(appHandler);
  input.emit('data', 'ab');
  const completed = await foreground.background.done;
  assert.equal(completed.source, 'fallback');
  assert.deepEqual(completed.outcomes.map((entry) => entry.status), ['timeout', 'timeout']);
  input.emit('data', 'c');
  assert.deepEqual(keys, ['ab', 'c']);
  assert.deepEqual(input.listeners('data'), [appHandler]);
  assert.equal(foreground.background.teardown(), false, 'teardown remains idempotent after expiry');
  foreground.background.detach(appHandler);
  assert.equal(input.listenerCount('data'), 0);
});

test('background input filter strips only probe-row CPRs and preserves interleaved keystrokes in order', async (t) => {
  t.after(clearGraphemeWidthOverrides);
  const input = new ProbeInput();
  const screen = {
    rows: 20, input,
    writeOutput(value, meta) {
      if (meta.context !== 'probe' || !String(value).includes('\u001b[6n')) return;
      setTimeout(() => input.emit('data', 'a\u001b[20;2Rb\u001b[A\u001b[20;2Rc'), 70);
    }
  };
  const foreground = await probeTerminalWidths({
    screen, input, probes: ['A', 'B'], foregroundMs: 30, backgroundIdleMs: 200, backgroundBudgetMs: 500
  });
  const received = [];
  const appHandler = (chunk) => received.push(String(chunk));
  foreground.background.attach(appHandler);
  const completed = await foreground.background.done;
  assert.deepEqual(completed.widths, { A: 1, B: 1 });
  assert.equal(received.join(''), 'ab\u001b[Ac');
  assert.doesNotMatch(received.join(''), /\u001b\[20;/);
  foreground.background.detach(appHandler);
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
