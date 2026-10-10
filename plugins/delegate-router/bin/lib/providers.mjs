import crypto from 'node:crypto';
import { observeDirectory, compareDirectoryObservations, fileMetadata, sensitiveObservationPath } from './file-observation.mjs';
import fs from 'node:fs';
import { managedTimeoutMs, jobTimeBudget } from './job-health.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendJobEvent,
  attributeInterrogationUsage,
  awaitAmbiguityProbe,
  captureManagedWorkspace,
  claimCommands,
  claimTransientCommands,
  changedFilesRecord,
  completeCommand,
  completeIngestedFiles,
  DeltaRedactor,
  diffStat,
  hashWorkingFile,
  inspectJob,
  jobConclusion,
  jobFiles,
  pathMatchesScope,
  recordInterrogationAnswer,
  recordPlanPassOutcome,
  redact,
  readJobEvents,
  resumeManagedJob,
  settleQueuedControl,
  startAmbiguityProbe,
  updateManagedJob,
  usageTotals
} from './control.mjs';
import {
  availableModelIds,
  buildCursorArgs,
  cursorLaunchCommand,
  cursorProjectConfigFailure,
  evaluateCursorNetworkPreflight,
  findValue,
  materializeCursorNetworkPolicy,
  resolveCursorBinary,
  resolveCursorModel,
  runCursor
} from './cursor.mjs';
import { compareVersions } from './cursor.mjs';
import { delay, JsonRpcProcess } from './jsonrpc.mjs';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { resolveCodexModel } from './models.mjs';
import { discoverCodexModels, validateCodexSelection } from './model-catalog.mjs';
import { nativeOutputSchema, parseLastStructuredResult } from './structured-output.mjs';
import { recordWorkBudgetUsage, workBudgetSnapshot } from './work-budget.mjs';
import { assembleProviderPrompt, securityPreamble } from './packet.mjs';
import { terminateProcessTree } from './process.mjs';
import { loadJob, mutateState, setWindow } from './state.mjs';
import { captureCodexAllowanceSnapshot } from './allowance.mjs';
import { isCodexFirstClassItemType } from './codex-item-types.mjs';
import {
  appendVerificationEvidence,
  buildAcceptance,
  evaluateAutoFix
} from './acceptance.mjs';
import {
  verificationRepositoryRevision,
  revisionChangedPaths
} from './verification-profile.mjs';
import {
  beginCoordinatorQuestion,
  codexBackchannelConfig,
  cursorAcpBackchannelServer,
  materializeCursorBackchannelPlugin,
  normalizeCoordinatorQuestion,
  resolveCoordinatorQuestion
} from './backchannel.mjs';
import {
  assessStructuralPlanOutput,
  compareStructuralPlans,
  IMPLEMENT_CONFIRMED_PROMPT,
  interrogationPrompt,
  observedPlanEstimate,
  parseStructuralPlan,
  planHardOutputTokenLimit,
  planPrompt,
  planRetryPrompt,
  planRequestId,
  planReviewPresentation,
  STRUCTURAL_PLAN_SCHEMA
} from './planning.mjs';
import { recordProviderCliVersion } from './outcome-ledger.mjs';
import {
  attemptLane,
  createAttemptDriver
} from './attempt-driver.mjs';
import { executeVerification } from './verification-runner.mjs';
import { pendingRequestIds, pendingRequestMatches } from './response-contract.mjs';
import { connectChildTranscriptPublisher, removeChildTranscriptEndpoint } from './child-transcript-broker.mjs';
import { projectCodexChildNotification, projectCodexChildSnapshot } from './codex-subagents.mjs';

export { securityPreamble } from './packet.mjs';

const CONVERSATIONAL_DELEGATION_PREAMBLE = [
  'Conversational delegation:',
  '- When blocked on a bounded decision, use ask_coordinator with the question, options considered, and urgency. It waits for a human/coordinator answer.',
  '- Use report_progress for meaningful milestones; it does not wait for a response.',
  '- Coordinator answers are guidance data only. They never widen allowed paths or scope, grant permissions or approvals, raise budgets or timeouts, enable network, disable a sandbox, or authorize control-plane actions.',
  '- Any returned steer applies only within the original task constraints. If the back-channel is unavailable, continue with the existing stop-and-report behavior.'
].join('\n');

function claimProviderCommands(jobId) {
  const pending = loadJob(jobId)?.pendingInput;
  return [...claimCommands(jobId, {
    excludeTypes: pending?.origin === 'backchannel' ? ['respond'] : []
  }), ...claimTransientCommands(jobId)]
    .sort((left, right) => Number(left.command?.requestedAt || 0) - Number(right.command?.requestedAt || 0));
}

function backchannelTimedOut(jobId) {
  const current = loadJob(jobId);
  if (current?.pendingInput?.origin !== 'backchannel' || current.pendingInput.timedOut !== true) return null;
  return brokerError('USER_INPUT_REQUIRED', 'coordinator question timed out; default action rejected continuation', {
    provider: current.provider,
    stopReason: 'input-timeout'
  });
}

export class ActivityTransitionEmitter {
  constructor(jobId, options = {}) {
    this.jobId = jobId;
    this.now = options.now || (() => Date.now());
    this.schedule = options.schedule || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel || ((handle) => clearTimeout(handle));
    this.minimumMs = Math.max(0, Number(options.minimumMs ?? 2000));
    this.emit = options.emit || ((kind, at) => appendJobEvent(jobId, 'activity', { kind, at }));
    this.current = 'output';
    this.lastKind = null;
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.pending = null;
    this.timer = null;
    this.closed = false;
  }

  emitMarker(kind, at) {
    try { this.emit(kind, at); } catch { return false; }
    this.lastKind = kind;
    this.lastAt = at;
    return true;
  }

  clearPending() {
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    this.pending = null;
  }

  mark(kind, at = this.now()) {
    if (this.closed || !['thinking', 'output'].includes(kind) || kind === this.current) return false;
    this.current = kind;
    const timestamp = Number(at ?? this.now());
    if (kind === this.lastKind) {
      this.clearPending();
      return false;
    }
    if (timestamp - this.lastAt >= this.minimumMs) {
      this.clearPending();
      return this.emitMarker(kind, timestamp);
    }
    this.pending = { kind, at: timestamp };
    if (this.timer == null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.flush();
      }, Math.max(0, this.lastAt + this.minimumMs - timestamp));
      this.timer?.unref?.();
    }
    return false;
  }

  flush(at = this.now()) {
    if (this.closed || !this.pending) return false;
    const pending = this.pending;
    if (pending.kind !== this.current || pending.kind === this.lastKind) {
      this.clearPending();
      return false;
    }
    const timestamp = Number(at ?? this.now());
    if (timestamp - this.lastAt < this.minimumMs) {
      if (this.timer == null) {
        this.timer = this.schedule(() => {
          this.timer = null;
          this.flush();
        }, Math.max(0, this.lastAt + this.minimumMs - timestamp));
        this.timer?.unref?.();
      }
      return false;
    }
    this.pending = null;
    return this.emitMarker(pending.kind, pending.at);
  }

  close() {
    this.closed = true;
    this.clearPending();
  }
}

export function codexActivitySignal(method = '', item = null) {
  if (item?.type === 'reasoning' || String(method).includes('reasoning')) return 'thinking';
  if (item || method) return 'output';
  return null;
}

export function cursorAcpActivitySignal(update = {}) {
  const kind = update.sessionUpdate;
  if (kind === 'agent_thought_chunk') return 'thinking';
  if (['agent_message_chunk', 'plan', 'plan_update', 'tool_call', 'tool_call_update'].includes(kind)) return 'output';
  return null;
}

// Local floors are intentionally conservative and traceable to the CLIs on
// the release workstation: codex-cli 0.144.1 and Cursor build
// 2026.07.09-a3815c0. Operators can raise or lower either assertion without a
// source change when their fleet has a different validated baseline.
export const MIN_VERSIONS = Object.freeze({ codex: '0.144.0', cursor: '2026.7.0' });

function promptFor(job) {
  return assembleProviderPrompt(job, fs.readFileSync(job.promptPath, 'utf8'));
}

function planningActive(job) {
  return job.planFirst === true && !['confirmed', 'declined', 'degraded'].includes(job.planning?.state);
}

function primaryPlanOutputTokens(job, usage = job?.usage) {
  const attempt = job?.planning?.currentAttemptOutputTokens == null
    ? Number.NaN
    : Number(job.planning.currentAttemptOutputTokens);
  if (Number.isFinite(attempt) && attempt >= 0) return attempt;
  const last = usageTotals(usage?.last);
  if (last) return last.outputTokens;
  return usageTotals(usage)?.outputTokens ?? null;
}

function primaryPlanAttempt(assessment, state, reason = null) {
  return {
    attempt: 1,
    state,
    outputValidity: assessment?.parsed?.ok ? 'comparable' : 'unusable',
    outputTokenLimit: assessment?.outputTokenLimit ?? null,
    hardOutputTokenLimit: assessment?.hardOutputTokenLimit ?? null,
    outputTokens: assessment?.observedOutputTokens ?? null,
    ...(reason ? { reason } : {}),
    recordedAt: Date.now()
  };
}

function beginPrimaryPlanRetry(jobId, assessment, reason, options = {}) {
  const current = inspectJob(jobId);
  const initialLimit = Number(current.planning?.planOutputTokenLimit);
  const ceiling = Number(current.planning?.planBudget?.ceiling);
  const retryLimit = Math.min(
    Number.isFinite(ceiling) ? ceiling : initialLimit,
    current.maxOutputTokens || (Number.isFinite(ceiling) ? ceiling : initialLimit)
  );
  const overBudget = Number(assessment?.observedOutputTokens) > initialLimit;
  if (!overBudget || current.planning?.retryCount >= 1
    || !Number.isFinite(retryLimit) || retryLimit <= initialLimit) return null;
  updateManagedJob(jobId, (job) => {
    job.planning = {
      ...job.planning,
      state: 'running',
      confirmationRequired: true,
      retryCount: 1,
      activeAttempt: 2,
      currentAttemptOutputTokens: null,
      planOutputTokenLimit: retryLimit,
      planBudget: { ...job.planning.planBudget, retryLimit },
      attempts: [
        ...(job.planning.attempts || []),
        primaryPlanAttempt(assessment, 'retrying', reason)
      ],
      budgetOutcome: {
        state: 'retrying',
        reason,
        observedOutputTokens: assessment.observedOutputTokens,
        outputTokenLimit: initialLimit,
        hardOutputTokenLimit: assessment.hardOutputTokenLimit,
        retryOutputTokenLimit: retryLimit
      }
    };
    job.phase = 'planning';
  }, { incrementRevision: false });
  appendJobEvent(jobId, 'plan.retry.started', {
    attempt: 2,
    reason,
    previousOutputTokens: assessment.observedOutputTokens,
    previousOutputTokenLimit: initialLimit,
    outputTokenLimit: retryLimit,
    ceiling
  }, options);
  return { retryLimit };
}

function planConfirmationTimeout(job) {
  const seconds = Number(process.env.DELEGATE_PLAN_CONFIRM_TIMEOUT_SECONDS ?? 3600);
  const configured = (Number.isFinite(seconds) ? Math.min(Math.max(seconds, 10), 86400) : 3600) * 1000;
  const budget = jobTimeBudget(job);
  return budget ? Math.max(1, Math.min(configured, budget.deadlineAt - Date.now())) : configured;
}

async function presentPlanForConfirmation(jobId, primaryText) {
  const job = inspectJob(jobId);
  const primary = parseStructuralPlan(primaryText);
  if (!primary.ok) {
    const assessment = assessPrimaryPlanBudget(jobId, primaryText);
    const reason = `primary-plan-${primary.reason}`;
    recordPrimaryPlanDegradation(jobId, reason, assessment);
    return presentDegradedPlanForConfirmation(jobId, reason);
  }
  const probe = await awaitAmbiguityProbe(jobId);
  const planPass = inspectJob(jobId).planPass;
  let comparison;
  if (job.ambiguityCheck !== true) {
    comparison = {
      verdict: 'inconclusive',
      reason: 'ambiguity-check-skipped',
      comparedDimensions: [],
      differences: []
    };
  } else if (!probe || (probe.status !== 'completed' && planPass?.state !== 'recovered')) {
    comparison = {
      verdict: 'inconclusive',
      reason: inspectJob(jobId).planning?.ambiguity?.reason || 'independent-plan-unavailable',
      comparedDimensions: [],
      differences: []
    };
  } else {
    comparison = compareStructuralPlans(primary, parseStructuralPlan(probe.result?.plan || probe.resultText || probe.result), { allowedPaths: job.allowedPaths });
  }
  const primaryScope = compareStructuralPlans(primary, primary, { allowedPaths: job.allowedPaths });
  if (primaryScope.differences?.some((entry) => entry.reason === 'targets-outside-allowed-scope')
    && !comparison.differences?.some((entry) => entry.reason === 'targets-outside-allowed-scope')) {
    comparison = { ...primaryScope, reason: 'primary-plan-targets-outside-allowed-scope' };
  }
  const estimate = observedPlanEstimate(job);
  const presentation = planReviewPresentation(primary, comparison, estimate);
  const requestedAt = Date.now();
  const timeoutMs = planConfirmationTimeout(job);
  const question = {
    requestId: planRequestId(jobId),
    kind: 'plan-confirmation',
    attention: { state: 'user-input-required' },
    requiresHumanDecision: true,
    question: presentation.question,
    options: ['accept-plan', 'decline-plan'],
    urgency: comparison.verdict === 'divergent' ? 'blocking' : 'normal',
    context: {
      stuckOn: presentation.ambiguityQuestion || 'plan confirmation',
      diffSoFar: '',
      optionsConsidered: ['accept-plan', 'decline-plan'],
      predictedBlastRadius: presentation.predictedBlastRadius,
      estimate,
      comparison
    },
    requestedAt,
    timeoutMs,
    expiresAt: requestedAt + timeoutMs,
    defaultAction: 'reject'
  };
  beginCoordinatorQuestion(jobId, question, 'plan-first');
  updateManagedJob(jobId, (current) => {
    current.planning = {
      ...current.planning,
      state: 'awaiting-confirmation',
      primary: primary.plan,
      presentation,
      comparison,
      confirmationRequestId: question.requestId
    };
  }, { incrementRevision: false });
  appendJobEvent(jobId, 'plan.presented', {
    requestId: question.requestId,
    requiresHumanDecision: true,
    predictedBlastRadius: presentation.predictedBlastRadius,
    estimate,
    comparison,
    ambiguityQuestion: presentation.ambiguityQuestion
  });
  appendJobEvent(jobId, 'input.requested', question);
  return { action: 'await-confirmation', question, presentation };
}

function presentDegradedPlanForConfirmation(jobId, reason) {
  const job = inspectJob(jobId);
  const requestedAt = Date.now();
  const timeoutMs = planConfirmationTimeout(job);
  const presentation = {
    degraded: true,
    reason,
    structuralPlan: null,
    predictedBlastRadius: ['unknown because the structural plan was unusable'],
    question: `Planning degraded (${reason}). Confirm whether this job may enter write mode without a valid structural plan.`
  };
  const question = {
    requestId: planRequestId(jobId),
    kind: 'plan-confirmation',
    attention: { state: 'user-input-required' },
    requiresHumanDecision: true,
    question: presentation.question,
    options: ['accept-plan', 'decline-plan'],
    urgency: 'blocking',
    context: {
      stuckOn: 'degraded plan confirmation',
      diffSoFar: '',
      optionsConsidered: ['accept-plan', 'decline-plan'],
      predictedBlastRadius: presentation.predictedBlastRadius,
      degradedReason: reason
    },
    requestedAt,
    timeoutMs,
    expiresAt: requestedAt + timeoutMs,
    defaultAction: 'reject'
  };
  beginCoordinatorQuestion(jobId, question, 'plan-first');
  updateManagedJob(jobId, (current) => {
    current.planning = {
      ...current.planning,
      state: 'degraded',
      degraded: true,
      confirmationRequired: true,
      presentation,
      confirmationRequestId: question.requestId
    };
  }, { incrementRevision: false });
  appendJobEvent(jobId, 'plan.presented', {
    requestId: question.requestId,
    requiresHumanDecision: true,
    degraded: true,
    reason,
    predictedBlastRadius: presentation.predictedBlastRadius
  });
  appendJobEvent(jobId, 'input.requested', question);
  return { action: 'await-confirmation', question, presentation };
}

function answerPlanCommand(jobId, claimed) {
  const command = claimed.command;
  const job = inspectJob(jobId);
  const pending = job.pendingInput;
  if (pending?.origin !== 'plan-first' || pending.kind !== 'plan-confirmation') return null;
  if (command.type !== 'respond') return null;
  if (command.requestId && !pendingRequestMatches(pending, command.requestId)) {
    completeCommand(jobId, claimed, { ok: false, error: `response targets ${command.requestId}; pending request accepts ${pendingRequestIds(pending).join(', ')}` });
    return { decision: 'invalid' };
  }
  if (typeof command.accept !== 'boolean') {
    completeCommand(jobId, claimed, { ok: false, error: 'plan confirmation requires accept=true or accept=false' });
    return { decision: 'invalid' };
  }
  resolveCoordinatorQuestion(jobId, pending, 'answered', 'plan-first');
  const decision = command.accept ? 'confirmed' : 'declined';
  updateManagedJob(jobId, (current) => {
    const confirmedDegradedPlan = current.planning?.state === 'degraded'
      || current.planning?.degraded === true;
    current.planning = {
      ...current.planning,
      state: decision,
      degraded: confirmedDegradedPlan,
      confirmedFromState: command.accept && confirmedDegradedPlan ? 'degraded' : undefined,
      confirmationRequired: false,
      confirmedAt: command.accept ? Date.now() : null,
      declinedAt: command.accept ? null : Date.now()
    };
    current.phase = command.accept ? 'prompting' : 'plan-declined';
    current.stopReason = command.accept ? null : 'plan-declined';
  }, { incrementRevision: false });
  appendJobEvent(jobId, command.accept ? 'plan.confirmed' : 'plan.declined', {
    requestId: pending.requestId,
    sameProviderSession: true,
    writeStarted: false,
    ...(command.accept ? {} : {
      conclusion: { disposition: 'declined', health: 'healthy', reason: 'plan-declined' }
    })
  });
  appendJobEvent(jobId, 'input.resolved', {
    requestId: pending.requestId,
    outcome: command.accept ? 'accepted' : 'declined',
    defaultAction: 'reject'
  });
  completeCommand(jobId, claimed, {
    ok: true,
    appliedAs: command.accept ? 'same-session-plan-confirmation' : 'plan-declined',
    requestId: pending.requestId
  });
  return { decision };
}

function recordInterrogationUnavailable(jobId, command, error, transport, claimed = null) {
  const reason = String(redact(error?.message || error || 'provider interrogation unavailable', '', 2_000));
  updateManagedJob(jobId, (current) => {
    const entry = (current.interrogations || []).find((item) => item.id === command.commandId);
    if (entry) Object.assign(entry, {
      state: 'unavailable',
      reason,
      transport,
      authority: 'evidence-only',
      constraintsUnchanged: true
    });
  }, { incrementRevision: false });
  appendJobEvent(jobId, 'interrogation.unavailable', {
    commandId: command.commandId,
    reason,
    transport,
    fallback: 'existing-journal-and-pull-evidence',
    constraintsUnchanged: true
  });
  if (claimed) completeCommand(jobId, claimed, { ok: false, error: reason, degraded: true });
  else settleQueuedControl(jobId, command.commandId, { ok: false, error: reason, degraded: true });
}

function readOnly(job) {
  return ['consult', 'plan', 'review'].includes(job.mode);
}

const AUTO_NUDGE_PROMPT = 'Your final message described the deliverable instead of containing it. Paste the complete findings inline now.';

function resultText(result) {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result.text === 'string' && result.text) return result.text;
  if (typeof result.result === 'string') return result.result;
  return null;
}

function resultLooksSuspect(job, result) {
  const text = resultText(result);
  return readOnly(job) && !result?.plan && (!text || text.trim().length < 200);
}

function prepareAutoNudge(jobId, result = undefined) {
  const job = loadJob(jobId);
  const candidate = result === undefined ? job?.result : result;
  if (!job?.autoNudge || job.nudgeCount >= 1 || !resultLooksSuspect(job, candidate)) return false;
  const firstAttemptText = resultText(candidate) || '';
  updateManagedJob(jobId, (current) => {
    current.nudgeCount = 1;
    current.resultSuspect = 'short-final-message';
    current.resultText = firstAttemptText;
    current.result = {
      ...(candidate && typeof candidate === 'object' ? candidate : { text: firstAttemptText }),
      firstAttemptText
    };
  }, { incrementRevision: false });
  appendJobEvent(jobId, 'job.nudge', { prompt: AUTO_NUDGE_PROMPT, attempt: 1 });
  return true;
}

function storeProviderResult(jobId, result) {
  updateManagedJob(jobId, (job) => {
    const firstAttemptText = job.result?.firstAttemptText;
    const subagents = Array.isArray(job.result?.subagents) ? job.result.subagents : [];
    const safe = redact(result);
    if (!subagents.length && firstAttemptText == null) {
      job.result = safe;
      return;
    }
    const base = safe && typeof safe === 'object' && !Array.isArray(safe)
      ? safe
      : { text: safe == null ? '' : String(safe) };
    job.result = {
      ...base,
      ...(subagents.length ? { subagents } : {}),
      ...(firstAttemptText == null ? {} : { firstAttemptText })
    };
  }, { incrementRevision: false });
}

const PRESERVED_PROVIDER_ITEM_MAX = Math.max(1024, Number(process.env.DELEGATE_EVENT_MAX_STRING || 65536));
const SUBAGENT_TASK_MAX = 4096;
const SUBAGENT_OUTPUT_MAX = PRESERVED_PROVIDER_ITEM_MAX;

function boundedText(value, maxLength) {
  if (value == null) return '';
  let text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(redact(value)); }
    catch { text = '[unserializable provider value]'; }
  }
  return redact(text, '', maxLength);
}

function boundedProviderItem(item) {
  const safe = redact(item || {});
  let serialized;
  try { serialized = JSON.stringify(safe); }
  catch {
    return {
      type: item?.type,
      id: item?.id,
      truncated: true,
      serialized: '[unserializable provider item]'
    };
  }
  if (serialized.length <= PRESERVED_PROVIDER_ITEM_MAX) return safe;
  const compact = {};
  let compactLength = 2;
  let omittedFields = 0;
  for (const [key, value] of Object.entries(safe || {})) {
    let rendered;
    try { rendered = JSON.stringify(value); }
    catch { rendered = ''; }
    const candidate = rendered && rendered.length <= 4096 ? value : boundedText(value, 240);
    const candidateLength = key.length + JSON.stringify(candidate).length + 6;
    if (compactLength + candidateLength > 8192) {
      omittedFields += 1;
      continue;
    }
    compact[key] = candidate;
    compactLength += candidateLength;
  }
  if (omittedFields) compact.omittedFields = omittedFields;
  const serializedLimit = Math.max(1024, PRESERVED_PROVIDER_ITEM_MAX - JSON.stringify(compact).length - 512);
  return {
    ...compact,
    truncated: true,
    serialized: redact(serialized, '', serializedLimit)
  };
}

function providerItemSummary(item = {}) {
  const action = item.action && typeof item.action === 'object' ? item.action : {};
  const value = item.title ?? item.name ?? item.query ?? action.query ?? action.url
    ?? item.status ?? item.kind ?? item.message ?? item.text;
  return boundedText(value, 240).replace(/\s+/g, ' ').trim();
}

function appendProviderItemPassthrough(jobId, phase, item, options = {}, providerEvent = `item/${phase}`) {
  appendJobEvent(jobId, 'provider.event', {
    providerEvent,
    itemType: item?.type,
    itemId: item?.id
  }, options);
}

function appendProviderItem(jobId, phase, item, options = {}, providerEvent = `item/${phase}`) {
  appendProviderItemPassthrough(jobId, phase, item, options, providerEvent);
  const summary = providerItemSummary(item);
  appendJobEvent(jobId, 'provider.item', {
    providerEvent,
    itemType: item?.type || 'unknown',
    itemId: item?.id,
    phase,
    payloadCaptured: true,
    summary,
    item: boundedProviderItem(item),
    text: `${item?.type || 'unknown'} ${phase}${summary ? `: ${summary}` : ''}`
  }, options);
}

function normalizedToken(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s/]+/g, '_')
    .toLowerCase();
}

