function tone(index, rgb) {
  return Object.freeze({ index, rgb: Object.freeze(rgb) });
}

// Muted, dark-theme-first color tokens. Components consume only the semantic
// styles produced below; numeric/RGB values live nowhere else in the UI.
export const barBg = tone(236, [48, 48, 48]);
export const barFg = tone(250, [188, 188, 188]);
export const headerFg = tone(250, [188, 188, 188]);
export const selectionBg = tone(237, [58, 58, 58]);
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
    selectionBg: lightSelectionBg, borderFg: lightBorderFg, dimFg: lightDimFg,
    accentFg: lightAccentFg, statusRunning: lightStatusRunning,
    statusFailed: lightStatusFailed, statusStalled: lightStatusStalled,
    statusPaused: lightStatusPaused, statusCancelled: lightStatusCancelled,
    badgeWarn: lightBadgeWarn, searchMatchBg: lightSearchMatchBg
  } : {
    barBg, barFg, headerFg, selectionBg, borderFg, dimFg, accentFg,
    statusRunning, statusFailed, statusStalled, statusPaused,
    statusCancelled, badgeWarn, searchMatchBg
  };
  return Object.freeze({
    colorsEnabled,
    theme: light ? 'light' : 'dark',
    body: Object.freeze({}),
    bar: colorsEnabled ? Object.freeze({ fg: values.barFg, bg: values.barBg }) : Object.freeze({ dim: true }),
    border: colored(colorsEnabled, { fg: values.borderFg, dim: true }),
    paneTitle: colored(colorsEnabled, { fg: values.headerFg, bold: true }),
    screenTitle: colored(colorsEnabled, { fg: values.headerFg, bold: true }),
    header: colorsEnabled ? Object.freeze({ fg: values.headerFg, bg: values.barBg }) : Object.freeze({ dim: true }),
    selection: colored(colorsEnabled, { bg: values.selectionBg }),
    selectedId: Object.freeze({ bold: true }),
    dim: colorsEnabled ? Object.freeze({ fg: values.dimFg }) : Object.freeze({ dim: true }),
    accent: colored(colorsEnabled, { fg: values.accentFg }),
    input: colored(colorsEnabled, { bg: values.selectionBg }),
    inputLabel: colored(colorsEnabled, { fg: values.accentFg }),
    inputCursor: Object.freeze({ underline: true }),
    searchMatch: colored(colorsEnabled, { bg: values.searchMatchBg, bold: true }),
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
    negative: colored(colorsEnabled, { fg: values.statusFailed })
  });
}

export const uiPalette = createPalette();
