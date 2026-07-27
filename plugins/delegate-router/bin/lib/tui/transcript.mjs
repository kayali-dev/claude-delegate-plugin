import path from 'node:path';
import { normalizeFileChangedEvent } from '../control.mjs';
import { isCodexFirstClassItemType } from '../codex-item-types.mjs';
import { displayOr, formatDisplayValue, formatMultilineDisplayValue, formatTimestamp, joinDisplayParts } from './display.mjs';
import { CHROME_GLYPHS, CHROME_SEPARATOR, spinnerGlyph } from './glyphs.mjs';
import { uiPalette as palette } from './palette.mjs';
import { displayWidth, graphemeWidth, padToWidth, splitGraphemes, truncateToWidth } from './width.mjs';

const TRANSCRIPT_NOTICE = /^(?:approval\.(?:requested|resolved)|correction\.|scope\.violation$|budget\.exceeded$|error$|network\.|input\.|session\.updated$|mode\.updated$|model\.updated$|commands\.updated$|subagent\.activity$|artifact\.created$)/;
const SUCCESS = /^(?:completed|complete|success|succeeded|ok|approved|accepted)$/i;
const FAILURE = /^(?:failed|failure|error|cancelled|canceled|rejected|denied)$/i;
const compactionNormalizationCache = new WeakMap();
const providerItemNormalizationCache = new WeakMap();
const subagentNormalizationCache = new WeakMap();

function compactionPhase(event) {
  if (event?.type === 'compaction.started') return 'started';
  if (event?.type === 'compaction.completed') return 'completed';
  const data = event?.data || {};
  if (event?.type !== 'provider.event' || String(data.itemType || '').toLowerCase() !== 'contextcompaction') return null;
  if (data.providerEvent === 'item/started') return 'started';
  if (data.providerEvent === 'item/completed') return 'completed';
  return null;
}

function compactionIdentity(event, phase) {
  return `${phase}:${formatDisplayValue(event?.data?.itemId)}`;
}

// This is the sole legacy compatibility boundary. Every TUI consumer sees the
// same canonical lifecycle, while new journals keep the raw provider.event for
// fidelity without rendering the compaction twice.
export function normalizeCompactionEvents(events = []) {
  if (!Array.isArray(events)) return [];
  const cached = compactionNormalizationCache.get(events);
  if (cached) return cached;
  const firstClass = new Set(events
    .filter((event) => event?.type === 'compaction.started' || event?.type === 'compaction.completed')
    .map((event) => compactionIdentity(event, compactionPhase(event))));
  const normalized = events.flatMap((event) => {
    const phase = compactionPhase(event);
    if (!phase || event.type !== 'provider.event') return [event];
    if (firstClass.has(compactionIdentity(event, phase))) return [];
    return [Object.freeze({
      ...event,
      type: `compaction.${phase}`,
      data: Object.freeze({ itemId: event.data?.itemId })
    })];
  });
  compactionNormalizationCache.set(events, normalized);
  return normalized;
}

function providerItemPhase(event) {
  if (event?.type === 'provider.item') return stringValue(event.data?.phase);
  if (event?.type !== 'provider.event' || !event.data?.itemType) return null;
  const providerEvent = String(event.data.providerEvent || '');
  const match = providerEvent.match(/(?:item\/|item_)(started|completed)$/);
  return match?.[1] || null;
}

function providerItemIdentity(event, phase = providerItemPhase(event)) {
  return `${phase}:${formatDisplayValue(event?.data?.itemType)}:${formatDisplayValue(event?.data?.itemId)}`;
}

// Pre-upgrade journals retained only providerEvent/itemType/itemId. Promote
// those stubs to the same typed block without inventing the missing payload.
export function normalizeProviderItemEvents(events = []) {
  if (!Array.isArray(events)) return [];
  const cached = providerItemNormalizationCache.get(events);
  if (cached) return cached;
  const firstClass = new Set(events
    .filter((event) => event?.type === 'provider.item')
    .map((event) => providerItemIdentity(event)));
  const normalized = events.flatMap((event) => {
    if (event?.type !== 'provider.event') return [event];
    const phase = providerItemPhase(event);
    if (!phase) return [event];
    if (isCodexFirstClassItemType(event.data?.itemType)) return [];
    if (firstClass.has(providerItemIdentity(event, phase))) return [];
    return [Object.freeze({
      ...event,
      type: 'provider.item',
      data: Object.freeze({
        providerEvent: event.data?.providerEvent,
        itemType: event.data?.itemType || 'unknown',
        itemId: event.data?.itemId,
        phase,
        payloadCaptured: false,
        legacyNotCaptured: true,
        item: null,
        text: `${event.data?.itemType || 'unknown'} ${phase}: payload was not captured by the recorder version`
      })
    })];
  });
  providerItemNormalizationCache.set(events, normalized);
  return normalized;
}

function legacySubagentType(status) {
  if (SUCCESS.test(status)) return 'subagent.completed';
  if (FAILURE.test(status)) return 'subagent.errored';
  if (/start|spawn|launch|run/i.test(status)) return 'subagent.started';
  return 'subagent.progress';
}

// `subagent.activity` is the legacy cross-provider shape. Content-bearing
// Cursor records stay useful; content-free direct-Codex records become honest
// unknown-state blocks with an explicit not-captured notice.
export function normalizeSubagentEvents(events = []) {
  if (!Array.isArray(events)) return [];
  const cached = subagentNormalizationCache.get(events);
  if (cached) return cached;
  const normalized = events.map((event) => {
    if (event?.type !== 'subagent.activity') return event;
    const data = event.data || {};
    const captured = Boolean(data.id || data.agentId || data.taskId || data.title || data.task
      || data.instruction || data.status || data.output || data.result || data.error);
    const status = stringValue(data.status, data.state, captured ? 'running' : 'unknown');
    return Object.freeze({
      ...event,
      type: captured ? legacySubagentType(status) : 'subagent.progress',
      data: Object.freeze({
        id: stringValue(data.agentId, data.taskId, data.id, `legacy-${event.seq || 0}`),
        correlationId: stringValue(data.agentId, data.taskId, data.id, `legacy-${event.seq || 0}`),
        type: stringValue(data.agentType, data.type, 'subagent'),
        agentName: stringValue(data.agentName, data.name),
        task: stringValue(data.task, data.instruction, data.title),
        status,
        durationMs: numberValue(data.durationMs, data.duration_ms),
        output: rawStringValue(data.output, data.result),
        error: rawStringValue(data.error),
        legacyNotCaptured: !captured,
        payloadCaptured: captured
      })
    });
  });
  subagentNormalizationCache.set(events, normalized);
  return normalized;
}

export function normalizeTranscriptEvents(events = []) {
  return normalizeSubagentEvents(normalizeProviderItemEvents(normalizeCompactionEvents(events)));
}

function stringValue(...values) {
  for (const value of values) {
    const rendered = formatDisplayValue(value).trim();
    if (rendered) return rendered;
  }
  return '';
}

function rawStringValue(...values) {
  for (const value of values) {
    const rendered = formatDisplayValue(value);
    if (rendered) return rendered;
  }
  return '';
}

