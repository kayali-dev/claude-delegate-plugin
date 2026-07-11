import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendJobEvent, claimCommands, completeCommand, inspectJob, redact, settleQueuedControl, updateManagedJob } from './control.mjs';
import {
  availableModelIds,
  buildCursorArgs,
  findValue,
  resolveCursorBinary,
  resolveCursorModel,
  runCursor
} from './cursor.mjs';
import { delay, JsonRpcProcess } from './jsonrpc.mjs';
import { terminateProcessTree } from './process.mjs';
import { loadJob, loadState, saveState, setWindow } from './state.mjs';

const SECURITY = `Security boundary:
- Do not read, print, transmit, or modify credentials, private keys, tokens, or .env files unless the task explicitly authorizes the exact path.
- Preserve pre-existing changes and never revert unrelated work.
- Stay inside the task's allowed scope. Stop and report if required work falls outside it.

`;

function promptFor(job) {
  const prompt = fs.readFileSync(job.promptPath, 'utf8');
  return job.allowSensitive ? prompt : `${SECURITY}${prompt}`;
}

function codexModel(model) {
  return ({ sol: 'gpt-5.6-sol', terra: 'gpt-5.6-terra', luna: 'gpt-5.6-luna' })[model] || (model === 'auto' ? null : model);
}

