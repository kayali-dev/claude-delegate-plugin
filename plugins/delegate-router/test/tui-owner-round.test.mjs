import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dashboardTileBandOwnerAt,
  dashboardTileBandOwnership,
  paintFrame,
  paintLogPane,
  settleVirtualFollow,
  virtualLogBottomPosition,
  WrapCache
} from '../bin/lib/tui/components.mjs';
import { eventBlocks, formatEventBlock, wrapEventBlock } from '../bin/lib/tui/events.mjs';
import { createPalette, setUiTheme, uiPalette } from '../bin/lib/tui/palette.mjs';
import { CHROME_GLYPHS, configureGlyphs, GLYPH_TIERS } from '../bin/lib/tui/glyphs.mjs';
import { CellGrid } from '../bin/lib/tui/screen.mjs';
import { advanceSpinnerGrid, SpinnerAnimator } from '../bin/lib/tui/spinner.mjs';
import { attributeAuditOutputTokens } from '../bin/lib/stats.mjs';
import {
  activityIndicator,
  attributeAuditUsage,
  dashboardTrendModel,
  dashboardViewModel,
  detailViewModel,
  statsViewModel
} from '../bin/lib/tui/viewmodels.mjs';
import { WIDTH_PROBE_GRAPHEMES } from '../bin/lib/tui/width-probe.mjs';

const NOW = 1_720_000_000_000;

function job(overrides = {}) {
  return {
    id: 'codex-owner-round', provider: 'codex', transport: 'app-server', model: 'gpt-5.4-sol', mode: 'review', cwd: '/work',
    status: 'running', phase: 'working', createdAt: NOW / 1000 - 60, updatedAt: NOW / 1000 - 2, lastActivityAt: NOW - 2000,
    workerAlive: true, usage: { total: { inputTokens: 10, outputTokens: 2 } }, ...overrides
  };
}

function store(overrides = {}) {
  const active = job();
  return {
    jobs: [active], eventsByJob: { [active.id]: [] }, activityEventsByJob: { [active.id]: [] },
    hydrationByJob: { [active.id]: { loaded: true, loading: false, error: null } },
    diffsByJob: {}, diffStatsByJob: {}, providers: [], writerLocks: [], groups: [], audit: [], stats: { since: '7d', groups: [] },
    ...overrides
  };
}

test('dashboard tile interior has one surface-background owner including text and padding', () => {
  const frame = dashboardViewModel(store(), { now: NOW }, { width: 100, height: 30 });
  const tile = frame.panes.find((pane) => pane.content?.kind === 'tile');
  assert.ok(tile);
  const grid = paintFrame(frame);
  const expected = JSON.stringify(uiPalette.surface.bg);
  for (let y = tile.rect.y + 1; y < tile.rect.y + tile.rect.height - 1; y += 1) {
    for (let x = tile.rect.x + 1; x < tile.rect.x + tile.rect.width - 1; x += 1) {
      assert.equal(JSON.stringify(grid.get(x, y).style.bg), expected, `tile interior owner at ${x},${y}`);
    }
  }
});

test('dashboard tile band has exact background ownership under polluted theme and probe state', (t) => {
  t.after(() => {
    setUiTheme('dark', process.env);
    configureGlyphs({ env: process.env, widths: {} });
  });
  const pollutedEnv = {
    ...process.env,
    DELEGATE_TUI_THEME: 'light',
    TERM: 'tmux-256color',
    TERM_PROGRAM: 'ghostty',
    TERM_PROGRAM_VERSION: '1.2',
    TMUX: '/tmp/tmux-1000/default,1,0',
    LANG: 'en_US.UTF-8'
  };
  const widths = Object.fromEntries(WIDTH_PROBE_GRAPHEMES.map((grapheme) => [grapheme, 1]));
  setUiTheme('light', pollutedEnv);
  configureGlyphs({ env: pollutedEnv, widths });

  const audit = Array.from({ length: 14 }, (_, index) => ({
    at: NOW - index * 86_400_000 - 1000,
    jobId: `tile-band-${index}`,
    durationMs: (index + 1) * 1000,
    outcome: { status: index % 4 ? 'completed' : 'failed' },
    usage: { total: { inputTokens: 100 + index, cachedInputTokens: 40 + index, outputTokens: 20 + index } }
  }));
  for (const width of [99, 100, 113]) {
    const frame = dashboardViewModel(store({ audit }), { now: NOW }, { width, height: 30 });
    const grid = paintFrame(frame);
    const ownership = dashboardTileBandOwnership(frame);
    assert.ok(ownership);
    assert.equal(ownership.sparklineRegions.length, 2, `${width}x30 declares both trend rectangles`);
    for (let y = ownership.rect.y; y < ownership.rect.y + ownership.rect.height; y += 1) {
      for (let x = ownership.rect.x; x < ownership.rect.x + ownership.rect.width; x += 1) {
        const owner = dashboardTileBandOwnerAt(ownership, x, y);
        const expected = uiPalette[owner].bg;
        assert.deepEqual(grid.get(x, y).style.bg, expected, `${width}x30 background owner at ${x},${y}`);
      }
    }
    for (const region of ownership.sparklineRegions) {
      for (let x = region.rect.x; x < region.rect.x + region.rect.width; x += 1) {
        const cell = grid.get(x, region.rect.y);
        assert.deepEqual(cell.style.bg, uiPalette.tileSurface.bg, `${width}x30 trend background at ${x},${region.rect.y}`);
        if (GLYPH_TIERS.elegant.spark.includes(cell.char)) {
          assert.deepEqual(cell.style, uiPalette.sparkline, `${width}x30 spark foreground cell at ${x},${region.rect.y}`);
        }
      }
    }
  }
});

