import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import { cursorTo, styleSequence } from '../bin/lib/tui/ansi.mjs';
import { CHROME_GLYPHS } from '../bin/lib/tui/glyphs.mjs';
import { setUiTheme, uiPalette } from '../bin/lib/tui/palette.mjs';
import { CellGrid, Screen } from '../bin/lib/tui/screen.mjs';
import { assertVtMatchesGrid, ByteVirtualTerminal } from './helpers/tui-vt.mjs';
import { graphemeWidth, isWidthSuspect } from '../bin/lib/tui/width.mjs';
import { ReplayVirtualTerminal } from '../bin/lib/tui/vt-model.mjs';

// Do not let a NO_COLOR test environment erase the class of state under test.
setUiTheme('dark', {});

function capture(columns, rows) {
  return { columns, rows, write() { return true; } };
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const GLYPHS = ['a', 'Z', '7', ' ', '·', '界', '🙂', '🧠', '✓', '⚙'];

function randomizedText(random, maxLength) {
  const length = Math.floor(random() * (maxLength + 1));
  let value = '';
  for (let index = 0; index < length; index += 1) value += GLYPHS[Math.floor(random() * GLYPHS.length)];
  return value;
}

function randomizedFrame(random, step) {
  const sizes = [[40, 12], [53, 16], [80, 24]];
  const [width, height] = sizes[Math.floor(random() * sizes.length)];
  const mode = ['log', 'table', 'empty'][Math.floor(random() * 3)];
  const overlayKind = ['none', 'none', 'input', 'help', 'confirm'][Math.floor(random() * 5)];
  const tabs = random() < 0.6;
  const status = random() < 0.85;
  const top = tabs ? 2 : 1;
  const bottom = status ? 1 : 0;
  let content;
  if (mode === 'table') {
    content = {
      kind: 'table', selected: step % 5, scroll: Math.max(0, step % 4 - 1),
      columns: [{ key: 'left', title: randomizedText(random, 8), width: Math.floor((width - 2) / 2) }, { key: 'right', title: 'State', width: Math.ceil((width - 2) / 2) }],
      rows: Array.from({ length: 7 }, () => ({ left: randomizedText(random, width), right: randomizedText(random, 14) }))
    };
  } else {
    content = { kind: 'log', follow: step % 2 === 0, scroll: step % 4, lines: mode === 'empty' ? [] : Array.from({ length: 9 }, () => randomizedText(random, width * 2)) };
  }
  const frame = {
    width, height,
    title: { text: randomizedText(random, width), right: random() < 0.75 ? randomizedText(random, Math.floor(width / 2)) : '' },
    panes: [{ rect: { x: 0, y: top, width, height: Math.max(3, height - top - bottom) }, title: randomizedText(random, width), content }]
  };
  if (tabs) frame.tabs = { rect: { x: 0, y: 1, width, height: 1 }, items: ['Transcript', 'Diff', 'Record', 'Events'], active: step % 4 };
  if (status) frame.status = { text: randomizedText(random, width * 2), right: random() < 0.75 ? randomizedText(random, Math.floor(width / 2)) : '' };
  if (overlayKind === 'input') frame.overlay = { kind: 'input', label: randomizedText(random, 12), value: randomizedText(random, width) };
  else if (overlayKind === 'help') frame.overlay = { kind: 'help', title: 'Help', items: Array.from({ length: 6 }, () => ({ key: randomizedText(random, 6), description: randomizedText(random, width) })) };
  else if (overlayKind === 'confirm') frame.overlay = { kind: 'confirm', title: 'Confirm', lines: [randomizedText(random, width), randomizedText(random, width)], label: 'Suffix', value: randomizedText(random, 8) };
  return { frame, shape: `${width}x${height} ${mode} ${overlayKind} tabs:${tabs} status:${status}` };
}

function assertValidWideCells(grid, context) {
  for (let y = 0; y < grid.rows; y += 1) {
    for (let x = 0; x < grid.columns; x += 1) {
      const entry = grid.get(x, y);
      if (entry.continuation) {
        const previous = grid.get(x - 1, y);
        assert.ok(previous && !previous.continuation && graphemeWidth(previous.char) > 1, `${context}: orphan continuation at ${x},${y}`);
      } else if (graphemeWidth(entry.char) > 1) {
        assert.equal(grid.get(x + 1, y)?.continuation, true, `${context}: wide base without continuation at ${x},${y}`);
      }
    }
  }
}

test('fixed-seed incremental rendering always matches a from-scratch repaint', () => {
  const random = mulberry32(0xc0ffee);
  const initial = randomizedFrame(random, 0);
  const output = capture(initial.frame.width, initial.frame.height);
  const screen = new Screen({ output, input: {}, columns: initial.frame.width, rows: initial.frame.height, colorMode: '256' });
  const incremental = new ByteVirtualTerminal(initial.frame.width, initial.frame.height);
  incremental.apply(`${'\u001b'}[?1049h${'\u001b'}[?7l`);
  for (let step = 0; step < 400; step += 1) {
    const { frame, shape } = step === 0 ? initial : randomizedFrame(random, step);
    if (frame.width !== screen.columns || frame.height !== screen.rows) {
      screen.resize(frame.width, frame.height);
      incremental.resize(frame.width, frame.height);
    }
    const grid = paintFrame(frame);
    assertValidWideCells(grid, `seed=0xc0ffee step=${step} shape=${shape}`);
    const previousGrid = screen.previous;
    if (previousGrid) {
      for (let y = 0; y < grid.rows; y += 1) {
        for (let x = 0; x < grid.columns; x += 1) assert.notEqual(grid.get(x, y), previousGrid.get(x, y), `seed=0xc0ffee step=${step}: submitted frame aliases retained cell ${x},${y}`);
      }
    }
    incremental.apply(screen.render(grid));
    assertVtMatchesGrid(incremental, grid, `seed=0xc0ffee step=${step} shape=${shape}`);
    for (let y = 0; y < grid.rows; y += 1) {
      for (let x = 0; x < grid.columns; x += 1) assert.notEqual(screen.previous.get(x, y), grid.get(x, y), `seed=0xc0ffee step=${step}: retained buffer aliases submitted cell ${x},${y}`);
    }
  }
});

test('suspect-width repaint owns every background cell beside the scrollbar', () => {
  const width = 100;
  const height = 30;
  const output = capture(width, height);
  const screen = new Screen({ output, input: {}, columns: width, rows: height, colorMode: '256' });
  const terminal = new ReplayVirtualTerminal(width, height, {
    // This is the failing tmux shape: our model reserves two cells, while the
    // interposed terminal consumes one. Before the fix, frame 2 retained the
    // old selection background at (98,2).
    widthOf(grapheme) {
      const measured = graphemeWidth(grapheme);
      return isWidthSuspect(grapheme) && measured === 2 ? 1 : measured;
    }
  });
  const frame = (wideTail, selectedEntry) => ({
    width, height,
    title: { text: 'Style ownership' },
    panes: [{
      rect: { x: 0, y: 1, width, height: 28 }, title: 'Virtual log',
      content: {
        kind: 'log', virtual: true,
        entries: [wideTail ? `${'A'.repeat(96)}🙂` : 'short', 'other'],
        formatEntry: (value) => value,
        follow: false, scroll: { entry: 0, line: 0 }, selectedEntry,
        measureKey: `style-owner-${wideTail}`
      }
    }],
    status: { text: 'ready' }
  });

  terminal.apply(screen.render(paintFrame(frame(false, 0))));
  const intended = paintFrame(frame(true, 1));
  terminal.apply(screen.render(intended));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const actualBackground = JSON.parse(terminal.cells[y][x].style || '{}').bg ?? null;
      const expectedBackground = intended.get(x, y).style.bg == null ? null : `256:${intended.get(x, y).style.bg.index}`;
      assert.equal(actualBackground, expectedBackground, `background owner at ${x},${y}`);
    }
  }
  assert.equal(intended.get(98, 2).continuation, false, 'inner padding keeps content spans out of the scrollbar-adjacent cell');
  assert.equal(JSON.parse(terminal.cells[2][98].style).bg ?? null, null, 'vacated selection background is cleared');
});

