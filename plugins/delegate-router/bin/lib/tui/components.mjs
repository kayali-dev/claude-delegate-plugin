import { CellGrid, renderGridToString } from './screen.mjs';
import { formatDisplayValue } from './display.mjs';
import { CHROME_GLYPHS, normalizeChromePunctuation, spinnerGlyph } from './glyphs.mjs';
import { displayWidth, padToWidth, stripAnsi, truncateToWidth, wrapToWidth } from './width.mjs';
import { uiPalette as palette } from './palette.mjs';

function mergeStyle(...styles) {
  return Object.assign({}, ...styles.filter(Boolean));
}

function inner(rect) {
  // Borders own the edge cells; content gets one column of breathing room on
  // both sides. Vertical space remains dense enough for small terminals.
  return { x: rect.x + 2, y: rect.y + 1, width: Math.max(0, rect.width - 4), height: Math.max(0, rect.height - 2) };
}

// This is the sole pane-to-display mapping. Selection scrolling, click hit
// testing, wrapping, highlighting, and painting must all use this exact rect.
export function paneContentRect(pane, options = {}) {
  const rect = pane.rect;
  if (pane.border !== false) return inner(rect);
  const padded = { x: rect.x + 1, y: rect.y, width: Math.max(0, rect.width - 2), height: rect.height };
  return options.scrollbar === true && padded.width > 1 ? { ...padded, width: padded.width - 1 } : padded;
}

function textOf(cell) {
  return cell && typeof cell === 'object' && !Array.isArray(cell)
    ? formatDisplayValue(cell.text)
    : formatDisplayValue(cell);
}

function styleOf(cell) {
  return cell && typeof cell === 'object' && !Array.isArray(cell) ? cell.style : null;
}

function segmentsOf(cell) {
  return cell && typeof cell === 'object' && Array.isArray(cell.segments) ? cell.segments : null;
}

function writePadded(grid, x, y, value, width, style, align = 'left') {
  if (width <= 0) return;
  const text = padToWidth(stripAnsi(value), width, align);
  grid.write(x, y, text, style, width);
}

function writeSegments(grid, x, y, segments, width, fallbackStyle, pad = true) {
  let used = 0;
  for (const segment of segments || []) {
    if (used >= width) break;
    const text = truncateToWidth(textOf(segment), width - used, { ellipsis: true });
    const segmentWidth = displayWidth(text);
    grid.write(x + used, y, text, mergeStyle(fallbackStyle, styleOf(segment)), segmentWidth);
    if (segment.spinner && segmentWidth > 0) grid.markSpinner(x + used, y);
    used += segmentWidth;
  }
  if (pad && used < width) grid.write(x + used, y, ' '.repeat(width - used), fallbackStyle, width - used);
}

export function paintBox(grid, rect, options = {}) {
  if (rect.width < 2 || rect.height < 2) return;
  const style = options.style || palette.border;
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  grid.set(rect.x, rect.y, CHROME_GLYPHS.cornerTopLeft, style);
  if (options.rightEdge !== false) grid.set(right, rect.y, CHROME_GLYPHS.cornerTopRight, style);
  grid.set(rect.x, bottom, CHROME_GLYPHS.cornerBottomLeft, style);
  if (options.rightEdge !== false) grid.set(right, bottom, CHROME_GLYPHS.cornerBottomRight, style);
  for (let x = rect.x + 1; x < right; x += 1) {
    grid.set(x, rect.y, CHROME_GLYPHS.horizontal, style);
    grid.set(x, bottom, CHROME_GLYPHS.horizontal, style);
  }
  for (let y = rect.y + 1; y < bottom; y += 1) {
    grid.set(rect.x, y, CHROME_GLYPHS.vertical, style);
    if (options.rightEdge !== false) grid.set(right, y, CHROME_GLYPHS.vertical, style);
  }
  if ((options.title || options.loading) && rect.width > 4) {
    const titleStyle = options.titleStyle || palette.paneTitle;
    const available = rect.width - 4;
    const titleSegments = segmentsOf(options.title);
    const segments = titleSegments
      ? [{ text: ' ', style: titleStyle }, ...titleSegments, { text: ' ', style: titleStyle }]
      : [{ text: ` ${normalizeChromePunctuation(textOf(options.title))}`, style: titleStyle }];
    if (options.loading) {
      segments.push({ text: `${CHROME_GLYPHS.separator.trim()} `, style: palette.dim });
      segments.push({ text: options.loadingGlyph || spinnerGlyph(), style: palette.dim, spinner: true });
      segments.push({ text: ' loading ', style: palette.dim });
    } else segments.push({ text: ' ', style: titleStyle });
    writeSegments(grid, rect.x + 2, rect.y, segments, available, style, false);
  }
}

export function paintPane(grid, pane, options = {}) {
  const rect = pane.rect;
  const ownerStyle = pane.style || (pane.content?.kind === 'tile' ? palette.tileSurface : palette.body);
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  if (pane.border !== false) paintBox(grid, rect, {
    title: pane.title,
    loading: pane.loading,
    loadingGlyph: pane.loadingGlyph,
    style: pane.borderStyle,
    titleStyle: pane.titleStyle,
    // Scrollable panes give their complete right edge to the scrollbar
    // painter. The box must not partially own its corners or track cells.
    rightEdge: options.scrollbar !== true
  });
  return paneContentRect(pane, options);
}

