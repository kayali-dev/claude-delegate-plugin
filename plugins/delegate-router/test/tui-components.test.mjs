import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { paintDiffLine, paintKeyValue, paintLogPane, scrollVirtualLog, WrapCache } from '../bin/lib/tui/components.mjs';
import { formatDiffRow, prepareDiffWindow, wrapDiffRow } from '../bin/lib/tui/diff.mjs';
import { configureGlyphs } from '../bin/lib/tui/glyphs.mjs';
import { CellGrid } from '../bin/lib/tui/screen.mjs';

function entryText(entry) {
  return entry.text;
}

test('virtual log wraps only the viewport window and reuses untouched entry wraps', () => {
  const entries = Array.from({ length: 5000 }, (_, index) => ({ id: index, text: `entry ${index}` }));
  const cache = new WrapCache();
  const rect = { x: 0, y: 0, width: 80, height: 20 };
  paintLogPane(new CellGrid(80, 20), rect, { virtual: true, entries, formatEntry: entryText, follow: false, scroll: 0 }, { wrapCache: cache });
  const initialWraps = cache.wrapCalls;
  assert.ok(initialWraps <= 32, `initial viewport wrapped ${initialWraps} of 5000 entries`);

  paintLogPane(new CellGrid(80, 20), rect, { virtual: true, entries, formatEntry: entryText, follow: false, scroll: 1 }, { wrapCache: cache });
  assert.ok(cache.wrapCalls - initialWraps <= 1, `one-line scroll wrapped ${cache.wrapCalls - initialWraps} new entries`);
  assert.ok(cache.hits >= 31);

  const beforeResize = cache.wrapCalls;
  cache.clear();
  paintLogPane(new CellGrid(60, 20), { ...rect, width: 60 }, { virtual: true, entries, formatEntry: entryText, follow: false, scroll: 1 }, { wrapCache: cache });
  assert.ok(cache.wrapCalls > beforeResize, 'resize invalidation must recompute the visible wraps');
});

test('virtual log scrolling advances by display lines within wrapped entries', () => {
  const entries = [{ text: 'abcdefghijklmnopqrstuvwxyz' }, { text: 'next' }];
  const log = { virtual: true, entries, formatEntry: entryText };
  const cache = new WrapCache();
  assert.deepEqual(scrollVirtualLog(log, { entry: 0, line: 0 }, 2, 5, cache), { entry: 0, line: 2 });
  assert.deepEqual(scrollVirtualLog(log, { entry: 0, line: 2 }, 4, 5, cache), { entry: 1, line: 0 });
  assert.deepEqual(scrollVirtualLog(log, { entry: 1, line: 0 }, -3, 5, cache), { entry: 0, line: 3 });
});

test('key-value painter shares one grid, humanizes keys, collapses nulls, and promotes section anomalies', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  configureGlyphs({ env: { TERM: 'dumb', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  const grid = new CellGrid(64, 12);
  paintKeyValue(grid, { x: 0, y: 0, width: 64, height: 12 }, {
    sectionGap: 1,
    sections: [
      {
        label: 'State',
        badge: { text: 'ACCEPTANCE BLOCKED' },
        rows: [{ key: 'objectiveMet', value: false }, { key: 'checkpoint', value: 'opaque-checkpoint-value', copy: true }]
      },
      {
        label: 'Verification',
        rows: [{ key: 'verificationProfile', value: null }, { key: 'exitCode', value: 7 }]
      }
    ]
  });
  const lines = grid.lines();
  assert.match(lines[1], /^STATE\s+.*ACCEPTANCE BLOCKED$/);
  assert.match(lines[2], /^objective met\s+false/);
  assert.doesNotMatch(lines.join('\n'), /objectiveMet|\bnull\b/);
  assert.match(lines[6], /^verification profile\s+-/);
  const falseColumn = lines[2].indexOf('false');
  const nullColumn = lines[6].indexOf('-');
  const exitColumn = lines[7].indexOf('7');
  assert.equal(falseColumn, nullColumn);
  assert.equal(falseColumn, exitColumn);
  assert.equal(lines[3].at(-1), 'C');
});

test('diff painter owns line gutters, file bands, symbols, row tint, and intra-line emphasis', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  configureGlyphs({ env: { TERM: 'dumb', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  const prepared = prepareDiffWindow({
    diff: '@@ -10,3 +10,3 @@\n function oldName() {\n-oldName();\n+newName();\n }',
    offset: 0,
    totalChars: 72
  }, { band: { path: 'src/names.mjs', additions: 1, deletions: 1 } });
  const grid = new CellGrid(72, 8);
  const cache = new WrapCache();
  paintDiffLine(grid, { x: 0, y: 0, width: 72, height: 8 }, {
    virtual: true,
    entries: prepared.rows,
    formatEntry: formatDiffRow,
    wrapEntry: wrapDiffRow,
    follow: false,
    scroll: 0
  }, { wrapCache: cache });
  const lines = grid.lines();
  assert.match(lines[0], /^src\/names\.mjs.*[+]1 -1$/);
  assert.match(lines[1], /[*]\s+function oldName\(\) \{/);
  assert.doesNotMatch(lines[1], /@@ -10/);
  assert.match(lines[3], /\s11\s+\|\s+-oldName\(\);/);
  assert.match(lines[4], /\s11\s+\|\s+[+]newName\(\);/);
  assert.ok(grid.get(71, 3).style.bg, 'removed row tint owns the full width');
  assert.ok(grid.get(71, 4).style.bg, 'added row tint owns the full width');
  assert.ok(grid.lines()[3].includes('Name();'));
  const removedCells = Array.from({ length: 72 }, (_, x) => grid.get(x, 3).style);
  assert.ok(removedCells.some((style) => style.bold), 'changed span is emphasized');
  assert.ok(removedCells.some((style) => style.dim), 'unchanged remainder is dimmed');
});

test('diff painter formats only the visible window', () => {
  const rows = prepareDiffWindow({
    diff: Array.from({ length: 5000 }, (_, index) => `+row ${index}`).join('\n'),
    offset: 0,
    totalChars: 50_000
  }).rows;
  const cache = new WrapCache();
  paintDiffLine(new CellGrid(80, 12), { x: 0, y: 0, width: 80, height: 12 }, {
    virtual: true,
    entries: rows,
    formatEntry: formatDiffRow,
    wrapEntry: wrapDiffRow,
    follow: false,
    scroll: { entry: 2500, line: 0 }
  }, { wrapCache: cache });
  assert.ok(cache.wrapCalls <= 24, `visible diff wrapped ${cache.wrapCalls} of ${rows.length} rows`);
});
