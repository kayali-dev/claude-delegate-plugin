// Terminal-owned glyph policy. Ambiguous-width characters live only in the
// elegant tier and are selected only after CPR proved that the interposed VT
// layer (including tmux) renders every grapheme in the candidate at width 1.
// Keep this module independent of width.mjs to avoid a dependency cycle.

export const GLYPH_TIERS = Object.freeze({
  elegant: Object.freeze({
    cornerTopLeft: '╭', cornerTopRight: '╮', cornerBottomLeft: '╰', cornerBottomRight: '╯',
    joinLeft: '├', joinRight: '┤', horizontal: '─', vertical: '│',
    scrollTrack: '│', scrollThumb: '┃', separator: ' · ', truncation: '…',
    selectionBar: '▌', empty: '○',
    planCompleted: '✓', planPending: '○',
    toolCommand: '⚙', toolFile: '✎', toolMcp: '⇅', toolCursor: '›', success: '✓', failure: '✗',
    meter: Object.freeze(['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']),
    spark: Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']),
    spinnerFrames: Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'])
  }),
  safeUnicode: Object.freeze({
    cornerTopLeft: '+', cornerTopRight: '+', cornerBottomLeft: '+', cornerBottomRight: '+',
    joinLeft: '+', joinRight: '+', horizontal: '-', vertical: '|',
    scrollTrack: '|', scrollThumb: '#', separator: ' | ', truncation: '..',
    selectionBar: '>', empty: 'o',
    planCompleted: '+', planPending: 'o',
    toolCommand: '$', toolFile: 'F', toolMcp: 'M', toolCursor: '>', success: '+', failure: 'x',
    meter: Object.freeze(['#', '#', '#', '#', '#', '#', '#', '#']),
    spark: Object.freeze(['.', '.', '-', '-', '=', '=', '#', '#']),
    // Braille is width-certain in the static classifier and stays smooth when
    // the CPR probe is unavailable.
    spinnerFrames: Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'])
  }),
  ascii: Object.freeze({
    cornerTopLeft: '+', cornerTopRight: '+', cornerBottomLeft: '+', cornerBottomRight: '+',
    joinLeft: '+', joinRight: '+', horizontal: '-', vertical: '|',
    scrollTrack: '|', scrollThumb: '#', separator: ' | ', truncation: '..',
    selectionBar: '>', empty: 'o',
    planCompleted: '+', planPending: 'o',
    toolCommand: '$', toolFile: 'F', toolMcp: 'M', toolCursor: '>', success: '+', failure: 'x',
    meter: Object.freeze(['#', '#', '#', '#', '#', '#', '#', '#']),
    spark: Object.freeze(['.', '.', '-', '-', '=', '=', '#', '#']),
    spinnerFrames: Object.freeze(['|', '/', '-', '\\'])
  })
});

const state = {
  mode: 'safeUnicode',
  widths: Object.freeze({}),
  glyphs: GLYPH_TIERS.safeUnicode
};

function graphemes(value) {
  const text = String(value ?? '');
  if (typeof Intl?.Segmenter !== 'function') return Array.from(text);
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((entry) => entry.segment);
}

function elegantCandidateSafe(value, widths) {
  const values = Array.isArray(value) ? value : [value];
  return values.every((candidate) => graphemes(candidate).every((grapheme) => {
    const codePoint = grapheme.codePointAt(0);
    return (grapheme.length === 1 && codePoint >= 0x20 && codePoint <= 0x7e) || widths[grapheme] === 1;
  }));
}

function unicodeCapable(env) {
  if (String(env.DELEGATE_TUI_ASCII || '') === '1') return false;
  const locale = String(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
  if (/^(?:C|POSIX)(?:\.|$)/i.test(locale) && !/UTF-?8/i.test(locale)) return false;
  return String(env.TERM || '').toLowerCase() !== 'dumb';
}

export function configureGlyphs(options = {}) {
  const env = options.env || process.env;
  const widths = Object.freeze({ ...(options.widths || {}) });
  const safeTier = unicodeCapable(env) ? GLYPH_TIERS.safeUnicode : GLYPH_TIERS.ascii;
  const forceAscii = String(env.DELEGATE_TUI_ASCII || '') === '1';
  const selected = {};
  for (const key of Object.keys(GLYPH_TIERS.ascii)) {
    const elegant = GLYPH_TIERS.elegant[key];
    selected[key] = !forceAscii && elegantCandidateSafe(elegant, widths) ? elegant : safeTier[key];
  }
  selected.corner = selected.cornerTopLeft;
  selected.spinner = selected.spinnerFrames[0];
  selected.suspectFallback = '?';
  state.mode = forceAscii ? 'ascii' : Object.keys(GLYPH_TIERS.elegant).some((key) => selected[key] === GLYPH_TIERS.elegant[key])
    ? 'probed-elegant' : safeTier === GLYPH_TIERS.ascii ? 'ascii' : 'safeUnicode';
  state.widths = widths;
  state.glyphs = Object.freeze(selected);
  CHROME_SEPARATOR = state.glyphs.separator;
  return glyphConfiguration();
}

export function glyphConfiguration() {
  return Object.freeze({ mode: state.mode, widths: state.widths, glyphs: state.glyphs });
}

const keys = [...new Set([
  ...Object.keys(GLYPH_TIERS.ascii), 'corner', 'spinner', 'suspectFallback'
])];
export const CHROME_GLYPHS = Object.freeze(Object.defineProperties({}, Object.fromEntries(keys.map((key) => [key, {
  enumerable: true,
  get() { return state.glyphs[key]; }
}]))));

export let CHROME_SEPARATOR = CHROME_GLYPHS.separator;

export function spinnerGlyph(now = Date.now()) {
  const frames = CHROME_GLYPHS.spinnerFrames;
  return frames[Math.floor(Math.max(0, Number(now) || 0) / 100) % frames.length];
}

export function normalizeChromePunctuation(value) {
  return String(value ?? '')
    .replaceAll('\u00b7', CHROME_GLYPHS.separator.trim())
    .replaceAll('\u2026', CHROME_GLYPHS.truncation)
    .replaceAll('\u2013', '-')
    .replaceAll('\u2014', '--');
}

// Establish the no-probe fallback at module load. The executable calls this
// again with cached or freshly measured widths before its first frame.
configureGlyphs();