test('ambiguous suspect spans take the new owner style in every background direction', () => {
  const width = 12;
  const output = capture(width, 1);
  const screen = new Screen({ output, input: {}, columns: width, rows: 1, colorMode: '256' });
  const terminal = new ReplayVirtualTerminal(width, 1, {
    widthOf(grapheme) { return grapheme === '·' ? 2 : graphemeWidth(grapheme); }
  });
  const selected = { bg: { index: 237, rgb: [58, 58, 58] } };
  const other = { bg: { index: 236, rgb: [48, 48, 48] } };
  const transitions = [
    ['default', {}],
    ['default-to-filled', selected],
    ['filled-to-default', {}],
    ['default-to-filled-again', selected],
    ['filled-to-other-filled', other]
  ];

  for (const [label, style] of transitions) {
    const intended = new CellGrid(width, 1);
    intended.set(8, 0, '·', style);
    terminal.apply(screen.render(intended));
    for (let x = 0; x < width; x += 1) {
      const actualBackground = JSON.parse(terminal.cells[0][x].style || '{}').bg ?? null;
      const expectedBackground = intended.get(x, 0).style.bg == null ? null : `256:${intended.get(x, 0).style.bg.index}`;
      assert.equal(actualBackground, expectedBackground, `${label}: owner background at ${x},0`);
    }
  }

  const narrowTerminal = new ReplayVirtualTerminal(width, 1, {
    widthOf(grapheme) { return grapheme === '🙂' ? 1 : graphemeWidth(grapheme); }
  });
  const narrowScreen = new Screen({ output: capture(width, 1), input: {}, columns: width, rows: 1, colorMode: '256' });
  for (const [label, style] of transitions) {
    const intended = new CellGrid(width, 1);
    intended.set(8, 0, '🙂', style);
    const bytes = narrowScreen.render(intended);
    narrowTerminal.apply(bytes);
    for (const x of [8, 9]) {
      const actualBackground = JSON.parse(narrowTerminal.cells[0][x].style || '{}').bg ?? null;
      const expectedBackground = style.bg == null ? null : `256:${style.bg.index}`;
      assert.equal(actualBackground, expectedBackground, `${label}: modeled suspect span takes the new owner bg at ${x},0`);
    }
    if (style.bg) {
      const explicitPreclear = `${cursorTo(0, 8)}${styleSequence(style, '256')}  ${cursorTo(0, 8)}`;
      assert.ok(bytes.includes(explicitPreclear), `${label}: pre-clear carries the new owner's explicit SGR before absolute redraw`);
    }
  }
});

