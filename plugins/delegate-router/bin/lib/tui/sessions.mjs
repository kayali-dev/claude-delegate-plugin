import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../control.mjs';
import { displayWidth, stripAnsi, truncateToWidth } from './width.mjs';

export const DEFAULT_SESSION_ACTIVE_SECONDS = 300;
export const DEFAULT_SESSION_SCAN_LIMIT = 200;
export const DEFAULT_SESSION_TAIL_BYTES = 64 * 1024;

const DEFAULT_SNIPPET_WIDTH = 120;
const MAX_REDACTION_INPUT_CHARS = 4096;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeText(value) {
  return stripAnsi(redact(String(value ?? '').slice(0, MAX_REDACTION_INPUT_CHARS)))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateLabel(value, width) {
  const text = safeText(value);
  const columns = Math.max(1, Math.floor(finiteNonNegative(width, DEFAULT_SNIPPET_WIDTH)));
  if (displayWidth(text) <= columns) return text;
  if (columns === 1) return '.';
  return `${truncateToWidth(text, columns - 1)}.`;
}

function messageMarker(record) {
  for (const value of [record?.type, record?.message?.role, record?.role]) {
    const marker = String(value || '').toLowerCase();
    if (marker === 'user' || marker === 'assistant') return marker;
  }
  return null;
}

function textContent(record) {
  let visited = 0;
  const seen = new Set();
  const visit = (value, allowString, depth) => {
    if (visited >= 256 || depth > 8 || value == null) return null;
    visited += 1;
    if (typeof value === 'string') return allowString && value.trim() ? value : null;
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, allowString, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const key of ['text', 'content']) {
      if (!Object.hasOwn(value, key)) continue;
      const found = visit(value[key], true, depth + 1);
      if (found) return found;
    }
    for (const key of ['message', 'data', 'payload']) {
      if (!Object.hasOwn(value, key)) continue;
      const found = visit(value[key], false, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(record, false, 0);
}

function activityLabel(record, width) {
  const marker = messageMarker(record);
  const snippet = textContent(record);
  if (marker) return truncateLabel(snippet ? `${marker}: ${snippet}` : marker, width);
  if (typeof record?.type === 'string' && record.type.trim()) return truncateLabel(record.type, width);
  return '(unreadable)';
}

function recordCwd(record) {
  for (const value of [record?.cwd, record?.project?.cwd, record?.session?.cwd]) {
    if (typeof value === 'string' && path.isAbsolute(value)) return path.normalize(value);
  }
  return null;
}

export function encodeProjectDirectory(cwd) {
  return path.resolve(String(cwd || path.parse(process.cwd()).root)).split(path.sep).join('-');
}

function existingDecodedDirectory(encoded, fsImpl) {
  const root = path.parse(path.resolve(path.sep)).root;
  const target = String(encoded || '');
  const prefix = encodeProjectDirectory(root);
  if (!target.startsWith(prefix)) return null;
  const suffix = target.slice(prefix.length);
  if (!suffix) return root;
  const memo = new Set();
  let visits = 0;
  const visit = (directory, offset) => {
    if (visits >= 512) return null;
    const memoKey = `${directory}\u0000${offset}`;
    if (memo.has(memoKey)) return null;
    memo.add(memoKey);
    visits += 1;
    let entries;
    try {
      entries = fsImpl.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name));
    } catch { return null; }
    for (const entry of entries) {
      const separator = offset === 0 ? '' : '-';
      const token = `${separator}${entry.name}`;
      if (!suffix.startsWith(token, offset)) continue;
      const nextOffset = offset + token.length;
      const candidate = path.join(directory, entry.name);
      if (nextOffset === suffix.length) return candidate;
      if (suffix[nextOffset] !== '-') continue;
      const found = visit(candidate, nextOffset);
      if (found) return found;
    }
    return null;
  };
  return visit(root, 0);
}

export function decodeProjectDirectory(encoded, options = {}) {
  const value = String(encoded || '');
  const hint = typeof options.cwdHint === 'string' && path.isAbsolute(options.cwdHint)
    ? path.normalize(options.cwdHint)
    : null;
  if (hint && encodeProjectDirectory(hint) === value) return hint;
  const existing = existingDecodedDirectory(value, options.fs || fs);
  if (existing) return existing;
  const root = path.parse(path.resolve(path.sep)).root;
  const withoutRoot = value.startsWith('-') ? value.slice(1) : value;
  return path.join(root, ...withoutRoot.split('-').filter(Boolean));
}

export function parseSessionTailText(text, options = {}) {
  const lines = String(text || '').split(/\r?\n/);
  if (options.truncatedStart) lines.shift();
  const maxLineChars = Number.isFinite(Number(options.maxLineChars)) ? Math.max(0, Number(options.maxLineChars)) : Number.POSITIVE_INFINITY;
  let lastActivity = null;
  let cwd = null;
  let parseableLines = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.trim() || line.length > maxLineChars) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { continue; }
    if (!record || typeof record !== 'object') continue;
    parseableLines += 1;
    if (!lastActivity) lastActivity = activityLabel(record, options.snippetWidth || DEFAULT_SNIPPET_WIDTH);
    if (!cwd) cwd = recordCwd(record);
    if (lastActivity && cwd) break;
  }
  return { lastActivity: lastActivity || '(unreadable)', cwd, parseableLines };
}