function numberValue(...values) {
  for (const value of values) {
    if (value == null || value === '' || typeof value === 'object' || typeof value === 'boolean') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function eventTime(event) {
  const value = Number(event?.at);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function compactDuration(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return '<1s';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function normalizedKind(value) {
  const kind = formatDisplayValue(value).toLowerCase();
  if (/add|create|new/.test(kind)) return 'create';
  if (/delete|remove/.test(kind)) return 'delete';
  if (/rename|move/.test(kind)) return 'rename';
  if (/edit|update|modify|change/.test(kind)) return 'edit';
  return kind || 'edit';
}

function normalizedTokenForDisplay(value) {
  return formatDisplayValue(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s/]+/g, '_')
    .toLowerCase();
}

function basename(value) {
  const normalized = formatDisplayValue(value).replaceAll('\\', '/');
  return path.posix.basename(normalized) || normalized || 'file';
}

function collectFiles(...sources) {
  const files = [];
  const seen = new Set();
  const add = (value, kind = 'edit') => {
    const file = typeof value === 'string' ? value : value?.path || value?.file || value?.filename || value?.uri;
    const rendered = formatDisplayValue(file);
    if (!rendered || seen.has(rendered)) return;
    seen.add(rendered);
    files.push({ path: rendered, basename: basename(rendered), kind: normalizedKind(typeof value === 'object' ? value.kind || value.type || value.operation : kind) });
  };
  for (const source of sources) {
    if (!source) continue;
    for (const change of source.changes || []) add(change);
    for (const location of source.locations || []) add(location, 'edit');
    for (const file of source.files || []) add(file);
    if (source.path || source.file || source.filename) add(source);
  }
  return files;
}

function toolPayload(event) {
  const data = event?.data || {};
  const item = data.item && typeof data.item === 'object' ? data.item : null;
  const call = data.toolCall && typeof data.toolCall === 'object' ? data.toolCall
    : data.tool_call && typeof data.tool_call === 'object' ? data.tool_call : null;
  return { data, item, call, rich: item || call || data };
}

export function toolEventKey(event) {
  const { data, item, call } = toolPayload(event);
  const id = item?.id ?? data.toolCallId ?? data.tool_call_id ?? call?.id ?? call?.toolCallId ?? data.id;
  return id == null ? null : formatDisplayValue(id) || null;
}

function toolName(payload) {
  const { data, item, call, rich } = payload;
  const server = stringValue(rich.server, rich.serverName, rich.mcpServer, rich.mcpServerName, data.server, call?.server);
  const tool = stringValue(rich.tool, rich.toolName, rich.name, data.toolName, call?.name);
  if (server && tool) return `${server}.${tool}`;
  return tool || server;
}

function commandText(payload) {
  const { data, item, call, rich } = payload;
  const command = rich.command ?? data.command ?? call?.command ?? call?.input?.command ?? item?.input?.command;
  return formatDisplayValue(command);
}

function statusDetails(startEvent, completedEvent, payload, options = {}) {
  const status = stringValue(payload.rich.status, payload.data.status, payload.call?.status, completedEvent ? 'completed' : 'running') || 'running';
  const exitCode = numberValue(payload.rich.exitCode, payload.data.exitCode, payload.call?.exitCode);
  const failed = exitCode != null ? exitCode !== 0 : FAILURE.test(status);
  const complete = Boolean(completedEvent) || SUCCESS.test(status) || failed;
  return {
    status,
    exitCode,
    running: !complete,
    failed,
    glyph: !complete ? spinnerGlyph(options.now) : failed ? `${CHROME_GLYPHS.failure}${exitCode == null ? '' : exitCode}` : CHROME_GLYPHS.success
  };
}

export class OutputLineTail {
  constructor(limit = 20) {
    this.limit = Math.max(1, Number(limit || 20));
    this.completedLines = 0;
    this.current = '';
    this.tail = [];
    this.seen = false;
  }

  append(value) {
    const text = formatMultilineDisplayValue(value);
    if (!text) return;
    this.seen = true;
    const parts = text.split('\n');
    this.current += parts[0];
    for (let index = 1; index < parts.length; index += 1) {
      this.tail.push(this.current);
      if (this.tail.length > this.limit) this.tail.shift();
      this.completedLines += 1;
      this.current = parts[index];
    }
  }

  replace(value) {
    this.completedLines = 0;
    this.current = '';
    this.tail = [];
    this.seen = false;
    this.append(value);
  }

  lineCount() {
    return this.seen ? this.completedLines + 1 : 0;
  }

  lines() {
    if (!this.seen) return [];
    return [...this.tail, this.current].slice(-this.limit);
  }
}

export function deriveToolDescriptor(startEvent, completedEvent = null, output = null, options = {}) {
  const source = completedEvent || startEvent || {};
  const startPayload = toolPayload(startEvent);
  const endPayload = toolPayload(completedEvent);
  const payload = completedEvent ? {
    data: { ...startPayload.data, ...endPayload.data },
    item: endPayload.item || startPayload.item,
    call: endPayload.call || startPayload.call,
    rich: endPayload.rich || startPayload.rich
  } : startPayload;
  const itemType = stringValue(payload.rich.type, payload.data.itemType, payload.data.sessionUpdate, payload.data.subtype, payload.call?.type) || 'tool';
  const command = commandText(payload);
  const files = collectFiles(startPayload.data, startPayload.item, startPayload.call, endPayload.data, endPayload.item, endPayload.call);
  const title = stringValue(payload.rich.title, payload.data.title, payload.call?.title, toolName(payload), itemType, 'tool');
  const name = toolName(payload) || title;
  const status = statusDetails(startEvent, completedEvent, payload, options);
  const explicitDuration = numberValue(payload.rich.durationMs, payload.data.durationMs, payload.call?.durationMs);
  const startedAt = eventTime(startEvent || source);
  const candidateEnd = completedEvent ? eventTime(completedEvent) : Number(options.now ?? Date.now());
  const endedAt = Number.isFinite(candidateEnd) && candidateEnd > 0 ? candidateEnd : null;
  const durationMs = explicitDuration != null && explicitDuration >= 0 ? explicitDuration
    : completedEvent && completedEvent !== startEvent && startedAt && endedAt && endedAt >= startedAt ? endedAt - startedAt : null;
  const outputText = rawStringValue(
    payload.rich.aggregatedOutput,
    payload.data.output,
    payload.call?.output,
    [payload.data.stdout, payload.data.stderr].filter(Boolean).join('\n')
  );
  const tracker = output instanceof OutputLineTail ? output : new OutputLineTail();
  if (outputText) tracker.replace(outputText);
  const lowerType = itemType.toLowerCase();
  const category = command || lowerType === 'commandexecution' ? 'command'
    : lowerType === 'filechange' || source.type === 'file.changed' ? 'file'
      : /mcptoolcall|dynamictoolcall/.test(lowerType) ? 'mcp'
        : files.length || title !== itemType ? 'cursor' : 'generic';
  const cwd = stringValue(payload.rich.cwd, payload.data.cwd, payload.call?.cwd);
  return Object.freeze({
    key: toolEventKey(startEvent) || toolEventKey(completedEvent) || `seq-${source.seq || 0}`,
    category, itemType, command, title, name, files, paths: files.map((file) => file.path), cwd,
    showCwd: Boolean(cwd && options.jobCwd && path.resolve(cwd) !== path.resolve(formatDisplayValue(options.jobCwd))),
    ...status, durationMs, startedAt, endedAt: completedEvent ? endedAt : null,
    outputLineCount: tracker.lineCount(), outputTail: tracker.lines()
  });
}

export function subagentEventKey(event) {
  const data = event?.data || {};
  return stringValue(data.correlationId, data.id, data.agentId, data.taskId) || null;
}

function providerLabel(provider) {
  const value = stringValue(provider, 'provider');
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)} agent`;
}

function detailLines(value, maxLength = 65536) {
  const text = formatMultilineDisplayValue(value, { maxLength, space: typeof value === 'object' ? 2 : 0 });
  return text ? text.split('\n') : [];
}

function subagentStatus(event) {
  if (event?.type === 'subagent.completed') return 'completed';
  if (event?.type === 'subagent.errored') return 'errored';
  return stringValue(event?.data?.status, event?.type?.split('.')[1], 'running');
}

export function deriveSubagentDescriptor(startEvent, terminalEvent = null, latestEvent = null, options = {}) {
  const start = startEvent || latestEvent || terminalEvent || {};
  const latest = latestEvent || terminalEvent || start;
  const terminal = terminalEvent || null;
  const startData = start.data || {};
  const data = { ...startData, ...(latest.data || {}), ...(terminal?.data || {}) };
  const legacyNotCaptured = data.legacyNotCaptured === true;
  const endedUnknown = !legacyNotCaptured && !terminal && options.jobTerminal === true;
  const status = legacyNotCaptured ? 'unknown' : endedUnknown ? 'ended (unknown outcome)' : subagentStatus(terminal || latest);
  const failed = !legacyNotCaptured && (terminal?.type === 'subagent.errored' || FAILURE.test(status));
  const running = !legacyNotCaptured && !terminal && !endedUnknown;
  const startedAt = eventTime(start);
  const endedAt = eventTime(terminal);
  const explicitDuration = numberValue(data.durationMs);
  const durationMs = explicitDuration != null && explicitDuration >= 0 ? explicitDuration
    : terminal && startedAt && endedAt && endedAt >= startedAt ? endedAt - startedAt : null;
  const output = rawStringValue(data.output, data.error);
  const lines = detailLines(output);
  const usage = data.usage && typeof data.usage === 'object' ? formatDisplayValue(data.usage, { maxLength: 4096, space: 2 }) : '';
  return Object.freeze({
    key: subagentEventKey(start) || subagentEventKey(latest) || `subagent-${latest.seq || 0}`,
    category: 'subagent',
    itemType: 'subagent',
    title: providerLabel(terminal?.provider || latest.provider || start.provider),
    name: providerLabel(terminal?.provider || latest.provider || start.provider),
    agentType: stringValue(data.type, 'subagent'),
    agentName: stringValue(data.agentName),
    agentId: stringValue(data.id),
    task: legacyNotCaptured
      ? 'payload was not captured by the recorder version'
      : stringValue(data.task),
    status,
    running,
    failed,
    glyph: running ? spinnerGlyph(options.now) : legacyNotCaptured ? '?'
      : failed ? CHROME_GLYPHS.failure : CHROME_GLYPHS.success,
    durationMs,
    startedAt,
    endedAt: terminal ? endedAt : null,
    command: '',
    files: [],
    paths: [],
    cwd: '',
    showCwd: false,
    outputLineCount: lines.length,
    outputTail: lines,
    detailLines: legacyNotCaptured
      ? ['payload was not captured by the recorder version; no task, status, or output can be recovered']
      : endedUnknown ? ['job ended before a terminal subagent outcome was observed']
      : lines.length ? lines : ['no subagent output was exposed by this lifecycle event'],
    detailLabel: output ? 'subagent output' : 'subagent details',
    legacyNotCaptured,
    endedUnknown,
    usage
  });
}

function providerItemEventKey(event) {
  const data = event?.data || {};
  return stringValue(data.itemId, data.item?.id, `${data.itemType || 'item'}:${event?.seq || 0}`);
}

function compactProviderItemSummary(data = {}) {
  if (data.legacyNotCaptured || data.payloadCaptured === false) return 'payload was not captured by the recorder version';
  const item = data.item && typeof data.item === 'object' ? data.item : {};
  const action = item.action && typeof item.action === 'object' ? item.action : {};
  const summary = stringValue(
    data.summary, item.title, item.name, item.query, action.query, action.url, action.pattern,
    item.status, item.kind, item.message, item.text
  );
  if (summary) return summary.replace(/\s+/g, ' ').trim();
  const fields = Object.entries(item)
    .filter(([key, value]) => !['type', 'id'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}=${formatDisplayValue(value)}`);
  return fields.join(', ') || stringValue(data.phase, 'item');
}

