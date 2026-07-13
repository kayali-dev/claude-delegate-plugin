import { EventEmitter } from 'node:events';
import { cursorTo, detectColorMode, mouseReportingOff, mouseReportingOn, sequences, styleSequence } from './ansi.mjs';
import { graphemeWidth, splitGraphemes, stripAnsi, truncateToWidth } from './width.mjs';

const EMPTY_STYLE = Object.freeze({});
const normalizedStyles = new WeakMap([[EMPTY_STYLE, EMPTY_STYLE]]);
const styleKeys = new WeakMap([[EMPTY_STYLE, '{}']]);

function normalizedStyle(style) {
  if (!style || typeof style !== 'object') return EMPTY_STYLE;
  const cached = normalizedStyles.get(style);
  if (cached) return cached;
  const normalized = Object.fromEntries(Object.entries(style).filter(([, value]) => value != null && value !== false).sort(([a], [b]) => a.localeCompare(b)));
  normalizedStyles.set(style, normalized);
  normalizedStyles.set(normalized, normalized);
  return normalized;
}

function styleKey(style) {
  const normalized = normalizedStyle(style);
  let key = styleKeys.get(normalized);
  if (key == null) {
    key = JSON.stringify(normalized);
    styleKeys.set(normalized, key);
  }
  return key;
}

function cell(char = ' ', style = EMPTY_STYLE, continuation = false) {
  const normalized = normalizedStyle(style);
  return { char, style: normalized, styleKey: styleKey(normalized), continuation };
}

function equalCell(left, right) {
  return Boolean(left && right && left.char === right.char && left.styleKey === right.styleKey && left.continuation === right.continuation);
}

export class CellGrid {
  constructor(columns, rows) {
    this.columns = Math.max(1, Math.floor(columns));
    this.rows = Math.max(1, Math.floor(rows));
    const empty = cell();
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.columns }, () => empty));
  }

  get(x, y) {
    return y >= 0 && y < this.rows && x >= 0 && x < this.columns ? this.cells[y][x] : null;
  }

  set(x, y, char = ' ', style = EMPTY_STYLE) {
    if (y < 0 || y >= this.rows || x < 0 || x >= this.columns) return 0;
    const plain = String(char);
    const ascii = plain.length === 1 && plain.charCodeAt(0) < 128;
    const grapheme = ascii ? plain : (splitGraphemes(stripAnsi(plain))[0] || ' ');
    const width = ascii ? 1 : Math.max(1, graphemeWidth(grapheme));
    if (width > 1 && x + width > this.columns) return 0;
    this.cells[y][x] = cell(grapheme, style, false);
    for (let offset = 1; offset < width; offset += 1) this.cells[y][x + offset] = cell('', style, true);
    return width;
  }

  write(x, y, value, style = EMPTY_STYLE, maxWidth = this.columns - x) {
    if (y < 0 || y >= this.rows || maxWidth <= 0) return 0;
    let cursor = x;
    let used = 0;
    const text = stripAnsi(truncateToWidth(value, maxWidth));
    for (const grapheme of splitGraphemes(text)) {
      const width = Math.max(0, graphemeWidth(grapheme));
      if (!width) continue;
      if (used + width > maxWidth || cursor + width > this.columns) break;
      const written = this.set(cursor, y, grapheme, style);
      if (!written) break;
      cursor += written;
      used += written;
    }
    return used;
  }

  fill(x, y, width, height, char = ' ', style = EMPTY_STYLE) {
    const right = Math.min(this.columns, x + Math.max(0, width));
    const bottom = Math.min(this.rows, y + Math.max(0, height));
    const plain = String(char);
    const ascii = plain.length === 1 && plain.charCodeAt(0) < 128;
    if (ascii) {
      const entry = cell(plain, style, false);
      for (let row = Math.max(0, y); row < bottom; row += 1) {
        for (let column = Math.max(0, x); column < right; column += 1) this.cells[row][column] = entry;
      }
      return;
    }
    for (let row = Math.max(0, y); row < bottom; row += 1) {
      for (let column = Math.max(0, x); column < right; column += 1) this.set(column, row, char, style);
    }
  }

  clone() {
    const copy = new CellGrid(this.columns, this.rows);
    // Cells and normalized styles are immutable by convention; writers replace
    // cells instead of mutating them, so row copies safely isolate frame edits.
    copy.cells = this.cells.map((row) => row.slice());
    return copy;
  }

  lines() {
    return this.cells.map((row) => row.map((entry) => entry.continuation ? '' : entry.char).join(''));
  }
}

export function renderGridToString(grid, options = {}) {
  const lines = grid.lines();
  return (options.trimEnd ? lines.map((line) => line.trimEnd()) : lines).join('\n');
}

