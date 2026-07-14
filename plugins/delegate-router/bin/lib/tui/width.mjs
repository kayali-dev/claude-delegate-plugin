// Terminal width is measured per grapheme where Intl.Segmenter is available.
// Static Unicode widths are corrected by an optional terminal-probed override
// table. Suspect graphemes are also identified so screen.mjs can confine any
// remaining terminal disagreement to that grapheme's own cells.

import { CHROME_GLYPHS } from './glyphs.mjs';

export const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

const segmenter = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const ASSIGNED = /\p{Assigned}/u;
const runtimeWidthOverrides = new Map();

// Generated from Unicode 17.0.0 EastAsianWidth.txt (2025-07-24), selecting
// every explicit `A` record without curation:
// https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
// Stored as inclusive start/end pairs parsed once at module initialization.
const EAST_ASIAN_AMBIGUOUS_DATA = `
00A1 00A4 00A7 00A8 00AA 00AD 00AE 00B0
00B1 00B2-00B3 00B4 00B6-00B7 00B8 00B9 00BA 00BC-00BE
00BF 00C6 00D0 00D7 00D8 00DE-00E1 00E6 00E8-00EA
00EC-00ED 00F0 00F2-00F3 00F7 00F8-00FA 00FC 00FE 0101
0111 0113 011B 0126-0127 012B 0131-0133 0138 013F-0142
0144 0148-014B 014D 0152-0153 0166-0167 016B 01CE 01D0
01D2 01D4 01D6 01D8 01DA 01DC 0251 0261
02C4 02C7 02C9-02CB 02CD 02D0 02D8-02DB 02DD 02DF
0300-036F 0391-03A1 03A3-03A9 03B1-03C1 03C3-03C9 0401 0410-044F 0451
2010 2013-2015 2016 2018 2019 201C 201D 2020-2022
2024-2027 2030 2032-2033 2035 203B 203E 2074 207F
2081-2084 20AC 2103 2105 2109 2113 2116 2121-2122
2126 212B 2153-2154 215B-215E 2160-216B 2170-2179 2189 2190-2194
2195-2199 21B8-21B9 21D2 21D4 21E7 2200 2202-2203 2207-2208
220B 220F 2211 2215 221A 221D-2220 2223 2225
2227-222C 222E 2234-2237 223C-223D 2248 224C 2252 2260-2261
2264-2267 226A-226B 226E-226F 2282-2283 2286-2287 2295 2299 22A5
22BF 2312 2460-249B 249C-24E9 24EB-24FF 2500-254B 2550-2573 2580-258F
2592-2595 25A0-25A1 25A3-25A9 25B2-25B3 25B6 25B7 25BC-25BD 25C0
25C1 25C6-25C8 25CB 25CE-25D1 25E2-25E5 25EF 2605-2606 2609
260E-260F 261C 261E 2640 2642 2660-2661 2663-2665 2667-266A
266C-266D 266F 269E-269F 26BF 26C6-26CD 26CF-26D3 26D5-26E1 26E3
26E8-26E9 26EB-26F1 26F4 26F6-26F9 26FB-26FC 26FE-26FF 273D 2776-277F
2B56-2B59 3248-324F E000-F8FF FE00-FE0F FFFD 1F100-1F10A 1F110-1F12D 1F130-1F169
1F170-1F18D 1F18F-1F190 1F19B-1F1AC E0100-E01EF F0000-FFFFD 100000-10FFFD
`;

export const EAST_ASIAN_AMBIGUOUS_RANGES = Object.freeze(EAST_ASIAN_AMBIGUOUS_DATA.trim().split(/\s+/).flatMap((token) => {
  const [start, end = start] = token.split('-').map((value) => Number.parseInt(value, 16));
  return [start, end];
}));

export function isEastAsianAmbiguousCodePoint(codePoint) {
  const target = Number(codePoint);
  if (!Number.isInteger(target) || target < 0 || target > 0x10ffff) return false;
  let low = 0;
  let high = EAST_ASIAN_AMBIGUOUS_RANGES.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = EAST_ASIAN_AMBIGUOUS_RANGES[middle * 2];
    const end = EAST_ASIAN_AMBIGUOUS_RANGES[middle * 2 + 1];
    if (target < start) high = middle - 1;
    else if (target > end) low = middle + 1;
    else return true;
  }
  return false;
}

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