export function deriveProviderItemDescriptor(startEvent, completedEvent = null, options = {}) {
  const source = completedEvent || startEvent || {};
  const startData = startEvent?.data || {};
  const endData = completedEvent?.data || {};
  const data = { ...startData, ...endData, item: endData.item || startData.item };
  const legacyNotCaptured = data.legacyNotCaptured === true || data.payloadCaptured === false;
  const endedUnknown = !legacyNotCaptured && !completedEvent && options.jobTerminal === true;
  const status = endedUnknown
    ? 'ended (unknown outcome)'
    : stringValue(data.item?.status, data.phase, completedEvent ? 'completed' : 'running');
  const failed = FAILURE.test(status);
  const running = !legacyNotCaptured && !endedUnknown && !completedEvent
    && data.phase !== 'completed' && !SUCCESS.test(status) && !failed;
  const startedAt = eventTime(startEvent || source);
  const endedAt = eventTime(completedEvent);
  const explicitDuration = numberValue(data.item?.durationMs, data.item?.duration_ms, data.durationMs);
  const durationMs = explicitDuration != null && explicitDuration >= 0 ? explicitDuration
    : completedEvent && startedAt && endedAt && endedAt >= startedAt ? endedAt - startedAt : null;
  const lines = legacyNotCaptured
    ? ['payload was not captured by the recorder version; only item type, id, and phase survived']
    : endedUnknown ? ['job ended before a terminal provider-item outcome was observed']
    : detailLines(data.item);
  return Object.freeze({
    key: providerItemEventKey(startEvent || completedEvent),
    category: 'provider-item',
    itemType: stringValue(data.itemType, data.item?.type, 'unknown'),
    title: stringValue(data.itemType, data.item?.type, 'unknown provider item'),
    name: stringValue(data.itemType, data.item?.type, 'unknown provider item'),
    summary: compactProviderItemSummary(data),
    status: legacyNotCaptured ? 'unknown' : status,
    running,
    failed,
    glyph: running ? spinnerGlyph(options.now) : legacyNotCaptured ? '?'
      : failed ? CHROME_GLYPHS.failure : CHROME_GLYPHS.success,
    durationMs,
    startedAt,
    endedAt: completedEvent ? endedAt : null,
    command: '',
    files: [],
    paths: [],
    cwd: '',
    showCwd: false,
    outputLineCount: lines.length,
    outputTail: lines,
    detailLines: lines,
    detailLabel: 'provider item detail',
    legacyNotCaptured,
    endedUnknown
  });
}

