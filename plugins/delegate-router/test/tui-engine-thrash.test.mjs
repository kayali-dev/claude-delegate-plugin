import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { paneContentRect, paintFrame, virtualLogScrollToEntry } from '../bin/lib/tui/components.mjs';
import { Screen } from '../bin/lib/tui/screen.mjs';
import { createViewModel, DETAIL_TABS } from '../bin/lib/tui/viewmodels.mjs';
import { configureGlyphs } from '../bin/lib/tui/glyphs.mjs';
import { setUiTheme } from '../bin/lib/tui/palette.mjs';
import { graphemeWidth, isEastAsianAmbiguousCodePoint, isWidthSuspect, setGraphemeWidthOverrides } from '../bin/lib/tui/width.mjs';
import { ReplayVirtualTerminal } from '../bin/lib/tui/vt-model.mjs';
import { WIDTH_PROBE_GRAPHEMES } from '../bin/lib/tui/width-probe.mjs';
import { assertVtMatchesGrid, ByteVirtualTerminal, expectedStyleKey } from './helpers/tui-vt.mjs';

const NOW = 1_700_000_000_000;

// Exercise real SGR backgrounds even when the test runner itself sets
// NO_COLOR. Style ownership is invisible in a colorless frame.
setUiTheme('dark', {});
const measuredWidths = Object.fromEntries(WIDTH_PROBE_GRAPHEMES.map((glyph) => [glyph, 1]));
setGraphemeWidthOverrides(measuredWidths);
configureGlyphs({ env: { TERM: 'tmux-256color', LANG: 'en_US.UTF-8' }, widths: measuredWidths });

function backgroundFromStyleKey(key) {
  return JSON.parse(key || '{}').bg ?? null;
}

function event(seq, type, data = {}) {
  return { v: 1, seq, at: NOW - 200_000 + seq * 500, jobId: 'codex-thrash-root', type, redacted: true, data };
}

function thrashStore() {
  const root = {
    id: 'codex-thrash-root', provider: 'codex', transport: 'app-server', model: 'sol', resolvedModel: 'gpt-test', mode: 'implement',
    status: 'running', phase: 'working', revision: 3, cwd: '/work/project', createdAt: NOW / 1000 - 800,
    updatedAt: NOW / 1000 - 1, lastActivityAt: NOW - 1000, workerPid: 1234, workerAlive: true,
    groupId: 'thrash-wave', providerSessionId: 'thread-thrash', managedBy: 'delegate-control', maxOutputTokens: 8000,
    usage: { total: { inputTokens: 4000, cachedInputTokens: 1200, outputTokens: 1800, totalTokens: 5800 } },
    verification: { exitCode: 0 }, changedFiles: { files: ['src/function.mjs'] }, scopeViolations: []
  };
  const child = {
    ...root, id: 'codex-thrash-child', status: 'completed', phase: 'completed', workerPid: null, workerAlive: false,
    rootJobId: root.id, parentJobId: root.id, createdAt: NOW / 1000 - 400, completedAt: NOW / 1000 - 20,
    resultText: 'assistant verified function behavior'
  };
  const events = [event(1, 'message.user', { text: 'Keep assistant and function intact.' })];
  let seq = 2;
  for (let index = 0; index < 90; index += 1) {
    events.push(event(seq++, 'message.completed', {
      id: `message-${index}`,
      text: `assistant message ${index}: function must remain function while scroll thrashing. ambiguous · … — Ω ─ 🙂 👩‍💻 ✈️ 👍🏽 ${'word '.repeat(index % 7)}`
    }));
    if (index % 12 === 0) {
      const id = `tool-${index}`;
      events.push(event(seq++, 'tool.started', { item: { id, type: 'commandExecution', command: ['node', '--test', `test/function-${index}.test.mjs`], status: 'inProgress' } }));
      events.push(event(seq++, 'tool.output', { id, delta: `assistant output ${index}\nfunction output ${index}\nliteral\\ntext` }));
      events.push(event(seq++, 'tool.completed', { item: { id, type: 'commandExecution', command: ['node', '--test', `test/function-${index}.test.mjs`], status: 'completed', exitCode: 0, durationMs: 1234 } }));
    }
    if (index % 17 === 0) events.push(event(seq++, 'plan.updated', { plan: [{ step: `function plan ${index}`, status: 'inProgress' }] }));
  }
  return {
    jobs: [root, child], eventsByJob: { [root.id]: events, [child.id]: [event(1, 'message.completed', { id: 'child', text: child.resultText })] },
    hydrationByJob: { [root.id]: { loaded: true }, [child.id]: { loaded: true } },
    diffsByJob: { [root.id]: 'diff --git a/src/function.mjs b/src/function.mjs\n@@ -1 +1 @@\n-function\n+assistant function' },
    diffStatsByJob: { [root.id]: { files: [{ path: 'src/function.mjs', additions: 1, deletions: 1 }], totalAdditions: 1, totalDeletions: 1 } },
    providers: [{ name: 'codex', enabled: true, allowance: { known: true, usedPercent: 43, windows: [{ name: 'five-hour', usedPercent: 43 }] }, warningPercent: 80, avoidPercent: 90, lastVerified: { ok: true, at: NOW - 1000 } }],
    writerLocks: [{ cwd: root.cwd, jobId: root.id, provider: 'codex', mode: root.mode, status: root.status, phase: root.phase }],
    profiles: ['independent-review'],
    groups: [{ groupId: 'thrash-wave', total: 2, running: 1, terminal: 1, stalled: 0, allTerminal: false, newestActivityAt: NOW - 1000, memberIds: [root.id, child.id] }],
    sessions: [{ id: 'session-thrash', cwd: root.cwd, mtimeMs: NOW - 5000, activeSeconds: 300, lastActivity: 'assistant function', size: 2048 }],
    sessionScan: { status: 'ready', available: true, scanned: 1, totalFiles: 1, capped: false },
    audit: [{ at: NOW - 20_000, jobId: child.id, provider: 'codex', model: 'sol', mode: 'implement', durationMs: 1200, outcome: { status: 'completed' }, usage: child.usage, scopeViolationsCount: 0, verification: { exitCode: 0 } }],
    stats: { since: '7d', jobs: 2, groups: [{ provider: 'codex', model: 'sol', mode: 'implement', jobs: 2, successRate: 1, resumedJobs: 1, nudgeCount: 0, meanDurationMs: 1200, meanOutputTokens: 1800, budgetCount: 0, timeoutCount: 0, violationCount: 0 }] }
  };
}