export function isWideCodePoint(codePoint) {
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

function isCoreCertain(codePoint) {
  return (codePoint >= 0x20 && codePoint <= 0x7e)
    || (codePoint >= 0xa0 && codePoint <= 0xff)
    || (codePoint >= 0x2500 && codePoint <= 0x257f)
    || (codePoint >= 0x2800 && codePoint <= 0x28ff)
    || isWideCodePoint(codePoint);
}

function hasVariationOrJoiner(text) {
  return /[\u200d\ufe0e\ufe0f]|[\u{e0100}-\u{e01ef}]/u.test(text);
}

function isEmojiModifier(codePoint) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

// Conservative by design. Anything outside the explicitly width-stable sets
// is suspect, including East-Asian-ambiguous symbols and code points newer
// than the terminal's Unicode table. A single basic combining mark on a stable
// base is the one combining form treated as certain.
export function classifyGraphemeWidth(grapheme) {
  const text = String(grapheme ?? '');
  if (!text) return Object.freeze({ kind: 'certain', suspect: false, reason: 'empty' });
  const symbols = Array.from(text);
  const points = symbols.map((symbol) => symbol.codePointAt(0));
  if (points.every(isControl)) return Object.freeze({ kind: 'certain', suspect: false, reason: 'control' });
  if (hasVariationOrJoiner(text)) return Object.freeze({ kind: 'suspect', suspect: true, reason: 'variation-or-joiner' });
  if (EMOJI.test(text) || points.some(isEmojiModifier) || text.includes('\u20e3')) {
    return Object.freeze({ kind: 'suspect', suspect: true, reason: 'emoji-presentation' });
  }
  if (points.some(isEastAsianAmbiguousCodePoint)) {
    return Object.freeze({ kind: 'suspect', suspect: true, reason: 'east-asian-ambiguous' });
  }
  if (symbols.length === 2 && isCoreCertain(points[0]) && points[1] >= 0x300 && points[1] <= 0x36f && MARK.test(symbols[1])) {
    return Object.freeze({ kind: 'certain', suspect: false, reason: 'simple-combining' });
  }
  if (symbols.length > 1 || symbols.some((symbol) => MARK.test(symbol))) {
    return Object.freeze({ kind: 'suspect', suspect: true, reason: 'complex-grapheme' });
  }
  if (!ASSIGNED.test(symbols[0])) return Object.freeze({ kind: 'suspect', suspect: true, reason: 'unassigned' });
  if (isCoreCertain(points[0])) return Object.freeze({ kind: 'certain', suspect: false, reason: 'stable-range' });
  return Object.freeze({ kind: 'suspect', suspect: true, reason: 'ambiguous-or-unknown' });
}

export function isWidthSuspect(grapheme) {
  return classifyGraphemeWidth(grapheme).suspect;
}

export function setGraphemeWidthOverrides(values, options = {}) {
  if (options.replace !== false) runtimeWidthOverrides.clear();
  const entries = values instanceof Map ? values.entries() : Object.entries(values || {});
  for (const [grapheme, width] of entries) {
    const measured = Number(width);
    if (!String(grapheme) || !Number.isInteger(measured) || measured < 0 || measured > 2) continue;
    runtimeWidthOverrides.set(String(grapheme), measured);
  }
  return getGraphemeWidthOverrides();
}

export function clearGraphemeWidthOverrides() {
  runtimeWidthOverrides.clear();
}

export function getGraphemeWidthOverrides() {
  return Object.freeze(Object.fromEntries(runtimeWidthOverrides));
}

export function hasGraphemeWidthOverride(grapheme) {
  return runtimeWidthOverrides.has(String(grapheme ?? ''));
}

export function chromeGlyph(preferred, fallback) {
  const fancy = String(preferred ?? '');
  if (!isWidthSuspect(fancy) || hasGraphemeWidthOverride(fancy)) return fancy;
  return String(fallback ?? '');
}

export function graphemeWidth(grapheme) {
  const text = String(grapheme ?? '');
  if (!text) return 0;
  if (runtimeWidthOverrides.has(text)) return runtimeWidthOverrides.get(text);
  if (EMOJI.test(text) || /\u20e3/u.test(text)) return 2;
  for (const symbol of Array.from(text)) {
    const codePoint = symbol.codePointAt(0);
    if (isControl(codePoint) || MARK.test(symbol) || codePoint === 0x200d
      || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
      || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) continue;
    return isWideCodePoint(codePoint) ? 2 : 1;
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

export function truncateToWidth(value, columns, options = {}) {
  const text = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(columns) || 0));
  if (displayWidth(text) <= limit) return text;
  const marker = options.ellipsis && limit > 0
    ? (limit >= displayWidth(CHROME_GLYPHS.truncation) ? CHROME_GLYPHS.truncation : CHROME_GLYPHS.truncation[0])
    : '';
  const contentLimit = Math.max(0, limit - displayWidth(marker));
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
      if (width + next > contentLimit) break outer;
      output += grapheme;
      width += next;
    }
  }
  output += marker;
  if (sawSgr && !output.endsWith('\u001b[0m')) output += '\u001b[0m';
  return output;
}

export function padToWidth(value, columns, align = 'left') {
  const limit = Math.max(0, Math.floor(Number(columns) || 0));
  const truncated = truncateToWidth(value, limit, { ellipsis: true });
  const remaining = Math.max(0, limit - displayWidth(truncated));
  if (align === 'right') return `${' '.repeat(remaining)}${truncated}`;
  if (align === 'center') {
    const left = Math.floor(remaining / 2);
    return `${' '.repeat(left)}${truncated}${' '.repeat(remaining - left)}`;
  }
  return `${truncated}${' '.repeat(remaining)}`;
}

// Detailed hard wrapping used by renderer components. It splits overlong
// unbroken tokens by grapheme/display width, so URLs, hashes, and paths can
// never escape a pane even when no whitespace is available.
export function wrapToWidth(value, columns) {
  const text = stripAnsi(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const width = Math.max(0, Math.floor(Number(columns) || 0));
  if (width <= 0) return { value: text, lines: [], fragments: [] };
  if (!text) return { value: text, lines: [''], fragments: [{ text: '', start: 0, end: 0 }] };
  const fragments = [];
  let current = '';
  let used = 0;
  let offset = 0;
  let start = 0;
  for (const grapheme of splitGraphemes(text)) {
    if (grapheme === '\n') {
      fragments.push({ text: current, start, end: offset });
      current = '';
      used = 0;
      offset += grapheme.length;
      start = offset;
      continue;
    }
    const size = graphemeWidth(grapheme);
    if (used + size > width && current) {
      fragments.push({ text: current, start, end: offset });
      current = '';
      used = 0;
      start = offset;
    }
    if (size <= width) {
      current += grapheme;
      used += size;
    }
    offset += grapheme.length;
  }
  fragments.push({ text: current, start, end: offset });
  return { value: text, lines: fragments.map((fragment) => fragment.text), fragments };
}
