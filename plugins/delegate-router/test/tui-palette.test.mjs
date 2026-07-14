import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { detectColorMode, styleSequence } from '../bin/lib/tui/ansi.mjs';
import {
  accentFg,
  barBg,
  barFg,
  badgeWarn,
  createPalette,
  dimFg,
  headerFg,
  selectionBg,
  setUiTheme,
  statusFailed,
  statusRunning,
  uiPalette
} from '../bin/lib/tui/palette.mjs';

test('dark-theme palette uses muted semantic 256-color tokens', () => {
  const palette = createPalette({});
  assert.equal(barBg.index, 236);
  assert.equal(barFg.index, 250);
  assert.equal(headerFg.index, 250);
  assert.equal(selectionBg.index, 237);
  assert.equal(statusRunning.index, 65);
  assert.equal(statusFailed.index, 167);
  assert.equal(badgeWarn.index, 179);
  assert.deepEqual(palette.bar, { fg: barFg, bg: barBg });
  assert.deepEqual(palette.body, {});
  assert.deepEqual(palette.selection, { bg: selectionBg });
  assert.deepEqual(palette.selectedId, { bold: true });
  assert.deepEqual(palette.planCompleted, { fg: statusRunning, dim: true });
  assert.deepEqual(palette.planActive, { fg: accentFg });
  assert.deepEqual(palette.planPending, { fg: dimFg, dim: true });
});

test('NO_COLOR removes palette colors but preserves structural bold and dim', () => {
  const palette = createPalette({ NO_COLOR: '' });
  assert.equal(palette.colorsEnabled, false);
  for (const style of Object.values(palette)) {
    if (!style || typeof style !== 'object') continue;
    assert.equal(Object.hasOwn(style, 'fg'), false);
    assert.equal(Object.hasOwn(style, 'bg'), false);
  }
  assert.equal(palette.paneTitle.bold, true);
  assert.equal(palette.bar.dim, true);
  assert.equal(palette.header.dim, true);
  assert.equal(palette.dim.dim, true);
  assert.equal(palette.selection.underline, true);
  assert.equal(detectColorMode({ NO_COLOR: '', TERM: 'xterm-direct' }), 'none');
  const sequence = styleSequence({ fg: statusFailed, bold: true }, 'none');
  assert.match(sequence, /\[0;1m$/);
  assert.doesNotMatch(sequence, /(?:38|48);/);
  assert.match(styleSequence({ dim: true }, 'none'), /\[0;2m$/, 'each nonempty style resets omitted attributes first');
});

test('theme selection keeps captured palette references live and the track shares pane border chrome', (t) => {
  t.after(() => setUiTheme('dark', process.env));
  setUiTheme('dark', {});
  const captured = uiPalette;
  const darkBorder = captured.border;
  assert.equal(captured.scrollTrack, captured.border, 'ordinary scrollbar track is the pane border style');

  setUiTheme('light', {});
  assert.equal(captured, uiPalette, 'theme selection preserves the exported palette identity');
  assert.equal(captured.theme, 'light', 'a pre-selection capture resolves the new backing palette');
  assert.notEqual(captured.border, darkBorder);
  assert.equal(captured.scrollTrack, captured.border, 'the border/track identity survives theme selection');
});
