import { CellGrid, renderGridToString } from './screen.mjs';
import { formatDisplayValue } from './display.mjs';
import { CHROME_GLYPHS, normalizeChromePunctuation, spinnerGlyph } from './glyphs.mjs';
import { displayWidth, padToWidth, stripAnsi, truncateToWidth, wrapToWidth } from './width.mjs';
import { uiPalette as palette } from './palette.mjs';
import { SPACE } from './rhythm.mjs';

function mergeStyle(...styles) {
  return Object.assign({}, ...styles.filter(Boolean));
}

function inner(rect) {
  return {
    x: rect.x + SPACE.paneColumn,
    y: rect.y + SPACE.paneRow,
    width: Math.max(0, rect.width - SPACE.paneColumn * 2),
    height: Math.max(0, rect.height - SPACE.paneRow * 2)
  };
}

function summaryRows(summary) {
  if (summary == null) return [];
  if (summary && typeof summary === 'object' && Array.isArray(summary.rows)) return summary.rows.filter((row) => row != null);
  return [summary];
}

function summaryHeight(summary, available) {
  return Math.min(Math.max(0, Number(available || 0)), summaryRows(summary).length);
}

// This is the sole pane-to-display mapping. Selection scrolling, click hit
// testing, wrapping, highlighting, and painting must all use this exact rect.
export function paneContentRect(pane, options = {}) {
  const rect = pane.rect;
  const base = pane.border !== false ? inner(rect) : {
    x: rect.x + SPACE.railGap,
    y: rect.y,
    width: Math.max(0, rect.width - SPACE.paneColumn),
    height: rect.height
  };
  const padded = pane.border === false && options.scrollbar === true && base.width > SPACE.scrollbarMargin
    ? { ...base, width: base.width - SPACE.scrollbarMargin }
    : base;
  const height = summaryHeight(pane.summary, padded.height);
  if (!height) return padded;
  return { ...padded, y: padded.y + height, height: Math.max(0, padded.height - height) };
}

