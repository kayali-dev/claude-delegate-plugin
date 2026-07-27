import { rgbTo256, xterm256ToRgb } from './ansi.mjs';

export const PALETTE_SEEDS = Object.freeze({
  accentHue: 195,
  accentChroma: 0.09,
  neutralHue: 235,
  neutralChroma: 0.012
});

export const CONTRAST_TARGETS = Object.freeze({
  text: 8,
  textSecondary: 5.5,
  textMuted: 4.5,
  borderSubtle: 1.6,
  border: 2.2,
  borderActive: 3.5,
  semantic: 4.5
});

export const TUI_THEME_PRESETS = Object.freeze([
  'dark',
  'light',
  'dark-daltonized',
  'light-daltonized',
  'dark-ansi',
  'light-ansi'
]);

export const PALETTE_TOKEN_NAMES = Object.freeze([
  'bg', 'surface', 'surfaceRaised', 'surfaceOverlay',
  'borderSubtle', 'border', 'borderActive',
  'text', 'textSecondary', 'textMuted', 'textOnAccent',
  'accentSubtle', 'accent', 'accentStrong', 'accentText',
  'successFg', 'successSubtleBg', 'warningFg', 'warningSubtleBg',
  'errorFg', 'errorSubtleBg', 'infoFg', 'infoSubtleBg',
  'selectionBg', 'selectionFg',
  'meterTrack', 'meterFill',
  'diffAddedFg', 'diffAddedBg', 'diffRemovedFg', 'diffRemovedBg',
  'diffHunkFg', 'diffHeaderFg',
  'categorical0', 'categorical1', 'categorical2', 'categorical3',
  'categorical4', 'categorical5', 'categorical6', 'categorical7'
]);

