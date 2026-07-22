import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from './control.mjs';
import { listJobs } from './state.mjs';
import { displayWidth, stripAnsi, truncateToWidth } from './tui/width.mjs';

export const DEFAULT_CODEX_SCAN_LIMIT = 200;
export const DEFAULT_CODEX_TAIL_BYTES = 64 * 1024;
const DEFAULT_META_BYTES = 64 * 1024;
const DEFAULT_LABEL_WIDTH = 120;
const MAX_CANDIDATES = 5000;
const MAX_LINE_CHARS = 256 * 1024;
const TOOL_ORIGINATORS = new Set([
  'delegate-router',
  'codex_cli_rs',
  'codex-companion',
  'codex-companion-runtime',
  'openai-codex'
]);

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeText(value, maxChars = 4096) {
  return stripAnsi(redact(String(value ?? '').slice(0, maxChars)))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeLabel(value, width = DEFAULT_LABEL_WIDTH) {
  const text = safeText(value);
  const columns = Math.max(1, Math.floor(finiteNonNegative(width, DEFAULT_LABEL_WIDTH)));
  if (displayWidth(text) <= columns) return text;
  if (columns === 1) return '.';
  return `${truncateToWidth(text, columns - 1)}.`;
}

function readBoundedTail(file, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    const length = Math.min(stat.size, maxBytes);
    if (!length) return { text: '', size: stat.size, mtimeMs: stat.mtimeMs, truncatedStart: false };
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), size: stat.size, mtimeMs: stat.mtimeMs, truncatedStart: start > 0 };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function tailRecords(file, options = {}) {
  try {
    const tail = readBoundedTail(file, Math.max(1024, Math.floor(finiteNonNegative(options.tailBytes, DEFAULT_CODEX_TAIL_BYTES))));
    const lines = tail.text.split(/\r?\n/);
    if (tail.truncatedStart) lines.shift();
    const records = [];
    for (const line of lines) {
      if (!line || line.length > MAX_LINE_CHARS) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') records.push(record);
      } catch {}
    }
    return { ...tail, records };
  } catch {
    return { text: '', size: 0, mtimeMs: 0, truncatedStart: false, records: [] };
  }
}

function readSessionMeta(file, maxBytes = DEFAULT_META_BYTES) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    const length = Math.min(stat.size, Math.max(1024, maxBytes));
    if (!length) return null;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    if (newline < 0 && stat.size > length) return null;
    const line = text.slice(0, newline < 0 ? text.length : newline).replace(/\r$/, '');
    if (!line || line.length > maxBytes) return null;
    const record = JSON.parse(line);
    return record?.type === 'session_meta' && record.payload && typeof record.payload === 'object' ? record.payload : null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

export function codexSessionsDirectory(env = process.env, home = os.homedir()) {
  return path.resolve(String(env.DELEGATE_CODEX_SESSIONS_DIR || path.join(home, '.codex', 'sessions')));
}

export function codexThreadIdentity(meta = {}) {
  // readSessionMeta returns an explicit null for in-flight files whose first
  // line is not yet fully written; a default parameter does not cover that.
  if (!meta || typeof meta !== 'object') return null;
  for (const value of [meta.id, meta.session_id, meta.thread_id, meta.threadId]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function toolOriginEvidence(meta = {}) {
  if (!meta || typeof meta !== 'object') return null;
  const originator = typeof meta.originator === 'string' ? meta.originator.trim() : '';
  const source = meta.source;
  if (originator === 'codex-tui' || source === 'cli') return null;
  if (TOOL_ORIGINATORS.has(originator)) return `originator:${originator}`;
  if (source === 'mcp' || source === 'app-server') return `source:${source}`;
  if (source && typeof source === 'object' && source.subagent && typeof source.subagent === 'object') return 'source:subagent';
  return null;
}

export function brokerOwnedCodexThreadIds(records = listJobs()) {
  const ids = new Set();
  for (const job of records) {
    if (job?.provider !== 'codex') continue;
    for (const value of [job.providerSessionId, job.session, job.threadId]) {
      if (typeof value === 'string' && value.trim()) ids.add(value.trim());
    }
  }
  return ids;
}

function collectCandidates(root) {
  const candidates = [];
  const visit = (directory, depth) => {
    if (depth > 4 || candidates.length >= MAX_CANDIDATES) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(file);
          candidates.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {}
      }
    }
  };
  visit(root, 0);
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
}

