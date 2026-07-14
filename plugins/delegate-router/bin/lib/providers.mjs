import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendJobEvent, claimCommands, completeCommand, completeIngestedFiles, DeltaRedactor, hashWorkingFile, inspectJob, jobFiles, pathMatchesScope, redact, settleQueuedControl, updateManagedJob, usageTotals } from './control.mjs';
import {
  availableModelIds,
  buildCursorArgs,
  findValue,
  resolveCursorBinary,
  resolveCursorModel,
  runCursor
} from './cursor.mjs';
import { compareVersions } from './cursor.mjs';
import { delay, JsonRpcProcess } from './jsonrpc.mjs';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { assembleProviderPrompt, securityPreamble } from './packet.mjs';
import { terminateProcessTree } from './process.mjs';
import { loadJob, mutateState, setWindow } from './state.mjs';

export { securityPreamble } from './packet.mjs';

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

function codexModel(model) {
  return ({ sol: 'gpt-5.6-sol', terra: 'gpt-5.6-terra', luna: 'gpt-5.6-luna' })[model] || (model === 'auto' ? null : model);
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
    job.result = firstAttemptText == null
      ? redact(result)
      : { ...(result && typeof result === 'object' ? redact(result) : { text: redact(result) }), firstAttemptText };
  }, { incrementRevision: false });
}

function largeWriteLimit() {
  const configured = Number(process.env.DELEGATE_MAX_CHANGED_FILES ?? 200);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 200;
}

function codexChangedPaths(item) {
  if (item?.type !== 'fileChange') return [];
  return (item.changes || []).map((change) => change?.path || change?.file || change?.filename).filter(Boolean);
}

