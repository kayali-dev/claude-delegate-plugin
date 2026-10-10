import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedStatsView } from '../bin/lib/stats-view.mjs';

test('MCP statistics page detail without recalculating aggregate rates', () => {
  const stats = { jobs: 1000, rates: { completed: { rate: 0.81, sampleSize: 1000 } },
    totals: { outputTokens: 9999 }, groups: Array.from({ length: 1000 }, (_, id) => ({ id, label: 'model' })), cohorts: [] };
  const page = boundedStatsView(stats, { limit: 3, offset: 6 });
  assert.deepEqual(page.groups.map((row) => row.id), [6, 7, 8]);
  assert.equal(page.display.nextOffset, 9);
  assert.equal(page.jobs, 1000); assert.deepEqual(page.rates, stats.rates);
  const summary = boundedStatsView(stats, { view: 'summary' });
  assert.equal(summary.groups, undefined); assert.equal(summary.cohorts, undefined);
  assert.equal(summary.display.totalGroups, 1000); assert.deepEqual(summary.totals, stats.totals);
});

test('statistics stay bounded with large details and never emit a non-advancing page cursor', () => {
  const nested = Array.from({ length: 100 }, () => ({ detail: 'x'.repeat(10_000) }));
  const stats = { jobs: 300, rates: {}, totals: { jobs: 300 }, groups: Array.from({ length: 300 }, (_, id) => ({ id, nested })), cohorts: nested };
  for (const view of ['full', 'summary']) {
    const result = boundedStatsView(stats, { maxChars: 4000, offset: 8, view });
    assert.ok(JSON.stringify(result, null, 2).length <= 4000);
    assert.equal(result.display.truncated, true);
    assert.ok(result.display.nextOffset == null || result.display.nextOffset > 8);
    assert.equal(result.jobs, 300);
  }
});

test('statistics reject invalid limits as a broker invalid request', () => {
  for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { maxChars: 1 }, { view: 'everything' }]) {
    assert.throws(() => boundedStatsView({ groups: [] }, options), { code: 'INVALID_REQUEST' });
  }
});