test('scroll-thrash keeps every scrollbar edge cell composed and clears old thumbs', () => {
  const width = 96;
  const height = 18;
  const output = capture(width, height);
  const screen = new Screen({ output, input: {}, columns: width, rows: height, colorMode: '256' });
  const vt = new ByteVirtualTerminal(width, height);
  vt.apply(`${'\u001b'}[?1049h${'\u001b'}[?7l`);
  const positions = [0, 1, 0.08, 0.72, 0.31, 0.96, 0.54, 0.16];
  let previousThumbs = new Map();
  const lengthsByTotal = new Map();

  for (let step = 0; step < 240; step += 1) {
    const total = 40 + Math.floor(step / positions.length) * 7;
    const viewport = 16;
    const scroll = Math.floor(Math.max(0, total - viewport) * positions[step % positions.length]);
    const lines = Array.from({ length: total }, (_, index) => `assistant function ${index}`);
    const rows = Array.from({ length: total }, (_, index) => ({ value: `row ${index}` }));
    const frame = {
      width, height, title: { text: 'Scrollbar thrash' },
      panes: [
        { rect: { x: 0, y: 1, width: 32, height: 16 }, title: 'Log', content: { kind: 'log', lines, follow: false, scroll } },
        { rect: { x: 32, y: 1, width: 32, height: 16 }, border: false, content: { kind: 'table', header: false, columns: [{ key: 'value', title: '', width: 31 }], rows, scroll, selected: scroll, selection: false } },
        { rect: { x: 64, y: 1, width: 32, height: 16 }, title: 'Follow', content: { kind: 'log', lines, follow: true, scroll: 0 } }
      ],
      status: { text: 'ready' }
    };
    const grid = paintFrame(frame);
    const columns = [
      { x: 31, start: 1, end: 16, top: CHROME_GLYPHS.corner, bottom: CHROME_GLYPHS.corner, trackStyle: uiPalette.focusBorder },
      { x: 63, start: 1, end: 17, top: null, bottom: null, trackStyle: uiPalette.border },
      { x: 95, start: 1, end: 16, top: CHROME_GLYPHS.corner, bottom: CHROME_GLYPHS.corner, follow: true, trackStyle: uiPalette.border }
    ];
    for (const column of columns) {
      if (column.top) assert.equal(grid.get(column.x, column.start).char, column.top, `step=${step}: top join`);
      if (column.bottom) assert.equal(grid.get(column.x, column.end).char, column.bottom, `step=${step}: bottom join`);
      const firstTrack = column.start + (column.top ? 1 : 0);
      const afterTrack = column.end;
      const thumbs = new Set();
      for (let y = firstTrack; y < afterTrack; y += 1) {
        const cell = grid.get(column.x, y);
        const char = cell.char;
        assert.ok(char === CHROME_GLYPHS.scrollTrack || char === CHROME_GLYPHS.scrollThumb, `step=${step}: complete scrollbar cell ${column.x},${y} is ${JSON.stringify(char)}`);
        assert.deepEqual(cell.style, char === CHROME_GLYPHS.scrollThumb ? uiPalette.scrollThumb : column.trackStyle, `step=${step}: ${char === CHROME_GLYPHS.scrollThumb ? 'thumb' : 'track'} style at ${column.x},${y}`);
        if (char === CHROME_GLYPHS.scrollThumb) thumbs.add(y);
      }
      const lengthKey = `${column.x}:${total}`;
      const priorLength = lengthsByTotal.get(lengthKey);
      if (priorLength != null) assert.equal(thumbs.size, priorLength, `step=${step}: thumb length remains fixed at total=${total}`);
      lengthsByTotal.set(lengthKey, thumbs.size);
      const old = previousThumbs.get(column.x) || new Set();
      for (const y of old) if (!thumbs.has(y)) {
        assert.equal(grid.get(column.x, y).char, CHROME_GLYPHS.scrollTrack, `step=${step}: stale thumb at ${column.x},${y}`);
        assert.deepEqual(grid.get(column.x, y).style, column.trackStyle, `step=${step}: stale thumb style at ${column.x},${y}`);
      }
      if (column.follow) assert.ok(thumbs.has(afterTrack - 1), `step=${step}: growing follow thumb remains bottom-pinned`);
      previousThumbs.set(column.x, thumbs);
    }
    vt.apply(screen.render(grid));
    assertVtMatchesGrid(vt, grid, `scrollbar-thrash step=${step}`);
  }
});

