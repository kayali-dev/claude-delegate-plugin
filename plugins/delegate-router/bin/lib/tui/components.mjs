import { CellGrid, renderGridToString } from './screen.mjs';
import { displayWidth, padToWidth, splitGraphemes, stripAnsi, truncateToWidth } from './width.mjs';
import { uiPalette as palette } from './palette.mjs';

function mergeStyle(...styles) {
  return Object.assign({}, ...styles.filter(Boolean));
}

function inner(rect) {
  return { x: rect.x + 1, y: rect.y + 1, width: Math.max(0, rect.width - 2), height: Math.max(0, rect.height - 2) };
}

function textOf(cell) {
  return cell && typeof cell === 'object' && !Array.isArray(cell) ? String(cell.text ?? '') : String(cell ?? '');
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

function writeSegments(grid, x, y, segments, width, fallbackStyle) {
  let used = 0;
  for (const segment of segments || []) {
    if (used >= width) break;
    const text = truncateToWidth(textOf(segment), width - used);
    const segmentWidth = displayWidth(text);
    grid.write(x + used, y, text, mergeStyle(fallbackStyle, styleOf(segment)), segmentWidth);
    used += segmentWidth;
  }
  if (used < width) grid.write(x + used, y, ' '.repeat(width - used), fallbackStyle, width - used);
}

export function paintBox(grid, rect, options = {}) {
  if (rect.width < 2 || rect.height < 2) return;
  const style = options.style || palette.border;
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  grid.set(rect.x, rect.y, '┌', style);
  grid.set(right, rect.y, '┐', style);
  grid.set(rect.x, bottom, '└', style);
  grid.set(right, bottom, '┘', style);
  for (let x = rect.x + 1; x < right; x += 1) {
    grid.set(x, rect.y, '─', style);
    grid.set(x, bottom, '─', style);
  }
  for (let y = rect.y + 1; y < bottom; y += 1) {
    grid.set(rect.x, y, '│', style);
    grid.set(right, y, '│', style);
  }
  if (options.title && rect.width > 4) {
    const title = ` ${truncateToWidth(options.title, rect.width - 4)} `;
    grid.write(rect.x + 2, rect.y, title, options.titleStyle || palette.paneTitle, rect.width - 4);
  }
}

export function paintPane(grid, pane) {
  const rect = pane.rect;
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', pane.style || palette.body);
  if (pane.border !== false) paintBox(grid, rect, { title: pane.title, style: pane.borderStyle, titleStyle: pane.titleStyle });
  return pane.border === false ? rect : inner(rect);
}

export function paintTable(grid, rect, table = {}) {
  const columns = table.columns || [];
  const rows = table.rows || [];
  const headerRows = table.header === false ? 0 : 1;
  const visibleRows = Math.max(0, rect.height - headerRows);
  const selected = Math.max(0, Math.min(rows.length - 1, Number(table.selected || 0)));
  const requestedScroll = Math.max(0, Number(table.scroll || 0));
  const scroll = Math.max(0, Math.min(
    Math.max(requestedScroll, selected >= requestedScroll + visibleRows ? selected - visibleRows + 1 : requestedScroll),
    Math.max(0, rows.length - visibleRows)
  ));
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', table.style || palette.body);
  const widths = columns.map((column) => Math.max(1, Number(column.width || 1)));
  if (headerRows) {
    let x = rect.x;
    for (let index = 0; index < columns.length && x < rect.x + rect.width; index += 1) {
      const width = Math.min(widths[index], rect.x + rect.width - x);
      const contentWidth = index < columns.length - 1 ? Math.max(1, width - 1) : width;
      writePadded(grid, x, rect.y, columns[index].title || '', contentWidth, columns[index].headerStyle || palette.header, columns[index].align);
      if (contentWidth < width) grid.set(x + contentWidth, rect.y, ' ', columns[index].headerStyle || palette.header);
      x += width;
    }
  }
  for (let visual = 0; visual < visibleRows; visual += 1) {
    const rowIndex = scroll + visual;
    const row = rows[rowIndex];
    if (!row) continue;
    let x = rect.x;
    const y = rect.y + headerRows + visual;
    const rowSelected = rowIndex === selected && table.selection !== false;
    for (let index = 0; index < columns.length && x < rect.x + rect.width; index += 1) {
      const column = columns[index];
      const width = Math.min(widths[index], rect.x + rect.width - x);
      const contentWidth = index < columns.length - 1 ? Math.max(1, width - 1) : width;
      const value = Array.isArray(row.cells) ? row.cells[index] : row[column.key];
      const style = rowSelected
        ? mergeStyle(row.style, styleOf(value), palette.selection, column.selectedStyle)
        : mergeStyle(row.style, styleOf(value), table.rowStyle);
      const segments = segmentsOf(value);
      if (segments) writeSegments(grid, x, y, segments, contentWidth, style);
      else writePadded(grid, x, y, textOf(value), contentWidth, style, column.align);
      if (contentWidth < width) grid.set(x + contentWidth, y, ' ', style);
      x += width;
    }
  }
  if (rows.length > visibleRows && rect.width > 0) {
    const marker = `${scroll + 1}-${Math.min(rows.length, scroll + visibleRows)}/${rows.length}`;
    grid.write(Math.max(rect.x, rect.x + rect.width - displayWidth(marker)), rect.y, marker, palette.dim, Math.min(rect.width, displayWidth(marker)));
  }
  return { scroll, visibleRows };
}

export function paintTabBar(grid, rect, tabs = [], active = 0) {
  grid.fill(rect.x, rect.y, rect.width, 1, ' ', palette.body);
  let x = rect.x;
  for (let index = 0; index < tabs.length && x < rect.x + rect.width; index += 1) {
    const label = ` ${index + 1}:${textOf(tabs[index])} `;
    const width = Math.min(displayWidth(label), rect.x + rect.width - x);
    grid.write(x, rect.y, truncateToWidth(label, width), index === active ? palette.header : palette.dim, width);
    x += width + 1;
  }
}

function wrapLine(value, width) {
  const text = stripAnsi(value);
  if (width <= 0) return [];
  if (!text) return [''];
  const lines = [];
  let current = '';
  let used = 0;
  for (const grapheme of splitGraphemes(text)) {
    if (grapheme === '\n') {
      lines.push(current);
      current = '';
      used = 0;
      continue;
    }
    const size = displayWidth(grapheme);
    if (used + size > width && current) {
      lines.push(current);
      current = '';
      used = 0;
    }
    if (size <= width) {
      current += grapheme;
      used += size;
    }
  }
  lines.push(current);
  return lines;
}

export class WrapCache {
  constructor() {
    this.objects = new WeakMap();
    this.primitives = new Map();
    this.formatters = new WeakMap();
    this.nextFormatterId = 1;
    this.wrapCalls = 0;
    this.hits = 0;
    this.misses = 0;
  }

  formatterId(formatter) {
    if (typeof formatter !== 'function') return 0;
    if (!this.formatters.has(formatter)) this.formatters.set(formatter, this.nextFormatterId++);
    return this.formatters.get(formatter);
  }

  lines(entry, width, formatter = null) {
    const key = `${Math.max(1, width)}:${this.formatterId(formatter)}`;
    const objectEntry = entry != null && (typeof entry === 'object' || typeof entry === 'function');
    const cache = objectEntry
      ? (this.objects.get(entry) || (this.objects.set(entry, new Map()), this.objects.get(entry)))
      : this.primitives;
    const primitiveKey = objectEntry ? key : `${typeof entry}:${String(entry)}:${key}`;
    if (cache.has(primitiveKey)) {
      this.hits += 1;
      return cache.get(primitiveKey);
    }
    const value = formatter ? formatter(entry) : textOf(entry);
    const lines = wrapLine(textOf(value), Math.max(1, width));
    cache.set(primitiveKey, lines);
    this.wrapCalls += 1;
    this.misses += 1;
    return lines;
  }

  clear() {
    this.objects = new WeakMap();
    this.primitives.clear();
    this.formatters = new WeakMap();
    this.nextFormatterId = 1;
  }
}

export const defaultWrapCache = new WrapCache();

export function invalidateWrapCache() {
  defaultWrapCache.clear();
}

function virtualPosition(value, entries, cache, width, formatter) {
  if (!entries.length) return { entry: 0, line: 0 };
  const entry = Math.max(0, Math.min(entries.length - 1, Math.floor(Number(value?.entry ?? value ?? 0))));
  const lines = cache.lines(entries[entry], width, formatter);
  const line = Math.max(0, Math.min(Math.max(0, lines.length - 1), Math.floor(Number(value?.line || 0))));
  return { entry, line };
}

export function virtualLogBottomPosition(log, width, height, cache = defaultWrapCache) {
  const entries = log.entries || [];
  let needed = Math.max(1, height);
  for (let entry = entries.length - 1; entry >= 0; entry -= 1) {
    const lines = cache.lines(entries[entry], width, log.formatEntry);
    if (lines.length >= needed) return { entry, line: Math.max(0, lines.length - needed) };
    needed -= lines.length;
  }
  return { entry: 0, line: 0 };
}

export function scrollVirtualLog(log, position, delta, width, cache = defaultWrapCache) {
  const entries = log.entries || [];
  if (!entries.length || !delta) return virtualPosition(position, entries, cache, width, log.formatEntry);
  let current = virtualPosition(position, entries, cache, width, log.formatEntry);
  let remaining = Math.abs(Math.trunc(delta));
  const direction = Math.sign(delta);
  while (remaining > 0) {
    const lines = cache.lines(entries[current.entry], width, log.formatEntry);
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
      const previous = cache.lines(entries[current.entry - 1], width, log.formatEntry);
      current = { entry: current.entry - 1, line: Math.max(0, previous.length - 1) };
    }
  }
  return current;
}

