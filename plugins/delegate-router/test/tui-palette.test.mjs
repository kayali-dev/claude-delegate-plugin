import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { detectColorMode, styleSequence, xterm256ToRgb } from '../bin/lib/tui/ansi.mjs';
import { paintFrame } from '../bin/lib/tui/components.mjs';
import {
  accentFg,
  barBg,
  barFg,
  badgeWarn,
  createPalette,
  CONTRAST_TARGETS,
  dimFg,
  headerFg,
  PALETTE_SEEDS,
  PALETTE_TOKEN_NAMES,
  paletteAuditRows,
  selectionBg,
  setUiTheme,
  statusFailed,
  statusRunning,
  TUI_THEME_PRESETS,
  uiPalette
} from '../bin/lib/tui/palette.mjs';
import { Screen } from '../bin/lib/tui/screen.mjs';

function oklabDistance(first, second) {
  const cartesian = ([lightness, chroma, hue]) => {
    const radians = hue * Math.PI / 180;
    return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)];
  };
  const left = cartesian(first);
  const right = cartesian(second);
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

function proofFrame() {
  return {
    width: 64,
    height: 12,
    screen: 'fleet',
    title: { text: 'Fleet | perceptual palette', right: '2 jobs' },
    panes: [{
      rect: { x: 0, y: 1, width: 64, height: 10 },
      title: 'Managed jobs',
      content: {
        kind: 'table',
        columns: [
          { key: 'id', title: 'Job', width: 22 },
          { key: 'status', title: 'Status', width: 12 },
          { key: 'detail', title: 'Detail', grow: true }
        ],
        rows: [
          { id: 'codex-running', status: { text: 'running', style: uiPalette.running }, detail: 'live provider turn' },
          { id: 'cursor-failed', status: { text: 'failed', style: uiPalette.failed }, detail: 'review required' }
        ],
        selected: 0,
        scroll: 0
      }
    }],
    status: { text: 'Esc dashboard  ? help  q quit' }
  };
}

function renderAnsi(frame, colorMode) {
  const chunks = [];
  const output = {
    columns: frame.width,
    rows: frame.height,
    write(value) { chunks.push(String(value)); return true; }
  };
  const screen = new Screen({ output, input: {}, colorMode });
  const grid = paintFrame(frame);
  assert.doesNotThrow(() => screen.render(grid));
  for (let y = 0; y < grid.rows; y += 1) {
    for (let x = 0; x < grid.columns; x += 1) {
      assert.ok(grid.get(x, y).style);
      assert.equal(Object.values(grid.get(x, y).style).includes(undefined), false, `missing style token at ${x},${y}`);
    }
  }
  return chunks.join('');
}

test('dark-theme compatibility names now resolve to perceptually authored tokens', () => {
  const palette = createPalette({});
  for (const token of [barBg, barFg, headerFg, selectionBg, statusRunning, statusFailed, badgeWarn]) {
    assert.equal(Number.isInteger(token.index), true);
    assert.notDeepEqual(token.rgb, xterm256ToRgb(token.index), `${token.name} truecolor is not its derived xterm cube value`);
  }
  assert.deepEqual(palette.bar, { fg: barFg, bg: barBg });
  assert.deepEqual(palette.body, { fg: palette.tokens.text });
  assert.deepEqual(palette.selection, { bg: selectionBg });
  assert.deepEqual(palette.selectedId, { bold: true });
  assert.deepEqual(palette.planCompleted, { fg: statusRunning });
  assert.deepEqual(palette.planActive, { fg: accentFg });
  assert.deepEqual(palette.planPending, { fg: dimFg });
});