test('dashboard trend model uses sparse placeholders, flat baselines, and actual min/max scaling', () => {
  assert.deepEqual(dashboardTrendModel(Array(14).fill(0), { label: 'jobs/14d', dataDays: 0 }), {
    kind: 'placeholder', label: 'jobs/14d', dataDays: 0, placeholder: 'collecting data (0d)'
  });
  assert.equal(dashboardTrendModel([0, 0, 3], { label: 'jobs/14d', dataDays: 1 }).placeholder, 'collecting data (1d)');
  assert.deepEqual(dashboardTrendModel([4, 4, 4], { label: 'jobs/14d', dataDays: 3 }).levels, [0, 0, 0]);
  const normal = dashboardTrendModel([2, 4, 3], { label: 'jobs/14d', dataDays: 3 });
  assert.equal(normal.minimum, 2);
  assert.equal(normal.maximum, 4);
  assert.equal(normal.maxLabel, 'max 4');
  assert.deepEqual(normal.levels, [0, 7, 4]);
});

test('scrollable and static panes share border chrome while track and thumb stay inside joins', () => {
  const expectedPalette = createPalette(process.env);
  assert.deepEqual(uiPalette.border, expectedPalette.border, 'renderer and expectation share the isolated palette');
  const frame = {
    width: 50, height: 12,
    panes: [
      { rect: { x: 0, y: 1, width: 24, height: 10 }, focused: false, content: { kind: 'tile', value: '1', label: 'static' } },
      { rect: { x: 26, y: 1, width: 24, height: 10 }, focused: false, content: { kind: 'log', lines: Array.from({ length: 30 }, (_, index) => `line ${index}`), follow: false, scroll: 3 } }
    ]
  };
  const grid = paintFrame(frame);
  const staticStyle = grid.get(23, 1).style;
  assert.deepEqual(grid.get(49, 1).style, staticStyle, 'top-right join uses the ordinary border style');
  assert.deepEqual(grid.get(49, 10).style, grid.get(23, 10).style, 'bottom-right join uses the ordinary border style');
  for (let y = 2; y < 10; y += 1) {
    const style = grid.get(49, y).style;
    assert.ok(
      [expectedPalette.scrollTrack, expectedPalette.scrollThumb].some((expected) => {
        const actualEntries = Object.entries(style);
        const expectedEntries = Object.entries(expected);
        return actualEntries.length === expectedEntries.length
          && expectedEntries.every(([key, value]) => JSON.stringify(style[key]) === JSON.stringify(value));
      }),
      `scroll owner style at row ${y}`
    );
  }
});

