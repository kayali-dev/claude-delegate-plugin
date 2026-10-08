import fs from 'node:fs';
import path from 'node:path';
import {
  inspectJob, jobDiff, redact, sliceDiff, submitControl
} from './control.mjs';
import { brokerError } from './errors.mjs';
import { captureClaudeUsage } from './claude-usage.mjs';
import { buildNativeWorkState, renderWorkStateChip } from './native-session.mjs';
import { effectiveUsage, enabledProviders, listJobs, loadJob, loadState, avoidPercentFor } from './state.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_ROWS = 40;
const FIELDS = new Set(['sessionId', 'projectDir', 'scope', 'jobId', 'expectedRevision', 'commandId', 'requestId', 'answer', 'accept', 'text', 'usage', 'confirmed']);

function text(value, maximum = 256) {
  return String(redact(String(value ?? ''))).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, maximum);
}

function canonical(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { return fs.realpathSync(value); } catch { return path.normalize(value); }
}

function ownSession(job, input) {
  return SESSION.test(input.sessionId || '') && job.origin?.sessionId === input.sessionId;
}

function inScope(job, input) {
  if (input.scope === 'all') return true;
  if (input.scope === 'workspace') {
    const root = canonical(input.projectDir);
    return root != null && canonical(job.origin?.workspaceId || job.origin?.projectDir) === root;
  }
  return ownSession(job, input);
}

function row(job, input, enabled) {
  const own = ownSession(job, input);
  const active = ['queued', 'running'].includes(job.status);
  const managed = job.managedBy === 'delegate-control';
  const liveInput = job.pendingInput && job.pendingInput.timedOut !== true
    && (!job.pendingInput.expiresAt || job.pendingInput.expiresAt > Date.now());
  const providerEnabled = job.provider === 'claude' || enabled.includes(job.provider);
  return {
    id: job.id,
    provider: text(job.provider, 16),
    model: text(job.model || job.requestedModel || 'provider default', 128),
    mode: text(job.mode, 24),
    status: text(job.status, 32),
    phase: text(job.phase || job.status, 64),
    revision: Number.isSafeInteger(job.revision) ? job.revision : null,
    isOwnSession: own,
    providerEnabled,
    managed,
    isolation: job.isolation === 'worktree' ? 'worktree' : 'shared',
    verification: text(job.verification?.state || job.verifyResult?.state || 'unknown', 32),
    acceptance: text(job.acceptance?.state || 'undecided', 32),
    changedFiles: Number.isSafeInteger(job.changedFiles?.count) ? job.changedFiles.count : null,
    countIsLowerBound: job.containment !== 'broker-workspace' && job.isolation !== 'worktree',
    pendingInput: liveInput ? {
      requestId: text(job.pendingInput.requestId, 256),
      kind: text(job.pendingInput.kind || 'question', 32),
      expiresAt: Number.isSafeInteger(job.pendingInput.expiresAt) ? job.pendingInput.expiresAt : null
    } : null,
    canCancel: own && providerEnabled && managed && active,
    canSteer: own && providerEnabled && managed && job.status === 'running' && !job.pendingInput,
    canAnswer: own && providerEnabled && managed && active && Boolean(liveInput),
    updatedAt: Number.isFinite(job.updatedAt) ? job.updatedAt : 0
  };
}