function messageText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = messageText(item);
      if (found) return found;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  for (const key of ['content', 'message']) {
    const found = messageText(value[key]);
    if (found) return found;
  }
  return '';
}

function activityForRecord(record, width) {
  if (record?.type === 'event_msg') {
    const kind = String(record.payload?.type || 'event');
    if (kind === 'agent_message') return safeLabel(`assistant: ${record.payload?.message || ''}`, width);
    if (kind === 'user_message') return safeLabel(`user: ${record.payload?.message || ''}`, width);
    if (kind === 'token_count') return 'usage updated';
    return safeLabel(kind.replaceAll('_', ' '), width);
  }
  if (record?.type === 'response_item') {
    const kind = String(record.payload?.type || 'response');
    if (kind === 'reasoning') return '';
    if (kind === 'message') return safeLabel(`${record.payload?.role || 'assistant'}: ${messageText(record.payload?.content)}`, width);
    if (kind.includes('tool_call')) return safeLabel(`tool: ${record.payload?.name || kind}`, width);
    return safeLabel(kind.replaceAll('_', ' '), width);
  }
  if (['turn_context', 'session_meta', 'world_state'].includes(record?.type)) return '';
  return safeLabel(record?.type || '', width);
}

function usageFromRecords(records) {
  let usage = null;
  for (const record of records) {
    if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
    const source = record.payload?.info?.total_token_usage;
    if (!source || typeof source !== 'object') continue;
    const inputTokens = Number(source.input_tokens);
    const outputTokens = Number(source.output_tokens);
    const totalTokens = Number(source.total_tokens);
    if (![inputTokens, outputTokens, totalTokens].some(Number.isFinite)) continue;
    usage = {
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      totalTokens: Number.isFinite(totalTokens)
        ? totalTokens
        : (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)
    };
  }
  return usage;
}

function modelFromRecords(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const model = records[index]?.type === 'turn_context' ? records[index]?.payload?.model : null;
    if (typeof model === 'string' && model.trim()) return safeText(model, 256);
  }
  return null;
}

function publicExternalId(threadId) {
  const safe = String(threadId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const suffix = safe && safe.length <= 128 ? safe : crypto.createHash('sha256').update(String(threadId)).digest('hex').slice(0, 32);
  return `external-codex-${suffix}`;
}

function sizeLabel(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}K`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)}M`;
}