function regressionFrame(options = {}) {
  const frame = {
    width: 36,
    height: 10,
    title: { text: `${'a'.repeat(29)}🙂tail`, right: options.right || '' },
    panes: [{
      rect: { x: 0, y: 1, width: 36, height: 8 },
      title: 'Live pane',
      content: { kind: 'log', follow: false, lines: ['first line', 'thinking 🧠', 'last line'] }
    }],
    status: { text: options.status || '', right: 'notify:on' }
  };
  if (options.overlay === 'input') frame.overlay = { kind: 'input', label: 'Search', value: 'wide 界 query' };
  if (options.overlay === 'help') frame.overlay = { kind: 'help', title: 'Help', items: [{ key: 'Esc', description: 'close overlay' }, { key: '/', description: 'search' }] };
  return frame;
}

test('wide title replacement, shorter status, and dismissed overlays have stable full-frame snapshots', () => {
  const frames = [
    ['wide-overwrite', regressionFrame({ right: 'run!', status: 'status: long transient message' })],
    ['input-open', regressionFrame({ status: 'search active', overlay: 'input' })],
    ['input-dismissed-short-status', regressionFrame({ status: 'ok' })],
    ['help-open', regressionFrame({ status: 'help', overlay: 'help' })],
    ['help-dismissed', regressionFrame({ status: 'ready' })]
  ];
  const rendered = frames.map(([name, frame]) => `--- ${name} ---\n${renderFrameToString(frame, { trimEnd: true }).split('\n').map((line) => line.trimEnd()).join('\n')}`).join('\n');
  const snapshot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-renderer-regressions.txt'), 'utf8').trimEnd();
  assert.equal(rendered, snapshot);
});
