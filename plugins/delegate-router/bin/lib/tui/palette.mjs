function tone(index, rgb) {
  return Object.freeze({ index, rgb: Object.freeze(rgb) });
}

// Muted, dark-theme-first color tokens. Components consume only the semantic
// styles produced below; numeric/RGB values live nowhere else in the UI.
export const barBg = tone(236, [48, 48, 48]);
export const barFg = tone(250, [188, 188, 188]);
export const headerFg = tone(250, [188, 188, 188]);
export const selectionBg = tone(237, [58, 58, 58]);
export const surfaceBg = tone(235, [38, 38, 38]);
export const pillBg = tone(237, [58, 58, 58]);
export const borderFg = tone(242, [108, 108, 108]);
export const dimFg = tone(244, [128, 128, 128]);
export const accentFg = tone(73, [95, 175, 175]);
export const statusRunning = tone(65, [95, 135, 95]);
export const statusFailed = tone(167, [215, 95, 95]);
export const statusStalled = tone(179, [215, 175, 95]);
export const statusPaused = tone(73, [95, 175, 175]);
export const statusCancelled = tone(244, [128, 128, 128]);
export const badgeWarn = tone(179, [215, 175, 95]);
export const searchMatchBg = tone(58, [95, 95, 0]);

export const lightBarBg = tone(254, [228, 228, 228]);
export const lightBarFg = tone(238, [68, 68, 68]);
export const lightHeaderFg = tone(238, [68, 68, 68]);
export const lightSelectionBg = tone(252, [208, 208, 208]);
export const lightSurfaceBg = tone(255, [238, 238, 238]);
export const lightPillBg = tone(252, [208, 208, 208]);
export const lightBorderFg = tone(244, [128, 128, 128]);
export const lightDimFg = tone(242, [108, 108, 108]);
export const lightAccentFg = tone(25, [0, 95, 175]);
export const lightStatusRunning = tone(22, [0, 95, 0]);
export const lightStatusFailed = tone(124, [175, 0, 0]);
export const lightStatusStalled = tone(130, [175, 95, 0]);
export const lightStatusPaused = tone(25, [0, 95, 175]);
export const lightStatusCancelled = tone(242, [108, 108, 108]);
export const lightBadgeWarn = tone(130, [175, 95, 0]);
export const lightSearchMatchBg = tone(229, [255, 255, 175]);

function colored(enabled, style) {
  if (enabled) return Object.freeze(style);
  return Object.freeze(Object.fromEntries(Object.entries(style).filter(([key]) => !['fg', 'bg'].includes(key))));
}

