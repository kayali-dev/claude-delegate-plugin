import fs from 'node:fs';
import path from 'node:path';
import { dataDir, listJobs } from './state.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const WRITE_MODES = new Set(['implement', 'verify']);
const TOOL_WRITE_NAMES = new Set(['Edit', 'Write']);

export const COLLISION_WATCH_PATH_CAP = 256;
export const COLLISION_HOOK_PATH_CAP = 64;

export function collisionWatchSignalPath() {
  return path.join(dataDir(), 'collision-watch.signal');
}

export function ensureCollisionWatchSignal() {
  const file = collisionWatchSignalPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'delegate collision watch refresh\n', { mode: 0o600 });
  try {
    if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

function canonicalDirectory(value) {
  const resolved = path.resolve(String(value || process.cwd()));
  try {
    return (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

function monitorScope(env = process.env) {
  const value = String(env.DELEGATE_MONITOR_SCOPE || 'session').trim().toLowerCase();
  if (value === 'project') return 'workspace';
  return ['session', 'workspace', 'all', 'off'].includes(value) ? value : 'session';
}

function sameDirectory(left, right) {
  return canonicalDirectory(left) === canonicalDirectory(right);
}

export function activeCollisionJob(job) {
  return Boolean(job && ACTIVE_STATUSES.has(job.status) && WRITE_MODES.has(job.mode));
}

export function collisionJobInScope(job, options = {}) {
  if (!activeCollisionJob(job)) return false;
  const scope = options.scope === 'project' ? 'workspace' : (options.scope || 'session');
  if (scope === 'off') return false;
  if (scope === 'all') return true;
  if (scope === 'session') {
    return Boolean(options.sessionId && job.origin?.sessionId === options.sessionId);
  }
  const workspaceId = options.workspaceId || options.projectDir;
  const originWorkspace = job.origin?.workspaceId || job.origin?.projectDir;
  return Boolean(workspaceId && originWorkspace && sameDirectory(workspaceId, originWorkspace));
}

function wildcardWatchRoot(cwd, entry) {
  const normalized = String(entry || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const wildcard = normalized.indexOf('*');
  if (wildcard < 0) return path.resolve(cwd, normalized);
  const prefix = normalized.slice(0, wildcard).replace(/\/+$/, '');
  return path.resolve(cwd, prefix || '.');
}

function changedPaths(job) {
  const values = [
    ...(Array.isArray(job.collisionOwnWrites) ? job.collisionOwnWrites.map((entry) => entry?.path) : []),
    ...(Array.isArray(job.changedFiles?.files) ? job.changedFiles.files : []),
    ...(Array.isArray(job.changedFiles?.entries) ? job.changedFiles.entries.map((entry) => entry?.path) : [])
  ];
  return values.filter((entry) => typeof entry === 'string' && entry && !path.isAbsolute(entry));
}

export function collisionWatchRoots(job) {
  if (!activeCollisionJob(job) || typeof job.cwd !== 'string') return [];
  const roots = [
    ...(Array.isArray(job.allowedPaths) ? job.allowedPaths.map((entry) => wildcardWatchRoot(job.cwd, entry)) : []),
    ...changedPaths(job).map((entry) => path.resolve(job.cwd, entry))
  ].map((entry) => path.normalize(entry));
  const selected = [];
  for (const candidate of [...new Set(roots)].sort()) {
    if (selected.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))) continue;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (selected[index].startsWith(`${candidate}${path.sep}`)) selected.splice(index, 1);
    }
    selected.push(candidate);
  }
  return selected.sort();
}

export function buildCollisionWatchPlan(options = {}) {
  const cap = Math.max(1, Number(options.cap || COLLISION_WATCH_PATH_CAP));
  const scope = options.scope || monitorScope(options.env);
  const jobs = (options.jobs || listJobs())
    .filter((job) => collisionJobInScope(job, {
      scope,
      sessionId: options.sessionId,
      workspaceId: options.workspaceId,
      projectDir: options.projectDir
    }))
    .sort((left, right) => Number(left.origin?.launchedAtMs || left.createdAt || 0)
      - Number(right.origin?.launchedAtMs || right.createdAt || 0) || String(left.id).localeCompare(String(right.id)));
  const candidates = [];
  for (const job of jobs) {
    for (const watchPath of collisionWatchRoots(job)) candidates.push({ jobId: job.id, path: watchPath });
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    unique.push(candidate);
  }
  const signalPath = path.resolve(options.signalPath || collisionWatchSignalPath());
  const ownedCap = Math.max(0, cap - 1);
  const selected = unique.slice(0, ownedCap);
  const omitted = unique.slice(ownedCap);
  return {
    scope,
    watchPaths: [signalPath, ...selected.map((entry) => entry.path)],
    signalPath,
    jobIds: jobs.map((job) => job.id),
    watchedJobIds: [...new Set(selected.map((entry) => entry.jobId))],
    omittedJobIds: [...new Set(omitted.map((entry) => entry.jobId))],
    totalPathCount: unique.length + 1,
    watchedPathCount: selected.length + 1,
    ownedPathCount: unique.length,
    watchedOwnedPathCount: selected.length,
    cap,
    degraded: omitted.length > 0,
    reason: omitted.length > 0 ? 'watch-path-cap-exceeded' : null
  };
}

function toolPath(call, cwd) {
  if (!TOOL_WRITE_NAMES.has(String(call?.tool_name || ''))) return null;
  const value = call?.tool_input?.file_path ?? call?.tool_input?.filePath;
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(cwd || process.cwd(), value);
}

export function collisionHookPaths(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  let values = [];
  if (payload.hook_event_name === 'FileChanged') {
    if (typeof payload.file_path === 'string' && payload.file_path.trim()) {
      values = [path.resolve(cwd, payload.file_path)];
    }
  } else if (payload.hook_event_name === 'PostToolUse') {
    const candidate = toolPath(payload, cwd);
    if (candidate) values = [candidate];
  } else if (payload.hook_event_name === 'PostToolBatch' && Array.isArray(payload.tool_calls)) {
    values = payload.tool_calls.map((call) => toolPath(call, cwd)).filter(Boolean);
  }
  const refreshSignal = path.normalize(collisionWatchSignalPath());
  return [...new Set(values.map((entry) => path.normalize(entry)))]
    .filter((entry) => entry !== refreshSignal)
    .slice(0, COLLISION_HOOK_PATH_CAP);
}
