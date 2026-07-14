import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
const harness = await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { paintFrame } from '../bin/lib/tui/components.mjs';
import { CHROME_GLYPHS, configureGlyphs, glyphConfiguration } from '../bin/lib/tui/glyphs.mjs';
import { createPalette, setUiTheme, uiPalette } from '../bin/lib/tui/palette.mjs';
import { loadTuiPreferences, tuiPreferencesPath } from '../bin/lib/tui/preferences.mjs';
import { claudeProjectsDirectory } from '../bin/lib/tui/sessions.mjs';
import { createViewModel, dashboardViewModel, DETAIL_TABS } from '../bin/lib/tui/viewmodels.mjs';
import { terminalWidthIdentity, WIDTH_PROBE_GRAPHEMES } from '../bin/lib/tui/width-probe.mjs';
import { dataDir } from '../bin/lib/state.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function restoreEnvironment(snapshot) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function dashboardStore(now) {
  const job = {
    id: 'codex-hermetic-attention', provider: 'codex', transport: 'app-server', model: 'sol', mode: 'review', cwd: '/work',
    status: 'running', phase: 'working', resultSuspect: true, workerAlive: true, workerPid: 1234,
    createdAt: now / 1000 - 60, updatedAt: now / 1000 - 2, lastActivityAt: now - 2000
  };
  return {
    jobs: [job], eventsByJob: { [job.id]: [] }, activityEventsByJob: { [job.id]: [] },
    hydrationByJob: {}, diffsByJob: {}, diffStatsByJob: {}, providers: [], writerLocks: [], groups: [], audit: [], stats: { groups: [] }
  };
}

function assertScreenBorderChrome(frame, grid, palette, label) {
  const panes = frame.panes || [];
  const focusable = panes.map((pane, index) => ({ pane, index })).filter(({ pane }) => pane.focusable !== false);
  const fallback = focusable[Math.max(0, Math.min(focusable.length - 1, Number(frame.focusedPane || 0)))]?.index ?? 0;
  for (let index = 0; index < panes.length; index += 1) {
    const pane = panes[index];
    if (pane.border === false || pane.rect.width < 2 || pane.rect.height < 2) continue;
    const focused = pane.focused ?? index === fallback;
    const border = frame.screen === 'dashboard' && pane.content?.kind === 'tile'
      ? palette.tileBorder
      : focused ? palette.focusBorder : palette.border;
    const left = pane.rect.x;
    const right = pane.rect.x + pane.rect.width - 1;
    const top = pane.rect.y;
    const bottom = pane.rect.y + pane.rect.height - 1;
    for (const [x, y, position] of [
      [left, top, 'top-left'], [right, top, 'top-right'],
      [left, bottom, 'bottom-left'], [right, bottom, 'bottom-right']
    ]) assert.deepEqual(grid.get(x, y).style, border, `${label} pane ${index} ${position}`);
    for (let y = top + 1; y < bottom; y += 1) {
      assert.deepEqual(grid.get(left, y).style, border, `${label} pane ${index} left edge row ${y}`);
      const rightCell = grid.get(right, y);
      if (rightCell.char === CHROME_GLYPHS.scrollThumb) assert.deepEqual(rightCell.style, palette.scrollThumb, `${label} pane ${index} thumb row ${y}`);
      else assert.deepEqual(rightCell.style, border, `${label} pane ${index} right edge row ${y}`);
    }
  }
}

test('every TUI test file enters the shared harness before importing the TUI stack', () => {
  const files = fs.readdirSync(testDirectory).filter((name) => /^tui-.*\.test\.mjs$/.test(name)).sort();
  assert.ok(files.length >= 20);
  for (const name of files) {
    const source = fs.readFileSync(path.join(testDirectory, name), 'utf8');
    const harnessImport = source.indexOf("from './helpers/tui-test-harness.mjs'");
    const tuiImport = source.indexOf("from '../bin/lib/tui/");
    assert.ok(harnessImport >= 0, `${name} imports the shared harness`);
    assert.ok(tuiImport < 0 || harnessImport < tuiImport, `${name} imports the harness before TUI modules`);
    assert.match(source, /await useTuiTestHarness\(import\.meta\.url\)/, `${name} activates the shared harness`);
  }
});