export function nativeOverview(input, options = {}) {
  const enabled = options.enabled || enabledProviders();
  const usageState = options.usageState || loadState();
  const all = options.jobs || listJobs();
  const jobs = all.filter((job) => ID.test(job?.id || '') && inScope(job, input))
    .sort((a, b) => {
      const priority = (job) => job.pendingInput && job.pendingInput.timedOut !== true ? 0
        : job.acceptance?.state === 'ready-for-review' ? 1
          : ['queued', 'running'].includes(job.status) ? 2 : 3;
      return priority(a) - priority(b) || (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    });
  const workState = buildNativeWorkState({ jobs: all, usageState, enabled, ...input, workspaceId: input.projectDir });
  return {
    schemaVersion: 1,
    observedAt: Date.now(),
    scope: input.scope || 'session',
    enabledProviders: enabled,
    chip: renderWorkStateChip({ workState }),
    workState,
    allowance: ['claude', ...enabled].map((provider) => {
      const usage = effectiveUsage(usageState, provider);
      return {
        provider,
        known: usage.known,
        usedPercent: usage.known ? usage.usedPercent : null,
        avoidPercent: avoidPercentFor(provider),
        windows: usage.windows.slice(0, 8).map((window) => ({
          name: text(window.name, 32), usedPercent: window.usedPercent,
          resetsAt: window.resetsAt || null, source: text(window.source, 32), updatedAt: window.updatedAt
        }))
      };
    }),
    jobs: jobs.slice(0, MAX_ROWS).map((job) => row(job, input, enabled)),
    omittedCount: Math.max(0, jobs.length - MAX_ROWS)
  };
}

function getJob(input) {
  if (!ID.test(input.jobId || '')) throw brokerError('INVALID_REQUEST', 'a valid jobId is required');
  const job = loadJob(input.jobId);
  if (!job) throw brokerError('NOT_FOUND', 'job not found');
  return job;
}

export async function dispatchNative(action, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw brokerError('INVALID_REQUEST', 'expected an input object');
  if (Object.keys(input).some((key) => !FIELDS.has(key))) throw brokerError('INVALID_REQUEST', 'unsupported native input field');
  if (input.scope != null && !['session', 'workspace', 'all'].includes(input.scope)) throw brokerError('INVALID_REQUEST', 'invalid scope');
  if (!['usage', 'snapshot', 'inspect', 'diff', 'cancel', 'steer', 'respond'].includes(action)) throw brokerError('INVALID_REQUEST', 'unsupported native action');
  if (action === 'usage') return captureClaudeUsage(input.usage);
  if (action === 'snapshot') return nativeOverview(input);
  const existing = getJob(input);
  if (action === 'inspect') {
    const job = inspectJob(existing.id);
    const planText = JSON.stringify(job.planning?.primary || job.pendingInput?.planEntries || null, null, 2);
    const resultText = job.resultText || job.result?.text || '';
    const paths = job.originalAllowedPaths || job.allowedPaths;
    return {
      ...row(job, input, enabledProviders()),
      scope: {
        state: text(job.scopePolicy?.state || (paths?.length ? 'explicit-paths' : 'unknown'), 32),
        paths: Array.isArray(paths) ? paths.slice(0, 40).map((value) => text(value, 256)) : [],
        omittedCount: Array.isArray(paths) ? Math.max(0, paths.length - 40) : 0
      },
      policy: { approval: text(job.approval || 'unknown', 32), sandbox: text(job.sandbox || 'auto', 32), network: typeof job.network === 'boolean' ? job.network : null },
      budget: { timeoutSeconds: job.timeoutSeconds ?? null, maxOutputTokens: job.maxOutputTokens ?? null },
      resultText: text(resultText, 8_000),
      evidenceTruncated: String(redact(planText)).length > 8_000 || String(redact(resultText)).length > 8_000
        || (Array.isArray(paths) && (paths.length > 40 || paths.some((value) => String(value).length > 256))),
      scopeViolations: (job.scopeViolations || []).slice(0, 20).map((entry) => text(entry.path || entry, 256)),
      question: text(job.pendingInput?.question, 8_000),
      plan: text(planText, 8_000),
      verification: {
        state: text(job.verification?.state || 'unknown', 32),
        caveats: (job.verification?.caveats || []).slice(0, 10).map((value) => text(value, 256))
      }
    };
  }
  if (action === 'diff') return { jobId: existing.id, ...sliceDiff(String(redact(jobDiff(existing.id))), { maxChars: 32_000 }) };
  if (!['cancel', 'steer', 'respond'].includes(action)) throw brokerError('INVALID_REQUEST', 'unsupported native action');
  if (!ownSession(existing, input)) throw brokerError('INVALID_REQUEST', 'native controls require the owning Claude session; use explicit CLI/MCP coordination otherwise');
  if (!enabledProviders().includes(existing.provider)) throw brokerError('PROVIDER_DISABLED', 'the job provider is disabled');
  if (input.confirmed !== true) throw brokerError('INVALID_REQUEST', 'a human confirmation is required');
  if (!ID.test(input.commandId || '')) throw brokerError('INVALID_REQUEST', 'a stable commandId is required');
  let command = { type: action, commandId: input.commandId };
  if (action === 'respond') {
    if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 256) throw brokerError('INVALID_REQUEST', 'requestId is required');
    command.requestId = input.requestId;
    if (existing.pendingInput?.kind === 'plan-confirmation') {
      if (typeof input.accept !== 'boolean' || input.answer != null) throw brokerError('INVALID_REQUEST', 'a plan requires a boolean decision, not an answer');
      command.accept = input.accept;
    } else {
      if (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 8_192 || input.accept != null) throw brokerError('INVALID_REQUEST', 'a bounded answer is required');
      command.answer = input.answer;
    }
  }
  if (action === 'steer') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8_192) throw brokerError('INVALID_REQUEST', 'bounded steering text is required');
    command.text = input.text;
    command.strategy = 'auto';
    command.correctionId = input.commandId;
  }
  // Intake is bounded and revisioned. Queued != applied: the UI refreshes the
  // real job instead of holding a hook until the provider eventually answers.
  const intake = submitControl(existing.id, command, input.expectedRevision);
  return { jobId: existing.id, commandId: input.commandId, state: 'queued-or-duplicate', duplicate: intake.duplicate === true };
}
