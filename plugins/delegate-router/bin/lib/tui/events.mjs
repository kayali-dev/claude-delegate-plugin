import { formatDisplayValue, formatTimestamp } from './display.mjs';
import { CHROME_GLYPHS } from './glyphs.mjs';
import { uiPalette as palette } from './palette.mjs';
import { displayWidth, truncateToWidth, wrapToWidth } from './width.mjs';

const blockCache = new WeakMap();

export function eventCategory(type = '') {
  const value = formatDisplayValue(type).toLowerCase();
  if (/error|failed|violation/.test(value)) return 'error';
  if (/approval|budget|warning|retry|correction/.test(value)) return 'warning';
  if (value.startsWith('message.') || value === 'activity') return 'message';
  if (value.startsWith('tool.') || value === 'file.changed') return 'tool';
  if (value.startsWith('usage.')) return 'usage';
  return 'other';
}

export function eventTagStyle(block) {
  const category = eventCategory(block?.event?.type);
  if (category === 'error') return palette.eventTagError;
  if (category === 'warning') return palette.eventTagWarning;
  if (category === 'message') return palette.eventTagMessage;
  if (category === 'tool') return palette.eventTagTool;
  if (category === 'usage') return palette.eventTagUsage;
  return palette.dim;
}

export function eventBlocks(events = [], filter = '') {
  const query = formatDisplayValue(filter).toLowerCase();
  let views = blockCache.get(events);
  if (!views) {
    views = new Map();
    blockCache.set(events, views);
  }
  if (views.has(query)) return views.get(query);
  const filtered = events.filter((event) => !query || formatDisplayValue(event?.type).toLowerCase().includes(query));
  const blocks = filtered.map((event, index) => Object.freeze({
    event,
    key: `${Number(event?.seq || 0)}:${formatDisplayValue(event?.type)}`,
    gapAfter: index < filtered.length - 1 && filtered[index + 1]?.type !== event?.type
  }));
  views.set(query, blocks);
  return blocks;
}

function payloadValue(event) {
  if (event?.data !== undefined) return event.data;
  const { seq: _seq, at: _at, type: _type, jobId: _jobId, ...rest } = event || {};
  return rest;
}

function safeJsonValue(value, seen = new WeakSet()) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return formatDisplayValue(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => safeJsonValue(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeJsonValue(entry, seen)]));
}

function json(value, space = 0) {
  try {
    const rendered = JSON.stringify(safeJsonValue(value), null, space);
    return rendered == null ? '' : rendered;
  } catch {
    return formatDisplayValue(value, { maxLength: 16_384 });
  }
}

function headerParts(block, options = {}) {
  const event = block.event || {};
  const seq = formatDisplayValue(event.seq || 0).padStart(6);
  const time = (formatTimestamp(Number(event.at || 0), { mode: options.timestampMode, now: options.now }) || '-').padStart(9);
  const type = formatDisplayValue(event.type || 'event');
  return { seq, time, type };
}

function styledJsonSegments(text) {
  const value = formatDisplayValue(text);
  const result = [];
  const pattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) result.push({ text: value.slice(offset, match.index), style: palette.body });
    const token = match[0];
    const after = value.slice(match.index + token.length);
    const style = token.startsWith('"') && /^\s*:/.test(after) ? palette.jsonKey
      : token.startsWith('"') ? palette.jsonString
        : /^(?:true|false|null)$/.test(token) ? palette.jsonLiteral : palette.jsonNumber;
    result.push({ text: token, style });
    offset = match.index + token.length;
  }
  if (offset < value.length) result.push({ text: value.slice(offset), style: palette.body });
  return result.length ? result : [{ text: value, style: palette.body }];
}

export function formatEventBlock(block) {
  const event = block?.event || {};
  return `${formatDisplayValue(event.seq)} ${formatDisplayValue(event.type)} ${json(payloadValue(event))}`;
}

export function wrapEventBlock(block, width, _formatted, options = {}) {
  const columns = Math.max(1, Number(width || 1));
  const expanded = options.expandedEvents instanceof Set && options.expandedEvents.has(block.key);
  const { seq, time, type } = headerParts(block, options);
  const tagWidth = Math.max(8, Math.min(26, Math.floor(columns * 0.3)));
  const tag = truncateToWidth(`[${type}]`, tagWidth, { ellipsis: true }).padEnd(tagWidth);
  const header = `${seq} ${time} ${tag}`;
  const fragments = [{
    text: header,
    sourceText: header,
    start: 0,
    end: header.length,
    lineKind: `event-${eventCategory(type)}`,
    segments: [
      { text: seq, style: palette.eventSeq },
      { text: ` ${time} `, style: palette.dim },
      { text: tag, style: eventTagStyle(block) }
    ]
  }];
  const rawPayload = payloadValue(block.event);
  const compact = json(rawPayload);
  let logicalOffset = header.length + 1;
  if (compact) {
    if (expanded) {
      const pretty = json(rawPayload, 2);
      for (const line of pretty.split('\n')) {
        const wrapped = wrapToWidth(`  ${line}`, columns);
        for (const piece of wrapped.lines) {
          fragments.push({
            text: piece, sourceText: piece, start: logicalOffset, end: logicalOffset + piece.length,
            lineKind: 'event-payload', segments: styledJsonSegments(piece)
          });
          logicalOffset += piece.length + 1;
        }
      }
    } else {
      const limit = Math.max(1, columns - 2);
      const clipped = truncateToWidth(compact, limit, { ellipsis: true });
      const text = `  ${clipped}`;
      fragments.push({
        text, sourceText: text, start: logicalOffset, end: logicalOffset + text.length,
        lineKind: 'event-payload', segments: styledJsonSegments(text)
      });
      logicalOffset += text.length + 1;
    }
  }
  if (block.gapAfter) fragments.push({ text: '', sourceText: '', start: logicalOffset, end: logicalOffset, lineKind: 'gap' });
  const value = `${header}\n${compact}`;
  return { value, fragments, lines: fragments.map((fragment) => fragment.text) };
}

export function eventBlockExpanded(block, expandedEvents) {
  return expandedEvents instanceof Set && expandedEvents.has(block?.key);
}

export function eventFrameWidth(block, options = {}) {
  const { seq, time, type } = headerParts(block, options);
  return displayWidth(`${seq} ${time} [${type}]`);
}

export { CHROME_GLYPHS };
