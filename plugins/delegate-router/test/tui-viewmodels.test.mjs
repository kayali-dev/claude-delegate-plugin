import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import { uiPalette } from '../bin/lib/tui/palette.mjs';
import {
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
  const stateIndex = frame.panes[0].content.columns.findIndex((column) => column.key === 'state');
  assert.match(frame.panes[0].content.rows[rowIndex].cells[stateIndex].text, /^failed/);
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
  assert.match(frame.panes[0].title, /loading history/);
  assert.match(frame.panes[0].content.lines[0].text, /Loading journal history/);
});

test('providers render warning and avoid zones as styled bar segments', () => {
  const frame = providersViewModel(syntheticStore(), {}, { width: 100, height: 30 });
  const columns = frame.panes[0].content.columns;
  const barIndex = columns.findIndex((column) => column.key === 'bar');
  const cursorBar = frame.panes[0].content.rows.find((row) => row.provider === 'cursor').bar;
  assert.ok(cursorBar.segments.some((segment) => segment.style === uiPalette.badgeWarn));
  assert.ok(cursorBar.segments.some((segment) => segment.style === uiPalette.failed));
  assert.equal(columns[barIndex].title, 'Allowance · warning · avoid');
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

test('help lists mouse, viewport, and edge navigation alongside every action group', () => {
  const keys = HELP_ITEMS.map((item) => item.key).join(' ');
  for (const key of ['wheel', 'PgUp', 'PgDn', 'Home', 'End', 'G / p', 'j/k', '1…6', 's / r / R', 'c / v / w', 'q']) {
    assert.match(keys, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const frame = fleetViewModel(syntheticStore(), { now: NOW, help: true }, { width: 80, height: 24 });
  assert.equal(frame.overlay.items.length, HELP_ITEMS.length);
});

test('fixed 100x30 fleet headless frame is deterministic', () => {
  const frame = fleetViewModel(syntheticStore(), { now: NOW }, { width: 100, height: 30 });
  const rendered = renderFrameToString(frame, { trimEnd: true });
  const snapshot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-fleet-100x30.txt'), 'utf8').trimEnd();
  assert.equal(rendered, snapshot);
  assert.equal(rendered.split('\n').length, 30);
  assert.match(rendered, /^ Delegate fleet/m);
  assert.match(rendered, /S1,L,RF/);
  assert.match(rendered, /Enter detail/);

  const grid = paintFrame(frame);
  assert.deepEqual(grid.get(0, 29).style, uiPalette.bar);
  assert.deepEqual(grid.get(1, 2).style, uiPalette.header);
  assert.deepEqual(grid.get(2, 4).style, {});
  assert.deepEqual(
    Object.fromEntries(Object.entries(grid.get(1, 3).style).filter(([key]) => key !== 'bold')),
    uiPalette.selection
  );
  assert.equal(grid.get(1, 3).style.bold, true);
  assert.equal(Object.hasOwn(grid.get(1, 3).style, 'fg'), false);
  assert.deepEqual(grid.get(23, 3).style, uiPalette.selection);
  assert.equal(grid.get(23, 3).style.bold, undefined);
});

test('every screen paints at realistic resize breakpoints with filters, follow, launcher, and help state', () => {
  const store = syntheticStore();
  const screens = [
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