export function compareVirtualPositions(left, right) {
  return Number(left?.entry || 0) - Number(right?.entry || 0) || Number(left?.line || 0) - Number(right?.line || 0);
}

function paintVirtualLogPane(grid, rect, log, cache) {
  const entries = log.entries || [];
  const overscan = Math.max(2, Number(log.overscan ?? Math.min(12, rect.height)));
  const targetLines = rect.height + overscan;
  const expanded = [];
  let start;
  if (log.follow !== false) {
    let index = entries.length;
    while (index > 0 && expanded.length < targetLines) {
      index -= 1;
      const entry = entries[index];
      const style = typeof log.styleEntry === 'function' ? log.styleEntry(entry) : styleOf(entry);
      const lines = cache.lines(entry, rect.width, log.formatEntry).map((text) => ({ text, style }));
      expanded.unshift(...lines);
    }
    start = { entry: Math.max(0, index), line: 0 };
  } else {
    start = virtualPosition(log.scroll, entries, cache, rect.width, log.formatEntry);
    for (let index = start.entry; index < entries.length && expanded.length < targetLines; index += 1) {
      const entry = entries[index];
      const style = typeof log.styleEntry === 'function' ? log.styleEntry(entry) : styleOf(entry);
      const lines = cache.lines(entry, rect.width, log.formatEntry);
      const offset = index === start.entry ? start.line : 0;
      for (let line = offset; line < lines.length; line += 1) expanded.push({ text: lines[line], style });
    }
  }
  const visible = log.follow !== false ? expanded.slice(Math.max(0, expanded.length - rect.height)) : expanded.slice(0, rect.height);
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', log.style || palette.body);
  for (let index = 0; index < visible.length; index += 1) {
    const line = visible[index];
    writePadded(grid, rect.x, rect.y + index, line.text, rect.width, line.style || log.lineStyle || palette.body);
  }
  return { scroll: start, totalEntries: entries.length };
}