export function paintTable(grid, rect, table = {}) {
  const columns = table.columns || [];
  const rows = table.rows || [];
  const rowCount = Math.max(0, Number(table.rowCount ?? rows.length));
  const headerRows = table.header === false ? 0 : 1;
  const visibleRows = Math.max(0, rect.height - headerRows);
  const selected = Math.max(0, Math.min(rowCount - 1, Number(table.selected || 0)));
  const requestedScroll = Math.max(0, Number(table.scroll || 0));
  const scroll = Math.max(0, Math.min(
    Math.max(requestedScroll, selected >= requestedScroll + visibleRows ? selected - visibleRows + 1 : requestedScroll),
    Math.max(0, rowCount - visibleRows)
  ));
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', table.style || palette.body);
  const widths = columns.map((column) => Math.max(1, Number(column.width || 1)));
  if (headerRows) {
    let x = rect.x;
    for (let index = 0; index < columns.length && x < rect.x + rect.width; index += 1) {
      const width = Math.min(widths[index], rect.x + rect.width - x);
      const contentWidth = index < columns.length - 1 ? Math.max(1, width - 1) : width;
      writePadded(grid, x, rect.y, normalizeChromePunctuation(columns[index].title || ''), contentWidth, columns[index].headerStyle || palette.header, columns[index].align);
      if (contentWidth < width) grid.set(x + contentWidth, rect.y, ' ', columns[index].headerStyle || palette.header);
      x += width;
    }
  }
  for (let visual = 0; visual < visibleRows; visual += 1) {
    const rowIndex = scroll + visual;
    const row = rows[rowIndex] || (typeof table.rowAt === 'function' ? table.rowAt(rowIndex) : null);
    if (!row) continue;
    let x = rect.x;
    const y = rect.y + headerRows + visual;
    const rowSelected = rowIndex === selected && table.selection !== false && table.focused !== false;
    const rowBaseStyle = rowSelected ? mergeStyle(row.style, table.rowStyle, palette.selection) : mergeStyle(row.style, table.rowStyle);
    grid.fill(rect.x, y, rect.width + (rowSelected ? 1 : 0), 1, ' ', rowBaseStyle);
    if (rowSelected) grid.set(rect.x - 1, y, CHROME_GLYPHS.selectionBar, palette.selectionBar);
    let availableRight = rect.x + rect.width;
    for (let index = 0; index < columns.length && x < rect.x + rect.width; index += 1) {
      const column = columns[index];
      const width = Math.min(widths[index], availableRight - x);
      const contentWidth = index < columns.length - 1 ? Math.max(1, width - 1) : width;
      const value = Array.isArray(row.cells) ? row.cells[index] : row[column.key];
      const style = rowSelected
        ? mergeStyle(rowBaseStyle, styleOf(value), column.selectedStyle)
        : mergeStyle(row.style, styleOf(value), table.rowStyle);
      const segments = segmentsOf(value);
      if (segments) writeSegments(grid, x, y, segments, contentWidth, style);
      else writePadded(grid, x, y, textOf(value), contentWidth, style, column.align);
      if (contentWidth < width) grid.set(x + contentWidth, y, ' ', style);
      x += width;
    }
  }
  return {
    kind: 'table', scroll, visibleRows, viewportItems: visibleRows, totalItems: rowCount,
    startIndex: rowCount ? scroll : 0,
    endIndex: rowCount ? Math.min(rowCount - 1, scroll + Math.max(0, visibleRows - 1)) : -1,
    follow: false
  };
}

export function tableRowIndexAt(pane, x, y) {
  const rect = pane?.rect;
  const table = pane?.content;
  if (!rect || table?.kind !== 'table') return null;
  const content = paneContentRect(pane, { scrollbar: true });
  if (x < content.x || x >= content.x + content.width) return null;
  const contentY = content.y;
  const headerRows = table.header === false ? 0 : 1;
  const firstRowY = contentY + headerRows;
  const contentHeight = content.height;
  const visibleRows = Math.max(0, contentHeight - headerRows);
  if (y < firstRowY || y >= firstRowY + visibleRows) return null;
  const rows = table.rows || [];
  const rowCount = Math.max(0, Number(table.rowCount ?? rows.length));
  const selected = Math.max(0, Math.min(rowCount - 1, Number(table.selected || 0)));
  const requestedScroll = Math.max(0, Number(table.scroll || 0));
  const scroll = Math.max(0, Math.min(
    Math.max(requestedScroll, selected >= requestedScroll + visibleRows ? selected - visibleRows + 1 : requestedScroll),
    Math.max(0, rowCount - visibleRows)
  ));
  const index = scroll + y - firstRowY;
  return index >= 0 && index < rowCount ? index : null;
}

export function paintTabBar(grid, rect, tabs = [], active = 0) {
  grid.fill(rect.x, rect.y, rect.width, 1, ' ', palette.body);
  let x = rect.x;
  for (let index = 0; index < tabs.length && x < rect.x + rect.width; index += 1) {
    const label = ` ${index + 1} ${normalizeChromePunctuation(textOf(tabs[index]))} `;
    const width = Math.min(displayWidth(label), rect.x + rect.width - x);
    grid.write(x, rect.y, truncateToWidth(label, width, { ellipsis: true }), index === active ? palette.tabActive : palette.tabInactive, width);
    x += width + 1;
  }
}

export function tabIndexAtColumn(tabs = [], column, rect = { x: 0, width: Number.MAX_SAFE_INTEGER }) {
  let x = rect.x || 0;
  const right = x + Math.max(0, Number(rect.width || 0));
  for (let index = 0; index < tabs.length && x < right; index += 1) {
    const width = Math.min(displayWidth(` ${index + 1} ${textOf(tabs[index])} `), right - x);
    if (column >= x && column < x + width) return index;
    x += width + 1;
  }
  return null;
}

export class WrapCache {
  constructor() {
    this.objects = new WeakMap();
    this.primitives = new Map();
    this.formatters = new WeakMap();
    this.nextFormatterId = 1;
    this.lineEstimators = new Map();
    this.arrayLineEstimators = new WeakMap();
    this.wrapCalls = 0;
    this.hits = 0;
    this.misses = 0;
  }

  formatterId(formatter) {
    if (typeof formatter !== 'function') return 0;
    if (!this.formatters.has(formatter)) this.formatters.set(formatter, this.nextFormatterId++);
    return this.formatters.get(formatter);
  }

  wrap(entry, width, formatter = null, wrapper = null) {
    const key = `${Math.max(1, width)}:${this.formatterId(formatter)}:${this.formatterId(wrapper)}`;
    const objectEntry = entry != null && (typeof entry === 'object' || typeof entry === 'function');
    const cache = objectEntry
      ? (this.objects.get(entry) || (this.objects.set(entry, new Map()), this.objects.get(entry)))
      : this.primitives;
    const primitiveKey = objectEntry ? key : `${typeof entry}:${formatDisplayValue(entry)}:${key}`;
    if (cache.has(primitiveKey)) {
      this.hits += 1;
      return cache.get(primitiveKey);
    }
    const value = formatter ? formatter(entry) : textOf(entry);
    const rendered = textOf(value);
    const renderedWrap = wrapper
      ? wrapper(entry, Math.max(1, width), rendered)
      : wrapToWidth(rendered, Math.max(1, width));
    const wrapped = Object.freeze({
      ...renderedWrap,
      lines: Object.freeze([...(renderedWrap.lines || [])]),
      fragments: Object.freeze((renderedWrap.fragments || []).map((fragment) => Object.freeze({ ...fragment })))
    });
    cache.set(primitiveKey, wrapped);
    this.wrapCalls += 1;
    this.misses += 1;
    return wrapped;
  }

  lines(entry, width, formatter = null, wrapper = null) {
    return this.wrap(entry, width, formatter, wrapper).lines;
  }

  fragments(entry, width, formatter = null, wrapper = null) {
    return this.wrap(entry, width, formatter, wrapper).fragments;
  }

  lineEstimator(log, entries, width) {
    const layoutKey = `${Math.max(1, width)}:${this.formatterId(log.formatEntry)}:${this.formatterId(log.wrapEntry)}`;
    const explicit = log.measureKey == null ? null : `${formatDisplayValue(log.measureKey)}:${layoutKey}`;
    let estimators;
    let key;
    if (explicit != null) {
      estimators = this.lineEstimators;
      key = explicit;
    } else {
      estimators = this.arrayLineEstimators.get(entries);
      if (!estimators) {
        estimators = new Map();
        this.arrayLineEstimators.set(entries, estimators);
      }
      key = layoutKey;
    }
    let estimator = estimators.get(key);
    if (!estimator) {
      estimator = new VirtualLineEstimator(entries.length);
      estimators.set(key, estimator);
    } else estimator.sync(entries.length);
    return estimator;
  }

