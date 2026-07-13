import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { aggregateJobGroups } from '../bin/lib/tui/datasource.mjs';
import { editTextInEditor } from '../bin/lib/tui/editor.mjs';
import { decodeInput } from '../bin/lib/tui/input.mjs';
import { NotificationDispatcher } from '../bin/lib/tui/notifications.mjs';
import { createPalette, lightBarBg, lightBarFg, lightSearchMatchBg, lightSelectionBg } from '../bin/lib/tui/palette.mjs';
import { LogicalSearchIndex, nextSearchMatch } from '../bin/lib/tui/search.mjs';
import { CellGrid, Screen } from '../bin/lib/tui/screen.mjs';
import {
  WrapCache,
  paintFrame,
  paintLogPane,
  tableRowIndexAt,
  tabIndexAtColumn,
  virtualSearchPosition
} from '../bin/lib/tui/components.mjs';
import { detailViewModel, groupsViewModel, routeAdvisorLines } from '../bin/lib/tui/viewmodels.mjs';
import { mouseReportingOff, mouseReportingOn } from '../bin/lib/tui/ansi.mjs';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-p2a-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('groups aggregate member breakdowns and all-terminal barrier states', () => {
  const jobs = [
    { id: 'run', groupId: 'wave-a', status: 'running', lastActivityAt: 100 },
    { id: 'stall', groupId: 'wave-a', status: 'running', stalled: true, lastActivityAt: 300 },
    { id: 'done', groupId: 'wave-a', status: 'completed', lastActivityAt: 200 },
    { id: 'fail', groupId: 'wave-b', status: 'failed', lastActivityAt: 400 },
    { id: 'cancel', groupId: 'wave-b', status: 'cancelled', lastActivityAt: 350 },
    { id: 'ungrouped', status: 'running' }
  ];
  const groups = aggregateJobGroups(jobs);
  const first = groups.find((group) => group.groupId === 'wave-a');
  assert.deepEqual({ total: first.total, running: first.running, terminal: first.terminal, stalled: first.stalled, allTerminal: first.allTerminal },
    { total: 3, running: 1, terminal: 1, stalled: 1, allTerminal: false });
  assert.equal(first.newestActivityAt, 300);
  assert.equal(groups.find((group) => group.groupId === 'wave-b').allTerminal, true);

  const frame = groupsViewModel({ groups }, { now: 500, groupSelection: 1 }, { width: 100, height: 30 });
  assert.equal(frame.meta.groupIds.length, 2);
  assert.equal(paintFrame(frame).rows, 30);
});

test('chain tab orders resume rounds and exposes exact jump targets', () => {
  const root = { id: 'codex-root-0000001', provider: 'codex', mode: 'implement', status: 'completed', createdAt: 10, resultText: 'root outcome', changedFiles: { count: 2 }, verification: { exitCode: 0 }, objectiveMet: true };
  const second = { id: 'codex-child-0000002', provider: 'codex', mode: 'review', status: 'completed', createdAt: 20, parentJobId: root.id, rootJobId: root.id, resultText: 'second outcome\nmore', changedFiles: { count: 1 }, verification: { exitCode: 7 }, resultSuspect: 'short' };
  const third = { id: 'codex-child-0000003', provider: 'codex', mode: 'implement', status: 'running', createdAt: 30, parentJobId: second.id, rootJobId: root.id, resultText: 'third outcome', changedFiles: { count: 3 } };
  const store = { jobs: [third, root, second], eventsByJob: {}, hydrationByJob: {}, diffStatsByJob: {} };
  const frame = detailViewModel(store, { jobId: second.id, detailTab: 5, chainSelection: 1 }, { width: 110, height: 28 });
  assert.equal(frame.tabs.items.at(-1), 'Chain');
  assert.deepEqual(frame.meta.chainJobIds, [root.id, second.id, third.id]);
  assert.match(frame.panes[0].content.rowAt(1).marker.text, /suspect:short/);
  assert.equal(frame.panes[0].content.rowAt(1).verify, '7');
  assert.equal(frame.meta.chainJobIds[frame.panes[0].content.selected], second.id);
});