test('constructing persistent TUI inputs resolves and reads only inside the harness state directory', () => {
  const reads = [];
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function interceptedRead(file, ...args) {
    reads.push(path.resolve(String(file)));
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    assert.deepEqual(loadTuiPreferences(), {
      theme: 'dark', notifications: true, timestampMode: 'absolute', fleetDensity: 'wide', widthProbeCache: {}
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(dataDir(), harness.stateDirectory);
  assert.equal(tuiPreferencesPath(), harness.preferencesFile);
  assert.equal(claudeProjectsDirectory(process.env), harness.projectsDirectory);
  assert.deepEqual(reads, [harness.preferencesFile]);
  for (const resolved of reads) assert.ok(resolved.startsWith(`${harness.root}${path.sep}`), resolved);
});

test('polluted user prefs and probe cache cannot alter owner or dashboard contracts in process', async () => {
  const pollutedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-polluted-user-'));
  const pollutedState = path.join(pollutedRoot, 'state');
  const pollutedHome = path.join(pollutedRoot, 'home');
  fs.mkdirSync(pollutedState, { recursive: true, mode: 0o700 });
  fs.mkdirSync(pollutedHome, { recursive: true, mode: 0o700 });
  const probeEnv = { TERM: 'tmux-256color', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2', TMUX: '/tmp/tmux-1000/default,1,0', LANG: 'en_US.UTF-8' };
  const probeIdentity = terminalWidthIdentity(probeEnv);
  const probedWidths = Object.fromEntries(WIDTH_PROBE_GRAPHEMES.map((grapheme) => [grapheme, 1]));
  fs.writeFileSync(path.join(pollutedState, 'tui-prefs.json'), `${JSON.stringify({
    theme: 'light', notifications: false, timestampMode: 'relative', fleetDensity: 'compact',
    widthProbeCache: { [probeIdentity]: { widths: probedWidths, measuredAt: 123 } }
  })}\n`, { mode: 0o600 });

  const before = { ...process.env };
  try {
    process.env.HOME = pollutedHome;
    process.env.XDG_STATE_HOME = pollutedState;
    process.env.DELEGATE_STATE_FILE = path.join(pollutedState, 'usage.json');
    process.env.DELEGATE_TUI_THEME = 'light';
    process.env.DELEGATE_TUI_ASCII = '1';
    process.env.NO_COLOR = '1';
    process.env.TERM = 'dumb';

    await useTuiTestHarness(import.meta.url, async (isolated) => {
      const expectedPalette = createPalette(isolated.env);
      assert.deepEqual(loadTuiPreferences(), {
        theme: 'dark', notifications: true, timestampMode: 'absolute', fleetDensity: 'wide', widthProbeCache: {}
      });
      assert.deepEqual(uiPalette, expectedPalette);
      assert.equal(glyphConfiguration().mode, 'safeUnicode');
      assert.equal(CHROME_GLYPHS.cornerTopLeft, '+');

      const borderFrame = {
        width: 50, height: 12,
        panes: [
          { rect: { x: 0, y: 2, width: 24, height: 9 }, focused: false, content: { kind: 'tile', value: '1', label: 'static' } },
          { rect: { x: 26, y: 2, width: 24, height: 9 }, focused: false, content: { kind: 'log', lines: Array.from({ length: 30 }, (_, index) => `line ${index}`), follow: false, scroll: 3 } }
        ]
      };
      const borderGrid = paintFrame(borderFrame);
      assert.deepEqual(borderGrid.get(23, 2).style, expectedPalette.border);
      assert.deepEqual(borderGrid.get(49, 2).style, expectedPalette.border);
      for (let y = 3; y < 10; y += 1) {
        const style = borderGrid.get(49, y).style;
        const expected = style.fg?.index === expectedPalette.scrollThumb.fg?.index
          ? expectedPalette.scrollThumb : expectedPalette.scrollTrack;
        assert.deepEqual(style, expected);
      }

      const now = 1_720_000_000_000;
      const dashboard = dashboardViewModel(dashboardStore(now), { now, dashboardFocus: 0 }, { width: 100, height: 30 });
      assert.deepEqual(dashboard.meta.attentionJobIds, ['codex-hermetic-attention']);
      const dashboardGrid = paintFrame(dashboard);
      const focused = dashboard.panes.find((pane) => pane.focused);
      assert.deepEqual(dashboardGrid.get(focused.rect.x, focused.rect.y).style, expectedPalette.focusBorder);
      assert.equal(dashboardGrid.get(0, 1).char, ' ');
      assert.deepEqual(dashboardGrid.get(0, 1).style, expectedPalette.body);

      // Now exercise the product startup order against the deliberately
      // polluted persisted preferences: load, atomically select the theme,
      // apply the cached tmux/Ghostty widths, then build and paint frames.
      const persisted = loadTuiPreferences({ directory: pollutedState, env: {} });
      const cached = persisted.widthProbeCache[probeIdentity];
      setUiTheme(persisted.theme, probeEnv);
      configureGlyphs({ env: probeEnv, widths: cached.widths });
      const persistedPalette = createPalette({ ...probeEnv, DELEGATE_TUI_THEME: 'light' });
      assert.deepEqual(uiPalette, persistedPalette);
      assert.equal(glyphConfiguration().mode, 'probed-elegant');

      const productStore = dashboardStore(1_720_000_000_000);
      const screens = [
        { screen: 'dashboard', dashboardFocus: 0 },
        { screen: 'fleet' },
        { screen: 'groups' },
        { screen: 'group-members', groupId: 'missing' },
        { screen: 'providers' },
        { screen: 'sessions' },
        { screen: 'stats' },
        { screen: 'launcher', launcher: { fieldIndex: 0 } },
        ...DETAIL_TABS.map((_tab, detailTab) => ({ screen: 'detail', jobId: 'codex-hermetic-attention', detailTab }))
      ];
      for (const screenUi of screens) {
        const frame = createViewModel(productStore, { ...screenUi, now: 1_720_000_000_000 }, { width: 100, height: 30 });
        const grid = paintFrame(frame);
        assertScreenBorderChrome(frame, grid, persistedPalette, `${screenUi.screen}:${screenUi.detailTab ?? ''}`);
      }
    });
    assert.equal(process.env.DELEGATE_STATE_FILE, harness.stateFile, 'nested pollution proof restores the file harness environment');
    assert.equal(process.env.DELEGATE_TUI_THEME, undefined);
    assert.equal(process.env.NO_COLOR, undefined);
  } finally {
    restoreEnvironment(before);
    fs.rmSync(pollutedRoot, { recursive: true, force: true });
  }
});
