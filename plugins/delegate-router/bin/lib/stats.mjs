import fs from 'node:fs';
import { brokerError } from './errors.mjs';
import { auditLogPath } from './state.mjs';
import {
  outcomeLedgerSnapshot,
  OUTCOME_RATE_MINIMUM_SAMPLE,
  OUTCOME_RECOMMENDATION_CONFIDENCE,
  OUTCOME_RECOMMENDATION_MINIMUM_SAMPLE
} from './outcome-ledger.mjs';

function durationMs(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)([smhdw])$/i);
  if (!match) return null;
  const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2].toLowerCase()];
  const result = Number(match[1]) * multiplier;
  if (!Number.isFinite(result) || result <= 0) throw brokerError('INVALID_REQUEST', 'since duration must be positive');
  return result;
}

function semanticVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareSemanticVersions(left, right) {
  const a = semanticVersion(left);
  const b = semanticVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function dateBoundary(value, name) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(text)) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw brokerError('INVALID_REQUEST', `${name} must be a valid ISO date`);
  return parsed;
}

export function auditCohortAt(record) {
  for (const candidate of [record?.attemptAt, record?.terminalAt, record?.at]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function recordBrokerVersion(record) {
  return record?.brokerVersion || record?.outcomeProvenance?.brokerVersion || record?.origin?.brokerVersion || null;
}

export function parseOutcomeSelection(options = {}, now = Date.now()) {
  const rawSince = options.since == null || options.since === '' ? null : String(options.since).trim();
  const rawUntil = options.until == null || options.until === '' ? null : String(options.until).trim();
  let kind = 'lifetime';
  let startAt = null;
  let brokerVersion = null;
  if (rawSince) {
    const windowMs = durationMs(rawSince);
    const date = windowMs == null ? dateBoundary(rawSince, 'since') : null;
    const version = windowMs == null && date == null ? semanticVersion(rawSince) : null;
    if (windowMs != null) {
      kind = 'duration';
      startAt = now - windowMs;
    } else if (date != null) {
      kind = 'date';
      startAt = date;
    } else if (version) {
      kind = 'broker-version';
      brokerVersion = version.join('.');
    } else {
      throw brokerError('INVALID_REQUEST', "since must be a duration ('7d'), ISO date ('2026-07-17'), or broker version ('0.42.0')");
    }
  }
  const endAt = rawUntil ? dateBoundary(rawUntil, 'until') : null;
  if (rawUntil && endAt == null) throw brokerError('INVALID_REQUEST', "until must be an ISO date such as '2026-07-17'");
  if (startAt != null && endAt != null && startAt >= endAt) {
    throw brokerError('INVALID_REQUEST', 'since must be earlier than until');
  }
  return {
    since: rawSince,
    until: rawUntil,
    kind,
    startAt,
    endAt,
    brokerVersion,
    label: kind === 'lifetime' ? rawUntil ? `until ${rawUntil}` : 'lifetime'
      : kind === 'broker-version' ? `since broker ${brokerVersion}`
        : `${rawSince ? `since ${rawSince}` : 'lifetime'}${rawUntil ? ` until ${rawUntil}` : ''}`
  };
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

export function coalesceAuditRecords(records = []) {
  const byJob = new Map();
  const anonymous = [];
  records.forEach((record, index) => {
    const jobId = record?.jobId == null ? null : String(record.jobId);
    if (!jobId) {
      anonymous.push(record);
      return;
    }
    const previous = byJob.get(jobId);
    const rank = [
      Number(record.auditRevision || 0),
      Number(record.recordedAt || record.at || 0),
      index
    ];
    if (!previous
      || rank[0] > previous.rank[0]
      || (rank[0] === previous.rank[0] && rank[1] > previous.rank[1])
      || (rank[0] === previous.rank[0] && rank[1] === previous.rank[1] && rank[2] > previous.rank[2])) {
      byJob.set(jobId, { record, rank });
    }
  });
  return [...anonymous, ...[...byJob.values()].map((entry) => entry.record)];
}

function projectRetainedAttemptEvidence(records, jobs = []) {
  if (!Array.isArray(jobs) || !jobs.length) return records;
  const byId = new Map(jobs.filter((job) => job?.id).map((job) => [String(job.id), job]));
  return records.map((record) => {
    const job = byId.get(String(record?.jobId || ''));
    if (!job) return record;
    const ledger = outcomeLedgerSnapshot(job);
    const currentDecision = ledger.acceptanceDecision.labelAvailable
      ? ledger.acceptanceDecision
      : record.acceptanceDecision;
    return {
      ...record,
      brokerVersion: record.brokerVersion ?? ledger.provenance.brokerVersion,
      adapterId: record.adapterId ?? ledger.provenance.adapterId,
      adapterVersion: record.adapterVersion ?? ledger.provenance.adapterVersion,
      providerCliVersion: record.providerCliVersion ?? ledger.provenance.providerCliVersion,
      providerCliVersionSource: record.providerCliVersionSource ?? ledger.provenance.providerCliVersionSource,
      policyVersion: record.policyVersion ?? ledger.provenance.policyVersion,
      eventSchemaVersion: record.eventSchemaVersion ?? ledger.provenance.eventSchemaVersion,
      taskShape: record.taskShape ?? ledger.taskShape,
      packetFeatures: record.packetFeatures ?? ledger.packetFeatures,
      verification: record.verification ?? job.verification ?? null,
      verificationOrigin: record.verificationOrigin ?? job.verificationOrigin ?? null,
      verificationOutcome: record.verificationOutcome ?? ledger.verificationOutcome,
      findings: record.findings ?? ledger.findings,
      acceptance: currentDecision?.labelAvailable ? job.acceptance : record.acceptance,
      acceptanceDecision: currentDecision,
      rejectionReason: currentDecision?.decision === 'rejected'
        ? ledger.rejectionReason
        : record.rejectionReason,
      usage: record.usage ?? job.usage ?? null
    };
  });
}

function recordSelected(record, selection) {
  const at = auditCohortAt(record);
  if (selection.startAt != null && at < selection.startAt) return false;
  if (selection.endAt != null && at >= selection.endAt) return false;
  if (selection.brokerVersion) {
    const compared = compareSemanticVersions(recordBrokerVersion(record), selection.brokerVersion);
    if (compared == null || compared < 0) return false;
  }
  return true;
}

function selectedRecords(records, attributedTokens, selection) {
  return records.flatMap((record, index) => recordSelected(record, selection)
    ? [{ record, outputTokens: attributedTokens[index] }]
    : []);
}

export function rateMeasurement(numerator, sampleSize, minimumSample = OUTCOME_RATE_MINIMUM_SAMPLE) {
  const samples = Math.max(0, Number(sampleSize || 0));
  const successes = Math.max(0, Number(numerator || 0));
  const sufficient = samples >= minimumSample;
  return {
    numerator: successes,
    sampleSize: samples,
    minimumSample,
    status: sufficient ? 'measured' : 'insufficient-data',
    rate: sufficient ? successes / samples : null
  };
}

function verificationLabel(record) {
  if (record?.verificationOutcome?.labelAvailable === true) {
    return record.verificationOutcome.outcome === 'pass' ? true
      : record.verificationOutcome.outcome === 'fail' ? false
        : null;
  }
  const origin = record?.verificationOrigin;
  const state = record?.verification?.state;
  if (origin !== 'broker') return null;
  if (state === 'passed') return true;
  if (['failed', 'timeout'].includes(state)) return false;
  if (!state && Number.isInteger(record?.verification?.exitCode)) return record.verification.exitCode === 0;
  return null;
}

function acceptanceLabel(record) {
  const decision = record?.acceptanceDecision?.decision || record?.acceptance?.state;
  if (decision === 'accepted') return true;
  if (decision === 'rejected') return false;
  return null;
}

function providerCompletionLabel(record) {
  const completion = record?.providerCompletion;
  if (completion?.labelAvailable !== false) {
    if (typeof completion?.finished === 'boolean') return completion.finished;
    if (typeof completion?.completed === 'boolean') return completion.completed;
  }
  const status = record?.outcome?.status;
  return ['completed', 'failed', 'cancelled'].includes(status) ? status === 'completed' : null;
}

export function outcomeRates(records = [], options = {}) {
  const minimumSample = Number(options.minimumSample || OUTCOME_RATE_MINIMUM_SAMPLE);
  const providerCompletion = records.map(providerCompletionLabel).filter((value) => value != null);
  const verification = records.map(verificationLabel).filter((value) => value != null);
  const acceptance = records.map(acceptanceLabel).filter((value) => value != null);
  return {
    providerCompletion: rateMeasurement(
      providerCompletion.filter(Boolean).length,
      providerCompletion.length,
      minimumSample
    ),
    verificationPass: rateMeasurement(
      verification.filter(Boolean).length,
      verification.length,
      minimumSample
    ),
    ownerAcceptance: rateMeasurement(
      acceptance.filter(Boolean).length,
      acceptance.length,
      minimumSample
    )
  };
}

function orphanedCount(records) {
  return records.filter((record) => record?.outcome?.errorCode === 'ORPHANED').length;
}

function cohortSummary(key, records, field) {
  return {
    [field]: key,
    jobs: records.length,
    orphanedJobs: orphanedCount(records),
    rates: outcomeRates(records)
  };
}

function outcomeCohorts(records) {
  const versions = new Map();
  const windows = new Map();
  for (const record of records) {
    const version = recordBrokerVersion(record) || 'historical-unknown';
    if (!versions.has(version)) versions.set(version, []);
    versions.get(version).push(record);
    const at = auditCohortAt(record);
    const window = at > 0 ? new Date(at).toISOString().slice(0, 10) : 'historical-unknown-date';
    if (!windows.has(window)) windows.set(window, []);
    windows.get(window).push(record);
  }
  return {
    brokerVersions: [...versions.entries()]
      .map(([version, cohort]) => cohortSummary(version, cohort, 'brokerVersion'))
      .sort((left, right) => left.brokerVersion.localeCompare(right.brokerVersion)),
    timeWindows: [...windows.entries()]
      .map(([window, cohort]) => cohortSummary(window, cohort, 'window'))
      .sort((left, right) => left.window.localeCompare(right.window))
  };
}

function aggregateSelectedStats(selected, selection, now) {
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
      rates: outcomeRates(records),
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
  const records = selected.map((entry) => entry.record);
  return {
    since: selection.since,
    until: selection.until,
    selection,
    generatedAt: now,
    jobs: selected.length,
    rates: outcomeRates(records),
    cohorts: outcomeCohorts(records),
    orphanedJobs: orphanedCount(records),
    groups
  };
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
  const coalesced = coalesceAuditRecords(projectRetainedAttemptEvidence(records, options.jobs));
  const selection = parseOutcomeSelection(options, now);
  const selected = selectedRecords(coalesced, attributeAuditOutputTokens(coalesced), selection);
  return { now, selected, selection, records: coalesced };
}

export function aggregateAudit(records, options = {}) {
  const { now, selected, selection } = aggregateSelection(records, options);
  return { ...aggregateSelectedStats(selected, selection, now), totals: aggregateSelectedTotals(selected) };
}

export function aggregateAuditStats(records, options = {}) {
  const { now, selected, selection } = aggregateSelection(records, options);
  return aggregateSelectedStats(selected, selection, now);
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
  const coalesced = coalesceAuditRecords(auditRecords);
  const attributed = attributeAuditOutputTokens(coalesced);
  const minimumDelta = Math.max(0, Number(options.minimumDelta ?? 0.01));
  const markers = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const startAt = Number(previous.at);
    const endAt = Number(current.at);
    if (endAt <= startAt) continue;
    const tracked = trackedAuditInWindow(coalesced, attributed, startAt, endAt);
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
  const selection = parseOutcomeSelection(options, now);
  if (selection.kind === 'broker-version') {
    return {
      markerCount: 0,
      byWindow: {},
      latest: null,
      approximate: true,
      selectionUnavailable: 'allowance markers have no broker-version attribution'
    };
  }
  const markers = history.filter((entry) => entry?.kind === 'unattributed-burn'
    && (selection.startAt == null || Number(entry.at || 0) >= selection.startAt)
    && (selection.endAt == null || Number(entry.at || 0) < selection.endAt));
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

function recordTaskShape(record) {
  const stored = record?.taskShape;
  if (stored && typeof stored === 'object') return stored;
  const mode = record?.mode || 'unknown';
  return {
    mode,
    access: ['implement', 'verify'].includes(mode) ? 'write' : 'read',
    isolation: record?.isolation || 'shared',
    boundedScope: record?.packetFeatures?.allowedPathFence === true,
    structuredWorkSpec: false
  };
}

function validatedRecommendationShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('INVALID_REQUEST', 'recommendFor must be a task-shape object');
  }
  const allowed = new Set(['mode', 'access', 'isolation', 'boundedScope', 'structuredWorkSpec']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw brokerError('INVALID_REQUEST', `recommendFor unknown task-shape field: ${unknown.join(', ')}`);
  if (typeof value.mode !== 'string' || !value.mode.trim()) {
    throw brokerError('INVALID_REQUEST', 'recommendFor.mode is required');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === 'string' ? item.trim() : item
  ]));
}

function taskShapeMatches(record, requested) {
  const shape = recordTaskShape(record);
  return Object.entries(requested).every(([key, value]) => shape[key] === value);
}

function wilsonInterval(successes, samples) {
  if (!(samples > 0)) return null;
  // Fixed 95% confidence keeps results comparable and prevents a caller from
  // lowering confidence until a preferred answer appears.
  const z = 1.959963984540054;
  const observed = successes / samples;
  const denominator = 1 + (z ** 2) / samples;
  const center = (observed + (z ** 2) / (2 * samples)) / denominator;
  const margin = z * Math.sqrt((observed * (1 - observed) + (z ** 2) / (4 * samples)) / samples) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function recommendOutcomeRouting(records = [], options = {}) {
  const requestedTaskShape = validatedRecommendationShape(options.taskShape);
  const { selected } = aggregateSelection(records, options);
  const matching = selected.map((entry) => entry.record)
    .filter((record) => taskShapeMatches(record, requestedTaskShape));
  const providers = new Map();
  for (const record of matching) {
    const provider = record.provider || 'unknown';
    if (!providers.has(provider)) providers.set(provider, { provider, labels: [] });
    const label = acceptanceLabel(record);
    if (label != null) providers.get(provider).labels.push(label);
  }
  const candidates = [...providers.values()].map(({ provider, labels }) => {
    const accepted = labels.filter(Boolean).length;
    const measurement = rateMeasurement(accepted, labels.length, OUTCOME_RECOMMENDATION_MINIMUM_SAMPLE);
    return {
      provider,
      accepted,
      sampleSize: labels.length,
      minimumSample: OUTCOME_RECOMMENDATION_MINIMUM_SAMPLE,
      status: measurement.status,
      observedRate: measurement.rate,
      confidenceInterval: measurement.status === 'measured' ? wilsonInterval(accepted, labels.length) : null
    };
  }).sort((left, right) => right.sampleSize - left.sampleSize || left.provider.localeCompare(right.provider));
  const eligible = candidates.filter((candidate) => candidate.status === 'measured')
    .sort((left, right) => right.observedRate - left.observedRate || left.provider.localeCompare(right.provider));
  const base = {
    status: 'insufficient-data',
    metric: 'owner-acceptance',
    requestedTaskShape,
    matchingAttempts: matching.length,
    minimumSamplePerProvider: OUTCOME_RECOMMENDATION_MINIMUM_SAMPLE,
    confidence: {
      level: OUTCOME_RECOMMENDATION_CONFIDENCE,
      method: 'wilson-score-interval'
    },
    candidates,
    recommendation: null,
    staticRouterChanged: false
  };
  if (eligible.length < 2) {
    return {
      ...base,
      reason: 'fewer than two providers have the minimum number of explicit owner-acceptance labels'
    };
  }
  const [best, runnerUp] = eligible;
  if (!(best.confidenceInterval.lower > runnerUp.confidenceInterval.upper)) {
    return {
      ...base,
      reason: 'eligible provider confidence intervals overlap'
    };
  }
  return {
    ...base,
    status: 'recommendation',
    reason: 'best provider lower confidence bound exceeds the runner-up upper bound',
    recommendation: {
      provider: best.provider,
      observedRate: best.observedRate,
      sampleSize: best.sampleSize,
      confidenceInterval: best.confidenceInterval
    }
  };
}

export function aggregateVisibilityStats(records, options = {}) {
  const resolved = {
    since: options.since,
    until: options.until,
    history: options.history,
    external: options.external,
    recommendFor: options.recommendFor,
    jobs: options.jobs,
    minimumDelta: options.minimumDelta,
    now: snapshotNow(options)
  };
  return {
    ...aggregateAudit(records, resolved),
    external: options.external || { threadCount: 0, usageThreadCount: 0, tokenTotals: null },
    unattributed: unattributedBurnSummary(options.history || [], resolved),
    routingRecommendation: options.recommendFor
      ? recommendOutcomeRouting(records, { ...resolved, taskShape: options.recommendFor })
      : null
  };
}