const TOKEN_NAME_SET = new Set(PALETTE_TOKEN_NAMES);
const PRESET_SET = new Set(TUI_THEME_PRESETS);
const SURFACE_LIGHTNESS = Object.freeze({
  dark: Object.freeze({ bg: 0.180, surface: 0.225, surfaceRaised: 0.270, surfaceOverlay: 0.315 }),
  light: Object.freeze({ bg: 0.985, surface: 0.950, surfaceRaised: 0.915, surfaceOverlay: 0.880 })
});
const SURFACE_NAMES = Object.freeze(['bg', 'surface', 'surfaceRaised', 'surfaceOverlay']);
const CATEGORICAL_HUES = Object.freeze([25, 145, 85, 255, 310, 195, 55, 275]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function normalizedOklch(value) {
  const source = Array.isArray(value)
    ? { l: value[0], c: value[1], h: value[2] }
    : value && typeof value === 'object'
      ? { l: value.l ?? value.lightness, c: value.c ?? value.chroma, h: value.h ?? value.hue }
      : null;
  if (!source || !Number.isFinite(Number(source.l)) || !Number.isFinite(Number(source.c)) || !Number.isFinite(Number(source.h))) return null;
  const lightness = Number(source.l);
  const chroma = Number(source.c);
  if (lightness < 0 || lightness > 1 || chroma < 0 || chroma > 0.4) return null;
  return Object.freeze([
    Number(lightness.toFixed(6)),
    Number(chroma.toFixed(6)),
    ((Number(source.h) % 360) + 360) % 360
  ]);
}

function linearToSrgb(channel) {
  const encoded = channel <= 0.0031308
    ? 12.92 * channel
    : (1.055 * Math.max(0, channel) ** (1 / 2.4)) - 0.055;
  return clamp(encoded, 0, 1);
}

export function oklchToSrgb(lightness, chroma, hue) {
  const normalized = normalizedOklch(
    typeof lightness === 'object' ? lightness : [lightness, chroma, hue]
  );
  if (!normalized) throw new TypeError('OKLCH must contain finite L, C, and h values in range');
  const [lValue, cValue, hueValue] = normalized;
  const radians = hueValue * Math.PI / 180;
  const a = cValue * Math.cos(radians);
  const b = cValue * Math.sin(radians);

  const lPrime = lValue + (0.3963377774 * a) + (0.2158037573 * b);
  const mPrime = lValue - (0.1055613458 * a) - (0.0638541728 * b);
  const sPrime = lValue - (0.0894841775 * a) - (1.2914855480 * b);
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const red = (+4.0767416621 * l) + (-3.3077115913 * m) + (+0.2309699292 * s);
  const green = (-1.2684380046 * l) + (+2.6097574011 * m) + (-0.3413193965 * s);
  const blue = (-0.0041960863 * l) + (-0.7034186147 * m) + (+1.7076147010 * s);
  return Object.freeze([red, green, blue].map((channel) => Math.round(linearToSrgb(channel) * 255)));
}

function relativeLuminance(rgb) {
  const channels = rgb.map((channel) => {
    const encoded = clamp(channel, 0, 255) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

export function wcagContrast(first, second) {
  const left = relativeLuminance(Array.isArray(first) ? first : first?.rgb || []);
  const right = relativeLuminance(Array.isArray(second) ? second : second?.rgb || []);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function colorAt(lightness, chroma, hue) {
  const oklch = normalizedOklch([lightness, chroma, hue]);
  const rgb = oklchToSrgb(oklch);
  return { oklch, rgb, index: rgbTo256(...rgb) };
}

function tone(name, oklch, audit = {}) {
  const color = colorAt(...oklch);
  return Object.freeze({
    name,
    index: color.index,
    rgb: color.rgb,
    oklch: color.oklch,
    category: audit.category || 'other',
    target: Number.isFinite(audit.target) ? audit.target : null,
    surfaces: Object.freeze([...(audit.surfaces || [])])
  });
}

function pairContrast(candidate, surface, quantized = false) {
  const left = quantized ? xterm256ToRgb(candidate.index) : candidate.rgb;
  const right = quantized ? xterm256ToRgb(surface.index) : surface.rgb;
  return wcagContrast(left, right);
}

function meetsContrast(candidate, surfaces, target) {
  return surfaces.every((surface) => pairContrast(candidate, surface) + 1e-9 >= target);
}

function solveTone(name, { chroma, hue, surfaces, target, direction, category }) {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = colorAt(middle, chroma, hue);
    if (direction > 0) {
      if (meetsContrast(candidate, surfaces, target)) high = middle;
      else low = middle;
    } else if (meetsContrast(candidate, surfaces, target)) low = middle;
    else high = middle;
  }
  let lightness = direction > 0 ? high : low;
  let candidate = colorAt(lightness, chroma, hue);
  for (let iteration = 0; iteration < 4000 && !meetsContrast(candidate, surfaces, target); iteration += 1) {
    lightness = clamp(lightness + (direction * 0.00025), 0, 1);
    candidate = colorAt(lightness, chroma, hue);
  }
  if (!meetsContrast(candidate, surfaces, target)) {
    throw new RangeError(`cannot solve ${name} to ${target}:1 contrast`);
  }
  return tone(name, candidate.oklch, {
    category,
    target,
    surfaces: surfaces.map((surface) => surface.name)
  });
}

function replaceAudit(token, audit) {
  return Object.freeze({
    ...token,
    name: audit.name || token.name,
    category: audit.category || token.category,
    target: Number.isFinite(audit.target) ? audit.target : null,
    surfaces: Object.freeze([...(audit.surfaces || [])])
  });
}

function semanticHues(daltonized) {
  return daltonized
    ? Object.freeze({ success: 250, warning: 315, error: 95, info: 205 })
    : Object.freeze({ success: 145, warning: 85, error: 25, info: 255 });
}

function buildTokenSet(base, daltonized = false) {
  const light = base === 'light';
  const direction = light ? -1 : 1;
  const tokens = {};
  const surfaceLightness = SURFACE_LIGHTNESS[base];
  for (const [index, name] of SURFACE_NAMES.entries()) {
    tokens[name] = tone(name, [surfaceLightness[name], PALETTE_SEEDS.neutralChroma, PALETTE_SEEDS.neutralHue], {
      category: 'surface',
      surfaces: [index === 0 ? name : SURFACE_NAMES[index - 1]]
    });
  }
  const allSurfaces = SURFACE_NAMES.map((name) => tokens[name]);
  const neutral = { chroma: PALETTE_SEEDS.neutralChroma, hue: PALETTE_SEEDS.neutralHue };
  const solve = (name, options) => {
    tokens[name] = solveTone(name, { direction, ...neutral, ...options });
    return tokens[name];
  };

  solve('borderSubtle', { surfaces: [tokens.surface], target: CONTRAST_TARGETS.borderSubtle, category: 'border' });
  solve('border', { surfaces: [tokens.bg], target: CONTRAST_TARGETS.border, category: 'border' });
  solve('borderActive', { surfaces: [tokens.bg], target: CONTRAST_TARGETS.borderActive, category: 'border' });
  solve('text', { surfaces: allSurfaces, target: CONTRAST_TARGETS.text, category: 'text' });
  solve('textSecondary', { surfaces: allSurfaces, target: CONTRAST_TARGETS.textSecondary, category: 'text' });
  solve('textMuted', { surfaces: allSurfaces, target: CONTRAST_TARGETS.textMuted, category: 'text' });

  tokens.accentSubtle = solveTone('accentSubtle', {
    chroma: 0.04, hue: PALETTE_SEEDS.accentHue, surfaces: [tokens.bg],
    target: 1.25, direction, category: 'accent'
  });
  tokens.accent = solveTone('accent', {
    chroma: PALETTE_SEEDS.accentChroma, hue: PALETTE_SEEDS.accentHue,
    surfaces: [...allSurfaces, tokens.accentSubtle], target: 4.5, direction, category: 'accent'
  });
  tokens.accentStrong = solveTone('accentStrong', {
    chroma: PALETTE_SEEDS.accentChroma, hue: PALETTE_SEEDS.accentHue,
    surfaces: allSurfaces, target: 7, direction, category: 'accent'
  });
  tokens.accentText = solveTone('accentText', {
    ...neutral, surfaces: [tokens.accentStrong], target: 4.5, direction: -direction, category: 'accent'
  });
  tokens.textOnAccent = replaceAudit(tokens.accentText, {
    name: 'textOnAccent', category: 'text', target: 4.5, surfaces: ['accentStrong']
  });
  tokens.accentSubtle = replaceAudit(tokens.accentSubtle, {
    category: 'accent', target: 4.5, surfaces: ['accent']
  });

  const hues = semanticHues(daltonized);
  for (const [semantic, hue] of Object.entries(hues)) {
    const backgroundName = `${semantic}SubtleBg`;
    const foregroundName = `${semantic}Fg`;
    tokens[backgroundName] = solveTone(backgroundName, {
      chroma: 0.035, hue, surfaces: [tokens.bg], target: 1.25, direction, category: 'semantic'
    });
    tokens[foregroundName] = solveTone(foregroundName, {
      chroma: semantic === 'warning' ? 0.12 : 0.105,
      hue,
      surfaces: [...allSurfaces, tokens[backgroundName]],
      target: CONTRAST_TARGETS.semantic,
      direction,
      category: 'semantic'
    });
    tokens[backgroundName] = replaceAudit(tokens[backgroundName], {
      category: 'semantic', target: CONTRAST_TARGETS.semantic, surfaces: [foregroundName]
    });
  }

  tokens.selectionBg = solveTone('selectionBg', {
    chroma: 0.045, hue: PALETTE_SEEDS.accentHue, surfaces: [tokens.bg],
    target: 1.35, direction, category: 'selection'
  });
  tokens.selectionFg = solveTone('selectionFg', {
    ...neutral, surfaces: [tokens.selectionBg], target: 4.5, direction, category: 'selection'
  });
  tokens.selectionBg = replaceAudit(tokens.selectionBg, {
    category: 'selection', target: 4.5, surfaces: ['selectionFg']
  });

  solve('meterTrack', { surfaces: [tokens.bg], target: 1.6, category: 'meter' });
  tokens.meterFill = solveTone('meterFill', {
    chroma: 0.09, hue: hues.info, surfaces: allSurfaces,
    target: 3.5, direction, category: 'meter'
  });

  const diffPairs = [
    ['diffAdded', hues.success],
    ['diffRemoved', hues.error]
  ];
  for (const [prefix, hue] of diffPairs) {
    const backgroundName = `${prefix}Bg`;
    const foregroundName = `${prefix}Fg`;
    tokens[backgroundName] = solveTone(backgroundName, {
      chroma: 0.035, hue, surfaces: [tokens.bg], target: 1.25, direction, category: 'diff'
    });
    tokens[foregroundName] = solveTone(foregroundName, {
      chroma: 0.105, hue, surfaces: [...allSurfaces, tokens[backgroundName]],
      target: 4.5, direction, category: 'diff'
    });
    tokens[backgroundName] = replaceAudit(tokens[backgroundName], {
      category: 'diff', target: 4.5, surfaces: [foregroundName]
    });
  }
  tokens.diffHunkFg = solveTone('diffHunkFg', {
    chroma: 0.09, hue: daltonized ? 205 : 275, surfaces: allSurfaces,
    target: 4.5, direction, category: 'diff'
  });
  solve('diffHeaderFg', { surfaces: allSurfaces, target: 5.5, category: 'diff' });

  CATEGORICAL_HUES.forEach((hue, index) => {
    tokens[`categorical${index}`] = solveTone(`categorical${index}`, {
      chroma: 0.08, hue, surfaces: allSurfaces,
      target: 4.5, direction, category: 'categorical'
    });
  });

  return tokens;
}

function normalizedOverride(value) {
  return normalizedOklch(value?.oklch || value);
}

export function normalizeThemeSelection(value) {
  if (typeof value === 'string') {
    const preset = value.toLowerCase();
    return PRESET_SET.has(preset) ? preset : 'dark';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'dark';
  const base = typeof value.base === 'string' && PRESET_SET.has(value.base.toLowerCase())
    ? value.base.toLowerCase()
    : 'dark';
  const overrides = {};
  for (const [name, candidate] of Object.entries(value.overrides || {})) {
    const oklch = TOKEN_NAME_SET.has(name) ? normalizedOverride(candidate) : null;
    if (oklch) overrides[name] = oklch;
  }
  return Object.freeze({ base, overrides: Object.freeze(overrides) });
}

const presetTokens = new Map();

function tokensForSelection(selection) {
  const normalized = normalizeThemeSelection(selection);
  const preset = typeof normalized === 'string' ? normalized : normalized.base;
  const base = preset.startsWith('light') ? 'light' : 'dark';
  const daltonized = preset.includes('daltonized');
  const cacheKey = `${base}:${daltonized}`;
  if (!presetTokens.has(cacheKey)) presetTokens.set(cacheKey, Object.freeze(buildTokenSet(base, daltonized)));
  const authored = presetTokens.get(cacheKey);
  if (typeof normalized === 'string' || !Object.keys(normalized.overrides).length) return { normalized, preset, base, authored };
  const overridden = { ...authored };
  for (const [name, oklch] of Object.entries(normalized.overrides)) {
    overridden[name] = tone(name, oklch, authored[name]);
  }
  return { normalized, preset, base, authored: Object.freeze(overridden) };
}

function colored(enabled, style, fallback = {}) {
  if (enabled) return Object.freeze(style);
  return Object.freeze(Object.fromEntries(
    Object.entries(fallback).filter(([key]) => !['fg', 'bg'].includes(key))
  ));
}

function paletteFromTokens(themeState, colorsEnabled) {
  const t = themeState.authored;
  // Body rows keep inheriting the user's terminal background. The authored bg
  // token is the contrast reference and surface-ramp root, while explicit
  // surfaces continue to own their complete rectangles.
  const bodyStyle = colored(colorsEnabled, { fg: t.text });
  const surfaceStyle = colored(colorsEnabled, { fg: t.text, bg: t.surface });
  const surfaceRaisedStyle = colored(colorsEnabled, { fg: t.text, bg: t.surfaceRaised });
  const surfaceOverlayStyle = colored(colorsEnabled, { fg: t.text, bg: t.surfaceOverlay });
  const borderSubtleStyle = colored(colorsEnabled, { fg: t.borderSubtle }, { dim: true });
  const borderStyle = colored(colorsEnabled, { fg: t.border }, { dim: true });
  const borderActiveStyle = colored(colorsEnabled, { fg: t.borderActive });
  const tileBorderStyle = colored(colorsEnabled, { fg: t.borderSubtle, bg: t.surface }, { dim: true });
  return Object.freeze({
    colorsEnabled,
    theme: themeState.preset,
    themeSelection: themeState.normalized,
    baseTheme: themeState.base,
    tokens: t,
    body: bodyStyle,
    dashboardBg: bodyStyle,
    surface: surfaceStyle,
    surfaceRaised: surfaceRaisedStyle,
    surfaceOverlay: surfaceOverlayStyle,
    tileSurface: surfaceStyle,
    tileBorder: tileBorderStyle,
    bar: colored(colorsEnabled, { fg: t.textSecondary, bg: t.surfaceRaised }, { dim: true }),
    borderSubtle: borderSubtleStyle,
    border: borderStyle,
    borderActive: borderActiveStyle,
    focusBorder: colored(colorsEnabled, { fg: t.accent }, { bold: true }),
    paneTitle: colored(colorsEnabled, { fg: t.textSecondary, bold: true }, { bold: true }),
    screenTitle: colored(colorsEnabled, { fg: t.textSecondary, bold: true }, { bold: true }),
    header: colored(colorsEnabled, { fg: t.textMuted, underline: true }, { underline: true, dim: true }),
    tabActive: colored(colorsEnabled, { fg: t.accent, underline: true }, { underline: true }),
    tabInactive: colored(colorsEnabled, { fg: t.textMuted }, { dim: true }),
    selection: colored(colorsEnabled, { bg: t.selectionBg }, { underline: true }),
    selectionBar: colored(colorsEnabled, { fg: t.accent }, { bold: true }),
    selectedId: Object.freeze({ bold: true }),
    dim: colored(colorsEnabled, { fg: t.textMuted }, { dim: true }),
    metadata: colored(colorsEnabled, { fg: t.textSecondary }),
    accent: colored(colorsEnabled, { fg: t.accent }, { bold: true }),
    info: colored(colorsEnabled, { fg: t.infoFg }),
    keyHint: colored(colorsEnabled, { fg: t.accent }, { bold: true }),
    tileValue: colored(colorsEnabled, { fg: t.text, bg: t.surface, bold: true }, { bold: true }),
    tileLabel: colored(colorsEnabled, { fg: t.textMuted, bg: t.surface }, { dim: true }),
    trendLabel: colored(colorsEnabled, { fg: t.textMuted, bg: t.surface }, { dim: true }),
    sparkline: colored(colorsEnabled, { fg: t.textSecondary, bg: t.surface }),
    trendPlaceholder: colored(colorsEnabled, { fg: t.textMuted, bg: t.surface }, { dim: true }),
    pill: colored(colorsEnabled, { bg: t.surfaceOverlay, fg: t.textSecondary }, { underline: true }),
    empty: colored(colorsEnabled, { fg: t.textMuted }, { dim: true }),
    input: colored(colorsEnabled, { fg: t.selectionFg, bg: t.selectionBg }),
    inputLabel: colored(colorsEnabled, { fg: t.accent }, { bold: true }),
    inputCursor: Object.freeze({ underline: true }),
    searchMatch: colored(colorsEnabled, { bg: t.selectionBg }, { underline: true }),
    running: colored(colorsEnabled, { fg: t.successFg }),
    failed: colored(colorsEnabled, { fg: t.errorFg }),
    stalled: colored(colorsEnabled, { fg: t.warningFg }),
    paused: colored(colorsEnabled, { fg: t.infoFg }),
    cancelled: colored(colorsEnabled, { fg: t.textMuted }, { dim: true }),
    completed: bodyStyle,
    badgeWarn: colored(colorsEnabled, { fg: t.warningFg }),
    danger: colored(colorsEnabled, { fg: t.errorFg }, { bold: true }),
    warningTitle: colored(colorsEnabled, { fg: t.warningFg, bold: true }, { bold: true }),
    positive: colored(colorsEnabled, { fg: t.diffAddedFg }),
    diffAddedRow: colored(colorsEnabled, { fg: t.diffAddedFg, bg: t.diffAddedBg }),
    diffAddedDim: colored(colorsEnabled, { fg: t.diffAddedFg, bg: t.diffAddedBg, dim: true }, { dim: true }),
    diffAddedEmphasis: colored(colorsEnabled, { fg: t.diffAddedFg, bg: t.diffAddedBg, bold: true }, { bold: true }),
    planCompleted: colored(colorsEnabled, { fg: t.successFg }, { dim: true }),
    planActive: colored(colorsEnabled, { fg: t.accent }, { bold: true }),
    planPending: colored(colorsEnabled, { fg: t.textMuted }, { dim: true }),
    negative: colored(colorsEnabled, { fg: t.diffRemovedFg }),
    diffRemovedRow: colored(colorsEnabled, { fg: t.diffRemovedFg, bg: t.diffRemovedBg }),
    diffRemovedDim: colored(colorsEnabled, { fg: t.diffRemovedFg, bg: t.diffRemovedBg, dim: true }, { dim: true }),
    diffRemovedEmphasis: colored(colorsEnabled, { fg: t.diffRemovedFg, bg: t.diffRemovedBg, bold: true }, { bold: true }),
    hunk: colored(colorsEnabled, { fg: t.diffHunkFg }),
    diffHeader: colored(colorsEnabled, { fg: t.diffHeaderFg }),
    eventSeq: colored(colorsEnabled, { fg: t.textMuted }, { dim: true }),
    eventTagMessage: colored(colorsEnabled, { fg: t.infoFg }),
    eventTagTool: colored(colorsEnabled, { fg: t.infoFg }),
    eventTagWarning: colored(colorsEnabled, { fg: t.warningFg }),
    eventTagError: colored(colorsEnabled, { fg: t.errorFg }),
    eventTagUsage: colored(colorsEnabled, { fg: t.textSecondary }),
    jsonKey: colored(colorsEnabled, { fg: t.textSecondary }, { dim: true }),
    jsonString: bodyStyle,
    jsonNumber: colored(colorsEnabled, { fg: t.infoFg }),
    jsonLiteral: colored(colorsEnabled, { fg: t.warningFg }),
    scrollTrack: borderSubtleStyle,
    scrollThumb: colored(colorsEnabled, { fg: t.accent }, { underline: true }),
    meterTrack: colored(colorsEnabled, { fg: t.meterTrack }, { dim: true }),
    meterFill: colored(colorsEnabled, { fg: t.meterFill }),
    categories: Object.freeze(Array.from({ length: 8 }, (_, index) => colored(colorsEnabled, { fg: t[`categorical${index}`] })))
  });
}

export function createPalette(env = process.env, selection = env.DELEGATE_TUI_THEME || 'dark') {
  const themeState = tokensForSelection(selection);
  const ansiVariant = themeState.preset.endsWith('-ansi');
  const colorsEnabled = !Object.hasOwn(env, 'NO_COLOR') && !ansiVariant;
  return paletteFromTokens(themeState, colorsEnabled);
}

const darkTokens = tokensForSelection('dark').authored;
const lightTokens = tokensForSelection('light').authored;

// Compatibility exports for existing consumers. Their values are perceptually
// authored tokens and their xterm indices are derived, never hand-selected.
export const barBg = darkTokens.surfaceRaised;
export const barFg = darkTokens.textSecondary;
export const headerFg = darkTokens.textSecondary;
export const selectionBg = darkTokens.selectionBg;
export const surfaceBg = darkTokens.surface;
export const pillBg = darkTokens.surfaceOverlay;
export const borderFg = darkTokens.border;
export const dimFg = darkTokens.textMuted;
export const accentFg = darkTokens.accent;
export const statusRunning = darkTokens.successFg;
export const statusFailed = darkTokens.errorFg;
export const statusStalled = darkTokens.warningFg;
export const statusPaused = darkTokens.infoFg;
export const statusCancelled = darkTokens.textMuted;
export const badgeWarn = darkTokens.warningFg;
export const searchMatchBg = darkTokens.selectionBg;

export const lightBarBg = lightTokens.surfaceRaised;
export const lightBarFg = lightTokens.textSecondary;
export const lightHeaderFg = lightTokens.textSecondary;
export const lightSelectionBg = lightTokens.selectionBg;
export const lightSurfaceBg = lightTokens.surface;
export const lightPillBg = lightTokens.surfaceOverlay;
export const lightBorderFg = lightTokens.border;
export const lightDimFg = lightTokens.textMuted;
export const lightAccentFg = lightTokens.accent;
export const lightStatusRunning = lightTokens.successFg;
export const lightStatusFailed = lightTokens.errorFg;
export const lightStatusStalled = lightTokens.warningFg;
export const lightStatusPaused = lightTokens.infoFg;
export const lightStatusCancelled = lightTokens.textMuted;
export const lightBadgeWarn = lightTokens.warningFg;
export const lightSearchMatchBg = lightTokens.selectionBg;

export function paletteAuditRows(selection = 'dark') {
  const { authored, preset } = tokensForSelection(selection);
  return PALETTE_TOKEN_NAMES.map((name) => {
    const token = authored[name];
    let surface = null;
    let contrast = null;
    let contrast256 = null;
    if (token.surfaces.length) {
      const candidates = token.surfaces.map((surfaceName) => {
        const surfaceToken = authored[surfaceName];
        return {
          name: surfaceName,
          contrast: wcagContrast(token.rgb, surfaceToken.rgb),
          contrast256: wcagContrast(xterm256ToRgb(token.index), xterm256ToRgb(surfaceToken.index))
        };
      });
      candidates.sort((left, right) => left.contrast - right.contrast);
      surface = candidates[0].name;
      contrast = candidates[0].contrast;
      contrast256 = candidates[0].contrast256;
    }
    return Object.freeze({
      preset,
      name,
      category: token.category,
      oklch: token.oklch,
      rgb: token.rgb,
      index: token.index,
      surface,
      target: token.target,
      contrast,
      contrast256
    });
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
  activePalette = createPalette(env, theme);
  return uiPalette;
}
