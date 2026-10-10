import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createManagedJob, eventPath, inspectJob, readJobEvents, resumeManagedJob, submitControl, submitTransientControl, updateManagedJob } from '../bin/lib/control.mjs';
import {
  mapCodexItem,
  mapCodexMcpEvent,
  mapCursorAcpNotification,
  recordGitState,
  recordSession,
  runManagedProvider
} from '../bin/lib/providers.mjs';
import { CODEX_FIRST_CLASS_ITEM_TYPES } from '../bin/lib/codex-item-types.mjs';
import { effectiveUsage, loadState } from '../bin/lib/state.mjs';
import { formatTranscriptBlock, TranscriptProjector } from '../bin/lib/tui/transcript.mjs';
import { waitForCondition } from './helpers/wait.mjs';
import { ChildTranscriptConsumer } from '../bin/lib/child-transcript-broker.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-acp.mjs');
const fakeCursorFallback = path.join(testDir, 'fake-cursor-fallback.mjs');
const subagentFixture = JSON.parse(fs.readFileSync(path.join(testDir, 'fixtures', 'subagent-lifecycle.json'), 'utf8'));

async function isolated(fn) {
  const old = { state: process.env.DELEGATE_STATE_FILE, codex: process.env.DELEGATE_CODEX_BIN, cursor: process.env.DELEGATE_CURSOR_BIN, login: process.env.DELEGATE_CURSOR_LOGIN_SHELL, write: process.env.FAKE_CURSOR_WRITE, overlap: process.env.FAKE_CURSOR_OVERLAP, crash: process.env.FAKE_CODEX_CRASH, crashOnce: process.env.FAKE_CODEX_CRASH_ONCE, collab: process.env.FAKE_CODEX_COLLAB, compaction: process.env.FAKE_CODEX_COMPACTION, fileChanges: process.env.FAKE_CODEX_FILE_CHANGES, writePath: process.env.FAKE_CODEX_WRITE_PATH, writeContent: process.env.FAKE_CODEX_WRITE_CONTENT, growingUsage: process.env.FAKE_CODEX_GROWING_USAGE, childReject: process.env.FAKE_CODEX_REJECT_CHILD_SUBSCRIBE, requestLog: process.env.FAKE_CODEX_REQUEST_LOG, retryBase: process.env.DELEGATE_RETRY_BASE_MS, minCodex: process.env.DELEGATE_MIN_CODEX_VERSION, minCursor: process.env.DELEGATE_MIN_CURSOR_VERSION };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-provider-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { await fn(directory); }
  finally {
    for (const [key, value] of Object.entries({ DELEGATE_STATE_FILE: old.state, DELEGATE_CODEX_BIN: old.codex, DELEGATE_CURSOR_BIN: old.cursor, DELEGATE_CURSOR_LOGIN_SHELL: old.login, FAKE_CURSOR_WRITE: old.write, FAKE_CURSOR_OVERLAP: old.overlap, FAKE_CODEX_CRASH: old.crash, FAKE_CODEX_CRASH_ONCE: old.crashOnce, FAKE_CODEX_COLLAB: old.collab, FAKE_CODEX_COMPACTION: old.compaction, FAKE_CODEX_FILE_CHANGES: old.fileChanges, FAKE_CODEX_WRITE_PATH: old.writePath, FAKE_CODEX_WRITE_CONTENT: old.writeContent, FAKE_CODEX_GROWING_USAGE: old.growingUsage, FAKE_CODEX_REJECT_CHILD_SUBSCRIBE: old.childReject, FAKE_CODEX_REQUEST_LOG: old.requestLog, DELEGATE_RETRY_BASE_MS: old.retryBase, DELEGATE_MIN_CODEX_VERSION: old.minCodex, DELEGATE_MIN_CURSOR_VERSION: old.minCursor })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function waitFor(jobId, predicate, description) {
  return waitForCondition({
    description,
    timeoutMs: 3_000,
    intervalMs: 10,
    observe: () => inspectJob(jobId),
    predicate
  });
}

test('Codex app-server maps events and applies true same-turn steering', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerTurnId), 'providerTurnId to be recorded');
  submitControl(job.id, { type: 'steer', correctionId: 'codex-correction', strategy: 'same-turn', text: 'add a test' }, active.revision);
  await running;
  assert.equal(inspectJob(job.id).status, 'completed');
  const types = readJobEvents(job.id, { limit: 1000 }).map((event) => event.type);
  for (const type of ['turn.started', 'plan.updated', 'file.changed', 'message.delta', 'message.completed', 'diff.updated', 'usage.updated', 'correction.applied', 'job.completed']) assert.ok(types.includes(type), type);
  const activity = readJobEvents(job.id, { limit: 1000 }).find((event) => event.type === 'activity');
  assert.equal(activity?.data.kind, 'thinking');
  assert.deepEqual(Object.keys(activity?.data || {}).sort(), ['at', 'kind']);
  const codexUsage = effectiveUsage(loadState(), 'codex');
  assert.equal(codexUsage.usedPercent, 41);
  assert.deepEqual(codexUsage.windows.map((window) => window.name).sort(), ['primary', 'secondary']);
  const record = inspectJob(job.id);
  assert.equal(record.changedFiles.count, 1);
  assert.deepEqual(record.changedFiles.files, ['a.js']);
  assert.equal(record.resolvedModel, 'fake');
  assert.equal(typeof record.result, 'string', 'subagent support does not reshape ordinary Codex results');
}));

test('Codex sends current aliases and unchanged explicit pins at thread and turn launch', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const requestLog = path.join(directory, 'model-requests.jsonl');
  process.env.FAKE_CODEX_REQUEST_LOG = requestLog;
  const models = [
    ['sol', 'gpt-6.1-sol'], ['astra', 'gpt-6-astra'], ['luna', 'gpt-6-luna'],
    ['terra', 'gpt-5.6-terra'], ['gpt-6-sol', 'gpt-6-sol'], ['gpt-5.6-sol', 'gpt-5.6-sol']
  ];
  for (const [requested, expected] of models) {
    fs.writeFileSync(requestLog, '', { mode: 0o600 });
    const job = createManagedJob({ provider: 'codex', model: requested, mode: 'review', cwd: directory, prompt: 'review model selection' });
    await runManagedProvider(job);
    assert.equal(inspectJob(job.id).status, 'completed');
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(requests.find((request) => request.method === 'thread/start').params.model, expected);
    assert.equal(requests.find((request) => request.method === 'turn/start').params.model, expected);
  }
}));