export function paintLogPane(grid, rect, log = {}, options = {}) {
  if (log.virtual) return paintVirtualLogPane(grid, rect, log, options.wrapCache || defaultWrapCache);
  const expanded = [];
  for (const raw of log.lines || []) {
    const value = textOf(raw);
    for (const line of wrapLine(value, rect.width)) expanded.push({ text: line, style: styleOf(raw) });
  }
  const maxScroll = Math.max(0, expanded.length - rect.height);
  const scroll = log.follow !== false ? maxScroll : Math.max(0, Math.min(maxScroll, Number(log.scroll || 0)));
  grid.fill(rect.x, rect.y, rect.width, rect.height, ' ', log.style || palette.body);
  for (let index = 0; index < rect.height; index += 1) {
    const line = expanded[scroll + index];
    if (!line) continue;
    writePadded(grid, rect.x, rect.y + index, line.text, rect.width, line.style || log.lineStyle || palette.body);
  }
  return { scroll, totalLines: expanded.length };
}

export function paintTextInput(grid, rect, input = {}) {
  const prompt = `${input.label || 'Input'}: `;
  const promptWidth = Math.min(rect.width, displayWidth(prompt));
  grid.fill(rect.x, rect.y, rect.width, 1, ' ', input.style || palette.input);
  grid.write(rect.x, rect.y, truncateToWidth(prompt, promptWidth), input.labelStyle || palette.inputLabel, promptWidth);
  grid.write(rect.x + promptWidth, rect.y, truncateToWidth(input.value || '', rect.width - promptWidth), input.style || palette.input, rect.width - promptWidth);
  if (rect.width > 0) grid.set(Math.min(rect.x + rect.width - 1, rect.x + promptWidth + displayWidth(input.value || '')), rect.y, ' ', mergeStyle(input.style || palette.input, palette.inputCursor));
}