function parseLastStructuredResult(text) {
  const blocks = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!blocks.length) return null;
  try {
    const parsed = JSON.parse(blocks.at(-1)[1].trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function holdBeforeFirstTurn(job, deadline) {
  if (!job.startPaused) return true;
  updateManagedJob(job.id, (current) => { current.phase = 'paused'; });
  appendJobEvent(job.id, 'job.state', { status: 'running', phase: 'paused' });
  for (;;) {
    if (Date.now() >= deadline) {
      throw brokerError('TIMEOUT', `managed job timed out while paused before its first prompt`, { provider: job.provider });
    }
    for (const claimed of claimCommands(job.id)) {
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
  if (Number.isFinite(job?.timeoutSeconds) && job.timeoutSeconds > 0) {
    return Math.min(Math.max(job.timeoutSeconds, 60), maximumSeconds) * 1000;
  }
  return boundedTimeoutMs(name, fallbackSeconds, maximumSeconds);
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
  const launch = provider === 'cursor' ? cursorCommand(binary, ['--version']) : { command: binary, args: ['--version'] };
  const result = spawnSync(launch.command, launch.args, {
    encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const observed = parsedVersion(output);
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

function recordUsage(job, usage, options = {}) {
  appendJobEvent(job.id, 'usage.updated', usage, options);
  updateManagedJob(job.id, (current) => { current.usage = usage; }, { incrementRevision: false });
  const totals = usageTotals(usage);
  if (!job.maxOutputTokens || !totals || totals.outputTokens <= job.maxOutputTokens) return null;
  return brokerError('BUDGET_EXCEEDED', `output token usage ${totals.outputTokens} exceeded maxOutputTokens ${job.maxOutputTokens}`, {
    provider: job.provider,
    maxOutputTokens: job.maxOutputTokens,
    observedOutputTokens: totals.outputTokens
  });
}

function recordBudgetExceeded(job, error, options = {}) {
  appendJobEvent(job.id, 'budget.exceeded', {
    code: error.code,
    retryable: error.retryable,
    maxOutputTokens: error.maxOutputTokens,
    observedOutputTokens: error.observedOutputTokens
  }, options);
}

function terminal(job, status, phase, extra = {}) {
  // The worker's final message is self-reported and can contradict what it
  // actually did; record the plugin's own observation of changed files so the
  // coordinator's first read of the job record is grounded.
  let changedFiles = null;
  let finalHashes = null;
  let scopeViolations = null;
  if (['implement', 'verify'].includes(job.mode)) {
    try {
      const files = jobFiles(job.id);
      const baseline = new Set(job.baselineFiles || []);
      const entries = files.map((file) => {
        const finalHash = hashWorkingFile(job.cwd, file.path);
        return {
          path: file.path,
          ...(file.status ? { status: file.status } : {}),
          ...(file.kind ? { kind: file.kind } : {}),
          ...((file.preexisting || baseline.has(file.path)) ? { preexisting: true } : {}),
          ...(file.overlapsPreexisting ? { overlapsPreexisting: true } : {}),
          ...(finalHash ? { finalHash } : {})
        };
      });
      const names = entries.map((file) => file.path);
      changedFiles = { count: names.length, files: names.slice(0, 50), entries: entries.slice(0, 1000) };
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
  const deferVerification = status === 'completed' && job.verify && !loadJob(job.id)?.verification;
  let ingestOutcome = null;
  if (status === 'completed' && !deferVerification && job.stagingDir) {
    try { ingestOutcome = completeIngestedFiles(job); }
    catch (error) { ingestOutcome = { copiedBack: [], removed: false, error: redact(error.message) }; }
  }
  updateManagedJob(job.id, (current) => {
    const firstAttemptText = current.result?.firstAttemptText;
    current.status = deferVerification ? 'running' : status;
    current.phase = deferVerification ? 'verifying' : phase;
    if (!deferVerification) current.completedAt = Math.floor(Date.now() / 1000);
    if (changedFiles) current.changedFiles = changedFiles;
    if (finalHashes) current.finalHashes = finalHashes;
    if (scopeViolations) current.scopeViolations = scopeViolations;
    Object.assign(current, redact(extra));
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
    if (!deferVerification && status === 'completed' && current.reportSchema) {
      const structured = parseLastStructuredResult(text);
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
    if (!deferVerification && status === 'completed' && ['consult', 'plan', 'review'].includes(job.mode)
      && !current.result?.plan && (!text || text.trim().length < 200)) {
      current.resultSuspect = 'short-final-message';
    }
    // The write-mode analogue (field-observed: a Codex pre-implementation
    // audit returned analysis instead of code): completed with zero observed
    // changes means the objective was not met, on the record itself and not
    // only via the wait exit code.
    if (!deferVerification && status === 'completed' && ['implement', 'verify'].includes(job.mode)
      && changedFiles && changedFiles.count === 0) {
      current.resultSuspect = 'no-changes-write-mode';
    }
  });
  appendJobEvent(job.id, deferVerification
    ? 'job.state'
    : status === 'completed' ? 'job.completed' : status === 'cancelled' ? 'job.cancelled' : 'error',
  deferVerification ? { status: 'running', phase: 'verifying' } : extra);
}

function recordSession(jobId, sessionId, turnId = undefined) {
  updateManagedJob(jobId, (job) => {
    if (sessionId) {
      job.providerSessionId = sessionId;
      job.session = sessionId;
    }
    if (turnId !== undefined) job.providerTurnId = turnId;
    job.phase = turnId ? 'running' : job.phase;
  });
  appendJobEvent(jobId, 'session.updated', { sessionId, turnId });
}

function mapCodexItem(jobId, phase, params, activity = null) {
  const item = params.item || {};
  const options = { sessionId: params.threadId, turnId: params.turnId };
  activity?.mark(codexActivitySignal('', item));
  if (item.type === 'reasoning') return;
  if (item.type === 'agentMessage' && phase === 'completed') {
    appendJobEvent(jobId, 'message.completed', { id: item.id, text: item.text, phase: item.phase }, options);
    storeProviderResult(jobId, item.text);
  } else if (item.type === 'plan') {
    appendJobEvent(jobId, 'plan.updated', { id: item.id, text: item.text, phase }, options);
  } else if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall') {
    // Collab-agent items mean the thread engaged Codex's multi-agent review
    // flow; such threads refuse direct resume. Mark the job so delegate_resume
    // can fail fast with the recovery instead of a provider round-trip.
    if (item.type === 'collabAgentToolCall') {
      updateManagedJob(jobId, (job) => { job.reviewFlowEngaged = true; }, { incrementRevision: false });
    }
    const type = phase === 'started' ? 'tool.started' : 'tool.completed';
    appendJobEvent(jobId, type, { item }, options);
  } else if (item.type === 'fileChange') {
    appendJobEvent(jobId, 'file.changed', { changes: item.changes || [], status: item.status, phase }, options);
  } else if (item.type !== 'reasoning' && item.type !== 'userMessage') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: `item/${phase}`, itemType: item.type, itemId: item.id }, options);
  }
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

async function runCodex(job) {
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
  let largeWriteError = null;
  const liveChangedPaths = new Set();
  const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CODEX_TIMEOUT_SECONDS', 3600);
  const deadline = (job.createdAt || Math.floor(Date.now() / 1000)) * 1000 + timeoutMs;
  const binary = process.env.DELEGATE_CODEX_BIN || 'codex';
  assertProviderVersion('codex', binary);
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
        if (exceeded && !budgetError) {
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

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'delegate-router', title: 'Delegate Router', version: '0.23.2' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    rpc.notify('initialized', {});
    const model = codexModel(job.model);
    const common = {
      model,
      cwd: job.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: codexSandboxMode(job),
      developerInstructions: securityPreamble(job.allowSensitive),
      config: job.effort ? { model_reasoning_effort: job.effort } : {}
    };
    let thread;
    try {
      thread = job.providerSessionId
        ? await rpc.request('thread/resume', { threadId: job.providerSessionId, ...common, excludeTurns: true })
        : await rpc.request('thread/start', common);
    } catch (error) {
      throw mapCodexResumeError(error, Boolean(job.providerSessionId));
    }
    const threadId = thread.thread.id;
    recordSession(job.id, threadId, null);
    if (thread.model) {
      updateManagedJob(job.id, (current) => { current.resolvedModel = thread.model; }, { incrementRevision: false });
    }

    const startTurn = async (text) => {
      turnDone = new Promise((resolve) => { turnResolve = resolve; });
      let result;
      try {
        result = await rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          cwd: job.cwd,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          model
        });
      } catch (error) {
        throw mapCodexResumeError(error, Boolean(job.providerSessionId));
      }
      recordSession(job.id, threadId, result.turn.id);
      return result.turn.id;
    };

    if (!await holdBeforeFirstTurn(loadJob(job.id), deadline)) return;
    await startTurn(promptFor(loadJob(job.id)));
    while (true) {
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
      for (const claimed of claimCommands(job.id)) {
        const command = claimed.command;
        try {
          const current = inspectJob(job.id);
          if (command.type === 'cancel') {
            for (const queued of queuedPrompts) {
              appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' });
              settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
            }
            queuedPrompts.length = 0;
            cancelled = true;
            const graceMs = drainGraceMs();
            cancelDrainDeadline = Date.now() + graceMs;
            if (current.providerTurnId) {
              await rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId }, Math.max(graceMs, 1))
                .catch((error) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'cancel-interrupt-error', error: error.message }));
            }
            completeCommand(job.id, claimed, { ok: true, appliedAs: 'interrupt' });
          } else if (command.type === 'steer') {
            if (cancelled) {
              completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
              continue;
            }
            const strategy = command.strategy || 'auto';
            if ((strategy === 'auto' || strategy === 'same-turn') && current.providerTurnId) {
              try {
                await rpc.request('turn/steer', {
                  threadId,
                  expectedTurnId: command.expectedTurnId || current.providerTurnId,
                  input: [{ type: 'text', text: command.text, text_elements: [] }]
                });
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
                await rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId });
              }
              appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy });
              completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: strategy === 'restart' ? 'restart' : 'next-turn' });
            }
          } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
        } catch (error) {
          completeCommand(job.id, claimed, { ok: false, error: error.message });
        }
      }
      if (completed) {
        interruptRequested = false;
        if (largeWriteError) throw largeWriteError;
        if (budgetError) throw budgetError;
        if (cancelled) { terminal(job, 'cancelled', 'cancelled'); break; }
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
    await rpc.stop();
  }
}

