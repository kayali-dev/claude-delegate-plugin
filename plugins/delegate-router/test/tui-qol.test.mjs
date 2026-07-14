import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyToClipboard } from '../bin/lib/tui/clipboard.mjs';
import { paintFrame, renderFrameToString, scrollbarGeometry, virtualLogLayout, WrapCache } from '../bin/lib/tui/components.mjs';
import { CHROME_GLYPHS } from '../bin/lib/tui/glyphs.mjs';
import { uiPalette } from '../bin/lib/tui/palette.mjs';
import { loadTuiPreferences, saveTuiPreferences, tuiPreferencesPath } from '../bin/lib/tui/preferences.mjs';
import { diffLineStyle } from '../bin/lib/tui/viewmodels.mjs';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

test('TUI preferences persist privately and environment values remain authoritative', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-prefs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const widthProbeCache = { 'term=tmux-256color|program=ghostty|version=1|mux=tmux': { widths: { '⚙': 1 }, measuredAt: 123 } };
  const file = saveTuiPreferences({ theme: 'light', notifications: false, timestampMode: 'relative', fleetDensity: 'compact', widthProbeCache }, { directory });
  assert.equal(file, tuiPreferencesPath({ directory }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadTuiPreferences({ directory, env: {} }), { theme: 'light', notifications: false, timestampMode: 'relative', fleetDensity: 'compact', widthProbeCache });
  assert.deepEqual(loadTuiPreferences({
    directory,
    env: { DELEGATE_TUI_THEME: 'dark', DELEGATE_TUI_NOTIFY: '1', DELEGATE_TUI_TIMESTAMP_MODE: 'absolute', DELEGATE_TUI_DENSITY: 'wide' }
  }), { theme: 'dark', notifications: true, timestampMode: 'absolute', fleetDensity: 'wide', widthProbeCache });
});

test('clipboard dispatch uses the platform tool and silently declines unavailable platforms', () => {
  const calls = [];
  assert.equal(copyToClipboard('assistant function', {
    platform: 'darwin',
    spawn(command, args, options) { calls.push({ command, args, input: options.input }); return { status: 0 }; }
  }), true);
  assert.deepEqual(calls, [{ command: 'pbcopy', args: [], input: 'assistant function' }]);
  assert.equal(copyToClipboard('assistant function', { platform: 'win32', spawn() { throw new Error('must not run'); } }), false);
  assert.equal(copyToClipboard('', { platform: 'darwin' }), false);
});

test('scrollable panes paint a palette-only track, proportional thumb, and title position', () => {
  const frame = {
    width: 44, height: 12, title: { text: 'Scroll proof' },
    panes: [{ rect: { x: 0, y: 1, width: 44, height: 10 }, title: 'Events', content: { kind: 'log', lines: Array.from({ length: 100 }, (_, index) => `line ${index}`), follow: false, scroll: 35 } }],
    status: { text: 'ready' }
  };
  const grid = paintFrame(frame);
  const indicatorX = 43;
  assert.equal(grid.get(indicatorX, 1).char, CHROME_GLYPHS.corner);
  assert.equal(grid.get(indicatorX, 10).char, CHROME_GLYPHS.corner);
  const indicatorStyles = Array.from({ length: 8 }, (_, row) => grid.get(indicatorX, 2 + row).style);
  assert.ok(Array.from({ length: 8 }, (_, row) => grid.get(indicatorX, 2 + row).char).every((char) => char === CHROME_GLYPHS.scrollTrack || char === CHROME_GLYPHS.scrollThumb));
  assert.ok(indicatorStyles.some((style) => style.fg === uiPalette.scrollTrack.fg || style.dim === uiPalette.scrollTrack.dim));
  assert.ok(indicatorStyles.some((style) => style.fg === uiPalette.scrollThumb.fg || style.underline === uiPalette.scrollThumb.underline));
  assert.match(renderFrameToString(frame).split('\n')[1], /36-43\/100|\d+%/);

  const follow = { ...frame, panes: [{ ...frame.panes[0], content: { ...frame.panes[0].content, follow: true } }] };
  const followGrid = paintFrame(follow);
  assert.equal(followGrid.get(indicatorX, 9).char, CHROME_GLYPHS.scrollThumb, 'follow mode pins the thumb to the bottom');
});

test('moving scrollbar thumbs repaint the complete owned edge column', () => {
  const base = {
    width: 36, height: 14, title: { text: 'Thumb ownership' },
    panes: [{ rect: { x: 0, y: 1, width: 36, height: 12 }, title: 'Transcript', content: { kind: 'log', lines: Array.from({ length: 200 }, (_, index) => `line ${index}`), follow: false } }],
    status: { text: 'ready' }
  };
  const top = paintFrame({ ...base, panes: [{ ...base.panes[0], content: { ...base.panes[0].content, scroll: 0 } }] });
  const bottom = paintFrame({ ...base, panes: [{ ...base.panes[0], content: { ...base.panes[0].content, scroll: 190 } }] });
  const x = 35;
  const topThumb = [];
  for (let y = 2; y < 12; y += 1) {
    assert.ok([CHROME_GLYPHS.scrollTrack, CHROME_GLYPHS.scrollThumb].includes(top.get(x, y).char), `top frame owns ${x},${y}`);
    assert.ok([CHROME_GLYPHS.scrollTrack, CHROME_GLYPHS.scrollThumb].includes(bottom.get(x, y).char), `bottom frame owns ${x},${y}`);
    if (top.get(x, y).char === CHROME_GLYPHS.scrollThumb) topThumb.push(y);
  }
  assert.ok(topThumb.length > 0);
  assert.ok(topThumb.some((y) => bottom.get(x, y).char === CHROME_GLYPHS.scrollTrack), 'old thumb cells become explicit track cells');
  assert.equal(bottom.get(x, 1).char, CHROME_GLYPHS.corner);
  assert.equal(bottom.get(x, 12).char, CHROME_GLYPHS.corner);
});