test('Codex rejects unavailable models and unsupported effort before starting a provider thread', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const requestLog = path.join(directory, 'preflight-requests.jsonl');
  process.env.FAKE_CODEX_REQUEST_LOG = requestLog;
  for (const [model, effort, code] of [['gpt-unavailable', 'high', 'INVALID_MODEL'], ['luna', 'ultra', 'INVALID_REQUEST']]) {
    fs.writeFileSync(requestLog, '');
    const job = createManagedJob({ provider: 'codex', model, effort, mode: 'consult', cwd: directory, prompt: 'inspect' });
    await assert.rejects(() => runManagedProvider(job), { code });
    assert.equal(inspectJob(job.id).status, 'failed');
    assert.equal(inspectJob(job.id).errorCode, code);
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(requests.some(request => request.method === 'model/list'));
    assert.ok(!requests.some(request => ['thread/start', 'turn/start'].includes(request.method)));
  }
}));

test('Codex native reports, unknown-field fallback, and explicit subagent limits preserve sandbox policy', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const requestLog = path.join(directory, 'native-contract-requests.jsonl');
  process.env.FAKE_CODEX_REQUEST_LOG = requestLog;
  const previous = { reply: process.env.FAKE_CODEX_REPLY, rejection: process.env.FAKE_CODEX_REJECT_OUTPUT_SCHEMA };
  try {
    process.env.FAKE_CODEX_REPLY = '{"objectiveMet":true}';
    const reportSchema = { type: 'object', additionalProperties: false, required: ['objectiveMet'], properties: { objectiveMet: { type: 'boolean' } } };
    for (const maxSubagents of [0, 2]) {
      fs.writeFileSync(requestLog, '');
      if (maxSubagents === 2) process.env.FAKE_CODEX_REJECT_OUTPUT_SCHEMA = '1'; else delete process.env.FAKE_CODEX_REJECT_OUTPUT_SCHEMA;
      const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'consult', cwd: directory, prompt: 'inspect', reportSchema, maxSubagents });
      await runManagedProvider(job);
      const finished = inspectJob(job.id);
      assert.equal(finished.status, 'completed');
      assert.deepEqual(finished.result.structured, { objectiveMet: true });
      assert.notEqual(finished.resultSuspect, 'short-final-message');
      assert.equal(finished.modelPreflight.entitlementVerified, false);
      const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse);
      const thread = requests.find(request => request.method === 'thread/start').params;
      if (maxSubagents === 0) assert.equal(thread.config['agents.enabled'], false);
      else {
        assert.equal(thread.config['agents.enabled'], true);
        assert.equal(thread.config['agents.max_concurrent_threads_per_session'], 2);
      }
      assert.equal(thread.approvalPolicy, 'on-request');
      assert.equal(thread.approvalsReviewer, 'auto_review');
      const turns = requests.filter(request => request.method === 'turn/start');
      assert.deepEqual(turns[0].params.outputSchema, reportSchema);
      assert.equal(turns.length, maxSubagents === 2 ? 2 : 1);
      if (turns.length === 2) {
        assert.equal(turns[1].params.outputSchema, undefined);
        assert.ok(readJobEvents(job.id, { limit: 1000 }).some(event => event.data?.providerEvent === 'codex:output-schema-unavailable'));
      }
    }
    for (const maxSubagents of [-1, 17, 1.5]) assert.throws(() => createManagedJob({ provider: 'codex', prompt: 'inspect', cwd: directory, maxSubagents }), { code: 'INVALID_REQUEST' });
    assert.throws(() => createManagedJob({ provider: 'cursor', prompt: 'inspect', cwd: directory, maxSubagents: 0 }), { code: 'INVALID_REQUEST' });
  } finally {
    if (previous.reply == null) delete process.env.FAKE_CODEX_REPLY; else process.env.FAKE_CODEX_REPLY = previous.reply;
    if (previous.rejection == null) delete process.env.FAKE_CODEX_REJECT_OUTPUT_SCHEMA; else process.env.FAKE_CODEX_REJECT_OUTPUT_SCHEMA = previous.rejection;
  }
}));

test('work-level output cap uses acknowledged provider cancellation and blocks later descendants', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_GROWING_USAGE = '1';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'consult', cwd: directory, prompt: 'inspect', maxTotalOutputTokens: 5 });
  await assert.rejects(() => runManagedProvider(job), { code: 'BUDGET_EXCEEDED' });
  const finished = inspectJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.errorCode, 'BUDGET_EXCEEDED');
  assert.throws(() => createManagedJob({ provider: 'codex', prompt: 'continue', cwd: directory, parentJobId: job.id }), { code: 'BUDGET_EXCEEDED' });
  assert.ok(readJobEvents(job.id, { limit: 1000 }).some(event => event.type === 'turn.completed' && event.data.turn.status === 'interrupted'));
}));

test('running Codex child streams incrementally on the parent worker connection without touching its journal', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const requestLog = path.join(directory, 'child-live-requests.jsonl');
  process.env.FAKE_CODEX_REQUEST_LOG = requestLog;
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'inspect child stream' });
  const running = runManagedProvider(job);
  await waitFor(job.id, (current) => Boolean(current.providerTurnId), 'parent Codex turn to become active');

  const consumer = new ChildTranscriptConsumer({ subscriptionId: 'provider-live-child' });
  const descriptor = await consumer.start();
  const messages = [];
  let disconnected = false;
  consumer.on('message', (message) => messages.push(message));
  consumer.on('disconnect', () => { disconnected = true; });
  const journalBefore = fs.readFileSync(eventPath(job.id));
  try {
    submitTransientControl(job.id, {
      type: 'child-transcript.subscribe', commandId: 'provider-live-child-subscribe',
      subscriptionId: descriptor.subscriptionId, threadId: 'thread-child-live',
      endpoint: descriptor.endpoint, token: descriptor.token
    });
    await waitForCondition({
      description: 'live child subscription to establish and close after terminal status',
      timeoutMs: 2_000,
      intervalMs: 10,
      observe: () => ({ messages: [...messages], disconnected }),
      predicate: (value) => value.messages.some((message) => message.type === 'established')
        && value.messages.some((message) => message.type === 'closed')
        && value.disconnected
    });
    const establishedIndex = messages.findIndex((message) => message.type === 'established');
    const publicFrames = messages
      .map((message, index) => ({ index, message }))
      .filter(({ message }) => message.type === 'events' && message.events?.some((event) => /Live child|answer\./.test(JSON.stringify(event))));
    assert.ok(establishedIndex >= 0);
    assert.ok(publicFrames.length >= 3, 'two deltas and completion arrive as separate incremental frames');
    assert.ok(publicFrames.every(({ index }) => index > establishedIndex));
    assert.match(JSON.stringify(messages), /Stored child prefix/);
    assert.match(JSON.stringify(messages), /Live child answer/);
    assert.doesNotMatch(JSON.stringify(messages), /live-child-private-reasoning/);
    assert.doesNotMatch(JSON.stringify(messages), /live-child-unknown-private-content/);
    // Byte-identity was the original requirement here and it was the wrong one:
    // the parent worker is still running, so its journal legitimately grows with
    // the parent's OWN events whenever the host is busy enough for them to land
    // inside this window. That made the assertion pass on a quiet machine and
    // fail under load while the implementation was correct either way. The
    // property that actually matters is that nothing CHILD-derived reaches the
    // parent's record, which does not depend on timing.
    const parentJournal = fs.readFileSync(eventPath(job.id), 'utf8');
    assert.ok(parentJournal.startsWith(journalBefore.toString('utf8')), 'the parent journal is only ever appended to');
    assert.doesNotMatch(parentJournal, /thread-child-live/, 'no child thread id reaches the parent journal');
    assert.doesNotMatch(parentJournal, /Live child answer|Stored child prefix/, 'no child transcript text reaches the parent journal');
    assert.doesNotMatch(parentJournal, /live-child-private-reasoning|live-child-unknown-private-content/, 'no child reasoning reaches the parent journal');
    const childAttributed = parentJournal.split('\n').filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter((event) => event.sessionId === 'thread-child-live');
    assert.deepEqual(childAttributed, [], 'no parent journal event is attributed to the child thread');

    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const parentStart = requests.find((request) => request.method === 'thread/start');
    const childResume = requests.find((request) => request.method === 'thread/resume' && request.params?.threadId === 'thread-child-live');
    const childUnsubscribe = requests.find((request) => request.method === 'thread/unsubscribe' && request.params?.threadId === 'thread-child-live');
    assert.ok(parentStart && childResume && childUnsubscribe);
    assert.equal(new Set([parentStart.pid, childResume.pid, childUnsubscribe.pid]).size, 1, 'start, child resume, and unsubscribe use one app-server process');
  } finally {
    consumer.close();
    await running;
  }
}));

