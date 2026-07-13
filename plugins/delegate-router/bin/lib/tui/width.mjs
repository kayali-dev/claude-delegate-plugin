// Terminal width is measured per grapheme where Intl.Segmenter is available.
// Common combining sequences, emoji/ZWJ sequences, flags, and East Asian wide
// ranges are handled. Exotic grapheme clusters whose terminals disagree with
// Unicode's default segmentation may still render one cell differently.

export const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

const segmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

export function splitGraphemes(value) {
  const text = String(value ?? '');
  if (!segmenter) return Array.from(text);
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

function isControl(codePoint) {
  return codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0);
}

function isWide(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function graphemeWidth(grapheme) {
  const text = String(grapheme ?? '');
  if (!text) return 0;
  if (EMOJI.test(text) || /\u20e3/u.test(text)) return 2;
  for (const symbol of Array.from(text)) {
    const codePoint = symbol.codePointAt(0);
    if (isControl(codePoint) || MARK.test(symbol) || codePoint === 0x200d
      || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
      || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) continue;
    return isWide(codePoint) ? 2 : 1;
  }
  return 0;
}

function tokens(value) {
  const text = String(value ?? '');
  const result = [];
  let offset = 0;
  ANSI_PATTERN.lastIndex = 0;
  for (;;) {
    const match = ANSI_PATTERN.exec(text);
    if (!match) break;
    if (match.index > offset) result.push({ ansi: false, value: text.slice(offset, match.index) });
    result.push({ ansi: true, value: match[0] });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) result.push({ ansi: false, value: text.slice(offset) });
  return result;
}

export function displayWidth(value) {
  let width = 0;
  for (const token of tokens(value)) {
    if (token.ansi) continue;
    for (const grapheme of splitGraphemes(token.value)) width += graphemeWidth(grapheme);
  }
  return width;
}

export function truncateToWidth(value, columns) {
  const text = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(columns) || 0));
  if (displayWidth(text) <= limit) return text;
  let width = 0;
  let output = '';
  let sawSgr = false;
  outer: for (const token of tokens(text)) {
    if (token.ansi) {
      output += token.value;
      if (/^\u001b\[[0-9;:]*m$/.test(token.value)) sawSgr = true;
      continue;
    }
    for (const grapheme of splitGraphemes(token.value)) {
      const next = graphemeWidth(grapheme);
      if (width + next > limit) break outer;
      output += grapheme;
      width += next;
    }
  }
  if (sawSgr && !output.endsWith('\u001b[0m')) output += '\u001b[0m';
  return output;
}

export function padToWidth(value, columns, align = 'left') {
  const limit = Math.max(0, Math.floor(Number(columns) || 0));
  const truncated = truncateToWidth(value, limit);
  const remaining = Math.max(0, limit - displayWidth(truncated));
  if (align === 'right') return `${' '.repeat(remaining)}${truncated}`;
  if (align === 'center') {
    const left = Math.floor(remaining / 2);
    return `${' '.repeat(left)}${truncated}${' '.repeat(remaining - left)}`;
  }
  return `${truncated}${' '.repeat(remaining)}`;
}

