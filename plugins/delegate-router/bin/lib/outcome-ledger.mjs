import { latestVerification } from './acceptance.mjs';

export const OUTCOME_LEDGER_SCHEMA_VERSION = 1;
export const OUTCOME_POLICY_VERSION = 1;
export const OUTCOME_RATE_MINIMUM_SAMPLE = 10;
export const OUTCOME_RECOMMENDATION_MINIMUM_SAMPLE = 20;
export const OUTCOME_RECOMMENDATION_CONFIDENCE = 0.95;

export const CANONICAL_PACKET_SECTIONS = Object.freeze([
  'Objective',
  'Mode',
  'Allowed scope',
  'Relevant context',
  'Constraints and non-goals',
  'Acceptance criteria',
  'Required verification',
  'Stop and report when',
  'Return'
]);

const WRITE_MODES = new Set(['implement', 'verify']);
const DECISIONS = new Set(['accepted', 'rejected']);
const MEASURED_VERIFICATION_STATES = new Set(['passed', 'failed', 'timeout']);

function bounded(value, maximum = 4000) {
  const text = String(value ?? '');
  return text.length > maximum ? `${text.slice(0, maximum)}\n[TRUNCATED ${text.length - maximum} chars]` : text;
}

function sectionPresent(packet, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:#{1,6}\\s*)?${escaped}(?:\\s*:|\\s*$)`, 'im').test(String(packet || ''));
}

export function packetFeatureSnapshot(packet, job = {}) {
  const canonicalSections = Object.fromEntries(CANONICAL_PACKET_SECTIONS.map((section) => [
    section,
    sectionPresent(packet, section)
  ]));
  const canonicalSectionCount = Object.values(canonicalSections).filter(Boolean).length;
  return {
    canonicalSections,
    canonicalSectionCount,
    canonicalSectionTotal: CANONICAL_PACKET_SECTIONS.length,
    canonicalPacketComplete: canonicalSectionCount === CANONICAL_PACKET_SECTIONS.length,
    structuredWorkSpec: Boolean(job.workSpec),
    reportSchema: Boolean(job.reportSchema),
    allowedPathFence: Array.isArray(job.allowedPaths) && job.allowedPaths.length > 0,
    verificationRecipe: Boolean(job.verify?.command),
    verificationException: Boolean(job.verify?.exception)
  };
}

export function taskShapeSnapshot(job = {}) {
  const mode = job.mode || 'unknown';
  return {
    mode,
    access: WRITE_MODES.has(mode) ? 'write' : 'read',
    continuation: Boolean(job.parentJobId),
    isolation: job.isolation || 'shared',
    boundedScope: Array.isArray(job.allowedPaths) && job.allowedPaths.length > 0,
    structuredWorkSpec: Boolean(job.workSpec),
    planFirst: job.planFirst === true,
    verificationRequested: Boolean(job.verify?.command || job.verify?.exception),
    structuredReport: Boolean(job.reportSchema),
    grouped: Boolean(job.groupId)
  };
}

export function initializeOutcomeAttempt(job, options = {}) {
  const brokerVersion = options.brokerVersion || job.origin?.brokerVersion || null;
  job.outcomeProvenance = {
    schemaVersion: OUTCOME_LEDGER_SCHEMA_VERSION,
    brokerVersion,
    adapterId: options.adapterId || job.transport || 'unknown',
    // Adapters ship in the broker package today. P9 may split this identity,
    // so keep a separate additive field now rather than inventing history then.
    adapterVersion: options.adapterVersion || brokerVersion,
    providerCliVersion: options.providerCliVersion || null,
    providerCliVersionSource: options.providerCliVersion
      ? options.providerCliVersionSource || 'launch'
      : options.providerCliVersionSource || (job.provider === 'claude' ? 'not-applicable' : 'pending'),
    policyVersion: OUTCOME_POLICY_VERSION,
    eventSchemaVersion: Number(options.eventSchemaVersion || 1)
  };
  job.taskShape = taskShapeSnapshot(job);
  job.packetFeatures = packetFeatureSnapshot(options.packet, job);
  return job;
}

export function recordProviderCliVersion(job, version, source = 'cli-version-check') {
  if (!job || !version) return job;
  job.outcomeProvenance ||= {
    schemaVersion: OUTCOME_LEDGER_SCHEMA_VERSION,
    brokerVersion: job.origin?.brokerVersion || null,
    adapterId: job.transport || 'unknown',
    adapterVersion: job.origin?.brokerVersion || null,
    providerCliVersion: null,
    providerCliVersionSource: 'pending',
    policyVersion: OUTCOME_POLICY_VERSION,
    eventSchemaVersion: 1
  };
  job.outcomeProvenance.providerCliVersion = String(version);
  job.outcomeProvenance.providerCliVersionSource = source;
  return job;
}

function findingCandidates(job = {}) {
  return [
    job.findings,
    job.result?.findings,
    job.result?.structured?.findings
  ].filter(Array.isArray);
}

function normalizedFinding(finding, index) {
  if (!finding || typeof finding !== 'object') {
    return { id: `finding-${index + 1}`, status: 'open', summary: bounded(finding) };
  }
  const summary = finding.summary ?? finding.message ?? finding.description ?? finding.title ?? finding.text ?? null;
  return {
    id: bounded(finding.id || `finding-${index + 1}`, 256),
    severity: finding.severity == null ? null : bounded(finding.severity, 64),
    status: finding.status == null ? null : bounded(finding.status, 64),
    criterion: finding.criterion == null
      ? finding.acceptanceCriterion == null ? null : bounded(finding.acceptanceCriterion, 1000)
      : bounded(finding.criterion, 1000),
    summary: summary == null ? null : bounded(summary)
  };
}