function readOnly(job) {
  return ['consult', 'plan', 'review'].includes(job.mode);
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

function terminal(job, status, phase, extra = {}) {
  updateManagedJob(job.id, (current) => {
    current.status = status;
    current.phase = phase;
    current.completedAt = Math.floor(Date.now() / 1000);
    Object.assign(current, redact(extra));
  });
  appendJobEvent(job.id, status === 'completed' ? 'job.completed' : status === 'cancelled' ? 'job.cancelled' : 'error', extra);
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

function mapCodexItem(jobId, phase, params) {
  const item = params.item || {};
  const options = { sessionId: params.threadId, turnId: params.turnId };
  if (item.type === 'agentMessage' && phase === 'completed') {
    appendJobEvent(jobId, 'message.completed', { id: item.id, text: item.text, phase: item.phase }, options);
    updateManagedJob(jobId, (job) => { job.result = redact(item.text); }, { incrementRevision: false });
  } else if (item.type === 'plan') {
    appendJobEvent(jobId, 'plan.updated', { id: item.id, text: item.text, phase }, options);
  } else if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall') {
    const type = phase === 'started' ? 'tool.started' : 'tool.completed';
    appendJobEvent(jobId, type, { item }, options);
  } else if (item.type === 'fileChange') {
    appendJobEvent(jobId, 'file.changed', { changes: item.changes || [], status: item.status, phase }, options);
  } else if (item.type !== 'reasoning' && item.type !== 'userMessage') {
    appendJobEvent(jobId, 'provider.event', { providerEvent: `item/${phase}`, itemType: item.type, itemId: item.id }, options);
  }
}

async function runCodex(job) {
  let turnDone = null;
  let turnResolve;
  let cancelled = false;
  const queuedPrompts = [];
  let interruptRequested = false;
  const messages = new Map();
  const rpc = new JsonRpcProcess(process.env.DELEGATE_CODEX_BIN || 'codex', [
    'app-server', '--stdio',
    '-c', 'approval_policy="on-request"',
    '-c', 'approvals_reviewer="auto_review"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'
  ], {
    cwd: job.cwd,
    onStderr: (text) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text }),
    onRequest: async (method, params) => {
      appendJobEvent(job.id, 'approval.requested', { method, params });
      const forced = job.approval === 'force';
      let result;
      if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') result = { decision: forced ? 'accept' : 'decline' };
      else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') result = { decision: forced ? 'accept' : 'decline' };
      else if (method === 'item/tool/requestUserInput') {
        appendJobEvent(job.id, 'error', { code: 'USER_INPUT_REQUIRED', message: 'Codex requested interactive input; managed v1 does not fabricate an answer', request: params });
        throw new Error('USER_INPUT_REQUIRED: inspect the request and resume the job with an explicit answer');
      }
      else throw new Error(`Unsupported app-server request: ${method}`);
      appendJobEvent(job.id, 'approval.resolved', { method, decision: result.decision || 'empty' });
      return result;
    },
    onNotification: async (method, params) => {
      const options = { sessionId: params.threadId, turnId: params.turnId || params.turn?.id };
      if (method === 'turn/started') {
        const turnId = params.turn?.id;
        recordSession(job.id, params.threadId, turnId);
        appendJobEvent(job.id, 'turn.started', { turn: params.turn }, options);
      } else if (method === 'item/agentMessage/delta') {
        const text = `${messages.get(params.itemId) || ''}${params.delta || ''}`;
        messages.set(params.itemId, text);
        appendJobEvent(job.id, 'message.delta', { id: params.itemId, delta: params.delta }, options);
      } else if (method === 'item/started') mapCodexItem(job.id, 'started', params);
      else if (method === 'item/completed') mapCodexItem(job.id, 'completed', params);
      else if (method === 'item/commandExecution/outputDelta') appendJobEvent(job.id, 'tool.output', { id: params.itemId, delta: params.delta }, options);
      else if (method === 'turn/plan/updated') appendJobEvent(job.id, 'plan.updated', { explanation: params.explanation, plan: params.plan }, options);
      else if (method === 'turn/diff/updated') appendJobEvent(job.id, 'diff.updated', { diff: params.diff }, options);
      else if (method === 'thread/tokenUsage/updated') {
        appendJobEvent(job.id, 'usage.updated', params.tokenUsage, options);
        updateManagedJob(job.id, (current) => { current.usage = params.tokenUsage; }, { incrementRevision: false });
      } else if (method === 'turn/completed') {
        appendJobEvent(job.id, 'turn.completed', { turn: params.turn }, options);
        updateManagedJob(job.id, (current) => { current.providerTurnId = null; }, { incrementRevision: false });
        turnResolve?.(params.turn);
      } else if (method === 'error') appendJobEvent(job.id, 'error', params, options);
      else if (!method.includes('reasoning')) appendJobEvent(job.id, 'provider.event', { providerEvent: method }, options);
    }
  });

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'delegate-router', title: 'Delegate Router', version: '0.4.2' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    rpc.notify('initialized', {});
    const model = codexModel(job.model);
    const common = {
      model,
      cwd: job.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: readOnly(job) ? 'read-only' : 'workspace-write',
      developerInstructions: SECURITY,
      config: job.effort ? { model_reasoning_effort: job.effort } : {}
    };
    const thread = job.providerSessionId
      ? await rpc.request('thread/resume', { threadId: job.providerSessionId, ...common, excludeTurns: true })
      : await rpc.request('thread/start', common);
    const threadId = thread.thread.id;
    recordSession(job.id, threadId, null);

    const startTurn = async (text) => {
      turnDone = new Promise((resolve) => { turnResolve = resolve; });
      const result = await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        cwd: job.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        model
      });
      recordSession(job.id, threadId, result.turn.id);
      return result.turn.id;
    };

    await startTurn(promptFor(job));
    const timeoutMs = jobTimeoutMs(job, 'DELEGATE_CODEX_TIMEOUT_SECONDS', 3600);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (Date.now() >= deadline) {
        const active = inspectJob(job.id).providerTurnId;
        if (active) await rpc.request('turn/interrupt', { threadId, turnId: active });
        throw new Error(`TIMEOUT: Codex managed job exceeded ${Math.round(timeoutMs / 1000)}s and was interrupted; raise timeoutSeconds for longer work`);
      }
      const completed = await Promise.race([
        turnDone.then((turn) => ({ turn })),
        rpc.exit.then((outcome) => ({ providerExit: outcome })),
        delay(150).then(() => null)
      ]);
      if (completed?.providerExit) {
        const outcome = completed.providerExit;
        throw outcome.error || new Error(`Codex app-server exited before turn completion (code ${outcome.code}, signal ${outcome.signal || 'none'})`);
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
            if (current.providerTurnId) await rpc.request('turn/interrupt', { threadId, turnId: current.providerTurnId });
            cancelled = true;
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
        if (cancelled) { terminal(job, 'cancelled', 'cancelled'); break; }
        if (queuedPrompts.length) {
          const next = queuedPrompts.shift();
          settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: next.appliedAs });
          appendJobEvent(job.id, next.appliedAs === 'restart' ? 'correction.restarted' : 'correction.applied', { commandId: next.commandId, appliedAs: next.appliedAs });
          await startTurn(next.text);
          continue;
        }
        const status = completed.turn.status === 'failed' ? 'failed' : 'completed';
        terminal(job, status, status, completed.turn.error ? { error: completed.turn.error } : {});
        break;
      }
    }
  } finally {
    await rpc.stop();
  }
}

