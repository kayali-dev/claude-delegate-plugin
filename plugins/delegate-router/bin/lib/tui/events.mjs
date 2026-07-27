import { formatDisplayValue, formatTimestamp } from './display.mjs';
import { CHROME_GLYPHS } from './glyphs.mjs';
import { uiPalette as palette } from './palette.mjs';
import { displayWidth, padToWidth, truncateToWidth, wrapToWidth } from './width.mjs';

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
    gapAfter: index < filtered.length - 1
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
    const style = token.startsWith('"') && /^\s*:/.test(after) ? palette.dim : palette.body;
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

function eventMeasure(event = {}) {
  const data = event.data || {};
  const values = [];
  const exitCode = Number(data.exitCode ?? data.exit_code ?? data.item?.exitCode ?? data.item?.exit_code);
  if (Number.isFinite(exitCode)) values.push(`exit ${Math.trunc(exitCode)}`);
  const duration = Number(data.durationMs ?? data.duration_ms ?? data.item?.durationMs ?? data.item?.duration_ms);
  if (Number.isFinite(duration) && duration >= 0) {
    if (duration < 1000) values.push('<1s');
    else if (duration < 60_000) values.push(`${Math.floor(duration / 1000)}s`);
    else values.push(`${Math.floor(duration / 60_000)}m${String(Math.floor(duration / 1000) % 60).padStart(2, '0')}s`);
  }
  const added = Number(data.added ?? data.additions ?? data.change?.added);
  const removed = Number(data.removed ?? data.deletions ?? data.change?.removed);
  if (Number.isFinite(added) || Number.isFinite(removed)) {
    values.push(`+${Number.isFinite(added) ? Math.max(0, Math.trunc(added)) : 0} ${CHROME_GLYPHS.minus}${Number.isFinite(removed) ? Math.max(0, Math.trunc(removed)) : 0}`);
  }
  return values.join(' ');
}

function eventRail(category, hasPayload) {
  if (category === 'message') return CHROME_GLYPHS.railMessage;
  if (category === 'tool') return hasPayload ? CHROME_GLYPHS.railBranch : CHROME_GLYPHS.railEnd;
  return CHROME_GLYPHS.railSystem;
}

function railRow({ time = '', rail, content = '', measure = '', width, segments = null, kind = 'event', first = true }) {
  const timeWidth = width >= 44 ? 9 : 0;
  const railWidth = Math.min(2, Math.max(1, width - timeWidth - 1));
  const measureWidth = width >= 60 ? 14 : width >= 44 ? 9 : 0;
  const separators = (timeWidth ? 1 : 0) + 1 + (measureWidth ? 1 : 0);
  const contentWidth = Math.max(1, width - timeWidth - railWidth - measureWidth - separators);
  const timeText = timeWidth ? `${padToWidth(first ? truncateToWidth(time, timeWidth, { ellipsis: true }) : '', timeWidth)} ` : '';
  const railText = `${padToWidth(truncateToWidth(rail, railWidth, { ellipsis: false }), railWidth)} `;
  const ownsMeasure = Boolean(measureWidth && first && measure);
  const clippedContent = truncateToWidth(content, contentWidth, { ellipsis: true });
  const contentText = ownsMeasure ? padToWidth(clippedContent, contentWidth) : clippedContent;
  const measureText = ownsMeasure ? ` ${padToWidth(truncateToWidth(measure, measureWidth, { ellipsis: true }), measureWidth, 'right')}` : '';
  const text = `${timeText}${railText}${contentText}${measureText}`;
  const contentSegments = segments && displayWidth(segments.map((segment) => segment.text).join('')) <= contentWidth
    ? [...segments, ...(ownsMeasure ? [{ text: ' '.repeat(contentWidth - displayWidth(segments.map((segment) => segment.text).join(''))) }] : [])]
    : [{ text: contentText }];
  return {
    text,
    sourceText: text,
    lineKind: kind,
    segments: [
      ...(timeWidth ? [{ text: timeText, style: palette.dim }] : []),
      { text: railText, style: kind === 'event-error' ? palette.failed : kind === 'event-warning' ? palette.badgeWarn : palette.metadata },
      ...contentSegments,
      ...(ownsMeasure ? [{ text: measureText, style: kind === 'event-error' ? palette.failed : palette.dim }] : [])
    ]
  };
}

export function wrapEventBlock(block, width, _formatted, options = {}) {
  const columns = Math.max(1, Number(width || 1));
  const expanded = options.expandedEvents instanceof Set && options.expandedEvents.has(block.key);
  const { seq, time, type } = headerParts(block, options);
  const rawPayload = payloadValue(block.event);
  const compact = json(rawPayload);
  const category = eventCategory(type);
  const terminalSuccess = /(?:completed|succeeded|resolved)$/.test(type);
  const failed = category === 'error';
  const marker = failed ? CHROME_GLYPHS.failure : terminalSuccess ? CHROME_GLYPHS.success : '';
  const headerContent = `${marker ? `${marker} ` : ''}#${seq.trim()} ${type}`;
  const header = railRow({
    time,
    rail: eventRail(category, Boolean(compact)),
    content: headerContent,
    measure: eventMeasure(block.event),
    width: columns,
    kind: `event-${category}`,
    segments: [
      ...(marker ? [{ text: `${marker} `, style: failed ? palette.failed : palette.body }] : []),
      { text: `#${seq.trim()} `, style: palette.dim },
      { text: type, style: eventTagStyle(block) }
    ]
  });
  const fragments = [header];
  let logicalOffset = header.text.length + 1;
  if (compact) {
    if (expanded) {
      const pretty = json(rawPayload, 2);
      const payloadLines = pretty.split('\n');
      for (let lineIndex = 0; lineIndex < payloadLines.length; lineIndex += 1) {
        const contentWidth = Math.max(1, columns - (columns >= 44 ? 12 : 3) - (columns >= 60 ? 15 : columns >= 44 ? 10 : 0));
        const wrapped = wrapToWidth(payloadLines[lineIndex], contentWidth);
        for (let pieceIndex = 0; pieceIndex < wrapped.lines.length; pieceIndex += 1) {
          const piece = wrapped.lines[pieceIndex];
          const last = lineIndex === payloadLines.length - 1 && pieceIndex === wrapped.lines.length - 1;
          const rendered = railRow({
            rail: last ? CHROME_GLYPHS.railEnd : CHROME_GLYPHS.railChild,
            content: piece,
            width: columns,
            segments: styledJsonSegments(piece),
            kind: 'event-payload',
            first: false
          });
          fragments.push(rendered);
          logicalOffset += rendered.text.length + 1;
        }
      }
    } else {
      const limit = Math.max(1, columns - (columns >= 44 ? 12 : 3) - (columns >= 60 ? 15 : columns >= 44 ? 10 : 0));
      const clipped = truncateToWidth(compact, limit, { ellipsis: true });
      const rendered = railRow({
        rail: CHROME_GLYPHS.railEnd,
        content: clipped,
        width: columns,
        segments: styledJsonSegments(clipped),
        kind: 'event-payload',
        first: false
      });
      fragments.push(rendered);
      logicalOffset += rendered.text.length + 1;
    }
  }
  if (block.gapAfter) fragments.push({ text: '', sourceText: '', start: logicalOffset, end: logicalOffset, lineKind: 'gap' });
  let start = 0;
  for (const fragment of fragments) {
    fragment.start = start;
    fragment.end = start + fragment.text.length;
    start = fragment.end + 1;
  }
  const value = `${headerContent}\n${compact}`;
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