test('Codex context-compaction items retain provider passthroughs and add ordered first-class lifecycles', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_COMPACTION = '1';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  await runManagedProvider(job);
  const compaction = readJobEvents(job.id, { limit: 1000 }).filter((event) => event.type.startsWith('compaction.')
    || (event.type === 'provider.event' && event.data.itemType === 'contextCompaction'));
  assert.deepEqual(compaction.map((event) => [event.type, event.data.providerEvent || null, event.data.itemId]), [
    ['provider.event', 'item/started', 'compaction-1'],
    ['compaction.started', null, 'compaction-1'],
    ['provider.event', 'item/completed', 'compaction-1'],
    ['compaction.completed', null, 'compaction-1']
  ]);
  assert.ok(compaction.every((event, index) => index === 0 || event.seq > compaction[index - 1].seq));
}));

test('every first-class Codex item type stays out of the generic provider-item fallback in every phase', () => isolated(async (directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'first class' });
  for (const itemType of CODEX_FIRST_CLASS_ITEM_TYPES) {
    for (const phase of ['started', 'completed']) {
      mapCodexItem(job.id, phase, {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          type: itemType,
          id: `${itemType}-${phase}`,
          text: 'first-class message',
          changes: [],
          status: phase === 'completed' ? 'completed' : 'inProgress'
        }
      });
    }
  }
  const events = readJobEvents(job.id, { limit: 1000 });
  assert.equal(events.filter((event) => event.type === 'provider.item').length, 0);
  assert.ok(events.some((event) => event.type === 'message.completed'));
  assert.ok(events.some((event) => event.type === 'plan.updated'));
  assert.ok(events.some((event) => event.type === 'compaction.completed'));
}));

test('agentMessage start and completion map to exactly one message block and no provider-item block', () => isolated(async (directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'message lifecycle' });
  const item = { type: 'agentMessage', id: 'message-1', text: 'Complete findings inline.' };
  mapCodexItem(job.id, 'started', { threadId: 'thread', turnId: 'turn', item });
  mapCodexItem(job.id, 'completed', { threadId: 'thread', turnId: 'turn', item });
  const events = readJobEvents(job.id, { limit: 1000 });
  const blocks = new TranscriptProjector().project(events, { jobTerminal: true });
  assert.equal(events.filter((event) => event.type === 'provider.item').length, 0);
  assert.equal(blocks.filter((block) => block.kind === 'message' && block.role === 'assistant').length, 1);
  assert.equal(blocks.filter((block) => block.tool?.category === 'provider-item').length, 0);
  assert.equal(blocks.find((block) => block.kind === 'message' && block.role === 'assistant')?.text, item.text);
}));

test('managed Codex, direct Codex, and Cursor normalize identical first-class subagent lifecycles and rendered blocks', () => isolated(async (directory) => {
  const managed = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'managed' });
  for (const entry of subagentFixture.managedCodex) {
    mapCodexItem(managed.id, entry.phase, { threadId: 'managed-thread', turnId: 'managed-turn', item: entry.item });
  }

  const direct = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'direct' });
  for (const [index, msg] of subagentFixture.directCodex.entries()) {
    mapCodexMcpEvent(direct, { id: `direct-${index}`, _meta: { threadId: 'direct-thread' }, msg }, {});
  }

  const cursor = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'review', cwd: directory, prompt: 'cursor' });
  for (const params of subagentFixture.cursor) mapCursorAcpNotification(cursor, 'cursor/task', params, 'cursor-session');

  const records = [managed, direct, cursor].map((job) => inspectJob(job.id));
  const lifecycles = [managed, direct, cursor].map((job) => readJobEvents(job.id, { limit: 1000 })
    .filter((event) => /^subagent\.(?:started|progress|completed|errored)$/.test(event.type)));
  for (const events of lifecycles) {
    assert.deepEqual(events.map((event) => event.type), ['subagent.started', 'subagent.progress', 'subagent.completed']);
    assert.equal(events.at(-1).data.task, subagentFixture.task);
    assert.equal(events.at(-1).data.type, 'reviewer');
    assert.equal(events.at(-1).data.output, subagentFixture.output);
  }
  for (const record of records) {
    assert.deepEqual(record.result.subagents.map(({ id, type, task, status, output }) => ({ id, type, task, status, output })), [{
      id: 'agent-1',
      type: 'reviewer',
      task: subagentFixture.task,
      status: 'completed',
      output: subagentFixture.output
    }]);
  }

  const rendered = lifecycles.map((events) => {
    const projector = new TranscriptProjector();
    const collapsed = projector.project(events, { now: Date.now() });
    const block = collapsed.find((candidate) => candidate.kind === 'tool' && candidate.tool.category === 'subagent');
    assert.ok(block);
    const expanded = projector.project(events, { now: Date.now(), expandedTools: new Set([block.tool.key]) });
    return formatTranscriptBlock(expanded.find((candidate) => candidate.id === block.id));
  });
  assert.match(rendered[0], /> Codex agent.*Inspect the parser.*[+✓]/);
  assert.match(rendered[1], /> Codex agent.*Inspect the parser.*[+✓]/);
  assert.match(rendered[2], /> Cursor agent.*Inspect the parser.*[+✓]/);
  for (const text of rendered) {
    assert.match(text, /subagent output:/);
    assert.match(text, /Full subagent report/);
    assert.doesNotMatch(text, /\[object Object\]|NaN/);
  }
}));