  clear() {
    this.objects = new WeakMap();
    this.primitives.clear();
    this.formatters = new WeakMap();
    this.nextFormatterId = 1;
    this.lineEstimators.clear();
    this.arrayLineEstimators = new WeakMap();
  }
}

class VirtualLineEstimator {
  constructor(totalBlocks) {
    this.reset(totalBlocks);
  }

  reset(totalBlocks) {
    this.totalBlocks = Math.max(0, Math.floor(Number(totalBlocks) || 0));
    this.capacity = 1;
    while (this.capacity < this.totalBlocks) this.capacity *= 2;
    this.counts = new Uint32Array(this.capacity + 1);
    this.sums = new Float64Array(this.capacity + 1);
    this.slots = new Map();
    this.measuredCount = 0;
    this.measuredSum = 0;
    this.estimatedTotal = null;
    this.dirty = true;
  }

  sync(totalBlocks) {
    const total = Math.max(0, Math.floor(Number(totalBlocks) || 0));
    if (total < this.totalBlocks) {
      this.reset(total);
      return;
    }
    if (total > this.capacity) {
      while (this.capacity < total) this.capacity *= 2;
      this.counts = new Uint32Array(this.capacity + 1);
      this.sums = new Float64Array(this.capacity + 1);
      for (const [index, slot] of this.slots) {
        this.updateTree(this.counts, index, 1);
        this.updateTree(this.sums, index, slot.height);
      }
    }
    if (total !== this.totalBlocks) this.dirty = true;
    this.totalBlocks = total;
  }

  updateTree(tree, index, delta) {
    for (let cursor = index + 1; cursor < tree.length; cursor += cursor & -cursor) tree[cursor] += delta;
  }

  prefixTree(tree, end) {
    let value = 0;
    for (let cursor = Math.max(0, Math.min(this.totalBlocks, end)); cursor > 0; cursor -= cursor & -cursor) value += tree[cursor];
    return value;
  }

  observe(index, entry, height) {
    if (index < 0 || index >= this.totalBlocks) return;
    const measured = Math.max(1, Math.floor(Number(height) || 1));
    const previous = this.slots.get(index);
    if (previous?.entry === entry && previous.height === measured) return;
    if (previous) {
      this.updateTree(this.sums, index, measured - previous.height);
      this.measuredSum += measured - previous.height;
    } else {
      this.updateTree(this.counts, index, 1);
      this.updateTree(this.sums, index, measured);
      this.measuredCount += 1;
      this.measuredSum += measured;
    }
    this.slots.set(index, { entry, height: measured });
    this.dirty = true;
  }

  averageHeight() {
    return this.measuredCount ? this.measuredSum / this.measuredCount : 1;
  }

  metrics(position, viewport) {
    const average = this.averageHeight();
    const rawTotal = this.measuredSum + Math.max(0, this.totalBlocks - this.measuredCount) * average;
    if (this.dirty || this.estimatedTotal == null) {
      this.estimatedTotal = Math.max(this.estimatedTotal || 0, rawTotal);
      this.dirty = false;
    }
    const entry = Math.max(0, Math.min(this.totalBlocks, Math.floor(Number(position?.entry) || 0)));
    const measuredBeforeCount = this.prefixTree(this.counts, entry);
    const measuredBeforeSum = this.prefixTree(this.sums, entry);
    const offset = measuredBeforeSum + Math.max(0, entry - measuredBeforeCount) * average + Math.max(0, Math.floor(Number(position?.line) || 0));
    return {
      estimatedTotalLines: Math.max(0, Math.round(this.estimatedTotal || 0)),
      estimatedOffsetLines: Math.max(0, Math.floor(offset)),
      viewportLines: Math.max(0, Math.floor(Number(viewport) || 0)),
      measuredBlocks: this.measuredCount,
      unmeasuredBlocks: Math.max(0, this.totalBlocks - this.measuredCount),
      averageMeasuredHeight: average
    };
  }
}

export const defaultWrapCache = new WrapCache();

export function invalidateWrapCache() {
  defaultWrapCache.clear();
}

function virtualPosition(value, entries, cache, width, formatter, wrapper) {
  if (!entries.length) return { entry: 0, line: 0 };
  const entry = Math.max(0, Math.min(entries.length - 1, Math.floor(Number(value?.entry ?? value ?? 0))));
  const lines = cache.lines(entries[entry], width, formatter, wrapper);
  const line = Math.max(0, Math.min(Math.max(0, lines.length - 1), Math.floor(Number(value?.line || 0))));
  return { entry, line };
}

export function virtualLogBottomPosition(log, width, height, cache = defaultWrapCache) {
  const entries = log.entries || [];
  let needed = Math.max(1, height);
  for (let entry = entries.length - 1; entry >= 0; entry -= 1) {
    const lines = cache.lines(entries[entry], width, log.formatEntry, log.wrapEntry);
    if (lines.length >= needed) return { entry, line: Math.max(0, lines.length - needed) };
    needed -= lines.length;
  }
  return { entry: 0, line: 0 };
}

export function scrollVirtualLog(log, position, delta, width, cache = defaultWrapCache) {
  const entries = log.entries || [];
  if (!entries.length || !delta) return virtualPosition(position, entries, cache, width, log.formatEntry, log.wrapEntry);
  let current = virtualPosition(position, entries, cache, width, log.formatEntry, log.wrapEntry);
  let remaining = Math.abs(Math.trunc(delta));
  const direction = Math.sign(delta);
  while (remaining > 0) {
    const lines = cache.lines(entries[current.entry], width, log.formatEntry, log.wrapEntry);
    if (direction > 0) {
      const available = Math.max(0, lines.length - current.line - 1);
      if (remaining <= available) return { entry: current.entry, line: current.line + remaining };
      remaining -= available + 1;
      if (current.entry >= entries.length - 1) return { entry: current.entry, line: Math.max(0, lines.length - 1) };
      current = { entry: current.entry + 1, line: 0 };
    } else {
      if (remaining <= current.line) return { entry: current.entry, line: current.line - remaining };
      remaining -= current.line + 1;
      if (current.entry <= 0) return { entry: 0, line: 0 };
      const previous = cache.lines(entries[current.entry - 1], width, log.formatEntry, log.wrapEntry);
      current = { entry: current.entry - 1, line: Math.max(0, previous.length - 1) };
    }
  }
  return current;
}

export function compareVirtualPositions(left, right) {
  return Number(left?.entry || 0) - Number(right?.entry || 0) || Number(left?.line || 0) - Number(right?.line || 0);
}

