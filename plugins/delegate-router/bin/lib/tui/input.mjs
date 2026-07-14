const ESC = '\u001b';

const FIXED_SEQUENCES = Object.freeze([
  [`${ESC}[A`, 'up'], [`${ESC}[B`, 'down'], [`${ESC}[C`, 'right'], [`${ESC}[D`, 'left'],
  [`${ESC}[5~`, 'page-up'], [`${ESC}[6~`, 'page-down'],
  [`${ESC}[H`, 'home'], [`${ESC}[1~`, 'home'], [`${ESC}OH`, 'home'],
  [`${ESC}[F`, 'end'], [`${ESC}[4~`, 'end'], [`${ESC}OF`, 'end'],
  [`${ESC}[Z`, 'shift-tab'],
  ['\r', 'enter'], ['\n', 'enter'], ['\u007f', 'backspace'], ['\b', 'backspace'],
  ['\u0003', 'ctrl-c'], ['\u0007', 'ctrl-g'], ['\u0015', 'ctrl-u'], ['\t', 'tab']
].sort((left, right) => right[0].length - left[0].length));

const ESCAPE_PREFIXES = FIXED_SEQUENCES.map(([sequence]) => sequence).filter((sequence) => sequence.startsWith(ESC));

function mouseEvent(button, x, y, suffix) {
  if ((button & 64) !== 0) return suffix === 'M' ? ((button & 1) === 0 ? 'wheel-up' : 'wheel-down') : null;
  if (suffix !== 'M' || (button & 32) !== 0) return null;
  return { type: 'click', button: button & 3, x: Math.max(0, x - 1), y: Math.max(0, y - 1) };
}

export function decodeInput(value, options = {}) {
  const text = String(value || '');
  const events = [];
  let offset = 0;
  while (offset < text.length) {
    const rest = text.slice(offset);
    if (rest.startsWith(`${ESC}[<`)) {
      const match = rest.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (match) {
        const event = mouseEvent(Number(match[1]), Number(match[2]), Number(match[3]), match[4]);
        if (event) events.push(event);
        offset += match[0].length;
        continue;
      }
      if (!options.final) break;
    }
    let matched = false;
    for (const [sequence, key] of FIXED_SEQUENCES) {
      if (!rest.startsWith(sequence)) continue;
      events.push(key);
      offset += sequence.length;
      matched = true;
      break;
    }
    if (matched) continue;
    if (rest[0] === ESC) {
      const incomplete = ESCAPE_PREFIXES.some((sequence) => sequence.startsWith(rest)) || `${ESC}[<`.startsWith(rest);
      if (incomplete && !options.final) break;
      events.push('escape');
      offset += 1;
      continue;
    }
    const point = rest.codePointAt(0);
    const key = String.fromCodePoint(point);
    events.push(key);
    offset += key.length;
  }
  return { events, rest: text.slice(offset) };
}

export function coalesceInputEvents(events) {
  const coalesced = [];
  let scrollDelta = 0;
  const flushScroll = () => {
    if (scrollDelta) coalesced.push({ type: 'scroll', delta: scrollDelta });
    scrollDelta = 0;
  };
  for (const event of events || []) {
    // Arrow keys are logical selection steps. Do not collapse them into a
    // viewport scroll: the controller must visit one block per keypress even
    // when the viewport is already at its top or bottom limit. BufferedInput
    // still dispatches the whole burst in one animation tick, so preserving
    // the individual events does not add renders. Wheel input intentionally
    // remains viewport-only and may be coalesced to its net line delta.
    if (event === 'wheel-up') scrollDelta -= 3;
    else if (event === 'wheel-down') scrollDelta += 3;
    else {
      flushScroll();
      coalesced.push(event);
    }
  }
  flushScroll();
  return coalesced;
}

export class BufferedInput {
  constructor(options = {}) {
    this.onFlush = options.onFlush || (() => {});
    this.frameMs = Math.max(0, Number(options.frameMs ?? 16));
    this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel || ((handle) => clearTimeout(handle));
    this.raw = '';
    this.events = [];
    this.timer = null;
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    this.raw += Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
    const decoded = decodeInput(this.raw, { final: false });
    this.events.push(...decoded.events);
    this.raw = decoded.rest;
    if (this.timer == null) this.timer = this.schedule(() => this.flush(), this.frameMs);
  }

  flush() {
    if (this.closed) return [];
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    if (this.raw) {
      const decoded = decodeInput(this.raw, { final: true });
      this.events.push(...decoded.events);
      this.raw = decoded.rest;
    }
    const events = coalesceInputEvents(this.events);
    this.events = [];
    if (events.length) this.onFlush(events);
    return events;
  }

  close() {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    this.raw = '';
    this.events = [];
    this.closed = true;
  }
}