function fileSummary(files) {
  if (!files.length) return 'file';
  return `${files[0].basename}${files.length > 1 ? ` (+${files.length - 1} more)` : ''}`;
}

function locationSummary(files) {
  if (!files.length) return '';
  const names = files.slice(0, 2).map((file) => file.basename).join(', ');
  return `${names}${files.length > 2 ? ` +${files.length - 2}` : ''}`;
}

function toolSummaryParts(tool) {
  const duration = compactDuration(tool.durationMs);
  const exit = tool.exitCode == null ? '' : `exit ${formatDisplayValue(tool.exitCode)}`;
  const output = tool.outputLineCount ? `${CHROME_GLYPHS.truncation} output (${tool.outputLineCount} lines)` : '';
  let parts;
  if (tool.category === 'subagent') {
    const identity = tool.agentName || (tool.agentType && tool.agentType !== 'subagent' ? tool.agentType : '');
    parts = [`> ${tool.title}`, identity, tool.task, tool.endedUnknown ? 'ended: outcome unknown' : '', tool.glyph];
  }
  if (tool.category === 'provider-item') {
    parts = [`$ ${tool.title}`, tool.summary, tool.endedUnknown ? 'ended: outcome unknown' : '', tool.glyph];
  }
  if (tool.category === 'command') parts = [`${CHROME_GLYPHS.toolCommand} ${tool.command || tool.title}`, tool.glyph];
  if (tool.category === 'file') {
    const kinds = [...new Set(tool.files.map((file) => file.kind))].join('/');
    parts = [`${CHROME_GLYPHS.toolFile} ${fileSummary(tool.files)}`, kinds || 'edit', tool.glyph];
  }
  if (tool.category === 'mcp') parts = [`${CHROME_GLYPHS.toolMcp} ${tool.name || tool.title}`, tool.glyph];
  if (tool.category === 'cursor') {
    const locations = locationSummary(tool.files);
    parts = [`${CHROME_GLYPHS.toolCursor} ${tool.title}`, locations, tool.glyph];
  }
  parts ||= [`${CHROME_GLYPHS.toolCommand} ${tool.title || tool.itemType || 'tool'}`, tool.glyph];
  return { text: joinDisplayParts(parts), rightText: joinDisplayParts([exit, duration, output]) };
}

function toolSummary(tool) {
  const summary = toolSummaryParts(tool);
  return joinDisplayParts([summary.text, summary.rightText]);
}

export function toolActivityLabel(tool) {
  if (!tool) return 'tool';
  if (tool.category === 'subagent') return tool.task || tool.agentName || tool.agentType || 'subagent';
  if (tool.category === 'provider-item') return `${tool.itemType || 'provider item'} ${tool.summary || ''}`.trim();
  if (tool.category === 'command') return tool.command || tool.title || 'command';
  if (tool.category === 'file') return `${fileSummary(tool.files)} ${[...new Set(tool.files.map((file) => file.kind))].join('/')}`.trim();
  return tool.name || tool.title || tool.itemType || 'tool';
}

function planEntries(event) {
  const data = event?.data || {};
  const entries = Array.isArray(data.plan) ? data.plan : Array.isArray(data.entries) ? data.entries
    : Array.isArray(data.plan?.entries) ? data.plan.entries : null;
  if (entries) return entries.map((entry) => typeof entry === 'string' ? { text: entry, status: 'pending' } : {
    text: stringValue(entry.step, entry.content, entry.title, entry.text, formatDisplayValue(entry)),
    status: stringValue(entry.status, 'pending')
  });
  const text = stringValue(data.text, data.plan);
  return text ? text.split(/\r?\n/).filter(Boolean).map((entry) => ({ text: entry, status: 'pending' })) : [];
}

function planStatusKind(status) {
  if (SUCCESS.test(status)) return 'complete';
  if (FAILURE.test(status)) return 'failed';
  if (/progress|running|active/i.test(status)) return 'active';
  return 'pending';
}

function planGlyph(status, activeGlyph) {
  const kind = planStatusKind(status);
  if (kind === 'complete') return CHROME_GLYPHS.planCompleted;
  if (kind === 'failed') return CHROME_GLYPHS.failure;
  if (kind === 'active') return activeGlyph || CHROME_GLYPHS.spinner;
  return CHROME_GLYPHS.planPending;
}

function noticeText(event) {
  const data = event?.data || {};
  if (event.type === 'approval.requested') return `! approval requested${CHROME_SEPARATOR}${stringValue(data.method, data.toolCall?.title, 'provider permission')}`;
  if (event.type === 'approval.resolved') return `+ approval resolved${CHROME_SEPARATOR}${stringValue(data.decision, data.outcome?.outcome, data.outcome, 'resolved')}`;
  if (event.type.startsWith('correction.')) return joinDisplayParts([`> ${event.type.replace('correction.', 'correction ')}`, data.appliedAs]);
  if (event.type === 'scope.violation') return `! scope violation${CHROME_SEPARATOR}${numberValue(data.count, data.files?.length) || 1} path${Number(data.count || data.files?.length || 1) === 1 ? '' : 's'}`;
  if (event.type === 'budget.exceeded') return joinDisplayParts(['! output budget exceeded', data.maxOutputTokens ? `${formatDisplayValue(data.maxOutputTokens)} tokens` : '']);
  if (event.type === 'network.preflight') return joinDisplayParts(['~ network preflight', data.expectedEgress, data.sandbox, data.effectiveMode]);
  if (event.type === 'network.mode-elevated') return joinDisplayParts(['! Cursor mode elevated for network', `${data.requestedMode} -> ${data.effectiveMode}`]);
  if (event.type === 'network.policy.materialized') return '~ temporary Cursor network policy installed';
  if (event.type === 'network.policy.restored') return '+ Cursor network policy restored';
  if (event.type === 'input.requested') return joinDisplayParts(['? coordinator input required', data.question, data.requestId]);
  if (event.type === 'input.response.requested') return joinDisplayParts(['> coordinator response queued', data.requestId]);
  if (event.type === 'input.resolved') return joinDisplayParts(['+ coordinator input resolved', data.outcome]);
  if (event.type === 'session.updated') return joinDisplayParts(['~ session updated', data.title, data.model]);
  if (event.type === 'mode.updated') return joinDisplayParts(['~ Cursor mode', data.mode]);
  if (event.type === 'model.updated') return joinDisplayParts(['~ Cursor model', data.model]);
  if (event.type === 'commands.updated') return joinDisplayParts(['~ Cursor commands updated', `${Array.isArray(data.commands) ? data.commands.length : 0} available`]);
  if (event.type === 'subagent.activity') return joinDisplayParts([`> ${providerLabel(event.provider)}`, data.title, data.status, data.task]);
  if (event.type === 'artifact.created') return joinDisplayParts(['+ artifact', data.kind, data.path, data.uri]);
  return `! ${stringValue(data.code, 'error')}${CHROME_SEPARATOR}${stringValue(data.message, data.error, 'provider error')}`;
}

