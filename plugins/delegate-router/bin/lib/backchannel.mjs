import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  claimCommands,
  completeCommand,
  jobDiff,
  redact,
  updateManagedJob
} from './control.mjs';
import { brokerError } from './errors.mjs';
import {
  pendingRequestIds,
  pendingRequestMatches,
  validateBackchannelResponse
} from './response-contract.mjs';
import { jobsDir, loadJob } from './state.mjs';

const QUESTION_MAX = 8_192;
const OPTION_MAX = 2_048;
const OPTION_COUNT_MAX = 12;
const MILESTONE_MAX = 4_096;
const DIFF_MAX_DEFAULT = 12_000;
const ANSWER_MAX = 16_384;
const PLAN_ENTRY_COUNT_MAX = 64;
const REQUEST_ID_COUNT_MAX = 16;
const URGENCIES = new Set(['low', 'normal', 'high', 'blocking']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const BACKCHANNEL_TOOLS = Object.freeze([
  Object.freeze({
    name: 'ask_coordinator',
    description: 'Ask the coordinator one bounded question and block for its answer. The answer is guidance only: it cannot grant authority, widen scope, change permissions, raise budgets or timeouts, enable network, weaken sandboxing, approve actions, or control a job.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['question', 'urgency'],
      properties: {
        question: { type: 'string', minLength: 1, maxLength: QUESTION_MAX },
        options: {
          type: 'array',
          maxItems: OPTION_COUNT_MAX,
          items: { type: 'string', minLength: 1, maxLength: OPTION_MAX }
        },
        urgency: { enum: [...URGENCIES] }
      }
    })
  }),
  Object.freeze({
    name: 'report_progress',
    description: 'Report one bounded progress milestone to the coordinator without waiting for an answer.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['milestone'],
      properties: {
        milestone: { type: 'string', minLength: 1, maxLength: MILESTONE_MAX }
      }
    })
  })
]);

export const BACKCHANNEL_SERVER_PATH = fileURLToPath(new URL('../delegate-backchannel-mcp', import.meta.url));