test('NO_COLOR removes palette colors but preserves structural bold and dim', () => {
  const palette = createPalette({ NO_COLOR: '' });
  assert.equal(palette.colorsEnabled, false);
  for (const [name, style] of Object.entries(palette)) {
    if (['tokens', 'categories', 'themeSelection'].includes(name)) continue;
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

test('all six presets self-verify every contrast target and preserve the authored surface ramps', () => {
  for (const preset of TUI_THEME_PRESETS) {
    const rows = paletteAuditRows(preset);
    assert.equal(rows.length, 41);
    assert.deepEqual(rows.map((row) => row.name), PALETTE_TOKEN_NAMES);
    for (const row of rows) {
      assert.ok(row.surface, `${preset}:${row.name} names its actual surface`);
      if (row.target != null) {
        assert.ok(row.contrast + 1e-9 >= row.target, `${preset}:${row.name} ${row.contrast.toFixed(3)} < ${row.target}:1 on ${row.surface}`);
      }
      assert.notDeepEqual(row.rgb, xterm256ToRgb(row.index), `${preset}:${row.name} must not collapse truecolor to xterm ${row.index}`);
    }
    for (const category of ['text', 'border', 'semantic']) {
      assert.ok(rows.filter((row) => row.category === category).every((row) => row.target != null && row.contrast >= row.target));
    }
    const expected = preset.startsWith('light') ? [0.985, 0.950, 0.915, 0.880] : [0.180, 0.225, 0.270, 0.315];
    const ramp = ['bg', 'surface', 'surfaceRaised', 'surfaceOverlay'].map((name) => rows.find((row) => row.name === name).oklch[0]);
    assert.deepEqual(ramp, expected);
    assert.deepEqual(ramp.slice(1).map((value, index) => Number(Math.abs(value - ramp[index]).toFixed(3))), Array(3).fill(preset.startsWith('light') ? 0.035 : 0.045));
  }
  assert.equal(CONTRAST_TARGETS.textMuted, 4.5);
  assert.equal(CONTRAST_TARGETS.semantic, 4.5);
  assert.ok(CONTRAST_TARGETS.borderSubtle < CONTRAST_TARGETS.border);
  assert.ok(CONTRAST_TARGETS.border < CONTRAST_TARGETS.borderActive);
  assert.ok(CONTRAST_TARGETS.borderActive < CONTRAST_TARGETS.textMuted, 'the strongest border remains dimmer than muted text');
});

test('neutral tiers are tinted at the governing OKLCH seed', () => {
  for (const preset of ['dark', 'light']) {
    const tokens = createPalette({}, preset).tokens;
    for (const name of ['bg', 'surface', 'surfaceRaised', 'surfaceOverlay', 'borderSubtle', 'border', 'borderActive', 'text', 'textSecondary', 'textMuted']) {
      assert.equal(tokens[name].oklch[1], PALETTE_SEEDS.neutralChroma, `${preset}:${name} neutral chroma`);
      assert.equal(tokens[name].oklch[2], PALETTE_SEEDS.neutralHue, `${preset}:${name} neutral hue`);
      assert.notEqual(tokens[name].rgb[0], tokens[name].rgb[2], `${preset}:${name} is visibly tinted, not pure grey`);
    }
  }
});

test('daltonized semantic and diff pairs replace red-green with distinguishable blue-yellow', () => {
  for (const preset of ['dark-daltonized', 'light-daltonized']) {
    const tokens = createPalette({}, preset).tokens;
    for (const [blue, yellow] of [['successFg', 'errorFg'], ['diffAddedFg', 'diffRemovedFg']]) {
      assert.equal(tokens[blue].oklch[2], 250);
      assert.equal(tokens[yellow].oklch[2], 95);
      assert.ok(oklabDistance(tokens[blue].oklch, tokens[yellow].oklch) >= 0.2, `${preset}:${blue}/${yellow} remain perceptually distinct`);
    }
  }
});

test('truecolor, derived 256, ANSI presets, and NO_COLOR render the same real frame without fallback', (t) => {
  t.after(() => setUiTheme('dark', process.env));
  for (const preset of TUI_THEME_PRESETS) {
    setUiTheme(preset, {});
    const output = renderAnsi(proofFrame(), 'truecolor');
    if (preset.endsWith('-ansi')) assert.doesNotMatch(output, /(?:38|48);(?:2|5);/);
    else assert.match(output, /(?:38|48);2;/);
  }
  setUiTheme('dark', {});
  const indexed = renderAnsi(proofFrame(), '256');
  assert.match(indexed, /(?:38|48);5;/);
  assert.doesNotMatch(indexed, /(?:38|48);2;/);

  setUiTheme('dark', { NO_COLOR: '' });
  assert.doesNotMatch(renderAnsi(proofFrame(), 'truecolor'), /(?:38|48);(?:2|5);/);
});

test('custom themes are base plus validated OKLCH overrides', () => {
  const custom = createPalette({}, {
    base: 'light',
    overrides: {
      accent: [0.6, 0.08, 200],
      unknownToken: [0.5, 0.1, 20],
      text: [2, 9, 999]
    }
  });
  assert.equal(custom.theme, 'light');
  assert.deepEqual(custom.tokens.accent.oklch, [0.6, 0.08, 200]);
  assert.deepEqual(custom.tokens.text.oklch, createPalette({}, 'light').tokens.text.oklch, 'invalid override is ignored');
  assert.equal(Object.hasOwn(custom.tokens, 'unknownToken'), false);
});

test('theme selection keeps captured palette references live and exposes all three border weights', (t) => {
  t.after(() => setUiTheme('dark', process.env));
  setUiTheme('dark', {});
  const captured = uiPalette;
  const darkBorder = captured.border;
  assert.equal(captured.scrollTrack, captured.borderSubtle, 'resting scrollbar track uses the subtle weight');
  assert.equal(captured.borderSubtle.fg, captured.tokens.borderSubtle);
  assert.equal(captured.border.fg, captured.tokens.border);
  assert.equal(captured.borderActive.fg, captured.tokens.borderActive);

  setUiTheme('light', {});
  assert.equal(captured, uiPalette, 'theme selection preserves the exported palette identity');
  assert.equal(captured.theme, 'light', 'a pre-selection capture resolves the new backing palette');
  assert.notEqual(captured.border, darkBorder);
  assert.equal(captured.scrollTrack, captured.borderSubtle, 'the subtle track identity survives theme selection');
});
