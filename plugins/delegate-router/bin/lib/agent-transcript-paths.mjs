import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_AGENT_TRANSCRIPT_ENTRY_LIMIT = 200;
const DEFAULT_AGENT_SESSION_LIMIT = 8;
const DEFAULT_AGENT_PROJECT_ENTRY_LIMIT = 200;
const TRANSCRIPT_AGENT_ID = /^[a-f0-9]{16,32}$/i;

function boundedPositiveInteger(value, fallback, maximum = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(number)));
}

export function normalizeTranscriptAgentId(value) {
  const id = String(value || '').trim();
  return TRANSCRIPT_AGENT_ID.test(id) ? id : null;
}

export function transcriptAgentIdForJob(job) {
  return normalizeTranscriptAgentId(job?.transcriptAgentId)
    // Records written before transcriptAgentId existed occasionally retained
    // the hook id in agentId. Display names containing @ deliberately fail
    // this strict compatibility check and are treated as absent.
    || normalizeTranscriptAgentId(job?.agentId);
}

export function transcriptPathMatchesAgentId(file, value) {
  const id = normalizeTranscriptAgentId(value);
  if (!id || typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const name = path.basename(path.normalize(file));
  return name === `agent-${id}.jsonl` || name.startsWith(`agent-${id}-`) && name.endsWith('.jsonl');
}

export function transcriptAgentIdFromPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const match = path.basename(path.normalize(file)).match(/^agent-([a-f0-9]{16,32})(?:-|\.jsonl$)/i);
  return normalizeTranscriptAgentId(match?.[1]);
}

export function encodeClaudeProjectDirectory(cwd) {
  return path.resolve(String(cwd || path.parse(process.cwd()).root)).split(path.sep).join('-');
}

function transcriptCandidates(directory, value, options = {}) {
  const id = normalizeTranscriptAgentId(value);
  if (!id) return [];
  const maxEntries = boundedPositiveInteger(options.maxEntries, DEFAULT_AGENT_TRANSCRIPT_ENTRY_LIMIT);
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, maxEntries); }
  catch { return []; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    && (entry.name === `agent-${id}.jsonl` || entry.name.startsWith(`agent-${id}-`)))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      try { return [{ file, mtimeMs: fs.statSync(file).mtimeMs }]; } catch { return []; }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
}

function transcriptInSidecar(sidecar, transcriptAgentId, options = {}) {
  if (typeof sidecar !== 'string' || !path.isAbsolute(sidecar)) return null;
  return transcriptCandidates(path.join(path.normalize(sidecar), 'subagents'), transcriptAgentId, options)[0]?.file || null;
}

export function resolveStoredAgentTranscriptPath(options = {}) {
  const transcriptAgentId = normalizeTranscriptAgentId(options.transcriptAgentId);
  if (!transcriptAgentId) return null;
  if (typeof options.coordinatorSidecarDir === 'string' && path.isAbsolute(options.coordinatorSidecarDir)) {
    const sidecar = path.normalize(options.coordinatorSidecarDir);
    const existing = transcriptInSidecar(sidecar, transcriptAgentId, options);
    if (existing) return existing;
    return options.allowMissing === false
      ? null
      : path.join(sidecar, 'subagents', `agent-${transcriptAgentId}.jsonl`);
  }
  if (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) return null;
  if (typeof options.projectsDir !== 'string' || !path.isAbsolute(options.projectsDir)) return null;

  const projectDirectory = path.join(path.normalize(options.projectsDir), encodeClaudeProjectDirectory(options.cwd));
  const maxProjectEntries = boundedPositiveInteger(options.maxProjectEntries, DEFAULT_AGENT_PROJECT_ENTRY_LIMIT);
  const maxSessionDirs = boundedPositiveInteger(options.maxSessionDirs, DEFAULT_AGENT_SESSION_LIMIT, 64);
  let entries;
  try { entries = fs.readdirSync(projectDirectory, { withFileTypes: true }); }
  catch { return null; }
  const sessions = entries.filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const directory = path.join(projectDirectory, entry.name);
    try { return [{ directory, mtimeMs: fs.statSync(directory).mtimeMs }]; } catch { return []; }
  }).sort((left, right) => right.mtimeMs - left.mtimeMs || left.directory.localeCompare(right.directory)).slice(0, maxProjectEntries);
  for (const session of sessions.slice(0, maxSessionDirs)) {
    const transcript = transcriptInSidecar(session.directory, transcriptAgentId, options);
    if (transcript) return transcript;
  }
  return null;
}

export function agentMetadataPath(coordinatorSidecarDir, value) {
  const transcriptAgentId = normalizeTranscriptAgentId(value);
  if (!transcriptAgentId || typeof coordinatorSidecarDir !== 'string' || !path.isAbsolute(coordinatorSidecarDir)) return null;
  return path.join(path.normalize(coordinatorSidecarDir), 'subagents', `agent-${transcriptAgentId}.meta.json`);
}