test('unknown Codex items preserve bounded redacted payloads and render without type-specific code', () => isolated(async (directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'unknowns' });
  mapCodexItem(job.id, 'completed', {
    threadId: 'thread', turnId: 'turn',
    item: {
      ...subagentFixture.unknownItem,
      embedded: 'API_KEY=super-secret-value',
      huge: 'x'.repeat(100_000)
    }
  });
  mapCodexItem(job.id, 'completed', {
    threadId: 'thread', turnId: 'turn',
    item: subagentFixture.webSearchItem
  });
  const items = readJobEvents(job.id, { limit: 1000 }).filter((event) => event.type === 'provider.item');
  assert.deepEqual(items.map((event) => event.data.itemType), ['futureWidget', 'webSearch']);
  const serialized = JSON.stringify(items);
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /\[TRUNCATED \d+ chars\]/);
  assert.ok(serialized.length < 140_000, `bounded provider items serialized to ${serialized.length} chars`);

  const projector = new TranscriptProjector();
  const collapsed = projector.project(items, { now: Date.now() });
  const blocks = collapsed.filter((block) => block.kind === 'tool' && block.tool.category === 'provider-item');
  assert.equal(blocks.length, 2);
  assert.match(formatTranscriptBlock(blocks[0]), /futureWidget.*Future provider payload/);
  assert.match(formatTranscriptBlock(blocks[1]), /webSearch.*delegate router subagent lifecycle/);
  const expanded = projector.project(items, {
    now: Date.now(),
    expandedTools: new Set(blocks.map((block) => block.tool.key))
  }).map(formatTranscriptBlock).join('\n');
  assert.match(expanded, /"answer": 42/);
  assert.match(expanded, /"query": "delegate router subagent lifecycle"/);
  assert.doesNotMatch(expanded, /\[object Object\]|NaN|super-secret-value/);
}));

test('subagent result output is redacted and capped independently of the parent final message', () => isolated(async (directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'bounded result' });
  const output = `API_KEY=super-secret-value\n${'large delegated output '.repeat(6000)}`;
  mapCodexItem(job.id, 'completed', {
    threadId: 'thread', turnId: 'turn',
    item: {
      type: 'collabAgentToolCall',
      id: 'huge-call',
      tool: 'wait',
      receiverThreadIds: ['huge-agent'],
      prompt: 'Produce the large report',
      agentsStates: { 'huge-agent': { completed: output } }
    }
  });
  const preserved = inspectJob(job.id).result.subagents[0].output;
  assert.doesNotMatch(preserved, /super-secret-value/);
  assert.match(preserved, /\[REDACTED\]/);
  assert.match(preserved, /\[TRUNCATED \d+ chars\]/);
  assert.ok(preserved.length < 66_000, `subagent output length ${preserved.length}`);
}));

test('Cursor ACP maps structured updates and reports correction as restart', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerSessionId), 'providerSessionId to be recorded');
  submitControl(job.id, { type: 'steer', correctionId: 'cursor-correction', strategy: 'auto', text: 'use a different API' }, active.revision);
  const afterFirst = inspectJob(job.id);
  submitControl(job.id, { type: 'steer', correctionId: 'cursor-correction-2', strategy: 'auto', text: 'also add a regression test' }, afterFirst.revision);
  await running;
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.match(completed.result.text, /answer/);
  assert.ok(completed.result.stopReason);
  assert.match(completed.result.plan, /1\. Search repo for the old name \[pending\]/);
  assert.match(completed.result.plan, /2\. Rename and update call sites/);
  assert.equal(completed.controls['cursor-correction'].state, 'applied');
  assert.equal(completed.controls['cursor-correction-2'].state, 'applied');
  const events = readJobEvents(job.id, { limit: 1000 });
  const activity = events.find((event) => event.type === 'activity');
  assert.equal(activity?.data.kind, 'thinking');
  assert.deepEqual(Object.keys(activity?.data || {}).sort(), ['at', 'kind']);
  assert.ok(events.some((event) => event.type === 'correction.restarted' && event.data.appliedAs === 'restart'));
  assert.ok(events.some((event) => event.type === 'tool.started'));
  assert.ok(events.some((event) => event.type === 'correction.queued'));
  assert.ok(events.some((event) => event.type === 'message.delta' && event.data.delta === 'answer-3'));
}));

test('Cursor falls back to headless only when ACP fails before a session starts', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursorFallback, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursorFallback;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'review', cwd: directory, prompt: 'task' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.transport, 'headless');
  assert.ok(readJobEvents(job.id, { limit: 1000 }).some((event) => event.data.providerEvent === 'cursor:acp-fallback'));
}));

test('Cursor final inventory includes staged and untracked files', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  spawnSync('git', ['init', '-q'], { cwd: directory });
  fs.writeFileSync(path.join(directory, '.env'), 'DATABASE_PASSWORD=hunter2\n');
  fs.writeFileSync(path.join(directory, 'preexisting.txt'), 'local notes\n');
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  process.env.FAKE_CURSOR_WRITE = '1';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'write files' });
  await runManagedProvider(job);
  const events = readJobEvents(job.id, { limit: 1000 });
  const changed = events.filter((event) => event.type === 'file.changed').map((event) => event.data.path);
  assert.ok(changed.includes('new-file.txt'));
  assert.ok(changed.includes('staged-file.txt'));
  const diffEvent = events.filter((event) => event.type === 'diff.updated').at(-1);
  assert.ok(diffEvent);
  const diff = diffEvent.data.diff || fs.readFileSync(diffEvent.data.artifactPath, 'utf8');
  assert.match(diff, /new-file\.txt/);
  assert.match(diff, /staged-file\.txt/);
  assert.doesNotMatch(diff, /hunter2|preexisting\.txt/);
}));