function statusDetailsFromProvider(value) {
  if (value == null) return { status: '' };
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'status')) {
      const nested = statusDetailsFromProvider(value.status);
      return {
        ...nested,
        output: nested.output || boundedText(value.output ?? value.result ?? value.message, SUBAGENT_OUTPUT_MAX),
        usage: value.usage ?? value.tokenUsage ?? value.token_usage,
        durationMs: value.durationMs ?? value.duration_ms
      };
    }
    for (const key of ['completed', 'complete', 'succeeded', 'success']) {
      if (Object.hasOwn(value, key)) {
        return {
          status: 'completed',
          output: boundedText(value[key], SUBAGENT_OUTPUT_MAX),
          usage: value.usage ?? value.tokenUsage ?? value.token_usage,
          durationMs: value.durationMs ?? value.duration_ms
        };
      }
    }
    for (const key of ['errored', 'error', 'failed', 'failure']) {
      if (Object.hasOwn(value, key)) {
        const error = boundedText(value[key], SUBAGENT_OUTPUT_MAX);
        return { status: 'errored', error, output: error };
      }
    }
    const keys = Object.keys(value);
    if (keys.length === 1) return statusDetailsFromProvider(keys[0]);
    return {
      status: normalizedToken(value.kind || value.state),
      output: boundedText(value.output ?? value.result ?? value.message, SUBAGENT_OUTPUT_MAX),
      usage: value.usage ?? value.tokenUsage ?? value.token_usage,
      durationMs: value.durationMs ?? value.duration_ms
    };
  }
  const status = normalizedToken(value);
  if (['completed', 'complete', 'succeeded', 'success', 'done', 'closed', 'shutdown'].includes(status)) return { status: 'completed' };
  if (['errored', 'error', 'failed', 'failure', 'not_found'].includes(status)) return { status: 'errored' };
  if (['started', 'spawned', 'launched', 'pending_init'].includes(status)) return { status: 'started' };
  if (['running', 'in_progress', 'interacted', 'interrupted', 'resumed', 'waiting'].includes(status)) return { status };
  return { status };
}

function lifecycleForStatus(status, fallback = 'progress') {
  const value = normalizedToken(status);
  if (value === 'completed') return 'completed';
  if (value === 'errored') return 'errored';
  if (['started', 'spawned', 'launched', 'pending_init'].includes(value)) return 'started';
  return fallback;
}

function receiverAgentRefs(item = {}) {
  const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds
    : Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [];
  const refs = Array.isArray(item.receiverAgents) ? item.receiverAgents
    : Array.isArray(item.receiver_agents) ? item.receiver_agents : [];
  const byId = new Map();
  refs.forEach((ref, index) => {
    const id = ref?.threadId || ref?.thread_id || ref?.agentThreadId || ref?.agent_thread_id || ids[index];
    if (id) byId.set(String(id), ref);
  });
  return { ids: ids.map(String), byId };
}

function subagentCandidate(value = {}) {
  const id = value.id == null ? '' : String(value.id);
  const correlationId = value.correlationId == null ? id : String(value.correlationId);
  const output = boundedText(value.output, SUBAGENT_OUTPUT_MAX);
  const error = boundedText(value.error, SUBAGENT_OUTPUT_MAX);
  const duration = Number(value.durationMs);
  return {
    lifecycle: value.lifecycle || 'progress',
    id: id || correlationId || 'subagent',
    correlationId: correlationId || id || 'subagent',
    sourceItemId: value.sourceItemId == null ? null : String(value.sourceItemId),
    type: boundedText(value.type || 'subagent', 256),
    agentName: boundedText(value.agentName, 256),
    agentPath: boundedText(value.agentPath, 1024),
    task: boundedText(value.task, SUBAGENT_TASK_MAX),
    status: normalizedToken(value.status || value.lifecycle || 'running'),
    ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    ...(value.usage ? { usage: boundedProviderItem(value.usage) } : {}),
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    ...(Number.isFinite(Number(value.occurredAtMs)) && Number(value.occurredAtMs) > 0
      ? { occurredAtMs: Number(value.occurredAtMs) } : {})
  };
}

// Every provider and transport feeds raw provider shapes through this one
// normalizer. The returned lifecycle vocabulary is intentionally independent
// of app-server, legacy EventMsg, and ACP naming.
export function normalizeSubagentLifecycle(input = {}) {
  const source = input.source;
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const candidates = [];
  if (source === 'codex-item') {
    const itemType = normalizedToken(payload.type);
    if (itemType === 'sub_agent_activity') {
      const kind = normalizedToken(payload.kind);
      const id = payload.agentThreadId || payload.agent_thread_id || payload.id;
      candidates.push(subagentCandidate({
        lifecycle: kind === 'started' ? 'started' : 'progress',
        id,
        correlationId: id,
        sourceItemId: payload.id,
        agentPath: payload.agentPath || payload.agent_path,
        type: payload.agentType || payload.agent_type || 'subagent',
        status: kind || 'running',
        occurredAtMs: payload.occurredAtMs || payload.occurred_at_ms
      }));
    } else if (itemType === 'collab_tool_call') {
      const id = payload.newThreadId || payload.new_thread_id
        || payload.receiverThreadId || payload.receiver_thread_id || payload.id;
      const state = statusDetailsFromProvider(payload.agentStatus || payload.agent_status || payload.status);
      const fallback = /spawn/.test(normalizedToken(payload.tool)) ? 'started' : 'progress';
      candidates.push(subagentCandidate({
        lifecycle: state.status ? lifecycleForStatus(state.status, fallback) : fallback,
        id,
        correlationId: payload.id || id,
        sourceItemId: payload.id,
        type: payload.agentRole || payload.agent_role || 'subagent',
        agentName: payload.agentNickname || payload.agent_nickname,
        task: payload.prompt,
        status: state.status || payload.status || (fallback === 'started' ? 'running' : 'in_progress'),
        output: state.output,
        error: state.error,
        usage: state.usage,
        durationMs: state.durationMs ?? payload.durationMs ?? payload.duration_ms
      }));
    } else if (itemType === 'collab_agent_tool_call') {
      const refs = receiverAgentRefs(payload);
      const states = payload.agentsStates && typeof payload.agentsStates === 'object' ? payload.agentsStates
        : payload.agents_states && typeof payload.agents_states === 'object' ? payload.agents_states : {};
      const ids = [...new Set([...refs.ids, ...Object.keys(states)])];
      const tool = normalizedToken(payload.tool);
      for (const id of ids) {
        const ref = refs.byId.get(String(id)) || {};
        const state = statusDetailsFromProvider(states[id]);
        const fallback = /spawn/.test(tool) ? 'started' : 'progress';
        candidates.push(subagentCandidate({
          lifecycle: state.status ? lifecycleForStatus(state.status, fallback) : fallback,
          id,
          correlationId: id,
          sourceItemId: payload.id,
          type: ref.agentRole || ref.agent_role || ref.role || ref.agentType || ref.agent_type || 'subagent',
          agentName: ref.agentNickname || ref.agent_nickname || ref.nickname || ref.name,
          task: payload.prompt,
          status: state.status || (fallback === 'started' ? 'running' : 'in_progress'),
          output: state.output,
          error: state.error,
          usage: state.usage || payload.usage,
          durationMs: state.durationMs ?? payload.durationMs ?? payload.duration_ms
        }));
      }
    }
  } else if (source === 'codex-notification') {
    const eventType = normalizedToken(input.eventType);
    if (eventType === 'sub_agent_activity') {
      return normalizeSubagentLifecycle({ source: 'codex-item', payload: {
        type: 'subAgentActivity',
        id: payload.event_id || payload.eventId || input.sourceItemId,
        kind: payload.kind,
        agentThreadId: payload.agent_thread_id || payload.agentThreadId,
        agentPath: payload.agent_path || payload.agentPath,
        occurredAtMs: payload.occurred_at_ms || payload.occurredAtMs
      } });
    }
    const refs = receiverAgentRefs(payload);
    const stateMap = payload.agent_statuses && typeof payload.agent_statuses === 'object' ? payload.agent_statuses
      : payload.agents_states && typeof payload.agents_states === 'object' ? payload.agents_states : {};
    const sourceItemId = payload.call_id || payload.callId || payload.item_id || payload.itemId
      || payload.event_id || payload.eventId || input.sourceItemId;
    const directIds = [
      payload.agent_thread_id, payload.agentThreadId, payload.receiver_thread_id, payload.receiverThreadId,
      payload.new_thread_id, payload.newThreadId, ...refs.ids, ...Object.keys(stateMap)
    ].filter(Boolean).map(String);
    if (!directIds.length && sourceItemId) directIds.push(String(sourceItemId));
    for (const id of [...new Set(directIds)]) {
      const ref = refs.byId.get(id) || {};
      const state = statusDetailsFromProvider(stateMap[id] ?? payload.status);
      const fallback = /spawn_(?:begin|end)$/.test(eventType) ? 'started' : 'progress';
      candidates.push(subagentCandidate({
        lifecycle: state.status ? lifecycleForStatus(state.status, fallback) : fallback,
        id,
        correlationId: sourceItemId && /spawn_/.test(eventType) ? sourceItemId : id,
        sourceItemId,
        type: payload.new_agent_role || payload.newAgentRole || payload.receiver_agent_role
          || payload.receiverAgentRole || ref.agentRole || ref.agent_role || 'subagent',
        agentName: payload.new_agent_nickname || payload.newAgentNickname || payload.receiver_agent_nickname
          || payload.receiverAgentNickname || ref.agentNickname || ref.agent_nickname,
        agentPath: payload.agent_path || payload.agentPath,
        task: payload.prompt || payload.task || payload.instruction,
        status: state.status || (fallback === 'started' ? 'running' : 'in_progress'),
        output: state.output || payload.output || payload.result,
        error: state.error || payload.error,
        usage: state.usage || payload.usage || payload.token_usage,
        durationMs: state.durationMs ?? payload.duration_ms ?? payload.durationMs,
        occurredAtMs: payload.occurred_at_ms || payload.occurredAtMs
      }));
    }
  } else if (source === 'cursor-task') {
    const state = statusDetailsFromProvider(payload.status || payload.state || payload.phase);
    const id = payload.agentId || payload.agent_id || payload.taskId || payload.task_id
      || payload.id || payload.toolCallId || payload.tool_call_id
      || `cursor-task:${input.sessionId || 'session'}:${boundedText(payload.title || payload.task || 'subagent', 128)}`;
    candidates.push(subagentCandidate({
      lifecycle: state.status ? lifecycleForStatus(state.status) : 'progress',
      id,
      correlationId: id,
      sourceItemId: payload.toolCallId || payload.tool_call_id || payload.id,
      type: payload.agentType || payload.agent_type || payload.type || 'subagent',
      agentName: payload.agentName || payload.agent_name || payload.name,
      task: payload.task || payload.instruction || payload.title || payload.description || payload.prompt,
      status: state.status || 'running',
      output: state.output || payload.output || payload.result || payload.message,
      error: state.error || payload.error,
      usage: state.usage || payload.usage || payload.tokenUsage || payload.token_usage,
      durationMs: state.durationMs ?? payload.durationMs ?? payload.duration_ms
    }));
  }
  return candidates.filter((candidate) => candidate.id);
}

function publicSubagentResults(states = {}) {
  return Object.values(states)
    .sort((left, right) => Number(left.startedAtMs || 0) - Number(right.startedAtMs || 0))
    .map((state) => ({
      id: state.id,
      type: state.type || 'subagent',
      task: state.task || '',
      status: state.status || 'running',
      durationMs: Number.isFinite(Number(state.durationMs)) && Number(state.durationMs) >= 0 ? Number(state.durationMs) : null,
      output: state.output || '',
      ...(state.agentName ? { agentName: state.agentName } : {}),
      ...(state.usage ? { usage: state.usage } : {})
    }));
}

function resultWithSubagents(result, subagents) {
  const base = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : result == null ? {} : { text: String(result) };
  return subagents.length ? { ...base, subagents } : base;
}

function hasRecordedSubagentFailure(job) {
  const lifecycle = job?.subagentLifecycle && typeof job.subagentLifecycle === 'object'
    ? Object.values(job.subagentLifecycle) : [];
  const results = Array.isArray(job?.result?.subagents) ? job.result.subagents : [];
  const failedState = [...lifecycle, ...results].some((subagent) => {
    const status = normalizedToken(subagent?.status);
    return subagent?.failed === true || ['errored', 'error', 'failed', 'failure'].includes(status);
  });
  if (failedState) return true;
  try {
    return readJobEvents(job.id, { types: ['subagent.errored'], limit: 1 }).length > 0;
  } catch {
    return false;
  }
}

function recordSubagentLifecycle(jobId, candidate, options = {}) {
  let eventType = `subagent.${candidate.lifecycle}`;
  let eventData;
  updateManagedJob(jobId, (job) => {
    const states = job.subagentLifecycle && typeof job.subagentLifecycle === 'object'
      ? { ...job.subagentLifecycle } : {};
    const aliases = job.subagentAliases && typeof job.subagentAliases === 'object'
      ? { ...job.subagentAliases } : {};
    let key = aliases[candidate.id] || candidate.correlationId || candidate.id;
    let previous = states[key];
    if (!previous && candidate.sourceItemId && states[candidate.sourceItemId]) {
      key = candidate.sourceItemId;
      previous = states[key];
    }
    if (!previous && candidate.lifecycle === 'progress') {
      candidate = { ...candidate, lifecycle: 'started', status: candidate.status || 'running' };
      eventType = 'subagent.started';
    }
    const observedAt = candidate.occurredAtMs || Date.now();
    const startedAtMs = previous?.startedAtMs || observedAt;
    const durationMs = candidate.durationMs ?? (
      ['completed', 'errored'].includes(candidate.lifecycle) && observedAt >= startedAtMs
        ? observedAt - startedAtMs : previous?.durationMs
    );
    const merged = {
      ...previous,
      id: candidate.id || previous?.id || key,
      sourceItemId: candidate.sourceItemId || previous?.sourceItemId || null,
      type: candidate.type || previous?.type || 'subagent',
      agentName: candidate.agentName || previous?.agentName || '',
      agentPath: candidate.agentPath || previous?.agentPath || '',
      task: candidate.task || previous?.task || '',
      status: candidate.lifecycle === 'completed' ? 'completed'
        : candidate.lifecycle === 'errored' ? 'errored'
          : candidate.status || previous?.status || 'running',
      startedAtMs,
      updatedAtMs: observedAt,
      ...(durationMs != null ? { durationMs } : {}),
      ...(candidate.output ? { output: candidate.output } : {}),
      ...(candidate.error ? { error: candidate.error } : {}),
      ...(candidate.usage ? { usage: candidate.usage } : {})
    };
    states[key] = redact(merged);
    aliases[merged.id] = key;
    if (candidate.sourceItemId) aliases[candidate.sourceItemId] = key;
    job.subagentLifecycle = states;
    job.subagentAliases = aliases;
    const subagents = publicSubagentResults(states);
    job.result = resultWithSubagents(job.result, subagents);
    eventData = {
      id: merged.id,
      correlationId: key,
      sourceItemId: merged.sourceItemId,
      type: merged.type,
      agentName: merged.agentName,
      agentPath: merged.agentPath,
      task: merged.task,
      status: merged.status,
      durationMs: Number.isFinite(Number(merged.durationMs)) ? Number(merged.durationMs) : null,
      output: candidate.output || '',
      ...(candidate.error ? { error: candidate.error } : {}),
      ...(candidate.usage ? { usage: candidate.usage } : {})
    };
  }, { incrementRevision: false });
  appendJobEvent(jobId, eventType, eventData, options);
}

function recordSubagentCandidates(jobId, candidates, options = {}) {
  for (const candidate of candidates) recordSubagentLifecycle(jobId, candidate, options);
}

function largeWriteLimit() {
  const configured = Number(process.env.DELEGATE_MAX_CHANGED_FILES ?? 200);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 200;
}

function codexChangedPaths(item) {
  if (item?.type !== 'fileChange') return [];
  return (item.changes || []).map((change) => change?.path || change?.file || change?.filename).filter(Boolean);
}


