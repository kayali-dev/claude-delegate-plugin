import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { withFileLock } from './lock.mjs';

const PROVIDERS = ['claude', 'codex', 'cursor'];

export function statePath() {
  if (process.env.DELEGATE_STATE_FILE) return process.env.DELEGATE_STATE_FILE;
  const root = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'delegate-router', 'usage.json');
}

export function dataDir() {
  return path.dirname(statePath());
}

export function jobsDir() {
  return path.join(dataDir(), 'jobs');
}

export function auditLogPath() {
  return path.join(dataDir(), 'audit.jsonl');
}

export function providerConfigPath() {
  return process.env.DELEGATE_PROVIDER_CONFIG || path.join(dataDir(), 'providers.json');
}

export function enabledProviders() {
  const override = process.env.DELEGATE_ENABLED_PROVIDERS;
  if (override) return normalizeEnabledProviders(override.split(','));
  try {
    const config = JSON.parse(fs.readFileSync(providerConfigPath(), 'utf8'));
    return normalizeEnabledProviders(config.enabled || []);
  } catch (error) {
    if (error.code === 'ENOENT') return ['codex', 'cursor'];
    throw brokerError('STATE_ERROR', `Cannot read ${providerConfigPath()}: ${error.message}`);
  }
}

export function providerEnabled(provider) {
  if (provider === 'claude') return true;
  validateProvider(provider);
  return enabledProviders().includes(provider);
}

export function saveEnabledProviders(providers) {
  const enabled = normalizeEnabledProviders(providers);
  const file = providerConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return enabled;
}

function normalizeEnabledProviders(providers) {
  const values = [...new Set(providers.map((value) => String(value).trim()).filter(Boolean))];
  for (const provider of values) {
    if (!['codex', 'cursor'].includes(provider)) throw brokerError('INVALID_REQUEST', `Invalid enabled provider: ${provider}`);
  }
  if (!values.length) throw brokerError('INVALID_REQUEST', 'At least one external provider must be enabled');
  return ['codex', 'cursor'].filter((provider) => values.includes(provider));
}

function emptyState() {
  return {
    version: 1,
    providers: Object.fromEntries(PROVIDERS.map((name) => [name, { windows: {} }])),
    history: []
  };
}

export function validateProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw brokerError('INVALID_REQUEST', `Unknown provider: ${provider}. Expected ${PROVIDERS.join(', ')}.`);
  }
  return provider;
}

export function loadState() {
  const file = statePath();
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.providers ||= {};
    for (const name of PROVIDERS) state.providers[name] ||= { windows: {} };
    state.history ||= [];
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw brokerError('STATE_ERROR', `Cannot read ${file}: ${error.message}`);
  }
}

export function saveState(state) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Serialized read-modify-write. Concurrent writers (status-line renders, Codex
// rate-limit notifications, CLI commands) each reload inside the lock, so no
// writer can clobber another's windows with a stale snapshot.
export function mutateState(mutator) {
  return withFileLock(`${statePath()}.lock`, () => {
    const state = loadState();
    const result = mutator(state);
    saveState(state);
    return result ?? state;
  });
}

export function setWindow(state, provider, windowName, usedPercent, options = {}) {
  validateProvider(provider);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw brokerError('INVALID_REQUEST', 'used percent must be between 0 and 100');
  }
  const now = Math.floor(Date.now() / 1000);
  state.providers[provider].windows[windowName] = {
    usedPercent,
    resetsAt: options.resetsAt || null,
    source: options.source || 'manual',
    updatedAt: now
  };
  state.providers[provider].updatedAt = now;
}

export function effectiveUsage(state, provider) {
  validateProvider(provider);
  const now = Math.floor(Date.now() / 1000);
  // Windows with a provider-declared reset expire at that boundary. Windows
  // without one (manual/dashboard entries, quota-error markers) are only
  // reliable while fresh: after the TTL they drop back to unknown instead of
  // silently gating decisions on stale numbers.
  const ttlDays = Number(process.env.DELEGATE_MANUAL_USAGE_TTL_DAYS ?? 7);
  const ttlSeconds = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400 : null;
  const windows = Object.entries(state.providers[provider].windows || {})
    .filter(([, value]) => !value.resetsAt || value.resetsAt > now)
    .filter(([, value]) => value.resetsAt || !ttlSeconds || now - (value.updatedAt || 0) <= ttlSeconds)
    .map(([name, value]) => ({ name, ...value }));
  if (windows.length === 0) return { known: false, usedPercent: null, windows: [] };
  return {
    known: true,
    usedPercent: Math.max(...windows.map((item) => item.usedPercent)),
    windows
  };
}

export function recordEvent(state, event) {
  state.history.push({ at: Math.floor(Date.now() / 1000), ...event });
  if (state.history.length > 500) state.history = state.history.slice(-500);
}

export function providerNames() {
  return [...PROVIDERS];
}

// Cursor overage is soft (on-demand billing) rather than a hard throttle, so
// its default guard bands are stricter to protect spend, not just access.
const AVOID_DEFAULTS = { claude: 90, codex: 90, cursor: 80 };
const WARNING_DEFAULTS = { claude: 80, codex: 80, cursor: 70 };

function thresholdFor(provider, kind, defaults) {
  validateProvider(provider);
  const specific = Number(process.env[`DELEGATE_${provider.toUpperCase()}_${kind}_PERCENT`]);
  if (Number.isFinite(specific)) return specific;
  const global = Number(process.env[`DELEGATE_${kind}_PERCENT`]);
  if (Number.isFinite(global)) return global;
  return defaults[provider];
}

export function avoidPercentFor(provider) {
  return thresholdFor(provider, 'AVOID', AVOID_DEFAULTS);
}

export function warningPercentFor(provider) {
  return thresholdFor(provider, 'WARNING', WARNING_DEFAULTS);
}

function jobPath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw brokerError('INVALID_REQUEST', `Invalid job id: ${id}`);
  return path.join(jobsDir(), `${id}.json`);
}

export function saveJob(job) {
  if (!job?.id) throw brokerError('INVALID_REQUEST', 'Job id is required');
  fs.mkdirSync(jobsDir(), { recursive: true });
  const file = jobPath(job.id);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function loadJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw normalizeBrokerError(error, { defaultCode: 'STATE_ERROR' });
  }
}

export function listJobs() {
  try {
    return fs.readdirSync(jobsDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => loadJob(name.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw normalizeBrokerError(error, { defaultCode: 'STATE_ERROR' });
  }
}