export function paintConfirmPrompt(grid, rect, prompt = {}) {
  const lines = prompt.lines?.length ? prompt.lines.map(String) : [String(prompt.message || '')];
  const widest = lines.reduce((value, line) => Math.max(value, displayWidth(line)), 0);
  const boxWidth = Math.min(rect.width, Math.max(36, Math.min(88, widest + 4)));
  const boxHeight = Math.min(rect.height, Math.max(5, lines.length + 4));
  const x = rect.x + Math.floor((rect.width - boxWidth) / 2);
  const y = rect.y + Math.floor((rect.height - boxHeight) / 2);
  grid.fill(x, y, boxWidth, boxHeight, ' ', palette.body);
  paintBox(grid, { x, y, width: boxWidth, height: boxHeight }, { title: prompt.title || 'Confirm', titleStyle: palette.warningTitle });
  for (let index = 0; index < lines.length && y + 1 + index < y + boxHeight - 2; index += 1) {
    grid.write(x + 2, y + 1 + index, truncateToWidth(lines[index], boxWidth - 4), prompt.danger ? palette.danger : palette.body, boxWidth - 4);
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
    grid.write(x + 2 + keyWidth + 1, row, truncateToWidth(item.description, width - keyWidth - 5), palette.body, width - keyWidth - 5);
    row += 1;
  }
}

function paintContent(grid, rect, content = {}, options = {}) {
  if (content.kind === 'table') return paintTable(grid, rect, content);
  if (content.kind === 'log' || content.kind === 'text') return paintLogPane(grid, rect, content, options);
  if (content.kind === 'tabs') return paintTabBar(grid, rect, content.tabs, content.active);
  return null;
}

export function paintFrame(frame, options = {}) {
  const grid = new CellGrid(frame.width, frame.height);
  grid.fill(0, 0, frame.width, frame.height, ' ', frame.style || palette.body);
  if (frame.title) {
    grid.write(1, 0, truncateToWidth(frame.title.text || frame.title, frame.width - 2), frame.title.style || palette.screenTitle, frame.width - 2);
    if (frame.title.right) {
      const right = truncateToWidth(frame.title.right, Math.floor(frame.width / 2));
      grid.write(Math.max(1, frame.width - displayWidth(right) - 1), 0, right, frame.title.rightStyle || palette.dim, displayWidth(right));
    }
  }
  if (frame.tabs) paintTabBar(grid, frame.tabs.rect, frame.tabs.items, frame.tabs.active);
  for (const pane of frame.panes || []) {
    const contentRect = paintPane(grid, pane);
    paintContent(grid, contentRect, pane.content, options);
  }
  if (frame.status) {
    const y = frame.height - 1;
    grid.fill(0, y, frame.width, 1, ' ', frame.status.style || palette.bar);
    if (frame.status.segments) writeSegments(grid, 1, y, frame.status.segments, frame.width - 2, frame.status.style || palette.bar);
    else grid.write(1, y, truncateToWidth(frame.status.text || '', frame.width - 2), frame.status.style || palette.bar, frame.width - 2);
    if (frame.status.right) {
      const right = truncateToWidth(frame.status.right, Math.floor(frame.width / 2));
      grid.write(Math.max(1, frame.width - displayWidth(right) - 1), y, right, frame.status.style || palette.bar, displayWidth(right));
    }
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
