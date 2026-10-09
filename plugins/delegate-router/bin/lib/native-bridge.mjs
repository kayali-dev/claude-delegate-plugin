import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  inspectJob, jobDiff, jobFiles, filterDiffPaths, redact, sliceDiff, sliceResultText, submitControl, claimJobController, agentStubActivity
} from './control.mjs';
import { brokerError } from './errors.mjs';
import { captureClaudeUsage } from './claude-usage.mjs';
import { buildNativeWorkState, renderWorkStateChip } from './native-session.mjs';
import { effectiveUsage, enabledProviders, listJobs, loadJob, loadState, avoidPercentFor } from './state.mjs';
import { controllerSession } from './admission.mjs';
import { previewNativeTask, launchNativePreview } from './native-launch.mjs';
import { enqueueNativePreview, listDispatchQueue, controlDispatchQueue } from './dispatch-queue.mjs';
import { observeClaudeAgents, bindClaudeAgent } from './native-agents.mjs';
import { jobTimeBudget } from './job-health.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_ROWS = 40;
const FIELDS = new Set(['sessionId', 'projectDir', 'scope', 'jobId', 'expectedRevision', 'commandId', 'requestId', 'answer', 'accept', 'text', 'usage', 'confirmed',
  'draft', 'previewId', 'authorizeCredits', 'priority', 'queueId', 'queueAction', 'agents', 'spawn', 'offset', 'file', 'find', 'evidenceVersion', 'view']);

function text(value, maximum = 256) {
  return String(redact(String(value ?? ''))).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, maximum);
}

function boundedRows(values, maximum = 40, byteLimit = 80_000) {
  const rows = []; let bytes = 2;
  for (const value of values.slice(0, maximum)) {
    const length = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes + length > byteLimit) break;
    rows.push(value); bytes += length;
  }
  return rows;
}

function canonical(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { return fs.realpathSync(value); } catch { return path.normalize(value); }
}

