import { truncateToWidth } from './width.mjs';
import { CHROME_SEPARATOR } from './glyphs.mjs';

const DEFAULT_MAX_LENGTH = 2048;

function jsonReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (value == null) return '';
    if (typeof value === 'number' && !Number.isFinite(value)) return '';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function' || typeof value === 'symbol') return '';
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

function bounded(value, maximum) {
  const text = String(value || '');
  const limit = Math.max(1, Math.floor(Number(maximum || DEFAULT_MAX_LENGTH)));
  if (text.length <= limit) return text;
  const marker = '.'.repeat(Math.min(3, limit));
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

// The only TUI conversion boundary for values originating in records or
// journals. It never relies on Object.prototype.toString, so structured
// provider fields cannot leak as "[object Object]".
export function formatDisplayValue(value, options = {}) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(' ');
  if (typeof value === 'object' || Array.isArray(value)) {
    try {
      const rendered = JSON.stringify(value, jsonReplacer(), Math.max(0, Number(options.space || 0)));
      return bounded(rendered || '', options.maxLength);
    } catch {
      return '';
    }
  }
  return '';
}

// Multi-line panes preserve real line boundaries, expand tabs deterministically,
// and remove terminal control bytes. Literal backslash sequences (for example
// the two characters "\\n" in source code) are deliberately left untouched.
export function formatMultilineDisplayValue(value, options = {}) {
  const tabSize = Math.max(1, Math.min(16, Math.floor(Number(options.tabSize || 4))));
  return formatDisplayValue(value, options)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' '.repeat(tabSize))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function displayOr(value, fallback = '') {
  const rendered = formatDisplayValue(value);
  return rendered || fallback;
}

export function joinDisplayParts(parts, separator = CHROME_SEPARATOR) {
  return (parts || []).map((part) => formatDisplayValue(part)).filter(Boolean).join(separator);
}

export function formatTimestamp(value, options = {}) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return '';
  const mode = options.mode === 'relative' ? 'relative' : 'absolute';
  if (mode === 'absolute') {
    try { return new Date(at).toISOString().slice(11, 19); }
    catch { return ''; }
  }
  const now = Number(options.now);
  if (!Number.isFinite(now) || now <= 0) return '';
  const delta = now - at;
  const amount = Math.abs(delta);
  let label;
  if (amount < 1000) label = 'now';
  else if (amount < 60_000) label = `${Math.floor(amount / 1000)}s`;
  else if (amount < 3_600_000) label = `${Math.floor(amount / 60_000)}m`;
  else if (amount < 172_800_000) label = `${Math.floor(amount / 3_600_000)}h`;
  else label = `${Math.floor(amount / 86_400_000)}d`;
  if (label === 'now') return label;
  return delta >= 0 ? `${label} ago` : `in ${label}`;
}

export function ellipsisDisplayValue(value, columns) {
  return truncateToWidth(formatDisplayValue(value), columns, { ellipsis: true });
}
