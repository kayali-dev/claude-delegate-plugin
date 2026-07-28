const ESC = '\u001b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const FIXED_SEQUENCES = Object.freeze([
  [`${ESC}[A`, 'up'], [`${ESC}[B`, 'down'], [`${ESC}[C`, 'right'], [`${ESC}[D`, 'left'],
  [`${ESC}[5~`, 'page-up'], [`${ESC}[6~`, 'page-down'],
  [`${ESC}[H`, 'home'], [`${ESC}[1~`, 'home'], [`${ESC}OH`, 'home'],
  [`${ESC}[F`, 'end'], [`${ESC}[4~`, 'end'], [`${ESC}OF`, 'end'],
  [`${ESC}[Z`, 'shift-tab'],
  [`${ESC}[I`, 'focus-in'], [`${ESC}[O`, 'focus-out'],
  ['\r', 'enter'], ['\n', 'enter'], ['\u007f', 'backspace'], ['\b', 'backspace'],
  ['\u0003', 'ctrl-c'], ['\u0004', 'ctrl-d'], ['\u0007', 'ctrl-g'], ['\u0015', 'ctrl-u'], ['\t', 'tab']
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
    // A short prefix of the paste opener is also a prefix of the Escape key and
    // of every CSI sequence. Hold it only while more bytes may still arrive; at
    // final the ESC handler below must resolve it, or the byte is held forever
    // and the keypress only surfaces when the user next types something.
    if (rest.length < PASTE_START.length && PASTE_START.startsWith(rest) && !options.final) break;
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END, PASTE_START.length);
      if (end < 0) {
        if (!options.final) break;
        // Final means no further bytes are coming. A paste whose terminator was
        // lost is delivered as what was actually received; holding it back would
        // wedge every later keystroke behind a marker that will never arrive.
        events.push({ type: 'paste', text: rest.slice(PASTE_START.length) });
        offset = text.length;
        continue;
      }
      events.push({ type: 'paste', text: rest.slice(PASTE_START.length, end) });
      offset += end + PASTE_END.length;
      continue;
    }
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
      const incomplete = ESCAPE_PREFIXES.some((sequence) => sequence.startsWith(rest))
        || `${ESC}[<`.startsWith(rest);
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

// A held buffer is either a paste body (bounded by its terminator, which may be
// many chunks away) or an ambiguous escape prefix (bounded by the terminal's
// escape timeout). They are separate deadlines because a large paste legitimately
// spans far more time than a keypress ever may.
export const ESCAPE_TIMEOUT_MS = 50;
export const PASTE_IDLE_TIMEOUT_MS = 5000;

export function pendingHoldKind(raw) {
  if (!raw) return null;
  if (raw.startsWith(PASTE_START)) return 'paste-body';
  if (raw[0] === ESC) return 'escape-prefix';
  return 'other';
}

export class BufferedInput {
  constructor(options = {}) {
    this.onFlush = options.onFlush || (() => {});
    // Unambiguous keys do not need to wait for a display-frame boundary.
    // A zero-delay timer still batches chunks delivered in the same event-loop
    // turn, while escape prefixes and bracketed paste retain their independent
    // correctness deadlines below.
    this.frameMs = Math.max(0, Number(options.frameMs ?? 0));
    this.escapeTimeoutMs = Math.max(0, Number(options.escapeTimeoutMs ?? ESCAPE_TIMEOUT_MS));
    this.pasteIdleTimeoutMs = Math.max(0, Number(options.pasteIdleTimeoutMs ?? PASTE_IDLE_TIMEOUT_MS));
    this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel || ((handle) => clearTimeout(handle));
    this.now = options.now || (() => Date.now());
    this.raw = '';
    this.events = [];
    this.timer = null;
    this.timerKind = null;
    this.pendingSince = null;
    this.closed = false;
  }

  arm(delay, kind) {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = this.schedule(() => this.flush(), delay);
    this.timerKind = kind;
  }

  push(value) {
    if (this.closed) return;
    this.raw += Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
    const decoded = decodeInput(this.raw, { final: false });
    this.events.push(...decoded.events);
    this.raw = decoded.rest;
    // Idle semantics: every arriving byte restarts the hold, so a sequence split
    // across a slow link still coalesces, while silence resolves the ambiguity.
    this.pendingSince = this.raw ? this.now() : null;
    // A hold timer is a worst-case deadline, not a paint cadence. Once the
    // ambiguity is resolved, decoded events must not wait for it.
    if (this.timer == null || (this.timerKind === 'hold' && !this.raw && this.events.length)) {
      this.arm(this.frameMs, 'frame');
    }
  }

  flush() {
    if (this.closed) return [];
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    this.timerKind = null;
    if (this.raw) {
      const deadline = pendingHoldKind(this.raw) === 'paste-body' ? this.pasteIdleTimeoutMs : this.escapeTimeoutMs;
      const waited = this.now() - (this.pendingSince ?? this.now());
      if (waited < deadline) {
        // Still ambiguous and still inside the deadline: keep waiting for the
        // rest of the sequence, but on a timer, so input can never be held
        // indefinitely waiting for bytes that will never arrive.
        this.arm(Math.max(1, deadline - waited), 'hold');
      } else {
        const before = this.raw;
        const decoded = decodeInput(this.raw, { final: true });
        this.events.push(...decoded.events);
        this.raw = decoded.rest;
        this.pendingSince = this.raw ? this.now() : null;
        // Forward progress is the invariant that keeps a wedge impossible: a
        // final decode that consumed nothing would otherwise re-hold the same
        // bytes forever. Drop the leading byte rather than stall the keyboard.
        if (this.raw === before) {
          this.events.push(before[0]);
          this.raw = before.slice(1);
          this.pendingSince = this.raw ? this.now() : null;
        }
        if (this.raw) this.arm(this.escapeTimeoutMs, 'hold');
      }
    }
    const events = coalesceInputEvents(this.events);
    this.events = [];
    if (events.length) this.onFlush(events);
    return events;
  }

  close() {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    this.timerKind = null;
    this.raw = '';
    this.pendingSince = null;
    this.events = [];
    this.closed = true;
  }
}
