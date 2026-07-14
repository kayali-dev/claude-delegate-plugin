import { EventEmitter } from 'node:events';
import { cursorTo, detectColorMode, mouseReportingOff, mouseReportingOn, sequences, styleSequence } from './ansi.mjs';
import { CHROME_GLYPHS } from './glyphs.mjs';
import { getGraphemeWidthOverrides, graphemeWidth, hasGraphemeWidthOverride, isWidthSuspect, splitGraphemes, stripAnsi, truncateToWidth } from './width.mjs';

const EMPTY_STYLE = Object.freeze({});
const normalizedStyles = new WeakMap([[EMPTY_STYLE, EMPTY_STYLE]]);
const styleKeys = new WeakMap([[EMPTY_STYLE, '{}']]);

function normalizedStyle(style) {
  if (!style || typeof style !== 'object') return EMPTY_STYLE;
  const cached = normalizedStyles.get(style);
  if (cached) return cached;
  const normalized = Object.freeze(Object.fromEntries(Object.entries(style).filter(([, value]) => value != null && value !== false).sort(([a], [b]) => a.localeCompare(b))));
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
  return Object.freeze({ char, style: normalized, styleKey: styleKey(normalized), continuation });
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
    // Animation ownership is metadata, not terminal style. Components mark
    // only cells that may be advanced without rebuilding their view-model.
    this.spinnerCells = new Set();
  }

  get(x, y) {
    return y >= 0 && y < this.rows && x >= 0 && x < this.columns ? this.cells[y][x] : null;
  }

  glyphBaseAt(x, y) {
    if (y < 0 || y >= this.rows || x < 0 || x >= this.columns) return null;
    let base = x;
    while (base > 0 && this.cells[y][base].continuation) base -= 1;
    if (base === x && x > 0) {
      const previous = this.cells[y][x - 1];
      if (!previous.continuation && graphemeWidth(previous.char) > 1) base = x - 1;
    }
    return base;
  }

  clearGlyph(base, y) {
    if (base == null || y < 0 || y >= this.rows || base < 0 || base >= this.columns) return;
    const entry = this.cells[y][base];
    const width = entry.continuation ? 1 : Math.max(1, graphemeWidth(entry.char));
    for (let offset = 0; offset < width && base + offset < this.columns; offset += 1) {
      const current = this.cells[y][base + offset];
      this.cells[y][base + offset] = cell(' ', current.style, false);
      this.spinnerCells.delete(`${base + offset},${y}`);
    }
  }

  clearOverlaps(x, y, width) {
    const bases = new Set();
    for (let offset = 0; offset < width; offset += 1) {
      const column = x + offset;
      const entry = this.get(column, y);
      if (!entry) continue;
      if (entry.continuation) bases.add(this.glyphBaseAt(column, y));
      else if (graphemeWidth(entry.char) > 1) bases.add(column);
      if (column > 0) {
        const previous = this.get(column - 1, y);
        if (previous && !previous.continuation && graphemeWidth(previous.char) > 1) bases.add(column - 1);
      }
    }
    for (const base of bases) if (base != null) this.clearGlyph(base, y);
  }

  set(x, y, char = ' ', style = EMPTY_STYLE) {
    if (y < 0 || y >= this.rows || x < 0 || x >= this.columns) return 0;
    this.spinnerCells.delete(`${x},${y}`);
    const plain = String(char);
    const ascii = plain.length === 1 && plain.charCodeAt(0) < 128;
    const grapheme = ascii ? plain : (splitGraphemes(stripAnsi(plain))[0] || ' ');
    const width = ascii ? 1 : Math.max(1, graphemeWidth(grapheme));
    if (width > 1 && x + width > this.columns) {
      this.clearOverlaps(x, y, 1);
      this.cells[y][x] = cell(' ', style, false);
      return 1;
    }
    this.clearOverlaps(x, y, width);
    this.cells[y][x] = cell(grapheme, style, false);
    for (let offset = 1; offset < width; offset += 1) this.cells[y][x + offset] = cell('', style, true);
    return width;
  }

  markSpinner(x, y) {
    if (y >= 0 && y < this.rows && x >= 0 && x < this.columns) this.spinnerCells.add(`${x},${y}`);
  }

  spinnerPositions() {
    return [...this.spinnerCells].map((key) => key.split(',').map(Number));
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
    for (const key of this.spinnerCells) {
      const [column, row] = key.split(',').map(Number);
      if (column >= x && column < right && row >= y && row < bottom) this.spinnerCells.delete(key);
    }
    const plain = String(char);
    const ascii = plain.length === 1 && plain.charCodeAt(0) < 128;
    if (ascii) {
      const entry = cell(plain, style, false);
      for (let row = Math.max(0, y); row < bottom; row += 1) {
        this.clearOverlaps(Math.max(0, x), row, Math.max(0, right - Math.max(0, x)));
        for (let column = Math.max(0, x); column < right; column += 1) this.cells[row][column] = entry;
      }
      return;
    }
    this.fill(x, y, width, height, ' ', style);
    for (let row = Math.max(0, y); row < bottom; row += 1) {
      for (let column = Math.max(0, x); column < right;) {
        const written = this.set(column, row, char, style);
        if (!written) break;
        column += written;
      }
    }
  }

  clone() {
    const copy = new CellGrid(this.columns, this.rows);
    // The retained front buffer owns physically distinct cell objects. This is
    // deliberately stronger than relying on writer convention: no mutation of
    // a submitted frame can alter the immutable comparison baseline.
    copy.cells = this.cells.map((row) => row.map((entry) => cell(entry.char, entry.style, entry.continuation)));
    copy.spinnerCells = new Set(this.spinnerCells);
    return copy;
  }

  confineSuspectStyleBoundaries() {
    // If an unmeasured width-1 suspect is rendered as width 2, a VT cannot
    // independently preserve that glyph cell and a differently styled next
    // cell. Make the fallback part of the intended grid before diffing and
    // diagnostics, so emitted bytes and recorded frames remain identical.
    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.columns - 1; x += 1) {
        const current = this.get(x, y);
        if (current.continuation || !isWidthSuspect(current.char)
          || graphemeWidth(current.char) !== 1 || hasGraphemeWidthOverride(current.char)) continue;
        const next = this.get(x + 1, y);
        if (next && next.styleKey !== current.styleKey) this.set(x, y, CHROME_GLYPHS.suspectFallback, current.style);
      }
    }
    return this;
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
    this.outputCapture = options.outputCapture || null;
    this.diagnostics = options.diagnostics || null;
    this.rawWriteOutput = options.writeOutput || this.outputCapture?.stdoutFacade?.write.bind(this.outputCapture.stdoutFacade) || this.output.write.bind(this.output);
    this.frameCounter = 0;
    this.lastPaintedCell = null;
    // Recording is a tee after the real write. Diagnostic I/O can be slow, but
    // can neither rewrite nor reorder the byte buffer handed to the terminal.
    this.writeOutput = (value, meta = {}) => {
      const result = this.rawWriteOutput(value);
      this.diagnostics?.recordBytes(value, { frame: meta.frame ?? this.frameCounter, context: meta.context || 'external' });
      return result;
    };
    this.errorOutput = options.errorOutput || this.outputCapture?.stderrFacade || process.stderr;
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
    this.restored = true;
    this.installLifecycle();
    try {
      this.resume();
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
    grid.confineSuspectStyleBoundaries();
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
        let cursorReliable = false;
        for (let x = start; x <= end; x += 1) {
          const current = grid.get(x, y);
          if (current.continuation) continue;
          const suspect = isWidthSuspect(current.char);
          const modeledWidth = Math.max(1, graphemeWidth(current.char));
          // Never allow the terminal's implicit cursor position after a
          // width-suspect grapheme to determine where another cell lands.
          // The suspect glyph is its own absolute-positioned run, and the next
          // base cell receives another CUP even when it is adjacent.
          if (!cursorReliable || suspect) output += cursorTo(y, x);
          // Suspect pre-clears always carry an explicit, absolute SGR for the
          // new frame owner. They never inherit a prior run's terminal state.
          if (current.styleKey !== activeStyle || suspect) {
            output += styleSequence(current.style, this.colorMode);
            activeStyle = current.styleKey;
          }
          if (suspect) {
            // A terminal (notably tmux in front of another emulator) may
            // render a suspect grapheme narrower than our width table. Since
            // continuation cells are intentionally not emitted as glyphs, an
            // old background could otherwise survive in the unconsumed half
            // of the modeled span. Claim the complete span with width-certain
            // spaces first, then draw the grapheme at the absolute base cell.
            // The existing guard below handles the opposite disagreement,
            // where the terminal renders the grapheme wider than our model.
            output += ' '.repeat(modeledWidth);
            output += cursorTo(y, x);
          }
          output += current.char || ' ';
          this.lastPaintedCell = { x, y, suspect };
          cursorReliable = !suspect;
          if (suspect) {
            // If the terminal consumes one more cell than our model, the
            // suspect glyph may temporarily cover the following intended
            // cell. Repaint that guard cell by absolute position immediately,
            // even when it was not otherwise dirty. The suspect itself may be
            // clipped by the terminal, but ordinary neighboring text cannot
            // remain displaced or overwritten.
            let guardX = x + modeledWidth;
            let guard = grid.get(guardX, y);
            while (guard && !guard.continuation) {
              const guardSuspect = isWidthSuspect(guard.char);
              output += cursorTo(y, guardX);
              if (guard.styleKey !== activeStyle) {
                output += styleSequence(guard.style, this.colorMode);
                activeStyle = guard.styleKey;
              }
              output += guard.char || ' ';
              this.lastPaintedCell = { x: guardX, y, suspect: guardSuspect };
              if (!guardSuspect) break;
              guardX += Math.max(1, graphemeWidth(guard.char));
              guard = grid.get(guardX, y);
            }
            // The ordinary loop may reach the guard again; force its duplicate
            // write to be absolute rather than relying on the guard cursor.
            cursorReliable = false;
          }
        }
        index += 1;
      }
    }
    this.frameCounter += 1;
    this.diagnostics?.setWidthOverrides(getGraphemeWidthOverrides());
    this.diagnostics?.nextFrame(grid, { colorMode: this.colorMode });
    if (output) {
      output += sequences.reset;
      this.writeOutput(output, { frame: this.frameCounter, context: 'frame' });
    }
    this.previous = grid.clone();
    return output;
  }

  suspend() {
    if (!this.started || this.restored) return false;
    this.restored = true;
    try {
      if (this.input.isTTY && typeof this.input.setRawMode === 'function') this.input.setRawMode(false);
    } catch {}
    try { if (typeof this.input.pause === 'function') this.input.pause(); } catch {}
    try { this.writeOutput(`${sequences.reset}${mouseReportingOff}${sequences.autowrapOn}${sequences.cursorShow}${sequences.alternateScreenOff}`, { context: 'restore' }); } catch {}
    this.outputCapture?.suspend();
    this.previous = null;
    return true;
  }

  resume() {
    if (!this.started || !this.restored) return false;
    this.restored = false;
    try {
      if (this.input.isTTY && typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
      if (typeof this.input.resume === 'function') this.input.resume();
      this.writeOutput(`${sequences.alternateScreenOn}${sequences.autowrapOff}${mouseReportingOn}${sequences.cursorHide}${sequences.clearScreen}${sequences.home}`, { context: 'startup' });
      this.outputCapture?.resume();
      this.previous = null;
      return true;
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  restore() {
    this.suspend();
  }

  stop() {
    this.restore();
    this.removeLifecycle();
    this.outputCapture?.stop();
    try { if (typeof this.input.pause === 'function') this.input.pause(); } catch {}
    this.diagnostics?.close();
  }

  markDiagnostic(message = 'owner saw ghost here') {
    return this.diagnostics?.mark(message, { cell: this.lastPaintedCell }) || null;
  }
}