function cursorCommand(binary, args) {
  if (process.platform !== 'darwin' || process.env.DELEGATE_CURSOR_LOGIN_SHELL === '0') return { command: binary, args };
  const shell = process.env.SHELL || '/bin/zsh';
  return { command: shell, args: ['-lic', 'exec "$@"', 'delegate-cursor-acp', binary, ...args] };
}

function cursorModel(options, requested) {
  if (!requested || requested === 'auto') return options.find((item) => item.value === 'default[]')?.value || null;
  const base = requested === 'composer' ? 'composer-' : requested.startsWith('grok') ? 'grok-' : requested;
  const candidates = options.filter((item) => item.value === requested || item.value.startsWith(base));
  candidates.sort((a, b) => {
    const fastA = /fast=true/.test(a.value) ? 1 : 0;
    const fastB = /fast=true/.test(b.value) ? 1 : 0;
    if (fastA !== fastB) return fastA - fastB;
    return b.value.localeCompare(a.value, undefined, { numeric: true });
  });
  return candidates[0]?.value || requested;
}

function mapAcpUpdate(jobId, update, sessionId, messageParts) {
  const kind = update.sessionUpdate;
  const options = { sessionId };
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text || '';
    messageParts.push(text);
    appendJobEvent(jobId, 'message.delta', { id: update.messageId, delta: text }, options);
  } else if (kind === 'plan' || kind === 'plan_update') appendJobEvent(jobId, 'plan.updated', update, options);
  else if (kind === 'tool_call') {
    appendJobEvent(jobId, 'tool.started', update, options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
  } else if (kind === 'tool_call_update') {
    const type = ['completed', 'failed'].includes(update.status) ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, update, options);
    for (const location of update.locations || []) if (location.path) appendJobEvent(jobId, 'file.changed', { path: location.path }, options);
  } else if (kind === 'usage_update') {
    appendJobEvent(jobId, 'usage.updated', update, options);
    updateManagedJob(jobId, (job) => { job.usage = update; }, { incrementRevision: false });
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
  const errors = [];
  const limit = Math.min(files.length, 1000);
  if (files.length > limit) errors.push(`file inventory capped at ${limit} of ${files.length}`);
  for (const item of files.slice(0, limit)) {
    if (item.contentExcluded) continue;
    let result;
    if (item.status === '??') {
      if (item.preexisting) continue;
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
    if (result?.stdout) diff += result.stdout;
  }
  return { diff, files, error: errors.filter(Boolean).join('; ') || null };
}

function recordGitState(job, sessionId) {
  const state = gitWorkspaceState(job);
  for (const file of state.files) appendJobEvent(job.id, 'file.changed', file, { sessionId });
  if (state.diff) appendJobEvent(job.id, 'diff.updated', { diff: state.diff, includesPreexistingChanges: job.isolation !== 'worktree' }, { sessionId });
  if (state.error) appendJobEvent(job.id, 'provider.event', { providerEvent: 'git-inventory-warning', error: state.error }, { sessionId });
}

async function runCursorAcp(job) {
  const binary = resolveCursorBinary();
  if (!binary) throw new Error('neither agent nor cursor-agent is executable');
  const rootArgs = readOnly(job) ? ['--sandbox', 'enabled', 'acp'] : ['--auto-review', '--sandbox', 'enabled', 'acp'];
  const launch = cursorCommand(binary, rootArgs);
  let sessionId = job.providerSessionId;
  let cancelRequested = false;
  const pendingCorrections = [];
  let cancelSignalSent = false;
  let promptPromise = null;
  const messageParts = [];
  const rpc = new JsonRpcProcess(launch.command, launch.args, {
    cwd: job.cwd,
    onStderr: (text) => appendJobEvent(job.id, 'provider.event', { providerEvent: 'stderr', text }),
    onNotification: async (method, params) => {
      if (method === 'session/update') mapAcpUpdate(job.id, params.update || {}, params.sessionId, messageParts);
    },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`Unsupported ACP request: ${method}`);
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
      clientInfo: { name: 'delegate-router', version: '0.4.2' }
    });
    const session = sessionId
      ? await rpc.request('session/load', { sessionId, cwd: job.cwd, mcpServers: [] })
      : await rpc.request('session/new', { cwd: job.cwd, mcpServers: [] });
    sessionId ||= session.sessionId;
    recordSession(job.id, sessionId, null);
    const config = session.configOptions || [];
    const modelOption = config.find((item) => item.id === 'model');
    const modeOption = config.find((item) => item.id === 'mode');
    if (modelOption) await rpc.request('session/set_config_option', {
      sessionId, configId: 'model', value: cursorModel(modelOption.options || [], job.model)
    });
    if (modeOption) await rpc.request('session/set_config_option', {
      sessionId, configId: 'mode', value: readOnly(job) ? (job.mode === 'consult' ? 'ask' : 'plan') : 'agent'
    });

    const startPrompt = (text) => {
      messageParts.length = 0;
      cancelSignalSent = false;
      appendJobEvent(job.id, 'turn.started', { transport: 'acp' }, { sessionId });
      promptPromise = rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600));
    };
    startPrompt(promptFor(job));

    while (true) {
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
      if (completed.response.usage) appendJobEvent(job.id, 'usage.updated', completed.response.usage, { sessionId });
      if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); break; }
      if (pendingCorrections.length) {
        const next = pendingCorrections.shift();
        settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
        appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId });
        startPrompt(next.text);
        continue;
      }
      recordGitState(job, sessionId);
      terminal(job, 'completed', 'completed', { result: { stopReason: completed.response.stopReason }, session: sessionId });
      break;
    }
  } finally {
    await rpc.stop();
  }
}

