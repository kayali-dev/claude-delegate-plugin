import { formatDisplayValue, formatMultilineDisplayValue } from './display.mjs';

function finiteCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function hunkRange(line) {
  const match = String(line || '').match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(?:\s*(.*))?$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    newStart: Number(match[2]),
    symbol: formatDisplayValue(match[3]).trim()
  };
}

function candidateSymbol(lines, index, previous) {
  const direct = hunkRange(lines[index])?.symbol;
  if (direct) return direct;
  if (previous) return previous;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.startsWith('@@') || line.startsWith('diff --git ')) break;
    if (!line.startsWith(' ')) continue;
    const content = line.slice(1).trimEnd();
    if (content && /^\S/.test(content)) return content;
  }
  return 'changed lines';
}

export function commonChangeSpan(leftValue, rightValue) {
  const left = formatDisplayValue(leftValue);
  const right = formatDisplayValue(rightValue);
  let prefix = 0;
  const maximumPrefix = Math.min(left.length, right.length);
  while (prefix < maximumPrefix && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  const maximumSuffix = Math.min(left.length - prefix, right.length - prefix);
  while (suffix < maximumSuffix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  return Object.freeze({
    left: Object.freeze({ prefix, changedEnd: left.length - suffix, length: left.length }),
    right: Object.freeze({ prefix, changedEnd: right.length - suffix, length: right.length })
  });
}

function applyIntraLinePairs(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== 'removed') continue;
    const removed = [];
    const added = [];
    let cursor = index;
    while (rows[cursor]?.kind === 'removed') removed.push(rows[cursor++]);
    while (rows[cursor]?.kind === 'added') added.push(rows[cursor++]);
    const pairs = Math.min(removed.length, added.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      const span = commonChangeSpan(removed[pair].content, added[pair].content);
      removed[pair].changeSpan = span.left;
      added[pair].changeSpan = span.right;
    }
    index = cursor - 1;
  }
}

export function projectDiffRows(diffText, options = {}) {
  const text = formatMultilineDisplayValue(diffText, { maxLength: 64_000 });
  const lines = text ? text.split('\n') : [];
  const rows = [];
  const band = options.band;
  if (band) {
    rows.push({
      kind: 'file-band',
      path: formatDisplayValue(band.path || 'selected diff'),
      additions: finiteCount(band.additions),
      deletions: finiteCount(band.deletions),
      raw: formatDisplayValue(band.path || 'selected diff')
    });
  }
  let oldLine = null;
  let newLine = null;
  let nearestSymbol = '';
  for (let index = 0; index < lines.length; index += 1) {
    const raw = formatDisplayValue(lines[index]);
    const range = hunkRange(raw);
    if (range) {
      oldLine = range.oldStart;
      newLine = range.newStart;
      const symbol = candidateSymbol(lines, index, nearestSymbol);
      rows.push({ kind: 'hunk', raw, symbol, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith('diff --git ')) nearestSymbol = '';
    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('---') || raw.startsWith('+++')) {
      rows.push({ kind: 'header', raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith('\\')) {
      rows.push({ kind: 'meta', raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith('-')) {
      rows.push({ kind: 'removed', raw, content: raw.slice(1), oldLine, newLine: null });
      if (oldLine != null) oldLine += 1;
      continue;
    }
    if (raw.startsWith('+')) {
      rows.push({ kind: 'added', raw, content: raw.slice(1), oldLine: null, newLine });
      if (newLine != null) newLine += 1;
      continue;
    }
    const content = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({ kind: 'context', raw, content, oldLine, newLine });
    if (content && /^\S/.test(content)) nearestSymbol = content.trimEnd();
    if (oldLine != null) oldLine += 1;
    if (newLine != null) newLine += 1;
  }
  applyIntraLinePairs(rows);
  const maximumLine = rows.reduce((maximum, row) => Math.max(maximum, Number(row.oldLine || 0), Number(row.newLine || 0)), 0);
  const numberWidth = Math.max(3, Math.min(7, String(maximumLine || 0).length));
  return Object.freeze(rows.map((row) => Object.freeze({ ...row, numberWidth })));
}

export function prepareDiffWindow(window = {}, options = {}) {
  const diff = formatDisplayValue(window.diff);
  return Object.freeze({
    ...window,
    diff,
    rows: projectDiffRows(diff, options)
  });
}

export function formatDiffRow(row) {
  if (row?.kind === 'file-band') return `${formatDisplayValue(row.path)} +${finiteCount(row.additions)} -${finiteCount(row.deletions)}`;
  if (row?.kind === 'hunk') return formatDisplayValue(row.symbol);
  return formatDisplayValue(row?.raw);
}

export function wrapDiffRow(row, _width, formatted = formatDiffRow(row)) {
  const text = formatDisplayValue(formatted);
  return {
    value: text,
    lines: [text],
    fragments: [{ text, sourceText: text, start: 0, end: text.length, lineKind: `diff-${row?.kind || 'context'}` }]
  };
}