test('dashboard aggregates only the final audit row per job and reads nested cached input', () => {
  const records = [
    { at: NOW - 5000, jobId: 'a', outcome: { status: 'completed' }, usage: { total: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 5_000_000 } } },
    { at: NOW - 4000, jobId: 'a', outcome: { status: 'completed' }, usage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 } } },
    { at: NOW - 3000, jobId: 'b', outcome: { status: 'completed' }, usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 10 } } }
  ];
  const frame = dashboardViewModel(store({ audit: records }), { now: NOW }, { width: 100, height: 30 });
  assert.deepEqual(frame.meta.todayUsage, { input: 150, output: 30, cached: 50 });
  assert.equal(frame.meta.todayJobs, 2);
  assert.equal(Math.round(frame.meta.meanCacheHit * 100), 33);
  assert.equal(frame.panes.find((pane) => pane.content?.label === 'tokens today').content.value, '180');
  assert.equal(frame.panes.find((pane) => pane.content?.label === 'mean cache hit').content.value, '33%');
});

test('dashboard and stats attribute cumulative Codex chains without multiplying thread totals', () => {
  const session = 'thread-cumulative';
  const makeJob = (id, parentJobId = null, provider = 'codex', providerSessionId = session) => ({
    id, parentJobId, rootJobId: 'round-0', provider, providerSessionId, model: provider === 'codex' ? 'gpt-5.4-sol' : 'composer',
    mode: 'review', status: 'completed', phase: 'completed', cwd: '/work', completedAt: NOW / 1000
  });
  const jobs = [makeJob('round-0')];
  const audit = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `round-${index}`;
    if (index) jobs.push(makeJob(id, 'round-0'));
    audit.push({
      at: NOW - (4 - index) * 1000, jobId: id, parentJobId: index ? 'round-0' : null, rootJobId: 'round-0',
      provider: 'codex', model: 'gpt-5.4-sol', mode: 'review', outcome: { status: 'completed' },
      usage: { total: { inputTokens: (index + 1) * 100, cachedInputTokens: (index + 1) * 40, outputTokens: (index + 1) * 10 } }
    });
  }
  jobs.push(makeJob('standalone', null, 'codex', 'thread-standalone'));
  audit.push({ at: NOW, jobId: 'standalone', provider: 'codex', model: 'gpt-5.4-sol', mode: 'review', outcome: { status: 'completed' }, usage: { total: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 5 } } });

  const attributed = attributeAuditUsage(audit, jobs);
  assert.deepEqual(attributeAuditOutputTokens(audit), attributed.map((entry) => entry.own.output), 'stats and TUI consumers agree on one synthetic chain fixture');
  const chainUsage = attributed.filter((row) => row.providerSessionId === session).map((row) => row.own);
  assert.deepEqual(chainUsage, Array.from({ length: 5 }, () => ({ input: 100, output: 10, cached: 40 })));
  assert.deepEqual(chainUsage.reduce((sum, usage) => ({
    input: sum.input + usage.input, output: sum.output + usage.output, cached: sum.cached + usage.cached
  }), { input: 0, output: 0, cached: 0 }), { input: 500, output: 50, cached: 200 }, 'five rounds attribute exactly the final thread totals');
  const frame = dashboardViewModel(store({ jobs, audit }), { now: NOW }, { width: 100, height: 30 });
  assert.deepEqual(frame.meta.todayUsage, { input: 550, output: 55, cached: 210 });
  assert.equal(Math.round(frame.meta.meanCacheHit * 100), 38);
  const tokenTile = frame.panes.find((pane) => pane.content?.label === 'tokens today').content;
  assert.equal(tokenTile.value, '605');
  assert.match(tokenTile.detail, /^in 550.*out 55$/);

  const statsFrame = statsViewModel(store({
    jobs,
    audit,
    stats: { since: '7d', groups: [{ provider: 'codex', model: 'sol', mode: 'review', jobs: 6, successRate: 1, meanOutputTokens: 999 }] }
  }), { now: NOW }, { width: 100, height: 30 });
  assert.equal(statsFrame.panes[0].content.rows[0].tokens, 9, 'mean output uses attributed 55/6 instead of cumulative finals');
});

