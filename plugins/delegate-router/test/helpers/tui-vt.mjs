import assert from 'node:assert/strict';
import { graphemeWidth, splitGraphemes } from '../../bin/lib/tui/width.mjs';

function stable(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function blankCell(style = '{}') {
  return { char: ' ', continuation: false, style };
}

function blankGrid(columns, rows, style = '{}') {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => blankCell(style)));
}

function expectedColor(value, mode) {
  if (value == null || value === 'default' || mode === 'none') return null;
  if (typeof value === 'number') return `256:${value}`;
  if (value && typeof value === 'object') {
    if (mode === 'truecolor' && Array.isArray(value.rgb)) return `rgb:${value.rgb.join(',')}`;
    if (Number.isInteger(value.index)) return `256:${value.index}`;
    if (Array.isArray(value.rgb)) return `rgb:${value.rgb.join(',')}`;
  }
  return null;
}

export function expectedStyleKey(style = {}, mode = '256') {
  const result = {};
  for (const flag of ['bold', 'dim', 'italic', 'underline', 'inverse']) if (style[flag]) result[flag] = true;
  const fg = expectedColor(style.fg, mode);
  const bg = expectedColor(style.bg, mode);
  if (fg) result.fg = fg;
  if (bg) result.bg = bg;
  return stable(result);
}

// Minimal byte-level VT used only by the tests. It interprets the exact CSI
// surface emitted by screen.mjs and models delayed autowrap plus bottom scroll.
export class ByteVirtualTerminal {
  constructor(columns, rows) {
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.style = {};
    this.autowrap = true;
    this.cursorVisible = true;
    this.inAlternate = false;
    this.savedCursor = { x: 0, y: 0 };
    this.main = blankGrid(this.columns, this.rows);
    this.alternate = blankGrid(this.columns, this.rows);
    this.x = 0;
    this.y = 0;
    this.pendingWrap = false;
  }

  get cells() { return this.inAlternate ? this.alternate : this.main; }

  resize(columns, rows) {
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.main = blankGrid(this.columns, this.rows);
    this.alternate = blankGrid(this.columns, this.rows);
    this.x = 0;
    this.y = 0;
    this.pendingWrap = false;
  }

  styleKey() { return stable(this.style); }

  clearPendingWrap() { this.pendingWrap = false; }

  scrollUp() {
    this.cells.shift();
    this.cells.push(Array.from({ length: this.columns }, () => blankCell(this.styleKey())));
    this.y = this.rows - 1;
  }

  eraseGlyphAt(x, y, style = this.styleKey()) {
    if (x < 0 || x >= this.columns || y < 0 || y >= this.rows) return;
    let base = x;
    while (base > 0 && this.cells[y][base].continuation) base -= 1;
    const width = Math.max(1, graphemeWidth(this.cells[y][base].char));
    for (let offset = 0; offset < width && base + offset < this.columns; offset += 1) this.cells[y][base + offset] = blankCell(style);
  }

  write(grapheme) {
    const width = Math.max(0, graphemeWidth(grapheme));
    if (!width) return;
    if (this.pendingWrap) {
      if (this.autowrap) {
        this.x = 0;
        this.y += 1;
        if (this.y >= this.rows) this.scrollUp();
      }
      this.pendingWrap = false;
    }
    if (this.y < 0 || this.y >= this.rows || this.x < 0) return;
    if (this.x + width > this.columns) {
      if (!this.autowrap) return;
      this.x = 0;
      this.y += 1;
      if (this.y >= this.rows) this.scrollUp();
    }
    const style = this.styleKey();
    for (let offset = 0; offset < width; offset += 1) this.eraseGlyphAt(this.x + offset, this.y, style);
    this.cells[this.y][this.x] = { char: grapheme, continuation: false, style };
    for (let offset = 1; offset < width; offset += 1) this.cells[this.y][this.x + offset] = { char: '', continuation: true, style };
    if (this.x + width >= this.columns) {
      this.x = this.columns - 1;
      this.pendingWrap = this.autowrap;
    } else this.x += width;
  }

  sgr(parameters) {
    const values = parameters === '' ? [0] : parameters.split(';').map((value) => Number(value || 0));
    for (let index = 0; index < values.length; index += 1) {
      const code = values[index];
      if (code === 0) this.style = {};
      else if (code === 1) this.style.bold = true;
      else if (code === 2) this.style.dim = true;
      else if (code === 3) this.style.italic = true;
      else if (code === 4) this.style.underline = true;
      else if (code === 7) this.style.inverse = true;
      else if (code === 22) { delete this.style.bold; delete this.style.dim; }
      else if (code === 23) delete this.style.italic;
      else if (code === 24) delete this.style.underline;
      else if (code === 27) delete this.style.inverse;
      else if (code === 39) delete this.style.fg;
      else if (code === 49) delete this.style.bg;
      else if ((code === 38 || code === 48) && values[index + 1] === 5) {
        this.style[code === 38 ? 'fg' : 'bg'] = `256:${values[index + 2]}`;
        index += 2;
      } else if ((code === 38 || code === 48) && values[index + 1] === 2) {
        this.style[code === 38 ? 'fg' : 'bg'] = `rgb:${values.slice(index + 2, index + 5).join(',')}`;
        index += 4;
      }
    }
  }