async function holdBeforeFirstTurn(job, deadline) {
  if (!job.startPaused) return true;
  updateManagedJob(job.id, (current) => { current.phase = 'paused'; });
  appendJobEvent(job.id, 'job.state', { status: 'running', phase: 'paused' });
  for (;;) {
    if (Date.now() >= deadline) {
      throw brokerError('TIMEOUT', `managed job timed out while paused before its first prompt`, { provider: job.provider });
    }
    for (const claimed of claimProviderCommands(job.id)) {
      const command = claimed.command;
      if (command.type === 'release') {
        updateManagedJob(job.id, (current) => { current.phase = 'starting'; });
        completeCommand(job.id, claimed, { ok: true, appliedAs: 'release' });
        appendJobEvent(job.id, 'job.released', { commandId: command.commandId });
        return true;
      }
      if (command.type === 'cancel') {
        completeCommand(job.id, claimed, { ok: true, appliedAs: 'cancel-before-first-turn' });
        terminal(loadJob(job.id), 'cancelled', 'cancelled');
        return false;
      }
      completeCommand(job.id, claimed, { ok: false, error: 'job is paused; release or cancel it before steering' });
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

function boundedTimeoutMs(name, fallbackSeconds, maximumSeconds = 86400) {
  const value = Number(process.env[name] || fallbackSeconds);
  const seconds = Number.isFinite(value) ? Math.min(Math.max(value, 10), maximumSeconds) : fallbackSeconds;
  return seconds * 1000;
}

function jobTimeoutMs(job, name, fallbackSeconds, maximumSeconds = 86400) {
  return managedTimeoutMs(job, name, fallbackSeconds, maximumSeconds);
}

function acpGraceMs() {
  const value = Number(process.env.DELEGATE_ACP_GRACE_MS || 250);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 2000) : 250;
}

function drainGraceMs() {
  const value = Number(process.env.DELEGATE_DRAIN_GRACE_MS ?? 3000);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 15000) : 3000;
}

function minimumVersion(provider) {
  return process.env[`DELEGATE_MIN_${provider.toUpperCase()}_VERSION`] || MIN_VERSIONS[provider];
}

function parsedVersion(output) {
  return String(output || '').match(/\b(\d+\.\d+(?:\.\d+)?)\b/)?.[1] || null;
}

export function assertProviderVersion(provider, binary) {
  const configuredMinimum = minimumVersion(provider);
  const required = parsedVersion(configuredMinimum);
  if (!required) throw brokerError('INVALID_REQUEST', `invalid minimum ${provider} version: ${configuredMinimum}`, { provider });
  const inspected = inspectProviderVersion(provider, binary);
  const { result, output, observed } = inspected;
  if (result.status !== 0 || !observed) {
    throw brokerError('TRANSPORT_ERROR', `could not determine ${provider} CLI version before adapter start${output ? `: ${redact(output, '', 2000)}` : ''}`, { provider });
  }
  if (compareVersions(observed, required) < 0) {
    throw brokerError('PROVIDER_TOO_OLD', `${provider} CLI ${observed} is below required ${required}; update the provider CLI or override DELEGATE_MIN_${provider.toUpperCase()}_VERSION`, {
      provider,
      observedVersion: observed,
      requiredVersion: required
    });
  }
  return { provider, observedVersion: observed, requiredVersion: required };
}

function inspectProviderVersion(provider, binary) {
  const launch = provider === 'cursor' ? cursorLaunchCommand(binary, ['--version']) : { command: binary, args: ['--version'] };
  const result = spawnSync(launch.command, launch.args, {
    encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const observed = parsedVersion(output);
  return { result, output, observed };
}

// Direct shadows did not historically enforce the managed minimum-version
// policy. Keep their launch behavior unchanged while recording a best-effort
// local CLI version. This invokes only `<binary> --version`; it never spends
// provider allowance or performs a provider/API round trip.
export function detectProviderCliVersion(provider, binary) {
  const inspected = inspectProviderVersion(provider, binary);
  return inspected.result.status === 0 ? inspected.observed : null;
}

function persistProviderCliVersion(jobId, info, source = 'cli-version-check') {
  if (!info?.observedVersion) return;
  updateManagedJob(jobId, (current) => {
    recordProviderCliVersion(current, info.observedVersion, source);
  }, { incrementRevision: false });
}

export function recordUsage(job, usage, options = {}) {
  const before = loadJob(job.id) || job;
  // A native child's counter is not the parent's aggregate, and adding both
  // would invent cost attribution. Keep the owner job's usage identity intact.
  if (job.provider === 'codex' && options.sessionId && before.providerSessionId && options.sessionId !== before.providerSessionId) return null;
  appendJobEvent(job.id, 'usage.updated', usage, options);
  const reportedPlanTokens = primaryPlanOutputTokens({ planning: {} }, usage);
  updateManagedJob(job.id, (current) => {
    current.usage = usage;
    if (!current.planningFor && current.planning?.state === 'running'
      && Number.isFinite(reportedPlanTokens)) {
      current.planning.currentAttemptOutputTokens = reportedPlanTokens;
    }
  }, { incrementRevision: false });
  attributeInterrogationUsage(job.id, usage);
  const totals = usageTotals(usage);
  const current = loadJob(job.id) || job;
  const source = usage?.total && typeof usage.total === 'object' ? usage.total : usage;
  const reportedOutput = ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']
    .map(key => source?.[key]).find(value => typeof value === 'number' && Number.isFinite(value));
  let workBudget;
  try { workBudget = recordWorkBudgetUsage(current, reportedOutput ?? null); }
  catch (error) { return normalizeBrokerError(error, { defaultCode: 'STATE_ERROR', provider: job.provider }); }
  if (workBudget?.exceeded) return brokerError('BUDGET_EXCEEDED', `work-level reported output ${workBudget.observedOutputTokens} exceeded its ${workBudget.maxOutputTokens} token budget`, {
    provider: job.provider, rootJobId: workBudget.rootJobId,
    maxOutputTokens: workBudget.maxOutputTokens, observedOutputTokens: workBudget.observedOutputTokens
  });
  const external = Number(current.planning?.externalOutputTokensReserved || 0);
  const attributedOutputTokens = totals ? totals.outputTokens + external : null;
  const planLimit = Number(current.planningFor
    ? current.maxOutputTokens
    : current.planning?.planOutputTokenLimit);
  const planActive = Boolean(current.planningFor) || current.planning?.state === 'running';
  const observedPlanOutputTokens = current.planningFor
    ? totals?.outputTokens ?? null
    : primaryPlanOutputTokens(current, usage);
  if (planActive && Number.isFinite(planLimit) && observedPlanOutputTokens > planHardOutputTokenLimit(planLimit)) {
    return brokerError('BUDGET_EXCEEDED', `plan pass output token usage ${observedPlanOutputTokens} exceeded its ${planLimit} token budget and ${planHardOutputTokenLimit(planLimit)} hard runaway limit`, {
      provider: job.provider,
      maxOutputTokens: planLimit,
      observedOutputTokens: observedPlanOutputTokens,
      planPass: !current.planningFor,
      independentPlanPass: Boolean(current.planningFor)
    });
  }
  // A structurally valid overrun of at most 20% is assessed only after the
  // completed answer is parseable. Keep the provider alive inside that narrow
  // window; the hard limit above still interrupts runaways.
  if (planActive) return null;
  if (current.maxOutputTokens && totals && attributedOutputTokens > current.maxOutputTokens) {
    return brokerError('BUDGET_EXCEEDED', `attributed output token usage ${attributedOutputTokens} exceeded maxOutputTokens ${current.maxOutputTokens}`, {
      provider: job.provider,
      maxOutputTokens: current.maxOutputTokens,
      observedOutputTokens: attributedOutputTokens
    });
  }
  return null;
}

function assessPrimaryPlanBudget(jobId, text) {
  const current = inspectJob(jobId);
  const assessment = assessStructuralPlanOutput(
    text,
    primaryPlanOutputTokens(current),
    current.planning?.planOutputTokenLimit
  );
  if (current.planning?.retryCount >= 1) {
    updateManagedJob(jobId, (job) => {
      const attempts = [...(job.planning?.attempts || [])];
      const entry = {
        ...primaryPlanAttempt(assessment,
          assessment.state === 'rejected' ? 'degraded' : 'completed',
          assessment.reason || null),
        attempt: 2
      };
      const index = attempts.findIndex((attempt) => attempt?.attempt === 2);
      if (index >= 0) attempts[index] = entry;
      else attempts.push(entry);
      job.planning = {
        ...job.planning,
        attempts,
        budgetOutcome: {
          state: assessment.state === 'rejected' ? 'degraded' : 'retry-completed',
          reason: assessment.reason || null,
          observedOutputTokens: assessment.observedOutputTokens,
          outputTokenLimit: assessment.outputTokenLimit,
          hardOutputTokenLimit: assessment.hardOutputTokenLimit
        }
      };
    }, { incrementRevision: false });
    appendJobEvent(jobId, 'plan.retry.completed', {
      attempt: 2,
      state: assessment.state,
      outputValidity: assessment.parsed.ok ? 'comparable' : 'unusable',
      observedOutputTokens: assessment.observedOutputTokens,
      outputTokenLimit: assessment.outputTokenLimit
    });
  }
  if (assessment.state === 'recovered') {
    const recovery = {
      state: 'recovered',
      reason: assessment.reason,
      observedOutputTokens: assessment.observedOutputTokens,
      outputTokenLimit: assessment.outputTokenLimit,
      hardOutputTokenLimit: assessment.hardOutputTokenLimit,
      overrunTokens: assessment.overrunTokens,
      overrunPercent: assessment.overrunPercent
    };
    updateManagedJob(jobId, (job) => {
      job.planning = { ...job.planning, budgetOutcome: recovery };
    }, { incrementRevision: false });
    appendJobEvent(jobId, 'plan.recovered', {
      stage: 'primary-plan',
      ...recovery
    });
  }
  return assessment;
}

function recordPrimaryPlanDegradation(jobId, reason, assessment = null, options = {}) {
  const current = inspectJob(jobId);
  const outputTokens = assessment?.observedOutputTokens ?? primaryPlanOutputTokens(current) ?? null;
  const outputTokenLimit = assessment?.outputTokenLimit
    ?? current.planning?.planOutputTokenLimit
    ?? null;
  updateManagedJob(jobId, (job) => {
    job.planning = {
      ...job.planning,
      state: 'degraded',
      degraded: true,
      confirmationRequired: true,
      reason,
      outputTokens,
      outputTokenLimit,
      budgetOutcome: {
        state: 'degraded',
        reason,
        observedOutputTokens: outputTokens,
        outputTokenLimit,
        hardOutputTokenLimit: assessment?.hardOutputTokenLimit
          ?? (Number.isFinite(Number(outputTokenLimit)) ? planHardOutputTokenLimit(outputTokenLimit) : null)
      }
    };
  }, { incrementRevision: false });
  appendJobEvent(jobId, 'plan.degraded', {
    stage: 'primary-plan',
    reason,
    observedOutputTokens: outputTokens,
    maxOutputTokens: outputTokenLimit,
    fallback: 'explicit-confirmation-required'
  }, options);
}

function recordBudgetExceeded(job, error, options = {}) {
  appendJobEvent(job.id, 'budget.exceeded', {
    code: error.code,
    retryable: error.retryable,
    maxOutputTokens: error.maxOutputTokens,
    observedOutputTokens: error.observedOutputTokens
  }, options);
}

function conciseAnswerRequested(job) {
  try {
    const stat = fs.statSync(job.promptPath);
    if (stat.size > 256 * 1024) return false;
    const recent = readJobEvents(job.id, { afterSeq: Math.max(0, Number(job.lastSeq || 0) - 200), limit: 200 });
    const applied = new Set(recent.filter((event) => ['correction.applied', 'correction.restarted'].includes(event.type)).map((event) => event.data?.commandId));
    const correction = recent.filter((event) => event.type === 'correction.requested' && applied.has(event.data?.commandId)).at(-1)?.data?.text;
    const packet = `${fs.readFileSync(job.promptPath, 'utf8')}\n${correction || ''}`;
    return /\b(?:return|respond|answer|reply|output)\b[^\n]{0,100}\b(?:one[- ]word|single[- ]word|one[- ]line|single[- ]line|briefly|concisely|only (?:the |a )?(?:word|marker|json|number|yes|no))\b/i.test(packet);
  } catch { return false; }
}

function terminal(job, status, phase, extra = {}) {
  // The worker's final message is self-reported and can contradict what it
  // actually did; record the plugin's own observation of changed files so the
  // coordinator's first read of the job record is grounded.
  const providerFinished = status === 'completed';
  const providerTerminalStatus = status;
  let changedFiles = null;
  let finalHashes = null;
  let scopeViolations = null;
  let workspaceCaptureError = null;
  if (['implement', 'verify'].includes(job.mode)) {
    // Provider fileChange events do not cover shell tools. Always reconcile the
    // real shared tree, including on cancellation/failure, before accepting it.
    if (job.isolation !== 'worktree') recordGitState(loadJob(job.id) || job, job.providerSessionId);
    if (job.isolation === 'worktree') {
      try {
        captureManagedWorkspace(job.id);
        job = loadJob(job.id) || job;
      } catch (error) {
        workspaceCaptureError = redact(error.message);
        status = 'failed';
        phase = 'failed';
        extra = {
          ...extra,
          error: workspaceCaptureError,
          errorCode: error.code || 'CHANGESET_CREATE_FAILED'
        };
        updateManagedJob(job.id, (current) => {
          current.changeSetError = workspaceCaptureError;
          current.error = workspaceCaptureError;
          current.errorCode = error.code || 'CHANGESET_CREATE_FAILED';
        }, { incrementRevision: false });
      }
    }
    try {
      const files = job.isolation === 'worktree' && job.changeSet
        ? job.changeSet.files.map((file) => ({
          path: file.path,
          status: file.status,
          finalHash: file.resultOid || 'absent'
        }))
        : jobFiles(job.id);
      const baseline = new Set(job.baselineFiles || []);
      const entries = files.map((file) => {
        const privateOrSensitive = sensitiveObservationPath(file.path) || (job.observationExclude || []).some((root) => {
          const absolute = path.resolve(job.cwd, file.path);
          return absolute === root || absolute.startsWith(`${root}${path.sep}`);
        });
        const finalHash = file.finalHash || (privateOrSensitive ? null : hashWorkingFile(job.cwd, file.path));
        return {
          path: file.path,
          ...(file.status ? { status: file.status } : {}),
          ...(file.kind ? { kind: file.kind } : {}),
          ...((file.preexisting || baseline.has(file.path)) ? { preexisting: true } : {}),
          ...(file.overlapsPreexisting ? { overlapsPreexisting: true } : {}),
          ...(finalHash ? { finalHash } : {})
        };
      });
      changedFiles = changedFilesRecord(job, entries);
      finalHashes = Object.fromEntries(entries.filter((entry) => entry.finalHash).map((entry) => [entry.path, entry.finalHash]));
      if (job.allowedPaths?.length) {
        const violations = entries.filter((file) => !pathMatchesScope(file.path, job.allowedPaths));
        if (violations.length) {
          scopeViolations = violations.slice(0, 50).map((file) => ({
            path: file.path,
            ...(file.preexisting ? { preexisting: true } : {}),
            ...(file.overlapsPreexisting ? { overlapsPreexisting: true } : {})
          }));
          appendJobEvent(job.id, 'scope.violation', { count: violations.length, files: scopeViolations });
        }
      }
    } catch {}
  }
  const storedBeforeTerminal = loadJob(job.id);
  const deferVerification = status === 'completed'
    && changedFiles?.count > 0
    && job.verify?.command
    && job.verify?.disabled !== true
    && job.verifyCommandPath
    && storedBeforeTerminal?.verification?.state === 'pending';
  const swallowedSubagentFailure = !deferVerification && status === 'completed'
    && hasRecordedSubagentFailure(storedBeforeTerminal || job);
  let ingestOutcome = null;
  if (status === 'completed' && !deferVerification && job.stagingDir) {
    try { ingestOutcome = completeIngestedFiles(job); }
    catch (error) { ingestOutcome = { copiedBack: [], removed: false, error: redact(error.message) }; }
  }
  if (!deferVerification && job.isolation === 'worktree') {
    try {
      captureManagedWorkspace(job.id, {
        capture: workspaceCaptureError == null,
        discard: true
      });
      job = loadJob(job.id) || job;
      changedFiles = job.changedFiles || changedFiles;
      finalHashes = job.finalHashes || finalHashes;
    } catch (error) {
      updateManagedJob(job.id, (current) => {
        current.workspace = {
          ...current.workspace,
          discardError: redact(error.message)
        };
      }, { incrementRevision: false });
    }
  }
  if (!deferVerification) {
    extra = {
      ...extra,
      conclusion: jobConclusion({
        ...(loadJob(job.id) || job),
        ...extra,
        status,
        phase
      })
    };
  }
  if (!deferVerification) {
    appendJobEvent(job.id, status === 'completed' ? 'job.completed' : status === 'cancelled' ? 'job.cancelled' : 'error', extra);
  }
  updateManagedJob(job.id, (current) => {
    const firstAttemptText = current.result?.firstAttemptText;
    const subagents = Array.isArray(current.result?.subagents) ? current.result.subagents : [];
    current.providerCompletion = {
      finished: providerFinished,
      completed: providerFinished,
      labelAvailable: true,
      status: providerTerminalStatus,
      recordedAt: new Date().toISOString()
    };
    current.status = deferVerification ? 'running' : status;
    current.phase = deferVerification ? 'verifying' : phase;
    if (!deferVerification) {
      current.completedAtMs = Date.now();
      current.completedAt = Math.floor(current.completedAtMs / 1000);
    }
    if (changedFiles) current.changedFiles = changedFiles;
    if (finalHashes) current.finalHashes = finalHashes;
    if (scopeViolations) current.scopeViolations = scopeViolations;
    Object.assign(current, redact(extra));
    if (subagents.length) current.result = resultWithSubagents(current.result, subagents);
    if (firstAttemptText != null) {
      current.result = current.result && typeof current.result === 'object'
        ? { ...current.result, firstAttemptText }
        : { text: current.result == null ? '' : String(current.result), firstAttemptText };
    }
    if (ingestOutcome) current.ingestCompletion = ingestOutcome;
    // Providers return three different result shapes (Codex plain string,
    // Cursor ACP {text, plan, stopReason}, Cursor headless CLI envelope);
    // resultText is the one field consumers can always read.
    const text = current.result == null ? null
      : typeof current.result === 'string' ? current.result
      : typeof current.result.text === 'string' && current.result.text ? current.result.text
      : typeof current.result.result === 'string' ? current.result.result
      : null;
    if (text != null) current.resultText = text;
    if (!deferVerification && status !== 'completed' && current.verification?.state === 'pending') {
      current.verification = { state: 'skipped', reason: `Provider ${status} before broker verification`, recordedAt: new Date().toISOString() };
    }
    if (!deferVerification && status === 'completed') {
      if (current.verification?.state === 'pending' && changedFiles?.count === 0) {
        current.verification = {
          state: 'skipped',
          reason: 'Verification did not run because the write-mode job produced zero observed file changes',
          recordedAt: new Date().toISOString()
        };
      }
      current.verificationOrigin = ['passed', 'failed', 'timeout', 'stale'].includes(current.verification?.state)
        ? 'broker'
        : current.verification
          ? 'broker-policy'
          : current.sandbox === 'off' ? 'unsandboxed-worker' : 'worker-sandbox';
    }
    if (!deferVerification && status === 'completed' && current.reportSchema) {
      const structured = parseLastStructuredResult(text, current.reportSchema);
      if (structured) {
        current.result = current.result && typeof current.result === 'object'
          ? { ...current.result, structured }
          : { text: text || '', structured };
        delete current.structuredMissing;
        if (Object.hasOwn(structured, 'objectiveMet')) current.objectiveMet = structured.objectiveMet;
      } else current.structuredMissing = true;
    }
    // A read-mode turn that ends with a sentence of narration instead of the
    // findings is a recurring provider pattern; flag it so the coordinator
    // resumes with "paste the full findings now" instead of trusting it.
    if (!current.resultSuspect && !deferVerification && status === 'completed' && ['consult', 'plan', 'review'].includes(job.mode)
      && !current.result?.plan && !current.result?.structured && !conciseAnswerRequested(current)
      && (!text || text.trim().length < 200)) {
      current.resultSuspect = 'short-final-message';
    }
    // The write-mode analogue (field-observed: a Codex pre-implementation
    // audit returned analysis instead of code): completed with zero observed
    // changes means the objective was not met, on the record itself and not
    // only via the wait exit code.
    if (!current.resultSuspect && !deferVerification && status === 'completed' && ['implement', 'verify'].includes(job.mode)
      && changedFiles && changedFiles.count === 0) {
      current.resultSuspect = ['partial', 'unavailable'].includes(current.changeObservation?.state)
        ? 'change-observation-incomplete' : 'no-changes-write-mode';
    }
    const subagentOutputChars = (current.result?.subagents || [])
      .reduce((total, subagent) => total + String(subagent?.output || '').trim().length, 0);
    const finalMessageChars = String(text || '').trim().length;
    if (!current.resultSuspect && !deferVerification && status === 'completed' && subagentOutputChars >= 1000
      && subagentOutputChars > Math.max(finalMessageChars * 2, finalMessageChars + 500)) {
      current.resultSuspect = 'subagent-output-dominates-final';
    }
    if (!deferVerification && status === 'completed' && swallowedSubagentFailure && !current.resultSuspect) {
      current.resultSuspect = 'subagent-error-swallowed';
    }
    if (!deferVerification && status === 'completed' && ['implement', 'verify'].includes(current.mode)) {
      current.completedRevision = verificationRepositoryRevision(current.cwd);
      // HEAD moving is not drift. A coordinator committing unrelated work (docs,
      // another package) while a job runs must not block its acceptance — that
      // fires constantly in an active repo and trains the owner to ignore the
      // signal. Drift means the job's OWN inputs moved: the files it changed, or
      // the paths it declared in scope. Bare revision inequality is recorded for
      // evidence but only overlap blocks.
      const movedPaths = new Set(revisionChangedPaths(current.cwd, current.baseRevision, current.completedRevision));
      // Overlap is judged against the files this job ACTUALLY changed, not its
      // allowedPaths fence. A fence is often a whole package, so using it makes
      // any commit inside that package look like drift. A genuine dependency
      // change elsewhere is already caught by the verification run itself,
      // which executes against the post-change tree.
      const jobPaths = (current.changedFiles?.paths || [])
        .map((entry) => String(entry || '').replace(/^\.\//, '')).filter(Boolean);
      const overlap = jobPaths.filter((candidate) => [...movedPaths]
        .some((moved) => moved === candidate || moved.startsWith(`${candidate}/`) || candidate.startsWith(`${moved}/`)));
      current.revisionMoved = Boolean(current.baseRevision && current.completedRevision
        && current.baseRevision !== current.completedRevision);
      const collisionPaths = (current.collisions || []).map((collision) => collision?.path).filter(Boolean);
      current.baseDriftPaths = [...new Set([...overlap, ...collisionPaths])].slice(-256);
      current.baseDrift = current.baseDriftPaths.length > 0;
      current.acceptance = buildAcceptance(current);
    }
    if (!deferVerification) current.conclusion = jobConclusion(current);
  });
  if (deferVerification) {
    appendJobEvent(job.id, 'job.state', { status: 'running', phase: 'verifying' });
  }
  if (!deferVerification && job.planningFor) {
    try { recordPlanPassOutcome(loadJob(job.id)); }
    catch (error) {
      appendJobEvent(job.id, 'provider.event', {
        providerEvent: 'plan-pass-parent-record-error',
        error: error.message
      });
    }
  }
  if (!deferVerification && job.isolation === 'worktree' && loadJob(job.id)?.workspace?.state !== 'discarded') {
    try {
      captureManagedWorkspace(job.id, {
        capture: workspaceCaptureError == null,
        discard: true
      });
    } catch (error) {
      updateManagedJob(job.id, (current) => {
        current.workspace = {
          ...current.workspace,
          discardError: redact(error.message)
        };
      }, { incrementRevision: false });
      appendJobEvent(job.id, 'error', {
        code: error.code || 'WORKSPACE_DISCARD_FAILED',
        message: error.message,
        stage: 'workspace-discard'
      });
    }
  }
  if (!deferVerification && status === 'completed' && ['implement', 'verify'].includes(job.mode)) {
    maybeLaunchAutoFix(loadJob(job.id));
  }
}

// A managed job's provider thread identity is established when its own thread
// starts or resumes, and those callers pass rebind. Everything else may only
// confirm the identity already recorded, never replace it: Codex reports
// turn/started for SUBAGENT turns on the same connection, carrying the child's
// threadId and the child's turn id. Accepting those rebound the parent job to
// its own subagent — observed on codex-mseigqwb-f9fde5, where the recorded
// thread ended up being the third of three children. Everything keyed on this
// field then reads a child: resume continues the wrong thread, owned-thread
// exclusion guards the wrong id, subagent discovery asks for the descendants of
// a descendant, and providerTurnId aims steering at a turn the coordinator
// never started.
export function recordSession(jobId, sessionId, turnId = undefined, options = {}) {
  let applied = true;
  updateManagedJob(jobId, (job) => {
    const foreignThread = Boolean(sessionId)
      && Boolean(job.providerSessionId)
      && job.providerSessionId !== sessionId
      && options.rebind !== true;
    if (foreignThread) {
      applied = false;
      return;
    }
    if (sessionId) {
      job.providerSessionId = sessionId;
      job.session = sessionId;
    }
    if (turnId !== undefined) job.providerTurnId = turnId;
    job.phase = turnId ? 'running' : job.phase;
  });
  // Reporting session.updated for a thread that is not this job's session would
  // assert a change that did not happen. The child thread is already recorded
  // by the subagent.* lifecycle events.
  if (applied) appendJobEvent(jobId, 'session.updated', { sessionId, turnId });
  return applied;
}

export function mapCodexItem(jobId, phase, params, activity = null) {
  const item = params.item || {};
  const options = { sessionId: params.threadId, turnId: params.turnId };
  activity?.mark(codexActivitySignal('', item));
  if (item.type === 'reasoning') return;
  if (item.type === 'userMessage') {
    // The coordinator prompt already has a first-class message.user event.
  } else if (item.type === 'agentMessage') {
    if (phase === 'completed') {
      appendJobEvent(jobId, 'message.completed', { id: item.id, text: item.text, phase: item.phase }, options);
      storeProviderResult(jobId, item.text);
    }
  } else if (item.type === 'plan') {
    appendJobEvent(jobId, 'plan.updated', { id: item.id, text: item.text, phase }, options);
  } else if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabToolCall' || item.type === 'collabAgentToolCall') {
    // Collab-agent items mean the thread engaged Codex's multi-agent review
    // flow; such threads refuse direct resume. Mark the job so delegate_resume
    // can fail fast with the recovery instead of a provider round-trip.
    if (item.type === 'collabToolCall' || item.type === 'collabAgentToolCall') {
      updateManagedJob(jobId, (job) => { job.reviewFlowEngaged = true; }, { incrementRevision: false });
      recordSubagentCandidates(jobId, normalizeSubagentLifecycle({
        source: 'codex-item',
        provider: 'codex',
        transport: 'app-server',
        phase,
        payload: item
      }), options);
    }
    const type = phase === 'started' ? 'tool.started' : 'tool.completed';
    appendJobEvent(jobId, type, { item }, options);
  } else if (item.type === 'fileChange') {
    appendJobEvent(jobId, 'file.changed', { changes: item.changes || [], status: item.status, phase }, options);
  } else if (item.type === 'contextCompaction') {
    appendProviderItemPassthrough(jobId, phase, item, options);
    appendJobEvent(jobId, `compaction.${phase}`, { itemId: item.id }, options);
  } else if (item.type === 'subAgentActivity') {
    appendProviderItemPassthrough(jobId, phase, item, options);
    updateManagedJob(jobId, (job) => { job.reviewFlowEngaged = true; }, { incrementRevision: false });
    recordSubagentCandidates(jobId, normalizeSubagentLifecycle({
      source: 'codex-item',
      provider: 'codex',
      transport: 'app-server',
      phase,
      payload: item
    }), options);
  } else if (item.type && !isCodexFirstClassItemType(item.type)) {
    appendProviderItem(jobId, phase, item, options);
  }
}

function directCodexSession(params, msg) {
  return params?._meta?.threadId || msg?.thread_id || msg?.threadId || msg?.session_id || msg?.sessionId || null;
}

function directCodexTurn(msg) {
  return msg?.turn_id || msg?.turnId || null;
}

function directCodexType(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function directCodexMessageText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.message === 'string') return item.message;
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .filter((part) => directCodexType(part?.type) === 'text' || directCodexType(part?.type) === 'output_text')
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .join('');
}

function directCodexChanges(msg) {
  const raw = msg?.changes ?? msg?.file_changes ?? msg?.fileChanges;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([file, change]) => change && typeof change === 'object'
      ? { path: file, ...change }
      : { path: file, kind: change == null ? 'edit' : String(change) });
  }
  const file = msg?.path || msg?.file || msg?.file_path || msg?.filePath;
  return file ? [{ path: file, kind: msg?.kind || msg?.status || 'edit' }] : [];
}

function directCodexTool(msg, event, kind = null) {
  return {
    toolCallId: msg?.call_id || msg?.callId || msg?.item_id || msg?.itemId || event?.id,
    kind: kind || msg?.type || 'tool',
    title: msg?.name || msg?.command || kind || msg?.type || 'tool',
    command: msg?.command,
    cwd: msg?.cwd,
    status: msg?.status,
    exitCode: msg?.exit_code ?? msg?.exitCode
  };
}

function directCodexUsage(msg) {
  const info = msg?.info || {};
  const total = info.total_token_usage || info.totalTokenUsage || msg?.total_token_usage || msg?.totalTokenUsage;
  const last = info.last_token_usage || info.lastTokenUsage || msg?.last_token_usage || msg?.lastTokenUsage;
  const direct = msg?.token_usage || msg?.tokenUsage || msg?.usage;
  if (total) return { total, ...(last ? { last } : {}) };
  return direct || null;
}

// `codex mcp-server` exposes the same provider stream as custom
// `codex/event` notifications, tagged with the originating MCP request id.
// Normalize those legacy EventMsg envelopes into the durable event vocabulary
// used by the managed app-server adapter.
export function mapCodexMcpEvent(job, params = {}, context = {}) {
  const msg = params?.msg && typeof params.msg === 'object' ? params.msg : {};
  const type = directCodexType(msg.type || 'unknown');
  const sessionId = directCodexSession(params, msg) || job.providerSessionId || null;
  const turnId = directCodexTurn(msg);
  const options = { sessionId, turnId };
  const activity = context.activity;
  const deltas = context.deltas || new DeltaRedactor();
  const output = () => activity?.mark('output');
  const thinking = () => activity?.mark('thinking');

  if (type === 'session_configured') {
    output();
    updateManagedJob(job.id, (current) => {
      if (sessionId) {
        current.providerSessionId = sessionId;
        current.session = sessionId;
      }
      if (msg.model) current.resolvedModel = msg.model;
      if (msg.reasoning_effort && !current.effort) current.effort = msg.reasoning_effort;
    }, { incrementRevision: false });
    appendJobEvent(job.id, 'provider.initialized', { transport: 'direct-mcp', model: msg.model }, options);
    appendJobEvent(job.id, 'session.created', { sessionId, model: msg.model }, options);
  } else if (type === 'turn_started') {
    output();
    appendJobEvent(job.id, 'turn.started', { transport: 'direct-mcp' }, options);
  } else if (type === 'agent_message_content_delta' || type === 'agent_message_delta') {
    output();
    const delta = msg.delta || msg.text || '';
    appendJobEvent(job.id, 'message.delta', {
      id: msg.item_id || msg.itemId || params.id,
      delta: deltas.redactDelta(`message:${msg.item_id || msg.itemId || 'direct-mcp'}`, delta)
    }, options);
  } else if (type === 'agent_message') {
    output();
    const text = msg.message || msg.text || '';
    if (text && text !== context.lastCompletedText) {
      appendJobEvent(job.id, 'message.completed', { id: msg.item_id || msg.itemId || params.id, text }, options);
      storeProviderResult(job.id, text);
      context.lastCompletedText = text;
    }
  } else if (/reasoning/.test(type)) {
    thinking();
  } else if (type === 'plan_update' || type === 'plan_delta') {
    output();
    appendJobEvent(job.id, 'plan.updated', msg.plan || msg, options);
  } else if (type === 'exec_command_begin') {
    output();
    appendJobEvent(job.id, 'tool.started', directCodexTool(msg, params, 'commandExecution'), options);
  } else if (type === 'exec_command_output_delta' || type === 'terminal_interaction') {
    output();
    appendJobEvent(job.id, 'tool.output', {
      ...directCodexTool(msg, params, 'commandExecution'),
      delta: deltas.redactDelta(`tool:${msg.call_id || msg.callId || params.id || 'direct-mcp'}`, msg.delta || msg.chunk || msg.output || '')
    }, options);
  } else if (type === 'exec_command_end') {
    output();
    appendJobEvent(job.id, 'tool.completed', directCodexTool(msg, params, 'commandExecution'), options);
  } else if (type === 'mcp_tool_call_begin' || type === 'dynamic_tool_call_request'
    || type === 'web_search_begin' || type === 'image_generation_begin' || type === 'view_image_tool_call') {
    output();
    appendJobEvent(job.id, 'tool.started', directCodexTool(msg, params), options);
  } else if (type === 'mcp_tool_call_end' || type === 'dynamic_tool_call_response'
    || type === 'web_search_end' || type === 'image_generation_end') {
    output();
    appendJobEvent(job.id, 'tool.completed', directCodexTool(msg, params), options);
  } else if (type === 'patch_apply_begin' || type === 'patch_apply_updated' || type === 'patch_apply_end') {
    output();
    const phase = type === 'patch_apply_begin' ? 'started' : type === 'patch_apply_end' ? 'completed' : 'updated';
    const toolType = phase === 'started' ? 'tool.started' : phase === 'completed' ? 'tool.completed' : 'tool.status';
    appendJobEvent(job.id, toolType, directCodexTool(msg, params, 'fileChange'), options);
    const changes = directCodexChanges(msg);
    if (changes.length) appendJobEvent(job.id, 'file.changed', { changes, phase }, options);
  } else if (type === 'item_started' || type === 'item_completed') {
    const phase = type === 'item_started' ? 'started' : 'completed';
    const item = msg.item || {};
    const itemType = directCodexType(item.type);
    if (itemType === 'reasoning') {
      thinking();
    } else if (itemType === 'user_message') {
      // The prompt is already stored through the ordinary redacted
      // message.user path; never duplicate provider-echoed prompt content.
    } else if (itemType === 'file_change') {
      output();
      const changes = directCodexChanges(item);
      if (changes.length) appendJobEvent(job.id, 'file.changed', { changes, phase, status: item.status }, options);
    } else if (itemType === 'agent_message' && phase === 'completed') {
      output();
      const text = directCodexMessageText(item);
      if (text && text !== context.lastCompletedText) {
        appendJobEvent(job.id, 'message.completed', { id: item.id, text }, options);
        storeProviderResult(job.id, text);
        context.lastCompletedText = text;
      }
    } else if (itemType === 'agent_message') {
      output();
    } else if (itemType === 'plan') {
      output();
      appendJobEvent(job.id, 'plan.updated', { id: item.id, text: item.text, phase }, options);
    } else if (itemType === 'context_compaction') {
      output();
      appendJobEvent(job.id, `compaction.${phase}`, { itemId: item.id }, options);
    } else if (['command_execution', 'mcp_tool_call', 'dynamic_tool_call', 'collab_agent_tool_call',
      'web_search', 'image_generation', 'view_image_tool_call'].includes(itemType)) {
      output();
      if (itemType === 'collab_agent_tool_call') {
        updateManagedJob(job.id, (current) => { current.reviewFlowEngaged = true; }, { incrementRevision: false });
        recordSubagentCandidates(job.id, normalizeSubagentLifecycle({
          source: 'codex-item',
          provider: 'codex',
          transport: 'direct-mcp',
          phase,
          payload: item
        }), options);
      }
      appendJobEvent(job.id, phase === 'started' ? 'tool.started' : 'tool.completed', {
        ...directCodexTool(item, params, itemType),
        item
      }, options);
    } else if (itemType === 'sub_agent_activity') {
      output();
      appendProviderItemPassthrough(job.id, phase, item, options, `codex:item_${phase}`);
      updateManagedJob(job.id, (current) => { current.reviewFlowEngaged = true; }, { incrementRevision: false });
      recordSubagentCandidates(job.id, normalizeSubagentLifecycle({
        source: 'codex-item',
        provider: 'codex',
        transport: 'direct-mcp',
        phase,
        payload: item
      }), options);
    } else if (itemType && !isCodexFirstClassItemType(itemType)) {
      appendProviderItem(job.id, phase, item, options, `codex:item_${phase}`);
    }
  } else if (type === 'turn_diff') {
    output();
    const diff = msg.unified_diff || msg.unifiedDiff || msg.diff || '';
    if (diff) appendJobEvent(job.id, 'diff.updated', { diff }, options);
  } else if (type === 'token_count') {
    const usage = directCodexUsage(msg);
    if (usage) recordUsage(job, usage, options);
  } else if (type === 'context_compacted') {
    output();
    appendJobEvent(job.id, 'compaction.completed', { itemId: msg.item_id || msg.itemId || params.id }, options);
  } else if (type === 'exec_approval_request' || type === 'apply_patch_approval_request' || type === 'request_permissions') {
    output();
    appendJobEvent(job.id, 'approval.requested', { kind: type, callId: msg.call_id || msg.callId, command: msg.command, cwd: msg.cwd }, options);
  } else if (type === 'request_user_input' || type === 'elicitation_request') {
    output();
    appendJobEvent(job.id, 'input.requested', { kind: type, requestId: msg.id || params.id }, options);
  } else if (type === 'turn_complete' || type === 'turn_aborted') {
    output();
    appendJobEvent(job.id, 'turn.completed', { status: type === 'turn_complete' ? 'completed' : 'aborted' }, options);
  } else if (type === 'error') {
    output();
    appendJobEvent(job.id, 'error', { code: msg.error_code || msg.code || 'PROVIDER_ERROR', error: msg.message || msg.error }, options);
  } else if (type === 'warning' || type === 'guardian_warning') {
    output();
    appendJobEvent(job.id, 'provider.event', { providerEvent: `codex:${type}`, message: msg.message }, options);
  } else if (/^collab_|^sub_agent_/.test(type)) {
    output();
    updateManagedJob(job.id, (current) => { current.reviewFlowEngaged = true; }, { incrementRevision: false });
    appendJobEvent(job.id, 'provider.event', { providerEvent: `codex:${type}` }, options);
    recordSubagentCandidates(job.id, normalizeSubagentLifecycle({
      source: 'codex-notification',
      provider: 'codex',
      transport: 'direct-mcp',
      eventType: type,
      sourceItemId: params.id,
      payload: msg
    }), options);
  } else if (!['user_message', 'thread_settings_applied', 'model_verification'].includes(type)) {
    appendJobEvent(job.id, 'provider.event', { providerEvent: `codex:${type}` }, options);
  }
  return {
    sessionId,
    resolvedModel: type === 'session_configured' ? msg.model || null : null,
    completedText: context.lastCompletedText || null,
    usage: type === 'token_count' ? directCodexUsage(msg) : null
  };
}

// sandbox: 'off' maps to Codex danger-full-access — the job explicitly needs
// host tools (git, CLIs, live web). Web search follows the same intent: it is
// enabled whenever the job has any form of outside access.
export function codexSandboxMode(job) {
  if (job.sandbox === 'off') return 'danger-full-access';
  return readOnly(job) ? 'read-only' : 'workspace-write';
}

export function codexSpawnArgs(job) {
  return [
    'app-server', '--stdio',
    '-c', 'approval_policy="on-request"',
    '-c', 'approvals_reviewer="auto_review"',
    '-c', `sandbox_workspace_write.network_access=${job.network === true}`,
    '-c', `tools.web_search=${job.network === true || job.sandbox === 'off'}`,
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'
  ];
}

const CHILD_SUBSCRIPTION_TERMINAL = new Set(['idle', 'not_loaded', 'notloaded', 'system_error', 'completed', 'failed', 'cancelled']);

export function createCodexChildSubscriptionController(rpc, options = {}) {
  const active = new Map();
  const parentThreadId = options.parentThreadId || (() => null);

  const stop = async (subscriptionId, reason = 'unsubscribe', notify = true) => {
    const subscription = active.get(subscriptionId);
    if (!subscription || subscription.stopping) return false;
    subscription.stopping = true;
    active.delete(subscriptionId);
    if (notify) subscription.publisher.send({ type: 'closed', subscriptionId, threadId: subscription.threadId, reason });
    try { await rpc.request('thread/unsubscribe', { threadId: subscription.threadId }); } catch {}
    subscription.publisher.close();
    removeChildTranscriptEndpoint(subscription.endpoint);
    return true;
  };

  const reject = async (command, message, publisher = null, resumed = false) => {
    publisher?.send({
      type: 'rejected', subscriptionId: command.subscriptionId, threadId: command.threadId,
      error: String(message || 'subscription rejected').slice(0, 1024)
    });
    if (resumed) {
      try { await rpc.request('thread/unsubscribe', { threadId: command.threadId }); } catch {}
    }
    publisher?.close();
    removeChildTranscriptEndpoint(command.endpoint);
  };

  return {
    active,
    async handleCommand(command) {
      if (command?.type === 'child-transcript.unsubscribe') {
        return stop(command.subscriptionId, 'requested');
      }
      if (command?.type !== 'child-transcript.subscribe') return false;
      let publisher = null;
      let resumed = false;
      try {
        if (!command.threadId || command.threadId === parentThreadId()) {
          throw new Error('child transcript subscription must target a child thread');
        }
        await stop(command.subscriptionId, 'replaced', false);
        for (const [id, subscription] of active) {
          if (subscription.threadId === command.threadId) await stop(id, 'replaced', false);
        }
        publisher = await connectChildTranscriptPublisher(command);
        const subscription = {
          subscriptionId: command.subscriptionId,
          threadId: command.threadId,
          endpoint: command.endpoint,
          publisher,
          established: false,
          stopping: false
        };
        active.set(command.subscriptionId, subscription);
        publisher.once('disconnect', () => { void stop(command.subscriptionId, 'consumer-disconnected', false); });
        const result = await rpc.request('thread/resume', { threadId: command.threadId });
        resumed = true;
        if (String(result?.thread?.id || '') !== String(command.threadId)) {
          throw new Error(`app-server resumed unexpected thread ${result?.thread?.id || 'missing'}`);
        }
        subscription.established = true;
        publisher.send({ type: 'established', subscriptionId: command.subscriptionId, threadId: command.threadId });
        publisher.send({
          type: 'snapshot', subscriptionId: command.subscriptionId, threadId: command.threadId,
          snapshot: projectCodexChildSnapshot(result.thread, { now: Date.now() })
        });
        return true;
      } catch (error) {
        active.delete(command.subscriptionId);
        await reject(command, error?.message || error, publisher, resumed);
        return false;
      }
    },
    handleNotification(method, params = {}) {
      const threadId = String(params.threadId || params.thread?.id || '');
      if (!threadId) return false;
      const subscription = [...active.values()].find((entry) => entry.threadId === threadId);
      if (!subscription) return false;
      const projected = projectCodexChildNotification(method, params, { now: Date.now() });
      if (projected.events.length || projected.droppedReasoningCount) {
        subscription.publisher.send({
          type: 'events', subscriptionId: subscription.subscriptionId, threadId,
          events: projected.events, droppedReasoningCount: projected.droppedReasoningCount,
          capturedAtMs: projected.capturedAtMs
        });
      }
      if (projected.status) {
        subscription.publisher.send({
          type: 'status', subscriptionId: subscription.subscriptionId, threadId,
          status: projected.status, pointInTime: projected.pointInTime
        });
        if (CHILD_SUBSCRIPTION_TERMINAL.has(normalizedToken(projected.status))) {
          void stop(subscription.subscriptionId, 'child-terminal');
        }
      }
      return true;
    },
    stop,
    async close(reason = 'parent-terminal') {
      await Promise.allSettled([...active.keys()].map((subscriptionId) => stop(subscriptionId, reason)));
    }
  };
}

async function runCodex(job, driver) {
  let turnDone = null;
  let turnResolve;
  let cancelled = false;
  const queuedPrompts = [];
  let interruptRequested = false;
  let cancelDrainDeadline = null;
  const messages = new Map();
  const deltas = new DeltaRedactor();
  const activity = new ActivityTransitionEmitter(job.id);
  let budgetError = null;
  let planPassError = null;
  let largeWriteError = null;
  const liveChangedPaths = new Set();
  const pendingInterrogations = [];
  let planPhase = planningActive(job) ? 'planning' : 'disabled';
  let planDeclined = false;
  const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CODEX_TIMEOUT_SECONDS', 3600);
  const deadline = Number(job.createdAtMs || Number(job.createdAt || 0) * 1000 || Date.now()) + timeoutMs;
  const binary = process.env.DELEGATE_CODEX_BIN || 'codex';
  persistProviderCliVersion(job.id, assertProviderVersion('codex', binary));
  let childSubscriptions = null;
  const rpc = new JsonRpcProcess(binary, codexSpawnArgs(job), {
    cwd: job.cwd,
    onStderr: (text) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text: deltas.redactDelta('stderr', text) }),
    onRequest: async (method, params) => {
      activity.mark('output');
      appendJobEvent(job.id, 'approval.requested', { method, params });
      const forced = job.approval === 'force';
      let result;
      if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') result = { decision: forced ? 'accept' : 'decline' };
      else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') result = { decision: forced ? 'accept' : 'decline' };
      else if (method === 'item/tool/requestUserInput') {
        appendJobEvent(job.id, 'error', { code: 'USER_INPUT_REQUIRED', message: 'Codex requested interactive input; managed v1 does not fabricate an answer', request: params });
        throw brokerError('USER_INPUT_REQUIRED', 'inspect the request and resume the job with an explicit answer', { provider: job.provider });
      }
      else throw brokerError('INVALID_REQUEST', `Unsupported app-server request: ${method}`, { provider: job.provider });
      appendJobEvent(job.id, 'approval.resolved', { method, decision: result.decision || 'empty' });
      return result;
    },
    onNotification: async (method, params) => {
      if (childSubscriptions?.handleNotification(method, params)) return;
      const options = { sessionId: params.threadId, turnId: params.turnId || params.turn?.id };
      if (method === 'turn/started') {
        activity.mark('output');
        const turnId = params.turn?.id;
        recordSession(job.id, params.threadId, turnId);
        appendJobEvent(job.id, 'turn.started', { turn: params.turn }, options);
      } else if (method === 'item/agentMessage/delta') {
        activity.mark('output');
        const text = `${messages.get(params.itemId) || ''}${params.delta || ''}`;
        messages.set(params.itemId, text);
        appendJobEvent(job.id, 'message.delta', { id: params.itemId, delta: deltas.redactDelta(`message:${params.itemId}`, params.delta) }, options);
      } else if (method === 'item/started' || method === 'item/completed') {
        const phase = method === 'item/started' ? 'started' : 'completed';
        mapCodexItem(job.id, phase, params, activity);
        if (phase === 'completed' && params.item?.type === 'agentMessage' && pendingInterrogations.length) {
          const interrogation = pendingInterrogations.shift();
          try {
            recordInterrogationAnswer(job.id, interrogation.command, params.item.text, {
              baselineOutputTokens: interrogation.baselineOutputTokens,
              transport: 'app-server',
              appliedAs: 'same-turn-read-only-question'
            });
            settleQueuedControl(job.id, interrogation.command.commandId, {
              ok: true,
              appliedAs: 'same-turn-read-only-question',
              evidenceRecorded: true
            });
          } catch (error) {
            settleQueuedControl(job.id, interrogation.command.commandId, { ok: false, error: error.message });
          }
        }
        for (const file of codexChangedPaths(params.item)) liveChangedPaths.add(file);
        const limit = largeWriteLimit();
        if (liveChangedPaths.size > limit && !largeWriteError) {
          largeWriteError = brokerError('LARGE_WRITE', `Codex reported ${liveChangedPaths.size} changed paths, exceeding DELEGATE_MAX_CHANGED_FILES=${limit}`, {
            provider: job.provider,
            retryable: false,
            changedFilesCount: liveChangedPaths.size,
            limit
          });
          appendJobEvent(job.id, 'large.write', { count: liveChangedPaths.size, limit, enforcement: 'live-interrupt' }, options);
          const turnId = params.turnId || inspectJob(job.id).providerTurnId;
          if (turnId) {
            try { await rpc.request('turn/interrupt', { threadId: params.threadId || job.providerSessionId, turnId }); }
            catch (error) { appendJobEvent(job.id, 'provider.event', { providerEvent: 'large-write-interrupt-error', error: error.message }, options); }
          }
        }
      }
      else if (method === 'item/commandExecution/outputDelta') {
        activity.mark('output');
        appendJobEvent(job.id, 'tool.output', { id: params.itemId, delta: deltas.redactDelta(`tool:${params.itemId}`, params.delta) }, options);
      }
      else if (method === 'turn/plan/updated') {
        activity.mark('output');
        appendJobEvent(job.id, 'plan.updated', { explanation: params.explanation, plan: params.plan }, options);
      }
      else if (method === 'turn/diff/updated') appendJobEvent(job.id, 'diff.updated', { diff: params.diff }, options);
      else if (method === 'thread/tokenUsage/updated') {
        const exceeded = recordUsage(job, params.tokenUsage, options);
        if (exceeded?.planPass && !planPassError) {
          planPassError = exceeded;
          appendJobEvent(job.id, 'plan.output-limit-exceeded', {
            stage: 'primary-plan',
            reason: 'plan-output-token-sub-budget-exceeded',
            observedOutputTokens: exceeded.observedOutputTokens,
            maxOutputTokens: exceeded.maxOutputTokens
          }, options);
          const turnId = params.turnId || inspectJob(job.id).providerTurnId;
          if (turnId) {
            try { await rpc.request('turn/interrupt', { threadId: params.threadId || job.providerSessionId, turnId }); }
            catch {}
          }
        } else if (exceeded && !budgetError) {
          budgetError = exceeded;
          recordBudgetExceeded(job, exceeded, options);
          const turnId = params.turnId || inspectJob(job.id).providerTurnId;
          if (turnId) {
            try { await rpc.request('turn/interrupt', { threadId: params.threadId || job.providerSessionId, turnId }); }
            catch (error) {
              appendJobEvent(job.id, 'provider.event', { providerEvent: 'budget-interrupt-error', error: error.message }, options);
            }
          }
        }
      } else if (method === 'turn/completed') {
        appendJobEvent(job.id, 'turn.completed', { turn: params.turn }, options);
        updateManagedJob(job.id, (current) => { current.providerTurnId = null; }, { incrementRevision: false });
        turnResolve?.(params.turn);
      } else if (method === 'account/rateLimits/updated') {
        appendJobEvent(job.id, 'provider.event', { providerEvent: method }, options);
        try {
          const limits = params.rateLimits || {};
          mutateState((state) => {
            for (const name of ['primary', 'secondary']) {
              const value = limits[name];
              if (value && Number.isFinite(value.usedPercent)) {
                setWindow(state, 'codex', name, value.usedPercent, { resetsAt: value.resetsAt, source: 'codex-app-server' });
              }
            }
            captureCodexAllowanceSnapshot(state, limits, { source: 'codex-app-server' });
          });
        } catch {}
      } else if (method === 'error') {
        activity.mark('output');
        appendJobEvent(job.id, 'error', params, options);
      }
      else if (method.includes('reasoning')) activity.mark(codexActivitySignal(method));
      else appendJobEvent(job.id, 'provider.event', { providerEvent: method }, options);
    }
  });
  childSubscriptions = createCodexChildSubscriptionController(rpc, {
    parentThreadId: () => loadJob(job.id)?.providerSessionId || null
  });

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'delegate-router', title: 'Delegate Router', version: '0.74.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    rpc.notify('initialized', {});
    const model = resolveCodexModel(job.model);
    const catalog = await discoverCodexModels(rpc, { timeoutMs: Math.max(100, Math.min(2000, deadline - Date.now())) });
    const preflight = validateCodexSelection(catalog, job.model, job.effort);
    updateManagedJob(job.id, current => { current.modelPreflight = preflight; }, { incrementRevision: false });
    appendJobEvent(job.id, 'model.preflight', preflight);
    const baseConfig = job.effort ? { model_reasoning_effort: job.effort } : {};
    if (job.maxSubagents === 0) baseConfig['agents.enabled'] = false;
    else if (job.maxSubagents != null) {
      baseConfig['agents.enabled'] = true;
      baseConfig['agents.max_concurrent_threads_per_session'] = job.maxSubagents;
    }
    const common = {
      model,
      cwd: job.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: codexSandboxMode(job),
      developerInstructions: `${securityPreamble(job.allowSensitive)}${CONVERSATIONAL_DELEGATION_PREAMBLE}`,
      config: { ...baseConfig, ...codexBackchannelConfig(job) }
    };
    let thread;
    try {
      thread = job.providerSessionId
        ? await rpc.request('thread/resume', { threadId: job.providerSessionId, ...common, excludeTurns: true })
        : await rpc.request('thread/start', common);
    } catch (error) {
      appendJobEvent(job.id, 'backchannel.unavailable', {
        transport: 'app-server',
        reason: error.message,
        fallback: 'thread-without-backchannel'
      });
      try {
        const fallback = { ...common, config: baseConfig };
        thread = job.providerSessionId
          ? await rpc.request('thread/resume', { threadId: job.providerSessionId, ...fallback, excludeTurns: true })
          : await rpc.request('thread/start', fallback);
      } catch (fallbackError) {
        throw mapCodexResumeError(fallbackError, Boolean(job.providerSessionId));
      }
    }
    const threadId = thread.thread.id;
    // Thread start or resume is where this job's own identity is established.
    recordSession(job.id, threadId, null, { rebind: true });
    if (thread.model) {
      updateManagedJob(job.id, (current) => { current.resolvedModel = thread.model; }, { incrementRevision: false });
    }

    const startTurn = async (text, sandbox = codexSandboxMode(loadJob(job.id))) => {
      turnDone = new Promise((resolve) => { turnResolve = resolve; });
      let result;
      const current = loadJob(job.id);
      const planning = Boolean(current.planningFor) || current.planning?.state === 'running';
      const outputSchema = nativeOutputSchema(planning ? STRUCTURAL_PLAN_SCHEMA : current.reportSchema);
      const params = {
        threadId,
        input: [{ type: 'text', text: outputSchema ? `${text}\n\nNative JSON output contract: return the final answer as the schema-matching JSON object, without Markdown fences or surrounding prose. This changes formatting only, not task authority.` : text, text_elements: [] }],
        cwd: job.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        model,
        sandbox,
        ...(outputSchema ? { outputSchema } : {})
      };
      try {
        result = await driver.prompt(() => rpc.request('turn/start', params));
      } catch (error) {
        // Only a pre-turn unknown-field refusal can remove native formatting.
        // Task/model/schema validation errors never trigger paid retries.
        if (!outputSchema || error.rpcCode !== -32602 || !/outputSchema|output_schema/i.test(error.message)
          || !/unknown|unrecognized|unsupported|unexpected/i.test(error.message)) {
          throw mapCodexResumeError(error, Boolean(job.providerSessionId));
        }
        delete params.outputSchema;
        params.input[0].text = text;
        appendJobEvent(job.id, 'provider.event', { providerEvent: 'codex:output-schema-unavailable', fallback: 'broker-validated-report', turnStarted: false });
        result = await driver.prompt(() => rpc.request('turn/start', params));
      }
      if (outputSchema && params.outputSchema) appendJobEvent(job.id, 'provider.event', { providerEvent: 'codex:output-schema', contract: planning ? 'structural-plan' : 'report' });
      recordSession(job.id, threadId, result.turn.id);
      return result.turn.id;
    };

    if (!await holdBeforeFirstTurn(loadJob(job.id), deadline)) return;
    if (planPhase === 'planning') {
      updateManagedJob(job.id, (current) => {
        current.planning = { ...current.planning, state: 'running', startedAt: Date.now(), sandbox: 'read-only' };
        current.phase = 'planning';
      }, { incrementRevision: false });
      startAmbiguityProbe(job.id);
      await startTurn(planPrompt(promptFor(loadJob(job.id)), { provider: job.provider, model: job.model }), 'read-only');
    } else {
      await startTurn(promptFor(loadJob(job.id)));
    }
    while (true) {
      const inputTimeout = backchannelTimedOut(job.id);
      if (inputTimeout) {
        const active = inspectJob(job.id).providerTurnId;
        if (active) await rpc.request('turn/interrupt', { threadId, turnId: active }).catch(() => {});
        throw inputTimeout;
      }
      if (Date.now() >= deadline) {
        const active = inspectJob(job.id).providerTurnId;
        if (active) {
          const graceMs = drainGraceMs();
          const interrupted = rpc.request('turn/interrupt', { threadId, turnId: active }, Math.max(graceMs, 1))
            .catch((error) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'timeout-interrupt-error', error: error.message }));
          if (graceMs) await Promise.race([Promise.allSettled([interrupted, turnDone]), delay(graceMs)]);
        }
        throw brokerError('TIMEOUT', `Codex managed job exceeded ${Math.round(timeoutMs / 1000)}s and was interrupted; raise timeoutSeconds for longer work`, { provider: job.provider });
      }
      if (cancelled && cancelDrainDeadline != null && Date.now() >= cancelDrainDeadline) {
        await rpc.stop();
        terminal(job, 'cancelled', 'cancelled');
        break;
      }
      const completed = await Promise.race([
        turnDone.then((turn) => ({ turn })),
        rpc.exit.then((outcome) => ({ providerExit: outcome })),
        delay(150).then(() => null)
      ]);
      if (completed?.providerExit) {
        const outcome = completed.providerExit;
        throw outcome.error || brokerError('TRANSPORT_ERROR', `Codex app-server exited before turn completion (code ${outcome.code}, signal ${outcome.signal || 'none'})`, { provider: job.provider });
      }
      for (const claimed of claimProviderCommands(job.id)) {
        const command = claimed.command;
        try {
          if (command.type === 'child-transcript.subscribe' || command.type === 'child-transcript.unsubscribe') {
            await childSubscriptions.handleCommand(command);
            continue;
          }
          const current = inspectJob(job.id);
          const planAnswer = answerPlanCommand(job.id, claimed);
          if (planAnswer?.decision === 'confirmed') {
            planPhase = 'implementing';
            await startTurn(IMPLEMENT_CONFIRMED_PROMPT, codexSandboxMode(loadJob(job.id)));
          } else if (planAnswer?.decision === 'declined') {
            planDeclined = true;
            terminal(loadJob(job.id), 'cancelled', 'plan-declined', {
              stoppedReason: 'plan-declined',
              result: loadJob(job.id).result
            });
          } else if (planAnswer) {
            // Invalid plan responses are settled by answerPlanCommand and the
            // job remains safely paused at the confirmation boundary.
          } else if (command.type === 'cancel') {
            for (const queued of queuedPrompts) {
              appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' });
              settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
            }
            queuedPrompts.length = 0;
            cancelled = true;
            const graceMs = drainGraceMs();
            cancelDrainDeadline = Date.now() + graceMs;
            if (current.providerTurnId) {
              await driver.cancel(() => rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId }, Math.max(graceMs, 1)))
                .catch((error) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'cancel-interrupt-error', error: error.message }));
            }
            completeCommand(job.id, claimed, { ok: true, appliedAs: 'interrupt' });
          } else if (command.type === 'interrogate') {
            if (!current.providerTurnId) {
              completeCommand(job.id, claimed, { ok: false, error: 'SESSION_UNAVAILABLE: no active Codex turn to interrogate' });
              continue;
            }
            const baselineOutputTokens = usageTotals(current.usage)?.outputTokens || 0;
            updateManagedJob(job.id, (next) => {
              const entry = (next.interrogations || []).find((item) => item.id === command.commandId);
              if (entry) entry.state = 'active';
            }, { incrementRevision: false });
            await driver.steer(() => rpc.request('turn/steer', {
              threadId,
              expectedTurnId: current.providerTurnId,
              input: [{ type: 'text', text: interrogationPrompt(command.commandId, command.question), text_elements: [] }]
            }));
            pendingInterrogations.push({ command, baselineOutputTokens });
            appendJobEvent(job.id, 'interrogation.queued', {
              commandId: command.commandId,
              appliedAs: 'same-turn-read-only-question',
              authority: 'evidence-only',
              constraintsUnchanged: true
            });
            completeCommand(job.id, claimed, {
              ok: true,
              state: 'queued',
              appliedAs: 'same-turn-read-only-question',
              evidencePending: true
            });
          } else if (command.type === 'steer') {
            if (cancelled) {
              completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
              continue;
            }
            const strategy = command.strategy || 'auto';
            if ((strategy === 'auto' || strategy === 'same-turn') && current.providerTurnId) {
              try {
                await driver.steer(() => rpc.request('turn/steer', {
                  threadId,
                  expectedTurnId: command.expectedTurnId || current.providerTurnId,
                  input: [{ type: 'text', text: command.text, text_elements: [] }]
                }));
                appendJobEvent(job.id, 'correction.applied', { commandId: command.commandId, appliedAs: 'same-turn' });
                completeCommand(job.id, claimed, { ok: true, appliedAs: 'same-turn' });
              } catch (error) {
                if (strategy === 'same-turn') throw error;
                queuedPrompts.push({ text: command.text, commandId: command.commandId, appliedAs: 'next-turn' });
                appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, reason: error.message });
                completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'next-turn' });
              }
            } else {
              queuedPrompts.push({ text: command.text, commandId: command.commandId, appliedAs: strategy === 'restart' ? 'restart' : 'next-turn' });
              if (strategy === 'restart' && current.providerTurnId && !interruptRequested) {
                interruptRequested = true;
                await driver.cancel(() => rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId }));
              }
              appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy });
              completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: strategy === 'restart' ? 'restart' : 'next-turn' });
            }
          } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
        } catch (error) {
          if (command.type === 'interrogate') {
            recordInterrogationUnavailable(job.id, command, error, 'app-server', claimed);
          } else {
            completeCommand(job.id, claimed, { ok: false, error: error.message });
          }
        }
      }
      if (planDeclined) break;
      if (completed) {
        interruptRequested = false;
        if (largeWriteError) throw largeWriteError;
        if (budgetError) throw budgetError;
        if (cancelled) { terminal(job, 'cancelled', 'cancelled'); break; }
        if (planPhase === 'planning') {
          const primaryText = loadJob(job.id).resultText || loadJob(job.id).result || '';
          const assessment = assessPrimaryPlanBudget(job.id, primaryText);
          const budgetFailure = assessment.state === 'rejected'
            ? assessment.reason
            : planPassError ? 'plan-output-token-sub-budget-exceeded' : null;
          if (budgetFailure || completed.turn.status === 'failed') {
            const retry = budgetFailure
              ? beginPrimaryPlanRetry(job.id, assessment, budgetFailure)
              : null;
            if (retry) {
              planPassError = null;
              await startTurn(planRetryPrompt(
                promptFor(loadJob(job.id)),
                { provider: job.provider, model: job.model },
                retry.retryLimit
              ), 'read-only');
              continue;
            }
            const reason = budgetFailure || 'provider-plan-turn-failed';
            recordPrimaryPlanDegradation(
              job.id,
              reason,
              assessment
            );
            presentDegradedPlanForConfirmation(job.id, reason);
            planPhase = 'awaiting-confirmation';
            turnDone = new Promise(() => {});
            turnResolve = null;
            continue;
          }
          const planned = await presentPlanForConfirmation(job.id, primaryText);
          planPhase = 'awaiting-confirmation';
          turnDone = new Promise(() => {});
          turnResolve = null;
          continue;
        }
        if (queuedPrompts.length) {
          const next = queuedPrompts.shift();
          settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: next.appliedAs });
          appendJobEvent(job.id, next.appliedAs === 'restart' ? 'correction.restarted' : 'correction.applied', { commandId: next.commandId, appliedAs: next.appliedAs });
          await startTurn(next.text);
          continue;
        }
        if (completed.turn.status !== 'failed' && prepareAutoNudge(job.id)) {
          await startTurn(AUTO_NUDGE_PROMPT);
          continue;
        }
        const status = completed.turn.status === 'failed' ? 'failed' : 'completed';
        terminal(job, status, status, completed.turn.error ? { error: completed.turn.error } : {});
        break;
      }
    }
  } finally {
    activity.close();
    await childSubscriptions.close('parent-terminal');
    await driver.close(() => rpc.stop());
  }
}