// One follow-state decision for keyboard, page, end, wheel and click paths.
// Selection may be independent from the viewport; in that case the tail is
// followed only when the selected logical block is the final block.
export function settleVirtualFollow(log, position, width, height, options = {}, cache = defaultWrapCache) {
  const bottom = virtualLogBottomPosition(log, width, height, cache);
  const atBottom = compareVirtualPositions(position, bottom) >= 0;
  const last = Math.max(-1, (log.entries?.length || 0) - 1);
  const selectionAtTail = options.selectedEntry == null || Number(options.selectedEntry) >= last;
  return {
    scroll: atBottom ? bottom : position,
    follow: atBottom && selectionAtTail,
    bottom
  };
}

export function virtualSearchPosition(log, hit, width, cache = defaultWrapCache) {
  const entries = log.entries || [];
  if (!entries.length || !hit) return { entry: 0, line: 0 };
  const entry = Math.max(0, Math.min(entries.length - 1, Number(hit.entry || 0)));
  const fragments = cache.fragments(entries[entry], width, log.formatEntry, log.wrapEntry);
  const offset = Math.max(0, Number(hit.offset || 0));
  let line = fragments.findIndex((fragment) => offset >= fragment.start && (offset < fragment.end || fragment.start === fragment.end));
  if (line < 0) line = Math.max(0, fragments.length - 1);
  return { entry, line };
}

function searchRanges(value, query) {
  const lower = formatDisplayValue(value).toLocaleLowerCase();
  const needle = formatDisplayValue(query).toLocaleLowerCase();
  if (!needle) return [];
  const ranges = [];
  let offset = 0;
  while (offset <= lower.length - needle.length) {
    const start = lower.indexOf(needle, offset);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    offset = start + Math.max(1, needle.length);
  }
  return ranges;
}

