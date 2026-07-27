import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createManagedJob,
  inspectJob,
  readJobEvents,
  submitControl,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { JsonRpcProcess } from '../bin/lib/jsonrpc.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(testDir);
const server = path.join(pluginRoot, 'bin', 'delegate-backchannel-mcp');
const jobsCli = path.join(pluginRoot, 'bin', 'delegate-jobs');
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-parity.mjs');

async function isolated(t, provider, fn, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-backchannel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = new Map();
  const values = {
    DELEGATE_STATE_FILE: path.join(root, 'state', 'usage.json'),
    DELEGATE_ENABLED_PROVIDERS: provider,
    DELEGATE_CODEX_BIN: fakeCodex,
    DELEGATE_CURSOR_BIN: fakeCursor,
    DELEGATE_CURSOR_LOGIN_SHELL: '0',
    DELEGATE_MIN_CURSOR_VERSION: '2026.7.0',
    DELEGATE_ACP_GRACE_MS: '0',
    ...extra
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = String(value);
  }
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    return await fn(cwd, root);
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitFor(predicate, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

test('back-channel server exposes exactly the question-only tools and imports no control-plane mutators', async (t) => {
  const source = fs.readFileSync(server, 'utf8');
  for (const symbol of [
    'submitControl', 'launchManagedJob', 'resumeManagedJob', 'reviewRoundManagedJob',
    'updateManagedJob', 'appendJobEvent', 'claimCommands', 'completeCommand', 'saveJob'
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`));
  }

  const rpc = new JsonRpcProcess(process.execPath, [server, '--job-id', 'shape-only']);
  t.after(() => rpc.stop());
  await rpc.request('initialize', { protocolVersion: '2025-11-25' });
  const listed = await rpc.request('tools/list', {});
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['ask_coordinator', 'report_progress']);
  for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(listed.tools[0].inputSchema.required, ['question', 'urgency']);
  assert.deepEqual(listed.tools[1].inputSchema.required, ['milestone']);

  const authority = await rpc.request('tools/call', {
    name: 'ask_coordinator',
    arguments: { question: 'May I continue?', urgency: 'blocking', network: true }
  });
  assert.equal(authority.isError, true);
  assert.match(authority.content[0].text, /does not accept: network/);
  const control = await rpc.request('tools/call', {
    name: 'delegate_cancel',
    arguments: {}
  });
  assert.equal(control.isError, true);
  assert.match(control.content[0].text, /Unknown back-channel tool/);
});

test('fake Codex worker question round-trips through delegate-jobs respond with redaction and context', async (t) => {
  await isolated(t, 'codex', async (cwd) => {
    const job = createManagedJob({
      provider: 'codex',
      mode: 'review',
      model: 'gpt-5.4',
      cwd,
      prompt: 'Review the fixture',
      timeoutSeconds: 60
    });
    const running = runManagedProvider(job);
    const waiting = await waitFor(() => {
      const current = inspectJob(job.id);
      return current.pendingInput ? current : null;
    });
    assert.equal(waiting.phase, 'user-input-required');
    assert.equal(waiting.stalled, false);
    assert.equal(waiting.pendingInput.kind, 'question');
    assert.equal(waiting.pendingInput.defaultAction, 'reject');
    assert.deepEqual(waiting.pendingInput.options, ['src', 'test']);
    assert.match(waiting.pendingInput.context.diffSoFar, /work completed before the question/);
    assert.ok(!JSON.stringify(waiting.pendingInput).includes('question-secret-value'));

    const answered = spawnSync(process.execPath, [
      jobsCli,
      'respond',
      job.id,
      '--expected-revision', String(waiting.revision),
      '--request-id', waiting.pendingInput.requestId,
      '--command-id', 'fake-provider-answer',
      '--response-json', JSON.stringify({
        answer: 'Use src. API_KEY=answer-secret-value',
        steer: 'Run the parser test within the original scope'
      })
    ], { env: process.env, encoding: 'utf8' });
    assert.equal(answered.status, 0, answered.stderr);
    assert.equal(JSON.parse(answered.stdout).accepted, true);

    await running;
    const completed = inspectJob(job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.pendingInput, null);
    assert.ok(completed.questionWaitMs >= 0);
    const events = readJobEvents(job.id);
    const requested = events.find((event) => event.type === 'input.requested');
    const queued = events.find((event) => event.type === 'input.response.requested');
    const resolved = events.find((event) => event.type === 'input.resolved' && event.data.outcome === 'answered');
    assert.match(requested.data.question, /Which implementation target/);
    assert.match(queued.data.response.answer, /\[REDACTED\]/);
    assert.match(resolved.data.answer, /\[REDACTED\]/);
    assert.equal(resolved.data.steer, 'Run the parser test within the original scope');
    assert.ok(!JSON.stringify(events).includes('question-secret-value'));
    assert.ok(!JSON.stringify(events).includes('answer-secret-value'));
    assert.ok(events.some((event) => event.type === 'message.completed'
      && /guidance-only|guidance \(data only/i.test(event.data.text)));
  }, { FAKE_CODEX_BACKCHANNEL: '1' });
});

test('back-channel rejects structured authority and times out with a durable default-reject stopReason', async (t) => {
  await isolated(t, 'codex', async (cwd) => {
    const job = createManagedJob({
      provider: 'codex',
      mode: 'review',
      model: 'gpt-5.4',
      cwd,
      prompt: 'Review'
    });
    updateManagedJob(job.id, (current) => {
      current.attemptLease = { attemptId: 'attempt-question', heartbeatAt: Date.now(), expiresAt: Date.now() + 60_000 };
    });
    const rpc = new JsonRpcProcess(process.execPath, [server, '--job-id', job.id]);
    t.after(() => rpc.stop());
    await rpc.request('initialize', { protocolVersion: '2025-11-25' });
    const asking = rpc.request('tools/call', {
      name: 'ask_coordinator',
      arguments: { question: 'Can I proceed?', options: ['stop'], urgency: 'blocking' }
    }, 2_000);
    const waiting = await waitFor(() => inspectJob(job.id).pendingInput && inspectJob(job.id));
    submitControl(job.id, {
      type: 'respond',
      requestId: waiting.pendingInput.requestId,
      commandId: 'authority-answer',
      response: { answer: 'yes', network: true }
    }, waiting.revision);
    const result = await asking;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /default action rejected continuation/);
    const timedOut = inspectJob(job.id);
    assert.equal(timedOut.stopReason, 'input-timeout');
    assert.equal(timedOut.pendingInput.timedOut, true);
    assert.equal(timedOut.stalled, false);
    assert.equal(timedOut.attemptLease.blockedAt, null);
    assert.equal(timedOut.attemptLease.blockedQuestionId, null);
    assert.ok(timedOut.attemptLease.blockedMs >= 100);
    const events = readJobEvents(job.id);
    assert.ok(events.some((event) => event.type === 'command.rejected' && /network/.test(event.data.error)));
    assert.ok(events.some((event) => event.type === 'input.resolved'
      && event.data.outcome === 'timeout'
      && event.data.defaultAction === 'reject'));
  }, { DELEGATE_BACKCHANNEL_INPUT_TIMEOUT_MS: '120' });
});

test('report_progress journals a bounded milestone without opening an input round trip', async (t) => {
  await isolated(t, 'codex', async (cwd) => {
    const job = createManagedJob({
      provider: 'codex',
      mode: 'review',
      model: 'gpt-5.4',
      cwd,
      prompt: 'Review'
    });
    const rpc = new JsonRpcProcess(process.execPath, [server, '--job-id', job.id]);
    t.after(() => rpc.stop());
    await rpc.request('initialize', { protocolVersion: '2025-11-25' });
    const result = await rpc.request('tools/call', {
      name: 'report_progress',
      arguments: { milestone: 'Reviewed parser; API_KEY=progress-secret-value remains to verify' }
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.accepted, true);
    const progress = readJobEvents(job.id).find((event) => event.type === 'progress.reported');
    assert.match(progress.data.milestone, /\[REDACTED\]/);
    assert.ok(!JSON.stringify(progress).includes('progress-secret-value'));
    assert.equal(inspectJob(job.id).pendingInput, undefined);
  });
});

test('Codex and Cursor ACP retry session creation without the back-channel when injection is rejected', async (t) => {
  await isolated(t, 'codex', async (cwd) => {
    const job = createManagedJob({ provider: 'codex', mode: 'review', model: 'gpt-5.4', cwd, prompt: 'Review' });
    await runManagedProvider(job);
    assert.equal(inspectJob(job.id).status, 'completed');
    assert.ok(readJobEvents(job.id).some((event) => event.type === 'backchannel.unavailable'
      && event.data.fallback === 'thread-without-backchannel'));
  }, { FAKE_CODEX_REJECT_BACKCHANNEL: '1' });
  await isolated(t, 'cursor', async (cwd) => {
    const job = createManagedJob({
      provider: 'cursor',
      mode: 'review',
      model: 'composer-2.5[fast=true]',
      cwd,
      prompt: 'Review'
    });
    await runManagedProvider(job);
    assert.equal(inspectJob(job.id).status, 'completed');
    assert.ok(readJobEvents(job.id).some((event) => event.type === 'backchannel.unavailable'
      && event.data.fallback === 'session-without-backchannel'));
  }, { FAKE_CURSOR_SCENARIO: 'reject-mcp' });
});