test('usage attribution handles missing parents, Cursor jobs, cross-day parents, and counter resets', () => {
  const dayStart = new Date(NOW); dayStart.setHours(0, 0, 0, 0);
  const jobs = [
    { id: 'yesterday', provider: 'codex', providerSessionId: 'cross-day', status: 'completed' },
    { id: 'today', parentJobId: 'yesterday', rootJobId: 'yesterday', provider: 'codex', providerSessionId: 'cross-day', status: 'completed' },
    { id: 'missing', parentJobId: 'pruned', provider: 'codex', providerSessionId: 'missing-parent', status: 'completed' },
    { id: 'cursor-a', provider: 'cursor', providerSessionId: 'cursor-chat', status: 'completed' },
    { id: 'cursor-b', parentJobId: 'cursor-a', provider: 'cursor', providerSessionId: 'cursor-chat', status: 'completed' },
    { id: 'reset-root', provider: 'codex', providerSessionId: 'reset', status: 'completed' },
    { id: 'reset-child', parentJobId: 'reset-root', rootJobId: 'reset-root', provider: 'codex', providerSessionId: 'reset', status: 'completed' }
  ];
  const row = (jobId, at, provider, input, output, parentJobId = null) => ({
    at, jobId, parentJobId, provider, model: provider === 'cursor' ? 'composer' : 'gpt-5.4-sol', mode: 'review', outcome: { status: 'completed' },
    usage: provider === 'cursor' ? { input_tokens: input, output_tokens: output } : { total: { inputTokens: input, outputTokens: output } }
  });
  const rows = [
    row('yesterday', dayStart.getTime() - 1000, 'codex', 100, 10),
    row('today', dayStart.getTime() + 1000, 'codex', 180, 18, 'yesterday'),
    row('missing', dayStart.getTime() + 2000, 'codex', 70, 7, 'pruned'),
    row('cursor-a', dayStart.getTime() + 3000, 'cursor', 30, 3),
    row('cursor-b', dayStart.getTime() + 4000, 'cursor', 40, 4, 'cursor-a'),
    row('reset-root', dayStart.getTime() + 5000, 'codex', 100, 10),
    row('reset-child', dayStart.getTime() + 6000, 'codex', 50, 5, 'reset-root')
  ];
  const attributed = new Map(attributeAuditUsage(rows, jobs).map((entry) => [entry.jobId, entry]));
  assert.deepEqual(attributed.get('today').own, { input: 80, output: 8, cached: 0 });
  assert.deepEqual(attributed.get('missing').own, { input: 70, output: 7, cached: 0 });
  assert.deepEqual(attributed.get('cursor-a').own, { input: 30, output: 3, cached: 0 });
  assert.deepEqual(attributed.get('cursor-b').own, { input: 40, output: 4, cached: 0 });
  assert.deepEqual(attributed.get('reset-child').own, { input: 0, output: 0, cached: 0 });
  const dashboard = dashboardViewModel(store({ jobs, audit: rows }), { now: NOW }, { width: 100, height: 30 });
  assert.equal(dashboard.meta.todayUsage.input, 320, 'cross-day child subtracts yesterday while missing/Cursor jobs remain full');
});

test('events use aligned semantic columns, lazy JSON styling, grouping gaps, and expansion', () => {
  const events = [
    { seq: 1, at: NOW - 3000, type: 'message.delta', data: { text: 'hello', count: 1 } },
    { seq: 2, at: NOW - 2000, type: 'message.delta', data: { text: 'again', count: 2 } },
    { seq: 3, at: NOW - 1000, type: 'tool.completed', data: { output: 'x'.repeat(400), ok: true, exitCode: 0 } }
  ];
  const blocks = eventBlocks(events);
  const collapsed = wrapEventBlock(blocks[1], 70, '', { now: NOW, timestampMode: 'relative', expandedEvents: new Set() });
  assert.match(collapsed.lines[0], /^\s+2\s+/);
  assert.ok(!collapsed.lines.at(-1), 'different next type inserts one blank grouping row');
  assert.ok(collapsed.fragments[0].segments.some((segment) => segment.style === uiPalette.eventSeq));
  assert.ok(collapsed.fragments[1].segments.some((segment) => segment.style === uiPalette.jsonKey));
  const expanded = wrapEventBlock(blocks[2], 42, '', { now: NOW, timestampMode: 'relative', expandedEvents: new Set([blocks[2].key]) });
  assert.ok(expanded.lines.length > collapsed.lines.length);

  const many = eventBlocks(Array.from({ length: 5000 }, (_, index) => ({ seq: index + 1, at: NOW, type: 'message.delta', data: { text: `row ${index}` } })));
  const cache = new WrapCache();
  const grid = new CellGrid(80, 12);
  paintLogPane(grid, { x: 0, y: 0, width: 80, height: 12 }, {
    virtual: true, entries: many, formatEntry: formatEventBlock,
    wrapEntry: (block, width, formatted) => wrapEventBlock(block, width, formatted, { now: NOW, timestampMode: 'relative', expandedEvents: new Set() }),
    follow: false, scroll: { entry: 2500, line: 0 }
  }, { wrapCache: cache });
  assert.ok(cache.wrapCalls <= 24, `visible-window event formatting wrapped ${cache.wrapCalls} blocks`);
});