export function paneSummaryRect(pane, options = {}) {
  if (!pane?.summary) return null;
  const withoutSummary = paneContentRect({ ...pane, summary: null }, options);
  const height = summaryHeight(pane.summary, withoutSummary.height);
  if (!height) return null;
  return { x: withoutSummary.x, y: withoutSummary.y, width: withoutSummary.width, height };
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

function writeKeyParts(grid, x, y, parts, width, ownerStyle, options = {}) {
  let used = 0;
  for (const part of parts || []) {
    if (used >= width) break;
    const text = truncateToWidth(formatDisplayValue(part.text), width - used);
    const partWidth = displayWidth(text);
    const keyStyle = options.dim
      ? mergeStyle(ownerStyle, palette.dim)
      : mergeStyle(ownerStyle, part.kind === 'separator' ? palette.dim : palette.keyHint);
    grid.write(x + used, y, text, keyStyle, partWidth);
    used += partWidth;
  }
  if (used < width) grid.write(x + used, y, ' '.repeat(width - used), ownerStyle, width - used);
  return used;
}

function writeHelpKeyCaps(grid, x, y, item, width, ownerStyle) {
  const parts = item.keys || [];
  const notation = formatDisplayValue(item.notation || parts.map((part) => part.text).join(''));
  const capValues = item.relation === 'chord' || !parts.some((part) => part.kind === 'separator')
    ? [notation]
    : parts.filter((part) => part.kind === 'key').map((part) => formatDisplayValue(part.text));
  const separator = item.relation === 'range' ? ` ${CHROME_GLYPHS.truncation} ` : ' ';
  let used = 0;
  for (let index = 0; index < capValues.length && used < width; index += 1) {
    if (index) {
      const between = truncateToWidth(separator, width - used);
      grid.write(x + used, y, between, mergeStyle(ownerStyle, palette.dim), displayWidth(between));
      used += displayWidth(between);
    }
    const cap = truncateToWidth(` ${capValues[index]} `, width - used);
    const capWidth = displayWidth(cap);
    grid.write(x + used, y, cap, mergeStyle(ownerStyle, palette.keyCap), capWidth);
    used += capWidth;
  }
  if (used < width) grid.write(x + used, y, ' '.repeat(width - used), ownerStyle, width - used);
}

function paintOverlayScrim(grid, rect) {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width;) {
      const current = grid.get(x, y);
      if (!current) break;
      if (current.continuation) {
        x += 1;
        continue;
      }
      const width = Math.max(1, displayWidth(current.char));
      const scrim = current.style?.bg
        ? mergeStyle(palette.scrim, { bg: current.style.bg })
        : palette.scrim;
      grid.set(x, y, current.char || ' ', mergeStyle(current.style, scrim));
      x += width;
    }
  }
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
  const ownerStyle = pane.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  if (pane.border !== false && rect.width > 0 && rect.height > 0) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      grid.set(rect.x, y, CHROME_GLYPHS.paneRail, mergeStyle(ownerStyle, pane.railStyle || palette.borderSubtle));
    }
    if ((pane.title || pane.loading) && rect.width > SPACE.paneColumn * 2) {
      const available = Math.max(0, rect.width - SPACE.paneColumn * 2);
      const titleStyle = mergeStyle(ownerStyle, pane.titleStyle || palette.paneTitle);
      const titleSegments = segmentsOf(pane.title);
      const segments = titleSegments
        ? [...titleSegments]
        : [{ text: normalizeChromePunctuation(textOf(pane.title)), style: titleStyle }];
      if (pane.loading) {
        segments.push({ text: CHROME_GLYPHS.separator, style: mergeStyle(ownerStyle, palette.dim) });
        segments.push({ text: pane.loadingGlyph || spinnerGlyph(), style: mergeStyle(ownerStyle, palette.dim), spinner: true });
        segments.push({ text: ' loading', style: mergeStyle(ownerStyle, palette.dim) });
      }
      writeSegments(grid, rect.x + SPACE.paneColumn, rect.y, segments, available, titleStyle);
    }
  }
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
  const ownerStyle = table.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  const widths = columns.map((column) => Math.max(1, Number(column.width || 1)));
  if (headerRows) {
    let x = rect.x;
    for (let index = 0; index < columns.length && x < rect.x + rect.width; index += 1) {
      const width = Math.min(widths[index], rect.x + rect.width - x);
      const contentWidth = index < columns.length - 1 ? Math.max(1, width - SPACE.tableColumn) : width;
      const headerStyle = mergeStyle(ownerStyle, columns[index].headerStyle || palette.header);
      writePadded(grid, x, rect.y, normalizeChromePunctuation(columns[index].title || ''), contentWidth, headerStyle, columns[index].align);
      if (contentWidth < width) grid.fill(x + contentWidth, rect.y, width - contentWidth, 1, ' ', headerStyle);
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
    const rowBaseStyle = rowSelected
      ? mergeStyle(ownerStyle, row.style, table.rowStyle, palette.selection)
      : mergeStyle(ownerStyle, row.style, table.rowStyle);
    grid.fill(rect.x, y, rect.width, 1, ' ', rowBaseStyle);
    if (rowSelected) grid.set(rect.x - 1, y, CHROME_GLYPHS.selectionBar, mergeStyle(ownerStyle, palette.selectionBar));
    let availableRight = rect.x + rect.width;
    for (let index = 0; index < columns.length && x < rect.x + rect.width; index += 1) {
      const column = columns[index];
      const width = Math.min(widths[index], availableRight - x);
      const contentWidth = index < columns.length - 1 ? Math.max(1, width - SPACE.tableColumn) : width;
      const value = Array.isArray(row.cells) ? row.cells[index] : row[column.key];
      const style = rowSelected
        ? mergeStyle(rowBaseStyle, styleOf(value), column.selectedStyle)
        : mergeStyle(ownerStyle, row.style, styleOf(value), table.rowStyle);
      const segments = segmentsOf(value);
      if (segments) writeSegments(grid, x, y, segments, contentWidth, style);
      else writePadded(grid, x, y, textOf(value), contentWidth, style, column.align);
      if (contentWidth < width) grid.fill(x + contentWidth, y, width - contentWidth, 1, ' ', style);
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

export function humanizeKey(value) {
  return formatDisplayValue(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function keyValueMissing(value) {
  return value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value));
}

function keyValueText(value) {
  if (keyValueMissing(value)) return CHROME_GLYPHS.nullValue;
  return formatDisplayValue(value, { maxLength: 16_384 });
}

function keyValueSections(content) {
  if (Array.isArray(content.sections)) return content.sections;
  return [{ label: content.label || 'Details', rows: content.rows || [] }];
}

export function keyValueLabelWidth(content = {}) {
  let maximum = 0;
  for (const section of keyValueSections(content)) {
    for (const row of section?.rows || []) maximum = Math.max(maximum, displayWidth(humanizeKey(row?.key)));
  }
  return Math.max(14, Math.min(22, Number(content.labelWidth || maximum || 14)));
}

function keyValueLayout(content = {}) {
  const lines = [];
  const sectionGap = Math.max(0, Math.min(SPACE.section, Number(content.sectionGap ?? SPACE.section)));
  const sections = keyValueSections(content);
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex] || {};
    if (sectionGap) lines.push({ kind: 'gap', sectionIndex });
    lines.push({ kind: 'header', section, sectionIndex });
    for (const row of section.rows || []) lines.push({ kind: 'row', row, section, sectionIndex });
  }
  return { sections, lines };
}

function keyValueScroll(content, lines, height) {
  const selectedSection = Number.isInteger(content.selectedSection) ? content.selectedSection : -1;
  let requestedScroll = Math.max(0, Number(content.scroll || 0));
  if (selectedSection >= 0) {
    const start = lines.findIndex((line) => line.sectionIndex === selectedSection && line.kind === 'header');
    let end = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].sectionIndex !== selectedSection) continue;
      end = index;
      break;
    }
    if (start >= 0 && start < requestedScroll) requestedScroll = start;
    else if (end >= requestedScroll + height) requestedScroll = Math.max(0, end - height + 1);
  }
  return Math.max(0, Math.min(Math.max(0, lines.length - height), requestedScroll));
}

function keyValueCopy(row, value, available) {
  if (row?.copy === false || keyValueMissing(row?.value)) return false;
  if (row?.copy === true) return true;
  const key = humanizeKey(row?.key);
  return /(?:\bid\b|path|cwd|command|hash|origin|checkpoint|packet|prompt)/.test(key)
    || displayWidth(value) > Math.max(24, Math.floor(available * 0.72));
}

