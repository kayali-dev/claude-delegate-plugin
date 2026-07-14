import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { paintLogPane, scrollVirtualLog, WrapCache } from '../bin/lib/tui/components.mjs';
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
