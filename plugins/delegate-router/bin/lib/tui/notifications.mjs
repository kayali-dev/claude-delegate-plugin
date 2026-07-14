import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CHROME_SEPARATOR } from './glyphs.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function executableOnPath(name, env = process.env) {
  const direct = path.isAbsolute(name) ? [name] : String(env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name));
  return direct.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

function defaultSpawn(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

function scopeViolationCount(job) {
  return Array.isArray(job?.scopeViolations) ? job.scopeViolations.length : Math.max(0, Number(job?.scopeViolations || 0));
}

function snapshot(job) {
  return {
    status: job.status || 'unknown',
    stalled: job.stalled === true,
    violations: scopeViolationCount(job),
    budget: job.stoppedReason === 'budget' || job.errorCode === 'BUDGET_EXCEEDED',
    provider: job.provider || 'unknown'
  };
}

function appleString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')}"`;
}

export class NotificationDispatcher {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.resolveCommand = options.resolveCommand || ((name) => executableOnPath(name, this.env));
    this.spawn = options.spawn || defaultSpawn;
    this.now = options.now || (() => Date.now());
    this.enabled = String(this.env.DELEGATE_TUI_NOTIFY ?? '1') !== '0';
    this.previous = new Map();
    this.lastSent = new Map();
    this.initialized = false;
    this.command = undefined;
  }

  toggle() {
    if (String(this.env.DELEGATE_TUI_NOTIFY ?? '1') === '0') return false;
    this.enabled = !this.enabled;
    return this.enabled;
  }

  commandForPlatform() {
    if (this.command !== undefined) return this.command;
    const name = this.platform === 'darwin' ? 'osascript' : this.platform === 'linux' ? 'notify-send' : null;
    this.command = name ? this.resolveCommand(name) : null;
    return this.command;
  }

  dispatch(job, kind, state = snapshot(job)) {
    if (!this.enabled) return false;
    const command = this.commandForPlatform();
    if (!command) return false;
    const now = this.now();
    if (this.lastSent.has(job.id) && now - this.lastSent.get(job.id) < 5000) return false;
    const safeField = state.provider;
    const body = `${job.id}${CHROME_SEPARATOR}${state.status}${CHROME_SEPARATOR}${safeField}${CHROME_SEPARATOR}${kind}`;
    const args = this.platform === 'darwin'
      ? ['-e', `display notification ${appleString(body)} with title ${appleString('Delegate Router')}`]
      : ['Delegate Router', body];
    try {
      this.spawn(command, args);
      this.lastSent.set(job.id, now);
      return true;
    } catch {
      return false;
    }
  }

  observe(store) {
    const jobs = store?.jobs || [];
    const next = new Map();
    const dispatched = [];
    for (const job of jobs) {
      const current = snapshot(job);
      next.set(job.id, current);
      const previous = this.previous.get(job.id);
      if (!this.initialized) continue;
      let kind = null;
      if (current.budget && !previous?.budget) kind = 'budget';
      else if (current.violations > Number(previous?.violations || 0)) kind = 'scope violation';
      else if (TERMINAL.has(current.status) && !TERMINAL.has(previous?.status)) kind = 'terminal';
      else if (current.stalled && !previous?.stalled) kind = 'stalled';
      if (kind && this.dispatch(job, kind, current)) dispatched.push({ jobId: job.id, kind });
    }
    this.previous = next;
    this.initialized = true;
    return dispatched;
  }
}

export { executableOnPath };