function fragmentSegments(fragment, ranges, style) {
  if (Array.isArray(fragment.segments)) {
    let offset = Number(fragment.start || 0);
    const result = [];
    for (const raw of fragment.segments) {
      const text = textOf(raw);
      const start = offset;
      const end = start + text.length;
      const matched = ranges.some((range) => range.end > start && range.start < end);
      result.push({ ...raw, text, style: mergeStyle(style, styleOf(raw), matched ? palette.searchMatch : null) });
      offset = end;
    }
    return result;
  }
  const overlaps = ranges
    .map((range) => ({ start: Math.max(fragment.start, range.start), end: Math.min(fragment.end, range.end) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  if (!overlaps.length) return [{ text: fragment.text, style }];
  const sourceText = fragment.sourceText ?? fragment.text;
  const prefix = fragment.prefix || '';
  const segments = [];
  if (prefix) segments.push({ text: prefix, style });
  let cursor = fragment.start;
  for (const range of overlaps) {
    if (range.start > cursor) segments.push({ text: sourceText.slice(cursor - fragment.start, range.start - fragment.start), style });
    segments.push({ text: sourceText.slice(range.start - fragment.start, range.end - fragment.start), style: mergeStyle(style, palette.searchMatch) });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < fragment.end) segments.push({ text: sourceText.slice(cursor - fragment.start), style });
  return segments;
}

function writeSearchLine(grid, x, y, fragment, ranges, width, style) {
  writeSegments(grid, x, y, fragmentSegments(fragment, ranges, style), width, style);
  if (fragment.spinnerChar) {
    const index = formatDisplayValue(fragment.text).indexOf(fragment.spinnerChar);
    if (index >= 0) grid.markSpinner(x + displayWidth(formatDisplayValue(fragment.text).slice(0, index)), y);
  }
}

export function virtualLogLayout(log, width, height, cache = defaultWrapCache) {
  const entries = log.entries || [];
  const lineEstimator = cache.lineEstimator(log, entries, width);
  const overscan = Math.max(2, Number(log.overscan ?? Math.min(12, height)));
  const targetLines = height + overscan;
  const expanded = [];
  let start;
  if (log.follow !== false) {
    let index = entries.length;
    while (index > 0 && expanded.length < targetLines) {
      index -= 1;
      const entry = entries[index];
      const baseStyle = typeof log.styleEntry === 'function' ? log.styleEntry(entry) : styleOf(entry);
      const wrapped = cache.wrap(entry, width, log.formatEntry, log.wrapEntry);
      lineEstimator.observe(index, entry, wrapped.fragments.length);
      const ranges = searchRanges(wrapped.value, log.searchQuery);
      const lines = wrapped.fragments.map((fragment, lineIndex) => ({
        fragment, ranges, entryIndex: index,
        lineIndex,
        style: typeof log.styleLine === 'function' ? log.styleLine(entry, fragment) : baseStyle
      }));
      expanded.unshift(...lines);
    }
    start = { entry: Math.max(0, index), line: 0 };
  } else {
    start = virtualPosition(log.scroll, entries, cache, width, log.formatEntry, log.wrapEntry);
    for (let index = start.entry; index < entries.length && expanded.length < targetLines; index += 1) {
      const entry = entries[index];
      const baseStyle = typeof log.styleEntry === 'function' ? log.styleEntry(entry) : styleOf(entry);
      const wrapped = cache.wrap(entry, width, log.formatEntry, log.wrapEntry);
      lineEstimator.observe(index, entry, wrapped.fragments.length);
      const lines = wrapped.fragments;
      const ranges = searchRanges(wrapped.value, log.searchQuery);
      const offset = index === start.entry ? start.line : 0;
      for (let line = offset; line < lines.length; line += 1) expanded.push({
        fragment: lines[line], ranges, entryIndex: index, lineIndex: line,
        style: typeof log.styleLine === 'function' ? log.styleLine(entry, lines[line]) : baseStyle
      });
    }
  }
  const visible = log.follow !== false ? expanded.slice(Math.max(0, expanded.length - height)) : expanded.slice(0, height);
  const ranges = new Map();
  for (let row = 0; row < visible.length; row += 1) {
    const entry = visible[row].entryIndex;
    const range = ranges.get(entry) || { start: row, end: row };
    range.end = row;
    ranges.set(entry, range);
  }
  const firstVisible = visible.length
    ? { entry: visible[0].entryIndex, line: visible[0].lineIndex }
    : start;
  const lineMetrics = lineEstimator.metrics(firstVisible, height);
  return { entries, expanded, visible, start, ranges, lineMetrics };
}

function paintVirtualLogPane(grid, rect, log, cache) {
  const { entries, visible, start, lineMetrics } = virtualLogLayout(log, rect.width, rect.height, cache);
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', log.style || palette.body);
  for (let index = 0; index < visible.length; index += 1) {
    const line = visible[index];
    const selected = log.focused !== false && Number(log.selectedEntry) === line.entryIndex;
    const style = mergeStyle(line.style || log.lineStyle || palette.body, selected ? palette.selection : null);
    if (selected && rect.width > 0) {
      // The right padding cell shares the selected owner style. This gives a
      // suspect-width grapheme at the content edge a same-style confinement
      // span without allowing it to touch the scrollbar owner.
      grid.set(rect.x + rect.width, rect.y + index, ' ', style);
      grid.set(rect.x - 1, rect.y + index, CHROME_GLYPHS.selectionBar, palette.selectionBar);
      writeSearchLine(grid, rect.x, rect.y + index, line.fragment, line.ranges, rect.width, style);
    } else writeSearchLine(grid, rect.x, rect.y + index, line.fragment, line.ranges, rect.width, style);
  }
  const indices = visible.map((line) => line.entryIndex);
  return {
    kind: 'virtual-log', scroll: start, totalItems: lineMetrics.estimatedTotalLines,
    startIndex: lineMetrics.estimatedOffsetLines,
    endIndex: lineMetrics.estimatedTotalLines
      ? Math.min(lineMetrics.estimatedTotalLines - 1, lineMetrics.estimatedOffsetLines + Math.max(0, visible.length - 1))
      : -1,
    visibleItems: new Set(indices).size,
    viewportItems: lineMetrics.viewportLines,
    lineMetrics,
    follow: log.follow !== false
  };
}

export function virtualLogEntryIndexAt(log, row, width, height, cache = defaultWrapCache) {
  const target = Math.floor(Number(row));
  if (target < 0 || target >= height) return null;
  const visible = virtualLogLayout(log, Math.max(1, width), Math.max(1, height), cache).visible;
  return visible[target]?.entryIndex ?? null;
}

// Keeps a logical entry visible using the exact cached wrapping and line map
// consumed by paint and click hit-testing. This is the sole block-to-display
// mapping used for transcript selection.
export function virtualLogScrollToEntry(log, entryIndex, width, height, cache = defaultWrapCache) {
  const entries = log.entries || [];
  if (!entries.length) return { entry: 0, line: 0 };
  const target = Math.max(0, Math.min(entries.length - 1, Math.floor(Number(entryIndex || 0))));
  const current = virtualLogLayout({ ...log, follow: false }, Math.max(1, width), Math.max(1, height), cache);
  const currentRange = current.ranges.get(target);
  const targetHeight = cache.lines(entries[target], Math.max(1, width), log.formatEntry, log.wrapEntry).length;
  // One header line peeking into the viewport is not enough to identify a
  // selected multi-line block. Keep the current scroll only when all lines
  // that can fit are actually visible; paint/highlight/click then share a
  // useful, not merely nonempty, display range.
  if (currentRange && currentRange.end - currentRange.start + 1 >= Math.min(Math.max(1, height), targetHeight)) return current.start;
  if (target < current.start.entry) return { entry: target, line: 0 };
  let remaining = Math.max(1, height);
  for (let entry = target; entry >= 0; entry -= 1) {
    const lines = cache.lines(entries[entry], Math.max(1, width), log.formatEntry, log.wrapEntry);
    if (lines.length >= remaining) return { entry, line: Math.max(0, lines.length - remaining) };
    remaining -= lines.length;
  }
  return { entry: 0, line: 0 };
}

// Selection is a logical block index; the viewport is derived state. This
// helper deliberately does not infer selection from the scroll position.
// At either selection boundary both values remain stable, while an in-range
// step scrolls only when the selected block is not fully visible.
export function stepVirtualLogSelection(log, selectedEntry, direction, width, height, cache = defaultWrapCache) {
  const entries = log.entries || [];
  const currentScroll = virtualPosition(log.scroll, entries, cache, Math.max(1, width), log.formatEntry, log.wrapEntry);
  if (!entries.length) return { selectedEntry: -1, scroll: currentScroll };
  const current = Math.max(0, Math.min(entries.length - 1, Math.floor(Number(selectedEntry) || 0)));
  const next = Math.max(0, Math.min(entries.length - 1, current + Math.sign(Number(direction) || 0)));
  if (next === current) return { selectedEntry: current, scroll: currentScroll };
  return {
    selectedEntry: next,
    scroll: virtualLogScrollToEntry({ ...log, follow: false, scroll: currentScroll }, next, width, height, cache)
  };
}

export function paintLogPane(grid, rect, log = {}, options = {}) {
  if (log.virtual) return paintVirtualLogPane(grid, rect, log, options.wrapCache || defaultWrapCache);
  const expanded = [];
  for (const raw of log.lines || []) {
    const value = textOf(raw);
    const wrapped = wrapToWidth(value, rect.width);
    const ranges = searchRanges(wrapped.value, log.searchQuery);
    for (const fragment of wrapped.fragments) expanded.push({ fragment, ranges, style: styleOf(raw) });
  }
  const maxScroll = Math.max(0, expanded.length - rect.height);
  const scroll = log.follow !== false ? maxScroll : Math.max(0, Math.min(maxScroll, Number(log.scroll || 0)));
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', log.style || palette.body);
  for (let index = 0; index < rect.height; index += 1) {
    const line = expanded[scroll + index];
    if (!line) continue;
    const style = line.style || log.lineStyle || palette.body;
    writeSearchLine(grid, rect.x, rect.y + index, line.fragment, line.ranges, rect.width, style);
  }
  return {
    kind: 'log', scroll, totalItems: expanded.length, visibleItems: Math.min(rect.height, expanded.length),
    viewportItems: Math.min(rect.height, expanded.length),
    startIndex: expanded.length ? scroll : 0,
    endIndex: expanded.length ? Math.min(expanded.length - 1, scroll + Math.max(0, rect.height - 1)) : -1,
    follow: log.follow !== false
  };
}

export function paintEmptyState(grid, rect, empty = {}) {
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', empty.style || palette.body);
  if (!rect.width || !rect.height) return null;
  const message = `${CHROME_GLYPHS.empty} ${formatDisplayValue(empty.message || 'nothing here')}`;
  const action = formatDisplayValue(empty.action);
  const y = rect.y + Math.max(0, Math.floor((rect.height - (action ? 2 : 1)) / 2));
  const text = truncateToWidth(message, rect.width, { ellipsis: true });
  grid.write(rect.x + Math.max(0, Math.floor((rect.width - displayWidth(text)) / 2)), y, text, empty.messageStyle || palette.empty, displayWidth(text));
  if (action && y + 1 < rect.y + rect.height) {
    const hint = truncateToWidth(action, rect.width, { ellipsis: true });
    grid.write(rect.x + Math.max(0, Math.floor((rect.width - displayWidth(hint)) / 2)), y + 1, hint, empty.actionStyle || palette.dim, displayWidth(hint));
  }
  return { kind: 'empty', totalItems: 0, viewportItems: rect.height, startIndex: 0, endIndex: -1, follow: false };
}

export function paintTile(grid, rect, tile = {}) {
  const ownerStyle = tile.style || palette.tileSurface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  if (!rect.width || !rect.height) return null;
  const valueSegments = segmentsOf(tile.value);
  const value = truncateToWidth(textOf(tile.value), rect.width, { ellipsis: true });
  const label = truncateToWidth(formatDisplayValue(tile.label), rect.width, { ellipsis: true });
  const trendRect = tileTrendRect(rect, tile);
  const detailRect = tileDetailRect(rect, tile);
  const valueY = trendRect || detailRect ? rect.y : rect.y + Math.max(0, Math.floor((rect.height - 2) / 2));
  if (valueSegments) writeSegments(grid, rect.x, valueY, valueSegments, rect.width, mergeStyle(ownerStyle, tile.valueStyle || palette.tileValue));
  else grid.write(rect.x, valueY, value, mergeStyle(ownerStyle, tile.valueStyle || palette.tileValue), rect.width);
  if (valueY + 1 < rect.y + rect.height) grid.write(rect.x, valueY + 1, label, mergeStyle(ownerStyle, tile.labelStyle || palette.tileLabel), rect.width);
  if (trendRect) paintTileTrend(grid, trendRect, tile.trend, ownerStyle);
  else if (detailRect) {
    const detail = truncateToWidth(formatDisplayValue(tile.detail), detailRect.width, { ellipsis: true });
    grid.fill(detailRect.x, detailRect.y, detailRect.width, detailRect.height, ' ', ownerStyle);
    grid.write(detailRect.x, detailRect.y, detail, mergeStyle(ownerStyle, tile.detailStyle || palette.trendLabel), displayWidth(detail));
  }
  return null;
}

export function tileTrendRect(contentRect, tile = {}) {
  if (!tile.trend || contentRect.width <= 0 || contentRect.height < 3) return null;
  return Object.freeze({ x: contentRect.x, y: contentRect.y + 2, width: contentRect.width, height: 1 });
}

export function tileDetailRect(contentRect, tile = {}) {
  if (!tile.detail || contentRect.width <= 0 || contentRect.height < 3) return null;
  return Object.freeze({ x: contentRect.x, y: contentRect.y + 2, width: contentRect.width, height: 1 });
}

function sampleTrendLevels(levels, width) {
  const source = Array.isArray(levels) ? levels : [];
  const count = Math.max(0, Math.floor(Number(width) || 0));
  if (!count || !source.length) return [];
  if (source.length <= count) return [...source];
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * source.length) / count);
    const end = Math.max(start + 1, Math.floor(((index + 1) * source.length) / count));
    return Math.max(...source.slice(start, end));
  });
}