function cursorCommand(binary, args, interactive = true) {
  if (process.platform !== 'darwin' || process.env.DELEGATE_CURSOR_LOGIN_SHELL === '0') return { command: binary, args };
  const shell = process.env.SHELL || '/bin/zsh';
  // Headless must not use -i: an interactive zsh reads the NDJSON stream as
  // shell commands. ACP keeps -i for keychain-backed login environments.
  const flags = interactive ? '-lic' : '-lc';
  return { command: shell, args: [flags, 'exec "$@"', 'delegate-cursor-shell', binary, ...args] };
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
      || b.base.localeCompare(a.base, undefined, { numeric: true }));
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

function mapAcpUpdate(job, update, sessionId, messageParts, deltas, planHolder, activity = null) {
  const jobId = job.id;
  const kind = update.sessionUpdate;
  const options = { sessionId };
  const signal = cursorAcpActivitySignal(update);
  if (signal) activity?.mark(signal);
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text || '';
    messageParts.push(text);
    appendJobEvent(jobId, 'message.delta', { id: update.messageId, delta: deltas.redactDelta(`message:${update.messageId ?? 'acp'}`, text) }, options);
  } else if (kind === 'plan' || kind === 'plan_update') {
    appendJobEvent(jobId, 'plan.updated', update, options);
    // Plan-mode output arrives here, not as agent message chunks; hold the
    // latest entries so the terminal result can carry the actual plan.
    const entries = update.entries || update.plan?.entries || null;
    if (planHolder && entries) planHolder.entries = entries;
  }
  else if (kind === 'tool_call') {
    appendJobEvent(jobId, 'tool.started', update, options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
  } else if (kind === 'tool_call_update') {
    const type = ['completed', 'failed'].includes(update.status) ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, update, options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
  } else if (kind === 'agent_thought_chunk') {
    return undefined;
  } else if (kind === 'usage_update') {
    return recordUsage(job, update, options);
  } else if (kind === 'session_info_update') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: 'session/update:session_info_update' }, options);
    if (update.model) {
      // The session's own report is the ground truth for resolvedModel, but a
      // silent overwrite hid fast-variant swaps from coordinators; disagreement
      // with the negotiated value must be loud.
      const current = loadJob(jobId);
      if (current?.resolvedModel && current.resolvedModel !== update.model) {
        appendJobEvent(jobId, 'provider.event', { providerEvent: 'cursor:model-mismatch', negotiated: current.resolvedModel, reported: update.model }, options);
      }
      updateManagedJob(jobId, (job) => { job.resolvedModel = update.model; }, { incrementRevision: false });
    }
  } else if (kind !== 'agent_thought_chunk' && kind !== 'user_message_chunk') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: `session/update:${kind}` }, options);
  }
}

