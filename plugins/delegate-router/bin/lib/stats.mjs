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

export function outputTokens(record) {
  const usage = record?.usage?.total && typeof record.usage.total === 'object' ? record.usage.total : record?.usage;
  for (const name of ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) {
    const candidate = usage?.[name];
    if (candidate == null) continue;
    if (typeof candidate !== 'number' && (typeof candidate !== 'string' || candidate.trim() === '')) continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function auditChainKey(record, chainedRoots) {
  if (record?.provider !== 'codex') return null;
  const explicit = record.rootJobId || record.parentJobId;
  if (explicit && chainedRoots.has(String(explicit))) return String(explicit);
  const jobId = record.jobId == null ? null : String(record.jobId);
  return jobId && chainedRoots.has(jobId) ? jobId : null;
}

// Codex reports thread-cumulative totals on resumed jobs. Attribute only the
// increase within each chronological chain so callers do not multiply the
// same tokens across review rounds. A decreasing counter starts a fresh
// cumulative sequence and is therefore counted in full.
export function attributeAuditOutputTokens(records = []) {
  const values = records.map(outputTokens);
  const chainedRoots = new Set(records.flatMap((record) => {
    if (record?.provider !== 'codex' || !record.parentJobId) return [];
    const root = record.rootJobId || record.parentJobId;
    return root == null ? [] : [String(root)];
  }));
  const chains = new Map();
  records.forEach((record, index) => {
    const chain = auditChainKey(record, chainedRoots);
    if (!chain || !Number.isFinite(values[index])) return;
    if (!chains.has(chain)) chains.set(chain, []);
    chains.get(chain).push({ index, at: Number(record.at || 0), value: values[index] });
  });
  for (const chain of chains.values()) {
    let maximum = null;
    chain.sort((left, right) => left.at - right.at || left.index - right.index).forEach((entry) => {
      if (maximum == null || entry.value < maximum) {
        values[entry.index] = Math.max(0, entry.value);
        maximum = entry.value;
        return;
      }
      values[entry.index] = Math.max(0, entry.value - maximum);
      maximum = Math.max(maximum, entry.value);
    });
  }
  return values;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function snapshotNow(options = {}) {
  const value = options.now;
  return Number(value == null ? Date.now() : value);
}

function selectedRecords(records, attributedTokens, options, now) {
  const windowMs = durationMs(options.since);
  return records.flatMap((record, index) => windowMs == null || Number(record.at || 0) >= now - windowMs
    ? [{ record, outputTokens: attributedTokens[index] }]
    : []);
}

function aggregateSelectedStats(selected, options, now) {
  const cells = new Map();
  for (const entry of selected) {
    const { record } = entry;
    const provider = record.provider || 'unknown';
    const model = normalizeStatsModel(record.model);
    const mode = record.mode || 'unknown';
    const transport = record.transport || 'unknown';
    const key = JSON.stringify([provider, model, mode, transport]);
    if (!cells.has(key)) cells.set(key, { provider, model, mode, transport, records: [] });
    cells.get(key).records.push(entry);
  }
  const groups = [...cells.values()].map((cell) => {
    const records = cell.records.map((entry) => entry.record);
    const durations = records.filter((record) => record.durationMs != null).map((record) => Number(record.durationMs)).filter(Number.isFinite);
    const tokens = cell.records.map((entry) => entry.outputTokens).filter(Number.isFinite);
    const successes = records.filter((record) => record.outcome?.status === 'completed'
      && Number(record.scopeViolationsCount || 0) === 0
      && (record.verification == null || (Number.isFinite(Number(record.verification.exitCode)) && Number(record.verification.exitCode) === 0))).length;
    const resumed = records.filter((record) => Boolean(record.parentJobId)).length;
    const resumeChains = new Set(records.filter((record) => record.parentJobId).map((record) => record.rootJobId || record.parentJobId)).size;
    const nudgeCount = records.reduce((sum, record) => sum + Number(record.nudgeCount || record.nudges || 0), 0);
    const violationCount = records.reduce((sum, record) => sum + Number(record.scopeViolationsCount || 0), 0);
    const violationJobs = records.filter((record) => Number(record.scopeViolationsCount || 0) > 0).length;
    const budgetCount = records.filter((record) => record.outcome?.errorCode === 'BUDGET_EXCEEDED' || record.outcome?.stoppedReason === 'budget').length;
    const timeoutCount = records.filter((record) => record.outcome?.errorCode === 'TIMEOUT' || record.outcome?.stoppedReason === 'timeout').length;
    return {
      provider: cell.provider,
      model: cell.model,
      mode: cell.mode,
      transport: cell.transport,
      jobs: records.length,
      successes,
      successRate: records.length ? successes / records.length : 0,
      resumedJobs: resumed,
      resumeChains,
      nudgeCount,
      nudgeRate: records.length ? nudgeCount / records.length : 0,
      meanDurationMs: mean(durations),
      medianDurationMs: percentile(durations, 0.5),
      meanOutputTokens: mean(tokens),
      budgetCount,
      timeoutCount,
      violationJobs,
      violationCount
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
    || a.mode.localeCompare(b.mode) || a.transport.localeCompare(b.transport));
  return { since: options.since || null, generatedAt: now, jobs: selected.length, groups };
}

function aggregateSelectedTotals(selected) {
  const terminalStatuses = { completed: 0, failed: 0, cancelled: 0 };
  let totalOutputTokens = 0;
  for (const entry of selected) {
    const { record } = entry;
    const status = record.outcome?.status;
    if (Object.hasOwn(terminalStatuses, status)) terminalStatuses[status] += 1;
    const tokens = entry.outputTokens;
    if (Number.isFinite(tokens)) totalOutputTokens += tokens;
  }
  return { jobs: selected.length, terminalStatuses, outputTokens: totalOutputTokens };
}

function aggregateSelection(records, options = {}) {
  const now = snapshotNow(options);
  const selected = selectedRecords(records, attributeAuditOutputTokens(records), options, now);
  return { now, selected };
}

export function aggregateAudit(records, options = {}) {
  const { now, selected } = aggregateSelection(records, options);
  return { ...aggregateSelectedStats(selected, options, now), totals: aggregateSelectedTotals(selected) };
}

export function aggregateAuditStats(records, options = {}) {
  const { now, selected } = aggregateSelection(records, options);
  return aggregateSelectedStats(selected, options, now);
}

export function aggregateAuditTotals(records, options = {}) {
  return aggregateSelectedTotals(aggregateSelection(records, options).selected);
}

export function auditUsageBands(records, options = {}) {
  const cells = new Map();
  const { selected } = aggregateSelection(records, options);
  for (const entry of selected) {
    const { record } = entry;
    const tokens = entry.outputTokens;
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

function snapshotWindows(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.windows)) return [];
  return snapshot.windows.flatMap((window) => {
    const usedPercent = Number(window?.usedPercent);
    if (!window?.name || !Number.isFinite(usedPercent)) return [];
    return [{ name: String(window.name), usedPercent, resetsAt: window.resetsAt == null ? null : Number(window.resetsAt) }];
  });
}

function trackedAuditInWindow(records, attributed, startAt, endAt) {
  let outputTokens = 0;
  let jobs = 0;
  records.forEach((record, index) => {
    const at = Number(record?.at || 0);
    if (record?.provider !== 'codex' || at <= startAt || at > endAt) return;
    const tracked = ['delegate-control', 'delegate-shadow'].includes(record.who)
      || ['app-server', 'direct-mcp', 'direct-cli', 'direct-acp'].includes(record.transport);
    if (!tracked) return;
    jobs += 1;
    if (Number.isFinite(attributed[index])) outputTokens += Math.max(0, attributed[index]);
  });
  return { jobs, outputTokens };
}

function activeTrackedJobInWindow(jobs, startAt, endAt) {
  return (jobs || []).some((job) => {
    if (job?.provider !== 'codex' || !['delegate-control', 'delegate-shadow'].includes(job.managedBy)) return false;
    const started = Number(job.createdAtMs || Number(job.createdAt || 0) * 1000 || 0);
    const ended = Number(job.completedAt ? job.completedAt * 1000 : job.updatedAt ? job.updatedAt * 1000 : endAt);
    return started <= endAt && ended > startAt;
  });
}

// Allowance percentages and provider token counters are different units, so
// the only defensible automatic attribution is conservative: emit a marker
// when an allowance window moved and there was no chain-attributed tracked
// Codex output (nor an overlapping active tracked job) in the capture window.
// Mixed tracked/untracked windows are intentionally left unclassified.
export function computeUnattributedBurnMarkers(snapshots = [], auditRecords = [], options = {}) {
  const ordered = [...snapshots].filter((snapshot) => Number.isFinite(Number(snapshot?.at)))
    .sort((left, right) => Number(left.at) - Number(right.at));
  const attributed = attributeAuditOutputTokens(auditRecords);
  const minimumDelta = Math.max(0, Number(options.minimumDelta ?? 0.01));
  const markers = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const startAt = Number(previous.at);
    const endAt = Number(current.at);
    if (endAt <= startAt) continue;
    const tracked = trackedAuditInWindow(auditRecords, attributed, startAt, endAt);
    if (tracked.outputTokens > 0 || tracked.jobs > 0 || activeTrackedJobInWindow(options.jobs, startAt, endAt)) continue;
    const previousByName = new Map(snapshotWindows(previous).map((window) => [window.name, window]));
    for (const window of snapshotWindows(current)) {
      const before = previousByName.get(window.name);
      if (!before) continue;
      if (before.resetsAt != null && window.resetsAt != null && before.resetsAt !== window.resetsAt) continue;
      const amountPercent = window.usedPercent - before.usedPercent;
      if (!(amountPercent > minimumDelta)) continue;
      markers.push({
        kind: 'unattributed-burn',
        provider: 'codex',
        window: window.name,
        amountPercent,
        fromUsedPercent: before.usedPercent,
        toUsedPercent: window.usedPercent,
        windowStartAt: startAt,
        windowEndAt: endAt,
        at: endAt,
        trackedOutputTokens: 0,
        estimate: true,
        note: 'allowance moved in a capture window with no tracked Codex output; percentage-point amount is capture-cadence bounded'
      });
    }
  }
  return markers;
}

export function unattributedBurnSummary(history = [], options = {}) {
  const now = snapshotNow(options);
  const windowMs = durationMs(options.since);
  const markers = history.filter((entry) => entry?.kind === 'unattributed-burn'
    && (windowMs == null || Number(entry.at || 0) >= now - windowMs));
  const byWindow = {};
  for (const marker of markers) {
    const name = String(marker.window || 'unknown');
    byWindow[name] ||= { markers: 0, amountPercent: 0, latestAt: null };
    byWindow[name].markers += 1;
    byWindow[name].amountPercent += Number(marker.amountPercent || 0);
    byWindow[name].latestAt = Math.max(Number(byWindow[name].latestAt || 0), Number(marker.at || 0)) || null;
  }
  return { markerCount: markers.length, byWindow, latest: markers.at(-1) || null, approximate: true };
}

export function aggregateVisibilityStats(records, options = {}) {
  return {
    ...aggregateAudit(records, options),
    external: options.external || { threadCount: 0, usageThreadCount: 0, tokenTotals: null },
    unattributed: unattributedBurnSummary(options.history || [], options)
  };
}