test('scrollbar geometry has constant length, monotonic position, and bounded endpoints', () => {
  const random = mulberry32(0x5c4011);
  for (let sample = 0; sample < 600; sample += 1) {
    const track = 1 + Math.floor(random() * 80);
    const total = 1 + Math.floor(random() * 500);
    const viewport = 1 + Math.floor(random() * (total + 30));
    const baseline = scrollbarGeometry({ track, viewport, total, offset: 0 });
    assert.equal(baseline.thumbStart, 0, `sample=${sample}: starts at the top`);
    let previous = -1;
    for (let offset = 0; offset <= baseline.maxOffset; offset += 1) {
      const geometry = scrollbarGeometry({ track, viewport, total, offset });
      assert.equal(geometry.thumbLen, baseline.thumbLen, `sample=${sample} offset=${offset}: constant length`);
      assert.ok(geometry.thumbStart >= previous, `sample=${sample} offset=${offset}: monotonic start`);
      assert.ok(geometry.thumbStart >= 0, `sample=${sample} offset=${offset}: nonnegative start`);
      assert.ok(geometry.thumbStart + geometry.thumbLen <= track, `sample=${sample} offset=${offset}: bounded thumb`);
      previous = geometry.thumbStart;
    }
    assert.equal(scrollbarGeometry({ track, viewport, total, offset: baseline.maxOffset }).thumbStart, track - baseline.thumbLen, `sample=${sample}: exact bottom endpoint`);
  }
});

test('virtual line estimates keep multi-line block thumbs proportional and offset-stable', () => {
  const entries = Array.from({ length: 6 }, (_, index) => `${index}: ${'wrapped '.repeat(10 + index)}`);
  const cache = new WrapCache();
  const log = { kind: 'log', virtual: true, entries, follow: false, scroll: { entry: 0, line: 0 } };
  const first = virtualLogLayout(log, 40, 12, cache);
  assert.ok(first.lineMetrics.estimatedTotalLines > 12, 'fewer blocks than rows still estimate their wrapped display lines');
  const lengths = [];
  for (const entry of [0, 1, 3, 5, 2, 0]) {
    const frame = {
      width: 42, height: 14,
      panes: [{ rect: { x: 0, y: 0, width: 42, height: 14 }, title: 'Variable blocks', content: { kind: 'log', virtual: true, entries, follow: false, scroll: { entry, line: 0 } } }]
    };
    const grid = paintFrame(frame, { wrapCache: cache });
    lengths.push(Array.from({ length: 12 }, (_, row) => grid.get(41, row + 1)).filter((cell) => cell.char === CHROME_GLYPHS.scrollThumb).length);
  }
  assert.equal(new Set(lengths).size, 1, 'pure offset changes never alter thumb length after measurements settle');
  assert.ok(lengths[0] < 12, 'overflowing multi-line blocks never produce a full-bar thumb');
});

test('virtual line estimates refine monotonically and use a full bar iff content fits', () => {
  const cache = new WrapCache();
  const entries = Array.from({ length: 48 }, (_, index) => `${index}: ${'line '.repeat(2 + index % 9)}`);
  const log = { virtual: true, entries, follow: false, scroll: { entry: 0, line: 0 } };
  const lengths = [];
  let previousMeasured = 0;
  let previousEstimate = 0;
  for (const entry of [0, 8, 16, 24, 32, 40, 47]) {
    const layout = virtualLogLayout({ ...log, scroll: { entry, line: 0 } }, 18, 10, cache);
    assert.ok(layout.lineMetrics.measuredBlocks >= previousMeasured);
    assert.ok(layout.lineMetrics.estimatedTotalLines >= previousEstimate);
    previousMeasured = layout.lineMetrics.measuredBlocks;
    previousEstimate = layout.lineMetrics.estimatedTotalLines;
    lengths.push(scrollbarGeometry({ track: 10, viewport: 10, total: layout.lineMetrics.estimatedTotalLines, offset: layout.lineMetrics.estimatedOffsetLines }).thumbLen);
  }
  for (let index = 1; index < lengths.length; index += 1) assert.ok(lengths[index] <= lengths[index - 1], `refinement ${index} never grows the thumb`);

  const fit = paintFrame({ width: 22, height: 8, panes: [{ rect: { x: 0, y: 0, width: 22, height: 8 }, content: { kind: 'log', virtual: true, entries: ['one', 'two'], follow: false } }] }, { wrapCache: new WrapCache() });
  const overflow = paintFrame({ width: 22, height: 8, panes: [{ rect: { x: 0, y: 0, width: 22, height: 8 }, content: { kind: 'log', virtual: true, entries: ['long '.repeat(30), 'also '.repeat(30)], follow: false } }] }, { wrapCache: new WrapCache() });
  const thumbCount = (grid) => Array.from({ length: 6 }, (_, row) => grid.get(21, row + 1).char).filter((char) => char === CHROME_GLYPHS.scrollThumb).length;
  assert.equal(thumbCount(fit), 6, 'content that fits uses the full track');
  assert.ok(thumbCount(overflow) < 6, 'content with more display lines than rows does not');
});

test('diff line semantics color additions, deletions, and hunk headers through the palette', () => {
  assert.equal(diffLineStyle('+added'), uiPalette.positive);
  assert.equal(diffLineStyle('-removed'), uiPalette.negative);
  assert.equal(diffLineStyle('@@ -1 +1 @@'), uiPalette.hunk);
  assert.equal(diffLineStyle(' context'), uiPalette.body);
});