test('Cursor diff excludes pre-existing dirty files the job never changed and flags overlap', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', ...args], { cwd: directory });
  git('init', '-q');
  fs.writeFileSync(path.join(directory, 'tracked-unchanged.txt'), 'committed\n');
  fs.writeFileSync(path.join(directory, 'tracked-overlap.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // Both files are dirty BEFORE the job starts; the job appends only to
  // tracked-overlap.txt. The unchanged one must vanish from diff, inventory,
  // and changedFiles; the overlapping one must stay, flagged.
  fs.appendFileSync(path.join(directory, 'tracked-unchanged.txt'), 'my local edit\n');
  fs.appendFileSync(path.join(directory, 'tracked-overlap.txt'), 'my local edit\n');
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  delete process.env.FAKE_CURSOR_WRITE;
  process.env.FAKE_CURSOR_OVERLAP = '1';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'append to overlap file' });
  await runManagedProvider(job);
  const events = readJobEvents(job.id, { limit: 1000 });
  const fileEvents = events.filter((event) => event.type === 'file.changed');
  assert.ok(!fileEvents.some((event) => event.data.path === 'tracked-unchanged.txt'));
  const overlap = fileEvents.find((event) => event.data.path === 'tracked-overlap.txt');
  assert.ok(overlap);
  assert.equal(overlap.data.preexisting, true);
  assert.equal(overlap.data.overlapsPreexisting, true);
  const diffEvent = events.filter((event) => event.type === 'diff.updated').at(-1);
  assert.ok(diffEvent);
  assert.equal(diffEvent.data.includesPreexistingChanges, true);
  const diff = diffEvent.data.diff || fs.readFileSync(diffEvent.data.artifactPath, 'utf8');
  assert.match(diff, /agent line/);
  assert.doesNotMatch(diff, /tracked-unchanged\.txt/);
  const record = inspectJob(job.id);
  assert.ok(record.changedFiles.files.includes('tracked-overlap.txt'));
  assert.ok(!record.changedFiles.files.includes('tracked-unchanged.txt'));
}));

test('review-flow threads are flagged and refuse resume fast; terminal jobs write the finished sentinel', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_COLLAB = '1';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.reviewFlowEngaged, true);
  assert.equal(completed.result.subagents.length, 1);
  assert.equal(completed.result.subagents[0].status, 'completed');
  assert.match(completed.result.subagents[0].output, /Detailed evidence from the delegated agent/);
  assert.equal(completed.resultSuspect, 'subagent-output-dominates-final');
  assert.ok(completed.finishedPath);
  assert.equal(fs.readFileSync(completed.finishedPath, 'utf8').trim(), 'completed');
  assert.throws(() => resumeManagedJob(job.id, { prompt: 'continue' }), /RESUME_UNSUPPORTED/);
}));

test('a successful parent with an errored child is suspect and preserves an existing reason', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const recordErroredChild = (jobId, id) => mapCodexItem(jobId, 'completed', {
    threadId: 'thread-fake', turnId: 'turn-before-parent-completion',
    item: {
      type: 'collabAgentToolCall', id: `collab-${id}`, tool: 'wait', status: 'completed',
      receiverThreadIds: [id],
      receiverAgents: [{ threadId: id, agentNickname: id, agentRole: 'reviewer' }],
      prompt: 'Review the implementation',
      agentsStates: { [id]: { failed: 'child review failed' } }
    }
  });

  const swallowed = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  recordErroredChild(swallowed.id, 'failed-reviewer');
  await runManagedProvider(swallowed);
  const completed = inspectJob(swallowed.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.subagents[0].status, 'errored');
  assert.ok(readJobEvents(swallowed.id, { types: ['subagent.errored'], limit: 1 }).length);
  assert.equal(completed.resultSuspect, 'subagent-error-swallowed');

  const prior = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review again' });
  updateManagedJob(prior.id, (job) => { job.resultSuspect = 'pre-existing-review-signal'; }, { incrementRevision: false });
  recordErroredChild(prior.id, 'failed-reviewer-with-prior');
  await runManagedProvider(prior);
  assert.equal(inspectJob(prior.id).resultSuspect, 'pre-existing-review-signal');
}));

test('out-of-scope writes are recorded as scopeViolations with a scope.violation event', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  spawnSync('git', ['init', '-q'], { cwd: directory });
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  process.env.FAKE_CURSOR_WRITE = '1';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'write files', allowedPaths: ['new-file.txt'] });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  const violationPaths = completed.scopeViolations.map((item) => item.path);
  assert.ok(violationPaths.includes('staged-file.txt'));
  assert.ok(!violationPaths.includes('new-file.txt'));
  const events = readJobEvents(job.id, { limit: 1000 });
  const violation = events.find((event) => event.type === 'scope.violation');
  assert.ok(violation);
  assert.ok(violation.data.files.some((item) => item.path === 'staged-file.txt'));
}));

test('a completed write-mode job with zero changes is flagged no-changes-write-mode', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_FILE_CHANGES = '0';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.changedFiles.count, 0);
  assert.equal(completed.resultSuspect, 'no-changes-write-mode');
}));

test('non-Git shell writes are detected without provider fileChange events and remain explicit lower bounds', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_FILE_CHANGES = '0';
  process.env.FAKE_CODEX_WRITE_PATH = 'pnpm-lock.yaml';
  process.env.FAKE_CODEX_WRITE_CONTENT = 'worker changed the lockfile without a fileChange event\n';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'update lockfile wiring' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(fs.existsSync(path.join(directory, 'pnpm-lock.yaml')), true);
  assert.equal(completed.containment, 'detection-only');
  assert.equal(completed.changedFiles.count, 1);
  assert.deepEqual(completed.changedFiles.files, ['pnpm-lock.yaml']);
  assert.equal(completed.changeObservation.source, 'filesystem');
  assert.equal(completed.changedFiles.countIsLowerBound, true);
  assert.equal(completed.acceptance.evidence.changes.countIsLowerBound, true);
}));

for (const gitWorkspace of [false, true]) {
  test(`shell writes trigger broker verification in ${gitWorkspace ? 'Git' : 'non-Git'} workspaces`, () => isolated(async (directory) => {
    if (gitWorkspace) spawnSync('git', ['init', '-q'], { cwd: directory });
    process.env.DELEGATE_CODEX_BIN = fakeCodex;
    process.env.FAKE_CODEX_FILE_CHANGES = '0';
    process.env.FAKE_CODEX_WRITE_PATH = 'hello.txt';
    process.env.FAKE_CODEX_WRITE_CONTENT = 'hello\n';
    const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory,
      prompt: 'Create hello.txt', allowedPaths: ['hello.txt'], verify: { command: 'grep -qx hello hello.txt' } });
    await runManagedProvider(job);
    const completed = inspectJob(job.id);
    assert.deepEqual(completed.changedFiles.files, ['hello.txt']);
    assert.equal(completed.verification.state, 'passed');
    assert.equal(completed.acceptance.state, 'ready-for-review');
    assert.notEqual(completed.resultSuspect, 'no-changes-write-mode');
    assert.ok(completed.completedAtMs >= completed.createdAtMs);
  }));
  test(`shell scope breaches are detected in ${gitWorkspace ? 'Git' : 'non-Git'} workspaces`, () => isolated(async (directory) => {
    if (gitWorkspace) spawnSync('git', ['init', '-q'], { cwd: directory });
    process.env.DELEGATE_CODEX_BIN = fakeCodex;
    process.env.FAKE_CODEX_FILE_CHANGES = '0';
    process.env.FAKE_CODEX_WRITE_PATH = 'outside.txt';
    const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory,
      prompt: 'Write bounded files', allowedPaths: ['hello.txt'] });
    await runManagedProvider(job);
    const completed = inspectJob(job.id);
    assert.ok(completed.scopeViolations.some((file) => file.path === 'outside.txt'));
    assert.ok(completed.acceptance.blockedBy.includes('scope-violation'));
  }));
}