test('seeded real-screen thrash bytes always equal independently composed intended frames', () => {
  const seed = '0x51a7e11';
  const store = thrashStore();
  const vt = new ByteVirtualTerminal(100, 30);
  const adversarial = new ReplayVirtualTerminal(100, 30, {
    widthOf(grapheme) {
      const width = graphemeWidth(grapheme);
      if (Array.from(grapheme).some((symbol) => isEastAsianAmbiguousCodePoint(symbol.codePointAt(0)))) return 2;
      return isWidthSuspect(grapheme) ? (width === 1 ? 2 : 1) : width;
    }
  });
  const output = {
    columns: 100, rows: 30, isTTY: true,
    write(value) { vt.apply(String(value)); adversarial.apply(String(value)); return true; }
  };
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {} };
  const screen = new Screen({ output, input, columns: 100, rows: 30, colorMode: '256' });
  screen.start();
  let ui = { screen: 'dashboard', now: NOW, selectedIndex: 0, dashboardFocus: 0, dashboardAttentionSelection: 0, dashboardFeedSelection: 0, detailTab: 0, detailScroll: 0, transcriptSelection: 0, follow: false, expandedTools: new Set(), timestampMode: 'absolute' };

  for (let step = 0; step < 320; step += 1) {
    if (step > 0 && step % 80 === 0) {
      const history = store.eventsByJob['codex-thrash-root'];
      store.eventsByJob = {
        ...store.eventsByJob,
        'codex-thrash-root': [...history, event(Number(history.at(-1)?.seq || 0) + 1, 'message.delta', {
          id: 'live-tail', delta: `assistant function live append ${step} `
        })]
      };
    }
    if (step > 0 && step % 41 === 0) {
      const size = step % 82 === 0 ? [73, 21] : step % 123 === 0 ? [121, 37] : [100, 30];
      if (size[0] !== output.columns || size[1] !== output.rows) {
        output.columns = size[0];
        output.rows = size[1];
        vt.resize(...size);
        adversarial.resize(...size);
        screen.resize(...size);
      }
    }
    const phase = step % 17;
    if (phase === 0) ui = { ...ui, screen: 'dashboard', help: false, input: null, confirm: null, statusHistoryOpen: false, dashboardFocus: step % 2 };
    else if (phase === 1) ui = { ...ui, screen: 'fleet', help: false, input: null, confirm: null, statusHistoryOpen: false, selectedIndex: step % 2, filter: step % 34 ? '' : 'function' };
    else if (phase >= 2 && phase <= 7) ui = { ...ui, screen: 'detail', jobId: 'codex-thrash-root', detailTab: phase - 2, help: false, input: null, confirm: null, statusHistoryOpen: false };
    else if (phase === 8) ui = { ...ui, screen: 'providers' };
    else if (phase === 9) ui = { ...ui, screen: 'groups' };
    else if (phase === 10) ui = { ...ui, screen: 'group-members', groupId: 'thrash-wave' };
    else if (phase === 11) ui = { ...ui, screen: 'sessions' };
    else if (phase === 12) ui = { ...ui, screen: 'stats' };
    else if (phase === 13) ui = { ...ui, screen: 'launcher', launcher: { fieldIndex: step % 9, profile: 'independent-review', provider: 'codex', model: 'sol', mode: 'review', effort: 'high', prompt: 'Review assistant function', allowedPaths: 'src', previewScroll: step % 3, preview: { provider: 'codex', model: 'sol', mode: 'review', packetWarnings: [], packet: '# Objective\nReview assistant function' } } };
    else if (phase === 14) ui = { ...ui, screen: 'fleet', help: true };
    else if (phase === 15) ui = { ...ui, screen: 'fleet', help: false, statusHistoryOpen: true, statusHistory: [{ at: NOW, stream: 'stderr', message: 'assistant function diagnostic' }] };
    else ui = { ...ui, screen: 'fleet', statusHistoryOpen: false, input: { kind: 'input', label: 'Search', value: 'assistant function' } };

    if (ui.screen === 'detail' && ui.detailTab === 0) {
      ui.follow = step % 48 === 1 || step % 80 === 1;
      ui.expandedTools = step % 32 < 16 ? new Set(['tool-0', 'tool-24']) : new Set();
      ui.search = step % 24 < 8 ? { pane: 'transcript', query: 'function', matches: [], current: 0 } : null;
      const before = createViewModel(store, ui, { width: output.columns, height: output.rows });
      const content = before.panes[0].content;
      if (content?.virtual && !ui.follow) {
        const count = content.entries.length;
        const pattern = [0, 35, 1, 70, 20, 89, 5, 50];
        ui.transcriptSelection = Math.min(count - 1, pattern[Math.floor(step / 16) % pattern.length]);
        const contentRect = paneContentRect(before.panes[0], { scrollbar: true });
        ui.detailScroll = virtualLogScrollToEntry(content, ui.transcriptSelection, contentRect.width, contentRect.height);
      }
    } else ui.search = null;

    const frame = createViewModel(store, ui, { width: output.columns, height: output.rows });
    assert.ok(DETAIL_TABS.includes(frame.tabs?.items?.[frame.tabs?.active]) || frame.screen !== 'detail', `${seed} step=${step}: valid detail tab`);
    const intended = paintFrame(frame);
    const independent = paintFrame(createViewModel(store, ui, { width: output.columns, height: output.rows }));
    for (let y = 0; y < intended.rows; y += 1) {
      for (let x = 0; x < intended.columns; x += 1) assert.notEqual(intended.get(x, y), independent.get(x, y), `${seed} step=${step}: independent paint aliases cell ${x},${y}`);
    }
    screen.render(intended);
    assertVtMatchesGrid(vt, independent, `${seed} step=${step} screen=${frame.screen}${frame.screen === 'detail' ? ` tab=${frame.tabs.active}` : ''}`);
    for (let y = 0; y < intended.rows; y += 1) {
      const allowed = new Set();
      for (let x = 0; x < intended.columns; x += 1) {
        const cell = intended.get(x, y);
        if (!cell.continuation && isWidthSuspect(cell.char)) {
          allowed.add(x);
          for (let offset = 1; offset < graphemeWidth(cell.char); offset += 1) allowed.add(x + offset);
        }
      }
      for (let x = 0; x < intended.columns; x += 1) {
        const actual = adversarial.cells[y][x];
        const expected = intended.get(x, y);
        if (allowed.has(x)) continue;
        assert.equal(
          backgroundFromStyleKey(actual.style),
          backgroundFromStyleKey(expectedStyleKey(expected.style, '256')),
          `${seed} step=${step}: background escaped its owning region at ${x},${y}`
        );
        assert.deepEqual(
          { char: actual.char, continuation: actual.continuation, style: actual.style },
          { char: expected.char, continuation: expected.continuation, style: expectedStyleKey(expected.style, '256') },
          `${seed} step=${step}: width disagreement escaped suspect cells at ${x},${y}`
        );
      }
    }
  }
  screen.stop();
});