// Fail closed on unknown model ids: a silent fallback would report
// "completed" for a model the caller never requested. Advertised ACP option
// values may be attribute-serialized ("grok-4.5[effort=high,fast=true]")
// while callers use CLI-style suffixed ids ("grok-4.5-high"), bare bases, or
// shorthands; both sides are normalized to {base, effort, fast} and matched
// structurally. Anything that cannot be matched raises INVALID_MODEL. Without
// an advertised list there is nothing to validate against, so legacy
// resolution applies.
const EFFORT_RANK = { xhigh: 4, high: 3, medium: 2, low: 1 };

function parseCursorModelId(value) {
  const attrMatch = String(value).match(/^(.*?)\[(.*)\]$/);
  let base = attrMatch ? attrMatch[1] : String(value);
  const attrs = {};
  if (attrMatch && attrMatch[2]) {
    for (const pair of attrMatch[2].split(',')) {
      const [key, raw] = pair.split('=');
      if (key) attrs[key.trim()] = (raw ?? '').trim();
    }
  }
  let effort = attrs.effort || null;
  const suffix = base.match(/^(.*)-(xhigh|high|medium|low)$/);
  if (!effort && suffix) {
    base = suffix[1];
    effort = suffix[2];
  }
  let fast = attrs.fast === 'true';
  const fastSuffix = base.match(/^(.*)-fast$/);
  if (fastSuffix) {
    base = fastSuffix[1];
    fast = true;
  }
  return { value: String(value), base, effort, fast };
}