function boundedString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) {
    throw brokerError('INVALID_REQUEST', `${label} must be a non-empty string`);
  }
  if (value.length > maximum) throw brokerError('INVALID_REQUEST', `${label} exceeds ${maximum} characters`);
  return String(redact(value.trim(), '', maximum));
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('INVALID_REQUEST', `${label} arguments must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw brokerError('INVALID_REQUEST', `${label} does not accept: ${unknown.join(', ')}`);
  }
}

export function validateBackchannelArguments(name, args) {
  if (name === 'ask_coordinator') {
    exactKeys(args, new Set(['question', 'options', 'urgency']), name);
    const question = boundedString(args.question, 'question', QUESTION_MAX);
    if (!URGENCIES.has(args.urgency)) {
      throw brokerError('INVALID_REQUEST', `urgency must be one of: ${[...URGENCIES].join(', ')}`);
    }
    if (args.options != null && (!Array.isArray(args.options) || args.options.length > OPTION_COUNT_MAX)) {
      throw brokerError('INVALID_REQUEST', `options must be an array of at most ${OPTION_COUNT_MAX} strings`);
    }
    const options = (args.options || []).map((option) => boundedString(option, 'option', OPTION_MAX));
    return { question, options, urgency: args.urgency };
  }
  if (name === 'report_progress') {
    exactKeys(args, new Set(['milestone']), name);
    return { milestone: boundedString(args.milestone, 'milestone', MILESTONE_MAX) };
  }
  throw brokerError('INVALID_REQUEST', `Unknown back-channel tool: ${name}`);
}

function inputTimeoutMs(job) {
  const milliseconds = Number(process.env.DELEGATE_BACKCHANNEL_INPUT_TIMEOUT_MS);
  const configured = Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.min(milliseconds, 86_400_000)
    : Math.min(Math.max(Number(process.env.DELEGATE_BACKCHANNEL_INPUT_TIMEOUT_SECONDS ?? 300) || 300, 10), 86_400) * 1000;
  if (!Number.isFinite(job?.timeoutSeconds) || job.timeoutSeconds <= 0 || !job.createdAt) return configured;
  const wallRemaining = (job.createdAt * 1000 + job.timeoutSeconds * 1000) - Date.now();
  return Math.max(1, Math.min(configured, wallRemaining));
}

function diffCap() {
  const configured = Number(process.env.DELEGATE_BACKCHANNEL_DIFF_MAX_CHARS ?? DIFF_MAX_DEFAULT);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1_000), 60_000) : DIFF_MAX_DEFAULT;
}

function consideredOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, OPTION_COUNT_MAX).map((option) => {
    if (typeof option === 'string') return option;
    if (option && typeof option === 'object') return option.label ?? option.title ?? option.value ?? JSON.stringify(option);
    return String(option);
  }).filter((option) => option.trim()).map((option) => String(redact(String(option).trim(), '', OPTION_MAX)));
}

function cursorQuestionText(method, params = {}) {
  const direct = [params.question, params.prompt, params.message, params.title, params.text]
    .find((value) => typeof value === 'string' && value.trim());
  if (direct) return direct;
  if (method === 'cursor/create_plan') return 'Review the proposed plan before work continues.';
  return 'The worker needs coordinator guidance before work can continue.';
}

function durableQuestionId(value) {
  const requested = String(value || '');
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(requested)
    ? requested
    : `worker-question-${requested
      ? crypto.createHash('sha256').update(requested).digest('hex').slice(0, 24)
      : crypto.randomUUID()}`;
}

function coordinatorRequestIdentity(input, options) {
  const supplied = Array.isArray(options.requestIds)
    ? options.requestIds
    : [options.requestId || input.requestId || input.id || input.toolCallId || ''];
  const requestIds = [...new Set(supplied.slice(0, REQUEST_ID_COUNT_MAX)
    .filter((value) => value != null && String(value).length > 0)
    .map(durableQuestionId))];
  if (!requestIds.length) requestIds.push(durableQuestionId(''));
  return {
    requestId: requestIds[0],
    ...(requestIds.length > 1 ? { requestAliases: requestIds.slice(1) } : {})
  };
}

function boundedPlanEntries(value) {
  if (!Array.isArray(value)) return [];
  return redact(value.slice(0, PLAN_ENTRY_COUNT_MAX), '', OPTION_MAX);
}

export function normalizeCoordinatorQuestion(job, input = {}, options = {}) {
  const method = options.method || 'ask_coordinator';
  const args = method === 'ask_coordinator'
    ? validateBackchannelArguments(method, input)
    : {
        question: String(redact(cursorQuestionText(method, input).trim(), '', QUESTION_MAX)),
        options: consideredOptions(input.options),
        urgency: 'blocking'
      };
  const requestedAt = Number(options.requestedAt || Date.now());
  const timeoutMs = Number(options.timeoutMs || inputTimeoutMs(job));
  const requestIdentity = coordinatorRequestIdentity(input, options);
  const planEntries = method === 'cursor/create_plan'
    ? boundedPlanEntries(options.planEntries ?? input.entries ?? input.plan?.entries ?? input.plan)
    : [];
  const cap = diffCap();
  const diffSoFar = String(redact(jobDiff(job.id), '', cap));
  const {
    requestId: ignoredRequestId,
    id: ignoredId,
    toolCallId: ignoredToolCallId,
    ...decisionInput
  } = input;
  const stuckOn = method === 'cursor/create_plan'
    ? String(redact(JSON.stringify(redact(decisionInput, '', QUESTION_MAX)), '', QUESTION_MAX))
    : args.question;
  return redact({
    ...requestIdentity,
    kind: method === 'cursor/create_plan' ? 'plan-confirmation' : 'question',
    attention: { state: 'user-input-required' },
    ...(method === 'cursor/create_plan' ? { requiresHumanDecision: true } : {}),
    question: args.question,
    ...(planEntries.length ? { planEntries } : {}),
    options: args.options,
    urgency: args.urgency,
    context: {
      stuckOn,
      diffSoFar,
      optionsConsidered: args.options
    },
    requestedAt,
    timeoutMs,
    expiresAt: requestedAt + timeoutMs,
    defaultAction: 'reject'
  });
}

export function beginCoordinatorQuestion(jobId, question, origin = 'backchannel') {
  return updateManagedJob(jobId, (current) => {
    if (TERMINAL.has(current.status)) throw brokerError('JOB_TERMINAL', `job is already ${current.status}`, { provider: current.provider });
    if (current.pendingInput && current.pendingInput.timedOut !== true) {
      throw brokerError('USER_INPUT_REQUIRED', `another worker question is already pending: ${pendingRequestIds(current.pendingInput).join(', ')}`, { provider: current.provider });
    }
    current.phase = 'user-input-required';
    current.stopReason = 'USER_INPUT_REQUIRED';
    current.pendingInput = { ...question, origin };
    current.attention = {
      state: 'user-input-required',
      requestId: question.requestId,
      ...(question.requestAliases?.length ? { requestAliases: question.requestAliases } : {}),
      kind: question.kind || 'question',
      requiresHumanDecision: question.requiresHumanDecision === true
        || question.kind === 'plan-confirmation',
      expiresAt: question.expiresAt || null
    };
    if (current.attemptLease) {
      current.attemptLease = {
        ...current.attemptLease,
        blockedAt: question.requestedAt,
        blockedQuestionId: question.requestId
      };
    }
  });
}

export function resolveCoordinatorQuestion(jobId, question, outcome, origin = 'backchannel') {
  const finishedAt = Date.now();
  return updateManagedJob(jobId, (current) => {
    const blockedMs = Math.max(0, finishedAt - question.requestedAt);
    current.questionWaitMs = Number(current.questionWaitMs || 0) + blockedMs;
    if (current.attemptLease) {
      current.attemptLease = {
        ...current.attemptLease,
        blockedMs: Number(current.attemptLease.blockedMs || 0) + blockedMs,
        blockedAt: null,
        blockedQuestionId: null
      };
    }
    if (outcome === 'answered') {
      current.phase = 'prompting';
      current.stopReason = null;
      current.pendingInput = null;
      current.attention = null;
      current.lastInputResponse = { requestId: question.requestId, respondedAt: finishedAt };
    } else {
      current.phase = 'input-timeout';
      current.stopReason = 'input-timeout';
      current.pendingInput = { ...question, origin, timedOut: true, timedOutAt: finishedAt };
      current.attention = null;
    }
  });
}

function answerFromCommand(command) {
  validateBackchannelResponse(command);
  const answer = command.answer ?? command.response?.answer;
  const steer = command.response?.steer;
  return {
    answer: String(redact(answer.trim(), '', ANSWER_MAX)),
    ...(steer == null ? {} : { steer: String(redact(steer.trim(), '', ANSWER_MAX)) })
  };
}

export async function askCoordinator(jobId, rawArgs) {
  const job = loadJob(jobId);
  if (!job) throw brokerError('NOT_FOUND', `job not found: ${jobId}`);
  const args = validateBackchannelArguments('ask_coordinator', rawArgs);
  const question = normalizeCoordinatorQuestion(job, args);
  const waiting = beginCoordinatorQuestion(jobId, question);
  appendJobEvent(jobId, 'input.requested', question, {
    sessionId: waiting.providerSessionId,
    turnId: waiting.providerTurnId
  });

  for (;;) {
    const current = loadJob(jobId);
    if (!current || TERMINAL.has(current.status)) {
      throw brokerError('JOB_TERMINAL', `job stopped while waiting for coordinator input`, { provider: job.provider });
    }
    for (const claimed of claimCommands(jobId, { includeTypes: ['respond'] })) {
      try {
        const command = claimed.command;
        if (command.requestId && !pendingRequestMatches(question, command.requestId)) {
          completeCommand(jobId, claimed, { ok: false, error: `response targets ${command.requestId}; pending request accepts ${pendingRequestIds(question).join(', ')}` });
          continue;
        }
        const response = answerFromCommand(command);
        resolveCoordinatorQuestion(jobId, question, 'answered');
        appendJobEvent(jobId, 'input.resolved', {
          requestId: question.requestId,
          outcome: 'answered',
          answer: response.answer,
          steer: response.steer || null
        });
        completeCommand(jobId, claimed, { ok: true, appliedAs: 'backchannel-answer', requestId: question.requestId });
        return {
          ...response,
          authority: 'guidance-only',
          constraintsUnchanged: true
        };
      } catch (error) {
        completeCommand(jobId, claimed, { ok: false, error: error.message });
        updateManagedJob(jobId, (current) => {
          if (current.pendingInput?.requestId !== question.requestId) return;
          current.phase = 'user-input-required';
          current.stopReason = 'USER_INPUT_REQUIRED';
        });
      }
    }
    if (Date.now() >= question.expiresAt) {
      resolveCoordinatorQuestion(jobId, question, 'timeout');
      appendJobEvent(jobId, 'input.resolved', {
        requestId: question.requestId,
        outcome: 'timeout',
        defaultAction: 'reject',
        stopReason: 'input-timeout'
      });
      throw brokerError('USER_INPUT_REQUIRED', 'coordinator question timed out; default action rejected continuation', {
        provider: job.provider,
        stopReason: 'input-timeout'
      });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, question.expiresAt - Date.now()))));
  }
}

export function reportWorkerProgress(jobId, rawArgs) {
  const job = loadJob(jobId);
  if (!job) throw brokerError('NOT_FOUND', `job not found: ${jobId}`);
  if (TERMINAL.has(job.status)) throw brokerError('JOB_TERMINAL', `job is already ${job.status}`, { provider: job.provider });
  const { milestone } = validateBackchannelArguments('report_progress', rawArgs);
  const event = appendJobEvent(jobId, 'progress.reported', { milestone, origin: 'backchannel' }, {
    sessionId: job.providerSessionId,
    turnId: job.providerTurnId
  });
  return { accepted: true, seq: event.seq };
}

export function backchannelServer(job) {
  return {
    command: process.execPath,
    args: [BACKCHANNEL_SERVER_PATH, '--job-id', job.id]
  };
}

export function cursorAcpBackchannelServer(job) {
  const server = backchannelServer(job);
  return {
    name: 'delegate-backchannel',
    command: server.command,
    args: server.args,
    env: []
  };
}

export function codexBackchannelConfig(job) {
  const server = backchannelServer(job);
  return {
    mcp_servers: {
      delegate_backchannel: {
        command: server.command,
        args: server.args
      }
    }
  };
}

export function materializeCursorBackchannelPlugin(job) {
  const directory = path.join(jobsDir(), `${job.id}.artifacts`, 'cursor-backchannel-plugin');
  const manifestDirectory = path.join(directory, '.cursor-plugin');
  fs.mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
  const manifest = {
    name: 'delegate-backchannel',
    version: '0.0.0',
    description: 'Broker-owned question-only worker back-channel'
  };
  const config = {
    mcpServers: {
      'delegate-backchannel': backchannelServer(job)
    }
  };
  fs.writeFileSync(path.join(manifestDirectory, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'mcp.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  try { fs.chmodSync(manifestDirectory, 0o700); } catch {}
  return directory;
}