export function createPalette(env = process.env) {
  const colorsEnabled = !Object.hasOwn(env, 'NO_COLOR');
  const light = String(env.DELEGATE_TUI_THEME || '').toLowerCase() === 'light';
  const values = light ? {
    barBg: lightBarBg, barFg: lightBarFg, headerFg: lightHeaderFg,
    selectionBg: lightSelectionBg, surfaceBg: lightSurfaceBg, pillBg: lightPillBg, borderFg: lightBorderFg, dimFg: lightDimFg,
    accentFg: lightAccentFg, statusRunning: lightStatusRunning,
    statusFailed: lightStatusFailed, statusStalled: lightStatusStalled,
    statusPaused: lightStatusPaused, statusCancelled: lightStatusCancelled,
    badgeWarn: lightBadgeWarn, searchMatchBg: lightSearchMatchBg
  } : {
    barBg, barFg, headerFg, selectionBg, surfaceBg, pillBg, borderFg, dimFg, accentFg,
    statusRunning, statusFailed, statusStalled, statusPaused,
    statusCancelled, badgeWarn, searchMatchBg
  };
  const bodyStyle = Object.freeze({});
  const surfaceStyle = colorsEnabled ? Object.freeze({ bg: values.surfaceBg }) : bodyStyle;
  const borderStyle = colored(colorsEnabled, { fg: values.borderFg, dim: true });
  return Object.freeze({
    colorsEnabled,
    theme: light ? 'light' : 'dark',
    body: bodyStyle,
    // Dashboard ownership tokens are explicit even where the terminal style
    // is currently the same as a general body/surface. Tests and painters use
    // these semantic names instead of inferring ownership from visual tones.
    dashboardBg: bodyStyle,
    surface: surfaceStyle,
    tileSurface: surfaceStyle,
    tileBorder: colored(colorsEnabled, { fg: values.borderFg, bg: values.surfaceBg, dim: true }),
    bar: colorsEnabled ? Object.freeze({ fg: values.barFg, bg: values.barBg }) : Object.freeze({ dim: true }),
    border: borderStyle,
    focusBorder: colored(colorsEnabled, { fg: values.accentFg }),
    paneTitle: colored(colorsEnabled, { fg: values.headerFg, bold: true }),
    screenTitle: colored(colorsEnabled, { fg: values.headerFg, bold: true }),
    header: colored(colorsEnabled, { fg: values.dimFg, underline: true, dim: true }),
    tabActive: colored(colorsEnabled, { fg: values.accentFg, underline: true }),
    tabInactive: colored(colorsEnabled, { fg: values.dimFg, dim: true }),
    selection: colorsEnabled ? Object.freeze({ bg: values.selectionBg }) : Object.freeze({ underline: true }),
    selectionBar: colored(colorsEnabled, { fg: values.accentFg }),
    selectedId: Object.freeze({ bold: true }),
    dim: colorsEnabled ? Object.freeze({ fg: values.dimFg }) : Object.freeze({ dim: true }),
    // Neutral metadata style. The accent hue itself is reserved for focus,
    // selection, active tabs and key hints below.
    accent: colored(colorsEnabled, { fg: values.headerFg }),
    keyHint: colored(colorsEnabled, { fg: values.accentFg }),
    tileValue: colored(colorsEnabled, { fg: values.headerFg, bg: values.surfaceBg, bold: true }),
    tileLabel: colorsEnabled ? Object.freeze({ fg: values.dimFg, bg: values.surfaceBg }) : Object.freeze({ dim: true }),
    trendLabel: colorsEnabled ? Object.freeze({ fg: values.dimFg, bg: values.surfaceBg, dim: true }) : Object.freeze({ dim: true }),
    sparkline: colorsEnabled ? Object.freeze({ fg: values.headerFg, bg: values.surfaceBg }) : Object.freeze({}),
    trendPlaceholder: colorsEnabled ? Object.freeze({ fg: values.dimFg, bg: values.surfaceBg, dim: true }) : Object.freeze({ dim: true }),
    pill: colorsEnabled ? Object.freeze({ bg: values.pillBg, fg: values.barFg }) : Object.freeze({ underline: true }),
    empty: colorsEnabled ? Object.freeze({ fg: values.dimFg, dim: true }) : Object.freeze({ dim: true }),
    input: colored(colorsEnabled, { bg: values.selectionBg }),
    inputLabel: colored(colorsEnabled, { fg: values.accentFg }),
    inputCursor: Object.freeze({ underline: true }),
    searchMatch: colorsEnabled ? Object.freeze({ bg: values.searchMatchBg }) : Object.freeze({ underline: true }),
    running: colored(colorsEnabled, { fg: values.statusRunning }),
    failed: colored(colorsEnabled, { fg: values.statusFailed }),
    stalled: colored(colorsEnabled, { fg: values.statusStalled }),
    paused: colored(colorsEnabled, { fg: values.statusPaused }),
    cancelled: colored(colorsEnabled, { fg: values.statusCancelled }),
    completed: Object.freeze({}),
    badgeWarn: colored(colorsEnabled, { fg: values.badgeWarn }),
    danger: colored(colorsEnabled, { fg: values.statusFailed }),
    warningTitle: colored(colorsEnabled, { fg: values.badgeWarn, bold: true }),
    positive: colored(colorsEnabled, { fg: values.statusRunning }),
    negative: colored(colorsEnabled, { fg: values.statusFailed }),
    hunk: colored(colorsEnabled, { fg: values.accentFg }),
    eventSeq: colorsEnabled ? Object.freeze({ fg: values.dimFg }) : Object.freeze({ dim: true }),
    eventTagMessage: colored(colorsEnabled, { fg: values.statusPaused }),
    eventTagTool: colored(colorsEnabled, { fg: values.statusRunning }),
    eventTagWarning: colored(colorsEnabled, { fg: values.badgeWarn }),
    eventTagError: colored(colorsEnabled, { fg: values.statusFailed }),
    eventTagUsage: colored(colorsEnabled, { fg: values.headerFg }),
    jsonKey: colorsEnabled ? Object.freeze({ fg: values.accentFg, dim: true }) : Object.freeze({ dim: true }),
    jsonString: Object.freeze({}),
    jsonNumber: colored(colorsEnabled, { fg: values.statusPaused }),
    jsonLiteral: colored(colorsEnabled, { fg: values.badgeWarn }),
    // The track replaces the pane's right border column, so its chrome must
    // be byte-for-byte the ordinary border style. The thumb alone accents it.
    scrollTrack: borderStyle,
    scrollThumb: colorsEnabled ? Object.freeze({ fg: values.accentFg, dim: true }) : Object.freeze({ underline: true }),
    meterTrack: colorsEnabled ? Object.freeze({ fg: values.borderFg, dim: true }) : Object.freeze({ dim: true })
  });
}

let activePalette = createPalette();
const paletteKeys = Object.keys(activePalette);

// Keep one stable facade for the lifetime of the process. Theme selection
// swaps the complete immutable backing palette atomically, while painters and
// any callers that captured `uiPalette` continue resolving live style values.
export const uiPalette = Object.freeze(Object.defineProperties({}, Object.fromEntries(paletteKeys.map((key) => [key, {
  enumerable: true,
  get() { return activePalette[key]; }
}]))));

export function setUiTheme(theme, env = process.env) {
  activePalette = createPalette({ ...env, DELEGATE_TUI_THEME: theme === 'light' ? 'light' : 'dark' });
  return uiPalette;
}
