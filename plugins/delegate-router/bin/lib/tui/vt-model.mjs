import { graphemeWidth, splitGraphemes } from './width.mjs';

function stable(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function blankCell(style = '{}') {
  return { char: ' ', continuation: false, style };
}

function blankGrid(columns, rows, style = '{}') {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => blankCell(style)));
}

export class ReplayVirtualTerminal {
  constructor(columns, rows, options = {}) {
    this.columns = Math.max(1, Number(columns) || 1);
    this.rows = Math.max(1, Number(rows) || 1);
    this.widthOf = options.widthOf || graphemeWidth;
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
  styleKey() { return stable(this.style); }
  clearPendingWrap() { this.pendingWrap = false; }

  resize(columns, rows) {
    this.columns = Math.max(1, Number(columns) || 1);
    this.rows = Math.max(1, Number(rows) || 1);
    this.main = blankGrid(this.columns, this.rows);
    this.alternate = blankGrid(this.columns, this.rows);
    this.x = 0;
    this.y = 0;
    this.pendingWrap = false;
  }

  scrollUp() {
    this.cells.shift();
    this.cells.push(Array.from({ length: this.columns }, () => blankCell(this.styleKey())));
    this.y = this.rows - 1;
  }

  eraseGlyphAt(x, y, style = this.styleKey()) {
    if (x < 0 || x >= this.columns || y < 0 || y >= this.rows) return;
    let base = x;
    while (base > 0 && this.cells[y][base].continuation) base -= 1;
    const width = Math.max(1, Number(this.widthOf(this.cells[y][base].char)) || 1);
    for (let offset = 0; offset < width && base + offset < this.columns; offset += 1) this.cells[y][base + offset] = blankCell(style);
  }

  write(grapheme) {
    const width = Math.max(0, Number(this.widthOf(grapheme)) || 0);
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
    for (let offset = 1; offset < width && this.x + offset < this.columns; offset += 1) this.cells[this.y][this.x + offset] = { char: '', continuation: true, style };
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
    } else if (mode === 0) {
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

  apply(value) {
    const output = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
    let offset = 0;
    while (offset < output.length) {
      if (output[offset] === '\u001b') {
        const match = /^\u001b\[([?]?)([0-9;:]*)([ -/]*)?([@-~])/.exec(output.slice(offset));
        if (!match) throw Object.assign(new Error(`unsupported escape at ${offset}`), { offset });
        const [, privatePrefix, parameters, , command] = match;
        if ((command === 'h' || command === 'l') && privatePrefix === '?') this.privateMode(parameters, command === 'h');
        else if (command === 'H' || command === 'f') {
          const values = parameters.split(';');
          this.y = Math.max(0, Math.min(this.rows - 1, Number(values[0] || 1) - 1));
          this.x = Math.max(0, Math.min(this.columns - 1, Number(values[1] || 1) - 1));
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
        else if (command !== 'n') throw Object.assign(new Error(`unsupported CSI ${JSON.stringify(match[0])}`), { offset });
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
}