export function findingsSnapshot(job = {}) {
  const seen = new Set();
  const items = [];
  for (const candidates of findingCandidates(job)) {
    for (const finding of candidates) {
      const normalized = normalizedFinding(finding, items.length);
      const key = JSON.stringify(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(normalized);
      if (items.length >= 100) break;
    }
    if (items.length >= 100) break;
  }
  const open = items.filter((finding) => finding.status !== 'resolved').length;
  return {
    total: items.length,
    open,
    resolved: items.length - open,
    truncated: findingCandidates(job).some((findings) => findings.length > items.length),
    items
  };
}

export function verificationOutcomeSnapshot(job = {}) {
  const verification = latestVerification(job);
  const origin = job.verificationOrigin || null;
  if (!verification || typeof verification !== 'object') {
    return {
      outcome: 'unknown',
      state: null,
      labelAvailable: false,
      measuredOnRealTree: false,
      origin
    };
  }
  let state = verification.state || null;
  if (!state && Number.isInteger(verification.exitCode)) state = verification.exitCode === 0 ? 'passed' : 'failed';
  const measuredOnRealTree = origin === 'broker';
  const labelAvailable = measuredOnRealTree && MEASURED_VERIFICATION_STATES.has(state);
  const outcome = state === 'passed' ? 'pass'
    : state === 'failed' || state === 'timeout' ? 'fail'
      : 'unknown';
  return {
    outcome,
    state,
    labelAvailable,
    measuredOnRealTree,
    origin,
    exitCode: Number.isInteger(verification.exitCode) ? verification.exitCode : null,
    inputChanged: verification.inputChanged === true
  };
}

export function acceptanceDecisionSnapshot(job = {}) {
  const acceptance = job.acceptance;
  const decision = DECISIONS.has(acceptance?.state) ? acceptance.state : null;
  return {
    decision,
    labelAvailable: decision != null,
    state: acceptance?.state || null,
    decidedAt: acceptance?.decidedAt || null,
    decidedBy: acceptance?.decidedBy || null,
    priorState: acceptance?.priorState || null
  };
}

export function planFirstOutcomeSnapshot(job = {}) {
  if (job.planFirst !== true) {
    return {
      requested: false,
      state: 'not-requested',
      completionReached: false,
      degraded: false,
      recovered: false,
      comparisonVerdict: null,
      reason: null,
      outputTokenLimit: null,
      outputTokens: null
    };
  }
  const planning = job.planning;
  const planPass = job.planPass;
  const degradedSource = planPass?.state === 'degraded'
    ? planPass
    : planning?.state === 'degraded' ? planning : null;
  const comparisonVerdict = planning?.comparison?.verdict || null;
  const completionReached = Boolean(comparisonVerdict
    || job.pendingInput?.kind === 'plan-confirmation'
    || ['awaiting-confirmation', 'confirmed', 'declined'].includes(planning?.state));
  const recovered = planPass?.state === 'recovered'
    || planning?.budgetOutcome?.state === 'recovered';
  const state = degradedSource
    ? 'degraded'
    : completionReached
      ? recovered ? 'recovered' : 'completed'
      : planning ? 'pending' : 'unknown';
  const measured = degradedSource || planPass || planning?.budgetOutcome || planning;
  return {
    requested: true,
    state,
    completionReached: state === 'completed' || state === 'recovered',
    degraded: state === 'degraded',
    recovered: state === 'recovered',
    comparisonVerdict,
    reason: degradedSource?.reason || (state === 'recovered' ? measured?.reason || null : null),
    outputTokenLimit: measured?.outputTokenLimit ?? planning?.planOutputTokenLimit ?? null,
    outputTokens: measured?.outputTokens ?? measured?.observedOutputTokens ?? null
  };
}

export function outcomeLedgerSnapshot(job = {}) {
  const provenance = job.outcomeProvenance || {
    schemaVersion: null,
    brokerVersion: job.origin?.brokerVersion || null,
    adapterId: job.transport || null,
    adapterVersion: null,
    providerCliVersion: null,
    providerCliVersionSource: 'historical-unavailable',
    policyVersion: null,
    eventSchemaVersion: null
  };
  const acceptanceDecision = acceptanceDecisionSnapshot(job);
  const storedProviderCompletion = job.providerCompletion;
  const providerFinished = typeof storedProviderCompletion?.finished === 'boolean'
    ? storedProviderCompletion.finished
    : job.status === 'completed';
  return {
    provenance,
    taskShape: job.taskShape || taskShapeSnapshot(job),
    packetFeatures: job.packetFeatures || null,
    providerCompletion: {
      finished: providerFinished,
      completed: providerFinished,
      labelAvailable: storedProviderCompletion?.labelAvailable !== false
        && ['completed', 'failed', 'cancelled'].includes(job.status),
      status: storedProviderCompletion?.status || job.status || null,
      recordedAt: storedProviderCompletion?.recordedAt || null
    },
    verificationOutcome: verificationOutcomeSnapshot(job),
    findings: findingsSnapshot(job),
    planFirstOutcome: planFirstOutcomeSnapshot(job),
    acceptanceDecision,
    usage: job.usage || null,
    rejectionReason: acceptanceDecision.decision === 'rejected'
      ? job.acceptance?.reason || null
      : null
  };
}