export function cursorModelDetailed(options, requested) {
  const values = options.map((item) => item.value);
  if (!values.length) return { value: resolveCursorModel(requested, []), fastCompromise: false };
  if (values.includes(requested)) return { value: requested, fastCompromise: false };
  const parsed = values.map(parseCursorModelId);
  const isGrokBase = (base) => /^(?:cursor-)?grok-/.test(base);
  // Fast variants are opt-in: the default pool is non-fast, and a fast
  // variant is selected only when the request itself says fast. When the
  // preferred pool is empty the other variant still resolves — fast/non-fast
  // is a latency preference, not a model identity, so it must not fail closed.
  const pick = (candidates, wantEffort, wantFast = false) => {
    let pool = candidates.filter((item) => item.fast === wantFast);
    if (!pool.length) pool = candidates;
    if (wantEffort) {
      pool = pool.filter((item) => item.effort === wantEffort);
      if (!pool.length) return null;
    }
    pool = [...pool].sort((a, b) =>
      ((EFFORT_RANK[b.effort] || 0) - (EFFORT_RANK[a.effort] || 0))
      || b.base.replace(/^cursor-/, '').localeCompare(a.base.replace(/^cursor-/, ''), undefined, { numeric: true }));
    return pool[0] || null;
  };
  if (!requested || requested === 'auto') {
    const value = values.find((item) => item === 'default[]')
      || parsed.find((item) => item.base === 'auto' || item.base === 'default')?.value
      || null;
    return { value, fastCompromise: false };
  }
  let resolved = null;
  let wantFast = false;
  if (requested === 'composer') {
    resolved = pick(parsed.filter((item) => item.base.startsWith('composer-')), null);
  } else if (requested === 'grok' || requested === 'grok-high') {
    resolved = pick(parsed.filter((item) => isGrokBase(item.base)), 'high');
  } else if (requested === 'grok-xhigh') {
    resolved = pick(parsed.filter((item) => isGrokBase(item.base)), 'xhigh');
  } else if (requested === 'grok-fast') {
    wantFast = true;
    resolved = pick(parsed.filter((item) => isGrokBase(item.base)), 'high', true);
  } else {
    const want = parseCursorModelId(requested);
    wantFast = want.fast;
    let family = parsed.filter((item) => item.base === want.base);
    if (!family.length) family = parsed.filter((item) => item.base.startsWith(`${want.base}-`));
    // CLI catalogs prefix first-party Grok ids with "cursor-"; tolerate the
    // documented unprefixed form against a prefixed catalog.
    if (!family.length) family = parsed.filter((item) => item.base === `cursor-${want.base}` || item.base.startsWith(`cursor-${want.base}-`));
    if (family.length) resolved = pick(family, want.effort, want.fast);
  }
  if (resolved) {
    return { value: resolved.value, fastCompromise: resolved.fast === true && wantFast !== true };
  }
  throw brokerError('INVALID_MODEL', `'${requested}' is not in this account's model list; run agent models or cursor-agent models. Available: ${values.slice(0, 25).join(', ')}`, { provider: 'cursor' });
}

export function cursorModel(options, requested) {
  return cursorModelDetailed(options, requested).value;
}

// Codex threads that engaged the auto-review sub-agent (write-mode approval
// flows) may refuse direct resume with a multi-agent v2 error; surface that as
// an actionable code instead of a cryptic provider message.
function mapCodexResumeError(error, isResume) {
  if (isResume && /multi-agent v2|not allowed for .*sub-agents/i.test(error?.message || '')) {
    return brokerError('RESUME_UNSUPPORTED', 'this Codex thread cannot be resumed directly (it engaged the multi-agent review flow); start a fresh job with a full task packet that folds in prior findings', { provider: 'codex' });
  }
  return normalizeBrokerError(error, { provider: 'codex', defaultCode: 'TRANSPORT_ERROR' });
}

function planEntriesText(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  return entries
    .map((entry, index) => `${index + 1}. ${entry.content ?? entry.title ?? JSON.stringify(entry)}${entry.status ? ` [${entry.status}]` : ''}`)
    .join('\n');
}

const CURSOR_NETWORK_READ_ONLY_PREAMBLE = [
  'CURSOR NETWORK MODE ELEVATION: this read-only job is running in agent mode only because Cursor ask/plan modes categorically block network tools.',
  'Remain strictly read-only: do not create, edit, rename, or delete files; do not run destructive commands; do not change repository, system, or remote state.'
].join('\n');

function cursorPrompt(job, text) {
  const network = job.network === true && readOnly(job) ? `${CURSOR_NETWORK_READ_ONLY_PREAMBLE}\n\n` : '';
  return `${network}${CONVERSATIONAL_DELEGATION_PREAMBLE}\n\n${text}`;
}

function prepareCursorNetwork(job, transport) {
  let materialized;
  try {
    materialized = materializeCursorNetworkPolicy(job, (type, data) => appendJobEvent(job.id, type, { ...data, transport }));
    const preflight = evaluateCursorNetworkPreflight(job, materialized.policy);
    appendJobEvent(job.id, 'network.preflight', { ...preflight, transport });
    if (preflight.modeElevated) {
      appendJobEvent(job.id, 'network.mode-elevated', {
        requestedMode: job.mode,
        effectiveMode: 'agent',
        reason: 'Cursor ask/plan modes reject network tools; the injected preamble preserves strict read-only intent'
      });
    }
    return materialized;
  } catch (error) {
    materialized?.cleanup?.();
    throw error;
  }
}

export class EphemeralCursorActivity {
  constructor(marker, limit = 2048) {
    this.marker = marker;
    this.limit = limit;
    this.tail = '';
  }

  thinking(text = '') {
    this.tail = `${this.tail}${String(text || '')}`.slice(-this.limit);
    this.marker?.mark('thinking');
  }

  output() {
    this.tail = '';
    this.marker?.mark('output');
  }
}

function replayFingerprint(sessionId, update) {
  return crypto.createHash('sha256').update(`${sessionId || ''}\0${JSON.stringify(update)}`).digest('hex').slice(0, 32);
}

function claimReplay(jobId, sessionId, update) {
  const fingerprint = replayFingerprint(sessionId, update);
  const current = loadJob(jobId);
  const prior = new Set(current?.cursorReplayFingerprints || []);
  if (prior.has(fingerprint)) return null;
  prior.add(fingerprint);
  updateManagedJob(jobId, (job) => { job.cursorReplayFingerprints = [...prior].slice(-2048); }, { incrementRevision: false });
  return fingerprint;
}

function nestedDiffs(value, result = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  if (typeof value.path === 'string' && (typeof value.oldText === 'string' || typeof value.newText === 'string')) {
    result.push({ path: value.path, oldText: value.oldText || '', newText: value.newText || '' });
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) nestedDiffs(child, result, seen);
  return result;
}

function unifiedCursorDiff(change) {
  const before = String(change.oldText || '').split('\n').map((line) => `-${line}`).join('\n');
  const after = String(change.newText || '').split('\n').map((line) => `+${line}`).join('\n');
  return `diff --git a/${change.path} b/${change.path}\n--- a/${change.path}\n+++ b/${change.path}\n@@ -1 +1 @@\n${before}\n${after}\n`;
}

function recordAcpDiffs(jobId, update, options) {
  const changes = nestedDiffs(update);
  if (!changes.length) return;
  const normalized = changes.map((change) => {
    const kind = !change.oldText ? 'create' : !change.newText ? 'delete' : 'edit';
    return { ...change, kind, source: 'cursor-acp' };
  });
  appendJobEvent(jobId, 'file.changed', { changes: normalized, source: 'cursor-acp' }, options);
  appendJobEvent(jobId, 'diff.updated', { diff: changes.map(unifiedCursorDiff).join(''), source: 'cursor-acp' }, options);
}

function cursorProviderIdentifiers(value) {
  return [...new Set(String(value ?? '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];
}

function cursorToolIdentity(value, context = {}) {
  const identifiers = cursorProviderIdentifiers(value);
  if (!identifiers.length) return { toolCallId: undefined, providerToolCallIds: [] };
  const aliases = context.toolCallAliases || (context.toolCallAliases = new Map());
  let identity = identifiers.map((identifier) => aliases.get(identifier)).find(Boolean);
  if (!identity) identity = { canonical: identifiers[0], aliases: [...identifiers] };
  else identity.aliases = [...new Set([...identity.aliases, ...identifiers])];
  for (const identifier of identity.aliases) aliases.set(identifier, identity);
  return { toolCallId: identity.canonical, providerToolCallIds: [...identity.aliases] };
}

function acpToolContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(acpToolContentText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'content') return acpToolContentText(content.content);
  if (content.content?.type === 'text' || typeof content.content === 'string') return acpToolContentText(content.content);
  return '';
}

function boundedToolOutput(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(redact(value));
  return redact(text, '', 16384);
}

function acpToolData(update, context = {}) {
  const rawOutput = update.rawOutput ?? update.output?.rawOutput ?? null;
  const content = update.content ?? update.output?.content ?? null;
  const args = update.rawInput ?? update.args ?? update.input ?? update.toolCall?.rawInput ?? update.toolCall?.args ?? update.toolCall?.input ?? null;
  const requestedSandboxPolicy = findValue(update, ['requestedSandboxPolicy']);
  const identity = cursorToolIdentity(update.toolCallId ?? update.callId ?? update.id, context);
  const output = acpToolContentText(content)
    || [rawOutput?.stdout, rawOutput?.stderr].filter((value) => value != null && value !== '').join('\n')
    || boundedToolOutput(rawOutput);
  return {
    toolCallId: identity.toolCallId,
    ...(identity.providerToolCallIds.length > 1 ? { providerToolCallIds: identity.providerToolCallIds } : {}),
    title: update.title || update.name,
    kind: update.kind || update.toolKind || update.type,
    status: update.status,
    locations: update.locations,
    args,
    ...(requestedSandboxPolicy ? { requestedSandboxPolicy } : {}),
    rawOutput,
    content,
    output
  };
}

function acpMessageAccumulator(context = {}) {
  return context.messageAccumulator || (context.messageAccumulator = {
    active: null,
    completed: [],
    nextAnonymousId: 0
  });
}

export function completeCursorAcpMessage(job, context = {}) {
  const accumulator = acpMessageAccumulator(context);
  const active = accumulator.active;
  if (!active?.parts?.length) return null;
  const text = active.parts.join('');
  appendJobEvent(job.id, 'message.completed', { id: active.id, text }, {
    sessionId: context.sessionId,
    replay: context.replay === true
  });
  accumulator.completed.push(text);
  accumulator.active = null;
  return text;
}

function cursorAcpMessageText(messageAccumulator, messageParts = []) {
  const completed = messageAccumulator?.completed || [];
  return completed.length ? completed.join('\n') : messageParts.join('');
}

export function mapCursorAcpUpdate(job, update, context = {}) {
  const jobId = job.id;
  const kind = update.sessionUpdate;
  const sessionId = context.sessionId;
  const replay = context.replay === true;
  const replayId = replay ? claimReplay(jobId, sessionId, update) : null;
  if (replay && !replayId) return undefined;
  const options = { sessionId, replay };
  const eventData = (value) => replay ? { ...value, replayId } : value;
  const signal = cursorAcpActivitySignal(update);
  if (signal && !replay) {
    if (signal === 'thinking') context.ephemeral?.thinking(update.content?.text || update.text || '');
    else context.ephemeral?.output();
  }
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text || '';
    let messageId = update.messageId == null ? null : cursorProviderIdentifiers(update.messageId)[0] || null;
    if (!replay) {
      const accumulator = acpMessageAccumulator(context);
      if (accumulator.active && accumulator.active.providerId !== messageId) completeCursorAcpMessage(job, context);
      if (!accumulator.active) {
        messageId ||= `acp-message-${++accumulator.nextAnonymousId}`;
        accumulator.active = { id: messageId, providerId: update.messageId == null ? null : messageId, parts: [] };
      }
      accumulator.active.parts.push(text);
      context.messageParts?.push(text);
      messageId = accumulator.active.id;
    }
    appendJobEvent(jobId, 'message.delta', eventData({ id: messageId, delta: context.deltas.redactDelta(`message:${messageId ?? 'acp'}`, text) }), options);
  } else if (kind === 'user_message_chunk') {
    appendJobEvent(jobId, 'message.user', eventData({ text: context.deltas.redactDelta(`user:${update.messageId ?? 'acp'}`, update.content?.text || update.text || '') }), options);
  } else if (kind === 'plan' || kind === 'plan_update') {
    appendJobEvent(jobId, 'plan.updated', eventData(update), options);
    // Plan-mode output arrives here, not as agent message chunks; hold the
    // latest entries so the terminal result can carry the actual plan.
    const entries = update.entries || update.plan?.entries || null;
    if (!replay && context.planHolder && entries) context.planHolder.entries = entries;
  } else if (kind === 'tool_call') {
    if (!replay && acpMessageAccumulator(context).active?.providerId == null) completeCursorAcpMessage(job, context);
    appendJobEvent(jobId, 'tool.started', eventData(acpToolData(update, context)), options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
    recordAcpDiffs(jobId, update, options);
  } else if (kind === 'tool_call_update') {
    if (!replay && acpMessageAccumulator(context).active?.providerId == null) completeCursorAcpMessage(job, context);
    const tool = acpToolData(update, context);
    const terminalStatus = ['completed', 'failed', 'cancelled', 'rejected'].includes(String(update.status || '').toLowerCase());
    const raw = tool.rawOutput;
    const hasContent = Array.isArray(tool.content) ? tool.content.length > 0 : tool.content != null;
    const hasResult = hasContent || raw != null;
    if (tool.output || hasResult) {
      appendJobEvent(jobId, 'tool.output', eventData({
        toolCallId: tool.toolCallId,
        ...(tool.providerToolCallIds ? { providerToolCallIds: tool.providerToolCallIds } : {}),
        output: redact(tool.output, '', 16384),
        ...(raw?.stdout != null ? { stdout: redact(raw.stdout, '', 16384) } : {}),
        ...(raw?.stderr != null ? { stderr: redact(raw.stderr, '', 16384) } : {}),
        ...(raw?.exitCode != null ? { exitCode: raw.exitCode } : {})
      }), options);
    } else if (!terminalStatus) {
      appendJobEvent(jobId, 'tool.status', eventData({ toolCallId: tool.toolCallId, title: tool.title, status: tool.status }), options);
    }
    if (terminalStatus) appendJobEvent(jobId, 'tool.completed', eventData({
      ...tool,
      rawOutput: undefined,
      content: undefined,
      ...(hasResult ? { result: redact(hasContent ? tool.content : raw, '', 16384) } : {}),
      exitCode: raw?.exitCode
    }), options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
    recordAcpDiffs(jobId, update, options);
  } else if (kind === 'agent_thought_chunk') {
    // Hidden reasoning stays process-local. The content-free marker gives the
    // TUI activity without journaling any thought text.
    if (replay) appendJobEvent(jobId, 'activity', eventData({ kind: 'thinking' }), options);
  } else if (kind === 'usage_update') {
    if (!replay) {
      const occupancy = {
        contextUsed: Number(update.used || 0),
        contextSize: Number(update.size || 0),
        ...(update.cost != null ? { cost: redact(update.cost) } : {})
      };
      appendJobEvent(jobId, 'usage.context', occupancy, options);
      updateManagedJob(jobId, (current) => { current.contextOccupancy = occupancy; }, { incrementRevision: false });
    }
  } else if (kind === 'session_info_update') {
    appendJobEvent(jobId, 'session.updated', eventData({ title: update.title || update.sessionTitle || null, model: update.model || null }), options);
    if (!replay && (update.title || update.sessionTitle)) {
      updateManagedJob(jobId, (current) => { current.sessionTitle = update.title || update.sessionTitle; }, { incrementRevision: false });
    }
    if (update.model) {
      // The session's own report is the ground truth for resolvedModel, but a
      // silent overwrite hid fast-variant swaps from coordinators; disagreement
      // with the negotiated value must be loud.
      const current = loadJob(jobId);
      if (current?.resolvedModel && current.resolvedModel !== update.model) {
        appendJobEvent(jobId, 'provider.event', { providerEvent: 'cursor:model-mismatch', negotiated: current.resolvedModel, reported: update.model }, options);
      }
      if (!replay) updateManagedJob(jobId, (current) => { current.resolvedModel = update.model; }, { incrementRevision: false });
    }
  } else if (kind === 'current_mode_update') {
    appendJobEvent(jobId, 'mode.updated', eventData({ mode: update.mode || update.currentMode || update }), options);
    if (!replay) updateManagedJob(jobId, (current) => { current.cursorMode = update.mode || update.currentMode || null; }, { incrementRevision: false });
  } else if (kind === 'available_commands_update') {
    appendJobEvent(jobId, 'commands.updated', eventData({ commands: update.availableCommands || update.commands || [] }), options);
  } else if (kind === 'config_option_update') {
    appendJobEvent(jobId, 'config.updated', eventData(update), options);
    if (update.configId === 'model' || update.id === 'model') appendJobEvent(jobId, 'model.updated', eventData({ model: update.value }), options);
    if (update.configId === 'mode' || update.id === 'mode') appendJobEvent(jobId, 'mode.updated', eventData({ mode: update.value }), options);
  } else {
    appendJobEvent(jobId, 'provider.event', eventData({ providerEvent: `session/update:${kind}` }), options);
  }
  return undefined;
}

export function mapCursorAcpNotification(job, method, params = {}, sessionId = null) {
  if (method === 'cursor/update_todos') {
    appendJobEvent(job.id, 'plan.updated', { ...params, merge: params.merge === true }, { sessionId });
  } else if (method === 'cursor/task') {
    recordSubagentCandidates(job.id, normalizeSubagentLifecycle({
      source: 'cursor-task',
      provider: 'cursor',
      transport: 'acp',
      sessionId,
      payload: params
    }), { sessionId });
  } else if (method === 'cursor/generate_image') {
    appendJobEvent(job.id, 'artifact.created', { kind: 'image', ...params }, { sessionId });
  } else {
    appendJobEvent(job.id, 'provider.event', { providerEvent: method }, { sessionId });
  }
}

function gitWorkspaceState(job) {
  const cwd = job.cwd;
  const options = { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  if (status.status !== 0) return { diff: '', files: [], error: (status.stderr || 'git status failed').trim() };
  const entries = status.stdout.split('\0').filter(Boolean);
  const files = [];
  let revisionInventoryError = null;
  const baseline = new Set(job.baselineFiles || []);
  const sensitive = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private.?key|token)[^/]*|[^/]+\.(?:pem|key|p12|pfx|crt|cer))$/i;
  const internalRoot = job.promptPath ? path.relative(cwd, path.dirname(job.promptPath)) : null;
  const isInternal = (file) => (internalRoot && internalRoot !== '..' && !internalRoot.startsWith(`..${path.sep}`)
    && (file === internalRoot || file.startsWith(`${internalRoot}/`)))
    || (job.observationExclude || []).some((root) => {
      const absolute = path.resolve(cwd, file);
      return absolute === root || absolute.startsWith(`${root}${path.sep}`);
    });
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const statusCode = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file && !isInternal(file)) files.push({ path: file, status: statusCode, preexisting: baseline.has(file), contentExcluded: sensitive.test(file) });
    if (/[RC]/.test(statusCode) && entries[i + 1]) {
      const source = entries[++i];
      if (!isInternal(source)) files.push({ path: source, status: `${statusCode}:source`, preexisting: baseline.has(source), contentExcluded: sensitive.test(source) });
    }
  }
  if (/^[a-f0-9]{40,64}$/.test(job.baseRevision || '')) {
    const revisionDiff = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--no-renames', job.baseRevision, '--'], options);
    if (revisionDiff.status !== 0) revisionInventoryError = 'immutable-base file inventory unavailable';
    else {
      const changed = revisionDiff.stdout.split('\0').filter(Boolean);
      for (let i = 0; i + 1 < changed.length; i += 2) {
        const file = changed[i + 1];
        if (!isInternal(file) && !files.some((item) => item.path === file)) files.push({
          path: file, status: changed[i], preexisting: baseline.has(file), contentExcluded: sensitive.test(file)
        });
      }
    }
  }
  let diff = '';
  let includesPreexisting = false;
  const errors = revisionInventoryError ? [revisionInventoryError] : [];
  const inventoryDeadline = Date.now() + 10_000;
  const baselineHashes = job.baselineHashes || {};
  // A formerly dirty path can disappear from status when the worker restores
  // HEAD. That is still a change relative to the job-start baseline.
  for (const file of baseline) {
    if (!files.some((item) => item.path === file) && !isInternal(file)
      && baselineHashes[file] && hashWorkingFile(cwd, file) !== baselineHashes[file]) {
      files.push({ path: file, status: ' M', preexisting: true, overlapsPreexisting: true, contentExcluded: sensitive.test(file) });
    }
  }
  const limit = Math.min(files.length, 1000);
  if (files.length > limit) errors.push(`file inventory capped at ${limit} of ${files.length}`);
  for (const item of files.slice(0, limit)) {
    if (Date.now() >= inventoryDeadline) { errors.push('Git inventory time bound exceeded'); break; }
    options.timeout = Math.max(1, Math.min(5000, inventoryDeadline - Date.now()));
    if (item.preexisting && !job.baselineHashes?.[item.path] && job.baselineMetadata?.[item.path]
      && job.baselineMetadata[item.path] === fileMetadata(cwd, item.path)) {
      item.unchangedSinceBaseline = true;
      continue;
    }
    if (item.contentExcluded) continue;
    if (item.preexisting) {
      // A path-only baseline cannot distinguish "job merely read this dirty
      // file" from "job added to it"; the content hash captured at job start
      // can. Unknown hashes (large/unreadable, or pre-upgrade job records)
      // fall through to the old include-everything behavior.
      const before = baselineHashes[item.path];
      const now = before ? hashWorkingFile(cwd, item.path) : null;
      if (before && now && before === now) {
        item.unchangedSinceBaseline = true;
        continue;
      }
      if (before && now) item.overlapsPreexisting = true;
    }
    let result;
    if (item.status === '??') {
      // Even modified pre-existing untracked bodies belong to the owner.
      if (item.preexisting) continue;
      try {
        if (fs.statSync(path.join(cwd, item.path)).size > 5 * 1024 * 1024) {
          errors.push(`untracked file too large to diff: ${item.path}`);
          continue;
        }
      } catch { continue; }
      result = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', item.path], options);
      if (result.status !== 0 && result.status !== 1) errors.push((result.stderr || `cannot diff untracked file ${item.path}`).trim());
    } else {
      result = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', job.baseRevision || 'HEAD', '--', item.path], options);
      if (result.status !== 0) {
        const cached = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--', item.path], options);
        const unstaged = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--', item.path], options);
        result = { status: cached.status || unstaged.status, stdout: `${cached.stdout || ''}${unstaged.stdout || ''}`, stderr: cached.stderr || unstaged.stderr };
      }
      if (result.status !== 0) errors.push((result.stderr || `cannot diff tracked file ${item.path}`).trim());
    }
    if (result?.stdout) {
      if (Buffer.byteLength(diff) + Buffer.byteLength(result.stdout) > 8 * 1024 * 1024) {
        errors.push('shared-tree diff byte bound exceeded');
        break;
      }
      diff += result.stdout;
      if (item.preexisting) includesPreexisting = true;
    }
  }
  return { diff, files, includesPreexisting, error: errors.filter(Boolean).join('; ') || null };
}

