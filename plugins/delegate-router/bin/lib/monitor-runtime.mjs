import fs from 'node:fs';
import { NotificationPolicy } from './monitor-policy.mjs';
import { MonitorStore, preferenceSnoozed } from './monitor-store.mjs';

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 75;

export function monitorEnabled(env = process.env) {
  return String(env.DELEGATE_MONITOR ?? '1') !== '0';
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
    try {
      const now = Date.now();
      const snapshots = this.store.scan();
      const snoozed = preferenceSnoozed(this.store.readPreference(), now);
      const lines = this.started
        ? this.policy.observe(snapshots, { now, snoozed })
        : this.policy.bootstrap(snapshots, { now, snoozed });
      this.started = true;
      for (const line of lines) this.emit(line);
      this.installWatchers();
      return lines;
    } catch (error) {
      this.logOnce(`scan:${error.code || error.name || 'error'}`, error);
      return [];
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
    return { disabled: false };
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
