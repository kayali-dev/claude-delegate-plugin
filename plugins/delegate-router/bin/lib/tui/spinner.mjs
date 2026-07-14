import { CHROME_GLYPHS, spinnerGlyph } from './glyphs.mjs';

export const SPINNER_INTERVAL_MS = 100;

export function advanceSpinnerGrid(grid, now = Date.now()) {
  if (!grid?.spinnerCells?.size) return null;
  const next = grid.clone();
  const glyph = spinnerGlyph(now);
  for (const [x, y] of next.spinnerPositions()) {
    const current = next.get(x, y);
    if (!current) continue;
    next.set(x, y, glyph, current.style);
    next.markSpinner(x, y);
  }
  return next;
}

export class SpinnerAnimator {
  constructor(options = {}) {
    this.intervalMs = Math.max(16, Number(options.intervalMs || SPINNER_INTERVAL_MS));
    this.onTick = options.onTick || (() => {});
    this.setInterval = options.setInterval || globalThis.setInterval;
    this.clearInterval = options.clearInterval || globalThis.clearInterval;
    this.now = options.now || Date.now;
    this.timer = null;
  }

  setActive(active) {
    if (!active) {
      if (this.timer) this.clearInterval(this.timer);
      this.timer = null;
      return false;
    }
    if (this.timer) return true;
    this.timer = this.setInterval(() => this.onTick(this.now()), this.intervalMs);
    this.timer?.unref?.();
    return true;
  }

  stop() {
    this.setActive(false);
  }

  get active() {
    return Boolean(this.timer);
  }
}

export function isSpinnerGlyph(value) {
  return CHROME_GLYPHS.spinnerFrames.includes(value);
}