function mapHeadlessEvent(jobId, event) {
  const sessionId = findValue(event, ['session_id', 'sessionId', 'chat_id', 'chatId']);
  if (sessionId) {
    updateManagedJob(jobId, (job) => { job.providerSessionId = sessionId; job.session = sessionId; }, { incrementRevision: false });
  }
  const options = { sessionId };
  if (event.type === 'assistant') {
    const text = findValue(event, ['text', 'content', 'message']) || '';
    appendJobEvent(jobId, 'message.delta', { delta: typeof text === 'string' ? text : JSON.stringify(text) }, options);
  } else if (event.type === 'tool_call') {
    const type = event.subtype === 'started' ? 'tool.started' : event.subtype === 'completed' ? 'tool.completed' : 'tool.output';
    appendJobEvent(jobId, type, { toolCall: event.tool_call, subtype: event.subtype }, options);
  } else if (event.type === 'result') {
    if (event.usage) appendJobEvent(jobId, 'usage.updated', event.usage, options);
    if (event.result) appendJobEvent(jobId, 'message.completed', { text: event.result }, options);
  } else appendJobEvent(jobId, 'provider.event', { providerEvent: `cursor:${event.type || 'unknown'}`, subtype: event.subtype }, options);
}

async function runCursorHeadless(job) {
  const binary = resolveCursorBinary();
  if (!binary) throw new Error('neither agent nor cursor-agent is executable');
  const ids = process.platform === 'darwin' && process.env.DELEGATE_CURSOR_LOGIN_SHELL !== '0'
    ? []
    : availableModelIds(binary);
  const model = resolveCursorModel(job.model, ids);
  let resume = job.providerSessionId;
  let text = promptFor(job);
  let cancelRequested = false;
  const pendingCorrections = [];

  while (true) {
    let activeChild = null;
    appendJobEvent(job.id, 'turn.started', { transport: 'headless', resume }, { sessionId: resume });
    const headless = cursorCommand(binary, buildCursorArgs({ mode: job.mode, model, cwd: job.cwd, approval: job.approval, resume }));
    const running = runCursor({
      binary: headless.command,
      args: headless.args,
      cwd: job.cwd,
      prompt: text,
      timeoutMs: jobTimeoutMs(job, 'DELEGATE_CURSOR_TIMEOUT_SECONDS', 3600),
      onChild: (child) => { activeChild = child; },
      onEvent: (event) => mapHeadlessEvent(job.id, event)
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
    appendJobEvent(job.id, 'turn.completed', { status: outcome.status, error: outcome.error }, { sessionId: resume });
    if (cancelRequested) { terminal(job, 'cancelled', 'cancelled'); return; }
    if (pendingCorrections.length) {
      const next = pendingCorrections.shift();
      settleQueuedControl(job.id, next.commandId, { ok: true, appliedAs: 'restart' });
      appendJobEvent(job.id, 'correction.restarted', { commandId: next.commandId, appliedAs: 'restart' }, { sessionId: resume });
      text = next.text;
      continue;
    }
    if (outcome.status !== 0) throw new Error(outcome.error || 'Cursor headless execution failed');
    const sessionId = findValue(outcome.payload, ['session_id', 'sessionId', 'chat_id', 'chatId']);
    if (sessionId) recordSession(job.id, sessionId, null);
    recordGitState(job, sessionId);
    terminal(job, 'completed', 'completed', { result: redact(outcome.payload), session: sessionId });
    return;
  }
}

export async function runManagedProvider(job) {
  updateManagedJob(job.id, (current) => { current.status = 'running'; current.phase = 'starting'; current.workerPid = process.pid; });
  appendJobEvent(job.id, 'job.state', { status: 'running', phase: 'starting', transport: job.transport });
  try {
    const current = loadJob(job.id);
    if (job.provider === 'codex') await runCodex(current);
    else if (job.provider === 'cursor' && job.transport === 'headless') await runCursorHeadless(current);
    else if (job.provider === 'cursor') {
      try { await runCursorAcp(current); }
      catch (error) {
        const started = inspectJob(job.id).providerSessionId;
        if (started) throw error;
        appendJobEvent(job.id, 'provider.event', { providerEvent: 'cursor:acp-fallback', error: error.message });
        updateManagedJob(job.id, (next) => { next.transport = 'headless'; next.capabilities.correction = 'cancel-resume'; });
        await runCursorHeadless(loadJob(job.id));
      }
    }
    else throw new Error(`Unsupported managed provider: ${job.provider}`);
  } catch (error) {
    if (/(?:quota|usage limit|rate limit|allowance)/i.test(error.message || '')) {
      const state = loadState();
      setWindow(state, job.provider, 'quota-error', 100, { source: 'quota-error' });
      saveState(state);
    }
    const current = inspectJob(job.id);
    if (!['completed', 'cancelled', 'failed'].includes(current.status)) terminal(job, 'failed', 'failed', { error: error.message });
    throw error;
  }
}