function buildDescriptions(events, options) {
  const slots = [];
  const messages = new Map();
  const tools = new Map();
  const fileGroups = new Map();
  const compactions = new Map();
  const subagents = new Map();
  const providerItems = new Map();
  let openAnonymousMessage = null;
  let openAnonymousCompaction = null;
  let plan = null;

  const addMessage = (event, role, key, streaming, text = '') => {
    const state = { slot: slots.length, id: key, role, at: eventTime(event), seqStart: event.seq || 0, seqEnd: event.seq || 0, parts: [], text, streaming };
    slots.push({ kind: 'message', state });
    messages.set(key, state);
    return state;
  };
  const addTool = (event, key) => {
    const state = { slot: slots.length, key, start: null, completed: null, output: new OutputLineTail(20), seqStart: event.seq || 0, seqEnd: event.seq || 0 };
    slots.push({ kind: 'tool', state });
    tools.set(key, state);
    return state;
  };
  const addCompaction = (event, key) => {
    const state = { slot: slots.length, key, start: null, completed: null, seqStart: event.seq || 0, seqEnd: event.seq || 0 };
    slots.push({ kind: 'compaction', state });
    compactions.set(key, state);
    return state;
  };
  const addSubagent = (event, key) => {
    const state = { slot: slots.length, key, start: null, latest: null, terminal: null, seqStart: event.seq || 0, seqEnd: event.seq || 0 };
    slots.push({ kind: 'subagent', state });
    subagents.set(key, state);
    return state;
  };
  const addProviderItem = (event, key) => {
    const state = { slot: slots.length, key, start: null, completed: null, seqStart: event.seq || 0, seqEnd: event.seq || 0 };
    slots.push({ kind: 'provider-item', state });
    providerItems.set(key, state);
    return state;
  };
  const addFileGroup = (event, key) => {
    const state = { key, start: null, completed: null, seqStart: event.seq || 0, seqEnd: event.seq || 0 };
    slots.push({ kind: 'files', state });
    fileGroups.set(key, state);
    return state;
  };
  const normalizedEvents = normalizeTranscriptEvents(events);
  const normalizedSubagentSourceItems = new Set(normalizedEvents
    .filter((event) => event?.type?.startsWith('subagent.') && event.data?.sourceItemId)
    .map((event) => formatDisplayValue(event.data.sourceItemId)));
  const replayEvents = normalizedEvents.filter((event) => event.replay === true);
  if (replayEvents.length) {
    slots.push({
      kind: 'restored',
      count: replayEvents.length,
      seqStart: replayEvents[0].seq || 0,
      seqEnd: replayEvents.at(-1).seq || 0,
      at: eventTime(replayEvents[0])
    });
  }
  for (const event of normalizedEvents) {
    if (event.replay === true) continue;
    const normalizedEvent = normalizeFileChangedEvent(event, options.jobCwd || '');
    const data = normalizedEvent?.data || {};
    if (event.type === 'turn.started' || event.type?.startsWith('correction.')) openAnonymousMessage = null;
    if (event.type === 'provider.event' || event.type === 'activity') continue;
    if (event.type === 'message.user') {
      const key = `user:${event.seq || slots.length}`;
      openAnonymousMessage = null;
      const state = addMessage(event, 'user', key, false, formatDisplayValue(data.text ?? data.message));
      state.seqEnd = event.seq || state.seqStart;
      continue;
    }
    if (event.type === 'message.delta') {
      const rawId = data.id == null ? null : formatDisplayValue(data.id);
      let key = rawId ? `assistant:${rawId}` : openAnonymousMessage;
      let state = key ? messages.get(key) : null;
      if (!state || !state.streaming) {
        key = rawId ? `${key}${state ? `:${event.seq}` : ''}` : `assistant:anon:${event.seq || slots.length}`;
        state = addMessage(event, 'assistant', key, true);
      }
      state.parts.push(formatDisplayValue(data.delta ?? data.text));
      state.seqEnd = event.seq || state.seqEnd;
      if (!rawId) openAnonymousMessage = key;
      continue;
    }
    if (event.type === 'message.completed') {
      const rawId = data.id == null ? null : formatDisplayValue(data.id);
      let key = rawId ? `assistant:${rawId}` : openAnonymousMessage;
      let state = key ? messages.get(key) : null;
      if (!state || !state.streaming) {
        key = rawId ? `${key}${state ? `:${event.seq}` : ''}` : `assistant:completed:${event.seq || slots.length}`;
        state = addMessage(event, 'assistant', key, false);
      }
      state.text = formatDisplayValue(data.text ?? data.message ?? data.output);
      state.streaming = false;
      state.seqEnd = event.seq || state.seqEnd;
      if (!rawId && openAnonymousMessage === key) openAnonymousMessage = null;
      continue;
    }
    if (event.type === 'plan.updated') {
      if (!plan) {
        plan = { slot: slots.length, event };
        slots.push({ kind: 'plan', state: plan });
      } else plan.event = event;
      continue;
    }
    if (event.type === 'compaction.started' || event.type === 'compaction.completed') {
      const itemId = formatDisplayValue(data.itemId);
      let key = itemId ? `compaction:${itemId}` : openAnonymousCompaction;
      let state = key ? compactions.get(key) : null;
      if (!state) {
        key = itemId ? `compaction:${itemId}` : `compaction:anon:${event.seq || slots.length}`;
        state = addCompaction(event, key);
      }
      if (event.type === 'compaction.started') {
        state.start = event;
        if (!itemId) openAnonymousCompaction = key;
      } else {
        state.completed = event;
        if (!itemId && openAnonymousCompaction === key) openAnonymousCompaction = null;
      }
      state.seqStart = Math.min(state.seqStart || event.seq || 0, event.seq || state.seqStart || 0);
      state.seqEnd = Math.max(state.seqEnd || 0, event.seq || 0);
      continue;
    }
    if (event.type?.startsWith('subagent.')) {
      const key = subagentEventKey(event) || `subagent:${event.seq || slots.length}`;
      const state = subagents.get(key) || addSubagent(event, key);
      state.latest = event;
      if (!state.start || event.type === 'subagent.started') state.start ||= event;
      if (event.type === 'subagent.completed' || event.type === 'subagent.errored') state.terminal = event;
      state.seqStart = Math.min(state.seqStart || event.seq || 0, event.seq || state.seqStart || 0);
      state.seqEnd = Math.max(state.seqEnd || 0, event.seq || 0);
      continue;
    }
    if (event.type === 'provider.item') {
      const itemType = stringValue(data.itemType, data.item?.type);
      if (itemType.toLowerCase() === 'contextcompaction'
        || (itemType.toLowerCase() === 'subagentactivity' && normalizedSubagentSourceItems.has(formatDisplayValue(data.itemId)))) continue;
      const key = providerItemEventKey(event);
      const state = providerItems.get(key) || addProviderItem(event, key);
      if (data.phase === 'started') state.start = event;
      else state.completed = event;
      state.start ||= event;
      state.seqStart = Math.min(state.seqStart || event.seq || 0, event.seq || state.seqStart || 0);
      state.seqEnd = Math.max(state.seqEnd || 0, event.seq || 0);
      continue;
    }
    if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.output' || event.type === 'tool.status') {
      const item = data.item && typeof data.item === 'object' ? data.item : {};
      if (normalizedTokenForDisplay(item.type) === 'collab_agent_tool_call'
        && normalizedSubagentSourceItems.has(formatDisplayValue(item.id))) continue;
      const key = toolEventKey(event) || `seq-${event.seq || slots.length}`;
      const state = tools.get(key) || addTool(event, key);
      if (event.type === 'tool.started') state.start = event;
      else if (event.type === 'tool.completed') state.completed = event;
      else if (event.type === 'tool.output') state.output.append(data.delta ?? data.output ?? data.text ?? [data.stdout, data.stderr].filter(Boolean).join('\n') ?? '');
      else state.start ||= event;
      state.seqEnd = event.seq || state.seqEnd;
      continue;
    }
    if (event.type === 'file.changed') {
      const changes = (data.changes || []).filter((change) => formatDisplayValue(change?.path));
      if (!changes.length) continue;
      const changedPaths = changes.map((change) => formatDisplayValue(change.path)).join('\0');
      const identity = formatDisplayValue(data.id) || (data.phase ? changedPaths : event.seq || slots.length);
      const key = `file:${identity}`;
      const state = fileGroups.get(key) || addFileGroup(normalizedEvent, key);
      if (data.phase === 'started' || data.status === 'inProgress' || data.status === 'in_progress') state.start = normalizedEvent;
      else {
        state.start ||= normalizedEvent;
        state.completed = normalizedEvent;
      }
      state.seqEnd = event.seq || state.seqEnd;
      continue;
    }
    if (TRANSCRIPT_NOTICE.test(event.type || '')) slots.push({ kind: 'notice', event });
  }

  return slots.map((slot) => {
    if (slot.kind === 'message') {
      const state = slot.state;
      return {
        id: `message:${state.id}`, kind: 'message', role: state.role, at: state.at,
        seqStart: state.seqStart, seqEnd: state.seqEnd,
        text: state.streaming ? state.parts.join('') : state.text, streaming: state.streaming
      };
    }
    if (slot.kind === 'plan') {
      const event = slot.state.event;
      return { id: 'plan:latest', kind: 'plan', at: eventTime(event), seqStart: event.seq || 0, seqEnd: event.seq || 0, entries: planEntries(event) };
    }
    if (slot.kind === 'tool') {
      const state = slot.state;
      return {
        id: `tool:${state.key}`, kind: 'tool', at: eventTime(state.start || state.completed),
        seqStart: state.seqStart, seqEnd: state.seqEnd,
        tool: deriveToolDescriptor(state.start || state.completed, state.completed, state.output, options)
      };
    }
    if (slot.kind === 'files') {
      const state = slot.state;
      const event = state.completed || state.start;
      return (event.data?.changes || []).map((change, index) => ({
        id: `${state.key}:${index}:${formatDisplayValue(change.path)}`,
        kind: 'file-change',
        at: eventTime(event),
        seqStart: state.seqStart,
        seqEnd: state.seqEnd,
        path: formatDisplayValue(change.path),
        change
      }));
    }
    if (slot.kind === 'compaction') {
      const state = slot.state;
      const startedAt = eventTime(state.start || state.completed);
      const completedAt = eventTime(state.completed);
      const durationMs = startedAt && completedAt && completedAt >= startedAt ? completedAt - startedAt : null;
      return {
        id: state.key, kind: 'compaction', at: startedAt, seqStart: state.seqStart, seqEnd: state.seqEnd,
        inProgress: !state.completed, durationMs
      };
    }
    if (slot.kind === 'subagent') {
      const state = slot.state;
      return {
        id: `subagent:${state.key}`, kind: 'tool', at: eventTime(state.start || state.latest),
        seqStart: state.seqStart, seqEnd: state.seqEnd,
        tool: deriveSubagentDescriptor(state.start || state.latest, state.terminal, state.latest, options)
      };
    }
    if (slot.kind === 'provider-item') {
      const state = slot.state;
      return {
        id: `provider-item:${state.key}`, kind: 'tool', at: eventTime(state.start || state.completed),
        seqStart: state.seqStart, seqEnd: state.seqEnd,
        tool: deriveProviderItemDescriptor(state.start || state.completed, state.completed, options)
      };
    }
    if (slot.kind === 'restored') {
      return {
        id: `restored:${slot.seqStart}:${slot.seqEnd}`,
        kind: 'restored',
        at: slot.at,
        seqStart: slot.seqStart,
        seqEnd: slot.seqEnd,
        count: slot.count,
        collapsed: true
      };
    }
    const event = slot.event;
    return { id: `notice:${event.seq || slots.indexOf(slot)}`, kind: 'notice', noticeType: event.type, at: eventTime(event), seqStart: event.seq || 0, seqEnd: event.seq || 0, text: noticeText(event) };
  }).flat();
}