export function scanExternalCodexThreads(options = {}) {
  const env = options.env || process.env;
  const sessionsDir = path.resolve(String(options.sessionsDir || codexSessionsDirectory(env)));
  const maxThreads = Math.max(1, Math.floor(finiteNonNegative(options.maxThreads, DEFAULT_CODEX_SCAN_LIMIT)));
  const ownedIds = options.ownedIds instanceof Set ? options.ownedIds : brokerOwnedCodexThreadIds(options.jobs || listJobs());
  let candidates;
  try {
    if (!fs.statSync(sessionsDir).isDirectory()) throw new Error(`${sessionsDir} is not a directory`);
    candidates = collectCandidates(sessionsDir);
  }
  catch (error) {
    return { available: false, sessionsDir, threads: [], sources: new Map(), scanned: 0, totalFiles: 0, capped: false, ownedExcluded: 0, personalExcluded: 0, duplicatesExcluded: 0, unreadableExcluded: 0, error: safeText(error.message, 1024) };
  }
  const selected = candidates.slice(0, maxThreads);
  const threads = [];
  const sources = new Map();
  const seenThreadIds = new Set();
  let ownedExcluded = 0;
  let personalExcluded = 0;
  let duplicatesExcluded = 0;
  let unreadableExcluded = 0;
  for (const candidate of selected) {
    // One in-flight or malformed rollout file must never abort the whole scan:
    // this loop runs on the TUI refresh timer, where a throw kills the process.
    try {
      scanCandidate(candidate);
    } catch {
      unreadableExcluded += 1;
    }
  }
  function scanCandidate(candidate) {
    const meta = readSessionMeta(candidate.file, options.metaBytes || DEFAULT_META_BYTES);
    const threadId = codexThreadIdentity(meta);
    if (!threadId) return;
    if (seenThreadIds.has(threadId)) {
      duplicatesExcluded += 1;
      return;
    }
    seenThreadIds.add(threadId);
    if (ownedIds.has(threadId) || (meta?.session_id && ownedIds.has(meta.session_id))) {
      ownedExcluded += 1;
      return;
    }
    const originEvidence = toolOriginEvidence(meta);
    if (!originEvidence) {
      personalExcluded += 1;
      return;
    }
    const tail = tailRecords(candidate.file, { tailBytes: options.tailBytes });
    let activityLabel = '(unreadable)';
    for (let index = tail.records.length - 1; index >= 0; index -= 1) {
      activityLabel = activityForRecord(tail.records[index], options.snippetWidth || DEFAULT_LABEL_WIDTH);
      if (activityLabel) break;
    }
    const usage = usageFromRecords(tail.records);
    const id = publicExternalId(threadId);
    const createdAtMs = Date.parse(meta?.timestamp || '') || candidate.mtimeMs;
    const model = modelFromRecords(tail.records);
    const row = {
      schemaVersion: 1,
      id,
      provider: 'codex',
      requestedModel: model || 'external',
      model: model || sizeLabel(candidate.size),
      resolvedModel: model,
      mode: 'external',
      status: 'external',
      phase: 'external',
      revision: 0,
      lastSeq: 0,
      cwd: typeof meta?.cwd === 'string' && path.isAbsolute(meta.cwd) ? safeText(path.normalize(meta.cwd), 4096) : null,
      transport: 'external',
      managedBy: 'external-codex-scanner',
      managed: false,
      external: true,
      readOnly: true,
      providerSessionId: safeText(threadId, 256),
      session: safeText(threadId, 256),
      originEvidence,
      createdAt: Math.floor(createdAtMs / 1000),
      createdAtMs,
      updatedAt: Math.floor(candidate.mtimeMs / 1000),
      lastActivityAt: candidate.mtimeMs,
      approximateSize: candidate.size,
      approximateSizeLabel: sizeLabel(candidate.size),
      activityLabel,
      usage,
      attributionConfidence: 'external-metadata'
    };
    threads.push(row);
    sources.set(id, candidate.file);
  }
  return {
    available: true,
    sessionsDir,
    threads,
    sources,
    scanned: selected.length,
    totalFiles: candidates.length,
    capped: candidates.length > selected.length,
    ownedExcluded,
    personalExcluded,
    duplicatesExcluded,
    unreadableExcluded,
    error: null
  };
}

export function externalThreadStats(scan = {}) {
  const threads = Array.isArray(scan.threads) ? scan.threads : [];
  const withUsage = threads.filter((thread) => thread.usage && typeof thread.usage === 'object');
  const totals = withUsage.reduce((sum, thread) => ({
    inputTokens: sum.inputTokens + Number(thread.usage.inputTokens || 0),
    outputTokens: sum.outputTokens + Number(thread.usage.outputTokens || 0),
    totalTokens: sum.totalTokens + Number(thread.usage.totalTokens || 0)
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    threadCount: threads.length,
    usageThreadCount: withUsage.length,
    tokenTotals: withUsage.length ? totals : null
  };
}

export function readCodexThreadTail(file, options = {}) {
  const tail = tailRecords(file, options);
  const events = [];
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 200)));
  for (const record of tail.records) {
    let type = null;
    let data = null;
    if (record?.type === 'event_msg' && record.payload?.type === 'agent_message') {
      type = 'message.completed';
      data = { text: safeText(record.payload.message, 16384), role: 'assistant' };
    } else if (record?.type === 'event_msg' && record.payload?.type === 'user_message') {
      type = 'message.user';
      data = { text: safeText(record.payload.message, 16384), role: 'user' };
    } else if (record?.type === 'event_msg' && record.payload?.type === 'token_count') {
      const usage = usageFromRecords([record]);
      if (usage) { type = 'usage.updated'; data = usage; }
    } else if (record?.type === 'response_item' && record.payload?.type === 'custom_tool_call') {
      type = 'tool.completed';
      data = { id: safeText(record.payload.call_id || record.payload.id, 256), name: safeText(record.payload.name || 'tool', 256), status: safeText(record.payload.status || 'completed', 64) };
    }
    if (!type || !data || (Object.hasOwn(data, 'text') && !data.text)) continue;
    events.push({ schemaVersion: 1, seq: events.length + 1, at: Date.parse(record.timestamp || '') || tail.mtimeMs, type, data: redact(data) });
    if (events.length > limit) events.shift();
  }
  return { events, bytesRead: Buffer.byteLength(tail.text), totalBytes: tail.size, truncated: tail.truncatedStart };
}