function gitWorkspaceState(job) {
  const cwd = job.cwd;
  const options = { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 };
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  if (status.status !== 0) return { diff: '', files: [], error: (status.stderr || 'git status failed').trim() };
  const entries = status.stdout.split('\0').filter(Boolean);
  const files = [];
  const baseline = new Set(job.baselineFiles || []);
  const sensitive = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private.?key|token)[^/]*|[^/]+\.(?:pem|key|p12|pfx|crt|cer))$/i;
  const internalRoot = job.promptPath ? path.relative(cwd, path.dirname(job.promptPath)) : null;
  const isInternal = (file) => internalRoot && internalRoot !== '..' && !internalRoot.startsWith(`..${path.sep}`)
    && (file === internalRoot || file.startsWith(`${internalRoot}/`));
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const statusCode = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) files.push({ path: file, status: statusCode, preexisting: baseline.has(file), contentExcluded: sensitive.test(file) || isInternal(file) });
    if (/[RC]/.test(statusCode) && entries[i + 1]) {
      const source = entries[++i];
      files.push({ path: source, status: `${statusCode}:source`, preexisting: baseline.has(source), contentExcluded: sensitive.test(source) || isInternal(source) });
    }
  }
  let diff = '';
  let includesPreexisting = false;
  const errors = [];
  const baselineHashes = job.baselineHashes || {};
  const limit = Math.min(files.length, 1000);
  if (files.length > limit) errors.push(`file inventory capped at ${limit} of ${files.length}`);
  for (const item of files.slice(0, limit)) {
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
      if (item.preexisting && !item.overlapsPreexisting) continue;
      try {
        if (fs.statSync(path.join(cwd, item.path)).size > 5 * 1024 * 1024) {
          errors.push(`untracked file too large to diff: ${item.path}`);
          continue;
        }
      } catch { continue; }
      result = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', item.path], options);
      if (result.status !== 0 && result.status !== 1) errors.push((result.stderr || `cannot diff untracked file ${item.path}`).trim());
    } else {
      result = spawnSync('git', ['diff', '--no-ext-diff', 'HEAD', '--', item.path], options);
      if (result.status !== 0) {
        const cached = spawnSync('git', ['diff', '--no-ext-diff', '--cached', '--', item.path], options);
        const unstaged = spawnSync('git', ['diff', '--no-ext-diff', '--', item.path], options);
        result = { status: cached.status || unstaged.status, stdout: `${cached.stdout || ''}${unstaged.stdout || ''}`, stderr: cached.stderr || unstaged.stderr };
      }
      if (result.status !== 0) errors.push((result.stderr || `cannot diff tracked file ${item.path}`).trim());
    }
    if (result?.stdout) {
      diff += result.stdout;
      if (item.preexisting) includesPreexisting = true;
    }
  }
  return { diff, files, includesPreexisting, error: errors.filter(Boolean).join('; ') || null };
}