function ownSession(job, input) {
  return SESSION.test(input.sessionId || '') && controllerSession(job) === input.sessionId;
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
    updatedAt: Number.isFinite(job.updatedAt) ? job.updatedAt : 0,
    scopeViolationCount: (job.scopeViolations || []).length,
    controllerSessionId: controllerSession(job), originSessionId: job.origin?.sessionId || null,
    workspaceId: text(job.origin?.workspaceId || job.origin?.projectDir, 2048) || null,
    parentJobId: job.parentJobId || null, agentId: job.hostAgentId || job.agentId || job.transcriptAgentId || null,
    parentAgentId: job.parentAgentId || null, agentName: text(job.agentName || job.agentType, 128),
    hostStatus: ['completed', 'failed', 'cancelled'].includes(job.status) ? job.status
      : job.hostAgent?.observedAt > Date.now() - 90_000 ? text(job.hostAgent.status, 32) : null,
    activitySource: job.hostAgent?.observedAt > Date.now() - 90_000 ? 'claude-host'
      : job.transport === 'claude-agent' ? 'transcript-observation' : 'broker',
    agentActivityState: job.transport === 'claude-agent' && !['completed', 'failed', 'cancelled'].includes(job.status)
      ? agentStubActivity(job)?.state || 'unknown' : null,
    timeBudget: jobTimeBudget(job),
    observedOutputTokens: Number.isFinite(job.usage?.outputTokens) ? job.usage.outputTokens : null,
    reportedChildren: (Array.isArray(job.result?.subagents) ? job.result.subagents : []).slice(0, 16).map((child) => ({
      id: text(child.id || child.agentId, 128), status: text(child.status || 'unknown', 32),
      label: text(child.agentName || child.task || child.type, 128) }))
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
  const queue = (options.queue || listDispatchQueue()).filter((entry) => input.scope === 'all' ? true
    : input.scope === 'workspace' ? canonical(entry.projectDir) === canonical(input.projectDir)
      : entry.sessionId === input.sessionId).sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending')
        || b.priority - a.priority || b.createdAt - a.createdAt);
  const queuePendingCount = queue.filter((entry) => entry.state === 'pending').length;
  const jobRows = boundedRows(jobs.slice(0, MAX_ROWS).map((job) => row(job, input, enabled)));
  const queueRows = boundedRows(queue.slice(0, 40).map((entry) => ({ ...entry, isOwnSession: entry.sessionId === input.sessionId })), 40, 20_000);
  return {
    schemaVersion: 1,
    observedAt: Date.now(),
    scope: input.scope || 'session',
    enabledProviders: enabled,
    chip: renderWorkStateChip({ workState }) + (queuePendingCount ? ` · ${queuePendingCount} pending` : ''),
    queuePendingCount,
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
    jobs: jobRows,
    omittedCount: Math.max(0, jobs.length - jobRows.length),
    queue: queueRows,
    omittedQueueCount: Math.max(0, queue.length - queueRows.length)
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
  if (!['usage', 'snapshot', 'inspect', 'diff', 'evidence', 'cancel', 'steer', 'respond', 'preview', 'launch', 'enqueue', 'queue-control', 'agents', 'agent-bind', 'claim'].includes(action)) throw brokerError('INVALID_REQUEST', 'unsupported native action');
  if (action === 'usage') return captureClaudeUsage(input.usage);
  if (action === 'agents') return observeClaudeAgents(input);
  if (action === 'agent-bind') return bindClaudeAgent(input);
  if (action === 'preview') return previewNativeTask(input);
  if (action === 'launch') return launchNativePreview(input);
  if (action === 'enqueue') return enqueueNativePreview(input);
  if (action === 'queue-control') return controlDispatchQueue(input);
  if (action === 'snapshot') return nativeOverview(input);
  const existing = getJob(input);
  if (action === 'claim') return claimJobController(existing.id, input);
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
        caveats: (job.verification?.caveats || []).slice(0, 10).map((value) => text(value, 256)),
        exitCode: job.verification?.exitCode ?? null,
        outputTail: text(job.verification?.outputTail || job.verification?.output, 8000),
        command: text(job.verify?.command, 2000)
      },
      baseRevision: text(job.changeSet?.base?.revision || job.workspace?.baseRevision, 128) || null,
      drift: { baseDrift: job.baseDrift === true || job.driftReport?.baseDrift === true,
        outsideScope: (job.scopeViolations || []).length },
      canClaim: !ownSession(job, input) && job.managedBy === 'delegate-control'
        && enabledProviders().includes(job.provider)
        && canonical(input.projectDir) != null
        && canonical(input.projectDir) === canonical(job.origin?.workspaceId || job.origin?.projectDir)
    };
  }
  if (action === 'diff' || action === 'evidence') {
    if (input.offset != null && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw brokerError('INVALID_REQUEST', 'offset must be a nonnegative integer');
    if (input.find != null && (typeof input.find !== 'string' || !input.find || input.find.length > 256)) throw brokerError('INVALID_REQUEST', 'search must be 1..256 characters');
    let evidence = action === 'diff' ? String(redact(jobDiff(existing.id), '', Number.POSITIVE_INFINITY))
      : String(redact(input.view === 'plan' ? JSON.stringify(existing.planning?.primary || existing.pendingInput?.planEntries || null, null, 2)
        : existing.resultText || existing.result?.text || '', '', Number.POSITIVE_INFINITY));
    const evidenceVersion = crypto.createHash('sha256').update(evidence).digest('hex');
    if (input.evidenceVersion && input.evidenceVersion !== evidenceVersion) throw brokerError('REVISION_CONFLICT', 'evidence changed; restart inspection at the first page');
    const files = action === 'diff' ? jobFiles(existing.id) : [];
    if (input.file) {
      if (action !== 'diff' || !files.some((entry) => entry.path === input.file)) throw brokerError('INVALID_REQUEST', 'select a recorded changed file');
      evidence = filterDiffPaths(evidence, [input.file]);
    }
    let offset = input.offset || 0;
    if (input.find) {
      const found = evidence.indexOf(input.find, offset);
      if (found < 0) throw brokerError('NOT_FOUND', 'search text not found in this evidence');
      offset = found;
    }
    let maxChars = action === 'diff' ? 32_000 : 24_000;
    const slice = action === 'diff' ? sliceDiff : sliceResultText;
    let page = slice(evidence, { offset, maxChars });
    while (Buffer.byteLength(JSON.stringify(page)) > 90_000 && maxChars > 1000) {
      maxChars = Math.floor(maxChars / 2); page = slice(evidence, { offset, maxChars });
    }
    const fileRows = boundedRows(files.slice(0, 64).map((entry) => ({ path: text(entry.path, 1024) })), 64, 16_000);
    return { jobId: existing.id, ...page, evidenceVersion,
      files: fileRows,
      omittedFiles: Math.max(0, files.length - fileRows.length) };
  }
  if (!['cancel', 'steer', 'respond'].includes(action)) throw brokerError('INVALID_REQUEST', 'unsupported native action');
  if (!ownSession(existing, input)) throw brokerError('INVALID_REQUEST', 'native controls require the owning Claude session; use explicit CLI/MCP coordination otherwise');
  if (!enabledProviders().includes(existing.provider)) throw brokerError('PROVIDER_DISABLED', 'the job provider is disabled');
  if (input.confirmed !== true) throw brokerError('INVALID_REQUEST', 'a human confirmation is required');
  if (!ID.test(input.commandId || '')) throw brokerError('INVALID_REQUEST', 'a stable commandId is required');
  let command = { type: action, commandId: input.commandId, controllerSessionId: input.sessionId };
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