  privateMode(parameters, enabled) {
    for (const mode of parameters.split(';').filter(Boolean).map(Number)) {
      if (mode === 7) {
        this.autowrap = enabled;
        if (!enabled) this.pendingWrap = false;
      } else if (mode === 25) this.cursorVisible = enabled;
      else if (mode === 1049 && enabled) {
        this.savedCursor = { x: this.x, y: this.y };
        this.alternate = blankGrid(this.columns, this.rows);
        this.inAlternate = true;
        this.x = 0;
        this.y = 0;
        this.pendingWrap = false;
      } else if (mode === 1049 && !enabled) {
        this.inAlternate = false;
        this.x = Math.min(this.columns - 1, this.savedCursor.x);
        this.y = Math.min(this.rows - 1, this.savedCursor.y);
        this.pendingWrap = false;
      }
    }
  }

  eraseDisplay(mode) {
    const style = this.styleKey();
    if (mode === 2) {
      const replacement = blankGrid(this.columns, this.rows, style);
      if (this.inAlternate) this.alternate = replacement;
      else this.main = replacement;
      return;
    }
    if (mode === 0) {
      for (let row = this.y; row < this.rows; row += 1) {
        const start = row === this.y ? this.x : 0;
        for (let column = start; column < this.columns; column += 1) this.cells[row][column] = blankCell(style);
      }
    }
  }

  eraseLine(mode) {
    const style = this.styleKey();
    const start = mode === 1 || mode === 2 ? 0 : this.x;
    const end = mode === 0 ? this.columns - 1 : mode === 1 ? this.x : this.columns - 1;
    for (let column = start; column <= end; column += 1) this.cells[this.y][column] = blankCell(style);
  }

  apply(output) {
    let offset = 0;
    while (offset < output.length) {
      if (output[offset] === '\u001b') {
        const match = /^\u001b\[([?]?)([0-9;:]*)([ -/]*)?([@-~])/.exec(output.slice(offset));
        if (!match) throw new Error(`unsupported escape at ${offset}: ${JSON.stringify(output.slice(offset, offset + 16))}`);
        const [, privatePrefix, parameters, , command] = match;
        if ((command === 'h' || command === 'l') && privatePrefix === '?') this.privateMode(parameters, command === 'h');
        else if (command === 'H' || command === 'f') {
          const values = parameters.split(';');
          const row = Number(values[0] || 1);
          const column = Number(values[1] || 1);
          this.y = Math.max(0, Math.min(this.rows - 1, row - 1));
          this.x = Math.max(0, Math.min(this.columns - 1, column - 1));
          this.clearPendingWrap();
        } else if (command === 'A' || command === 'B' || command === 'C' || command === 'D') {
          const amount = Math.max(1, Number(parameters || 1));
          if (command === 'A') this.y = Math.max(0, this.y - amount);
          if (command === 'B') this.y = Math.min(this.rows - 1, this.y + amount);
          if (command === 'C') this.x = Math.min(this.columns - 1, this.x + amount);
          if (command === 'D') this.x = Math.max(0, this.x - amount);
          this.clearPendingWrap();
        } else if (command === 'J') this.eraseDisplay(Number(parameters || 0));
        else if (command === 'K') this.eraseLine(Number(parameters || 0));
        else if (command === 'm') this.sgr(parameters);
        else throw new Error(`unsupported CSI ${JSON.stringify(match[0])}`);
        offset += match[0].length;
        continue;
      }
      const nextEscape = output.indexOf('\u001b', offset);
      const chunk = output.slice(offset, nextEscape < 0 ? output.length : nextEscape);
      for (const grapheme of splitGraphemes(chunk)) {
        if (grapheme === '\n') {
          this.y += 1;
          if (this.y >= this.rows) this.scrollUp();
          this.pendingWrap = false;
        } else if (grapheme === '\r') {
          this.x = 0;
          this.pendingWrap = false;
        } else this.write(grapheme);
      }
      offset += chunk.length;
    }
  }

  snapshot() {
    return this.cells.map((row) => row.map((cell) => `${cell.continuation ? '»' : cell.char}\u0000${cell.style}`).join('\u0001')).join('\n');
  }
}

export function firstGridDifference(vt, grid, colorMode = '256') {
  if (vt.columns !== grid.columns || vt.rows !== grid.rows) return { size: true };
  for (let y = 0; y < grid.rows; y += 1) {
    for (let x = 0; x < grid.columns; x += 1) {
      const actual = vt.cells[y][x];
      const cell = grid.get(x, y);
      const expected = { char: cell.char, continuation: cell.continuation, style: expectedStyleKey(cell.style, colorMode) };
      if (actual.char !== expected.char || actual.continuation !== expected.continuation || actual.style !== expected.style) {
        return { x, y, actual, expected };
      }
    }
  }
  return null;
}

export function assertVtMatchesGrid(vt, grid, context = '', colorMode = '256') {
  const difference = firstGridDifference(vt, grid, colorMode);
  assert.equal(difference, null, `${context} VT/grid mismatch: ${JSON.stringify(difference)}`);
}
