import crypto from 'node:crypto';

export const ACCEPTANCE_STATES = Object.freeze([
  'ready-for-review',
  'blocked',
  'accepted',
  'rejected',
  'superseded'
]);

export const AUTO_FIX_HARD_CAP = 3;

const WRITE_MODES = new Set(['implement', 'verify']);

function unresolvedFindings(job) {
  const candidates = [
    job?.findings,
    job?.result?.findings,
    job?.result?.structured?.findings
  ];
  for (const findings of candidates) {
    if (Array.isArray(findings)) return findings.filter((finding) => finding?.status !== 'resolved');
  }
  if (job?.result?.structured?.clean === false || job?.objectiveMet === false) return [{ status: 'open' }];
  return [];
}

function scopeViolationCount(job) {
  if (Array.isArray(job?.scopeViolations)) return job.scopeViolations.length;
  const count = Number(job?.scopeViolationsCount || job?.scopeViolations || 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function acceptanceEvidence(job) {
  const verification = job?.verification || null;
  const findings = unresolvedFindings(job);
  return {
    providerOutcome: {
      status: job?.status || null,
      completedAt: job?.completedAt || null
    },
    changes: {
      count: Number.isSafeInteger(job?.changedFiles?.count) ? job.changedFiles.count : null,
      files: Array.isArray(job?.changedFiles?.files) ? job.changedFiles.files.slice(0, 50) : []
    },
    verification,
    scope: {
      violationCount: scopeViolationCount(job),
      violations: Array.isArray(job?.scopeViolations) ? job.scopeViolations.slice(0, 50) : []
    },
    review: {
      unresolvedFindings: findings.length
    },
    base: {
      launchedRevision: job?.baseRevision || null,
      completedRevision: job?.completedRevision || null,
      drifted: job?.baseDrift === true || verification?.inputChanged === true,
      // Recorded for evidence: HEAD moved, but only overlap with this job's own
      // paths counts as drift that blocks acceptance.
      revisionMoved: job?.revisionMoved === true,
      driftPaths: job?.baseDriftPaths || []
    }
  };
}

export function buildAcceptance(job, options = {}) {
  if (!WRITE_MODES.has(job?.mode) || job?.status !== 'completed') return job?.acceptance || null;
  if (['accepted', 'rejected', 'superseded'].includes(job?.acceptance?.state)) return job.acceptance;
  const blockedBy = [];
  const verification = job.verification || {};
  if (verification.state === 'timeout' || verification.timedOut === true) blockedBy.push('verification-timeout');
  else if (verification.state === 'failed' || (Number.isInteger(verification.exitCode) && verification.exitCode !== 0)) blockedBy.push('verification-failed');
  if (verification.state === 'stale' || verification.inputChanged === true || job.baseDrift === true) blockedBy.push('base-drift');
  if (scopeViolationCount(job) > 0) blockedBy.push('scope-violation');
  if (!(job.changedFiles?.count > 0)) blockedBy.push('zero-changed-files');
  if (unresolvedFindings(job).length > 0) blockedBy.push('structured-review-findings-unresolved');
  return {
    state: blockedBy.length ? 'blocked' : 'ready-for-review',
    blockedBy: [...new Set(blockedBy)],
    evidence: acceptanceEvidence(job),
    decidedBy: 'broker',
    decidedAt: options.now || new Date().toISOString()
  };
}

export function acceptanceEvidenceDigest(acceptance) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ blockedBy: acceptance?.blockedBy || [], evidence: acceptance?.evidence || null }))
    .digest('hex');
}

export function verificationFailureCount(verification) {
  if (!verification || verification.state !== 'failed') return 0;
  const text = String(verification.outputTail || '');
  const values = [];
  const patterns = [
    /(?:^|\s)(\d+)\s+(?:failed|failures?|failing)(?:\s|$)/gim,
    /(?:^|\s)(?:failed|failures?|failing)\s*[:=]?\s*(\d+)(?:\s|$)/gim,
    /(?:^|\s)fail\s+(\d+)(?:\s|$)/gim
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) values.push(Number(match[1]));
  }
  const positive = values.filter((value) => Number.isSafeInteger(value) && value > 0);
  return positive.length ? Math.min(...positive) : null;
}

export function autoFixMetrics(job) {
  return {
    failures: verificationFailureCount(job?.verification),
    scopeViolations: scopeViolationCount(job)
  };
}

export function autoFixMadeProgress(previous, current) {
  if (!previous || !current) return false;
  const fewerFailures = Number.isSafeInteger(previous.failures)
    && Number.isSafeInteger(current.failures)
    && current.failures < previous.failures;
  const fewerViolations = Number.isSafeInteger(previous.scopeViolations)
    && Number.isSafeInteger(current.scopeViolations)
    && current.scopeViolations < previous.scopeViolations;
  return fewerFailures || fewerViolations;
}

function outputTokens(job) {
  const usage = job?.usage || {};
  const total = usage.total || usage;
  const value = Number(total.outputTokens ?? total.output_tokens);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function evaluateAutoFix(job, options = {}) {
  if (!job?.autoFix) return { action: 'stop', reason: 'off' };
  const configured = Number(job.autoFix.maxRounds);
  const maxRounds = Math.min(AUTO_FIX_HARD_CAP, Number.isSafeInteger(configured) && configured > 0 ? configured : 0);
  if (!maxRounds) return { action: 'stop', reason: 'off' };
  const round = Number.isSafeInteger(job.autoFix.round) ? job.autoFix.round : 0;
  if (round >= maxRounds) return { action: 'stop', reason: 'hard-cap' };
  if (job.status !== 'completed') return { action: 'stop', reason: 'provider-not-completed' };
  if (!(job.changedFiles?.count > 0)) return { action: 'stop', reason: 'zero-changed-files' };
  if (unresolvedFindings(job).length) return { action: 'stop', reason: 'judgment-required' };
  if (job.baseDrift === true || job.verification?.inputChanged === true) return { action: 'stop', reason: 'base-drift' };
  if (job.verification?.state === 'timeout') return { action: 'stop', reason: 'verification-timeout' };
  const metrics = autoFixMetrics(job);
  const deterministic = (job.verification?.state === 'failed' && Number.isInteger(metrics.failures))
    || metrics.scopeViolations > 0;
  if (!deterministic) return { action: 'stop', reason: 'ambiguous-criterion' };
  if (round > 0 && !autoFixMadeProgress(job.autoFix.previousMetrics, metrics)) {
    return { action: 'stop', reason: 'no-progress', metrics };
  }
  const nowMs = Number(options.nowMs ?? Date.now());
  const startedAtMs = Number(job.autoFix.startedAtMs || Number(job.createdAt || 0) * 1000);
  if (job.timeoutSeconds && startedAtMs > 0 && nowMs - startedAtMs >= job.timeoutSeconds * 1000) {
    return { action: 'stop', reason: 'budget-exhausted' };
  }
  const used = outputTokens(job);
  if (job.maxOutputTokens && used != null && used >= job.maxOutputTokens) {
    return { action: 'stop', reason: 'budget-exhausted' };
  }
  return { action: 'launch', round: round + 1, maxRounds, metrics };
}