function fingerprint(block) {
  return JSON.stringify(block);
}

function internBlocks(descriptions, previous) {
  const next = new Map();
  const blocks = descriptions.map((description) => {
    const mark = fingerprint(description);
    const old = previous.get(description.id);
    const block = old?.fingerprint === mark ? old : Object.freeze({ ...description, fingerprint: mark });
    next.set(description.id, block);
    return block;
  });
  return { blocks, interned: next };
}

export class TranscriptProjector {
  constructor() {
    this.events = null;
    this.jobTerminal = null;
    this.base = [];
    this.interned = new Map();
    this.rendered = new Map();
  }

  project(events = [], options = {}) {
    const jobTerminal = options.jobTerminal === true;
    if (events !== this.events || jobTerminal !== this.jobTerminal) {
      const result = internBlocks(buildDescriptions(events, options), this.interned);
      this.events = events;
      this.jobTerminal = jobTerminal;
      this.base = result.blocks;
      this.interned = result.interned;
    }
    const expanded = options.expandedTools instanceof Set ? options.expandedTools : new Set(options.expandedTools || []);
    const now = Number(options.now ?? Date.now());
    const descriptions = this.base.map((base, index) => {
      const tool = base.kind === 'tool' && base.tool.running
        ? { ...base.tool, glyph: spinnerGlyph(now), durationMs: Number.isFinite(now) && base.tool.startedAt && now >= base.tool.startedAt ? now - base.tool.startedAt : null }
        : base.tool;
      const planActive = base.kind === 'plan' && base.entries?.some((entry) => planStatusKind(entry.status) === 'active');
      const compactionActive = base.kind === 'compaction' && base.inProgress;
      return {
        ...base,
        ...(tool ? { tool } : {}),
        ...((base.streaming || tool?.running || planActive || compactionActive) ? { spinner: spinnerGlyph(now) } : {}),
        timestamp: formatTimestamp(base.at, { mode: options.timestampMode, now }),
        expanded: base.kind === 'tool' && expanded.has(base.tool.key),
        gapAfter: index < this.base.length - 1
      };
    });
    if (options.thinking) {
      descriptions.push({
        id: `activity:thinking:${Number(options.thinkingSince || 0)}`, kind: 'thinking', transient: true,
        at: Number(options.thinkingSince || now), seqStart: Number(options.thinkingSeq || 0), seqEnd: Number(options.thinkingSeq || 0),
        text: `${spinnerGlyph(now)} thinking...`, timestamp: formatTimestamp(Number(options.thinkingSince || now), { mode: options.timestampMode, now }), expanded: false, gapAfter: false
      });
    }
    const next = new Map();
    const blocks = descriptions.map((description) => {
      const mark = fingerprint(description);
      const old = this.rendered.get(description.id);
      const block = old?.fingerprint === mark ? old : Object.freeze({ ...description, fingerprint: mark });
      next.set(description.id, block);
      return block;
    });
    this.rendered = next;
    return blocks;
  }
}

