import fs from 'node:fs';
import path from 'node:path';
import { ReplayVirtualTerminal } from './vt-model.mjs';
import { graphemeWidth, isWidthSuspect, splitGraphemes } from './width.mjs';

const BYTE_MAGIC = 'DELEGATE_TUI_BYTES_V1\n';

function monotonicTimestamp() {
  return process.hrtime.bigint().toString();
}

function safeAppend(file, value) {
  fs.appendFileSync(file, value, { mode: 0o600 });
}

export function serializeDiagnosticGrid(grid, options = {}) {
  const runs = [];
  let previous = null;
  for (let y = 0; y < grid.rows; y += 1) {
    for (let x = 0; x < grid.columns; x += 1) {
      const cell = grid.get(x, y);
      const token = { c: cell.char, s: cell.styleKey, k: cell.continuation ? 1 : 0 };
      if (previous && previous.c === token.c && previous.s === token.s && previous.k === token.k) previous.n += 1;
      else {
        previous = { ...token, n: 1 };
        runs.push(previous);
      }
    }
  }
  return { columns: grid.columns, rows: grid.rows, colorMode: options.colorMode || '256', widthOverrides: options.widthOverrides || {}, runs };
}

export function deserializeDiagnosticGrid(record) {
  const cells = [];
  for (const run of record.runs || []) {
    for (let count = 0; count < Number(run.n || 0); count += 1) cells.push({ char: run.c, styleKey: run.s, continuation: Boolean(run.k) });
  }
  if (cells.length !== record.columns * record.rows) throw new Error(`frame ${record.frame}: invalid grid cell count ${cells.length}`);
  return cells;
}

export class TuiFlightRecorder {
  constructor(directory, options = {}) {
    this.directory = path.resolve(String(directory));
    this.bytesFile = path.join(this.directory, 'bytes.log');
    this.framesFile = path.join(this.directory, 'frames.jsonl');
    this.frame = 0;
    this.closed = false;
    this.widthOverrides = {};
    this.onError = options.onError || (() => {});
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.bytesFile, BYTE_MAGIC, { mode: 0o600 });
    fs.writeFileSync(this.framesFile, '', { mode: 0o600 });
  }

  setWidthOverrides(values) {
    this.widthOverrides = { ...(values || {}) };
  }

  nextFrame(grid, options = {}) {
    this.frame += 1;
    const record = {
      type: 'frame', frame: this.frame, atNs: monotonicTimestamp(),
      ...serializeDiagnosticGrid(grid, { colorMode: options.colorMode, widthOverrides: this.widthOverrides })
    };
    try { safeAppend(this.framesFile, `${JSON.stringify(record)}\n`); }
    catch (error) { this.onError(error); }
    return this.frame;
  }

  recordBytes(value, options = {}) {
    if (this.closed) return;
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
    const header = {
      type: 'bytes', frame: Number(options.frame ?? this.frame), atNs: monotonicTimestamp(),
      context: String(options.context || 'external'), length: payload.length
    };
    try {
      safeAppend(this.bytesFile, Buffer.from(`@${JSON.stringify(header)}\n`, 'utf8'));
      safeAppend(this.bytesFile, payload);
      safeAppend(this.bytesFile, Buffer.from('\n', 'utf8'));
    } catch (error) { this.onError(error); }
  }

  mark(message = 'owner saw ghost here', details = {}) {
    const record = { type: 'marker', frame: this.frame, atNs: monotonicTimestamp(), message: String(message), ...details };
    try {
      safeAppend(this.framesFile, `${JSON.stringify(record)}\n`);
      safeAppend(this.bytesFile, Buffer.from(`@${JSON.stringify({ ...record, length: 0 })}\n\n`, 'utf8'));
    } catch (error) { this.onError(error); }
    return record;
  }

  close() { this.closed = true; }
}

export function readDiagnosticBytes(file) {
  const data = fs.readFileSync(file);
  const magic = Buffer.from(BYTE_MAGIC);
  if (!data.subarray(0, magic.length).equals(magic)) throw new Error('unsupported bytes.log format');
  const records = [];
  let offset = magic.length;
  while (offset < data.length) {
    if (data[offset] !== 0x40) throw new Error(`invalid byte-log header at offset ${offset}`);
    const newline = data.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('truncated byte-log header');
    const header = JSON.parse(data.subarray(offset + 1, newline).toString('utf8'));
    const start = newline + 1;
    const end = start + Number(header.length || 0);
    if (end > data.length) throw new Error(`truncated byte payload for frame ${header.frame}`);
    records.push({ ...header, payload: data.subarray(start, end), fileOffset: start });
    offset = end;
    if (data[offset] === 0x0a) offset += 1;
  }
  return records;
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

function expectedStyleKey(styleKey, mode) {
  let style = {};
  try { style = JSON.parse(styleKey || '{}'); } catch {}
  const result = {};
  for (const flag of ['bold', 'dim', 'italic', 'underline', 'inverse']) if (style[flag]) result[flag] = true;
  const fg = expectedColor(style.fg, mode);
  const bg = expectedColor(style.bg, mode);
  if (fg) result.fg = fg;
  if (bg) result.bg = bg;
  return JSON.stringify(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))));
}