function recordGitState(job, sessionId) {
  const state = gitWorkspaceState(job);
  const changed = state.files.filter((file) => !file.unchangedSinceBaseline);
  for (const file of state.files) {
    // Pre-existing files proven byte-identical to the job-start baseline were
    // at most read, never changed — emitting file.changed for them is exactly
    // the attribution noise this filter removes.
    if (file.unchangedSinceBaseline) continue;
    appendJobEvent(job.id, 'file.changed', file, { sessionId });
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

async function runCursorAcp(job) {
  const binary = resolveCursorBinary();
  if (!binary) throw brokerError('TRANSPORT_ERROR', 'neither agent nor cursor-agent is executable', { provider: job.provider });
  assertProviderVersion('cursor', binary);
  const sandboxValue = job.sandbox === 'off' ? 'disabled' : 'enabled';
  const rootArgs = readOnly(job) ? ['--sandbox', sandboxValue, 'acp'] : ['--auto-review', '--sandbox', sandboxValue, 'acp'];
  const launch = cursorCommand(binary, rootArgs);
  let sessionId = job.providerSessionId;
  let cancelRequested = false;
  const pendingCorrections = [];
  let cancelSignalSent = false;
  let promptPromise = null;
  const messageParts = [];
  const planHolder = { entries: null };
  const deltas = new DeltaRedactor();
  const activity = new ActivityTransitionEmitter(job.id);
  let budgetError = null;
  const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600);
  const deadline = (job.createdAt || Math.floor(Date.now() / 1000)) * 1000 + timeoutMs;
  const rpc = new JsonRpcProcess(launch.command, launch.args, {
    cwd: job.cwd,
    onStderr: (text) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text: deltas.redactDelta('stderr', text) }),
    onNotification: async (method, params) => {
      if (method === 'session/update') {
        const exceeded = mapAcpUpdate(job, params.update || {}, params.sessionId, messageParts, deltas, planHolder, activity);
        if (exceeded && !budgetError) {
          budgetError = exceeded;
          recordBudgetExceeded(job, exceeded, { sessionId: params.sessionId });
          if (!cancelSignalSent && (params.sessionId || sessionId)) {
            rpc.notify('session/cancel', { sessionId: params.sessionId || sessionId });
            cancelSignalSent = true;
          }
        }
      }
    },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw brokerError('INVALID_REQUEST', `Unsupported ACP request: ${method}`, { provider: job.provider });
      activity.mark('output');
      appendJobEvent(job.id, 'approval.requested', { method, toolCall: params.toolCall, options: params.options }, { sessionId });
      const allow = job.approval === 'force' ? params.options?.find((option) => /allow/i.test(option.kind)) : null;
      const reject = params.options?.find((option) => /reject|deny/i.test(option.kind));
      const selected = allow || reject;
      const outcome = selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' };
      appendJobEvent(job.id, 'approval.resolved', { outcome }, { sessionId });
      return { outcome };
    }
  });

  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'delegate-router', version: '0.23.2' }
    });
    const session = sessionId
      ? await rpc.request('session/load', { sessionId, cwd: job.cwd, mcpServers: [] })
      : await rpc.request('session/new', { cwd: job.cwd, mcpServers: [] });
    sessionId ||= session.sessionId;
    recordSession(job.id, sessionId, null);
    const config = session.configOptions || [];
    const modelOption = config.find((item) => item.id === 'model');
    const modeOption = config.find((item) => item.id === 'mode');
    if (modelOption) {
      let resolvedModel;
      try {
        const detailed = cursorModelDetailed(modelOption.options || [], job.model);
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
      updateManagedJob(job.id, (current) => {
        current.model = resolvedModel;
        current.resolvedModel = resolvedModel;
      }, { incrementRevision: false });
    }
    if (modeOption) await rpc.request('session/set_config_option', {
      sessionId, configId: 'mode', value: readOnly(job) ? (job.mode === 'consult' ? 'ask' : 'plan') : 'agent'
    });

    if (!await holdBeforeFirstTurn(loadJob(job.id), deadline)) return;

    const startPrompt = (text) => {
      messageParts.length = 0;
      cancelSignalSent = false;
      appendJobEvent(job.id, 'turn.started', { transport: 'acp' }, { sessionId });
      promptPromise = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, Math.max(1, deadline - Date.now()));
    };
    startPrompt(promptFor(loadJob(job.id)));

    while (true) {
      if (Date.now() >= deadline) {
        if (!cancelSignalSent) rpc.notify('session/cancel', { sessionId });
        throw brokerError('TIMEOUT', `Cursor managed job exceeded ${Math.round(timeoutMs / 1000)}s`, { provider: job.provider });
      }
      const completed = await Promise.race([
        promptPromise.then((response) => ({ response }), (error) => ({ error })),
        delay(150).then(() => null)
      ]);
      for (const claimed of claimCommands(job.id)) {
        const command = claimed.command;
        if (command.type === 'cancel') {
          cancelRequested = true;
          for (const queued of pendingCorrections) {
            appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' }, { sessionId });
            settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
          }
          pendingCorrections.length = 0;
          if (!cancelSignalSent) { rpc.notify('session/cancel', { sessionId }); cancelSignalSent = true; }
          completeCommand(job.id, claimed, { ok: true, appliedAs: 'cancel' });
        } else if (command.type === 'steer') {
          if (cancelRequested) {
            completeCommand(job.id, claimed, { ok: false, error: 'JOB_CANCELLING: correction rejected' });
          } else if (command.strategy === 'same-turn') {
            completeCommand(job.id, claimed, { ok: false, error: 'UNSUPPORTED_STRATEGY: ACP v1 has no same-turn steering' });
          } else {
            pendingCorrections.push({ text: command.text, commandId: command.commandId });
            if (!cancelSignalSent) { rpc.notify('session/cancel', { sessionId }); cancelSignalSent = true; }
            appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy: 'restart' }, { sessionId });
            completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'restart' });
          }
        } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
      }
      if (!completed) continue;
      if (completed.error) throw completed.error;
      if (acpGraceMs()) await delay(acpGraceMs());
      appendJobEvent(job.id, 'turn.completed', completed.response, { sessionId });
      if (messageParts.length) appendJobEvent(job.id, 'message.completed', { text: messageParts.join('') }, { sessionId });
      if (completed.response.usage) {
        const exceeded = recordUsage(job, completed.response.usage, { sessionId });
        if (exceeded && !budgetError) {
          budgetError = exceeded;
          recordBudgetExceeded(job, exceeded, { sessionId });
        }
      }
      if (budgetError) {
        recordGitState(job, sessionId);
        throw budgetError;
      }
      if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); break; }
      if (pendingCorrections.length) {
        const next = pendingCorrections.shift();
        settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
        appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId });
        startPrompt(next.text);
        continue;
      }
      const planText = planEntriesText(planHolder.entries);
      const result = {
        text: messageParts.join(''),
        ...(planText ? { plan: planText } : {}),
        stopReason: completed.response.stopReason
      };
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
  } finally {
    activity.close();
    await rpc.stop();
  }
}

