import path from 'node:path';
import { displayOr, formatDisplayValue, formatMultilineDisplayValue, formatTimestamp, joinDisplayParts } from './display.mjs';
import { CHROME_GLYPHS, CHROME_SEPARATOR, spinnerGlyph } from './glyphs.mjs';
import { displayWidth, graphemeWidth, splitGraphemes, truncateToWidth } from './width.mjs';

const TRANSCRIPT_NOTICE = /^(?:approval\.(?:requested|resolved)|correction\.|scope\.violation$|budget\.exceeded$|error$)/;
const SUCCESS = /^(?:completed|complete|success|succeeded|ok|approved|accepted)$/i;
const FAILURE = /^(?:failed|failure|error|cancelled|canceled|rejected|denied)$/i;

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
  const outputText = rawStringValue(payload.rich.aggregatedOutput, payload.data.output, payload.call?.output);
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
  const output = tool.outputLineCount ? `${CHROME_GLYPHS.truncation} output (${tool.outputLineCount} lines)` : '';
  let parts;
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
  return { text: joinDisplayParts(parts), rightText: joinDisplayParts([duration, output]) };
}

function toolSummary(tool) {
  const summary = toolSummaryParts(tool);
  return joinDisplayParts([summary.text, summary.rightText]);
}

export function toolActivityLabel(tool) {
  if (!tool) return 'tool';
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
  return `! ${stringValue(data.code, 'error')}${CHROME_SEPARATOR}${stringValue(data.message, data.error, 'provider error')}`;
}

