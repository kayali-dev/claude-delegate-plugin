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

function colored(enabled, style) {
  if (enabled) return Object.freeze(style);
  return Object.freeze(Object.fromEntries(Object.entries(style).filter(([key]) => !['fg', 'bg'].includes(key))));
}

export function createPalette(env = process.env) {
  const colorsEnabled = !Object.hasOwn(env, 'NO_COLOR');
  return Object.freeze({
    colorsEnabled,
    body: Object.freeze({}),
    bar: colorsEnabled ? Object.freeze({ fg: barFg, bg: barBg }) : Object.freeze({ dim: true }),
    border: colored(colorsEnabled, { fg: borderFg, dim: true }),
    paneTitle: colored(colorsEnabled, { fg: headerFg, bold: true }),
    screenTitle: colored(colorsEnabled, { fg: headerFg, bold: true }),
    header: colorsEnabled ? Object.freeze({ fg: headerFg, bg: barBg }) : Object.freeze({ dim: true }),
    selection: colored(colorsEnabled, { bg: selectionBg }),
    selectedId: Object.freeze({ bold: true }),
    dim: colorsEnabled ? Object.freeze({ fg: dimFg }) : Object.freeze({ dim: true }),
    accent: colored(colorsEnabled, { fg: accentFg }),
    input: colored(colorsEnabled, { bg: selectionBg }),
    inputLabel: colored(colorsEnabled, { fg: accentFg }),
    inputCursor: Object.freeze({ underline: true }),
    running: colored(colorsEnabled, { fg: statusRunning }),
    failed: colored(colorsEnabled, { fg: statusFailed }),
    stalled: colored(colorsEnabled, { fg: statusStalled }),
    paused: colored(colorsEnabled, { fg: statusPaused }),
    cancelled: colored(colorsEnabled, { fg: statusCancelled }),
    completed: Object.freeze({}),
    badgeWarn: colored(colorsEnabled, { fg: badgeWarn }),
    danger: colored(colorsEnabled, { fg: statusFailed }),
    warningTitle: colored(colorsEnabled, { fg: badgeWarn, bold: true }),
    positive: colored(colorsEnabled, { fg: statusRunning }),
    negative: colored(colorsEnabled, { fg: statusFailed })
  });
}

export const uiPalette = createPalette();