function mapHeadlessEvent(job, event, deltas) {
  const jobId = job.id;
  const sessionId = findValue(event, ['session_id', 'sessionId', 'chat_id', 'chatId']);
  if (sessionId) {
    updateManagedJob(jobId, (job) => { job.providerSessionId = sessionId; job.session = sessionId; }, { incrementRevision: false });
  }
  const options = { sessionId };
  const usage = event.usage || (event.type === 'usage_update' || event.subtype === 'usage_update' ? event : null);
  const exceeded = usage ? recordUsage(job, usage, options) : null;
  if (event.type === 'assistant') {
    const text = findValue(event, ['text', 'content', 'message']) || '';
    appendJobEvent(jobId, 'message.delta', { delta: deltas.redactDelta('message:headless', typeof text === 'string' ? text : JSON.stringify(text)) }, options);
  } else if (event.type === 'tool_call') {
    const type = event.subtype === 'started' ? 'tool.started' : event.subtype === 'completed' ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, { toolCall: event.tool_call, subtype: event.subtype }, options);
  } else if (event.type === 'result') {
    if (event.result) appendJobEvent(jobId, 'message.completed', { text: event.result }, options);
  } else appendJobEvent(jobId, 'provider.event', { providerEvent: `cursor:${event.type || 'unknown'}`, subtype: event.subtype }, options);
  return exceeded;
}

