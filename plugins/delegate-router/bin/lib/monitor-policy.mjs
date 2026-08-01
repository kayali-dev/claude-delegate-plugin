import { redact } from './control.mjs';
import path from 'node:path';

const WRITE_MODES = new Set(['implement', 'verify']);
const READ_MODES = new Set(['consult', 'plan', 'review']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const BLOCKING_CODES = new Set([
  'USER_INPUT_REQUIRED',
  'PERMISSION_DENIED',
  'PERMISSION_BLOCKED',
  'APPROVAL_REQUIRED',
  'DIRECT_TRANSPORT',
  'READ_ONLY_TRANSPORT'
]);
const BUDGET_CODES = new Set([
  'BUDGET_EXCEEDED'
]);
const ALLOWANCE_CODES = new Set([
  'ALLOWANCE_EXCEEDED',
  'QUOTA_EXCEEDED',
  'QUOTA_GUARD',
  'RATE_LIMIT'
]);
const USER_CANCEL_CODES = new Set(['CANCELLED', 'CANCELED', 'USER_CANCELLED', 'USER_CANCELED']);

export const DEFAULT_MONITOR_STALL_MS = 10 * 60 * 1000;
export const DEFAULT_MONITOR_COOLDOWN_MS = 30 * 1000;
export const DEFAULT_MONITOR_RATE_LIMIT = 6;
export const MONITOR_RATE_WINDOW_MS = 60 * 1000;

function eventCode(event) {
  return String(event?.data?.code || event?.data?.errorCode || '').trim().toUpperCase();
}

function field(value, fallback, maximum = 80) {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const safe = String(redact(String(value), '', maximum))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || fallback;
}

function safeJobId(job) {
  return field(job?.id, 'unknown-job', 96);
}

export function monitorProjectLabel(job) {
  const workspaceId = typeof job?.origin?.workspaceId === 'string'
    ? job.origin.workspaceId
    : typeof job?.origin?.projectDir === 'string' ? job.origin.projectDir : '';
  if (workspaceId) return field(path.basename(path.normalize(workspaceId)), 'workspace', 64).replace(/[\[\]]/g, '_');
  const cwd = typeof job?.cwd === 'string' ? job.cwd : '';
  return `legacy@${field(path.basename(path.normalize(cwd)), 'unknown', 56).replace(/[\[\]]/g, '_')}`;
}

function projectSetLabel(edges) {
  const labels = [...new Set(edges.map((edge) => monitorProjectLabel(edge.job)))].sort();
  return field(labels.join('+'), 'unknown', 160);
}

function safeMode(job) {
  const mode = String(job?.mode || '').toLowerCase();
  return WRITE_MODES.has(mode) || READ_MODES.has(mode) ? mode : 'unknown mode';
}

function scopeViolationCount(job) {
  if (Array.isArray(job?.scopeViolations)) return job.scopeViolations.length;
  const count = Number(job?.scopeViolations || 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function latestEvent(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

function after(events, event, predicate) {
  if (!event) return null;
  const sequence = Number(event.seq || 0);
  return latestEvent(events, (candidate) => Number(candidate.seq || 0) > sequence && predicate(candidate));
}

function blockedApproval(events) {
  const blocked = latestEvent(events, (event) => {
    if (event.type !== 'approval.resolved') return false;
    const value = `${event.data?.decision || ''} ${event.data?.outcome?.outcome || event.data?.outcome || ''}`;
    return /reject|deny|declin|cancel/i.test(value);
  });
  if (!blocked) return false;
  const continued = after(events, blocked, (event) => [
    'turn.started',
    'message.delta',
    'message.completed',
    'tool.started',
    'tool.completed',
    'file.changed',
    'approval.requested',
    'job.completed'
  ].includes(event.type));
  return !continued;
}

function inputOutstanding(job, events) {
  if (job?.pendingInput?.timedOut === true
    || job?.phase === 'input-timeout'
    || job?.stopReason === 'input-timeout') return false;
  if (job?.pendingInput && job.pendingInput.timedOut !== true) return true;
  if (job?.phase === 'user-input-required') return true;
  const requested = latestEvent(events, (event) => event.type === 'input.requested');
  const resolved = latestEvent(events, (event) => event.type === 'input.resolved');
  if (requested && Number(requested.seq || 0) > Number(resolved?.seq || 0)) return true;
  const code = String(job?.errorCode || '').toUpperCase();
  if (BLOCKING_CODES.has(code)) return true;
  return Boolean(latestEvent(events, (event) => event.type === 'error' && BLOCKING_CODES.has(eventCode(event))));
}

function budgetExceeded(job, events) {
  const code = String(job?.errorCode || '').toUpperCase();
  return job?.stoppedReason === 'budget'
    || BUDGET_CODES.has(code)
    || events.some((event) => event.type === 'budget.exceeded'
      || (event.type === 'error' && BUDGET_CODES.has(eventCode(event))));
}

function allowanceExceeded(job, events) {
  const code = String(job?.errorCode || '').toUpperCase();
  return ALLOWANCE_CODES.has(code)
    || events.some((event) => event.type === 'error' && ALLOWANCE_CODES.has(eventCode(event)));
}

function breachAlreadyExplainsFailure(job, budget, allowance) {
  const code = String(job?.errorCode || '').toUpperCase();
  return (budget && BUDGET_CODES.has(code))
    || (allowance && ALLOWANCE_CODES.has(code));
}

function findingCount(job) {
  const candidates = [
    job?.findings,
    job?.result?.findings,
    job?.result?.structured?.findings
  ];
  for (const value of candidates) if (Array.isArray(value) && value.length) return value.length;
  if (job?.result?.structured?.clean === false || job?.objectiveMet === false) return 1;
  return 0;
}

function cancelledByError(job) {
  if (job?.status !== 'cancelled') return false;
  if (job.cancelledByError === true) return true;
  const code = String(job.errorCode || '').toUpperCase();
  if (code && !USER_CANCEL_CODES.has(code)) return true;
  return ['error', 'timeout', 'input-timeout', 'budget', 'large-write'].includes(String(job.stoppedReason || ''));
}

function lastActivityAt(snapshot) {
  const job = snapshot?.job || {};
  const values = [
    snapshot?.lastEventAt,
    job.lastActivityAt,
    Number(job.updatedAt || 0) * 1000,
    Number(job.createdAt || 0) * 1000
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function sessionIdLabel(value) {
  const safe = field(value, '', 256);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(safe) ? safe : 'unknown';
}

function notificationIdentity(job, options = {}) {
  if (!Object.hasOwn(options, 'recipientSessionId')) return {};
  const originSessionId = sessionIdLabel(job?.origin?.sessionId);
  const recipientSessionId = sessionIdLabel(options.recipientSessionId);
  const sessionComparisonKnown = recipientSessionId !== 'unknown';
  const revision = Number(job?.revision);
  return {
    originSessionId,
    isOwnSession: sessionComparisonKnown && originSessionId !== 'unknown'
      && originSessionId === recipientSessionId,
    sessionComparisonKnown,
    observedAtRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : null
  };
}

function candidate(job, key, category, priority, detail = {}) {
  return { job, jobId: safeJobId(job), key, category, priority, ...detail };
}

export function detectActionableEdges(snapshot, options = {}) {
  const job = snapshot?.job || {};
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const now = Number(options.now ?? Date.now());
  const configuredStall = Number(options.stallMs ?? DEFAULT_MONITOR_STALL_MS);
  const stallMs = Number.isFinite(configuredStall) && configuredStall >= 0 ? configuredStall : DEFAULT_MONITOR_STALL_MS;
  const edges = [];
  for (const collision of Array.isArray(job.collisions) ? job.collisions : []) {
    const collisionPath = typeof collision?.path === 'string' ? collision.path : '';
    const collisionLabel = field(collisionPath, '', 180);
    if (!collisionLabel) continue;
    edges.push(candidate(job, `collision:${collisionPath}`, 'collision', 1, {
      path: collisionLabel,
      verificationStale: collision?.verificationStale === true
    }));
  }
  const violations = scopeViolationCount(job);
  if (violations > 0) edges.push(candidate(job, 'policy-breach:scope', 'policy-breach', 1, { breach: 'scope', count: violations }));
  const budget = budgetExceeded(job, events);
  const allowance = allowanceExceeded(job, events);
  if (budget) edges.push(candidate(job, 'budget-breach', 'budget-breach', 1, { breach: 'budget' }));
  if (allowance) edges.push(candidate(job, 'allowance-breach', 'allowance-breach', 1, { breach: 'allowance' }));

  if (inputOutstanding(job, events)) edges.push(candidate(job, 'needs-input:request', 'needs-input', 2, {
    input: 'request',
    requestId: job.pendingInput?.requestId || null,
    requestKind: job.pendingInput?.kind || 'question',
    requiresHumanDecision: job.pendingInput?.requiresHumanDecision === true
      || job.pendingInput?.kind === 'plan-confirmation',
    revision: job.revision,
    expiresAt: Number.isSafeInteger(Number(job.pendingInput?.expiresAt))
      ? Number(job.pendingInput.expiresAt)
      : null
  }));
  if (blockedApproval(events)) edges.push(candidate(job, 'needs-input:permission', 'needs-input', 2, { input: 'permission' }));

  if (job.status === 'completed' && WRITE_MODES.has(job.mode) && job.acceptance?.state === 'blocked') {
    edges.push(candidate(job, 'acceptance:blocked', 'blocked', 3, {
      blockedBy: Array.isArray(job.acceptance.blockedBy) ? job.acceptance.blockedBy : []
    }));
  } else if (job.status === 'completed' && WRITE_MODES.has(job.mode)
    && job.acceptance?.state === 'ready-for-review') {
    edges.push(candidate(job, 'ready-for-review:write', 'ready-for-review', 4));
  } else if (job.status === 'completed' && READ_MODES.has(job.mode)) {
    const findings = findingCount(job);
    if (findings > 0) edges.push(candidate(job, 'ready-for-review:findings', 'ready-for-review', 4, { findings }));
  }

  if ((job.status === 'failed' || String(job.errorCode || '').toUpperCase() === 'ORPHANED' || cancelledByError(job))
    && !breachAlreadyExplainsFailure(job, budget, allowance)) {
    edges.push(candidate(job, 'failure', 'failure', 5));
  }

  const activityAt = lastActivityAt(snapshot);
  if (ACTIVE_STATUSES.has(job.status)
    && !['paused', 'user-input-required'].includes(job.phase)
    && activityAt != null
    && now - activityAt >= stallMs) {
    edges.push(candidate(job, 'stalled', 'stalled', 6, { idleMs: Math.max(0, now - activityAt) }));
  }
  return edges
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key))
    .map((edge) => Object.freeze({ ...edge, ...notificationIdentity(job, options) }));
}

function checkLabel(job) {
  const state = job?.verification?.state;
  if (state === 'passed') return 'checks passed';
  if (state === 'failed') return 'checks failed';
  if (state === 'timeout') return 'checks timed out';
  if (state === 'stale') return 'checks stale';
  const exitCode = Number(job?.verification?.exitCode);
  if (Number.isFinite(exitCode)) return exitCode === 0 ? 'checks passed' : 'checks failed';
  return 'checks not run';
}

function changedFilesLabel(job) {
  const raw = Number(job?.changedFiles?.count);
  if (!Number.isSafeInteger(raw) || raw < 0) return 'files unknown';
  const count = `${raw} file${raw === 1 ? '' : 's'}`;
  return job?.changedFiles?.countIsLowerBound === true ? `at least ${count}` : count;
}

function errorCodeLabel(job) {
  const safe = field(job?.errorCode, '', 48);
  return /^[A-Z0-9_-]{1,48}$/.test(safe) ? safe : '';
}

export function formatEdgeLine(edge) {
  const id = edge.jobId || safeJobId(edge.job);
  const identity = Object.hasOwn(edge, 'isOwnSession')
    ? [
        `origin.sessionId=${edge.originSessionId || 'unknown'}`,
        `isOwnSession=${edge.isOwnSession === true}`,
        `observedAtRevision=${Number.isSafeInteger(edge.observedAtRevision) ? edge.observedAtRevision : 'unknown'}`,
        ...(Number.isSafeInteger(edge.expiresAt) ? [`expiresAt=${edge.expiresAt}`] : []),
        ...(edge.sessionComparisonKnown === false ? ['sessionCorrelation=unavailable'] : [])
      ]
    : [];
  const prefix = `delegate[${monitorProjectLabel(edge.job)}]: ${id}${identity.length ? ` [${identity.join(' ')}]` : ''}`;
  if (edge.category === 'collision') {
    return `${prefix} collision detected (${field(edge.path, 'owned path', 180)}; base-drift recorded${edge.verificationStale ? ', checks stale' : ''})`;
  }
  if (edge.category === 'policy-breach') {
    return `${prefix} policy-breach (scope violation, ${edge.count} path${edge.count === 1 ? '' : 's'})`;
  }
  if (edge.category === 'budget-breach') {
    return `${prefix} budget-breach (per-job output cap exceeded; raise maxOutputTokens or reduce output)`;
  }
  if (edge.category === 'allowance-breach') {
    return `${prefix} allowance-breach (provider quota or rate allowance exhausted; wait for reset or choose another provider)`;
  }
  if (edge.category === 'needs-input') {
    if (edge.isOwnSession === false) {
      return `${prefix} needs-input (cross-session visibility only; the owning session must answer)`;
    }
    if (edge.input === 'permission') return `${prefix} needs-input (permission blocked)`;
    const revision = Number.isInteger(edge.revision) ? edge.revision : Number(edge.job?.revision || 0);
    const candidateRequestId = field(edge.requestId, '', 96);
    const requestId = /^[A-Za-z0-9_.:-]{1,96}$/.test(candidateRequestId) ? candidateRequestId : '';
    const request = requestId ? ` --request-id ${requestId}` : '';
    if (edge.requestKind === 'plan-confirmation') {
      return `${prefix} needs-input [requiresHumanDecision=true] (human plan-confirmation open; inspect with: delegate-jobs inspect ${id}. This notification is not user acknowledgement, approval, or consent; an agent must not execute the decision unattended.)`;
    }
    return `${prefix} needs-input (answer in TUI with a, or: delegate-jobs respond ${id} --expected-revision ${revision}${request} --answer '<answer>')`;
  }
  if (edge.category === 'superseded') {
    return `${prefix} needs-input superseded (request ${field(edge.requestId, 'unknown', 96)} ${field(edge.outcome, 'resolved', 32)}; emittedAtRevision=${Number.isSafeInteger(edge.emittedAtRevision) ? edge.emittedAtRevision : 'unknown'})`;
  }
  if (edge.category === 'blocked') {
    const reasons = (edge.blockedBy || []).map((reason) => field(reason, '', 48)).filter(Boolean);
    return `${prefix} blocked (${safeMode(edge.job)}, ${checkLabel(edge.job)}${reasons.length ? `, ${reasons.join('+')}` : ''})`;
  }
  if (edge.category === 'ready-for-review') {
    if (edge.findings) {
      return `${prefix} ready-for-review (${safeMode(edge.job)}, ${edge.findings} finding${edge.findings === 1 ? '' : 's'})`;
    }
    return `${prefix} ready-for-review (${safeMode(edge.job)}, ${changedFilesLabel(edge.job)}, ${checkLabel(edge.job)})`;
  }
  if (edge.category === 'failure') {
    const code = errorCodeLabel(edge.job);
    return `${prefix} failure (${code || field(edge.job?.status, 'failed', 24)})`;
  }
  const minutes = Math.max(1, Math.floor(Number(edge.idleMs || 0) / 60_000));
  return `${prefix} stalled (no journal progress for ${minutes}m)`;
}

export function formatStartupSummary(edges) {
  const counts = new Map();
  for (const edge of edges) counts.set(edge.category, (counts.get(edge.category) || 0) + 1);
  const labels = [
    ['collision', 'collision'],
    ['policy-breach', 'policy breach'],
    ['budget-breach', 'budget breach'],
    ['allowance-breach', 'allowance breach'],
    ['needs-input', 'input'],
    ['blocked', 'blocked'],
    ['ready-for-review', 'review'],
    ['failure', 'failure'],
    ['stalled', 'stalled']
  ].flatMap(([key, label]) => counts.has(key) ? [`${counts.get(key)} ${label}`] : []);
  return `delegate[${projectSetLabel(edges)}]: ${edges.length} existing job${edges.length === 1 ? ' needs' : 's need'} attention (${labels.join(', ')}; inspect delegate_list)`;
}

export function formatSuppressionSummary(count, projects = ['unknown']) {
  return `delegate[${field([...projects].sort().join('+'), 'unknown', 160)}]: ${count} actionable notification${count === 1 ? '' : 's'} suppressed (rate limit; inspect delegate_list)`;
}

export class FixedWindowRateLimiter {
  constructor(options = {}) {
    this.maximum = Math.max(1, Number(options.maximum || DEFAULT_MONITOR_RATE_LIMIT));
    this.windowMs = Math.max(1000, Number(options.windowMs || MONITOR_RATE_WINDOW_MS));
    this.windowStart = null;
    this.emitted = 0;
    this.suppressed = 0;
    this.suppressedProjects = new Set();
  }

  rotate(now) {
    if (this.windowStart == null) this.windowStart = now;
    if (now - this.windowStart < this.windowMs) return [];
    const suppressed = this.suppressed;
    const projects = new Set(this.suppressedProjects);
    this.windowStart = now;
    this.emitted = 0;
    this.suppressed = 0;
    this.suppressedProjects.clear();
    if (!suppressed) return [];
    this.emitted = 1;
    return [formatSuppressionSummary(suppressed, projects)];
  }

  offer(line, now, project = 'unknown') {
    const output = this.rotate(now);
    if (this.emitted < this.maximum) {
      output.push(line);
      this.emitted += 1;
    } else {
      this.suppressed += 1;
      this.suppressedProjects.add(project);
    }
    return output;
  }

  clearSuppressed() {
    this.suppressed = 0;
    this.suppressedProjects.clear();
  }
}

function preferred(left, right) {
  if (!left) return right;
  if (!right) return left;
  return right.priority < left.priority || (right.priority === left.priority && right.key < left.key) ? right : left;
}

function edgeIdentity(edge) {
  return edge.category === 'needs-input'
    ? `${edge.key}:${edge.requestId || edge.input || 'unknown'}`
    : edge.key;
}

function answeredSupersede(snapshot, emittedEdge, options = {}) {
  if (emittedEdge?.category !== 'needs-input' || !emittedEdge.requestId) return null;
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const resolved = latestEvent(events, (event) => event.type === 'input.resolved'
    && event.data?.requestId === emittedEdge.requestId
    && event.data?.outcome === 'answered');
  if (!resolved) return null;
  return Object.freeze({
    ...candidate(snapshot?.job || {}, `superseded:${edgeIdentity(emittedEdge)}`, 'superseded', 2, {
      requestId: emittedEdge.requestId,
      outcome: 'answered',
      emittedAtRevision: emittedEdge.observedAtRevision,
      expiresAt: emittedEdge.expiresAt
    }),
    ...notificationIdentity(snapshot?.job || {}, options)
  });
}

function unacknowledgedAtBoot(edge) {
  const job = edge.job || {};
  if (ACTIVE_STATUSES.has(job.status)) return true;
  return job.needsAttention === true
    || job.monitorNeedsAttention === true
    || job.attention?.acknowledged === false;
}

export class NotificationPolicy {
  constructor(options = {}) {
    this.cooldownMs = Math.max(0, Number(options.cooldownMs ?? DEFAULT_MONITOR_COOLDOWN_MS));
    this.stallMs = Math.max(0, Number(options.stallMs ?? DEFAULT_MONITOR_STALL_MS));
    this.active = new Map();
    this.pending = new Map();
    this.emittedActive = new Map();
    this.lastEmittedAt = new Map();
    this.rate = new FixedWindowRateLimiter({
      maximum: options.maxLinesPerMinute,
      windowMs: options.rateWindowMs
    });
    this.bootstrapped = false;
  }

  bootstrap(snapshots = [], options = {}) {
    const now = Number(options.now ?? Date.now());
    const attention = [];
    this.active.clear();
    for (const snapshot of snapshots) {
      const edges = detectActionableEdges(snapshot, {
        now,
        stallMs: this.stallMs,
        ...(Object.hasOwn(options, 'recipientSessionId') ? { recipientSessionId: options.recipientSessionId } : {})
      });
      const jobId = safeJobId(snapshot?.job);
      this.active.set(jobId, new Set(edges.map(edgeIdentity)));
      const selected = edges.find((edge) => unacknowledgedAtBoot(edge)
        && (!options.snoozed || edge.priority === 1));
      if (selected) attention.push(selected);
    }
    this.bootstrapped = true;
    if (!attention.length) return [];
    return this.rate.offer(formatStartupSummary(attention), now, projectSetLabel(attention));
  }

  observe(snapshots = [], options = {}) {
    if (!this.bootstrapped) return this.bootstrap(snapshots, options);
    const now = Number(options.now ?? Date.now());
    const output = options.snoozed ? [] : this.rate.rotate(now);
    if (options.snoozed) this.rate.clearSuppressed();
    const seen = new Set();
    for (const snapshot of snapshots) {
      const edges = detectActionableEdges(snapshot, {
        now,
        stallMs: this.stallMs,
        ...(Object.hasOwn(options, 'recipientSessionId') ? { recipientSessionId: options.recipientSessionId } : {})
      });
      const jobId = safeJobId(snapshot?.job);
      seen.add(jobId);
      const previous = this.active.get(jobId) || new Set();
      const current = new Set(edges.map(edgeIdentity));
      const byKey = new Map(edges.map((edge) => [edgeIdentity(edge), edge]));
      const emitted = new Map(this.emittedActive.get(jobId) || []);
      for (const [identity, priorEdge] of emitted) {
        if (current.has(identity)) continue;
        emitted.delete(identity);
        const supersede = answeredSupersede(snapshot, priorEdge, options);
        if (supersede) output.push(formatEdgeLine(supersede));
      }
      if (emitted.size) this.emittedActive.set(jobId, emitted);
      else this.emittedActive.delete(jobId);
      const pending = new Map(
        [...(this.pending.get(jobId) || new Map())]
          .filter(([key]) => current.has(key))
      );
      for (const edge of edges) {
        const identity = edgeIdentity(edge);
        if (!previous.has(identity) && (!options.snoozed || edge.priority === 1)) {
          pending.set(identity, edge);
        }
      }
      let selected = null;
      for (const edge of pending.values()) selected = preferred(selected, edge);
      this.active.set(jobId, current);
      if (!selected || (options.snoozed && selected.priority !== 1)) continue;
      const last = Number(this.lastEmittedAt.get(jobId) ?? Number.NEGATIVE_INFINITY);
      if (now - last < this.cooldownMs) {
        this.pending.set(jobId, pending);
        continue;
      }
      const selectedIdentity = edgeIdentity(selected);
      pending.delete(selectedIdentity);
      if (pending.size) this.pending.set(jobId, pending);
      else this.pending.delete(jobId);
      this.lastEmittedAt.set(jobId, now);
      const emittedEdge = byKey.get(selectedIdentity) || selected;
      const line = formatEdgeLine(emittedEdge);
      const offered = this.rate.offer(line, now, monitorProjectLabel(emittedEdge.job));
      output.push(...offered);
      if (offered.includes(line)) {
        const activeEmitted = new Map(this.emittedActive.get(jobId) || []);
        activeEmitted.set(selectedIdentity, emittedEdge);
        this.emittedActive.set(jobId, activeEmitted);
      }
    }
    for (const jobId of this.active.keys()) {
      if (seen.has(jobId)) continue;
      this.active.delete(jobId);
      this.pending.delete(jobId);
      this.emittedActive.delete(jobId);
      this.lastEmittedAt.delete(jobId);
    }
    return output;
  }
}