function dirtyColumns(current, previous, row, full) {
  const dirty = new Set();
  for (let x = 0; x < current.columns; x += 1) {
    if (full || !equalCell(current.get(x, row), previous?.get(x, row))) dirty.add(x);
  }
  for (const x of [...dirty]) {
    if (current.get(x, row)?.continuation || previous?.get(x, row)?.continuation) {
      let base = x;
      while (base > 0 && (current.get(base, row)?.continuation || previous?.get(base, row)?.continuation)) base -= 1;
      for (let column = base; column <= x; column += 1) dirty.add(column);
    }
  }
  return [...dirty].sort((a, b) => a - b);
}

export class Screen extends EventEmitter {
  constructor(options = {}) {
    super();
    this.output = options.output || process.stdout;
    this.input = options.input || process.stdin;
    this.columns = Math.max(1, options.columns || this.output.columns || 80);
    this.rows = Math.max(1, options.rows || this.output.rows || 24);
    this.colorMode = options.colorMode || detectColorMode(options.env || process.env);
    this.exit = options.exit || ((code) => process.exit(code));
    this.errorOutput = options.errorOutput || process.stderr;
    this.previous = null;
    this.started = false;
    this.restored = false;
    this.listenersInstalled = false;
    this.boundResize = () => this.resize(this.output.columns || this.columns, this.output.rows || this.rows);
    this.boundExit = () => this.restore();
    this.boundSigint = () => { this.restore(); this.exit(130); };
    this.boundSigterm = () => { this.restore(); this.exit(143); };
    this.boundException = (error) => {
      this.restore();
      try { this.errorOutput.write(`${error?.stack || error}\n`); } catch {}
      this.exit(1);
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.restored = false;
    this.installLifecycle();
    try {
      if (this.input.isTTY && typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
      if (typeof this.input.resume === 'function') this.input.resume();
      this.output.write(`${sequences.alternateScreenOn}${mouseReportingOn}${sequences.cursorHide}${sequences.clearScreen}${sequences.home}`);
    } catch (error) {
      this.restore();
      this.removeLifecycle();
      throw error;
    }
  }

  installLifecycle() {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    process.on('SIGWINCH', this.boundResize);
    process.once('exit', this.boundExit);
    process.once('SIGINT', this.boundSigint);
    process.once('SIGTERM', this.boundSigterm);
    process.once('uncaughtException', this.boundException);
  }

  removeLifecycle() {
    if (!this.listenersInstalled) return;
    this.listenersInstalled = false;
    process.off('SIGWINCH', this.boundResize);
    process.off('exit', this.boundExit);
    process.off('SIGINT', this.boundSigint);
    process.off('SIGTERM', this.boundSigterm);
    process.off('uncaughtException', this.boundException);
  }

  resize(columns, rows) {
    const nextColumns = Math.max(1, Number(columns) || 1);
    const nextRows = Math.max(1, Number(rows) || 1);
    if (nextColumns === this.columns && nextRows === this.rows) return false;
    this.columns = nextColumns;
    this.rows = nextRows;
    this.previous = null;
    this.emit('resize', { columns: this.columns, rows: this.rows });
    return true;
  }

  render(grid) {
    if (!(grid instanceof CellGrid)) throw new TypeError('Screen.render expects a CellGrid');
    const full = !this.previous || this.previous.columns !== grid.columns || this.previous.rows !== grid.rows;
    let output = full ? `${sequences.reset}${sequences.clearScreen}` : '';
    let activeStyle = '';
    for (let y = 0; y < grid.rows; y += 1) {
      const dirty = dirtyColumns(grid, this.previous, y, full);
      let index = 0;
      while (index < dirty.length) {
        const start = dirty[index];
        let end = start;
        while (index + 1 < dirty.length && dirty[index + 1] === end + 1) end = dirty[++index];
        output += cursorTo(y, start);
        for (let x = start; x <= end; x += 1) {
          const current = grid.get(x, y);
          if (current.continuation) continue;
          if (current.styleKey !== activeStyle) {
            output += styleSequence(current.style, this.colorMode);
            activeStyle = current.styleKey;
          }
          output += current.char || ' ';
        }
        index += 1;
      }
    }
    if (output) {
      output += sequences.reset;
      this.output.write(output);
    }
    this.previous = grid.clone();
    return output;
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      if (this.input.isTTY && typeof this.input.setRawMode === 'function') this.input.setRawMode(false);
    } catch {}
    try { this.output.write(`${sequences.reset}${mouseReportingOff}${sequences.cursorShow}${sequences.alternateScreenOff}`); } catch {}
  }

  stop() {
    this.restore();
    this.removeLifecycle();
    try { if (typeof this.input.pause === 'function') this.input.pause(); } catch {}
  }
}