test('all navigation paths share bottom follow re-engagement and leaving-tail behavior', () => {
  const cache = new WrapCache();
  const log = { virtual: true, entries: Array.from({ length: 20 }, (_, index) => `entry ${index}\nbody`), follow: false };
  const bottom = virtualLogBottomPosition(log, 30, 6, cache);
  for (const path of ['arrow', 'page-down', 'end', 'wheel', 'click']) {
    const state = settleVirtualFollow(log, bottom, 30, 6, { selectedEntry: 19 }, cache);
    assert.equal(state.follow, true, `${path} re-engages at bottom`);
  }
  assert.equal(settleVirtualFollow(log, bottom, 30, 6, { selectedEntry: 18 }, cache).follow, false, 'selecting away from the tail disengages even if the viewport remains bottom-aligned');
  assert.equal(settleVirtualFollow(log, { entry: Math.max(0, bottom.entry - 1), line: 0 }, 30, 6, {}, cache).follow, false, 'leaving the bottom disengages');
});

test('history loading stays in the pane title and never inserts a shifting message row', () => {
  const state = store();
  state.hydrationByJob[state.jobs[0].id] = { loaded: false, loading: true, error: null };
  const frame = detailViewModel(state, { jobId: state.jobs[0].id, detailTab: 0, now: NOW, follow: true }, { width: 100, height: 30 });
  assert.equal(frame.panes[0].loading, true);
  assert.equal(frame.panes[0].content.kind, 'log');
  assert.deepEqual(frame.panes[0].content.lines, []);
  const grid = paintFrame(frame);
  assert.ok(grid.spinnerCells.size > 0, 'title loading indicator is an animated marked cell');
});

test('activity mapping animates busy states only and every active surface shares one phase', () => {
  for (const kind of ['working', 'thinking', 'streaming', 'compacting', 'tool']) {
    const indicator = activityIndicator({ kind, glyph: '>', label: kind, since: NOW - 1000, age: '1s', tone: 'accent' }, NOW);
    assert.equal(indicator.animated, true, kind);
    assert.equal(indicator.segments[0].spinner, true, kind);
  }
  for (const kind of ['approval', 'needs-input', 'paused', 'quiet', 'stalled']) {
    const indicator = activityIndicator({ kind, glyph: '!', label: kind, since: NOW - 1000, age: '1s', tone: 'warning' }, NOW);
    assert.equal(indicator.animated, false, kind);
    assert.equal(indicator.segments[0].spinner, undefined, kind);
  }

  const frame = dashboardViewModel(store(), { now: NOW }, { width: 100, height: 30 });
  const first = paintFrame(frame);
  assert.ok(first.spinnerCells.size > 0, 'running dashboard tile marks its spinner');
  const second = advanceSpinnerGrid(first, NOW + 100);
  assert.ok(second);
  for (const [x, y] of first.spinnerPositions()) assert.notEqual(first.get(x, y).char, second.get(x, y).char);

  let callback = null;
  let cleared = 0;
  const timer = { unref() {} };
  const animator = new SpinnerAnimator({
    setInterval(fn) { callback = fn; return timer; },
    clearInterval(value) { assert.equal(value, timer); cleared += 1; },
    onTick() {}
  });
  animator.setActive(true);
  assert.equal(animator.active, true);
  assert.equal(typeof callback, 'function');
  animator.setActive(false);
  assert.equal(animator.active, false);
  assert.equal(cleared, 1);

  const done = job({ status: 'completed', phase: 'completed', completedAt: NOW / 1000 });
  const idleFrame = dashboardViewModel(store({ jobs: [done], eventsByJob: { [done.id]: [] }, activityEventsByJob: { [done.id]: [] } }), { now: NOW }, { width: 100, height: 30 });
  assert.equal(paintFrame(idleFrame).spinnerCells.size, 0, 'no active jobs leaves the animation timer with no marked work');
});

test('app-bar painter owns a blank spacer row and all screen content starts below it', () => {
  const frame = dashboardViewModel(store(), { now: NOW }, { width: 80, height: 24 });
  assert.ok(frame.panes.every((pane) => pane.rect.y >= 2));
  const grid = paintFrame(frame);
  assert.equal(grid.lines()[1], ' '.repeat(80));
});