test('incremental logical search maps hits lazily through the wrap cache and navigates both directions', () => {
  const entries = Array.from({ length: 5000 }, (_, index) => ({ text: index % 100 === 0 ? `entry ${index} Needle target` : `entry ${index}` }));
  const formatter = (entry) => entry.text;
  const index = new LogicalSearchIndex(entries, formatter);
  const cache = new WrapCache();
  const matches = index.find('needle');
  assert.equal(matches.length, 50);
  assert.equal(cache.wrapCalls, 0, 'building and querying the logical index must not wrap history');
  const log = { virtual: true, entries, formatEntry: formatter, follow: false, scroll: 0, searchQuery: 'needle' };
  const position = virtualSearchPosition(log, matches[0], 40, cache);
  assert.deepEqual(position, { entry: 0, line: 0 });
  assert.equal(cache.wrapCalls, 1, 'mapping one hit wraps only its entry');
  paintLogPane(new CellGrid(40, 12), { x: 0, y: 0, width: 40, height: 12 }, { ...log, scroll: position }, { wrapCache: cache });
  assert.ok(cache.wrapCalls <= 26, `viewport plus bounded overscan wrapped ${cache.wrapCalls} entries`);
  assert.equal(nextSearchMatch(0, matches.length, 1), 1);
  assert.equal(nextSearchMatch(0, matches.length, -1), 49);

  const highlighted = new CellGrid(40, 2);
  paintLogPane(highlighted, { x: 0, y: 0, width: 40, height: 2 }, { ...log, entries: entries.slice(0, 1), scroll: position }, { wrapCache: new WrapCache() });
  assert.ok(highlighted.cells.flat().some((cell) => cell.style.bold), 'visible matches receive the semantic search-match style');
});