test('explicit concise answers are not flagged as incomplete', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'consult', cwd: directory, prompt: 'Reply with a single-word marker.' });
  await runManagedProvider(job);
  assert.notEqual(inspectJob(job.id).resultSuspect, 'short-final-message');
}));

test('applied concise steering is not mistaken for an incomplete report', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'consult', cwd: directory, prompt: 'Inspect the repository.' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerTurnId), 'an active turn');
  submitControl(job.id, { type: 'steer', text: 'Reply with a single-word marker.', correctionId: 'terse-contract' }, active.revision);
  await running;
  assert.notEqual(inspectJob(job.id).resultSuspect, 'short-final-message');
}));

test('missing private non-Git baseline blocks acceptance without fabricating a no-op', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_FILE_CHANGES = '0';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'Implement.' });
  assert.ok(job.observationWarnings.length);
  assert.equal(job.filesystemBaseline, undefined, 'large fingerprints are a private artifact, not an inspect payload');
  assert.equal(fs.statSync(job.filesystemBaselinePath).mode & 0o777, 0o600);
  fs.unlinkSync(job.filesystemBaselinePath);
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.changeObservation.state, 'unavailable');
  assert.equal(completed.resultSuspect, 'change-observation-incomplete');
  assert.ok(completed.acceptance.blockedBy.includes('change-observation-incomplete'));
}));

test('Git reconciliation preserves owner untracked bodies and catches dirty restoration and committed shell edits', () => isolated(async (directory) => {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'base\n');
  git('add', 'tracked.txt'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'owner-dirty\n');
  fs.writeFileSync(path.join(directory, 'owner-untracked.txt'), 'private owner body\n');
  fs.writeFileSync(path.join(directory, '.env'), 'private credential body\n');
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'Edit tracked.txt' });
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'base\n');
  fs.appendFileSync(path.join(directory, 'owner-untracked.txt'), 'candidate\n');
  const state = recordGitState(job, null);
  assert.ok(state.files.some((file) => file.path === 'tracked.txt' && file.overlapsPreexisting));
  assert.doesNotMatch(state.diff, /private owner body|private credential body/);
  assert.equal(state.files.find((file) => file.path === '.env').unchangedSinceBaseline, true);
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'committed candidate\n');
  git('add', 'tracked.txt'); git('commit', '-qm', 'candidate');
  const committed = recordGitState(job, null);
  assert.match(committed.diff, /committed candidate/);
}));

test('a session advertising only fast variants falls back to headless non-fast (live-catalog shape)', () => isolated(async (directory) => {
  const fakeCursorTier = path.join(testDir, 'fake-cursor-tier.mjs');
  fs.chmodSync(fakeCursorTier, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursorTier;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  // Tier fake ACP catalog: grok ONLY as [effort=high,fast=true] — the shape
  // observed on the live account 2026-07-13. Plain grok must not silently run
  // fast: the CLI catalog has a non-fast id, so the job switches to headless.
  const job = createManagedJob({ provider: 'cursor', model: 'grok', mode: 'review', cwd: directory, prompt: 'review' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.transport, 'headless');
  assert.equal(completed.resolvedModel, 'grok-4.5-high');
  const events = readJobEvents(job.id, { limit: 1000 });
  const fallback = events.find((event) => event.data.providerEvent === 'cursor:acp-tier-fallback');
  assert.ok(fallback);
  assert.match(fallback.data.error, /only as a fast variant/);
}));

test('Codex provider exit fails immediately instead of waiting for the turn timeout', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_CRASH = '1';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review' });
  const started = Date.now();
  await assert.rejects(() => runManagedProvider(job), /exited before turn completion/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(inspectJob(job.id).status, 'failed');
}));

test('retryPolicy retries a transient Codex crash once on the same job and thread', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_CRASH_ONCE = '1';
  process.env.DELEGATE_RETRY_BASE_MS = '1';
  const job = createManagedJob({
    provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review',
    retryPolicy: { maxAttempts: 2, retryOn: ['transport'] }
  });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.retries, 1);
  assert.equal(completed.providerSessionId, 'thread-fake');
  const retry = readJobEvents(job.id, { limit: 1000 }).find((event) => event.type === 'job.retry');
  assert.deepEqual({ attempt: retry.data.attempt, code: retry.data.code }, { attempt: 2, code: 'TRANSPORT_ERROR' });
}));

test('terminal jobs tag verification origin and sandbox-only CLI results warn before acceptance', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({
    provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement',
    verify: { command: "printf 'verification-tail\\n'; exit 7", timeoutSeconds: 10 }
  });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcomeProvenance.providerCliVersion, '0.144.1');
  assert.equal(completed.outcomeProvenance.providerCliVersionSource, 'cli-version-check');
  assert.equal(completed.verificationOrigin, 'broker');
  assert.equal(completed.verification.exitCode, 7);
  assert.match(completed.verification.outputTail, /verification-tail/);
  assert.ok(readJobEvents(job.id, { limit: 1000 }).some((event) => event.type === 'verification.finished' && event.data.exitCode === 7));
  const cli = path.join(path.dirname(testDir), 'bin', 'delegate-jobs');
  const waited = spawnSync(process.execPath, [cli, 'wait', job.id], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(waited.status, 6, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).verification.exitCode, 7);

  const brokerResult = spawnSync(process.execPath, [cli, 'result', job.id], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(brokerResult.status, 0, brokerResult.stderr);
  assert.doesNotMatch(brokerResult.stderr, /worker-reported checks are partial evidence/);

  const sandboxed = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review' });
  await runManagedProvider(sandboxed);
  const sandboxedCompleted = inspectJob(sandboxed.id);
  assert.equal(sandboxedCompleted.verificationOrigin, 'worker-sandbox');
  const sandboxedStatus = spawnSync(process.execPath, [cli, 'status', sandboxed.id], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(sandboxedStatus.status, 0, sandboxedStatus.stderr);
  assert.match(sandboxedStatus.stderr, /verification: worker-sandbox .*re-run checks on the real tree/);
  const sandboxedResult = spawnSync(process.execPath, [cli, 'result', sandboxed.id], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(sandboxedResult.status, 0, sandboxedResult.stderr);
  assert.equal(JSON.parse(sandboxedResult.stdout).verificationOrigin, 'worker-sandbox');
  assert.match(sandboxedResult.stderr, /worker-reported checks are partial evidence/);

  const unsandboxed = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review', sandbox: 'off' });
  await runManagedProvider(unsandboxed);
  assert.equal(inspectJob(unsandboxed.id).verificationOrigin, 'unsandboxed-worker');
}));

