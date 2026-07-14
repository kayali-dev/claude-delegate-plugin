const ESC = '\u001b';

export const sequences = Object.freeze({
  alternateScreenOn: `${ESC}[?1049h`,
  alternateScreenOff: `${ESC}[?1049l`,
  cursorHide: `${ESC}[?25l`,
  cursorShow: `${ESC}[?25h`,
  autowrapOff: `${ESC}[?7l`,
  autowrapOn: `${ESC}[?7h`,
  mouseSgrOn: `${ESC}[?1006h`,
  mouseSgrOff: `${ESC}[?1006l`,
  mouseButtonOn: `${ESC}[?1000h`,
  mouseButtonOff: `${ESC}[?1000l`,
  mouseMotionOff: `${ESC}[?1003l`,
  clearScreen: `${ESC}[2J`,
  clearLine: `${ESC}[2K`,
  clearToEnd: `${ESC}[0J`,
  clearLineToEnd: `${ESC}[0K`,
  home: `${ESC}[H`,
  reset: `${ESC}[0m`
});

export const mouseReportingOn = `${sequences.mouseButtonOn}${sequences.mouseSgrOn}`;
export const mouseReportingOff = `${sequences.mouseMotionOff}${sequences.mouseButtonOff}${sequences.mouseSgrOff}`;

export function detectColorMode(env = process.env) {
  if (Object.hasOwn(env, 'NO_COLOR')) return 'none';
  const colorTerm = String(env.COLORTERM || '').toLowerCase();
  const term = String(env.TERM || '').toLowerCase();
  return /truecolor|24bit/.test(colorTerm) || /direct|truecolor/.test(term) ? 'truecolor' : '256';
}

export function cursorTo(row, column) {
  return `${ESC}[${Math.max(0, row) + 1};${Math.max(0, column) + 1}H`;
}

export function cursorUp(rows = 1) { return `${ESC}[${Math.max(1, rows)}A`; }
export function cursorDown(rows = 1) { return `${ESC}[${Math.max(1, rows)}B`; }
export function cursorForward(columns = 1) { return `${ESC}[${Math.max(1, columns)}C`; }
export function cursorBackward(columns = 1) { return `${ESC}[${Math.max(1, columns)}D`; }

function normalizeRgb(value) {
  if (value == null || value === 'default') return null;
  if (value && typeof value === 'object' && Array.isArray(value.rgb)) return normalizeRgb(value.rgb);
  if (Array.isArray(value) && value.length === 3) {
    return value.map((part) => Math.max(0, Math.min(255, Math.round(Number(part) || 0))));
  }
  return null;
}

export function rgbTo256(red, green, blue) {
  const [r, g, b] = [red, green, blue].map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const cube = (part) => Math.round((part / 255) * 5);
  return 16 + (36 * cube(r)) + (6 * cube(g)) + cube(b);
}

function colorCode(layer, value, mode) {
  if (value == null || value === 'default') return layer === 'fg' ? '39' : '49';
  if (value && typeof value === 'object' && Number.isInteger(value.index)) {
    if (mode !== 'truecolor' || !Array.isArray(value.rgb)) return `${layer === 'fg' ? 38 : 48};5;${value.index}`;
  }
  if (Number.isInteger(value) && value >= 0 && value <= 255) return `${layer === 'fg' ? 38 : 48};5;${value}`;
  const rgb = normalizeRgb(value);
  if (!rgb) return layer === 'fg' ? '39' : '49';
  if (mode === 'truecolor') return `${layer === 'fg' ? 38 : 48};2;${rgb.join(';')}`;
  return `${layer === 'fg' ? 38 : 48};5;${rgbTo256(...rgb)}`;
}

export function styleSequence(style = null, mode = detectColorMode()) {
  if (!style || Object.keys(style).length === 0) return sequences.reset;
  const codes = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.inverse) codes.push('7');
  if (mode !== 'none' && Object.hasOwn(style, 'fg')) codes.push(colorCode('fg', style.fg, mode));
  if (mode !== 'none' && Object.hasOwn(style, 'bg')) codes.push(colorCode('bg', style.bg, mode));
  // Cell styles are absolute descriptions, while SGR parameters are normally
  // cumulative. Reset first so bold/dim/color from an earlier run cannot leak
  // into a later run whose style simply omits that attribute.
  return `${ESC}[0${codes.length ? `;${codes.join(';')}` : ''}m`;
}

export function alternateScreen(enabled) {
  return enabled ? sequences.alternateScreenOn : sequences.alternateScreenOff;
}

export function cursorVisible(visible) {
  return visible ? sequences.cursorShow : sequences.cursorHide;
}