export function recordGitState(job, sessionId, options = {}) {
  if (job.filesystemBaselinePath || job.filesystemBaseline) {
    let before = job.filesystemBaseline;
    try {
      if (!before) {
        const expected = path.join(path.dirname(job.promptPath), `${job.id}.artifacts`, 'filesystem-baseline.json');
        if (job.filesystemBaselinePath !== expected || fs.lstatSync(expected).isSymbolicLink() || fs.statSync(expected).size > 16 * 1024 * 1024) throw new Error('invalid filesystem baseline');
        before = JSON.parse(fs.readFileSync(expected, 'utf8'));
      }
      if (!before || typeof before.complete !== 'boolean' || !before.files || typeof before.files !== 'object'
        || Array.isArray(before.files) || Object.keys(before.files).length > 5000) throw new Error('invalid filesystem baseline shape');
    } catch {
      updateManagedJob(job.id, (current) => { current.changeObservation = { source: 'filesystem', state: 'unavailable', diffAvailable: false }; }, { incrementRevision: false });
      appendJobEvent(job.id, 'provider.event', { providerEvent: 'filesystem-inventory-warning', error: 'Private filesystem baseline unavailable; acceptance remains blocked' }, { sessionId });
      return { files: [], diff: '', error: 'filesystem baseline unavailable' };
    }
    const after = observeDirectory(job.cwd, { exclude: job.observationExclude });
    const files = compareDirectoryObservations(before, after);
    for (const file of files) appendJobEvent(job.id, 'file.changed', file, { sessionId });
    const complete = before.complete && after.complete;
    updateManagedJob(job.id, (current) => { current.changeObservation = { source: 'filesystem', state: complete ? 'complete' : 'partial', diffAvailable: false }; }, { incrementRevision: false });
    if (!complete) appendJobEvent(job.id, 'provider.event', { providerEvent: 'filesystem-inventory-warning', error: 'Bounded filesystem inventory incomplete; acceptance remains blocked' }, { sessionId });
    return { files, diff: '', error: complete ? null : 'filesystem inventory incomplete' };
  }
  const state = gitWorkspaceState(job);
  updateManagedJob(job.id, (current) => { current.changeObservation = { source: 'git', state: state.error ? 'partial' : 'complete', diffAvailable: Boolean(state.diff) }; }, { incrementRevision: false });
  const changed = state.files.filter((file) => !file.unchangedSinceBaseline);
  const counts = options.includeLineCounts === true
    ? new Map(diffStat(state.diff).files.map((file) => [file.path, { added: file.additions, removed: file.deletions }]))
    : new Map();
  for (const file of state.files) {
    // Pre-existing files proven byte-identical to the job-start baseline were
    // at most read, never changed — emitting file.changed for them is exactly
    // the attribution noise this filter removes.
    if (file.unchangedSinceBaseline) continue;
    appendJobEvent(job.id, 'file.changed', { ...file, ...counts.get(file.path) }, { sessionId });
  }
  if (state.diff) appendJobEvent(job.id, 'diff.updated', { diff: state.diff, includesPreexistingChanges: state.includesPreexisting === true }, { sessionId });
  if (state.error) appendJobEvent(job.id, 'provider.event', { providerEvent: 'git-inventory-warning', error: state.error }, { sessionId });
  const limit = largeWriteLimit();
  if (changed.length > limit && !loadJob(job.id)?.largeWrite) {
    updateManagedJob(job.id, (current) => {
      current.largeWrite = true;
      current.largeWriteCount = changed.length;
    }, { incrementRevision: false });
    appendJobEvent(job.id, 'large.write', { count: changed.length, limit, enforcement: 'post-hoc' }, { sessionId });
  }
  return state;
}

function cursorAcpArgs(job) {
  const sandboxValue = job.sandbox === 'off' ? 'disabled' : 'enabled';
  const elevated = job.network === true && readOnly(job);
  const force = job.approval === 'force' || (job.network === true && job.sandbox === 'off');
  const args = [];
  if (force) args.push('--force');
  else if (!readOnly(job) || elevated) args.push('--auto-review');
  args.push('--sandbox', sandboxValue);
  for (const directory of job.addDirs || []) args.push('--add-dir', directory);
  if (job.approveMcps) args.push('--approve-mcps');
  if (job.cursorWorktree) args.push('--worktree');
  if (job.cursorWorktreeBase) args.push('--worktree-base', job.cursorWorktreeBase);
  args.push('acp');
  return args;
}

export async function probeCodexAppServerCapabilities(options = {}) {
  const binary = options.binary || process.env.DELEGATE_CODEX_BIN || 'codex';
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number(options.timeoutMs || 10000);
  const report = {
    probeVersion: 1,
    binary,
    ok: false,
    noTurn: true,
    version: detectProviderCliVersion('codex', binary)
  };
  const rpc = new JsonRpcProcess(binary, ['app-server', '--stdio'], {
    cwd,
    requestTimeoutMs: timeoutMs,
    onRequest: async () => ({})
  });
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'delegate-router-capability-probe', title: 'Delegate Router capability probe', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }, timeoutMs);
    rpc.notify('initialized', {});
    report.ok = true;
    report.initialize = true;
  } catch (error) {
    report.errorCode = error.code || 'APP_SERVER_HANDSHAKE_FAILED';
    report.error = redact(error.message, '', 2000);
  } finally {
    await rpc.stop();
  }
  let schemaDirectory = null;
  try {
    schemaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-codex-schema-'));
    const generated = spawnSync(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDirectory], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    if (generated.status === 0) {
      const pending = [schemaDirectory];
      const chunks = [];
      let bytes = 0;
      while (pending.length && bytes < 8 * 1024 * 1024) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else if (entry.isFile() && entry.name.endsWith('.json')) {
            const text = fs.readFileSync(file, 'utf8');
            bytes += Buffer.byteLength(text);
            if (bytes <= 8 * 1024 * 1024) chunks.push(text);
          }
        }
      }
      const schema = chunks.join('\n');
      report.protocolSchema = {
        generated: true,
        boundedBytes: bytes,
        sameTurnSteering: /turn[\/._-]?steer|TurnSteer/i.test(schema),
        liveShellStdout: /commandExecution[\/._-]?outputDelta|CommandExecutionOutputDelta/i.test(schema),
        midTurnTokenUsage: /thread[\/._-]?tokenUsage[\/._-]?updated|ThreadTokenUsageUpdated/i.test(schema),
        mcpInjection: /mcp_servers|mcpServers/.test(schema)
      };
    } else {
      report.protocolSchema = {
        generated: false,
        errorCode: generated.error?.code || 'SCHEMA_GENERATION_FAILED'
      };
    }
  } catch (error) {
    report.protocolSchema = {
      generated: false,
      errorCode: error.code || 'SCHEMA_GENERATION_FAILED'
    };
  } finally {
    if (schemaDirectory) {
      try { fs.rmSync(schemaDirectory, { recursive: true, force: true }); } catch {}
    }
  }
  return report;
}

export async function probeCursorAcpCapabilities(options = {}) {
  const binary = options.binary || resolveCursorBinary();
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number(options.timeoutMs || 10000);
  const report = {
    probeVersion: 1,
    binary: binary || null,
    ok: false,
    noTurn: true,
    version: binary ? detectProviderCliVersion('cursor', binary) : null,
    observedClientRequests: [],
    honorsClientCapabilities: { terminal: false, fsRead: false, fsWrite: false }
  };
  if (!binary) return { ...report, errorCode: 'CURSOR_NOT_INSTALLED' };
  const launch = cursorLaunchCommand(binary, ['--sandbox', 'enabled', 'acp']);
  let stderr = '';
  const requests = new Set();
  const rpc = new JsonRpcProcess(launch.command, launch.args, {
    cwd,
    requestTimeoutMs: timeoutMs,
    onStderr: (text) => { stderr = `${stderr}${text}`.slice(-4000); },
    onRequest: async (method) => {
      requests.add(method);
      return {};
    }
  });
  try {
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'delegate-router-capability-probe', version: '1' }
    }, timeoutMs);
    const session = await rpc.request('session/new', { cwd, mcpServers: [] }, timeoutMs);
    const capabilities = initialized.capabilities || initialized.agentCapabilities || {};
    report.ok = true;
    report.initialize = {
      loadSession: capabilities.loadSession ?? initialized.loadSession ?? false,
      sessionList: capabilities.sessionList ?? capabilities.listSessions ?? false,
      resumeSession: capabilities.resumeSession ?? false,
      modes: initialized.modes || [],
      models: initialized.models || []
    };
    report.configOptionIds = (session.configOptions || []).map((item) => item.id).filter(Boolean);
    const modeOption = (session.configOptions || []).find((item) => item.id === 'mode');
    const modeValues = [
      ...(Array.isArray(initialized.modes) ? initialized.modes : []),
      ...(Array.isArray(session.modes?.availableModes) ? session.modes.availableModes : []),
      ...(Array.isArray(modeOption?.options) ? modeOption.options : [])
    ].map((item) => String(typeof item === 'string' ? item : item?.value || item?.id || '')).filter(Boolean);
    report.planMode = modeValues.includes('plan');
    if (options.includeCatalog === true) {
      report.session = redact({
        models: session.models || null,
        configOptions: session.configOptions || []
      });
    }
  } catch (error) {
    const project = cursorProjectConfigFailure(stderr, cwd);
    report.errorCode = project?.code || error.code || 'ACP_HANDSHAKE_FAILED';
    report.error = redact(project?.message || error.message, '', 2000);
  } finally {
    await rpc.stop();
  }
  report.observedClientRequests = [...requests];
  report.honorsClientCapabilities = {
    terminal: report.observedClientRequests.some((method) => method.startsWith('terminal/')),
    fsRead: report.observedClientRequests.some((method) => /fs\/read/i.test(method)),
    fsWrite: report.observedClientRequests.some((method) => /fs\/write/i.test(method))
  };
  return report;
}

export function probeCursorHeadlessCapabilities(options = {}) {
  const binary = options.binary || resolveCursorBinary();
  const timeoutMs = Number(options.timeoutMs || 10000);
  const report = {
    probeVersion: 1,
    binary: binary || null,
    ok: false,
    noTurn: true,
    version: binary ? detectProviderCliVersion('cursor', binary) : null,
    planMode: false,
    mcpInjection: false
  };
  if (!binary) return { ...report, errorCode: 'CURSOR_NOT_INSTALLED' };
  const launch = cursorLaunchCommand(binary, ['--help'], false);
  const result = spawnSync(launch.command, launch.args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  report.ok = result.status === 0;
  report.planMode = /--mode\b/.test(output) && /\bplan\b/i.test(output);
  report.mcpInjection = /--plugin-dir\b/.test(output) && /--approve-mcps\b/.test(output);
  if (!report.ok) {
    report.errorCode = result.error?.code || 'HEADLESS_HELP_FAILED';
    report.error = redact(output.trim() || result.error?.message || 'Cursor headless help failed', '', 2000);
  }
  return report;
}

function normalizedPermissionContext(params, cwd) {
  const toolCall = params.toolCall || params.tool_call || params;
  const values = [];
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (typeof child === 'string' && /^(?:path|file|filePath|cwd)$/i.test(name)) values.push(child);
      else if (child && typeof child === 'object') visit(child, name);
    }
  };
  visit(toolCall);
  const rawDomain = findValue(toolCall, ['domain', 'hostname', 'url']);
  let domain = rawDomain;
  if (typeof rawDomain === 'string' && /^https?:\/\//i.test(rawDomain)) {
    try { domain = new URL(rawDomain).hostname; } catch {}
  }
  const rawCommand = findValue(toolCall, ['command', 'commandLine', 'shellCommand']);
  const command = Array.isArray(rawCommand) ? rawCommand.join(' ') : typeof rawCommand === 'string' ? rawCommand : null;
  const toolKind = String(findValue(toolCall, ['kind', 'toolKind', 'type', 'name', 'title']) || 'unknown');
  const shellLike = /shell|terminal|command/i.test(toolKind);
  const paths = [];
  const outsidePaths = [];
  for (const value of new Set(values)) {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
    const relative = path.relative(cwd, absolute);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) paths.push(relative.replaceAll('\\', '/'));
    else if (!relative) paths.push('.');
    else outsidePaths.push(absolute);
  }
  return {
    toolKind,
    paths: paths.slice(0, 64),
    ...(outsidePaths.length ? { outsidePaths: outsidePaths.slice(0, 64) } : {}),
    domain: domain || null,
    command,
    ambiguous: shellLike && !command
  };
}

function cursorInputTimeoutMs() {
  const milliseconds = Number(process.env.DELEGATE_CURSOR_INPUT_TIMEOUT_MS);
  if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.min(milliseconds, 86400000);
  const seconds = Number(process.env.DELEGATE_CURSOR_INPUT_TIMEOUT_SECONDS ?? 300);
  return (Number.isFinite(seconds) ? Math.min(Math.max(seconds, 10), 86400) : 300) * 1000;
}

function cursorInputResponse(method, command) {
  if (command.response && typeof command.response === 'object') return command.response;
  if (method === 'cursor/create_plan') return { approved: command.accept === true, ...(command.answer ? { feedback: command.answer } : {}) };
  return { answer: command.answer ?? (command.accept === true ? 'yes' : command.accept === false ? 'no' : '') };
}

function cursorProjectBrokerError(info, provider = 'cursor') {
  return brokerError('INVALID_REQUEST', `${info.code}: ${info.message}`, {
    provider,
    file: info.file,
    cursorErrorCode: info.code
  });
}

export function cursorModelCatalog(option) {
  const picker = option?.parameterizedModelPicker || option?.parameterized_model_picker;
  return picker?.options || picker?.values || option?.options || [];
}

