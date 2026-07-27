import fs from 'node:fs';
import path from 'node:path';
import { resolveMonitorSession } from './monitor-correlation.mjs';
import { NotificationPolicy } from './monitor-policy.mjs';
import { MonitorStore, preferenceSnoozed } from './monitor-store.mjs';

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 75;

export function monitorEnabled(env = process.env) {
  return String(env.DELEGATE_MONITOR ?? '1') !== '0' && monitorScope(env) !== 'off';
}

export function monitorScope(env = process.env) {
  const value = String(env.DELEGATE_MONITOR_SCOPE || 'session').trim().toLowerCase();
  if (value === 'project') return 'workspace';
  return ['session', 'workspace', 'all', 'off'].includes(value) ? value : 'session';
}

export function normalizeMonitorProjectDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  try {
    return (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

export function scopeMonitorSnapshots(snapshots, options = {}) {
  const scope = options.scope === 'project' ? 'workspace' : (options.scope || 'session');
  if (scope === 'off') return [];
  if (scope === 'all') return snapshots;
  if (scope === 'session') {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    if (!sessionId) return [];
    return snapshots.filter((snapshot) => snapshot?.job?.origin?.sessionId === sessionId);
  }
  const workspaceId = normalizeMonitorProjectDirectory(options.workspaceId || options.projectDir);
  if (!workspaceId) return [];
  return snapshots.filter((snapshot) => {
    const origin = snapshot?.job?.origin;
    if (!origin || typeof origin !== 'object') return false;
    const originWorkspace = normalizeMonitorProjectDirectory(origin.workspaceId || origin.projectDir);
    return originWorkspace != null && originWorkspace === workspaceId;
  });
}

function monitorWorkspaceLabel(workspaceId) {
  const name = path.basename(path.normalize(workspaceId || 'workspace'));
  return String(name || 'workspace')
    .replace(/[\u0000-\u001f\u007f-\u009f\[\]]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 64) || 'workspace';
}

function correlationDegradationLine(workspaceId, reason) {
  const safeReason = String(reason || 'unavailable').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80);
  return `delegate[${monitorWorkspaceLabel(workspaceId)}]: monitor-scope degraded (session correlation ${safeReason}; using workspace scope)`;
}

function numericEnv(env, name, fallback, minimum = 0) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function createOnceLogger(write = (line) => process.stderr.write(`${line}\n`)) {
  const seen = new Set();
  return (kind, error) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    const code = String(error?.code || error?.name || 'error').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    write(`delegate-monitor: ${kind} (${code || 'error'}); continuing`);
  };
}

export class DelegateMonitor {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.scope = options.scope || monitorScope(this.env);
    this.projectDir = normalizeMonitorProjectDirectory(
      options.projectDir || this.env.CLAUDE_PROJECT_DIR || process.cwd()
    );
    this.workspaceId = normalizeMonitorProjectDirectory(options.workspaceId || this.projectDir);
    this.emit = options.emit || ((line) => process.stdout.write(`${line}\n`));
    this.logOnce = options.logOnce || createOnceLogger(options.writeError);
    this.pollMs = Math.max(100, Number(options.pollMs || numericEnv(this.env, 'DELEGATE_MONITOR_POLL_MS', DEFAULT_POLL_MS, 100)));
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    this.store = options.store || new MonitorStore({
      onError: this.logOnce,
      ...(options.jobsDirectory ? { jobsDirectory: options.jobsDirectory } : {}),
      ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
      ...(options.preferenceFile ? { preferenceFile: options.preferenceFile } : {})
    });
    this.sessionId = null;
    this.effectiveScope = this.scope;
    this.correlation = null;
    this.degradation = null;
    this.degradationEmitted = false;
    if (this.scope === 'session') {
      this.correlation = options.correlation || (options.sessionId
        ? { ok: true, sessionId: options.sessionId, reason: null, recorded: true }
        : resolveMonitorSession({
            stateDirectory: this.store.stateDirectory,
            workspaceId: this.workspaceId,
            parentPid: options.parentPid ?? options.coordinatorPid,
            ...(options.processTable ? { processTable: options.processTable } : {}),
            ...(options.processes ? { processes: options.processes } : {})
          }));
      if (this.correlation.ok && this.correlation.sessionId) {
        this.sessionId = this.correlation.sessionId;
      } else {
        this.effectiveScope = 'workspace';
        this.degradation = {
          requestedScope: 'session',
          effectiveScope: 'workspace',
          reason: this.correlation.reason || 'unavailable',
          recorded: this.correlation.recorded === true
        };
      }
    }
    this.policy = options.policy || new NotificationPolicy({
      stallMs: numericEnv(this.env, 'DELEGATE_MONITOR_STALL_SECONDS', 600, 0) * 1000,
      cooldownMs: numericEnv(this.env, 'DELEGATE_MONITOR_COOLDOWN_SECONDS', 30, 0) * 1000,
      maxLinesPerMinute: numericEnv(this.env, 'DELEGATE_MONITOR_MAX_LINES_PER_MINUTE', 6, 1)
    });
    this.watchers = new Map();
    this.pollTimer = null;
    this.debounceTimer = null;
    this.started = false;
    this.closed = false;
  }

  scan() {
    if (this.closed || !monitorEnabled(this.env)) return [];
    const statusLines = [];
    if (this.degradation && !this.degradationEmitted) {
      this.degradationEmitted = true;
      statusLines.push(correlationDegradationLine(this.workspaceId, this.degradation.reason));
    }
    try {
      const now = Date.now();
      const snapshots = scopeMonitorSnapshots(this.store.scan(), {
        scope: this.effectiveScope,
        projectDir: this.projectDir,
        workspaceId: this.workspaceId,
        sessionId: this.sessionId
      });
      const snoozed = preferenceSnoozed(this.store.readPreference(), now);
      const policyLines = this.started
        ? this.policy.observe(snapshots, { now, snoozed })
        : this.policy.bootstrap(snapshots, { now, snoozed });
      this.started = true;
      const lines = [...statusLines, ...policyLines];
      for (const line of lines) this.emit(line);
      this.installWatchers();
      return lines;
    } catch (error) {
      this.logOnce(`scan:${error.code || error.name || 'error'}`, error);
      for (const line of statusLines) this.emit(line);
      return statusLines;
    }
  }

  schedule() {
    if (this.closed || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scan();
    }, this.debounceMs);
  }

  watch(directory, kind) {
    if (this.watchers.has(directory)) return;
    let watcher;
    try {
      watcher = fs.watch(directory, { persistent: true }, () => this.schedule());
    } catch (error) {
      if (error.code !== 'ENOENT') this.logOnce(`watch:${kind}:${error.code || error.name || 'error'}`, error);
      return;
    }
    watcher.on('error', (error) => {
      this.logOnce(`watch:${kind}:${error.code || error.name || 'error'}`, error);
      try { watcher.close(); } catch {}
      this.watchers.delete(directory);
    });
    this.watchers.set(directory, watcher);
  }

  installWatchers() {
    this.watch(this.store.directory, 'jobs');
    if (this.store.stateDirectory !== this.store.directory) this.watch(this.store.stateDirectory, 'state');
  }

  start() {
    if (!monitorEnabled(this.env)) return { disabled: true };
    this.scan();
    this.pollTimer = setInterval(() => this.scan(), this.pollMs);
    return {
      disabled: false,
      requestedScope: this.scope,
      effectiveScope: this.effectiveScope,
      degradation: this.degradation
    };
  }

  stop() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch {}
    }
    this.watchers.clear();
  }
}