test('Codex output budget interrupts the turn and preserves partial state and continuation', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_GROWING_USAGE = '1';
  const job = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'implement within budget',
    maxOutputTokens: 4
  });
  await assert.rejects(
    () => runManagedProvider(job),
    (error) => error.code === 'BUDGET_EXCEEDED' && error.retryable === false && error.provider === 'codex'
  );
  const failed = inspectJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stoppedReason, 'budget');
  assert.equal(failed.errorCode, 'BUDGET_EXCEEDED');
  assert.match(failed.error, /BUDGET_EXCEEDED/);
  assert.equal(failed.providerSessionId, 'thread-fake');
  assert.equal(failed.usage.total.outputTokens, 6);
  assert.deepEqual(failed.checkpoint, {
    failureReason: 'BUDGET_EXCEEDED',
    continuationId: 'thread-fake',
    lastDiffEventSeq: readJobEvents(job.id, { limit: 1000 }).filter((event) => event.type === 'diff.updated').at(-1).seq,
    resumeHint: 'resume this thread with delegate_resume and a packet folding in the partial diff'
  });
  const events = readJobEvents(job.id, { limit: 1000 });
  assert.ok(events.some((event) => event.type === 'budget.exceeded' && event.data.observedOutputTokens === 6));
  assert.ok(events.some((event) => event.type === 'diff.updated' && /partial\.js/.test(event.data.diff)));
  assert.ok(events.some((event) => event.type === 'message.delta' && /partial work/.test(event.data.delta)));
  assert.ok(events.some((event) => event.type === 'turn.completed' && event.data.turn.status === 'interrupted'));
}));

test('provider minimum versions fail clearly through an env-forced floor', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.DELEGATE_MIN_CODEX_VERSION = '999.0.0';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review' });
  await assert.rejects(
    () => runManagedProvider(job),
    (error) => error.code === 'PROVIDER_TOO_OLD' && error.retryable === false && error.observedVersion === '0.144.1'
  );
  const failed = inspectJob(job.id);
  assert.equal(failed.errorCode, 'PROVIDER_TOO_OLD');
  assert.match(failed.error, /0\.144\.1.*999\.0\.0/);
}));

test('current ACP catalogs select new Grok tiers while retaining exact older pins', async () => {
  const { cursorModel } = await import('../bin/lib/providers.mjs');
  const acp = [
    { value: 'default[]' }, { value: 'composer-2.5[fast=false]' },
    { value: 'grok-4.5[effort=high,fast=false]' },
    { value: 'cursor-grok-4.7[effort=high,fast=false]' },
    { value: 'cursor-grok-4.7[effort=xhigh,fast=false]' },
    { value: 'cursor-grok-4.7[effort=high,fast=true]' }
  ];
  assert.equal(cursorModel(acp, 'grok'), 'cursor-grok-4.7[effort=high,fast=false]');
  assert.equal(cursorModel(acp, 'grok-xhigh'), 'cursor-grok-4.7[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'grok-4.7-high'), 'cursor-grok-4.7[effort=high,fast=false]');
  assert.equal(cursorModel(acp, 'grok-fast'), 'cursor-grok-4.7[effort=high,fast=true]');
  assert.equal(cursorModel(acp, 'grok-4.5-high'), 'grok-4.5[effort=high,fast=false]');
  assert.throws(() => cursorModel(acp, 'grok-4.7-low'), { code: 'INVALID_MODEL' });
});

test('cursor model resolution matches attribute-serialized catalogs (REG-1)', async () => {
  const { cursorModel } = await import('../bin/lib/providers.mjs');
  // Realistic ACP catalog: attribute-serialized values, as advertised by the
  // live agent. Every id recommended by references/models.md must resolve
  // here; this test is the doc-drift guard.
  const acp = [
    { value: 'default[]' },
    { value: 'composer-2.5[fast=true]' }, { value: 'composer-2.5[fast=false]' },
    { value: 'grok-4.5[effort=xhigh,fast=false]' }, { value: 'grok-4.5[effort=xhigh,fast=true]' },
    { value: 'grok-4.5[effort=high,fast=false]' }, { value: 'grok-4.5[effort=high,fast=true]' },
    { value: 'grok-4.5[effort=medium,fast=false]' },
    { value: 'gpt-5.6-sol[effort=xhigh,context=272k]' }
  ];
  assert.equal(cursorModel(acp, 'grok-4.5-high'), 'grok-4.5[effort=high,fast=false]');
  assert.equal(cursorModel(acp, 'grok-4.5-xhigh'), 'grok-4.5[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'grok'), 'grok-4.5[effort=high,fast=false]');
  assert.equal(cursorModel(acp, 'grok-xhigh'), 'grok-4.5[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'grok-4.5'), 'grok-4.5[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'composer'), 'composer-2.5[fast=false]');
  assert.equal(cursorModel(acp, 'composer-2.5'), 'composer-2.5[fast=false]');
  assert.equal(cursorModel(acp, 'gpt-5.6-sol-xhigh'), 'gpt-5.6-sol[effort=xhigh,context=272k]');
  assert.equal(cursorModel(acp, 'auto'), 'default[]');
  assert.equal(cursorModel(acp, 'grok-4.5[effort=high,fast=true]'), 'grok-4.5[effort=high,fast=true]');
  // Fast is opt-in: explicit fast requests resolve to the fast variant,
  // everything else stays non-fast (asserted above).
  assert.equal(cursorModel(acp, 'composer-2.5-fast'), 'composer-2.5[fast=true]');
  assert.equal(cursorModel(acp, 'grok-4.5-fast-high'), 'grok-4.5[effort=high,fast=true]');
  assert.equal(cursorModel(acp, 'grok-fast'), 'grok-4.5[effort=high,fast=true]');
});

test('fast-only live catalogs are flagged as a compromise, cursor- prefixed ids resolve', async () => {
  const { cursorModel, cursorModelDetailed } = await import('../bin/lib/providers.mjs');
  const { resolveCursorModel } = await import('../bin/lib/cursor.mjs');
  // Exact ACP catalog shape observed live on 2026-07-13: grok and composer
  // advertised ONLY as fast variants. Plain requests resolve but must carry
  // fastCompromise so the adapter can escape to headless or warn loudly.
  const live = [
    { value: 'default[]' },
    { value: 'grok-4.5[effort=high,fast=true]' },
    { value: 'composer-2.5[fast=true]' },
    { value: 'gpt-5.6-sol[context=272k,reasoning=medium,fast=false]' }
  ];
  assert.deepEqual(cursorModelDetailed(live, 'composer'), { value: 'composer-2.5[fast=true]', fastCompromise: true });
  assert.deepEqual(cursorModelDetailed(live, 'grok'), { value: 'grok-4.5[effort=high,fast=true]', fastCompromise: true });
  assert.deepEqual(cursorModelDetailed(live, 'auto'), { value: 'default[]', fastCompromise: false });
  assert.deepEqual(cursorModelDetailed(live, 'grok-fast'), { value: 'grok-4.5[effort=high,fast=true]', fastCompromise: false });
  // CLI catalogs now prefix first-party Grok ids with "cursor-".
  const cli = [{ value: 'cursor-grok-4.5-high' }, { value: 'cursor-grok-4.5-high-fast' }, { value: 'cursor-grok-4.5-medium' }, { value: 'composer-2.5' }, { value: 'composer-2.5-fast' }];
  assert.equal(cursorModel(cli, 'grok'), 'cursor-grok-4.5-high');
  assert.equal(cursorModel(cli, 'grok-4.5-high'), 'cursor-grok-4.5-high');
  assert.equal(cursorModel(cli, 'composer'), 'composer-2.5');
  assert.equal(resolveCursorModel('grok', ['cursor-grok-4.5-high', 'cursor-grok-4.5-high-fast', 'composer-2.5']), 'cursor-grok-4.5-high');
  for (const bogus of ['grok-9point9-fake', 'grok-4.5-turbo', 'claude-fable-5']) {
    try {
      cursorModel(live, bogus);
      assert.fail(`expected INVALID_MODEL for ${bogus}`);
    } catch (error) {
      assert.equal(error.code, 'INVALID_MODEL', bogus);
      assert.equal(error.retryable, false, bogus);
      assert.equal(error.provider, 'cursor', bogus);
    }
  }
});

test('cursor model resolution also matches suffix-style catalogs and empty lists', async () => {
  const { cursorModel } = await import('../bin/lib/providers.mjs');
  const cli = [
    { value: 'grok-4.5-xhigh' }, { value: 'grok-4.5-fast-xhigh' },
    { value: 'grok-4.5-high' }, { value: 'grok-4.5-medium' },
    { value: 'composer-2.5' }, { value: 'default[]' }
  ];
  assert.equal(cursorModel(cli, 'grok-4.5-high'), 'grok-4.5-high');
  assert.equal(cursorModel(cli, 'grok'), 'grok-4.5-high');
  assert.equal(cursorModel(cli, 'grok-xhigh'), 'grok-4.5-xhigh');
  assert.equal(cursorModel(cli, 'grok-4.5'), 'grok-4.5-xhigh');
  assert.equal(cursorModel(cli, 'composer'), 'composer-2.5');
  assert.equal(cursorModel([], 'grok'), 'grok-4.7-high');
});

test('codex resume rejections map to an actionable RESUME_UNSUPPORTED code', async () => {
  const providers = await import('../bin/lib/providers.mjs');
  assert.ok(providers.securityPreamble);
});

test('Cursor ACP resolves a grok tier request against the advertised catalog end-to-end', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'grok', mode: 'consult', cwd: directory, prompt: 'question' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resolvedModel, 'grok-4.5[effort=high,fast=false]');
  assert.equal(completed.model, 'grok-4.5[effort=high,fast=false]');
}));