test('editor handoff restores terminal, runs a scripted editor, and fully re-enters the screen', (t) => {
  const directory = temporaryDirectory(t);
  const fake = path.join(directory, 'fake-editor.mjs');
  fs.writeFileSync(fake, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'edited body\\n');\n", { mode: 0o700 });
  const output = { text: '', columns: 40, rows: 10, isTTY: true, write(value) { this.text += value; return true; } };
  const raw = [];
  const input = { isTTY: true, setRawMode(value) { raw.push(value); }, resume() {}, pause() {} };
  const screen = new Screen({ output, input, columns: 40, rows: 10 });
  screen.start();
  const result = editTextInEditor({
    screen, text: 'old body', env: { VISUAL: process.execPath }, stateDirectory: directory,
    spawnEditor({ file }) {
      output.text += '<FAKE_EDITOR>';
      return spawnSync(process.execPath, [fake, file], { encoding: 'utf8' });
    }
  });
  assert.equal(result.accepted, true);
  assert.equal(result.text, 'edited body\n');
  const marker = output.text.indexOf('<FAKE_EDITOR>');
  assert.ok(output.text.lastIndexOf(mouseReportingOff, marker) < marker);
  assert.ok(output.text.indexOf(mouseReportingOn, marker) > marker);
  assert.deepEqual(raw, [true, false, true]);
  const rejected = editTextInEditor({
    screen, text: 'keep me', env: { EDITOR: process.execPath }, stateDirectory: directory,
    spawnEditor({ file }) { fs.writeFileSync(file, 'discard me'); return { status: 7, signal: null }; }
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.text, 'keep me');
  screen.stop();
  assert.deepEqual(raw, [true, false, true, false, true, false]);
});

test('route advisor formats primary, top fallback, scores, and observed usage bands', () => {
  const lines = routeAdvisorLines({
    kind: 'implementation', mode: 'implement', effort: 'high',
    primary: { provider: 'cursor', model: 'auto', score: 105, reason: 'best fit', usageBand: { p50OutputTokens: 1200, p90OutputTokens: 3400, samples: 8 } },
    fallbacks: [{ provider: 'codex', model: 'terra', score: 80 }]
  });
  assert.match(lines[1], /Primary: cursor\/auto · score 105 · p50 1200 \/ p90 3400 out \(8\)/);
  assert.match(lines[2], /Fallback: codex\/terra · score 80/);
});

test('notification dispatch is safe, debounced, and disabled by DELEGATE_TUI_NOTIFY=0', () => {
  let now = 10_000;
  const calls = [];
  const dispatcher = new NotificationDispatcher({
    env: {}, platform: 'darwin', now: () => now, resolveCommand: () => '/usr/bin/osascript',
    spawn(command, args) { calls.push({ command, args }); return {}; }
  });
  const running = { id: 'codex-safe-id', provider: 'codex', status: 'running', prompt: 'SECRET_PROMPT' };
  dispatcher.observe({ jobs: [running] });
  dispatcher.observe({ jobs: [{ ...running, status: 'completed' }] });
  assert.equal(calls.length, 1);
  now += 1000;
  dispatcher.observe({ jobs: [{ ...running, status: 'completed', scopeViolations: [{ path: 'safe.js' }] }] });
  assert.equal(calls.length, 1, 'same-job notification storms are suppressed for five seconds');
  now += 5000;
  dispatcher.observe({ jobs: [{ ...running, status: 'completed', scopeViolations: [{}, {}] }] });
  assert.equal(calls.length, 2);
  dispatcher.observe({ jobs: [
    { ...running, status: 'completed', scopeViolations: [{}, {}] },
    { id: 'cursor-stall', provider: 'cursor', status: 'running', stalled: false },
    { id: 'codex-budget', provider: 'codex', status: 'running' }
  ] });
  now += 100;
  dispatcher.observe({ jobs: [
    { ...running, status: 'completed', scopeViolations: [{}, {}] },
    { id: 'cursor-stall', provider: 'cursor', status: 'running', stalled: true },
    { id: 'codex-budget', provider: 'codex', status: 'failed', stoppedReason: 'budget' }
  ] });
  assert.equal(calls.length, 4);
  assert.match(JSON.stringify(calls), /stalled/);
  assert.match(JSON.stringify(calls), /budget/);
  assert.doesNotMatch(JSON.stringify(calls), /SECRET_PROMPT|safe\.js/);

  const disabledCalls = [];
  const disabled = new NotificationDispatcher({ env: { DELEGATE_TUI_NOTIFY: '0' }, platform: 'linux', resolveCommand: () => '/usr/bin/notify-send', spawn(...args) { disabledCalls.push(args); } });
  disabled.observe({ jobs: [running] });
  disabled.observe({ jobs: [{ ...running, stalled: true }] });
  assert.equal(disabledCalls.length, 0);
  assert.equal(disabled.toggle(), false);
});

test('SGR button press exposes click coordinates for row selection and tab switching', () => {
  const event = decodeInput('\u001b[<0;12;8M', { final: true }).events[0];
  assert.deepEqual(event, { type: 'click', button: 0, x: 11, y: 7 });
  const pane = {
    rect: { x: 0, y: 1, width: 50, height: 10 },
    content: { kind: 'table', rows: [{}, {}, {}], columns: [{ key: 'id' }], selected: 0, scroll: 0 }
  };
  assert.equal(tableRowIndexAt(pane, 11, 4), 1);
  assert.equal(tabIndexAtColumn(['Transcript', 'Diff', 'Record'], 18, { x: 0, width: 50 }), 1);
});

test('light theme changes semantic palette values without component-specific overrides', () => {
  const palette = createPalette({ DELEGATE_TUI_THEME: 'light' });
  assert.equal(palette.theme, 'light');
  assert.deepEqual(palette.bar, { fg: lightBarFg, bg: lightBarBg });
  assert.deepEqual(palette.selection, { bg: lightSelectionBg });
  assert.deepEqual(palette.searchMatch, { bg: lightSearchMatchBg, bold: true });
  assert.deepEqual(palette.body, {});
});