export function paintKeyValue(grid, rect, content = {}) {
  const ownerStyle = content.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  const { lines } = keyValueLayout(content);
  const labelWidth = Math.min(keyValueLabelWidth(content), Math.max(1, rect.width - SPACE.tableColumn - 1));
  const selectedSection = Number.isInteger(content.selectedSection) ? content.selectedSection : -1;
  const scroll = keyValueScroll(content, lines, rect.height);
  for (let visual = 0; visual < rect.height; visual += 1) {
    const line = lines[scroll + visual];
    if (!line) continue;
    const y = rect.y + visual;
    const selected = line.sectionIndex === selectedSection && content.focused !== false;
    const lineStyle = selected ? mergeStyle(ownerStyle, palette.selection) : ownerStyle;
    if (selected) {
      grid.fill(rect.x, y, rect.width, 1, ' ', lineStyle);
      if (line.kind === 'header') grid.set(rect.x - 1, y, CHROME_GLYPHS.selectionBar, mergeStyle(ownerStyle, palette.selectionBar));
    }
    if (line.kind === 'gap') continue;
    if (line.kind === 'header') {
      const label = humanizeKey(line.section.label || 'Details').toUpperCase();
      const badge = line.section.badge;
      const badgeText = badge ? formatDisplayValue(badge.text ?? badge) : '';
      const badgeWidth = Math.min(displayWidth(badgeText), Math.max(0, Math.floor(rect.width / 2)));
      const labelWidthAvailable = Math.max(0, rect.width - badgeWidth - (badgeText ? SPACE.railGap : 0));
      grid.write(rect.x, y, truncateToWidth(label, labelWidthAvailable, { ellipsis: true }), mergeStyle(lineStyle, palette.dim), labelWidthAvailable);
      if (badgeText) {
        const x = rect.x + rect.width - badgeWidth;
        grid.write(x, y, truncateToWidth(badgeText, badgeWidth, { ellipsis: true }), mergeStyle(lineStyle, badge.style || palette.badgeWarn), badgeWidth);
      }
      continue;
    }
    const row = line.row || {};
    const value = keyValueText(row.value);
    const valueX = rect.x + labelWidth + SPACE.tableColumn;
    const available = Math.max(0, rect.x + rect.width - valueX);
    const copy = keyValueCopy(row, value, available);
    const valueWidth = Math.max(0, available - (copy ? SPACE.tableColumn : 0));
    writePadded(grid, rect.x, y, humanizeKey(row.key), labelWidth, mergeStyle(lineStyle, palette.dim));
    const valueStyle = mergeStyle(lineStyle, keyValueMissing(row.value) ? palette.dim : styleOf(row.value) || row.style || palette.body);
    const segments = segmentsOf(row.value);
    if (segments) writeSegments(grid, valueX, y, segments, valueWidth, valueStyle);
    else writePadded(grid, valueX, y, value, valueWidth, valueStyle);
    if (copy && available > 0) grid.set(rect.x + rect.width - 1, y, CHROME_GLYPHS.copyAffordance, mergeStyle(lineStyle, palette.dim));
  }
  return {
    kind: 'key-value', scroll, totalItems: lines.length,
    visibleItems: Math.min(rect.height, lines.length),
    viewportItems: Math.min(rect.height, lines.length),
    startIndex: lines.length ? scroll : 0,
    endIndex: lines.length ? Math.min(lines.length - 1, scroll + Math.max(0, rect.height - 1)) : -1,
    follow: false,
    labelWidth
  };
}