export function paintTileTrend(grid, rect, trend = {}, ownerStyle = palette.tileSurface) {
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  if (!rect.width || !rect.height) return;
  if (trend.kind !== 'sparkline') {
    const placeholder = truncateToWidth(formatDisplayValue(trend.placeholder || 'collecting data (0d)'), rect.width, { ellipsis: true });
    grid.write(rect.x, rect.y, placeholder, mergeStyle(ownerStyle, palette.trendPlaceholder), displayWidth(placeholder));
    return;
  }
  const label = formatDisplayValue(trend.label);
  const maxLabel = formatDisplayValue(trend.maxLabel);
  const fixedWidth = displayWidth(label) + displayWidth(maxLabel) + 2;
  const chartWidth = Math.max(1, rect.width - fixedWidth);
  const chart = sampleTrendLevels(trend.levels, chartWidth)
    .map((level) => CHROME_GLYPHS.spark[Math.max(0, Math.min(7, Math.floor(Number(level) || 0)))])
    .join('');
  writeSegments(grid, rect.x, rect.y, [
    { text: `${label} `, style: palette.trendLabel },
    { text: chart, style: palette.sparkline },
    { text: ` ${maxLabel}`, style: palette.trendLabel }
  ], rect.width, ownerStyle);
}

export function paintTextInput(grid, rect, input = {}) {
  const prompt = `${normalizeChromePunctuation(formatDisplayValue(input.label)) || 'Input'}: `;
  const promptWidth = Math.min(rect.width, displayWidth(prompt));
  grid.fill(rect.x, rect.y, rect.width, 1, ' ', input.style || palette.input);
  grid.write(rect.x, rect.y, truncateToWidth(prompt, promptWidth, { ellipsis: true }), input.labelStyle || palette.inputLabel, promptWidth);
  const inputValue = formatDisplayValue(input.value);
  grid.write(rect.x + promptWidth, rect.y, truncateToWidth(inputValue, rect.width - promptWidth, { ellipsis: true }), input.style || palette.input, rect.width - promptWidth);
  if (rect.width > 0) grid.set(Math.min(rect.x + rect.width - 1, rect.x + promptWidth + displayWidth(inputValue)), rect.y, ' ', mergeStyle(input.style || palette.input, palette.inputCursor));
}

export function paintConfirmPrompt(grid, rect, prompt = {}) {
  const lines = prompt.lines?.length ? prompt.lines.map(formatDisplayValue) : [formatDisplayValue(prompt.message)];
  const widest = lines.reduce((value, line) => Math.max(value, displayWidth(line)), 0);
  const boxWidth = Math.min(rect.width, Math.max(36, Math.min(88, widest + 4)));
  const boxHeight = Math.min(rect.height, Math.max(5, lines.length + 4));
  const x = rect.x + Math.floor((rect.width - boxWidth) / 2);
  const y = rect.y + Math.floor((rect.height - boxHeight) / 2);
  grid.fill(x, y, boxWidth, boxHeight, ' ', palette.body);
  paintBox(grid, { x, y, width: boxWidth, height: boxHeight }, { title: prompt.title || 'Confirm', titleStyle: palette.warningTitle });
  for (let index = 0; index < lines.length && y + 1 + index < y + boxHeight - 2; index += 1) {
    grid.write(x + 2, y + 1 + index, truncateToWidth(lines[index], boxWidth - 4, { ellipsis: true }), prompt.danger ? palette.danger : palette.body, boxWidth - 4);
  }
  paintTextInput(grid, { x: x + 2, y: y + boxHeight - 2, width: boxWidth - 4, height: 1 }, { label: prompt.label || 'Type', value: prompt.value || '' });
}

export function paintHelpOverlay(grid, rect, help = {}) {
  const width = Math.min(rect.width - 2, help.width || 72);
  const height = Math.min(rect.height - 2, Math.max(6, (help.items || []).length + 4));
  const x = rect.x + Math.max(1, Math.floor((rect.width - width) / 2));
  const y = rect.y + Math.max(1, Math.floor((rect.height - height) / 2));
  grid.fill(x, y, width, height, ' ', palette.body);
  paintBox(grid, { x, y, width, height }, { title: help.title || 'Help' });
  let row = y + 1;
  for (const item of help.items || []) {
    if (row >= y + height - 1) break;
    const keyWidth = Math.min(18, Math.max(8, Number(help.keyWidth || 14)));
    writePadded(grid, x + 2, row, item.key, keyWidth, palette.header);
    grid.write(x + 2 + keyWidth + 1, row, truncateToWidth(formatDisplayValue(item.description), width - keyWidth - 5, { ellipsis: true }), palette.body, width - keyWidth - 5);
    row += 1;
  }
}