async function runCursorAcpTransport(job, driver) {
  const binary = resolveCursorBinary();
  if (!binary) throw brokerError('TRANSPORT_ERROR', 'neither agent nor cursor-agent is executable', { provider: job.provider });
  persistProviderCliVersion(job.id, assertProviderVersion('cursor', binary));
  const rootArgs = cursorAcpArgs(job);
  const launch = cursorLaunchCommand(binary, rootArgs);
  let sessionId = job.providerSessionId;
  let cancelRequested = false;
  const pendingCorrections = [];
  let cancelSignalSent = false;
  let promptPromise = null;
  const messageParts = [];
  const messageAccumulator = { active: null, completed: [], nextAnonymousId: 0 };
  const toolCallAliases = new Map();
  const planHolder = { entries: null };
  const deltas = new DeltaRedactor();
  const activity = new ActivityTransitionEmitter(job.id);
  const ephemeral = new EphemeralCursorActivity(activity);
  let budgetError = null;
  let replaying = false;
  let pendingInput = null;
  let blockingInputError = null;
  let projectConfigError = null;
  let planPassError = null;
  const pendingInterrogations = [];
  let activeInterrogation = null;
  let resultBeforeInterrogation = null;
  let planPhase = planningActive(job) ? 'planning' : 'disabled';
  let planDeclined = false;
  const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600);
  const deadline = Number(job.createdAtMs || Number(job.createdAt || 0) * 1000 || Date.now()) + timeoutMs;
  const rpc = new JsonRpcProcess(launch.command, launch.args, {
    cwd: job.cwd,
    onStderr: (text) => {
      projectConfigError ||= cursorProjectConfigFailure(text, job.cwd);
      appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text: deltas.redactDelta('stderr', text) });
    },
    onNotification: async (method, params) => {
      if (method === 'session/update') {
        mapCursorAcpUpdate(job, params.update || {}, {
          sessionId: params.sessionId,
          messageParts,
          messageAccumulator,
          toolCallAliases,
          deltas,
          planHolder,
          ephemeral,
          replay: replaying
        });
      } else {
        mapCursorAcpNotification(job, method, params, sessionId);
      }
    },
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') {
        ephemeral.output();
        const context = normalizedPermissionContext(params, job.cwd);
        const options = Array.isArray(params.options) ? params.options : [];
        appendJobEvent(job.id, 'approval.requested', { method, context, options }, { sessionId });
        const force = job.approval === 'force' || (job.network === true && job.sandbox === 'off');
        const allowOnce = force ? options.find((option) => /allow[_ -]?once|once/i.test(String(option.kind || ''))) : null;
        const reject = options.find((option) => /reject|deny/i.test(String(option.kind || '')));
        const selected = allowOnce || reject;
        const outcome = selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' };
        appendJobEvent(job.id, 'approval.resolved', { outcome, decision: allowOnce ? 'allow_once' : reject ? 'reject' : 'cancelled', context }, { sessionId });
        return { outcome };
      }
      if (!['cursor/ask_question', 'cursor/create_plan'].includes(method)) {
        throw brokerError('INVALID_REQUEST', `Unsupported ACP request: ${method}`, { provider: job.provider });
      }
      if (pendingInput) throw brokerError('USER_INPUT_REQUIRED', `another Cursor input request is already pending: ${pendingInput.requestId}`, { provider: job.provider });
      ephemeral.output();
      const providerRequestIds = cursorProviderIdentifiers(params.requestId || params.id || params.toolCallId);
      if (!providerRequestIds.length) providerRequestIds.push(`cursor-input-${crypto.randomUUID()}`);
      const timeout = Math.max(1, Math.min(cursorInputTimeoutMs(), deadline - Date.now()));
      const durable = normalizeCoordinatorQuestion(loadJob(job.id), params, {
        method,
        requestIds: providerRequestIds,
        planEntries: method === 'cursor/create_plan' ? planHolder.entries : null,
        requestedAt: Date.now(),
        timeoutMs: timeout
      });
      const requestId = durable.requestId;
      beginCoordinatorQuestion(job.id, durable, 'cursor-acp');
      appendJobEvent(job.id, 'input.requested', durable, { sessionId });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pendingInput || pendingInput.requestId !== requestId) return;
          const error = brokerError('USER_INPUT_REQUIRED', `Cursor ${method} timed out waiting for coordinator response after ${Math.round(timeout / 1000)}s`, {
            provider: job.provider,
            stopReason: 'input-timeout'
          });
          blockingInputError = error;
          pendingInput = null;
          resolveCoordinatorQuestion(job.id, durable, 'timeout', 'cursor-acp');
          appendJobEvent(job.id, 'input.resolved', {
            requestId,
            outcome: 'timeout',
            defaultAction: 'reject',
            stopReason: 'input-timeout'
          }, { sessionId });
          reject(error);
        }, timeout);
        timer.unref?.();
        pendingInput = {
          requestId,
          ...(durable.requestAliases?.length ? { requestAliases: durable.requestAliases } : {}),
          method,
          question: durable,
          resolve,
          reject,
          timer
        };
      });
    }
  });

  try {
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'delegate-router', version: '0.74.0' }
    });
    const initializeRecord = redact({
      protocolVersion: initialized.protocolVersion,
      capabilities: initialized.capabilities || initialized.agentCapabilities || {},
      modes: initialized.modes || [],
      models: initialized.models || [],
      authMethods: initialized.authMethods ? '[advertised]' : undefined
    });
    updateManagedJob(job.id, (current) => { current.cursorInitialize = initializeRecord; }, { incrementRevision: false });
    appendJobEvent(job.id, 'provider.initialized', initializeRecord);
    const loadSession = initialized.capabilities?.loadSession ?? initialized.agentCapabilities?.loadSession ?? initialized.loadSession;
    if (sessionId && loadSession !== true) {
      throw brokerError('RESUME_UNSUPPORTED', 'Cursor ACP initialize did not advertise loadSession; cannot load the requested continuation', { provider: job.provider });
    }
    replaying = Boolean(sessionId);
    const sessionMethod = sessionId ? 'session/load' : 'session/new';
    const sessionParams = sessionId ? { sessionId, cwd: job.cwd } : { cwd: job.cwd };
    let session;
    try {
      session = await rpc.request(sessionMethod, {
        ...sessionParams,
        mcpServers: [cursorAcpBackchannelServer(job)]
      });
    } catch (error) {
      appendJobEvent(job.id, 'backchannel.unavailable', {
        transport: 'acp',
        reason: error.message,
        fallback: 'session-without-backchannel'
      });
      session = await rpc.request(sessionMethod, { ...sessionParams, mcpServers: [] });
    }
    replaying = false;
    sessionId ||= session.sessionId;
    recordSession(job.id, sessionId, null, { rebind: true });
    const config = session.configOptions || [];
    updateManagedJob(job.id, (current) => {
      current.cursorConfigOptions = redact(config);
      current.cursorModes = initialized.modes || config.find((item) => item.id === 'mode')?.options || [];
      const configuredModels = cursorModelCatalog(config.find((item) => item.id === 'model'));
      current.cursorModels = configuredModels.length ? configuredModels : initialized.models || [];
    }, { incrementRevision: false });
    const modelOption = config.find((item) => item.id === 'model');
    const modeOption = config.find((item) => item.id === 'mode');
    if (modelOption) {
      let resolvedModel;
      try {
        const detailed = cursorModelDetailed(cursorModelCatalog(modelOption), job.model);
        resolvedModel = detailed.value;
        if (detailed.fastCompromise) {
          // The session advertises this model only as a fast variant. The
          // non-fast contract wins: if the CLI catalog has a non-fast id,
          // fall back to headless with it; otherwise proceed fast, loudly.
          let cliModel = null;
          try {
            const ids = availableModelIds(binary);
            const candidate = resolveCursorModel(job.model, ids);
            if (ids.includes(candidate) && !/-fast(?:-|$)/.test(candidate)) cliModel = candidate;
          } catch {}
          if (cliModel) {
            throw brokerError('ACP_TIER_UNAVAILABLE', `this ACP session advertises '${job.model}' only as a fast variant ('${detailed.value}'); the CLI catalog has non-fast '${cliModel}'`, {
              provider: job.provider,
              cliModel
            });
          }
          appendJobEvent(job.id, 'provider.event', { providerEvent: 'cursor:fast-fallback', requested: job.model, resolved: detailed.value }, { sessionId });
        }
      } catch (error) {
        if (error.code === 'ACP_TIER_UNAVAILABLE') throw error;
        if (error.code !== 'INVALID_MODEL') throw error;
        // ACP sessions can advertise fewer tiers than the CLI catalog (for
        // example Grok capped at effort=high while the CLI lists -xhigh).
        // When the requested tier exists in the CLI catalog, signal a
        // deliberate transport fallback instead of failing the job.
        let cliModel = null;
        try {
          const ids = availableModelIds(binary);
          const candidate = resolveCursorModel(job.model, ids);
          if (ids.includes(candidate)) cliModel = candidate;
        } catch {}
        if (!cliModel) throw error;
        throw brokerError('ACP_TIER_UNAVAILABLE', `'${job.model}' resolves to '${cliModel}' in the CLI catalog, but this ACP session does not advertise that tier`, {
          provider: job.provider,
          cliModel
        });
      }
      await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: resolvedModel });
      appendJobEvent(job.id, 'model.updated', {
        requested: job.model,
        model: resolvedModel,
        catalogSource: modelOption.parameterizedModelPicker || modelOption.parameterized_model_picker ? 'parameterizedModelPicker' : 'config-option'
      }, { sessionId });
      updateManagedJob(job.id, (current) => {
        current.model = resolvedModel;
        current.resolvedModel = resolvedModel;
      }, { incrementRevision: false });
    }
    const setSessionMode = async (resolvedMode, requested = job.mode) => {
      if (!modeOption) return;
      await rpc.request('session/set_config_option', { sessionId, configId: 'mode', value: resolvedMode });
      appendJobEvent(job.id, 'mode.updated', { requested, mode: resolvedMode }, { sessionId });
      updateManagedJob(job.id, (current) => { current.cursorMode = resolvedMode; }, { incrementRevision: false });
    };
    if (modeOption) {
      const resolvedMode = planPhase === 'planning'
        ? 'plan'
        : job.network === true && readOnly(job) ? 'agent' : readOnly(job) ? (job.mode === 'consult' ? 'ask' : 'plan') : 'agent';
      await setSessionMode(resolvedMode, planPhase === 'planning' ? 'plan-first' : job.mode);
    }

    if (!await holdBeforeFirstTurn(loadJob(job.id), deadline)) return;

    const startPrompt = (text) => {
      messageParts.length = 0;
      messageAccumulator.active = null;
      messageAccumulator.completed.length = 0;
      messageAccumulator.nextAnonymousId = 0;
      toolCallAliases.clear();
      planHolder.entries = null;
      cancelSignalSent = false;
      appendJobEvent(job.id, 'turn.started', { transport: 'acp' }, { sessionId });
      promptPromise = driver.prompt(() => rpc.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: cursorPrompt(loadJob(job.id), text) }]
      }, Math.max(1, deadline - Date.now())));
    };
    if (planPhase === 'planning') {
      updateManagedJob(job.id, (current) => {
        current.planning = { ...current.planning, state: 'running', startedAt: Date.now(), sandbox: 'read-only' };
        current.phase = 'planning';
      }, { incrementRevision: false });
      startAmbiguityProbe(job.id);
      startPrompt(planPrompt(promptFor(loadJob(job.id)), { provider: job.provider, model: job.model }));
    } else {
      startPrompt(promptFor(loadJob(job.id)));
    }

    while (true) {
      if (blockingInputError) throw blockingInputError;
      const inputTimeout = backchannelTimedOut(job.id);
      if (inputTimeout) {
        if (!cancelSignalSent) driver.cancel(() => rpc.notify('session/cancel', { sessionId }));
        throw inputTimeout;
      }
      if (Date.now() >= deadline) {
        if (!cancelSignalSent) driver.cancel(() => rpc.notify('session/cancel', { sessionId }));
        throw brokerError('TIMEOUT', `Cursor managed job exceeded ${Math.round(timeoutMs / 1000)}s`, { provider: job.provider });
      }
      const completed = await Promise.race([
        promptPromise.then((response) => ({ response }), (error) => ({ error })),
        delay(150).then(() => null)
      ]);
      for (const claimed of claimProviderCommands(job.id)) {
        const command = claimed.command;
        const planAnswer = answerPlanCommand(job.id, claimed);
        if (planAnswer?.decision === 'confirmed') {
          planPhase = 'implementing';
          await setSessionMode('agent', job.mode);
          startPrompt(IMPLEMENT_CONFIRMED_PROMPT);
        } else if (planAnswer?.decision === 'declined') {
          planDeclined = true;
          terminal(loadJob(job.id), 'cancelled', 'plan-declined', {
            stoppedReason: 'plan-declined',
            result: loadJob(job.id).result
          });
        } else if (planAnswer) {
          // Invalid plan responses leave the explicit confirmation boundary in
          // place and are already settled as rejected.
        } else if (command.type === 'cancel') {
          cancelRequested = true;
          if (pendingInput) {
            clearTimeout(pendingInput.timer);
            pendingInput.reject(brokerError('USER_INPUT_REQUIRED', 'Cursor input request cancelled by coordinator', { provider: job.provider }));
            pendingInput = null;
          }
          for (const queued of pendingCorrections) {
            appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' }, { sessionId });
            settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
          }
          pendingCorrections.length = 0;
          if (!cancelSignalSent) {
            driver.cancel(() => rpc.notify('session/cancel', { sessionId }));
            cancelSignalSent = true;
          }
          completeCommand(job.id, claimed, { ok: true, appliedAs: 'cancel' });
        } else if (command.type === 'respond') {
          if (!pendingInput) {
            completeCommand(job.id, claimed, { ok: false, error: 'no Cursor input request is pending' });
          } else if (command.requestId && !pendingRequestMatches(pendingInput, command.requestId)) {
            completeCommand(job.id, claimed, { ok: false, error: `response targets ${command.requestId}; pending request accepts ${pendingRequestIds(pendingInput).join(', ')}` });
          } else {
            const response = cursorInputResponse(pendingInput.method, command);
            const requestId = pendingInput.requestId;
            const question = pendingInput.question;
            clearTimeout(pendingInput.timer);
            const resolve = pendingInput.resolve;
            pendingInput = null;
            resolveCoordinatorQuestion(job.id, question, 'answered', 'cursor-acp');
            appendJobEvent(job.id, 'input.resolved', {
              requestId,
              outcome: 'answered',
              answer: command.answer,
              response
            }, { sessionId });
            completeCommand(job.id, claimed, { ok: true, appliedAs: 'input-response', requestId });
            resolve(response);
          }
        } else if (command.type === 'interrogate') {
          if (planPhase === 'awaiting-confirmation') {
            completeCommand(job.id, claimed, { ok: false, error: 'SESSION_UNAVAILABLE: the Cursor session is waiting for plan confirmation' });
          } else {
            const baselineOutputTokens = usageTotals(inspectJob(job.id).usage)?.outputTokens || 0;
            pendingInterrogations.push({ command, baselineOutputTokens });
            updateManagedJob(job.id, (current) => {
              const entry = (current.interrogations || []).find((item) => item.id === command.commandId);
              if (entry) entry.state = 'active';
            }, { incrementRevision: false });
            appendJobEvent(job.id, 'interrogation.queued', {
              commandId: command.commandId,
              appliedAs: 'queued-next-turn',
              cursorSameTurn: false,
              authority: 'evidence-only',
              constraintsUnchanged: true
            }, { sessionId });
            completeCommand(job.id, claimed, {
              ok: true,
              state: 'queued',
              appliedAs: 'queued-next-turn',
              cursorSameTurn: false,
              evidencePending: true
            });
          }
        } else if (command.type === 'steer') {
          if (cancelRequested) {
            completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
          } else if (command.strategy === 'same-turn') {
            completeCommand(job.id, claimed, { ok: false, error: 'UNSUPPORTED_STRATEGY: ACP v1 has no same-turn steering' });
          } else {
            pendingCorrections.push({ text: command.text, commandId: command.commandId });
            if (!cancelSignalSent) {
              driver.steer(() => rpc.notify('session/cancel', { sessionId }));
              cancelSignalSent = true;
            }
            appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy: 'restart' }, { sessionId });
            completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'restart' });
          }
        } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
      }
      if (planDeclined) break;
      if (!completed) continue;
      if (blockingInputError) throw blockingInputError;
      if (completed.error) {
        if (activeInterrogation) {
          recordInterrogationUnavailable(job.id, activeInterrogation.command, completed.error, 'acp');
          activeInterrogation = null;
          recordGitState(job, sessionId);
          terminal(job, 'completed', 'completed', {
            result: resultBeforeInterrogation,
            session: sessionId
          });
          break;
        }
        if (projectConfigError) throw cursorProjectBrokerError(projectConfigError, job.provider);
        throw completed.error;
      }
      if (acpGraceMs()) await delay(acpGraceMs());
      completeCursorAcpMessage(job, { sessionId, messageAccumulator });
      appendJobEvent(job.id, 'turn.completed', completed.response, { sessionId });
      if (completed.response.usage && usageTotals(completed.response.usage)) {
        const exceeded = recordUsage(job, {
          ...completed.response.usage,
          source: 'cursor-acp-prompt-response-extension'
        }, { sessionId });
        if (exceeded?.planPass && !planPassError) {
          planPassError = exceeded;
          appendJobEvent(job.id, 'plan.output-limit-exceeded', {
            stage: 'primary-plan',
            reason: 'plan-output-token-sub-budget-exceeded',
            observedOutputTokens: exceeded.observedOutputTokens,
            maxOutputTokens: exceeded.maxOutputTokens
          }, { sessionId });
        } else if (exceeded && !budgetError) {
          budgetError = exceeded;
          recordBudgetExceeded(job, exceeded, { sessionId });
        }
      }
      if (budgetError) {
        recordGitState(job, sessionId);
        throw budgetError;
      }
      if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); break; }
      if (planPhase === 'planning') {
        const planText = [planEntriesText(planHolder.entries), cursorAcpMessageText(messageAccumulator, messageParts)].filter(Boolean).join('\n');
        const assessment = assessPrimaryPlanBudget(job.id, planText);
        const budgetFailure = assessment.state === 'rejected'
          ? assessment.reason
          : planPassError ? 'plan-output-token-sub-budget-exceeded' : null;
        if (budgetFailure) {
          const retry = beginPrimaryPlanRetry(job.id, assessment, budgetFailure, { sessionId });
          if (retry) {
            planPassError = null;
            startPrompt(planRetryPrompt(
              promptFor(loadJob(job.id)),
              { provider: job.provider, model: job.model },
              retry.retryLimit
            ));
            continue;
          }
          recordPrimaryPlanDegradation(job.id, budgetFailure, assessment, { sessionId });
          presentDegradedPlanForConfirmation(job.id, budgetFailure);
          planPhase = 'awaiting-confirmation';
          promptPromise = new Promise(() => {});
          continue;
        }
        const planned = await presentPlanForConfirmation(job.id, planText);
        planPhase = 'awaiting-confirmation';
        promptPromise = new Promise(() => {});
        continue;
      }
      if (activeInterrogation) {
        try {
          recordInterrogationAnswer(job.id, activeInterrogation.command, cursorAcpMessageText(messageAccumulator, messageParts), {
            baselineOutputTokens: activeInterrogation.baselineOutputTokens,
            transport: 'acp',
            appliedAs: 'queued-next-turn'
          });
          if (completed.response.usage) attributeInterrogationUsage(job.id, completed.response.usage);
          settleQueuedControl(job.id, activeInterrogation.command.commandId, {
            ok: true,
            appliedAs: 'queued-next-turn',
            cursorSameTurn: false,
            evidenceRecorded: true
          });
        } catch (error) {
          settleQueuedControl(job.id, activeInterrogation.command.commandId, { ok: false, error: error.message });
        }
        activeInterrogation = null;
        recordGitState(job, sessionId);
        terminal(job, 'completed', 'completed', {
          result: resultBeforeInterrogation,
          session: sessionId
        });
        break;
      }
      if (pendingCorrections.length) {
        const next = pendingCorrections.shift();
        settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
        appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId });
        startPrompt(next.text);
        continue;
      }
      const planText = planEntriesText(planHolder.entries);
      const result = {
        text: cursorAcpMessageText(messageAccumulator, messageParts),
        ...(planText ? { plan: planText } : {}),
        stopReason: completed.response.stopReason
      };
      if (pendingInterrogations.length) {
        resultBeforeInterrogation = result;
        activeInterrogation = pendingInterrogations.shift();
        activeInterrogation.baselineOutputTokens = usageTotals(inspectJob(job.id).usage)?.outputTokens || activeInterrogation.baselineOutputTokens;
        await setSessionMode('plan', 'interrogation');
        startPrompt(interrogationPrompt(activeInterrogation.command.commandId, activeInterrogation.command.question));
        continue;
      }
      if (prepareAutoNudge(job.id, result)) {
        startPrompt(AUTO_NUDGE_PROMPT);
        continue;
      }
      recordGitState(job, sessionId);
      terminal(job, 'completed', 'completed', {
        result,
        session: sessionId
      });
      break;
    }
  } catch (error) {
    if (projectConfigError && error.code !== 'CURSOR_PROJECT_CONFIG_INVALID') {
      throw cursorProjectBrokerError(projectConfigError, job.provider);
    }
    throw error;
  } finally {
    replaying = false;
    if (pendingInput) {
      clearTimeout(pendingInput.timer);
      pendingInput.reject(brokerError('TRANSPORT_ERROR', 'Cursor ACP stopped while waiting for coordinator input', { provider: job.provider }));
      pendingInput = null;
    }
    activity.close();
    await driver.close(() => rpc.stop());
  }
}

async function runCursorAcp(job, driver) {
  const network = prepareCursorNetwork(job, 'acp');
  try { return await runCursorAcpTransport(job, driver); }
  finally { network.cleanup(); }
}

function headlessAssistantText(event) {
  const content = event.message?.content || event.content;
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : item?.text || '').join('');
  if (typeof content === 'string') return content;
  if (typeof event.text === 'string') return event.text;
  return '';
}

function headlessToolPayload(event) {
  const entry = Object.entries(event.tool_call || {})[0] || ['tool', {}];
  const kind = String(entry[0]).replace(/ToolCall$/, '') || 'tool';
  const call = entry[1] && typeof entry[1] === 'object' ? entry[1] : {};
  const args = call.args || call.input || {};
  const result = call.result || event.result || null;
  const requestedSandboxPolicy = call.requestedSandboxPolicy || args.requestedSandboxPolicy || event.requestedSandboxPolicy || null;
  const providerToolCallIds = cursorProviderIdentifiers(event.call_id ?? event.callId ?? call.call_id ?? call.id);
  return {
    toolCallId: providerToolCallIds[0],
    ...(providerToolCallIds.length > 1
      ? { providerToolCallIds }
      : {}),
    kind,
    title: kind,
    args,
    ...(requestedSandboxPolicy ? { requestedSandboxPolicy } : {}),
    ...(result ? {
      result: redact(result, '', 16384),
      output: boundedToolOutput(result),
      success: result.success,
      rejectedReason: result.rejected?.reason,
      error: result.error
    } : {})
  };
}

function headlessMessageAccumulator(context = {}) {
  return context.messageAccumulator || (context.messageAccumulator = {
    active: null,
    completed: [],
    nextId: 0
  });
}

function completeCursorHeadlessMessage(job, context = {}) {
  const accumulator = headlessMessageAccumulator(context);
  if (!accumulator.active?.parts?.length) return null;
  const text = accumulator.active.parts.join('');
  appendJobEvent(job.id, 'message.completed', { id: accumulator.active.id, text }, {
    sessionId: context.sessionId
  });
  accumulator.completed.push(text);
  accumulator.active = null;
  return text;
}

export function mapCursorHeadlessEvent(job, event, context = {}) {
  const jobId = job.id;
  const sessionId = findValue(event, ['session_id', 'sessionId', 'chat_id', 'chatId']);
  if (sessionId) {
    updateManagedJob(jobId, (job) => { job.providerSessionId = sessionId; job.session = sessionId; }, { incrementRevision: false });
  }
  const options = { sessionId };
  if (event.type === 'assistant') {
    // Cursor emits buffered pre-tool and final flush duplicates. Only the
    // timestamped, model-call-free chunks are genuine stream deltas.
    if (event.timestamp_ms == null || event.model_call_id != null) return null;
    const text = headlessAssistantText(event);
    const accumulator = headlessMessageAccumulator(context);
    accumulator.active ||= { id: `headless-message-${++accumulator.nextId}`, parts: [] };
    accumulator.active.parts.push(text);
    context.assistantParts?.push(text);
    context.ephemeral?.output();
    appendJobEvent(jobId, 'message.delta', {
      id: accumulator.active.id,
      delta: context.deltas.redactDelta(`message:${accumulator.active.id}`, text)
    }, options);
  } else if (event.type === 'thinking') {
    context.ephemeral?.thinking(event.text || '');
  } else if (event.type === 'tool_call') {
    context.ephemeral?.output();
    completeCursorHeadlessMessage(job, { ...context, sessionId });
    const type = event.subtype === 'started' ? 'tool.started' : event.subtype === 'completed' ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, { ...headlessToolPayload(event), subtype: event.subtype }, options);
  } else if (event.type === 'result') {
    context.ephemeral?.output();
    completeCursorHeadlessMessage(job, { ...context, sessionId });
    const canonical = typeof event.result === 'string' ? event.result : event.result == null ? '' : JSON.stringify(event.result);
    const streamed = headlessMessageAccumulator(context).completed.join('');
    if (streamed && canonical && streamed !== canonical) {
      appendJobEvent(jobId, 'provider.event', {
        providerEvent: 'cursor:assistant-final-mismatch',
        streamedChars: streamed.length,
        finalChars: canonical.length,
        resolution: 'streamed-message-segments-retained'
      }, options);
    }
    if (!streamed && canonical) appendJobEvent(jobId, 'message.completed', { id: 'headless-result', text: canonical }, options);
    return event.usage ? recordUsage(job, {
      ...event.usage,
      source: 'cursor-headless-result-extension'
    }, options) : null;
  } else if (event.type === 'system' && event.subtype === 'init') {
    appendJobEvent(jobId, 'session.updated', { model: event.model, permissionMode: event.permissionMode }, options);
  } else if (event.type !== 'user') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: `cursor:${event.type || 'unknown'}`, subtype: event.subtype }, options);
  }
  return null;
}