async function runCursorHeadless(job) {
  const binary = resolveCursorBinary();
  if (!binary) throw brokerError('TRANSPORT_ERROR', 'neither agent nor cursor-agent is executable', { provider: job.provider });
  assertProviderVersion('cursor', binary);
  const ids = process.platform === 'darwin' && process.env.DELEGATE_CURSOR_LOGIN_SHELL !== '0'
    ? []
    : availableModelIds(binary);
  const model = resolveCursorModel(job.model, ids);
  let resume = job.providerSessionId;
  let text = promptFor(job);
  let cancelRequested = false;
  const pendingCorrections = [];
  const deltas = new DeltaRedactor();
  let budgetError = null;
  let budgetTermination = null;

  while (true) {
    let activeChild = null;
    appendJobEvent(job.id, 'turn.started', { transport: 'headless', resume }, { sessionId: resume });
    const headless = cursorCommand(binary, buildCursorArgs({ mode: job.mode, model, cwd: job.cwd, approval: job.approval, resume, sandbox: job.sandbox }), false);
    const running = runCursor({
      binary: headless.command,
      args: headless.args,
      cwd: job.cwd,
      prompt: text,
      timeoutMs: jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600),
      onChild: (child) => { activeChild = child; },
      onEvent: (event) => {
        const exceeded = mapHeadlessEvent(job, event, deltas);
        if (exceeded && !budgetError) {
          budgetError = exceeded;
          recordBudgetExceeded(job, exceeded, { sessionId: resume });
          if (activeChild) budgetTermination = terminateProcessTree(activeChild);
        }
      }
    });
    let outcome;
    while (!outcome) {
      outcome = await Promise.race([running, delay(150).then(() => null)]);
      for (const claimed of claimCommands(job.id)) {
        const command = claimed.command;
        if (command.type === 'cancel') {
          cancelRequested = true;
          for (const queued of pendingCorrections) {
            appendJobEvent(job.id, 'correction.rejected', { commandId: queued.commandId, reason: 'job cancelled' }, { sessionId: resume });
            settleQueuedControl(job.id, queued.commandId, { ok: false, error: 'job cancelled before correction started' });
          }
          pendingCorrections.length = 0;
          if (activeChild) await terminateProcessTree(activeChild);
          completeCommand(job.id, claimed, { ok: true, appliedAs: 'process-tree-termination' });
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
              if (first && activeChild) await terminateProcessTree(activeChild);
              appendJobEvent(job.id, 'correction.queued', { commandId: command.commandId, strategy: 'restart' }, { sessionId: resume });
              completeCommand(job.id, claimed, { ok: true, state: 'queued', appliedAs: 'restart' });
            }
          }
        } else completeCommand(job.id, claimed, { ok: false, error: `unsupported command: ${command.type}` });
      }
    }
    if (budgetTermination) await budgetTermination;
    appendJobEvent(job.id, 'turn.completed', { status: outcome.status, error: outcome.error }, { sessionId: resume });
    if (budgetError) {
      recordGitState(job, resume);
      throw budgetError;
    }
    if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); return; }
    if (pendingCorrections.length) {
      const next = pendingCorrections.shift();
      settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
      appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId: resume });
      text = next.text;
      continue;
    }
    if (outcome.status !== 0) {
      recordGitState(job, resume);
      if (outcome.timedOut) throw brokerError('TIMEOUT', outcome.error || 'Cursor headless execution timed out', { provider: job.provider });
      throw brokerError('PROVIDER_ERROR', outcome.error || 'Cursor headless execution failed', { provider: job.provider });
    }
    const sessionId = findValue(outcome.payload, ['session_id', 'sessionId', 'chat_id', 'chatId']);
    if (sessionId) recordSession(job.id, sessionId, null);
    if (sessionId && prepareAutoNudge(job.id, outcome.payload)) {
      resume = sessionId;
      text = AUTO_NUDGE_PROMPT;
      continue;
    }
    recordGitState(job, sessionId);
    terminal(job, 'completed', 'completed', { result: redact(outcome.payload), session: sessionId });
    return;
  }
}