function paintContent(grid, rect, content = {}, options = {}) {
  if (content.kind === 'empty') return paintEmptyState(grid, rect, content);
  if (content.kind === 'tile') return paintTile(grid, rect, content);
  if (content.kind === 'table') {
    const rowCount = Number(content.rowCount ?? content.rows?.length ?? 0);
    if (!rowCount && content.empty) return paintEmptyState(grid, rect, content.empty);
    return paintTable(grid, rect, { ...content, focused: options.focused });
  }
  if (content.kind === 'log' || content.kind === 'text') {
    const count = content.virtual ? content.entries?.length : content.lines?.length;
    if (!count && content.empty) return paintEmptyState(grid, rect, content.empty);
    return paintLogPane(grid, rect, { ...content, focused: options.focused }, options);
  }
  if (content.kind === 'tabs') return paintTabBar(grid, rect, content.tabs, content.active);
  return null;
}

function scrollReadout(metrics, width) {
  const total = Math.max(0, Number(metrics?.totalItems || 0));
  if (!total) return '0/0';
  const start = Math.max(0, Number(metrics.startIndex || 0));
  const end = Math.max(start, Number(metrics.endIndex ?? start));
  const detailed = `${start + 1}-${Math.min(total, end + 1)}/${total.toLocaleString('en-US')}`;
  if (displayWidth(detailed) <= Math.max(6, Math.floor(width / 3))) return detailed;
  const denominator = Math.max(1, total - 1);
  return `${Math.round((Math.min(total - 1, end) / denominator) * 100)}%`;
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

// The tile band deliberately declares ownership for its complete footprint,
// including the blank row on either side and odd-width remainder columns.
// A tile owns every cell in its pane rect; all other cells in this band belong
// to the dashboard background. This is shared by composition and invariants.
export function dashboardTileBandOwnership(frame) {
  if (frame?.screen !== 'dashboard') return null;
  const regions = (frame.panes || [])
    .filter((pane) => pane.content?.kind === 'tile' && pane.rect?.width > 0 && pane.rect?.height > 0)
    .map((pane) => ({ rect: { ...pane.rect }, owner: 'tileSurface' }));
  if (!regions.length) return null;
  const top = Math.min(...regions.map(({ rect }) => rect.y));
  const bottom = Math.max(...regions.map(({ rect }) => rect.y + rect.height - 1));
  const y = Math.max(0, top - 1);
  const last = Math.min(Number(frame.height || 0) - 1, bottom + 1);
  const sparklineRegions = [];
  for (const pane of frame.panes || []) {
    if (pane.content?.kind !== 'tile') continue;
    const trend = tileTrendRect(paneContentRect(pane), pane.content);
    if (trend) sparklineRegions.push(Object.freeze({ rect: trend, owner: 'tileSurface' }));
  }
  return Object.freeze({
    rect: Object.freeze({ x: 0, y, width: Math.max(0, Number(frame.width || 0)), height: Math.max(0, last - y + 1) }),
    defaultOwner: 'dashboardBg',
    regions: Object.freeze(regions.map((region) => Object.freeze({ rect: Object.freeze(region.rect), owner: region.owner }))),
    sparklineRegions: Object.freeze(sparklineRegions)
  });
}

export function dashboardTileBandOwnerAt(ownership, x, y) {
  if (!ownership) return null;
  const { rect } = ownership;
  if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) return null;
  return ownership.regions.find((region) => x >= region.rect.x && x < region.rect.x + region.rect.width
    && y >= region.rect.y && y < region.rect.y + region.rect.height)?.owner || ownership.defaultOwner;
}

export function scrollbarGeometry({ track: rawTrack, viewport: rawViewport, total: rawTotal, offset: rawOffset, follow = false } = {}) {
  const track = Math.max(0, finiteInteger(rawTrack));
  const total = Math.max(0, finiteInteger(rawTotal));
  const viewport = Math.max(0, finiteInteger(rawViewport));
  if (!track || !total) return { track, viewport, total, maxOffset: Math.max(1, total - viewport), thumbLen: 0, thumbStart: 0 };
  const thumbLen = Math.max(1, Math.min(track, Math.round(track * viewport / total)));
  const maxOffset = Math.max(1, total - viewport);
  const requestedOffset = follow ? maxOffset : Math.max(0, finiteInteger(rawOffset));
  const thumbStart = requestedOffset >= maxOffset
    ? track - thumbLen
    : Math.min(track - thumbLen, Math.floor((track - thumbLen) * requestedOffset / maxOffset));
  return { track, viewport, total, maxOffset, thumbLen, thumbStart };
}

function paintScrollIndicator(grid, pane, contentRect, metrics) {
  if (pane.rect.width < 1 || pane.rect.height < 1) return;
  const total = Math.max(0, Number(metrics?.totalItems || 0));
  const viewport = Math.max(0, Number(metrics?.viewportItems ?? contentRect.height));
  if (pane.border !== false && pane.rect.width > 8) {
    const readout = ` ${scrollReadout(metrics, pane.rect.width)} `;
    const maximum = Math.max(0, pane.rect.width - 4);
    const text = truncateToWidth(readout, maximum, { ellipsis: true });
    const x = Math.max(pane.rect.x + 2, pane.rect.x + pane.rect.width - displayWidth(text) - 2);
    grid.write(x, pane.rect.y, text, pane.borderStyle || palette.border, Math.min(maximum, displayWidth(text)));
  }
  // The scrollbar replaces the complete right pane edge. It is the sole
  // painter for this column, including both border joins, on every frame.
  const x = pane.rect.x + pane.rect.width - 1;
  const bordered = pane.border !== false && pane.rect.height >= 2;
  const top = bordered ? pane.rect.y + 1 : pane.rect.y;
  const bottom = bordered ? pane.rect.y + pane.rect.height - 1 : pane.rect.y + pane.rect.height;
  if (bordered) {
    grid.set(x, pane.rect.y, CHROME_GLYPHS.cornerTopRight, pane.borderStyle || palette.border);
    grid.set(x, pane.rect.y + pane.rect.height - 1, CHROME_GLYPHS.cornerBottomRight, pane.borderStyle || palette.border);
  }
  const height = Math.max(0, bottom - top);
  if (!height) return;
  const trackStyle = pane.borderStyle || palette.scrollTrack;
  for (let row = 0; row < height; row += 1) grid.set(x, top + row, CHROME_GLYPHS.scrollTrack, trackStyle);
  const geometry = scrollbarGeometry({
    track: height,
    viewport,
    total,
    offset: metrics?.startIndex,
    follow: metrics?.follow === true
  });
  for (let row = geometry.thumbStart; row < geometry.thumbStart + geometry.thumbLen; row += 1) grid.set(x, top + row, CHROME_GLYPHS.scrollThumb, palette.scrollThumb);
}