export function keyValueSectionIndexAt(pane, x, y) {
  if (pane?.content?.kind !== 'key-value') return null;
  const rect = paneContentRect(pane, { scrollbar: true });
  if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) return null;
  const { lines } = keyValueLayout(pane.content);
  const scroll = keyValueScroll(pane.content, lines, rect.height);
  return lines[scroll + y - rect.y]?.sectionIndex ?? null;
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
  // The strip labels the pane immediately below it and owns the same tinted
  // surface. Accent + underline remain the active-state vocabulary; the
  // background is continuity, not the only selection cue.
  grid.fill(rect.x, rect.y, rect.width, 1, ' ', palette.surfaceRaised);
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
  const ownerStyle = log.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  for (let index = 0; index < visible.length; index += 1) {
    const line = visible[index];
    const selected = log.focused !== false && Number(log.selectedEntry) === line.entryIndex;
    const style = mergeStyle(ownerStyle, line.style || log.lineStyle || palette.body, selected ? palette.selection : null);
    if (selected && rect.width > 0) {
      // The right padding cell shares the selected owner style. This gives a
      // suspect-width grapheme at the content edge a same-style confinement
      // span without allowing it to touch the scrollbar owner.
      grid.set(rect.x + rect.width, rect.y + index, ' ', style);
      grid.set(rect.x - 1, rect.y + index, CHROME_GLYPHS.selectionBar, mergeStyle(ownerStyle, palette.selectionBar));
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
  const ownerStyle = log.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  for (let index = 0; index < rect.height; index += 1) {
    const line = expanded[scroll + index];
    if (!line) continue;
    const style = mergeStyle(ownerStyle, line.style || log.lineStyle || palette.body);
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

export function paintRail(grid, rect, rail = {}, options = {}) {
  const metrics = paintVirtualLogPane(grid, rect, { ...rail, virtual: true }, options.wrapCache || defaultWrapCache);
  return { ...metrics, kind: 'rail' };
}

function searchedSegments(segments, ranges) {
  let offset = 0;
  return segments.map((segment) => {
    const text = textOf(segment);
    const start = offset;
    const end = start + text.length;
    offset = end;
    const matched = ranges.some((range) => range.end > start && range.start < end);
    return matched ? { ...segment, text, style: mergeStyle(styleOf(segment), palette.searchMatch) } : { ...segment, text };
  });
}

function diffChangeSegments(row, rowStyle) {
  const marker = row.kind === 'added' ? '+' : '-';
  const emphasis = row.kind === 'added' ? palette.diffAddedEmphasis : palette.diffRemovedEmphasis;
  const dim = row.kind === 'added' ? palette.diffAddedDim : palette.diffRemovedDim;
  const content = formatDisplayValue(row.content);
  const span = row.changeSpan;
  if (!span) return [{ text: marker, style: mergeStyle(rowStyle, emphasis) }, { text: content, style: mergeStyle(rowStyle, emphasis) }];
  const prefix = content.slice(0, span.prefix);
  const changed = content.slice(span.prefix, span.changedEnd);
  const suffix = content.slice(span.changedEnd);
  return [
    { text: marker, style: mergeStyle(rowStyle, emphasis) },
    ...(prefix ? [{ text: prefix, style: mergeStyle(rowStyle, dim) }] : []),
    ...(changed ? [{ text: changed, style: mergeStyle(rowStyle, emphasis) }] : []),
    ...(suffix ? [{ text: suffix, style: mergeStyle(rowStyle, dim) }] : [])
  ];
}

function paintDiffGutter(grid, rect, y, row, rowStyle) {
  const numberWidth = Math.max(3, Math.min(7, Number(row.numberWidth || 3)));
  const oldText = row.oldLine == null ? '' : formatDisplayValue(row.oldLine);
  const newText = row.newLine == null ? '' : formatDisplayValue(row.newLine);
  writePadded(grid, rect.x, y, oldText, numberWidth, mergeStyle(rowStyle, palette.dim), 'right');
  writePadded(grid, rect.x + numberWidth + 1, y, newText, numberWidth, mergeStyle(rowStyle, palette.dim), 'right');
  const separatorX = rect.x + numberWidth * 2 + 2;
  grid.set(separatorX, y, CHROME_GLYPHS.diffSeparator, mergeStyle(rowStyle, palette.dim));
  return separatorX + SPACE.tableColumn;
}

export function paintDiffLine(grid, rect, diff = {}, options = {}) {
  const cache = options.wrapCache || defaultWrapCache;
  const { entries, visible, start, lineMetrics } = virtualLogLayout({ ...diff, virtual: true }, rect.width, rect.height, cache);
  const ownerStyle = diff.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  for (let visual = 0; visual < visible.length; visual += 1) {
    const line = visible[visual];
    const row = entries[line.entryIndex] || {};
    const y = rect.y + visual;
    if (row.kind === 'file-band') {
      const bandStyle = mergeStyle(ownerStyle, palette.borderSubtle);
      grid.fill(rect.x, y, rect.width, 1, ' ', bandStyle);
      const measure = `+${formatDisplayValue(row.additions || 0)} ${CHROME_GLYPHS.minus}${formatDisplayValue(row.deletions || 0)}`;
      const measureWidth = Math.min(displayWidth(measure), Math.max(0, Math.floor(rect.width / 3)));
      const pathWidth = Math.max(0, rect.width - measureWidth - (measureWidth ? SPACE.tableColumn : 0));
      grid.write(rect.x, y, truncateToWidth(formatDisplayValue(row.path), pathWidth, { ellipsis: true }), mergeStyle(bandStyle, palette.paneTitle), pathWidth);
      if (measureWidth) grid.write(rect.x + rect.width - measureWidth, y, measure, mergeStyle(bandStyle, palette.metadata), measureWidth);
      continue;
    }
    const rowStyle = row.kind === 'added' ? mergeStyle(ownerStyle, palette.diffAddedRow)
      : row.kind === 'removed' ? mergeStyle(ownerStyle, palette.diffRemovedRow)
        : ownerStyle;
    grid.fill(rect.x, y, rect.width, 1, ' ', rowStyle);
    const contentX = paintDiffGutter(grid, rect, y, row, rowStyle);
    const available = Math.max(0, rect.x + rect.width - contentX);
    if (!available) continue;
    let segments;
    if (row.kind === 'added' || row.kind === 'removed') segments = diffChangeSegments(row, rowStyle);
    else if (row.kind === 'hunk') segments = [
      { text: `${CHROME_GLYPHS.railSystem} `, style: mergeStyle(rowStyle, palette.hunk) },
      { text: formatDisplayValue(row.symbol || 'changed lines'), style: mergeStyle(rowStyle, palette.hunk) }
    ];
    else if (row.kind === 'header') segments = [{ text: formatDisplayValue(row.raw), style: mergeStyle(rowStyle, palette.diffHeader) }];
    else if (row.kind === 'meta') segments = [{ text: formatDisplayValue(row.raw), style: mergeStyle(rowStyle, palette.dim) }];
    else segments = [{ text: ` ${formatDisplayValue(row.content ?? row.raw)}`, style: mergeStyle(rowStyle, palette.body) }];
    writeSegments(grid, contentX, y, searchedSegments(segments, line.ranges || []), available, rowStyle);
  }
  return {
    kind: 'diff', scroll: start, totalItems: lineMetrics.estimatedTotalLines,
    startIndex: lineMetrics.estimatedOffsetLines,
    endIndex: lineMetrics.estimatedTotalLines
      ? Math.min(lineMetrics.estimatedTotalLines - 1, lineMetrics.estimatedOffsetLines + Math.max(0, visible.length - 1))
      : -1,
    visibleItems: visible.length,
    viewportItems: lineMetrics.viewportLines,
    lineMetrics,
    follow: false
  };
}

export function paintSummaryStrip(grid, rect, summary = {}, ownerStyle = palette.surface) {
  if (!rect || !rect.width || !rect.height) return;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  const rows = summaryRows(summary);
  for (let row = 0; row < Math.min(rect.height, rows.length); row += 1) {
    const source = typeof rows[row] === 'string' ? { text: rows[row] } : rows[row] || {};
    const style = mergeStyle(ownerStyle, source.style || palette.metadata);
    const badge = source.badge;
    const badgeText = badge ? formatDisplayValue(badge.text ?? badge) : '';
    const badgeWidth = Math.min(displayWidth(badgeText), Math.max(0, Math.floor(rect.width / 2)));
    const width = Math.max(0, rect.width - badgeWidth - (badgeText ? SPACE.tableColumn : 0));
    const y = rect.y + row;
    if (Array.isArray(source.segments)) writeSegments(grid, rect.x, y, source.segments, width, style);
    else grid.write(rect.x, y, truncateToWidth(formatDisplayValue(source.text), width, { ellipsis: true }), style, width);
    if (badgeWidth) {
      grid.write(
        rect.x + rect.width - badgeWidth,
        y,
        truncateToWidth(badgeText, badgeWidth, { ellipsis: true }),
        mergeStyle(ownerStyle, badge.style || palette.badgeWarn),
        badgeWidth
      );
    }
  }
}

export function paintEmptyState(grid, rect, empty = {}) {
  const ownerStyle = empty.style || palette.surface;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', ownerStyle);
  if (!rect.width || !rect.height) return null;
  const message = `${CHROME_GLYPHS.empty} ${formatDisplayValue(empty.message || 'nothing here')}`;
  const action = formatDisplayValue(empty.action);
  const y = rect.y + Math.max(0, Math.floor((rect.height - (action ? 2 : 1)) / 2));
  const text = truncateToWidth(message, rect.width, { ellipsis: true });
  grid.write(rect.x + Math.max(0, Math.floor((rect.width - displayWidth(text)) / 2)), y, text, mergeStyle(ownerStyle, empty.messageStyle || palette.empty), displayWidth(text));
  if (action && y + 1 < rect.y + rect.height) {
    const hint = truncateToWidth(action, rect.width, { ellipsis: true });
    grid.write(rect.x + Math.max(0, Math.floor((rect.width - displayWidth(hint)) / 2)), y + 1, hint, mergeStyle(ownerStyle, empty.actionStyle || palette.dim), displayWidth(hint));
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
  grid.fill(x, y, boxWidth, boxHeight, ' ', palette.surfaceOverlay);
  paintBox(grid, { x, y, width: boxWidth, height: boxHeight }, {
    title: prompt.title || 'Confirm',
    titleStyle: mergeStyle(palette.surfaceOverlay, palette.warningTitle),
    style: mergeStyle(palette.surfaceOverlay, palette.borderActive)
  });
  for (let index = 0; index < lines.length && y + 1 + index < y + boxHeight - 2; index += 1) {
    grid.write(
      x + SPACE.overlayColumn,
      y + SPACE.overlayRow + index,
      truncateToWidth(lines[index], boxWidth - SPACE.overlayColumn * 2, { ellipsis: true }),
      mergeStyle(palette.surfaceOverlay, prompt.danger ? palette.danger : palette.body),
      boxWidth - SPACE.overlayColumn * 2
    );
  }
  paintTextInput(grid, {
    x: x + SPACE.overlayColumn,
    y: y + boxHeight - SPACE.overlayColumn,
    width: boxWidth - SPACE.overlayColumn * 2,
    height: SPACE.overlayRow
  }, { label: prompt.label || 'Type', value: prompt.value || '' });
}

export function paintHelpOverlay(grid, rect, help = {}) {
  paintOverlayScrim(grid, rect);
  const pages = help.pages || [];
  const pageIndex = Math.max(0, Math.min(pages.length - 1, Number(help.page || 0)));
  const page = pages[pageIndex] || { label: 'keys', scope: 'CURRENT SCREEN', rows: help.items || [] };
  const horizontalMargin = rect.width >= 84 ? SPACE.dialogMargin : SPACE.overlayRow;
  const verticalMargin = rect.height >= 16 ? SPACE.overlayColumn : SPACE.overlayRow;
  let width = Math.max(1, Math.min(rect.width - horizontalMargin * 2, help.width || 80));
  if ((rect.width - width) % 2 !== 0 && width > 1) width -= 1;
  const desiredHeight = Math.max(8, (page.rows || []).length + (page.divider ? 10 : 8));
  const height = Math.max(1, Math.min(rect.height - verticalMargin * 2, help.height || desiredHeight, desiredHeight));
  const x = rect.x + Math.floor((rect.width - width) / 2);
  const y = rect.y + Math.floor((rect.height - height) / 2);
  grid.fill(x, y, width, height, ' ', palette.surfaceOverlay);
  paintBox(grid, { x, y, width, height }, {
    style: mergeStyle(palette.surfaceOverlay, palette.borderActive),
    titleStyle: mergeStyle(palette.surfaceOverlay, palette.paneTitle)
  });
  const bodyX = x + SPACE.overlayColumn;
  const bodyWidth = width - SPACE.overlayColumn * 2;
  const title = formatDisplayValue(help.title || 'DELEGATE KEYS');
  const paging = `${pageIndex + 1}/${Math.max(1, pages.length)}`;
  grid.write(bodyX, y + SPACE.overlayRow, title, mergeStyle(palette.surfaceOverlay, palette.paneTitle), Math.min(bodyWidth, displayWidth(title)));
  grid.write(bodyX + bodyWidth - displayWidth(paging), y + SPACE.overlayRow, paging, mergeStyle(palette.surfaceOverlay, palette.dim), displayWidth(paging));
  let row = y + SPACE.overlayRow + SPACE.overlayColumn;
  if (page.divider) {
    grid.write(bodyX, row, 'ALL KEYS', mergeStyle(palette.surfaceOverlay, palette.dim), Math.min(bodyWidth, 8));
    row += SPACE.overlayColumn;
  }
  const section = String(page.label || 'keys').toUpperCase();
  const marker = page.destructive ? `DESTRUCTIVE ${CHROME_GLYPHS.destructiveMarker}` : formatDisplayValue(page.scope);
  const markerWidth = Math.min(displayWidth(marker), Math.max(0, Math.floor(bodyWidth / 2)));
  grid.write(bodyX, row, section, mergeStyle(palette.surfaceOverlay, palette.dim), Math.min(displayWidth(section), bodyWidth));
  if (markerWidth) grid.write(bodyX + bodyWidth - markerWidth, row, marker, mergeStyle(palette.surfaceOverlay, palette.dim), markerWidth);
  row += SPACE.overlayColumn;
  const keyWidth = Math.min(24, Math.max(16, Number(help.keyWidth || 22)));
  for (const item of page.rows || []) {
    if (row >= y + height - 2) break;
    writeHelpKeyCaps(grid, bodyX, row, item, keyWidth, palette.surfaceOverlay);
    grid.write(
      bodyX + keyWidth + SPACE.railGap,
      row,
      truncateToWidth(formatDisplayValue(item.label || item.description), bodyWidth - keyWidth - SPACE.railGap, { ellipsis: true }),
      mergeStyle(palette.surfaceOverlay, palette.body),
      bodyWidth - keyWidth - SPACE.railGap
    );
    row += SPACE.overlayRow;
  }
  const footer = '[ ] section   ? / Esc close';
  const footerText = truncateToWidth(footer, bodyWidth);
  grid.write(bodyX + bodyWidth - displayWidth(footerText), y + height - 2, footerText, mergeStyle(palette.surfaceOverlay, palette.dim), displayWidth(footerText));
}

export function paintActionOverlay(grid, rect, menu = {}) {
  paintOverlayScrim(grid, rect);
  const items = menu.items || [];
  const width = Math.min(rect.width - 2, menu.width || 82);
  const height = Math.min(rect.height - 2, Math.max(9, Math.min(18, items.length + 7)));
  const x = rect.x + Math.max(1, Math.floor((rect.width - width) / 2));
  const y = rect.y + Math.max(1, Math.floor((rect.height - height) / 2));
  const bodyX = x + SPACE.overlayColumn;
  const bodyWidth = width - SPACE.overlayColumn * 2;
  const selected = Math.max(0, Math.min(items.length - 1, Number(menu.selected || 0)));
  const viewport = Math.max(1, height - 6);
  const start = Math.max(0, Math.min(Math.max(0, items.length - viewport), selected - viewport + 1));
  grid.fill(x, y, width, height, ' ', palette.surfaceOverlay);
  paintBox(grid, { x, y, width, height }, {
    title: menu.title || 'Actions',
    style: mergeStyle(palette.surfaceOverlay, palette.borderActive),
    titleStyle: mergeStyle(palette.surfaceOverlay, palette.paneTitle)
  });
  const filter = `/${menu.query || ''}${menu.filtering ? '_' : ''}`;
  grid.write(bodyX, y + 1, truncateToWidth(filter, bodyWidth, { ellipsis: true }), mergeStyle(palette.surfaceOverlay, menu.filtering ? palette.inputLabel : palette.dim), bodyWidth);
  if (menu.hint) {
    grid.write(bodyX, y + 2, truncateToWidth(menu.hint, bodyWidth, { ellipsis: true }), mergeStyle(palette.surfaceOverlay, palette.dim), bodyWidth);
  }
  const keyWidth = 12;
  for (let index = start; index < Math.min(items.length, start + viewport); index += 1) {
    const item = items[index];
    const row = y + 3 + index - start;
    const rowStyle = index === selected ? mergeStyle(palette.surfaceOverlay, palette.selection) : palette.surfaceOverlay;
    grid.fill(bodyX, row, bodyWidth, 1, ' ', rowStyle);
    writeKeyParts(grid, bodyX, row, item.keys, keyWidth, rowStyle, { dim: Boolean(item.unavailable) });
    const reason = item.unavailable ? ` -- ${formatDisplayValue(item.unavailable)}` : '';
    grid.write(
      bodyX + keyWidth + SPACE.railGap,
      row,
      truncateToWidth(`${formatDisplayValue(item.label)}${reason}`, bodyWidth - keyWidth - SPACE.railGap, { ellipsis: true }),
      mergeStyle(rowStyle, item.unavailable ? palette.dim : palette.body),
      bodyWidth - keyWidth - SPACE.railGap
    );
  }
  const footer = '/ filter  Enter run  x/Esc close';
  grid.write(bodyX, y + height - 2, truncateToWidth(footer, bodyWidth), mergeStyle(palette.surfaceOverlay, palette.dim), Math.min(bodyWidth, displayWidth(footer)));
  if (items.length > viewport) {
    const geometry = scrollbarGeometry({ track: Math.max(1, height - 4), viewport, total: items.length, offset: start });
    const trackX = x + width - 2;
    for (let offset = 0; offset < geometry.track; offset += 1) grid.set(trackX, y + 2 + offset, CHROME_GLYPHS.scrollTrack, mergeStyle(palette.surfaceOverlay, palette.borderSubtle));
    for (let offset = 0; offset < geometry.thumbLen; offset += 1) grid.set(trackX, y + 2 + geometry.thumbStart + offset, CHROME_GLYPHS.scrollThumb, mergeStyle(palette.surfaceOverlay, palette.borderActive));
  }
}

export function paintPrefixOverlay(grid, rect, popup = {}) {
  const items = popup.items || [];
  const width = Math.min(Math.max(28, ...items.map((item) => displayWidth(item.label || '') + 10)), Math.max(1, rect.width - 2));
  const height = Math.min(rect.height - 2, Math.max(4, items.length + 2));
  const x = rect.x + Math.max(1, rect.width - width - SPACE.screenBoundary);
  const y = rect.y + Math.max(1, rect.height - height - SPACE.screenBoundary);
  grid.fill(x, y, width, height, ' ', palette.surfaceOverlay);
  paintBox(grid, { x, y, width, height }, {
    title: popup.title || 'prefix',
    style: mergeStyle(palette.surfaceOverlay, palette.borderActive),
    titleStyle: mergeStyle(palette.surfaceOverlay, palette.paneTitle)
  });
  const keyWidth = 5;
  for (let index = 0; index < items.length && index + 1 < height - 1; index += 1) {
    const row = y + 1 + index;
    writeKeyParts(grid, x + SPACE.overlayColumn, row, items[index].keys, keyWidth, palette.surfaceOverlay);
    grid.write(
      x + SPACE.overlayColumn + keyWidth + SPACE.railGap,
      row,
      truncateToWidth(formatDisplayValue(items[index].label), width - keyWidth - SPACE.overlayColumn * 2 - SPACE.railGap, { ellipsis: true }),
      mergeStyle(palette.surfaceOverlay, palette.body),
      width - keyWidth - SPACE.overlayColumn * 2 - SPACE.railGap
    );
  }
}

function paintContent(grid, rect, content = {}, options = {}) {
  const styled = { ...content, style: content.style || options.ownerStyle };
  if (content.kind === 'empty') return paintEmptyState(grid, rect, styled);
  if (content.kind === 'tile') return paintTile(grid, rect, styled);
  if (content.kind === 'table') {
    const rowCount = Number(content.rowCount ?? content.rows?.length ?? 0);
    if (!rowCount && content.empty) return paintEmptyState(grid, rect, { ...content.empty, style: content.empty.style || options.ownerStyle });
    return paintTable(grid, rect, { ...styled, focused: options.focused });
  }
  if (content.kind === 'key-value') return paintKeyValue(grid, rect, { ...styled, focused: options.focused });
  if (content.kind === 'rail') {
    const count = content.entries?.length;
    if (!count && content.empty) return paintEmptyState(grid, rect, { ...content.empty, style: content.empty.style || options.ownerStyle });
    return paintRail(grid, rect, { ...styled, focused: options.focused }, options);
  }
  if (content.kind === 'diff') {
    const count = content.entries?.length;
    if (!count && content.empty) return paintEmptyState(grid, rect, { ...content.empty, style: content.empty.style || options.ownerStyle });
    return paintDiffLine(grid, rect, { ...styled, focused: options.focused }, options);
  }
  if (content.kind === 'log' || content.kind === 'text') {
    const count = content.virtual ? content.entries?.length : content.lines?.length;
    if (!count && content.empty) return paintEmptyState(grid, rect, { ...content.empty, style: content.empty.style || options.ownerStyle });
    return paintLogPane(grid, rect, { ...styled, focused: options.focused }, options);
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

function footerHintSegments(hint, ownerStyle) {
  const dim = ['navigation', 'view'].includes(hint.class);
  const keyStyle = dim ? mergeStyle(ownerStyle, palette.dim) : mergeStyle(ownerStyle, palette.metadata);
  const labelStyle = dim ? mergeStyle(ownerStyle, palette.dim) : mergeStyle(ownerStyle, palette.body);
  const segments = [];
  for (const part of hint.keys || []) {
    segments.push({
      text: formatDisplayValue(part.text),
      style: part.kind === 'separator' ? mergeStyle(ownerStyle, palette.dim) : keyStyle
    });
  }
  segments.push({ text: '  ', style: ownerStyle });
  segments.push({ text: formatDisplayValue(hint.label), style: labelStyle });
  return segments;
}

function footerGroupSegments(groups, ownerStyle) {
  const segments = [];
  for (let groupIndex = 0; groupIndex < (groups || []).length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (groupIndex) segments.push({ text: CHROME_GLYPHS.separator, style: mergeStyle(ownerStyle, palette.dim) });
    if (group[0]?.class === 'destructive') {
      segments.push({ text: `${CHROME_GLYPHS.destructiveMarker} `, style: mergeStyle(ownerStyle, palette.metadata) });
    }
    for (let hintIndex = 0; hintIndex < group.length; hintIndex += 1) {
      if (hintIndex) segments.push({ text: '  ', style: ownerStyle });
      segments.push(...footerHintSegments(group[hintIndex], ownerStyle));
    }
  }
  return segments;
}

function segmentsWidth(segments) {
  return (segments || []).reduce((total, segment) => total + displayWidth(textOf(segment)), 0);
}

// The tile band declares exact surface ownership for its footprint, including
// odd-width remainder columns. Section gaps remain frame-background cells when
// present and disappear entirely under the named height-pressure threshold.
export function dashboardTileBandOwnership(frame) {
  if (frame?.screen !== 'dashboard') return null;
  const regions = (frame.panes || [])
    .filter((pane) => pane.content?.kind === 'tile' && pane.rect?.width > 0 && pane.rect?.height > 0)
    .map((pane) => ({ rect: { ...pane.rect }, owner: 'tileSurface' }));
  if (!regions.length) return null;
  const top = Math.min(...regions.map(({ rect }) => rect.y));
  const bottom = Math.max(...regions.map(({ rect }) => rect.y + rect.height - 1));
  const y = Math.max(0, top);
  const last = Math.min(Number(frame.height || 0) - 1, bottom);
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
  if (pane.border !== false && pane.rect.width > SPACE.screenBoundary * 4) {
    const readout = ` ${scrollReadout(metrics, pane.rect.width)} `;
    const maximum = Math.max(0, pane.rect.width - SPACE.paneColumn * 2);
    const text = truncateToWidth(readout, maximum, { ellipsis: true });
    const x = Math.max(
      pane.rect.x + SPACE.paneColumn,
      pane.rect.x + pane.rect.width - displayWidth(text) - SPACE.paneColumn
    );
    grid.write(x, pane.rect.y, text, mergeStyle(pane.style || palette.surface, palette.borderSubtle), Math.min(maximum, displayWidth(text)));
  }
  const x = pane.rect.x + pane.rect.width - 1;
  const bordered = pane.border !== false;
  // Summary strips are part of the pane's interior chrome, so the rail stays
  // continuous beside them even though only the rows below them scroll.
  const top = bordered ? pane.rect.y + SPACE.paneRow : pane.rect.y;
  const bottom = bordered ? pane.rect.y + pane.rect.height - SPACE.paneRow : pane.rect.y + pane.rect.height;
  const height = Math.max(0, bottom - top);
  if (!height) return;
  const trackStyle = mergeStyle(pane.style || palette.surface, palette.borderSubtle);
  for (let row = 0; row < height; row += 1) grid.set(x, top + row, CHROME_GLYPHS.scrollTrack, trackStyle);
  const geometry = scrollbarGeometry({
    track: height,
    viewport,
    total,
    offset: metrics?.startIndex,
    follow: metrics?.follow === true
  });
  for (let row = geometry.thumbStart; row < geometry.thumbStart + geometry.thumbLen; row += 1) {
    grid.set(x, top + row, CHROME_GLYPHS.scrollThumb, mergeStyle(pane.style || palette.surface, palette.scrollThumb));
  }
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
    const ownerStyle = dashboardTile
      ? palette.surface
      : focused ? palette.surfaceRaised : palette.surface;
    const decorated = {
      ...pane,
      style: pane.style || ownerStyle,
      railStyle: focused ? palette.focusBorder : palette.borderSubtle
    };
    const scrollable = ['table', 'log', 'text', 'key-value', 'rail', 'diff'].includes(pane.content?.kind);
    const contentRect = paintPane(grid, decorated, { scrollbar: scrollable });
    const summaryRect = paneSummaryRect(decorated, { scrollbar: scrollable });
    if (summaryRect) paintSummaryStrip(grid, summaryRect, decorated.summary, decorated.style);
    const metrics = paintContent(grid, contentRect, pane.content, { ...options, focused, ownerStyle: decorated.style });
    if (scrollable) paintScrollIndicator(grid, decorated, contentRect, metrics);
  }
  if (frame.status) {
    const y = frame.height - 1;
    const ownerStyle = frame.status.style || palette.bar;
    grid.fill(0, y, frame.width, 1, ' ', ownerStyle);
    let statusWidth = frame.width - 2;
    let right = '';
    let rightX = frame.width - 1;
    const pinnedSegments = frame.status.rightHints?.length
      ? footerGroupSegments([frame.status.rightHints], ownerStyle)
      : [];
    const pinnedWidth = segmentsWidth(pinnedSegments);
    if (pinnedWidth) {
      rightX = Math.max(1, frame.width - pinnedWidth - 1);
      statusWidth = Math.max(0, rightX - 2);
    } else if (frame.status.right) {
      right = truncateToWidth(formatDisplayValue(frame.status.right), Math.floor(frame.width / 2), { ellipsis: true });
      rightX = Math.max(1, frame.width - displayWidth(right) - 1);
      statusWidth = Math.max(0, rightX - 2);
    }
    if (frame.status.hints) {
      writeSegments(grid, 1, y, footerGroupSegments(frame.status.hints, ownerStyle), statusWidth, ownerStyle);
    } else if (frame.status.segments) writeSegments(grid, 1, y, frame.status.segments, statusWidth, ownerStyle);
    else grid.write(1, y, truncateToWidth(formatDisplayValue(frame.status.text), statusWidth, { ellipsis: true }), ownerStyle, statusWidth);
    if (pinnedWidth) writeSegments(grid, rightX, y, pinnedSegments, pinnedWidth, ownerStyle, false);
    else if (right) grid.write(rightX, y, right, ownerStyle, displayWidth(right));
  }
  if (frame.overlay?.kind === 'help') paintHelpOverlay(grid, { x: 0, y: 0, width: frame.width, height: frame.height }, frame.overlay);
  if (frame.overlay?.kind === 'actions') paintActionOverlay(grid, { x: 0, y: 0, width: frame.width, height: frame.height }, frame.overlay);
  if (frame.overlay?.kind === 'prefix') paintPrefixOverlay(grid, { x: 0, y: 0, width: frame.width, height: frame.height }, frame.overlay);
  if (frame.overlay?.kind === 'input') paintTextInput(grid, { x: 1, y: frame.height - 2, width: frame.width - 2, height: 1 }, frame.overlay);
  if (frame.overlay?.kind === 'confirm') paintConfirmPrompt(grid, { x: 0, y: 0, width: frame.width, height: frame.height }, frame.overlay);
  return grid;
}

export function renderFrameToString(frame, options = {}) {
  return renderGridToString(paintFrame(frame, options), options);
}

export { palette };