function verificationFailure(job, message, exitCode = 127) {
  return {
    command: job.verify?.command || '[unavailable]',
    exitCode,
    durationMs: 0,
    outputTail: redact(message, '', 2000)
  };
}

async function executeVerification(job) {
  let command;
  try { command = fs.readFileSync(job.verifyCommandPath, 'utf8'); }
  catch (error) { return verificationFailure(job, `verification command is unavailable: ${error.message}`); }
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: job.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let output = '';
    let settled = false;
    let timedOut = false;
    let timer;
    const append = (chunk) => { output = `${output}${String(chunk)}`.slice(-8192); };
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: job.verify.command,
        exitCode,
        durationMs: Date.now() - started,
        outputTail: redact(output.slice(-2000), '', 2000)
      });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => { append(error.message); finish(127); });
    child.once('exit', (code, signal) => finish(timedOut ? 124 : Number.isInteger(code) ? code : signal ? 128 : 1));
    timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child);
      finish(124);
    }, job.verify.timeoutSeconds * 1000);
    timer.unref?.();
  });
}

async function finishVerification(job) {
  const verification = await executeVerification(job);
  updateManagedJob(job.id, (current) => { current.verification = verification; }, { incrementRevision: false });
  appendJobEvent(job.id, 'verification.finished', verification);
  terminal(loadJob(job.id), 'completed', 'completed');
}

async function runProviderAttempt(job) {
  if (job.provider === 'codex') await runCodex(job);
  else if (job.provider === 'cursor' && job.transport === 'headless') await runCursorHeadless(job);
  else if (job.provider === 'cursor') {
    try { await runCursorAcp(job); }
    catch (error) {
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
      await runCursorHeadless(loadJob(job.id));
    }
  } else throw brokerError('INVALID_REQUEST', `Unsupported managed provider: ${job.provider}`, { provider: job.provider });
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
  for (const claimed of claimCommands(job.id)) {
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
      await runProviderAttempt(loadJob(job.id));
      const current = inspectJob(job.id);
      if (current.status === 'running' && current.phase === 'verifying') await finishVerification(loadJob(job.id));
      return;
    } catch (error) {
      const typed = normalizeBrokerError(error, { provider: job.provider, defaultCode: 'TRANSPORT_ERROR' });
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
