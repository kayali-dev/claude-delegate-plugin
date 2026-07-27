import fs from 'node:fs';
import path from 'node:path';
import {
  avoidPercentFor,
  effectiveUsage,
  enabledProviders,
  listJobs,
  loadState,
  warningPercentFor
} from './state.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PROVIDERS = new Set(['claude', 'codex', 'cursor']);
const ENTRY_CAP = 8;

export const NATIVE_CONTEXT_MAX_BYTES = 2_048;

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value);
  try {
    return (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

function sameDirectory(left, right) {
  const first = canonicalDirectory(left);
  const second = canonicalDirectory(right);
  return first != null && second != null && first === second;
}

function safeId(value) {
  const text = String(value || '');
  return SAFE_ID.test(text) ? text : null;
}

function safeSessionId(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(text) ? text : null;
}

function safeToken(value, fallback = 'unknown') {
  const text = String(value || '');
  return SAFE_TOKEN.test(text) ? text : fallback;
}

function timestamp(job) {
  return Number(job?.updatedAt || job?.completedAt || job?.createdAt || 0);
}

function nativeScope(value) {
  const scope = String(value || 'session').trim().toLowerCase();
  if (scope === 'project') return 'workspace';
  return ['session', 'workspace', 'all', 'off'].includes(scope) ? scope : 'session';
}

function scopeJobs(jobs, options) {
  const scope = nativeScope(options.scope);
  if (scope === 'off') return [];
  if (scope === 'all') return jobs;
  if (scope === 'session') {
    if (!options.sessionId) return [];
    return jobs.filter((job) => job?.origin?.sessionId === options.sessionId);
  }
  if (!options.workspaceId) return [];
  return jobs.filter((job) => sameDirectory(
    job?.origin?.workspaceId || job?.origin?.projectDir,
    options.workspaceId
  ));
}

function publicJob(job, byId) {
  const id = safeId(job?.id);
  if (!id) return null;
  let root = job;
  const seen = new Set([id]);
  while (safeId(root?.parentJobId) && !seen.has(root.parentJobId) && byId.has(root.parentJobId)) {
    seen.add(root.parentJobId);
    root = byId.get(root.parentJobId);
  }
  return {
    id,
    provider: PROVIDERS.has(job.provider) ? job.provider : 'unknown',
    status: safeToken(job.status),
    phase: safeToken(job.phase || job.status),
    rootJobId: safeId(root?.id) || id
  };
}

function blockerFor(job) {
  if ((job?.scopeViolations?.length || 0) > 0 || (job?.collisions?.length || 0) > 0) {
    return { priority: 1, kind: 'policy-breach', reason: 'owned-path-overlap-or-scope-violation' };
  }
  if (job?.pendingInput || job?.stopReason === 'USER_INPUT_REQUIRED'
    || /(?:input|required|approval|permission)/i.test(String(job?.phase || ''))) {
    return { priority: 2, kind: 'human-input', reason: 'human-input-required' };
  }
  if (job?.acceptance?.state === 'blocked') {
    const reason = (job.acceptance.blockedBy || []).map((value) => safeToken(value, null)).find(Boolean);
    return { priority: 3, kind: 'acceptance-blocked', reason: reason || 'acceptance-evidence-blocked' };
  }
  return null;
}

function resumable(job, children) {
  if (!TERMINAL_STATUSES.has(job?.status)) return false;
  if (job?.managedBy !== 'delegate-control') return false;
  if (!job?.providerSessionId && !job?.session) return false;
  if (job?.provider === 'codex' && job?.reviewFlowEngaged === true) return false;
  if (['accepted', 'rejected', 'superseded'].includes(job?.acceptance?.state)) return false;
  return !children.has(job.id);
}

function allowanceBand(provider, usedPercent) {
  if (!Number.isFinite(usedPercent)) return 'unknown';
  if (usedPercent >= 98) return 'blocked';
  if (usedPercent >= avoidPercentFor(provider)) return 'avoid';
  if (usedPercent >= warningPercentFor(provider)) return 'warning';
  return 'normal';
}

function providerAllowance(options, active, needsReview) {
  const usageState = options.usageState;
  const configured = options.enabled || [];
  const candidates = [
    ...active.map((job) => job.provider),
    ...needsReview.map((job) => job.provider),
    ...configured,
    'codex',
    'cursor'
  ].filter((provider, index, values) => PROVIDERS.has(provider) && values.indexOf(provider) === index);
  let fallback = null;
  for (const provider of candidates) {
    let usage;
    try { usage = effectiveUsage(usageState, provider); } catch { continue; }
    const item = {
      provider,
      known: usage.known,
      usedPercent: usage.known ? Number(usage.usedPercent.toFixed(2)) : null,
      band: allowanceBand(provider, usage.usedPercent)
    };
    if (!fallback) fallback = item;
    if (usage.known) return item;
  }
  return fallback || { provider: 'codex', known: false, usedPercent: null, band: 'unknown' };
}

function defaultEnabledProviders() {
  try { return enabledProviders(); } catch { return ['codex', 'cursor']; }
}

export function nativeWorkOptions(payload = {}, env = process.env) {
  return {
    sessionId: safeSessionId(payload.session_id || env.CLAUDE_CODE_SESSION_ID),
    workspaceId: canonicalDirectory(
      env.CLAUDE_PROJECT_DIR
      || payload.workspace?.project_dir
      || payload.workspace?.current_dir
      || payload.cwd
      || process.cwd()
    ),
    scope: nativeScope(env.DELEGATE_NATIVE_SCOPE || 'session')
  };
}

export function buildNativeWorkState(options = {}) {
  const jobs = Array.isArray(options.jobs) ? options.jobs : listJobs();
  const usageState = options.usageState || loadState();
  const enabled = Array.isArray(options.enabled) ? options.enabled : defaultEnabledProviders();
  const scoped = scopeJobs(jobs, options)
    .filter((job) => safeId(job?.id))
    .sort((left, right) => timestamp(right) - timestamp(left) || String(left.id).localeCompare(String(right.id)));
  const byId = new Map(scoped.map((job) => [job.id, job]));
  const children = new Set(scoped.map((job) => safeId(job.parentJobId)).filter(Boolean));
  const activeRaw = scoped.filter((job) => ACTIVE_STATUSES.has(job.status));
  const reviewRaw = scoped.filter((job) => job?.acceptance?.state === 'ready-for-review');
  const blockedRaw = scoped.flatMap((job) => {
    const blocker = blockerFor(job);
    const publicValue = publicJob(job, byId);
    return blocker && publicValue ? [{ ...publicValue, ...blocker }] : [];
  }).sort((left, right) => left.priority - right.priority);
  const resumableRaw = scoped.filter((job) => resumable(job, children));

  const active = activeRaw.map((job) => publicJob(job, byId)).filter(Boolean);
  const needsReview = reviewRaw.map((job) => publicJob(job, byId)).filter(Boolean);
  const resumableChains = resumableRaw.map((job) => publicJob(job, byId)).filter(Boolean);
  const result = {
    schemaVersion: 1,
    scope: nativeScope(options.scope),
    runningCount: active.length,
    needsReviewCount: needsReview.length,
    blockedCount: blockedRaw.length,
    resumableCount: resumableChains.length,
    providerAllowance: providerAllowance({ usageState, enabled }, active, needsReview),
    active: active.slice(0, ENTRY_CAP),
    blocked: blockedRaw.slice(0, ENTRY_CAP),
    needsReview: needsReview.slice(0, ENTRY_CAP),
    resumableChains: resumableChains.slice(0, ENTRY_CAP)
  };
  result.omittedCount = (active.length - result.active.length)
    + (blockedRaw.length - result.blocked.length)
    + (needsReview.length - result.needsReview.length)
    + (resumableChains.length - result.resumableChains.length);
  return result;
}

export function renderWorkStateChip(options = {}) {
  const state = options.workState || buildNativeWorkState(options);
  const parts = [];
  if (state.runningCount) parts.push(`${state.runningCount} running`);
  if (state.needsReviewCount) parts.push(`${state.needsReviewCount} needs review`);
  if (!parts.length) parts.push('idle');
  const allowance = state.providerAllowance || {};
  parts.push(`${safeToken(allowance.provider, 'codex')} ${
    allowance.known && Number.isFinite(allowance.usedPercent)
      ? `${Math.round(allowance.usedPercent)}%`
      : '?'
  }`);
  return `D ${parts.join(' · ')}`;
}

function itemLine(label, item, detail) {
  const suffix = detail ? `; ${detail}` : '';
  return `${label}: ${item.id} [${item.provider} ${item.phase}${suffix}]`;
}

export function renderNativeAdditionalContext(options = {}) {
  const state = options.workState || buildNativeWorkState(options);
  if (!state.runningCount && !state.needsReviewCount && !state.blockedCount && !state.resumableCount) {
    return 'Delegate work: none in this coordinator session.';
  }

  const maximum = Math.min(
    NATIVE_CONTEXT_MAX_BYTES,
    Math.max(256, Number(options.maxBytes || NATIVE_CONTEXT_MAX_BYTES))
  );
  const header = `Delegate work (${state.scope}; bounded metadata only, max ${NATIVE_CONTEXT_MAX_BYTES} bytes):`;
  const footer = 'Use these IDs directly with delegate_inspect/resume; delegate_list is only the overflow or new-session fallback.';
  const blockedIds = new Set(state.blocked.map((item) => item.id));
  const candidates = [
    ...state.blocked.filter((item) => item.priority === 1)
      .map((item) => itemLine('policy breach', item, item.reason)),
    ...state.blocked.filter((item) => item.priority === 2)
      .map((item) => itemLine('human input', item, item.reason)),
    ...state.blocked.filter((item) => item.priority > 2)
      .map((item) => itemLine('acceptance blocked', item, item.reason)),
    ...state.needsReview.map((item) => itemLine('needs review', item)),
    ...state.resumableChains
      .filter((item) => !state.needsReview.some((review) => review.id === item.id)
        && !state.blocked.some((blocked) => blocked.id === item.id))
      .map((item) => itemLine('resumable', item, `chain ${item.rootJobId}`)),
    ...state.active.filter((item) => !blockedIds.has(item.id))
      .map((item) => itemLine('active', item))
  ];
  const lines = [header];
  let omitted = state.omittedCount || 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const reserve = `\nomitted: ${omitted + candidates.length - index - 1} lower-priority item(s); use delegate_list.\n${footer}`;
    if (Buffer.byteLength(`${lines.join('\n')}\n${candidate}${reserve}`, 'utf8') <= maximum) {
      lines.push(candidate);
    } else {
      omitted += 1;
    }
  }
  if (omitted) lines.push(`omitted: ${omitted} lower-priority item(s); use delegate_list.`);
  lines.push(footer);
  while (Buffer.byteLength(lines.join('\n'), 'utf8') > maximum && lines.length > 2) {
    lines.splice(lines.length - 2, 1);
  }
  return lines.join('\n');
}