function firstDifference(vt, frame) {
  const intended = deserializeDiagnosticGrid(frame);
  if (vt.columns !== frame.columns || vt.rows !== frame.rows) return { size: true, actual: `${vt.columns}x${vt.rows}`, expected: `${frame.columns}x${frame.rows}` };
  for (let index = 0; index < intended.length; index += 1) {
    const x = index % frame.columns;
    const y = Math.floor(index / frame.columns);
    const actual = vt.cells[y][x];
    const expected = intended[index];
    const style = expectedStyleKey(expected.styleKey, frame.colorMode);
    if (actual.char !== expected.char || actual.continuation !== expected.continuation || actual.style !== style) {
      return { x, y, actual, expected: { char: expected.char, continuation: expected.continuation, style } };
    }
  }
  return null;
}

function byteWindow(records, frame, cell = null) {
  const payload = Buffer.concat(records.filter((record) => record.type === 'bytes' && record.frame === frame && record.context === 'frame').map((record) => record.payload));
  if (!payload.length) return { hex: '(no emitted bytes)', ascii: '(no emitted bytes)' };
  let center = Math.floor(payload.length / 2);
  if (cell && Number.isInteger(cell.y)) {
    const rowPrefix = Buffer.from(`\u001b[${cell.y + 1};`);
    const found = payload.lastIndexOf(rowPrefix);
    if (found >= 0) center = found;
  }
  const start = Math.max(0, center - 48);
  const end = Math.min(payload.length, center + 96);
  const window = payload.subarray(start, end);
  return {
    hex: [...window].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    ascii: [...window].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')
  };
}

function suspectByteWindow(records, frame) {
  const payload = Buffer.concat(records.filter((record) => record.type === 'bytes' && record.frame === frame && record.context === 'frame').map((record) => record.payload));
  const text = payload.toString('utf8');
  const grapheme = splitGraphemes(text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')).find((value) => isWidthSuspect(value));
  if (!grapheme) return null;
  const center = payload.indexOf(Buffer.from(grapheme));
  const start = Math.max(0, center - 48);
  const end = Math.min(payload.length, center + Buffer.byteLength(grapheme) + 96);
  const window = payload.subarray(start, end);
  return {
    grapheme,
    hex: [...window].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    ascii: [...window].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')
  };
}

export function analyzeTuiDiagnostics(directory) {
  const root = path.resolve(String(directory));
  const byteRecords = readDiagnosticBytes(path.join(root, 'bytes.log'));
  const jsonRecords = fs.readFileSync(path.join(root, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const frames = jsonRecords.filter((record) => record.type === 'frame').sort((left, right) => left.frame - right.frame);
  const markers = jsonRecords.filter((record) => record.type === 'marker');
  if (!frames.length) return 'Delegate TUI diagnostic analysis\nNo frames were recorded.';
  let overrides = frames[0].widthOverrides || {};
  const widthOf = (grapheme) => Object.hasOwn(overrides, grapheme) ? Number(overrides[grapheme]) : graphemeWidth(grapheme);
  const terminal = new ReplayVirtualTerminal(frames[0].columns, frames[0].rows, { widthOf });
  for (const record of byteRecords.filter((record) => record.type === 'bytes' && record.frame === 0 && record.context !== 'restore')) terminal.apply(record.payload);
  const results = new Map();
  const lines = ['Delegate TUI diagnostic analysis', `frames: ${frames.length}; markers: ${markers.length}`];
  for (const frame of frames) {
    overrides = frame.widthOverrides || {};
    if (terminal.columns !== frame.columns || terminal.rows !== frame.rows) terminal.resize(frame.columns, frame.rows);
    let parseError = null;
    for (const record of byteRecords.filter((entry) => entry.type === 'bytes' && entry.frame === frame.frame && entry.context === 'frame')) {
      try { terminal.apply(record.payload); }
      catch (error) { parseError = error; break; }
    }
    const difference = parseError ? { parser: parseError.message, offset: parseError.offset } : firstDifference(terminal, frame);
    results.set(frame.frame, difference);
    if (difference) {
      const window = byteWindow(byteRecords, frame.frame, difference);
      lines.push(`frame ${frame.frame}: WRITER BUG at ${difference.x ?? '?'}:${difference.y ?? '?'} ${JSON.stringify(difference)}`);
      lines.push(`  hex: ${window.hex}`);
      lines.push(`  ascii: ${window.ascii}`);
    } else lines.push(`frame ${frame.frame}: agreement`);
  }
  for (const marker of markers) {
    const difference = results.get(marker.frame);
    const window = byteWindow(byteRecords, marker.frame, marker.cell || difference);
    if (difference) lines.push(`MARKER frame ${marker.frame}: WRITER BUG verdict (${marker.message})`);
    else lines.push(`MARKER frame ${marker.frame}: TERMINAL-SIDE INTERPRETATION verdict; bytes paint the intended frame (${marker.message})`);
    lines.push(`  hex: ${window.hex}`);
    lines.push(`  ascii: ${window.ascii}`);
    if (!difference) {
      const suspect = suspectByteWindow(byteRecords, marker.frame);
      if (suspect) {
        lines.push(`  earlier width-suspect signature: ${JSON.stringify(suspect.grapheme)}`);
        lines.push(`  suspect hex: ${suspect.hex}`);
        lines.push(`  suspect ascii: ${suspect.ascii}`);
      }
    }
  }
  return lines.join('\n');
}
