import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import { configureGlyphs } from '../bin/lib/tui/glyphs.mjs';
import { createPalette, uiPalette } from '../bin/lib/tui/palette.mjs';
import { clearGraphemeWidthOverrides, setGraphemeWidthOverrides } from '../bin/lib/tui/width.mjs';
import { WIDTH_PROBE_GRAPHEMES } from '../bin/lib/tui/width-probe.mjs';
import {
  dashboardViewModel,
  DETAIL_TABS,
  HELP_ITEMS,
  detailViewModel,
  fleetViewModel,
  groupMembersViewModel,
  groupsViewModel,
  launcherViewModel,
  providersViewModel,
  statsViewModel
} from '../bin/lib/tui/viewmodels.mjs';

const NOW = 1_700_000_000_000;

function syntheticStore() {
  const active = {
    id: 'codex-active-1234567', provider: 'codex', model: 'sol', resolvedModel: 'gpt-5.4-sol', mode: 'implement',
    status: 'running', phase: 'working', revision: 4, cwd: '/work/alpha', createdAt: NOW / 1000 - 125,
    updatedAt: NOW / 1000 - 2, lastActivityAt: NOW - 5000, workerPid: 1234, workerAlive: true,
    maxOutputTokens: 8000, rootJobId: 'codex-root-7654321',
    groupId: 'wave-a', managedBy: 'delegate-control', providerSessionId: 'thread-a',
    scopeViolations: [{ path: 'outside.js' }], largeWrite: true, reviewFlowEngaged: true,
    usage: { total: { inputTokens: 4000, cachedInputTokens: 1000, outputTokens: 2000, totalTokens: 6000 } }
  };
  const done = {
    id: 'cursor-done-abcdef0', provider: 'cursor', model: 'composer', resolvedModel: 'composer-2.5', mode: 'review',
    status: 'completed', phase: 'completed', revision: 7, cwd: '/work/beta', createdAt: NOW / 1000 - 500,
    completedAt: NOW / 1000 - 60, updatedAt: NOW / 1000 - 60, lastActivityAt: NOW - 60000,
    resultSuspect: 'short-final-message', managedBy: 'delegate-control', providerSessionId: 'chat-b',
    resultText: 'I prepared the report.', changedFiles: { count: 0, files: [] }, verification: null,
    usage: { total: { inputTokens: 800, outputTokens: 120, totalTokens: 920 } }
  };
  const events = {
    [active.id]: [
      { v: 1, seq: 1, at: NOW - 120000, jobId: active.id, type: 'message.user', redacted: true, data: { text: 'Implement it' } },
      { v: 1, seq: 2, at: NOW - 5000, jobId: active.id, type: 'message.completed', redacted: true, data: { text: 'Working' } },
      { v: 1, seq: 3, at: NOW - 4000, jobId: active.id, type: 'usage.updated', redacted: true, data: active.usage }
    ],
    [done.id]: [{ v: 1, seq: 1, at: NOW - 60000, jobId: done.id, type: 'message.completed', redacted: true, data: { text: done.resultText } }]
  };
  return {
    jobs: [done, active], eventsByJob: events,
    hydrationByJob: { [active.id]: { loaded: true, loading: false, error: null }, [done.id]: { loaded: true, loading: false, error: null } },
    diffsByJob: { [active.id]: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n+one\n-two' },
    diffStatsByJob: { [active.id]: { files: [{ path: 'src/a.js', additions: 1, deletions: 1 }], totalFiles: 1, totalAdditions: 1, totalDeletions: 1 } },
    providers: [
      { name: 'claude', enabled: true, allowance: { known: false, usedPercent: null, windows: [] }, warningPercent: 80, avoidPercent: 90, lastVerified: null },
      { name: 'codex', enabled: true, allowance: { known: true, usedPercent: 42, windows: [{ name: 'five_hour', usedPercent: 42 }] }, warningPercent: 80, avoidPercent: 90, lastVerified: { ok: true, at: NOW - 10000 } },
      { name: 'cursor', enabled: false, allowance: { known: true, usedPercent: 76, windows: [{ name: 'first-party', usedPercent: 76 }] }, warningPercent: 70, avoidPercent: 80, lastVerified: null }
    ],
    writerLocks: [{ cwd: '/work/alpha', jobId: active.id, provider: 'codex', mode: 'implement', status: 'running', phase: 'working' }],
    profiles: ['independent-review'],
    groups: [{ groupId: 'wave-a', total: 1, running: 1, terminal: 0, stalled: 0, allTerminal: false, newestActivityAt: NOW - 5000, memberIds: [active.id] }],
    audit: [{ at: NOW - 60_000, jobId: done.id, provider: 'cursor', model: 'composer', mode: 'review', durationMs: 440_000, outcome: { status: 'completed' }, usage: done.usage, scopeViolationsCount: 0 }],
    stats: { since: '7d', jobs: 2, groups: [{ provider: 'codex', model: 'sol', mode: 'implement', jobs: 2, successRate: 0.5, resumedJobs: 1, nudgeCount: 0, meanDurationMs: 1234, meanOutputTokens: 2000, budgetCount: 0, timeoutCount: 1, violationCount: 1 }] }
  };
}

test('fleet rows sort active first, expose compact safety badges, and filter id/model/cwd', () => {
  const store = syntheticStore();
  const frame = fleetViewModel(store, { now: NOW }, { width: 100, height: 30 });
  assert.deepEqual(frame.meta.visibleJobIds, ['codex-active-1234567', 'cursor-done-abcdef0']);
  const columns = frame.panes[0].content.columns;
  const badgesIndex = columns.findIndex((column) => column.key === 'badges');
  assert.equal(frame.panes[0].content.rows[0].cells[badgesIndex].text, 'S1,L,RF');
  const filtered = fleetViewModel(store, { now: NOW, filter: 'beta' }, { width: 100, height: 30 });
  assert.deepEqual(filtered.meta.visibleJobIds, ['cursor-done-abcdef0']);
  const activeOnly = fleetViewModel(store, { now: NOW, activeOnly: true }, { width: 100, height: 30 });
  assert.deepEqual(activeOnly.meta.visibleJobIds, ['codex-active-1234567']);
});

test('fleet and Record derive failed state for stale queued records before durable reconciliation', () => {
  const store = syntheticStore();
  const stale = {
    id: 'codex-stale-7654321', provider: 'codex', model: 'sol', mode: 'review', status: 'queued', phase: 'queued',
    revision: 1, cwd: '/work/stale', createdAt: NOW / 1000 - 700, updatedAt: NOW / 1000 - 700,
    lastActivityAt: NOW - 700000, workerPid: null, workerAlive: false, managedBy: 'delegate-control'
  };
  store.jobs.push(stale);
  const frame = fleetViewModel(store, { now: NOW }, { width: 100, height: 30 });
  const rowIndex = frame.meta.visibleJobIds.indexOf(stale.id);
  const activityIndex = frame.panes[0].content.columns.findIndex((column) => column.key === 'activity');
  assert.match(frame.panes[0].content.rows[rowIndex].cells[activityIndex].text, /failed/);
  assert.ok(frame.meta.reconcileJobIds.includes(stale.id));

  const activeOnly = fleetViewModel(store, { now: NOW, activeOnly: true }, { width: 100, height: 30 });
  assert.ok(!activeOnly.meta.visibleJobIds.includes(stale.id));

  const record = detailViewModel(store, { jobId: stale.id, detailTab: 2, now: NOW }, { width: 100, height: 30 });
  assert.match(record.panes[0].content.lines[0].text, /^\(reconciled\)/);
  assert.match(record.panes[0].content.lines.map((line) => line.text ?? line).join('\n'), /"status": "failed"/);
});

test('detail view models every tab and exposes diff-file selection metadata', () => {
  const store = syntheticStore();
  for (let tab = 0; tab < DETAIL_TABS.length; tab += 1) {
    const frame = detailViewModel(store, { jobId: 'codex-active-1234567', detailTab: tab, now: NOW }, { width: 100, height: 30 });
    assert.equal(frame.tabs.active, tab);
    assert.equal(frame.screen, 'detail');
  }
  const diff = detailViewModel(store, { jobId: 'codex-active-1234567', detailTab: 1 }, { width: 100, height: 30 });
  assert.deepEqual(diff.meta.diffFiles, ['src/a.js']);
  const record = detailViewModel(store, { jobId: 'cursor-done-abcdef0', detailTab: 2 }, { width: 100, height: 30 });
  assert.match(record.panes[0].content.lines.join('\n'), /"resumable"/);
});

test('detail transcript exposes history hydration progress instead of a blank pane', () => {
  const store = syntheticStore();
  delete store.eventsByJob['codex-active-1234567'];
  store.hydrationByJob['codex-active-1234567'] = { loaded: false, loading: true, error: null };
  const frame = detailViewModel(store, { jobId: 'codex-active-1234567', detailTab: 0, follow: true }, { width: 100, height: 30 });
  assert.equal(frame.panes[0].loading, true);
  assert.equal(frame.panes[0].content.kind, 'log');
  assert.deepEqual(frame.panes[0].content.lines, []);
  assert.doesNotMatch(frame.panes[0].title, /loading history/);
});

test('fleet and detail snapshots expose live activity, transient thinking, and honest headless visibility', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  configureGlyphs({ env: { TERM: 'xterm', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  const store = syntheticStore();
  const id = 'codex-active-1234567';
  store.eventsByJob[id] = [...store.eventsByJob[id], { v: 1, seq: 4, at: NOW - 12_000, jobId: id, type: 'activity', redacted: true, data: { kind: 'thinking', at: NOW - 12_000 } }];
  const fleet = fleetViewModel(store, { now: NOW }, { width: 100, height: 30 });
  const activityIndex = fleet.panes[0].content.columns.findIndex((column) => column.key === 'activity');
  assert.match(fleet.panes[0].content.rows[0].cells[activityIndex].text, /thinking \| 12s$/);

  const detail = detailViewModel(store, { jobId: id, detailTab: 0, now: NOW, follow: true }, { width: 100, height: 30 });
  assert.match(detail.title.right, /thinking \| 12s/);
  assert.equal(detail.meta.activity.kind, 'thinking');
  assert.equal(detail.panes[0].content.entries.at(-1).kind, 'thinking');
  const rendered = renderFrameToString(detail, { trimEnd: true }).split('\n').map((line) => line.trimEnd()).join('\n');
  const snapshot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-detail-activity-100x30.txt'), 'utf8').trimEnd();
  assert.equal(rendered, snapshot);

  store.eventsByJob[id] = [...store.eventsByJob[id], { v: 1, seq: 5, at: NOW - 1000, jobId: id, type: 'message.delta', redacted: true, data: { id: 'next', delta: 'Visible output' } }];
  const output = detailViewModel(store, { jobId: id, detailTab: 0, now: NOW, follow: true }, { width: 100, height: 30 });
  assert.equal(output.meta.activity.kind, 'streaming');
  assert.ok(!output.panes[0].content.entries.some((entry) => entry.kind === 'thinking'));

  store.jobs = store.jobs.map((job) => job.id === id ? { ...job, provider: 'cursor', transport: 'headless' } : job);
  store.eventsByJob[id] = [{ v: 1, seq: 1, at: NOW - 1000, jobId: id, type: 'activity', redacted: true, data: { kind: 'thinking', at: NOW - 1000 } }];
  const headless = detailViewModel(store, { jobId: id, detailTab: 0, now: NOW }, { width: 100, height: 30 });
  assert.equal(headless.meta.activity.kind, 'working');
  assert.match(headless.title.right, /headless transport: reduced visibility/);
});

test('remote clock offset keeps activity windows aligned to the newest server timeline', () => {
  const store = syntheticStore();
  const id = 'codex-active-1234567';
  store.remote = { enabled: true, host: 'remote.test', clockOffsetMs: -60_000 };
  store.eventsByJob[id] = [{ v: 1, seq: 1, at: NOW - 1000, jobId: id, type: 'message.delta', redacted: true, data: { id: 'live', delta: 'output' } }];
  const frame = detailViewModel(store, { jobId: id, detailTab: 0, now: NOW + 60_000, remote: store.remote }, { width: 100, height: 30 });
  assert.equal(frame.meta.activity.kind, 'streaming');
});

test('timestamp mode, fleet density, and provider/token sort are reflected in pure frames', () => {
  const store = syntheticStore();
  const first = 'codex-active-1234567';
  store.eventsByJob[first] = [{ v: 1, seq: 1, at: NOW - 180_000, jobId: first, type: 'message.completed', redacted: true, data: { id: 'stamp', text: 'timestamped' } }];
  const absolute = detailViewModel(store, { jobId: first, detailTab: 0, now: NOW, timestampMode: 'absolute' }, { width: 100, height: 30 });
  const relative = detailViewModel(store, { jobId: first, detailTab: 0, now: NOW, timestampMode: 'relative' }, { width: 100, height: 30 });
  assert.match(absolute.panes[0].content.entries[0].timestamp, /^\d\d:\d\d:\d\d$/);
  assert.equal(relative.panes[0].content.entries[0].timestamp, '3m ago');

  const second = { ...store.jobs.find((job) => job.id === first), id: 'cursor-active-high-tokens', provider: 'cursor', updatedAt: NOW / 1000 - 1, lastActivityAt: NOW - 1000, usage: { total: { outputTokens: 7000 } } };
  store.jobs.push(second);
  store.eventsByJob[second.id] = [];
  const tokens = fleetViewModel(store, { now: NOW, fleetSort: 'tokens', fleetDensity: 'compact' }, { width: 100, height: 30 });
  assert.equal(tokens.meta.visibleJobIds[0], second.id);
  assert.equal(tokens.meta.fleetDensity, 'compact');
  assert.match(tokens.title.text, /sort:tokens \| compact/);
  const provider = fleetViewModel(store, { now: NOW, fleetSort: 'provider' }, { width: 100, height: 30 });
  assert.equal(provider.meta.visibleJobIds[0], first);
});

test('providers render a smooth band-colored fill over a dim track', () => {
  const frame = providersViewModel(syntheticStore(), {}, { width: 100, height: 30 });
  const columns = frame.panes[0].content.columns;
  const barIndex = columns.findIndex((column) => column.key === 'bar');
  const cursorBar = frame.panes[0].content.rows.find((row) => row.provider === 'cursor').bar;
  assert.ok(cursorBar.segments.some((segment) => segment.style === uiPalette.dim));
  assert.ok(cursorBar.segments.some((segment) => segment.style === uiPalette.meterTrack));
  assert.equal(columns[barIndex].title, 'Allowance | warning | avoid');
});

test('stats and launcher frames use seven days and show the exact dry-run packet', () => {
  const store = syntheticStore();
  const stats = statsViewModel(store, {}, { width: 100, height: 30 });
  assert.match(stats.title.text, /last 7d/);
  assert.equal(stats.panes[0].content.rows[0].success, '50%');
  const filteredStats = statsViewModel(store, { statsFilter: 'cursor' }, { width: 100, height: 30 });
  assert.equal(filteredStats.meta.visibleStatsCount, 0);
  const launcher = launcherViewModel(store, {
    launcher: {
      fieldIndex: 5, provider: 'codex', model: 'sol', mode: 'review', effort: 'xhigh', prompt: 'Review it', allowedPaths: ['src'],
      preview: { provider: 'codex', model: 'sol', mode: 'review', effort: 'xhigh', cwd: '/work/alpha', packetWarnings: ['missing section: Return'], packet: '# Objective\nReview it\n\n# Return\nFindings' }
    }
  }, { width: 100, height: 30 });
  assert.equal(launcher.meta.previewReady, true);
  assert.ok(launcher.meta.fields.includes('verifyCommand'));
  assert.ok(launcher.meta.fields.includes('ingestFiles'));
  assert.match(launcher.panes[1].content.lines.join('\n'), /# Objective\nReview it/);
  assert.match(launcher.panes[1].content.lines.join('\n'), /WARNING: missing section: Return/);
});

test('dashboard is attention-first and derives today tiles, providers, feed, and trends without scanning', () => {
  const expectedPalette = createPalette(process.env);
  const store = syntheticStore();
  store.audit[0].usage = { total: { inputTokens: 800, cachedInputTokens: 200, outputTokens: 120 } };
  const frame = dashboardViewModel(store, { now: NOW, timestampMode: 'relative', dashboardFocus: 0 }, { width: 100, height: 30 });
  assert.equal(frame.screen, 'dashboard');
  assert.equal(frame.panes[0].title, 'Needs you');
  assert.deepEqual(frame.meta.attentionJobIds, ['codex-active-1234567', 'cursor-done-abcdef0']);
  assert.deepEqual(frame.meta.feedJobIds, ['cursor-done-abcdef0']);
  assert.equal(frame.meta.selectedJobId, 'codex-active-1234567');
  assert.equal(frame.meta.trends.jobs.length, 14);
  assert.ok(frame.panes.some((pane) => pane.title === 'Provider allowance'));
  assert.ok(frame.panes.some((pane) => pane.title === 'Recent notable activity'));
  assert.equal(frame.panes.find((pane) => pane.content?.label === 'mean cache hit').content.value, '25%');
  const grid = paintFrame(frame);
  const focused = frame.panes.find((pane) => pane.focused);
  assert.ok(focused);
  assert.deepEqual(uiPalette.focusBorder, expectedPalette.focusBorder, 'renderer and expectation share the isolated palette');
  assert.deepEqual(grid.get(focused.rect.x, focused.rect.y).style, expectedPalette.focusBorder);
  assert.equal(grid.get(0, 1).char, ' ', 'row one remains the app-bar-owned spacer');
  assert.deepEqual(grid.get(0, 1).style, expectedPalette.body);
});

test('dashboard frame snapshots are deterministic in ASCII and probe-proven Unicode modes', (t) => {
  t.after(() => { clearGraphemeWidthOverrides(); configureGlyphs({ env: process.env, widths: {} }); });
  const store = syntheticStore();
  const frame = () => dashboardViewModel(store, { now: NOW, timestampMode: 'relative', dashboardFocus: 0 }, { width: 100, height: 30 });
  configureGlyphs({ env: { TERM: 'xterm', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  clearGraphemeWidthOverrides();
  const ascii = renderFrameToString(frame(), { trimEnd: true });
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots');
  assert.equal(ascii, fs.readFileSync(path.join(directory, 'tui-dashboard-100x30-ascii.txt'), 'utf8').trimEnd());

  const widths = Object.fromEntries(WIDTH_PROBE_GRAPHEMES.map((glyph) => [glyph, 1]));
  setGraphemeWidthOverrides(widths);
  configureGlyphs({ env: { TERM: 'tmux-256color', LANG: 'en_US.UTF-8' }, widths });
  const unicode = renderFrameToString(frame(), { trimEnd: true });
  assert.equal(unicode, fs.readFileSync(path.join(directory, 'tui-dashboard-100x30-unicode.txt'), 'utf8').trimEnd());
  assert.match(unicode, /╭─ Needs you/);
  assert.match(ascii, /\+- Needs you/);
});

test('dashboard trend frames snapshot sparse, single-day, flat, and normal histories exactly', (t) => {
  t.after(() => { clearGraphemeWidthOverrides(); configureGlyphs({ env: process.env, widths: {} }); });
  const widths = Object.fromEntries(WIDTH_PROBE_GRAPHEMES.map((glyph) => [glyph, 1]));
  setGraphemeWidthOverrides(widths);
  configureGlyphs({ env: { TERM: 'tmux-256color', LANG: 'en_US.UTF-8' }, widths });
  const dayStart = new Date(NOW); dayStart.setHours(0, 0, 0, 0);
  const auditFor = (counts, durations) => counts.flatMap((count, day) => Array.from({ length: count }, (_, index) => ({
    at: dayStart.getTime() - (13 - day) * 86_400_000 + 1000 + index,
    jobId: `trend-${day}-${index}`,
    provider: 'cursor', model: 'composer', mode: 'review', durationMs: durations[day],
    outcome: { status: 'completed' },
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 25 }, output_tokens: 20 }
  })));
  const cases = [
    ['sparse-two-days', Array(12).fill(0).concat([1, 1]), Array(12).fill(0).concat([1000, 2000])],
    ['single-day', Array(13).fill(0).concat([1]), Array(13).fill(0).concat([1000])],
    ['zero-variance', Array(14).fill(1), Array(14).fill(5000)],
    ['normal', [1, 2, 1, 3, 2, 4, 2, 1, 3, 4, 2, 5, 3, 6], [1000, 2000, 1500, 3000, 2500, 5000, 2200, 1800, 4000, 3500, 2800, 6000, 4500, 7000]]
  ];
  const snapshot = cases.map(([name, counts, durations]) => {
    const state = syntheticStore();
    state.audit = auditFor(counts, durations);
    const frame = dashboardViewModel(state, { now: NOW, timestampMode: 'relative', dashboardFocus: 0 }, { width: 100, height: 30 });
    const rendered = renderFrameToString(frame).split('\n');
    const tiles = frame.panes.filter((pane) => pane.content?.kind === 'tile');
    const top = Math.min(...tiles.map((pane) => pane.rect.y));
    const bottom = Math.max(...tiles.map((pane) => pane.rect.y + pane.rect.height - 1));
    return `## ${name}\n${rendered.slice(top, bottom + 1).join('\n')}`;
  }).join('\n\n');
  const expected = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-dashboard-trends.txt'), 'utf8').trimEnd();
  assert.equal(snapshot, expected);
  assert.match(snapshot, /collecting data \(2d\)/);
  assert.match(snapshot, /collecting data \(1d\)/);
  assert.match(snapshot, /jobs\/14d ▁+/);
  assert.match(snapshot, /jobs\/14d .*max 6/);
});

test('help lists mouse, viewport, and edge navigation alongside every action group', () => {
  const keys = HELP_ITEMS.map((item) => item.key).join(' ');
  for (const key of ['wheel', 'PgUp', 'PgDn', 'Home', 'End', 'G / S / p', 'j/k', '1-6', 's / r / R', 'c / v / w', 'q']) {
    assert.match(keys, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const frame = fleetViewModel(syntheticStore(), { now: NOW, help: true }, { width: 80, height: 24 });
  assert.equal(frame.overlay.items.length, HELP_ITEMS.length);
});

test('fixed 100x30 fleet headless frame is deterministic', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  configureGlyphs({ env: { TERM: 'xterm', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  const frame = fleetViewModel(syntheticStore(), { now: NOW }, { width: 100, height: 30 });
  const rendered = renderFrameToString(frame, { trimEnd: true });
  const snapshot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-fleet-100x30.txt'), 'utf8').trimEnd();
  assert.equal(rendered, snapshot);
  assert.equal(rendered.split('\n').length, 30);
  assert.match(rendered, /^ delegate \| fleet/m);
  assert.match(rendered, /S1 L RF/);
  assert.match(rendered, /Enter detail/);

  const grid = paintFrame(frame);
  assert.deepEqual(grid.get(0, 29).style, uiPalette.bar);
  assert.deepEqual(grid.get(2, 3).style, uiPalette.header);
  assert.deepEqual(grid.get(1, 4).style, uiPalette.selectionBar);
  assert.deepEqual(grid.get(4, 4).style, { ...uiPalette.selectedId, ...uiPalette.selection });
  assert.deepEqual(
    Object.fromEntries(Object.entries(grid.get(3, 4).style).filter(([key]) => key !== 'bold')),
    uiPalette.selection
  );
  assert.equal(grid.get(3, 4).style.bold, true);
  assert.equal(Object.hasOwn(grid.get(3, 4).style, 'fg'), false);
  assert.deepEqual(grid.get(24, 4).style, uiPalette.selection);
  assert.equal(grid.get(24, 4).style.bold, undefined);
});

test('every screen paints at realistic resize breakpoints with filters, follow, launcher, and help state', () => {
  const store = syntheticStore();
  const screens = [
    (viewport) => dashboardViewModel(store, { now: NOW, dashboardFocus: 0 }, viewport),
    (viewport) => fleetViewModel(store, { now: NOW, filter: 'work', activeOnly: false, selectedIndex: 1 }, viewport),
    ...(DETAIL_TABS.map((_name, detailTab) => (viewport) => detailViewModel(store, {
      jobId: 'codex-active-1234567', detailTab, now: NOW, follow: detailTab % 2 === 0,
      eventFilter: detailTab === 4 ? 'message' : '', diffSelection: 0
    }, viewport))),
    (viewport) => providersViewModel(store, { providerScroll: 0 }, viewport),
    (viewport) => groupsViewModel(store, { now: NOW, groupSelection: 0 }, viewport),
    (viewport) => groupMembersViewModel(store, { now: NOW, groupId: 'wave-a', groupMemberSelection: 0 }, viewport),
    (viewport) => statsViewModel(store, { statsSelection: 0 }, viewport),
    (viewport) => launcherViewModel(store, {
      launcher: {
        fieldIndex: 0, profile: 'independent-review', provider: 'codex', model: 'sol', mode: 'review', effort: 'high',
        prompt: 'Review it', allowedPaths: ['src'],
        preview: { provider: 'codex', model: 'sol', mode: 'review', packetWarnings: [], packet: '# Objective\nReview it' }
      }
    }, viewport),
    (viewport) => fleetViewModel(store, { now: NOW, help: true }, viewport)
  ];
  for (const viewport of [{ width: 60, height: 18 }, { width: 80, height: 24 }, { width: 100, height: 30 }, { width: 140, height: 40 }]) {
    for (const makeFrame of screens) {
      const frame = makeFrame(viewport);
      const grid = paintFrame(frame);
      assert.equal(grid.columns, viewport.width);
      assert.equal(grid.rows, viewport.height);
      assert.equal(grid.get(0, viewport.height - 1).style.bg, uiPalette.bar.bg);
    }
  }
});

export { syntheticStore };