function buildDescriptions(events, options) {
  const slots = [];
  const messages = new Map();
  const tools = new Map();
  let openAnonymousMessage = null;
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

  for (const event of events || []) {
    const data = event?.data || {};
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
    if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.output') {
      const key = toolEventKey(event) || `seq-${event.seq || slots.length}`;
      const state = tools.get(key) || addTool(event, key);
      if (event.type === 'tool.started') state.start = event;
      else if (event.type === 'tool.completed') state.completed = event;
      else state.output.append(data.delta ?? data.output ?? data.text ?? '');
      state.seqEnd = event.seq || state.seqEnd;
      continue;
    }
    if (event.type === 'file.changed' && (Array.isArray(data.changes) || data.phase)) {
      const changedPaths = (data.changes || []).map((change) => formatDisplayValue(change?.path || change?.file)).filter(Boolean).join('\0');
      const key = `file:${formatDisplayValue(data.id) || changedPaths || event.seq || slots.length}`;
      const state = tools.get(key) || addTool(event, key);
      if (data.phase === 'started' || data.status === 'inProgress' || data.status === 'in_progress') state.start = event;
      else {
        state.start ||= event;
        state.completed = event;
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
    const event = slot.event;
    return { id: `notice:${event.seq || slots.indexOf(slot)}`, kind: 'notice', noticeType: event.type, at: eventTime(event), seqStart: event.seq || 0, seqEnd: event.seq || 0, text: noticeText(event) };
  });
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
    this.base = [];
    this.interned = new Map();
    this.rendered = new Map();
  }

  project(events = [], options = {}) {
    if (events !== this.events) {
      const result = internBlocks(buildDescriptions(events, options), this.interned);
      this.events = events;
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
      return {
        ...base,
        ...(tool ? { tool } : {}),
        ...((base.streaming || tool?.running || planActive) ? { spinner: spinnerGlyph(now) } : {}),
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
    const streaming = block.streaming ? `${CHROME_SEPARATOR}${block.spinner || CHROME_GLYPHS.spinner} streaming` : '';
    const header = `| ${displayOr(block.role, 'assistant')}${streaming}`;
    const paragraphs = formatMultilineDisplayValue(block.text).split('\n');
    return [
      { text: header, rightText: formatDisplayValue(block.timestamp), kind: 'message-header', nowrap: true, spinner: block.streaming ? block.spinner : null },
      ...paragraphs.map((text) => ({ text, kind: 'body', indent: '  ' })),
      ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
    ];
  }
  if (block.kind === 'tool') {
    const summary = toolSummaryParts(block.tool);
    const lines = [{ ...summary, kind: block.tool.failed ? 'tool-failed' : block.tool.running ? 'tool-running' : 'tool', nowrap: true, spinner: block.tool.running ? block.tool.glyph : null }];
    if (block.expanded) {
      if (block.tool.command) {
        const commandLines = formatMultilineDisplayValue(block.tool.command).split('\n');
        commandLines.forEach((text, index) => lines.push({ text: `${index === 0 ? 'command: ' : ''}${text}`, kind: 'body', indent: index === 0 ? '  ' : '           ' }));
      }
      if (block.tool.showCwd) lines.push({ text: `cwd: ${formatDisplayValue(block.tool.cwd)}`, kind: 'meta', indent: '  ' });
      for (const file of block.tool.files) lines.push({ text: `${formatDisplayValue(file.kind)}: ${formatDisplayValue(file.path)}`, kind: 'meta', indent: '  ' });
      if (block.tool.outputTail.length) {
        lines.push({ text: `output tail (${block.tool.outputTail.length}/${block.tool.outputLineCount} lines):`, kind: 'meta', indent: '  ' });
        for (const line of block.tool.outputTail) lines.push({ text: formatDisplayValue(line), kind: 'body', indent: '    ' });
      }
    }
    if (block.gapAfter) lines.push({ text: '', kind: 'gap' });
    return lines;
  }
  if (block.kind === 'plan') {
    const lines = [{ text: '| plan', rightText: formatDisplayValue(block.timestamp), kind: 'plan-header', nowrap: true }];
    for (const entry of block.entries || []) {
      const status = planStatusKind(entry.status);
      const glyph = planGlyph(entry.status, block.spinner);
      lines.push({
        text: `${glyph} ${formatDisplayValue(entry.text)}`,
        kind: `plan-${status}`,
        indent: '  ',
        ...(status === 'active' ? { spinner: glyph } : {})
      });
    }
    if (block.gapAfter) lines.push({ text: '', kind: 'gap' });
    return lines;
  }
  const kind = block.kind === 'thinking' ? 'thinking' : /scope|budget|error/.test(block.noticeType || '') ? 'notice-error'
    : block.noticeType === 'approval.requested' ? 'notice-warning' : 'notice';
  return [
    { text: block.text, kind, nowrap: true, spinner: block.kind === 'thinking' ? block.text?.[0] : null },
    ...(block.gapAfter ? [{ text: '', kind: 'gap' }] : [])
  ];
}

export function formatTranscriptBlock(block) {
  return transcriptLogicalLines(block).map((line) => joinDisplayParts([line.text, line.rightText])).join('\n');
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
  const prefix = line.indent || '';
  const available = Math.max(1, width - displayWidth(prefix));
  if (line.nowrap) {
    // Tool commands and block labels are the primary value. Keep at least
    // sixty percent for the left side and compact duration/output metadata in
    // the pinned right column when space is tight.
    const right = truncateToWidth(formatDisplayValue(line.rightText), Math.max(0, Math.floor(width * 0.4)), { ellipsis: true });
    const rightWidth = displayWidth(right);
    const leftWidth = Math.max(0, width - rightWidth - (right ? 1 : 0));
    const left = truncateToWidth(formatDisplayValue(line.text), leftWidth, { ellipsis: true });
    const gap = Math.max(0, width - displayWidth(left) - rightWidth);
    const text = right ? `${left}${' '.repeat(gap)}${right}` : left;
    return [{ text, sourceText: text, prefix: '', start: globalStart, end: globalStart + text.length, lineKind: line.kind, ...(line.spinner ? { spinnerChar: line.spinner } : {}) }];
  }
  if (!line.text) return [{ text: '', sourceText: '', prefix: '', start: globalStart, end: globalStart, lineKind: line.kind }];
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
    const text = `${prefix}${sourceText}`;
    fragments.push({ text, sourceText, prefix, start: globalStart + startOffset, end: globalStart + endOffset, lineKind: line.kind,
      ...(line.spinner && text.includes(line.spinner) ? { spinnerChar: line.spinner } : {}) });
    cursor = Math.max(end, pieceEnd);
  }
  return fragments.length ? fragments : [{ text: prefix, sourceText: '', prefix, start: globalStart, end: globalStart, lineKind: line.kind }];
}

export function wrapTranscriptBlock(block, width, formatted = formatTranscriptBlock(block)) {
  const lines = transcriptLogicalLines(block);
  const fragments = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    fragments.push(...wrappedLineFragments(lines[index], Math.max(1, width), start));
    start += lines[index].text.length + (index < lines.length - 1 ? 1 : 0);
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
  if (block?.kind !== 'tool') return [];
  return normalizeJobPaths(block.tool.paths || [], jobCwd);
}