export function paintFrame(frame, options = {}) {
  const grid = new CellGrid(frame.width, frame.height);
  grid.fill(0, 0, frame.width, frame.height, ' ', frame.style || palette.body);
  if (frame.appBar) {
    const appBarStyle = frame.appBar.style || palette.bar;
    grid.fill(0, 0, frame.width, 1, ' ', appBarStyle);
    if (frame.height > 1) grid.fill(0, 1, frame.width, 1, ' ', frame.style || palette.body);
    const product = formatDisplayValue(frame.appBar.product || 'delegate');
    const breadcrumbParts = (frame.appBar.breadcrumb || []).map(formatDisplayValue).filter(Boolean);
    const breadcrumb = breadcrumbParts.length ? `${CHROME_GLYPHS.separator}${breadcrumbParts.join(CHROME_GLYPHS.separator)}` : '';
    const center = formatDisplayValue(frame.appBar.center);
    const productWidth = Math.min(displayWidth(product), Math.max(0, Math.floor(frame.width / 5)));
    grid.write(1, 0, truncateToWidth(product, productWidth, { ellipsis: true }), mergeStyle(appBarStyle, palette.screenTitle), productWidth);
    if (breadcrumb) {
      const maximum = Math.max(0, Math.floor(frame.width / 3));
      const value = truncateToWidth(breadcrumb, maximum, { ellipsis: true });
      const x = Math.min(frame.width - displayWidth(value), 1 + productWidth);
      grid.write(x, 0, value, mergeStyle(appBarStyle, palette.dim), displayWidth(value));
    }
    if ((center || frame.appBar.centerSegments) && frame.width >= 56) {
      const maximum = Math.max(0, Math.floor(frame.width / 3));
      const segments = frame.appBar.centerSegments;
      const value = truncateToWidth(center || segments.map(textOf).join(''), maximum, { ellipsis: true });
      const x = Math.max(1, Math.floor((frame.width - displayWidth(value)) / 2));
      if (segments) writeSegments(grid, x, 0, segments, maximum, mergeStyle(appBarStyle, frame.appBar.centerStyle || palette.dim));
      else grid.write(x, 0, value, mergeStyle(appBarStyle, frame.appBar.centerStyle || palette.dim), displayWidth(value));
    }
    const chips = frame.appBar.chips || [];
    let right = frame.width - 1;
    for (let index = chips.length - 1; index >= 0; index -= 1) {
      const chip = chips[index];
      const text = ` ${formatDisplayValue(chip.text)} `;
      const width = displayWidth(text);
      right -= width;
      if (right <= Math.floor(frame.width / 2)) break;
      grid.write(right, 0, text, mergeStyle(appBarStyle, palette.pill, chip.style), width);
      right -= 1;
    }
  } else if (frame.title) {
    let titleWidth = frame.width - 2;
    let right = '';
    let rightX = frame.width - 1;
    if (frame.title.right) {
      right = truncateToWidth(normalizeChromePunctuation(formatDisplayValue(frame.title.right)), Math.floor(frame.width / 2), { ellipsis: true });
      rightX = Math.max(1, frame.width - displayWidth(right) - 1);
      titleWidth = Math.max(0, rightX - 2);
    }
    const titleText = frame.title && typeof frame.title === 'object' ? frame.title.text : frame.title;
    grid.write(1, 0, truncateToWidth(normalizeChromePunctuation(formatDisplayValue(titleText)), titleWidth, { ellipsis: true }), frame.title.style || palette.screenTitle, titleWidth);
    if (right) grid.write(rightX, 0, right, frame.title.rightStyle || palette.dim, displayWidth(right));
  }
  if (frame.tabs) paintTabBar(grid, frame.tabs.rect, frame.tabs.items, frame.tabs.active);
  const panes = frame.panes || [];
  const tileBandOwnership = dashboardTileBandOwnership(frame);
  if (tileBandOwnership) {
    const { rect, defaultOwner } = tileBandOwnership;
    grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', palette[defaultOwner]);
  }
  const focusable = panes.map((pane, index) => ({ pane, index })).filter(({ pane }) => pane.focusable !== false);
  const fallbackFocus = focusable[Math.max(0, Math.min(focusable.length - 1, Number(frame.focusedPane || 0)))]?.index ?? 0;
  for (let paneIndex = 0; paneIndex < panes.length; paneIndex += 1) {
    const pane = panes[paneIndex];
    const focused = pane.focused ?? paneIndex === fallbackFocus;
    const dashboardTile = frame.screen === 'dashboard' && pane.content?.kind === 'tile';
    // Border chrome is semantic, not frame-owned data: always resolve it from
    // the live palette at paint time so a frame created around preference
    // loading cannot retain a stale theme object.
    const decorated = {
      ...pane,
      style: dashboardTile ? palette.tileSurface : pane.style,
      borderStyle: dashboardTile ? palette.tileBorder : focused ? palette.focusBorder : palette.border
    };
    const scrollable = ['table', 'log', 'text'].includes(pane.content?.kind);
    const contentRect = paintPane(grid, decorated, { scrollbar: scrollable });
    const metrics = paintContent(grid, contentRect, pane.content, { ...options, focused });
    if (scrollable) paintScrollIndicator(grid, decorated, contentRect, metrics);
  }
  if (frame.status) {
    const y = frame.height - 1;
    grid.fill(0, y, frame.width, 1, ' ', frame.status.style || palette.bar);
    let statusWidth = frame.width - 2;
    let right = '';
    let rightX = frame.width - 1;
    if (frame.status.right) {
      right = truncateToWidth(formatDisplayValue(frame.status.right), Math.floor(frame.width / 2), { ellipsis: true });
      rightX = Math.max(1, frame.width - displayWidth(right) - 1);
      statusWidth = Math.max(0, rightX - 2);
    }
    if (frame.status.hints) {
      const segments = [];
      for (let groupIndex = 0; groupIndex < frame.status.hints.length; groupIndex += 1) {
        if (groupIndex) segments.push({ text: CHROME_GLYPHS.separator, style: palette.dim });
        for (const hint of frame.status.hints[groupIndex]) {
          segments.push({ text: `${formatDisplayValue(hint.key)} `, style: palette.keyHint });
          segments.push({ text: `${formatDisplayValue(hint.label)} `, style: palette.dim });
        }
      }
      writeSegments(grid, 1, y, segments, statusWidth, frame.status.style || palette.bar);
    } else if (frame.status.segments) writeSegments(grid, 1, y, frame.status.segments, statusWidth, frame.status.style || palette.bar);
    else grid.write(1, y, truncateToWidth(formatDisplayValue(frame.status.text), statusWidth, { ellipsis: true }), frame.status.style || palette.bar, statusWidth);
    if (right) grid.write(rightX, y, right, frame.status.style || palette.bar, displayWidth(right));
  }
  if (frame.overlay?.kind === 'help') paintHelpOverlay(grid, { x: 0, y: 0, width: frame.width, height: frame.height }, frame.overlay);
  if (frame.overlay?.kind === 'input') paintTextInput(grid, { x: 1, y: frame.height - 2, width: frame.width - 2, height: 1 }, frame.overlay);
  if (frame.overlay?.kind === 'confirm') paintConfirmPrompt(grid, { x: 0, y: 0, width: frame.width, height: frame.height }, frame.overlay);
  return grid;
}

export function renderFrameToString(frame, options = {}) {
  return renderGridToString(paintFrame(frame, options), options);
}

export { palette };