export function parseSessionTail(file, options = {}) {
  const tailBytes = Math.max(1024, Math.floor(finiteNonNegative(options.tailBytes, DEFAULT_SESSION_TAIL_BYTES)));
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    const length = Math.min(stat.size, tailBytes);
    if (!length) return { lastActivity: '(unreadable)', cwd: null, parseableLines: 0, bytesRead: 0 };
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    return {
      ...parseSessionTailText(buffer.subarray(0, bytesRead).toString('utf8'), {
        truncatedStart: start > 0,
        snippetWidth: options.snippetWidth,
        maxLineChars: options.maxLineChars
      }),
      bytesRead
    };
  } catch {
    return { lastActivity: '(unreadable)', cwd: null, parseableLines: 0, bytesRead: 0 };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function visibleClaudeMessage(record) {
  const message = record?.message && typeof record.message === 'object' ? record.message : record;
  const role = String(message?.role || record?.type || '').toLowerCase();
  if (!['user', 'assistant'].includes(role)) return null;
  const content = Array.isArray(message.content) ? message.content : [message.content];
  const texts = content.flatMap((block) => {
    if (typeof block === 'string') return [block];
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return [];
    return [block.text];
  }).map((text) => safeText(text)).filter(Boolean);
  if (!texts.length) return null;
  return { role, text: texts.join('\n').slice(0, 16384) };
}

export function readClaudeTranscriptTail(file, options = {}) {
  const tailBytes = Math.max(1024, Math.floor(finiteNonNegative(options.tailBytes, DEFAULT_SESSION_TAIL_BYTES)));
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 200)));
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    const length = Math.min(stat.size, tailBytes);
    if (!length) return { events: [], bytesRead: 0, totalBytes: stat.size, truncated: false };
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    const events = [];
    for (const line of lines) {
      if (!line || line.length > 256 * 1024) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const visible = visibleClaudeMessage(record);
      if (!visible) continue;
      events.push({
        schemaVersion: 1,
        seq: events.length + 1,
        at: Date.parse(record.timestamp || '') || stat.mtimeMs,
        type: visible.role === 'user' ? 'message.user' : 'message.completed',
        data: { role: visible.role, text: visible.text },
        source: 'claude-agent-transcript'
      });
      if (events.length > limit) events.shift();
    }
    return { events, bytesRead, totalBytes: stat.size, truncated: start > 0 };
  } catch {
    return { events: [], bytesRead: 0, totalBytes: 0, truncated: false };
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

export function classifySession(mtimeMs, options = {}) {
  const now = finiteNonNegative(options.now, Date.now());
  const activeSeconds = finiteNonNegative(options.activeSeconds, DEFAULT_SESSION_ACTIVE_SECONDS);
  const ageMs = Math.max(0, now - finiteNonNegative(mtimeMs, 0));
  return { active: ageMs <= activeSeconds * 1000, ageMs, activeSeconds };
}

export function claudeProjectsDirectory(env = process.env, home = os.homedir()) {
  return path.resolve(String(env.DELEGATE_CLAUDE_PROJECTS_DIR || path.join(home, '.claude', 'projects')));
}

function unavailableScan(projectsDir, reason) {
  return {
    available: false,
    projectsDir,
    sessions: [],
    scanned: 0,
    totalFiles: 0,
    capped: false,
    error: `Claude projects directory is missing or unreadable: ${projectsDir}${reason ? ` (${reason})` : ''}`
  };
}

export function scanClaudeSessions(options = {}) {
  const env = options.env || process.env;
  const projectsDir = path.resolve(String(options.projectsDir || claudeProjectsDirectory(env)));
  const now = finiteNonNegative(options.now, Date.now());
  const activeSeconds = finiteNonNegative(options.activeSeconds ?? env.DELEGATE_SESSION_ACTIVE_SECONDS, DEFAULT_SESSION_ACTIVE_SECONDS);
  const maxSessions = Math.max(1, Math.floor(finiteNonNegative(options.maxSessions, DEFAULT_SESSION_SCAN_LIMIT)));
  let projectEntries;
  try { projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true }); }
  catch (error) { return unavailableScan(projectsDir, error?.code || 'unavailable'); }

  const candidates = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(projectsDir, projectEntry.name);
    let sessionEntries;
    try { sessionEntries = fs.readdirSync(projectPath, { withFileTypes: true }); }
    catch { continue; }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.jsonl')) continue;
      const file = path.join(projectPath, sessionEntry.name);
      try {
        const stat = fs.statSync(file);
        candidates.push({
          file,
          encodedProjectDir: projectEntry.name,
          id: sessionEntry.name.slice(0, -'.jsonl'.length),
          mtimeMs: stat.mtimeMs,
          size: stat.size
        });
      } catch {}
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id));
  const selected = candidates.slice(0, maxSessions);
  const decodedProjects = new Map();
  const sessions = selected.map((candidate) => {
    const tail = parseSessionTail(candidate.file, { tailBytes: options.tailBytes, snippetWidth: options.snippetWidth });
    let cwd = tail.cwd && encodeProjectDirectory(tail.cwd) === candidate.encodedProjectDir ? tail.cwd : decodedProjects.get(candidate.encodedProjectDir);
    if (!cwd) cwd = decodeProjectDirectory(candidate.encodedProjectDir);
    decodedProjects.set(candidate.encodedProjectDir, cwd);
    return {
      id: candidate.id,
      cwd,
      encodedProjectDir: candidate.encodedProjectDir,
      mtimeMs: candidate.mtimeMs,
      size: candidate.size,
      lastActivity: tail.lastActivity,
      ...classifySession(candidate.mtimeMs, { now, activeSeconds })
    };
  });
  sessions.sort((left, right) => Number(right.active) - Number(left.active)
    || right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id));
  return {
    available: true,
    projectsDir,
    sessions,
    scanned: sessions.length,
    totalFiles: candidates.length,
    capped: candidates.length > sessions.length,
    error: null
  };
}

function normalizedCwd(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return path.resolve(value); }
  catch { return null; }
}

export function correlateSessions(sessions = [], jobs = [], writerLocks = []) {
  const activeJobsByCwd = new Map();
  for (const job of jobs) {
    if (!job || TERMINAL.has(job.status)) continue;
    const cwd = normalizedCwd(job.cwd);
    if (cwd) activeJobsByCwd.set(cwd, (activeJobsByCwd.get(cwd) || 0) + 1);
  }
  const writersByCwd = new Map();
  for (const lock of writerLocks) {
    const cwd = normalizedCwd(lock?.cwd);
    if (cwd && !writersByCwd.has(cwd)) writersByCwd.set(cwd, lock);
  }
  return sessions.map((session) => {
    const cwd = normalizedCwd(session?.cwd);
    const writer = cwd ? writersByCwd.get(cwd) || null : null;
    return {
      ...session,
      activeDelegateJobs: cwd ? activeJobsByCwd.get(cwd) || 0 : 0,
      writerLock: writer,
      writerJobId: writer?.jobId || null
    };
  });
}