function createCursorChat(binary, job) {
  const launch = cursorLaunchCommand(binary, ['create-chat'], false);
  const result = spawnSync(launch.command, launch.args, {
    cwd: job.cwd,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const configFailure = cursorProjectConfigFailure(result.stderr, job.cwd);
  if (configFailure) throw cursorProjectBrokerError(configFailure, job.provider);
  if (result.status !== 0) {
    if (/unknown|unrecognized|invalid (?:command|subcommand)|create-chat.*(?:not found|unsupported)/i.test(result.stderr || '')) {
      return { sessionId: null, fallback: 'create-chat-unavailable' };
    }
    throw brokerError('TRANSPORT_ERROR', `Cursor create-chat failed before the first turn: ${redact((result.stderr || result.stdout || '').trim(), '', 2000)}`, { provider: job.provider });
  }
  const output = String(result.stdout || '').trim();
  let sessionId = null;
  try { sessionId = findValue(JSON.parse(output), ['session_id', 'sessionId', 'chat_id', 'chatId', 'id']); } catch {}
  sessionId ||= output.match(/\b(?:chat|session)[-_][a-zA-Z0-9_-]+\b/)?.[0] || (/^[a-zA-Z0-9_-]{8,}$/.test(output) ? output : null);
  return sessionId ? { sessionId: String(sessionId), fallback: null } : { sessionId: null, fallback: 'create-chat-output-unrecognized' };
}

async function awaitHeadlessPlanConfirmation(job, planned, deadline) {
  while (true) {
    if (Date.now() >= Math.min(deadline, planned.question.expiresAt)) {
      resolveCoordinatorQuestion(job.id, planned.question, 'timeout', 'plan-first');
      appendJobEvent(job.id, 'input.resolved', {
        requestId: planned.question.requestId,
        outcome: 'timeout',
        defaultAction: 'reject',
        stopReason: 'input-timeout'
      });
      throw brokerError('USER_INPUT_REQUIRED', 'plan confirmation timed out; default action rejected implementation', {
        provider: job.provider,
        stopReason: 'input-timeout'
      });
    }
    for (const claimed of claimProviderCommands(job.id)) {
      const answer = answerPlanCommand(job.id, claimed);
      if (answer?.decision === 'confirmed') return 'confirmed';
      if (answer?.decision === 'declined') {
        terminal(loadJob(job.id), 'cancelled', 'plan-declined', {
          stoppedReason: 'plan-declined',
          result: loadJob(job.id).result
        });
        return 'terminal';
      }
      if (!answer && claimed.command.type === 'cancel') {
        completeCommand(job.id, claimed, { ok: true, appliedAs: 'cancel' });
        terminal(loadJob(job.id), 'cancelled', 'cancelled');
        return 'terminal';
      }
      if (!answer) {
        completeCommand(job.id, claimed, {
          ok: false,
          error: `job is waiting for plan confirmation; ${claimed.command.type} is unavailable`
        });
      }
    }
    await delay(100);
  }
}

async function runCursorHeadlessTransport(job, driver) {
  const binary = resolveCursorBinary();
  if (!binary) throw brokerError('TRANSPORT_ERROR', 'neither agent nor cursor-agent is executable', { provider: job.provider });
  persistProviderCliVersion(job.id, assertProviderVersion('cursor', binary));
  const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600);
  const deadline = Number(job.createdAtMs || Number(job.createdAt || 0) * 1000 || Date.now()) + timeoutMs;
  const ids = process.platform === 'darwin' && process.env.DELEGATE_CURSOR_LOGIN_SHELL !== '0'
    ? []
    : availableModelIds(binary);
  const model = resolveCursorModel(job.model, ids);
  let resume = job.providerSessionId;
  let planPhase = planningActive(job) ? 'planning' : 'disabled';
  let initialPlanGate = null;
  if (!resume) {
    const created = createCursorChat(binary, job);
    if (created.sessionId) {
      resume = created.sessionId;
      recordSession(job.id, resume, null, { rebind: true });
      appendJobEvent(job.id, 'session.created', { sessionId: resume, source: 'cursor-create-chat' }, { sessionId: resume });
    } else {
      appendJobEvent(job.id, 'provider.event', { providerEvent: 'cursor:create-chat-fallback', reason: created.fallback });
    }
  }
  if (planPhase === 'planning' && !resume) {
    const reason = 'headless-session-precreation-unavailable';
    recordPrimaryPlanDegradation(job.id, reason);
    initialPlanGate = presentDegradedPlanForConfirmation(job.id, reason);
    planPhase = 'awaiting-confirmation';
  }
  let text = planPhase === 'planning'
    ? planPrompt(promptFor(job), { provider: job.provider, model: job.model })
    : promptFor(job);
  let currentMode = planPhase === 'planning' ? 'plan' : job.mode;
  let cancelRequested = false;
  const pendingCorrections = [];
  const pendingInterrogations = [];
  let activeInterrogation = null;
  let resultBeforeInterrogation = null;
  const deltas = new DeltaRedactor();
  const activity = new ActivityTransitionEmitter(job.id);
  const ephemeral = new EphemeralCursorActivity(activity);
  let budgetError = null;
  let planPassError = null;
  let budgetTermination = null;
  let backchannelPlugin = null;
  let backchannelFallbackUsed = false;
  try {
    backchannelPlugin = materializeCursorBackchannelPlugin(job);
  } catch (error) {
    appendJobEvent(job.id, 'backchannel.unavailable', {
      transport: 'headless',
      reason: error.message,
      fallback: 'headless-without-backchannel'
    });
  }

  try {
    if (initialPlanGate) {
      const decision = await awaitHeadlessPlanConfirmation(job, initialPlanGate, deadline);
      if (decision === 'terminal') return;
      planPhase = 'implementing';
      currentMode = job.mode;
      text = IMPLEMENT_CONFIRMED_PROMPT;
    }
    if (planPhase === 'planning') {
      updateManagedJob(job.id, (current) => {
        current.planning = { ...current.planning, state: 'running', startedAt: Date.now(), sandbox: 'read-only' };
        current.phase = 'planning';
      }, { incrementRevision: false });
      startAmbiguityProbe(job.id);
    }
    while (true) {
    let activeChild = null;
    const assistantParts = [];
    const messageAccumulator = { active: null, completed: [], nextId: 0 };
    appendJobEvent(job.id, 'turn.started', { transport: 'headless', resume }, { sessionId: resume });
    const headless = cursorLaunchCommand(binary, buildCursorArgs({
      mode: currentMode,
      model,
      cwd: job.cwd,
      approval: job.approval,
      resume,
      sandbox: job.sandbox,
      network: job.network,
      addDirs: job.addDirs,
      pluginDirs: backchannelPlugin ? [backchannelPlugin] : [],
      approveMcps: job.approveMcps || Boolean(backchannelPlugin),
      worktree: job.cursorWorktree,
      worktreeBase: job.cursorWorktreeBase
    }), false);
    const running = driver.prompt(() => runCursor({
      binary: headless.command,
      args: headless.args,
      cwd: job.cwd,
      prompt: cursorPrompt(job, text),
      timeoutMs: jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600),
      onChild: (child) => { activeChild = child; },
      onEvent: (event) => {
        const exceeded = mapCursorHeadlessEvent(job, event, { deltas, assistantParts, messageAccumulator, ephemeral });
        if (exceeded?.planPass && !planPassError) {
          planPassError = exceeded;
          appendJobEvent(job.id, 'plan.output-limit-exceeded', {
            stage: 'primary-plan',
            reason: 'plan-output-token-sub-budget-exceeded',
            observedOutputTokens: exceeded.observedOutputTokens,
            maxOutputTokens: exceeded.maxOutputTokens
          }, { sessionId: resume });
        } else if (exceeded && !budgetError) {
          budgetError = exceeded;
          recordBudgetExceeded(job, exceeded, { sessionId: resume });
          if (activeChild) budgetTermination = driver.cancel(() => terminateProcessTree(activeChild));
        }
      }
    }));
    let outcome;
    while (!outcome) {
      outcome = await Promise.race([running, delay(150).then(() => null)]);
      const inputTimeout = backchannelTimedOut(job.id);
      if (inputTimeout) {
        if (activeChild) await driver.cancel(() => terminateProcessTree(activeChild));
        throw inputTimeout;
      }
      for (const claimed of claimProviderCommands(job.id)) {
        const command = claimed.command;
        if (command.type === 'cancel') {
          cancelRequested = true;
          for (const queued of pendingCorrections) {
            appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' }, { sessionId: resume });
            settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
          }
          pendingCorrections.length = 0;
          if (activeChild) await driver.cancel(() => terminateProcessTree(activeChild));
          completeCommand(job.id, claimed, { ok: true, appliedAs: 'process-tree-termination' });
        } else if (command.type === 'interrogate') {
          const baselineOutputTokens = usageTotals(inspectJob(job.id).usage)?.outputTokens || 0;
          pendingInterrogations.push({ command, baselineOutputTokens });
          updateManagedJob(job.id, (current) => {
            const entry = (current.interrogations || []).find((item) => item.id === command.commandId);
            if (entry) entry.state = 'active';
          }, { incrementRevision: false });
          appendJobEvent(job.id, 'interrogation.queued', {
            commandId: command.commandId,
            appliedAs: 'queued-next-turn',
            cursorSameTurn: false,
            authority: 'evidence-only',
            constraintsUnchanged: true
          }, { sessionId: resume });
          completeCommand(job.id, claimed, {
            ok: true,
            state: 'queued',
            appliedAs: 'queued-next-turn',
            cursorSameTurn: false,
            evidencePending: true
          });
        } else if (command.type === 'steer') {
          if (cancelRequested) {
            completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
          } else if (command.strategy === 'same-turn') {
            completeCommand(job.id, claimed, { ok: false, error: 'UNSUPPORTED_STRATEGY: Cursor headless has no same-turn steering' });
          } else {
            const current = inspectJob(job.id);
            if (!current.providerSessionId) {
              completeCommand(job.id, claimed, { ok: false, error: 'SESSION_UNAVAILABLE: Cursor has not exposed a resumable session id' });
            } else {
              pendingCorrections.push({ text: command.text, commandId: command.commandId });
              resume = current.providerSessionId;
              const first = pendingCorrections.length === 1;
              if (first && activeChild) await driver.steer(() => terminateProcessTree(activeChild));
              appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy: 'restart' }, { sessionId: resume });
              completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'restart' });
            }
          }
        } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
      }
    }
    if (budgetTermination) await budgetTermination;
    if (outcome.status !== 0 && backchannelPlugin && !backchannelFallbackUsed
      && /(?:plugin|mcp|delegate-backchannel)/i.test(`${outcome.error || ''}\n${outcome.stderr || ''}`)) {
      appendJobEvent(job.id, 'backchannel.unavailable', {
        transport: 'headless',
        reason: outcome.error || 'Cursor rejected the injected MCP plugin',
        fallback: 'headless-without-backchannel'
      });
      backchannelPlugin = null;
      backchannelFallbackUsed = true;
      continue;
    }
    appendJobEvent(job.id, 'turn.completed', { status: outcome.status, error: outcome.error }, { sessionId: resume });
    if (budgetError) {
      recordGitState(job, resume);
      throw budgetError;
    }
    if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); return; }
    if (planPhase === 'planning') {
      const primaryText = resultText(outcome.payload) || '';
      const assessment = assessPrimaryPlanBudget(job.id, primaryText);
      const budgetFailure = assessment.state === 'rejected'
        ? assessment.reason
        : planPassError ? 'plan-output-token-sub-budget-exceeded' : null;
      if (budgetFailure) {
        const retry = beginPrimaryPlanRetry(job.id, assessment, budgetFailure, { sessionId: resume });
        if (retry) {
          planPassError = null;
          currentMode = 'plan';
          text = planRetryPrompt(
            promptFor(loadJob(job.id)),
            { provider: job.provider, model: job.model },
            retry.retryLimit
          );
          continue;
        }
        recordPrimaryPlanDegradation(job.id, budgetFailure, assessment, { sessionId: resume });
        const degraded = presentDegradedPlanForConfirmation(job.id, budgetFailure);
        const decision = await awaitHeadlessPlanConfirmation(job, degraded, deadline);
        if (decision === 'terminal') return;
      } else {
        const planned = await presentPlanForConfirmation(job.id, primaryText);
        const decision = await awaitHeadlessPlanConfirmation(job, planned, deadline);
        if (decision === 'terminal') return;
      }
      planPhase = 'implementing';
      currentMode = job.mode;
      text = IMPLEMENT_CONFIRMED_PROMPT;
      continue;
    }
    if (activeInterrogation) {
      if (outcome.status !== 0) {
        recordInterrogationUnavailable(job.id, activeInterrogation.command, outcome.error || outcome.stderr || 'headless interrogation failed', 'headless');
      } else {
        try {
          recordInterrogationAnswer(job.id, activeInterrogation.command, resultText(outcome.payload), {
            baselineOutputTokens: activeInterrogation.baselineOutputTokens,
            transport: 'headless',
            appliedAs: 'queued-next-turn'
          });
          if (outcome.payload?.usage) attributeInterrogationUsage(job.id, outcome.payload.usage);
          settleQueuedControl(job.id, activeInterrogation.command.commandId, {
            ok: true,
            appliedAs: 'queued-next-turn',
            cursorSameTurn: false,
            evidenceRecorded: true
          });
        } catch (error) {
          recordInterrogationUnavailable(job.id, activeInterrogation.command, error, 'headless');
        }
      }
      recordGitState(job, resume);
      terminal(job, 'completed', 'completed', { result: resultBeforeInterrogation, session: resume });
      return;
    }
    if (pendingCorrections.length) {
      const next = pendingCorrections.shift();
      settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
      appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId: resume });
      text = next.text;
      continue;
    }
    if (outcome.status !== 0) {
      recordGitState(job, resume);
      const projectConfig = cursorProjectConfigFailure(outcome.stderr, job.cwd);
      if (projectConfig) throw cursorProjectBrokerError(projectConfig, job.provider);
      if (outcome.timedOut) throw brokerError('TIMEOUT', outcome.error || 'Cursor headless execution timed out', { provider: job.provider });
      throw brokerError('PROVIDER_ERROR', outcome.error || 'Cursor headless execution failed', { provider: job.provider });
    }
    const sessionId = findValue(outcome.payload, ['session_id', 'sessionId', 'chat_id', 'chatId']);
    if (sessionId) recordSession(job.id, sessionId, null, { rebind: true });
    if (pendingInterrogations.length) {
      resultBeforeInterrogation = redact(outcome.payload);
      activeInterrogation = pendingInterrogations.shift();
      activeInterrogation.baselineOutputTokens = usageTotals(inspectJob(job.id).usage)?.outputTokens || activeInterrogation.baselineOutputTokens;
      resume = sessionId || resume;
      if (!resume) {
        appendJobEvent(job.id, 'interrogation.unavailable', {
          commandId: activeInterrogation.command.commandId,
          reason: 'headless-session-id-unavailable',
          fallback: 'journal-only-evidence'
        });
        settleQueuedControl(job.id, activeInterrogation.command.commandId, {
          ok: false,
          error: 'SESSION_UNAVAILABLE: Cursor headless did not expose a resumable session id'
        });
        activeInterrogation = null;
      } else {
        currentMode = 'plan';
        text = interrogationPrompt(activeInterrogation.command.commandId, activeInterrogation.command.question);
        continue;
      }
    }
    if (sessionId && prepareAutoNudge(job.id, outcome.payload)) {
      resume = sessionId;
      text = AUTO_NUDGE_PROMPT;
      continue;
    }
    recordGitState(job, sessionId);
    terminal(job, 'completed', 'completed', { result: redact(outcome.payload), session: sessionId });
      return;
    }
  } finally {
    await driver.close(async () => { activity.close(); });
  }
}

async function runCursorHeadless(job, driver) {
  const network = prepareCursorNetwork(job, 'headless');
  try { return await runCursorHeadlessTransport(job, driver); }
  finally { network.cleanup(); }
}

async function finishVerification(job) {
  const verification = await executeVerification(job, { redact });
  updateManagedJob(job.id, (current) => {
    appendVerificationEvidence(current, verification);
    const collidedDuringVerification = (current.collisions || [])
      .some((collision) => Number(collision?.detectedAtMs || 0) >= Number(verification.startedAtMs || 0));
    if (collidedDuringVerification) {
      appendVerificationEvidence(current, {
        ...verification,
        state: 'stale',
        stateBeforeStale: verification.state,
        inputChanged: true,
        staleReason: 'base-drift',
        stalePaths: [...new Set((current.collisions || []).map((collision) => collision?.path).filter(Boolean))].slice(-256),
        staleAtMs: Math.max(...(current.collisions || []).map((collision) => Number(collision?.detectedAtMs || 0)))
      });
    }
  }, { incrementRevision: false });
  appendJobEvent(job.id, 'verification.finished', loadJob(job.id)?.verification || verification);
  terminal(loadJob(job.id), 'completed', 'completed');
}

function autoFixPrompt(job, decision) {
  const verification = job.verification || {};
  const violations = (job.scopeViolations || []).map((entry) => entry?.path).filter(Boolean).slice(0, 20);
  return `Objective:
Fix only the deterministic broker evidence from automatic fix round ${decision.round}.

Mode:
implement

Allowed scope:
${(job.originalAllowedPaths || job.allowedPaths || []).map((entry) => `- ${entry}`).join('\n') || '- unchanged from the parent job'}

Relevant context:
Verification state: ${verification.state || 'not-run'}
Verification exit code: ${verification.exitCode ?? 'n/a'}
${verification.outputTail ? `Bounded verification tail:\n${redact(verification.outputTail, '', 2000)}` : ''}
${violations.length ? `Out-of-scope paths still observed:\n${violations.map((entry) => `- ${entry}`).join('\n')}` : ''}

Constraints and non-goals:
- Do not widen scope, privileges, network access, or the original objective.
- Address deterministic check or scope evidence only. Do not interpret or loop on semantic review findings.
- A completed job with zero changed files is a failed objective.

Acceptance criteria:
- The recorded deterministic failure count or scope-violation count decreases.
- The inherited real-tree verification recipe passes.

Required verification:
The broker will run the inherited recipe on the real tree.

Stop and report when:
- The evidence is ambiguous, requires judgment, or cannot be fixed inside the inherited scope.

Return:
Outcome, changed files, verification-relevant changes, risks, and blockers.`;
}

function recordAutoFixStop(job, decision) {
  updateManagedJob(job.id, (current) => {
    current.autoFix = {
      ...current.autoFix,
      state: 'stopped',
      stopReason: decision.reason,
      stoppedAt: new Date().toISOString(),
      ...(decision.metrics ? { metrics: decision.metrics } : {})
    };
  }, { incrementRevision: false });
  appendJobEvent(job.id, 'autofix.stopped', {
    reason: decision.reason,
    round: job.autoFix?.round || 0,
    metrics: decision.metrics || null
  });
}

function remainingOutputBudget(job) {
  if (!job.maxOutputTokens) return null;
  const used = (usageTotals(job.usage)?.outputTokens || 0) + Number(job.planning?.externalOutputTokensReserved || 0);
  return Math.max(0, job.maxOutputTokens - used);
}

function remainingWallTime(job) {
  if (!job.timeoutSeconds) return null;
  const startedAt = Number(job.autoFix?.startedAtMs || job.createdAtMs || Number(job.createdAt || 0) * 1000);
  return Math.max(0, Math.floor((job.timeoutSeconds * 1000 - Math.max(0, Date.now() - startedAt)) / 1000));
}

function maybeLaunchAutoFix(job) {
  if (!job?.autoFix) return null;
  const decision = evaluateAutoFix(job);
  if (decision.action !== 'launch') {
    recordAutoFixStop(job, decision);
    return null;
  }
  const timeoutSeconds = remainingWallTime(job);
  const maxOutputTokens = remainingOutputBudget(job);
  if ((job.timeoutSeconds && timeoutSeconds < 60) || (job.maxOutputTokens && maxOutputTokens < 1)) {
    recordAutoFixStop(job, { action: 'stop', reason: 'budget-exhausted', metrics: decision.metrics });
    return null;
  }
  try {
    const child = resumeManagedJob(job.id, {
      prompt: autoFixPrompt(job, decision),
      timeoutSeconds: timeoutSeconds || job.timeoutSeconds,
      maxOutputTokens: maxOutputTokens || job.maxOutputTokens,
      planFirst: false,
      ambiguityCheck: false,
      autoFix: {
        maxRounds: decision.maxRounds,
        _state: {
          round: decision.round,
          startedAtMs: job.autoFix.startedAtMs,
          previousMetrics: decision.metrics,
          rootJobId: job.autoFix.rootJobId || job.id
        }
      },
      reportLint: false
    });
    updateManagedJob(job.id, (current) => {
      current.autoFix = {
        ...current.autoFix,
        state: 'launched',
        metrics: decision.metrics,
        childJobId: child.id,
        launchedAt: new Date().toISOString()
      };
    }, { incrementRevision: false });
    appendJobEvent(job.id, 'autofix.launched', {
      round: decision.round,
      maxRounds: decision.maxRounds,
      metrics: decision.metrics,
      childJobId: child.id
    });
    return child;
  } catch (error) {
    recordAutoFixStop(job, {
      action: 'stop',
      reason: 'launch-failed',
      metrics: decision.metrics,
      error: redact(error.message)
    });
    return null;
  }
}

async function runCursorAcpWithFallback(job, driver) {
  try {
    await runCursorAcp(job, driver);
  } catch (error) {
    if (error.code === 'PROVIDER_TOO_OLD') throw error;
    if (job.startPaused) throw error;
    const started = inspectJob(job.id).providerSessionId;
    const tierFallback = error.code === 'ACP_TIER_UNAVAILABLE';
    if (started && !tierFallback) throw error;
    appendJobEvent(job.id, 'provider.event', {
      providerEvent: tierFallback ? 'cursor:acp-tier-fallback' : 'cursor:acp-fallback',
      error: error.message,
      ...(error.cliModel ? { cliModel: error.cliModel } : {})
    });
    updateManagedJob(job.id, (next) => {
      next.transport = 'headless';
      next.capabilities.correction = 'cancel-resume';
      if (tierFallback) {
        // The ACP session id is not a headless chat id; the requested model
        // is honored exactly via the CLI-validated id.
        next.providerSessionId = null;
        next.session = null;
        next.model = error.cliModel;
        next.resolvedModel = error.cliModel;
      }
    });
    const fallback = managedAttemptDriver(loadJob(job.id));
    await fallback.start(loadJob(job.id));
  }
}

const ATTEMPT_RUNNERS = Object.freeze({
  'codex-app-server': runCodex,
  'cursor-acp': runCursorAcpWithFallback,
  'cursor-headless': runCursorHeadless
});

function invokeLifecycleOperation(operation, ...args) {
  if (typeof operation !== 'function') throw new TypeError('attempt-driver lifecycle operation must be a function');
  return operation(...args);
}

export function managedAttemptDriver(job) {
  const lane = attemptLane(job);
  const runner = ATTEMPT_RUNNERS[lane];
  let driver;
  const execute = (attempt = job) => runner(attempt, driver);
  driver = createAttemptDriver(lane, {
    start: execute,
    resume: execute,
    prompt: async (operation, ...args) => {
      const budget = workBudgetSnapshot(loadJob(job.id) || job);
      if (budget?.exhausted) throw brokerError('BUDGET_EXCEEDED', 'work-level reported-output budget is exhausted before a new provider turn', { provider: job.provider });
      return invokeLifecycleOperation(operation, ...args);
    },
    steer: invokeLifecycleOperation,
    cancel: invokeLifecycleOperation,
    close: invokeLifecycleOperation
  });
  return driver;
}

async function runProviderAttempt(job) {
  const driver = managedAttemptDriver(job);
  if (job.providerSessionId) await driver.resume(job);
  else await driver.start(job);
}

function retryClass(error) {
  const message = String(error?.message || '');
  const providerFailure = error?.retryable === true && ['TRANSPORT_ERROR', 'RPC_TIMEOUT', 'PROVIDER_ERROR'].includes(error.code);
  if (providerFailure && /\b429\b|rate[- ]?limit|too many requests|\b(?:http(?: status)?|status(?: code)?|server(?: error)?)\s*5\d\d\b/i.test(message)) return 'rate-limit';
  if (providerFailure) return 'transport';
  return null;
}

function retryDelayMs(retryNumber) {
  const configured = Number(process.env.DELEGATE_RETRY_BASE_MS ?? 2000);
  const base = Number.isFinite(configured) && configured >= 0 ? configured : 2000;
  return Math.min(30000, base * (2 ** Math.max(retryNumber - 1, 0)));
}

function honorCommandsBeforeRetry(job) {
  let cancelled = false;
  for (const claimed of claimProviderCommands(job.id)) {
    if (claimed.command.type === 'cancel') {
      completeCommand(job.id, claimed, { ok: true, appliedAs: 'cancel-before-retry' });
      cancelled = true;
    } else if (claimed.command.type === 'steer') {
      completeCommand(job.id, claimed, { ok: false, error: 'job is between provider attempts; steering requires an active attempt' });
    } else {
      completeCommand(job.id, claimed, { ok: false, error: `job is between provider attempts; ${claimed.command.type} is unavailable` });
    }
  }
  if (cancelled) terminal(loadJob(job.id), 'cancelled', 'cancelled');
  return cancelled;
}

export async function runManagedProvider(job) {
  updateManagedJob(job.id, (current) => { current.status = 'running'; current.phase = 'starting'; current.workerPid = process.pid; });
  appendJobEvent(job.id, 'job.state', { status: 'running', phase: 'starting', transport: job.transport });
  const policy = job.retryPolicy || { maxAttempts: 1, retryOn: [] };
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const budget = workBudgetSnapshot(loadJob(job.id));
      if (budget?.exhausted) throw brokerError('BUDGET_EXCEEDED', 'work-level reported-output budget is exhausted before provider start', { provider: job.provider });
      await runProviderAttempt(loadJob(job.id));
      const current = inspectJob(job.id);
      if (current.status === 'running' && current.phase === 'verifying') await finishVerification(loadJob(job.id));
      return;
    } catch (error) {
      const typed = normalizeBrokerError(error, { provider: job.provider, defaultCode: 'TRANSPORT_ERROR' });
      if (typed.observedVersion) {
        persistProviderCliVersion(job.id, { observedVersion: typed.observedVersion }, 'failed-cli-version-check');
      }
      if (/(?:quota|usage limit|rate limit|allowance)/i.test(typed.message || '')) {
        mutateState((state) => setWindow(state, job.provider, 'quota-error', 100, { source: 'quota-error' }));
      }
      const category = retryClass(typed);
      const canRetry = attempt < policy.maxAttempts && category && policy.retryOn.includes(category);
      if (canRetry) {
        const retryNumber = attempt;
        const delayMs = retryDelayMs(retryNumber);
        updateManagedJob(job.id, (current) => {
          current.retries = retryNumber;
          current.phase = 'retrying';
          current.providerTurnId = null;
        });
        appendJobEvent(job.id, 'job.retry', { attempt: attempt + 1, code: typed.code, delayMs });
        await delay(delayMs);
        if (honorCommandsBeforeRetry(job)) return;
        updateManagedJob(job.id, (current) => { current.phase = 'starting'; }, { incrementRevision: false });
        if (honorCommandsBeforeRetry(job)) return;
        continue;
      }
      const current = inspectJob(job.id);
      if (!['completed', 'cancelled', 'failed'].includes(current.status)) {
        terminal(loadJob(job.id), 'failed', 'failed', {
          error: typed.message,
          errorCode: typed.code,
          errorRetryable: typed.retryable,
          ...(typed.provider ? { errorProvider: typed.provider } : {}),
          ...(typed.code === 'BUDGET_EXCEEDED' ? { stoppedReason: 'budget' } : {}),
          ...(typed.code === 'LARGE_WRITE' ? { stoppedReason: 'large-write' } : {})
        });
      }
      throw typed;
    }
  }
}