export function transcriptLogicalLines(block) {
  if (block.kind === 'message') {
    const streaming = block.streaming ? `${block.spinner || CHROME_GLYPHS.spinner} streaming` : '';
    const paragraphs = formatMultilineDisplayValue(block.text).split('\n');
    return [
      {
        text: displayOr(block.role, 'assistant'),
        time: formatDisplayValue(block.timestamp),
        rightText: streaming,
        rail: CHROME_GLYPHS.railMessage,
        kind: 'message-header',
        nowrap: true,
        spinner: block.streaming ? block.spinner : null
      },
      ...paragraphs.map((text) => ({ text, kind: 'body', rail: CHROME_GLYPHS.railMessage })),
      ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
    ];
  }
  if (block.kind === 'tool') {
    const summary = toolSummaryParts(block.tool);
    const lines = [{
      ...summary,
      time: formatDisplayValue(block.timestamp),
      rail: block.expanded ? CHROME_GLYPHS.railBranch : CHROME_GLYPHS.railEnd,
      kind: block.tool.failed ? 'tool-failed' : block.tool.running ? 'tool-running' : 'tool',
      nowrap: true,
      spinner: block.tool.running ? block.tool.glyph : null
    }];
    if (block.expanded) {
      if (block.tool.category === 'subagent') {
        if (block.tool.agentId) lines.push({ text: `agent id: ${formatDisplayValue(block.tool.agentId)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        if (block.tool.agentType) lines.push({ text: `agent type: ${formatDisplayValue(block.tool.agentType)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        if (block.tool.status) lines.push({ text: `status: ${formatDisplayValue(block.tool.status)}`, kind: block.tool.failed ? 'tool-failed' : 'meta', rail: CHROME_GLYPHS.railChild });
        if (block.tool.usage) lines.push({ text: `usage: ${formatDisplayValue(block.tool.usage)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        lines.push({ text: `${block.tool.detailLabel}:`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        for (const line of block.tool.detailLines || []) lines.push({ text: formatDisplayValue(line), kind: 'body', rail: CHROME_GLYPHS.railChild });
      } else if (block.tool.category === 'provider-item') {
        lines.push({ text: `${block.tool.detailLabel}:`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        for (const line of block.tool.detailLines || []) lines.push({ text: formatDisplayValue(line), kind: 'body', rail: CHROME_GLYPHS.railChild });
      } else if (block.tool.command) {
        const commandLines = formatMultilineDisplayValue(block.tool.command).split('\n');
        commandLines.forEach((text, index) => lines.push({ text: `${index === 0 ? 'command: ' : ''}${text}`, kind: 'body', rail: CHROME_GLYPHS.railChild }));
        if (block.tool.showCwd) lines.push({ text: `cwd: ${formatDisplayValue(block.tool.cwd)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        for (const file of block.tool.files) lines.push({ text: `${formatDisplayValue(file.kind)}: ${formatDisplayValue(file.path)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        if (block.tool.outputTail.length) {
          lines.push({ text: `output tail (${block.tool.outputTail.length}/${block.tool.outputLineCount} lines):`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
          for (const line of block.tool.outputTail) lines.push({ text: formatDisplayValue(line), kind: 'body', rail: CHROME_GLYPHS.railChild });
        }
      } else {
        if (block.tool.showCwd) lines.push({ text: `cwd: ${formatDisplayValue(block.tool.cwd)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        for (const file of block.tool.files) lines.push({ text: `${formatDisplayValue(file.kind)}: ${formatDisplayValue(file.path)}`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
        if (block.tool.outputTail.length) {
          lines.push({ text: `output tail (${block.tool.outputTail.length}/${block.tool.outputLineCount} lines):`, kind: 'meta', rail: CHROME_GLYPHS.railChild });
          for (const line of block.tool.outputTail) lines.push({ text: formatDisplayValue(line), kind: 'body', rail: CHROME_GLYPHS.railChild });
        }
      }
      if (lines.length > 1) lines[lines.length - 1].rail = CHROME_GLYPHS.railEnd;
    }
    if (block.gapAfter) lines.push({ text: '', kind: 'gap' });
    return lines;
  }
  if (block.kind === 'file-change') {
    const elegant = CHROME_GLYPHS.toolFile !== 'F';
    const glyph = CHROME_GLYPHS.toolFile;
    const label = formatDisplayValue(block.change?.label || block.path).replaceAll(' \u2192 ', elegant ? ' \u2192 ' : ' -> ');
    const hasCounts = Number.isSafeInteger(block.change?.added) && block.change.added >= 0
      && Number.isSafeInteger(block.change?.removed) && block.change.removed >= 0;
    const added = hasCounts ? `+${block.change.added}` : '';
    const removed = hasCounts ? `${elegant ? '\u2212' : '-'}${block.change.removed}` : '';
    const prefix = `${glyph} ${label}`;
    return [
      {
        text: prefix,
        time: formatDisplayValue(block.timestamp),
        rightText: hasCounts ? `${added} ${removed}` : '',
        rail: CHROME_GLYPHS.railEnd,
        kind: 'file-change',
        nowrap: true,
        segments: [{ text: prefix }]
      },
      ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
    ];
  }
  if (block.kind === 'plan') {
    const lines = [{
      text: 'plan',
      time: formatDisplayValue(block.timestamp),
      rail: CHROME_GLYPHS.railSystem,
      kind: 'plan-header',
      nowrap: true
    }];
    for (const entry of block.entries || []) {
      const status = planStatusKind(entry.status);
      const glyph = planGlyph(entry.status, block.spinner);
      lines.push({
        text: `${glyph} ${formatDisplayValue(entry.text)}`,
        kind: `plan-${status}`,
        rail: CHROME_GLYPHS.railChild,
        ...(status === 'active' ? { spinner: glyph } : {})
      });
    }
    if (lines.length > 1) lines[lines.length - 1].rail = CHROME_GLYPHS.railEnd;
    if (block.gapAfter) lines.push({ text: '', kind: 'gap' });
    return lines;
  }
  if (block.kind === 'compaction') {
    const glyph = block.inProgress ? block.spinner || CHROME_GLYPHS.spinner : CHROME_GLYPHS.success;
    return [
      {
        text: `${glyph} context compaction`,
        time: formatDisplayValue(block.timestamp),
        rightText: block.inProgress || block.durationMs == null ? '' : compactDuration(block.durationMs),
        rail: CHROME_GLYPHS.railSystem,
        kind: block.inProgress ? 'compaction-active' : 'compaction-complete',
        nowrap: true,
        ...(block.inProgress ? { spinner: glyph } : {})
      },
      ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
    ];
  }
  if (block.kind === 'restored') {
    return [
      {
        text: `restored history (${block.count} event${block.count === 1 ? '' : 's'})`,
        time: formatDisplayValue(block.timestamp),
        rail: CHROME_GLYPHS.railSystem,
        kind: 'restored',
        nowrap: true
      },
      ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
    ];
  }
  const kind = block.kind === 'thinking' ? 'thinking' : /scope|budget|error/.test(block.noticeType || '') ? 'notice-error'
    : block.noticeType === 'approval.requested' ? 'notice-warning' : 'notice';
  return [
    {
      text: block.text,
      time: formatDisplayValue(block.timestamp),
      rail: CHROME_GLYPHS.railSystem,
      kind,
      nowrap: true,
      spinner: block.kind === 'thinking' ? block.text?.[0] : null
    },
    ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
  ];
}

export function formatTranscriptBlock(block) {
  return transcriptLogicalLines(block).map((line) => line.kind === 'file-change' && line.rightText
    ? `${line.text} (${line.rightText})`
    : joinDisplayParts([line.text, line.rightText])).join('\n');
}

function glyphOffsets(value) {
  const result = [];
  let offset = 0;
  for (const text of splitGraphemes(value)) {
    result.push({ text, start: offset, end: offset + text.length, width: graphemeWidth(text) });
    offset += text.length;
  }
  return result;
}

function wrappedLineFragments(line, width, globalStart) {
  if (!line.text && line.kind === 'gap') {
    return [{ text: '', sourceText: '', prefix: '', start: globalStart, end: globalStart, lineKind: line.kind }];
  }
  const timeWidth = width >= 44 ? 9 : 0;
  const railWidth = Math.min(2, Math.max(1, width - timeWidth - 1));
  const measureWidth = width >= 60 ? 14 : width >= 44 ? 9 : 0;
  const separators = (timeWidth ? 1 : 0) + 1 + (measureWidth ? 1 : 0);
  const available = Math.max(1, width - timeWidth - railWidth - measureWidth - separators);
  const rail = truncateToWidth(formatDisplayValue(line.rail || CHROME_GLYPHS.railChild), railWidth, { ellipsis: false });
  const time = timeWidth ? truncateToWidth(formatDisplayValue(line.time), timeWidth, { ellipsis: true }) : '';
  const measure = measureWidth ? truncateToWidth(formatDisplayValue(line.rightText), measureWidth, { ellipsis: true }) : '';
  const compose = (content, first, contentSegments = null) => {
    const timeText = timeWidth ? `${padToWidth(first ? time : '', timeWidth)} ` : '';
    const railText = `${padToWidth(rail, railWidth)} `;
    const ownsMeasure = Boolean(measureWidth && first && measure);
    const contentText = ownsMeasure ? padToWidth(content, available) : content;
    const measureText = ownsMeasure ? ` ${padToWidth(measure, measureWidth, 'right')}` : '';
    const text = `${timeText}${railText}${contentText}${measureText}`;
    const segments = [
      ...(timeWidth ? [{ text: timeText, style: palette.dim }] : []),
      { text: railText, style: line.kind.includes('failed') || line.kind === 'notice-error' ? palette.failed : palette.metadata },
      ...(contentSegments || [{ text: contentText }]),
      ...(ownsMeasure && contentSegments && displayWidth(contentSegments.map((segment) => segment.text).join('')) < available
        ? [{ text: ' '.repeat(available - displayWidth(contentSegments.map((segment) => segment.text).join(''))) }]
        : []),
      ...(ownsMeasure ? [{ text: measureText, style: palette.dim }] : [])
    ];
    return { text, segments };
  };
  if (line.nowrap) {
    const left = truncateToWidth(formatDisplayValue(line.text), available, { ellipsis: true });
    const preservesSegments = left === formatDisplayValue(line.text) && Array.isArray(line.segments);
    const rendered = compose(left, true, preservesSegments ? line.segments : null);
    const text = rendered.text;
    return [{ text, sourceText: text, prefix: '', start: globalStart, end: globalStart + text.length, lineKind: line.kind,
      segments: rendered.segments,
      ...(line.spinner ? { spinnerChar: line.spinner } : {}) }];
  }
  if (!line.text) {
    const rendered = compose('', true);
    return [{ text: rendered.text, sourceText: rendered.text, prefix: '', start: globalStart, end: globalStart + rendered.text.length, lineKind: line.kind, segments: rendered.segments }];
  }
  const glyphs = glyphOffsets(line.text);
  const fragments = [];
  let cursor = 0;
  while (cursor < glyphs.length) {
    while (cursor < glyphs.length && fragments.length && /^\s+$/u.test(glyphs[cursor].text)) cursor += 1;
    if (cursor >= glyphs.length) break;
    let used = 0;
    let end = cursor;
    let whitespace = -1;
    while (end < glyphs.length && used + glyphs[end].width <= available) {
      used += glyphs[end].width;
      if (/^\s+$/u.test(glyphs[end].text)) whitespace = end;
      end += 1;
    }
    if (end === cursor) end += 1;
    if (end < glyphs.length && whitespace >= cursor) end = whitespace;
    let pieceEnd = end;
    while (pieceEnd > cursor && /^\s+$/u.test(glyphs[pieceEnd - 1].text)) pieceEnd -= 1;
    if (pieceEnd === cursor) pieceEnd = Math.max(cursor + 1, end);
    const startOffset = glyphs[cursor].start;
    const endOffset = glyphs[pieceEnd - 1].end;
    const sourceText = line.text.slice(startOffset, endOffset);
    const rendered = compose(sourceText, fragments.length === 0);
    const text = rendered.text;
    fragments.push({ text, sourceText: text, prefix: '', start: globalStart + startOffset, end: globalStart + endOffset, lineKind: line.kind, segments: rendered.segments,
      ...(line.spinner && text.includes(line.spinner) ? { spinnerChar: line.spinner } : {}) });
    cursor = Math.max(end, pieceEnd);
  }
  return fragments.length ? fragments : [{ text: '', sourceText: '', prefix: '', start: globalStart, end: globalStart, lineKind: line.kind }];
}

export function wrapTranscriptBlock(block, width, formatted = formatTranscriptBlock(block)) {
  const lines = transcriptLogicalLines(block);
  const fragments = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const wrapped = wrappedLineFragments(lines[index], Math.max(1, width), start);
    fragments.push(...wrapped);
    start += wrapped.reduce((total, fragment) => total + fragment.text.length + 1, 0);
  }
  return { value: formatDisplayValue(formatted), fragments, lines: fragments.map((fragment) => fragment.text) };
}

export function normalizeJobPaths(values, jobCwd = '') {
  const cwd = formatDisplayValue(jobCwd);
  return (values || []).map((raw) => {
    const value = formatDisplayValue(raw);
    if (!value) return '';
    if (!path.isAbsolute(value) || !cwd) return value.replaceAll('\\', '/').replace(/^\.\//, '');
    const relative = path.relative(cwd, value);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replaceAll('\\', '/') : value.replaceAll('\\', '/');
  }).filter(Boolean);
}

export function transcriptToolPaths(block, jobCwd = '') {
  if (block?.kind === 'file-change') return normalizeJobPaths([block.path], jobCwd);
  if (block?.kind !== 'tool') return [];
  return normalizeJobPaths(block.tool.paths || [], jobCwd);
}
