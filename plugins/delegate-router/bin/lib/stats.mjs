import fs from 'node:fs';
import { brokerError } from './errors.mjs';
import { auditLogPath } from './state.mjs';

function durationMs(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)([smhdw])$/i);
  if (!match) throw brokerError('INVALID_REQUEST', "since must be a duration such as '24h' or '7d'");
  const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2].toLowerCase()];
  const result = Number(match[1]) * multiplier;
  if (!Number.isFinite(result) || result <= 0) throw brokerError('INVALID_REQUEST', 'since duration must be positive');
  return result;
}

export function readAuditLog(file = auditLogPath()) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function normalizeStatsModel(model) {
  const value = String(model || 'unknown');
  const codex = value.match(/^gpt-[\d.]+-(sol|terra|luna)$/i);
  if (codex) return codex[1].toLowerCase();
  if (/^composer(?:-|$)/i.test(value)) return 'composer';
  if (/^grok(?:-|$)/i.test(value)) return 'grok';
  return value;
}

function outputTokens(record) {
  const usage = record?.usage?.total && typeof record.usage.total === 'object' ? record.usage.total : record?.usage;
  for (const name of ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) {
    const value = Number(usage?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function selectedRecords(records, options = {}) {
  const windowMs = durationMs(options.since);
  const now = Number(options.now || Date.now());
  return windowMs == null ? records : records.filter((record) => Number(record.at || 0) >= now - windowMs);
}

export function aggregateAuditStats(records, options = {}) {
  const selected = selectedRecords(records, options);
  const cells = new Map();
  for (const record of selected) {
    const provider = record.provider || 'unknown';
    const model = normalizeStatsModel(record.model);
    const mode = record.mode || 'unknown';
    const key = JSON.stringify([provider, model, mode]);
    if (!cells.has(key)) cells.set(key, { provider, model, mode, records: [] });
    cells.get(key).records.push(record);
  }
  const groups = [...cells.values()].map((cell) => {
    const durations = cell.records.filter((record) => record.durationMs != null).map((record) => Number(record.durationMs)).filter(Number.isFinite);
    const tokens = cell.records.map(outputTokens).filter(Number.isFinite);
    const successes = cell.records.filter((record) => record.outcome?.status === 'completed'
      && Number(record.scopeViolationsCount || 0) === 0
      && (record.verification == null || (Number.isFinite(Number(record.verification.exitCode)) && Number(record.verification.exitCode) === 0))).length;
    const resumed = cell.records.filter((record) => Boolean(record.parentJobId)).length;
    const resumeChains = new Set(cell.records.filter((record) => record.parentJobId).map((record) => record.rootJobId || record.parentJobId)).size;
    const nudgeCount = cell.records.reduce((sum, record) => sum + Number(record.nudgeCount || record.nudges || 0), 0);
    const violationCount = cell.records.reduce((sum, record) => sum + Number(record.scopeViolationsCount || 0), 0);
    const violationJobs = cell.records.filter((record) => Number(record.scopeViolationsCount || 0) > 0).length;
    const budgetCount = cell.records.filter((record) => record.outcome?.errorCode === 'BUDGET_EXCEEDED' || record.outcome?.stoppedReason === 'budget').length;
    const timeoutCount = cell.records.filter((record) => record.outcome?.errorCode === 'TIMEOUT' || record.outcome?.stoppedReason === 'timeout').length;
    return {
      provider: cell.provider,
      model: cell.model,
      mode: cell.mode,
      jobs: cell.records.length,
      successes,
      successRate: cell.records.length ? successes / cell.records.length : 0,
      resumedJobs: resumed,
      resumeChains,
      nudgeCount,
      nudgeRate: cell.records.length ? nudgeCount / cell.records.length : 0,
      meanDurationMs: mean(durations),
      medianDurationMs: percentile(durations, 0.5),
      meanOutputTokens: mean(tokens),
      budgetCount,
      timeoutCount,
      violationJobs,
      violationCount
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.mode.localeCompare(b.mode));
  return { since: options.since || null, generatedAt: Number(options.now || Date.now()), jobs: selected.length, groups };
}

export function aggregateAuditTotals(records, options = {}) {
  const selected = selectedRecords(records, options);
  const terminalStatuses = { completed: 0, failed: 0, cancelled: 0 };
  let totalOutputTokens = 0;
  for (const record of selected) {
    const status = record.outcome?.status;
    if (Object.hasOwn(terminalStatuses, status)) terminalStatuses[status] += 1;
    const tokens = outputTokens(record);
    if (Number.isFinite(tokens)) totalOutputTokens += tokens;
  }
  return { jobs: selected.length, terminalStatuses, outputTokens: totalOutputTokens };
}

export function auditUsageBands(records, options = {}) {
  const cells = new Map();
  for (const record of selectedRecords(records, options)) {
    const tokens = outputTokens(record);
    if (!Number.isFinite(tokens) || !record.provider || !record.model || !record.effort) continue;
    const models = new Set([record.model, record.requestedModel].filter(Boolean).map(normalizeStatsModel));
    for (const model of models) {
      const key = `${record.provider}\0${model}\0${record.effort}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(tokens);
    }
  }
  return Object.fromEntries([...cells.entries()].map(([key, values]) => [key, {
    p50OutputTokens: percentile(values, 0.5),
    p90OutputTokens: percentile(values, 0.9),
    samples: values.length
  }]));
}

export function usageBandKey(provider, model, effort) {
  return `${provider}\0${normalizeStatsModel(model)}\0${effort}`;
}