test('Cursor ACP fails closed on a bogus model id end-to-end', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'grok-9point9-fake', mode: 'consult', cwd: directory, prompt: 'question' });
  await assert.rejects(() => runManagedProvider(job), /INVALID_MODEL/);
  assert.equal(inspectJob(job.id).status, 'failed');
}));

test('ACP tier gaps fall back to headless with the CLI-resolved model, explicitly evented', () => isolated(async (directory) => {
  const fakeCursorTier = path.join(testDir, 'fake-cursor-tier.mjs');
  fs.chmodSync(fakeCursorTier, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursorTier;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'grok-xhigh', mode: 'consult', cwd: directory, prompt: 'hard question' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.transport, 'headless');
  assert.equal(completed.model, 'grok-4.5-xhigh');
  assert.equal(completed.resolvedModel, 'grok-4.5-xhigh');
  assert.equal(completed.providerSessionId, 'headless-tier-session');
  const events = readJobEvents(job.id, { limit: 1000 });
  assert.ok(events.some((event) => event.data.providerEvent === 'cursor:acp-tier-fallback' && event.data.cliModel === 'grok-4.5-xhigh'));
}));

// Reproduces the sequence observed on codex-mseigqwb-f9fde5, where sol spawned
// three subagents: turn/started fires for each CHILD turn on the same
// connection, carrying the child's threadId and turn id. Before the guard, each
// one rebound the parent job, and the recorded thread ended up being the third
// child. Everything keyed on that field then reads a child — resume continues
// the wrong thread, and the Subagents tab asks thread/list for the descendants
// of a descendant, which is why it found none.
test('subagent turns never rebind the parent job thread or its steering turn', () => isolated(async (directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'consult', cwd: directory, prompt: 'investigate' });
  const parentThread = '019fcc4d-7746-7c90-89cb-b3b5eff493f2';
  const parentTurn = '019fcc4d-8a37-7293-8708-377d977f7847';
  recordSession(job.id, parentThread, parentTurn, { rebind: true });
  assert.equal(inspectJob(job.id).providerSessionId, parentThread);

  const children = [
    ['019fcc4d-9ba5-7ad1-8078-0c3ba82202d6', '019fcc4d-9c1b-7d60-bd87-7c3eeb60e928'],
    ['019fcc4d-b61f-79c2-9c8b-701a54bc9d4f', '019fcc4d-b68a-7142-a669-f9fb38cea32d'],
    ['019fcc4d-c352-7432-b04d-5bc25e6f052f', '019fcc4d-c3ac-76e0-a080-69d3bb681131']
  ];
  for (const [childThread, childTurn] of children) {
    assert.equal(recordSession(job.id, childThread, childTurn), false, 'a foreign thread must be refused');
  }

  const after = inspectJob(job.id);
  assert.equal(after.providerSessionId, parentThread, 'the parent thread survives every child turn');
  assert.equal(after.session, parentThread);
  assert.equal(after.providerTurnId, parentTurn, 'steering still aims at the turn the coordinator started');

  // Reporting session.updated for a thread that is not this job's session would
  // assert a change that never happened.
  const announced = readJobEvents(job.id, { limit: 1000 })
    .filter((event) => event.type === 'session.updated')
    .map((event) => event.data?.sessionId);
  assert.deepEqual(announced, [parentThread], 'only the job\'s own session is announced');

  // The parent's own turns must still advance normally.
  const secondTurn = '019fcc4d-dddd-7000-9000-000000000001';
  assert.equal(recordSession(job.id, parentThread, secondTurn), true);
  assert.equal(inspectJob(job.id).providerTurnId, secondTurn);

  // A genuine resume onto a different thread is still allowed when asked for.
  const resumed = '019fcc4d-eeee-7000-9000-000000000002';
  assert.equal(recordSession(job.id, resumed, null, { rebind: true }), true);
  assert.equal(inspectJob(job.id).providerSessionId, resumed);
}));
