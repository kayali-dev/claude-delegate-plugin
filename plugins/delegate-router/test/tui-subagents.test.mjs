import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
const harness = await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CodexSubagentClient,
  projectCodexChildSnapshot,
  supportsCodexSubagentDiscovery
} from '../bin/lib/codex-subagents.mjs';
import { eventPath, createManagedJob, updateManagedJob } from '../bin/lib/control.mjs';
import { normalizeSubagentLifecycle } from '../bin/lib/providers.mjs';
import { DelegateDataSource } from '../bin/lib/tui/datasource.mjs';
import { projectSubagentRows, subagentRowsForDisplay } from '../bin/lib/tui/subagents.mjs';
import { detailViewModel } from '../bin/lib/tui/viewmodels.mjs';

const NOW = 1_786_000_000_000;
const REASONING_SECRET = 'private-chain-of-thought-must-never-enter-the-view';

function packet(objective) {
  return `# Objective\n${objective}\n\n# Allowed scope\nRead only.\n\n# Acceptance criteria\nComplete.\n\n# Return\nResult.`;
}

function childFixture(status = 'active') {
  return {
    id: 'thread-child-running',
    parentThreadId: 'thread-parent',
    agentNickname: 'implementer',
    agentRole: 'worker',
    preview: 'Implement the bounded change',
    status: { type: status },
    createdAt: NOW / 1000 - 30,
    updatedAt: NOW / 1000 - 1,
    turns: [{
      id: 'turn-child',
      status: status === 'active' ? 'inProgress' : 'completed',
      startedAt: NOW / 1000 - 30,
      items: [
        { id: 'reasoning-1', type: 'reasoning', summary: [{ text: REASONING_SECRET }], content: [{ text: REASONING_SECRET }] },
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Use the public contract.' }] },
        { id: 'assistant-1', type: 'agentMessage', text: 'Implemented the public contract.' }
      ]
    }]
  };
}

function storeFor(job, events = [], subagents = {}) {
  return {
    jobs: [job],
    eventsByJob: { [job.id]: events },
    activityEventsByJob: {},
    hydrationByJob: { [job.id]: { loaded: true, loading: false, error: null } },
    diffsByJob: {},
    diffStatsByJob: {},
    subagentsByJob: { [job.id]: subagents },
    providers: [], writerLocks: [], profiles: [], groups: [], audit: [], sessions: [],
    sessionScan: {}, externalScan: {}, stats: { since: '7d', jobs: 1, groups: [] }, updatedAt: NOW
  };
}

function parentJob(provider = 'codex', overrides = {}) {
  return {
    id: `${provider}-parent-job`, provider, model: 'auto', resolvedModel: 'provider-model', mode: 'review',
    status: 'running', phase: 'working', revision: 2, cwd: '/work/project',
    providerSessionId: provider === 'codex' ? 'thread-parent' : 'cursor-session',
    createdAt: NOW / 1000 - 120, updatedAt: NOW / 1000 - 1,
    ...overrides
  };
}

function subagentsFrame(store, ui = {}) {
  const base = detailViewModel(store, { jobId: store.jobs[0].id, now: NOW, follow: false }, { width: 132, height: 34 });
  const detailTab = base.meta.tabs.indexOf('Subagents');
  assert.ok(detailTab >= 0, 'the provider exposes the Subagents tab');
  return detailViewModel(store, {
    jobId: store.jobs[0].id, now: NOW, follow: false, detailTab, viewportWidth: 132, viewportHeight: 34,
    ...ui
  }, { width: 132, height: 34 });
}

function emptyMessage(frame) {
  return [frame.panes[0].content.message, frame.panes[0].content.action].filter(Boolean).join(' ');
}

test('Codex v2 discovery is version/capability gated and thread/read yields a bounded reasoning-free snapshot', async () => {
  const fixture = childFixture();
  assert.match(JSON.stringify(fixture), new RegExp(REASONING_SECRET), 'the fixture genuinely contains child reasoning');
  const requests = [];
  const notifications = [];
  const rpc = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'initialize') return { serverInfo: { name: 'codex', version: '0.144.0' } };
      if (method === 'thread/list') {
        return params.cursor == null
          ? { data: [{ id: 'thread-child-running', parentThreadId: 'thread-parent', status: { type: 'active' } }], nextCursor: 'page-2' }
          : { data: [{ id: 'thread-grandchild', parentThreadId: 'thread-child-running', status: { type: 'idle' } }], nextCursor: null };
      }
      if (method === 'thread/read') return { thread: fixture };
      throw new Error(`unexpected RPC ${method}`);
    },
    notify(method, params) { notifications.push({ method, params }); },
    async stop() {}
  };
  const client = new CodexSubagentClient(parentJob('codex', {
    outcomeProvenance: { providerCliVersion: '0.144.0' }
  }), { rpcFactory: () => rpc });
  try {
    const discovery = await client.discover('thread-parent');
    assert.deepEqual(discovery.threads.map((thread) => thread.id), ['thread-child-running', 'thread-grandchild']);
    assert.ok(requests.filter((entry) => entry.method === 'thread/list').every((entry) => entry.params.ancestorThreadId === 'thread-parent'));
    const snapshot = await client.read('thread-child-running', { now: NOW });
    assert.equal(snapshot.pointInTime, true);
    assert.equal(snapshot.droppedReasoningCount, 1);
    assert.match(JSON.stringify(snapshot.events), /Implemented the public contract/);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(REASONING_SECRET));
    assert.deepEqual(requests.find((entry) => entry.method === 'initialize').params.capabilities.experimentalApi, true);
    assert.deepEqual(requests.find((entry) => entry.method === 'thread/read').params, { threadId: 'thread-child-running', includeTurns: true });
    assert.equal(requests.some((entry) => /resume|subscribe|turns\/list|items\/list/.test(entry.method)), false);
    assert.deepEqual(notifications.map((entry) => entry.method), ['initialized']);
  } finally { await client.close(); }

  assert.equal(supportsCodexSubagentDiscovery('0.142.9'), false);
  assert.equal(supportsCodexSubagentDiscovery('0.143.0'), true);
  let started = false;
  const oldClient = new CodexSubagentClient(parentJob(), {
    version: '0.142.9',
    rpcFactory: () => { started = true; throw new Error('must not start'); }
  });
  await assert.rejects(oldClient.discover('thread-parent'), { code: 'SUBAGENT_DISCOVERY_UNSUPPORTED' });
  assert.equal(started, false, 'the unsupported version is rejected before an app-server process starts');
});

test('current collabToolCall and legacy spellings both produce lifecycle rows', () => {
  const current = normalizeSubagentLifecycle({
    source: 'codex-item',
    payload: {
      id: 'spawn-call', type: 'collabToolCall', tool: 'spawnAgent', status: 'inProgress',
      senderThreadId: 'thread-parent', newThreadId: 'thread-child', prompt: 'Review the change',
      agentStatus: { status: 'running' }
    }
  });
  assert.equal(current.length, 1);
  assert.equal(current[0].id, 'thread-child');
  assert.equal(current[0].task, 'Review the change');
  assert.equal(current[0].lifecycle, 'started');

  const legacy = normalizeSubagentLifecycle({
    source: 'codex-item',
    payload: { id: 'legacy', type: 'collab_agent_tool_call', tool: 'spawn_agent', receiverThreadIds: ['legacy-child'], prompt: 'Legacy review' }
  });
  assert.equal(legacy[0].id, 'legacy-child');
});

test('Subagents renders a flat nested tree, collapses guardians, and preserves selection across transcript back navigation', () => {
  const job = parentJob();
  const events = [
    { type: 'subagent.started', at: NOW - 30_000, data: { id: 'thread-child-running', agentName: 'implementer', type: 'worker', task: 'Implement it', status: 'running' } },
    { type: 'subagent.started', at: NOW - 25_000, data: { id: 'guardian-1', agentName: 'policy guardian', type: 'guardian', task: 'Watch policy', status: 'running' } },
    { type: 'subagent.started', at: NOW - 24_000, data: { id: 'guardian-2', agentName: 'scope guardian', type: 'guardian', task: 'Watch scope', status: 'running' } }
  ];
  const state = {
    status: 'ready', provider: 'codex', threads: [
      { id: 'thread-child-running', parentThreadId: 'thread-parent', agentName: 'implementer', role: 'worker', task: 'Implement it', status: 'active', createdAtMs: NOW - 30_000 },
      { id: 'thread-grandchild', parentThreadId: 'thread-child-running', agentName: 'reviewer', role: 'reviewer', task: 'Review it', status: 'idle', createdAtMs: NOW - 20_000 }
    ]
  };
  const rows = projectSubagentRows(job, events, state);
  assert.equal(rows.find((row) => row.id === 'thread-grandchild').depth, 2);
  assert.deepEqual(subagentRowsForDisplay(rows).map((row) => row.id), ['thread-child-running', 'thread-grandchild', '__guardians__']);
  assert.deepEqual(subagentRowsForDisplay(rows, true).map((row) => row.id), ['thread-child-running', 'thread-grandchild', '__guardians__', 'guardian-1', 'guardian-2']);

  const store = storeFor(job, events, state);
  const list = subagentsFrame(store, { subagentSelection: 1 });
  assert.equal(list.meta.subagentRows[1].id, 'thread-grandchild');
  assert.equal(list.meta.subagentRows[1].depth, 2);
  assert.match(list.panes[0].content.rows[1].agent, /^  reviewer/);
  assert.equal(list.panes[0].content.rows.at(-1).agent, 'Guardians (2)');

  store.subagentsByJob[job.id] = {
    ...state,
    snapshot: {
      threadId: 'thread-grandchild', mode: 'stored', status: 'ready', pointInTime: true, capturedAtMs: NOW,
      events: [{ schemaVersion: 1, seq: 1, at: NOW, type: 'message.completed', redacted: true, data: { id: 'answer', text: 'Child transcript text' } }]
    }
  };
  const opened = subagentsFrame(store, { subagentSelection: 1, subagentTranscriptId: 'thread-grandchild' });
  assert.match(opened.panes[0].title, /Stored snapshot/);
  assert.match(opened.panes[0].summary.text, /point-in-time; may be incomplete and may grow/);
  assert.doesNotMatch(JSON.stringify(opened), /\bLive\b/);
  const returned = subagentsFrame(store, { subagentSelection: 1, subagentTranscriptId: null });
  assert.equal(returned.meta.subagentRows[1].id, 'thread-grandchild', 'Esc leaves the parent row selection intact');

  const controller = fs.readFileSync(new URL('../bin/delegate-tui', import.meta.url), 'utf8');
  assert.match(controller, /key === 'enter'[\s\S]*openSelectedSubagent\(\)/, 'Enter opens the selected child');
  assert.match(controller, /row\.category === 'guardians'[\s\S]*guardiansExpanded = !ui\.guardiansExpanded/, 'Enter expands the guardian category');
  const backBranch = controller.match(/else if \(ui\.screen === 'detail' && ui\.subagentTranscriptId\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(backBranch, /ui\.subagentTranscriptId = null/, 'Esc closes only the child transcript');
  assert.doesNotMatch(backBranch, /subagentSelection\s*=/, 'Esc preserves the parent row selection');
});

test('Cursor lifecycle rows are explicitly transcript-unavailable and Enter has a non-silent unavailable panel', () => {
  const job = parentJob('cursor');
  const event = {
    type: 'subagent.started', at: NOW - 8_000,
    data: { id: 'cursor-task-call', agentName: 'researcher', type: 'Task', task: 'Investigate the API', status: 'running' }
  };
  const store = storeFor(job, [event], { status: 'ready', provider: 'cursor', threads: [] });
  const list = subagentsFrame(store);
  assert.equal(list.meta.subagentRows[0].depth, null);
  assert.equal(list.panes[0].content.rows[0].depth, '—');
  assert.equal(list.panes[0].content.rows[0].transcript, 'Unavailable');

  store.subagentsByJob[job.id].snapshot = {
    threadId: 'cursor-task-call', mode: 'unavailable', status: 'unavailable', events: [],
    message: 'Cursor lifecycle signals do not expose a child transcript locator.'
  };
  const opened = subagentsFrame(store, { subagentTranscriptId: 'cursor-task-call' });
  assert.match(opened.panes[0].title, /Unavailable/);
  assert.match(emptyMessage(opened), /Cursor child transcript unavailable/);
  assert.match(emptyMessage(opened), /do not expose a child transcript locator/);
  assert.match(opened.panes[0].summary.text, /no transcript was fabricated/);
});

test('authoritative zero, unsupported discovery, and unreachable remote detail are three different states', () => {
  const job = parentJob();
  const zero = emptyMessage(subagentsFrame(storeFor(job, [], { status: 'ready', provider: 'codex', threads: [] })));
  const unsupported = emptyMessage(subagentsFrame(storeFor(job, [], { status: 'unavailable', provider: 'codex', threads: [], unsupported: true })));
  const remote = emptyMessage(subagentsFrame(storeFor({ ...job, remote: true }, [], { status: 'remote-unavailable', provider: 'codex', threads: [] })));
  assert.match(zero, /No worker subagents or guardians were recorded for this job/);
  assert.match(unsupported, /Subagent discovery is unavailable for this Codex version or thread store/);
  assert.doesNotMatch(unsupported, /No worker subagents/);
  assert.match(remote, /unavailable from this remote TUI connection/);
  assert.doesNotMatch(remote, /No worker subagents/);
  assert.equal(new Set([zero, unsupported, remote]).size, 3);

  const cursor = emptyMessage(subagentsFrame(storeFor(parentJob('cursor'), [], { status: 'ready', provider: 'cursor', threads: [] })));
  assert.match(cursor, /Cursor can run subagents, but this transport exposed no child records/);
  assert.match(cursor, /Child transcripts are unavailable/);

  const external = detailViewModel(storeFor(parentJob('codex', { external: true }), [], {}), {
    jobId: 'codex-parent-job', now: NOW
  }, { width: 100, height: 30 });
  assert.equal(external.meta.tabs.includes('Subagents'), false, 'unmanaged external threads do not advertise a parent-job surface');
});

test('datasource keeps child snapshots memory-only, polls only the selected running child, and uses exact selected-thread disk fallback', async () => {
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: harness.root, prompt: packet('Inspect child activity') });
  updateManagedJob(job.id, (record) => {
    record.providerSessionId = 'thread-parent';
    record.providerCliVersion = '0.144.0';
    record.status = 'running';
    record.phase = 'working';
    record.subagentLifecycle = {
      'thread-child-running': { id: 'thread-child-running', status: 'running', task: 'Still working' }
    };
  });
  const reads = [];
  const fixture = childFixture('idle');
  const projected = projectCodexChildSnapshot(fixture, { now: NOW });
  assert.equal(projected.pointInTime, false, 'the stored thread status alone looks settled in this fixture');
  const client = {
    version: '0.144.0',
    async discover() {
      return { threads: [projected.thread], capped: false, version: this.version };
    },
    async read(threadId) {
      reads.push(threadId);
      return { ...projected, capturedAtMs: Date.now() };
    },
    async close() {}
  };
  const source = new DelegateDataSource({ watch: false, pollMs: 100, codexSubagentClientFactory: () => client });
  try {
    source.refreshRecords({ force: true });
    const journalBefore = fs.readFileSync(eventPath(job.id));
    const jobCount = source.getState().jobs.length;
    await source.selectSubagent(job.id);
    await source.selectSubagent(job.id, 'thread-child-running');
    let state = source.getState().subagentsByJob[job.id];
    assert.equal(state.snapshot.pointInTime, true, 'the parent lifecycle keeps a running child snapshot explicitly point-in-time');
    assert.doesNotMatch(JSON.stringify(state.snapshot), new RegExp(REASONING_SECRET));
    source.lastSubagentReadAt = 0;
    await source.refreshSelectedSubagentSnapshot();
    assert.deepEqual(reads, ['thread-child-running', 'thread-child-running']);
    assert.equal(source.getState().jobs.length, jobCount, 'no child job or fleet row was created');
    assert.deepEqual(fs.readFileSync(eventPath(job.id)), journalBefore, 'child transcript bytes never enter the parent journal');
  } finally { source.close(); }

  const fallbackJob = createManagedJob({ provider: 'codex', mode: 'review', cwd: harness.root, prompt: packet('Read one selected fallback') });
  updateManagedJob(fallbackJob.id, (record) => {
    record.providerSessionId = 'thread-fallback-parent';
    record.providerCliVersion = '0.144.0';
    record.status = 'completed';
    record.phase = 'completed';
  });
  const sessionsDir = path.join(harness.root, 'codex-sessions');
  fs.mkdirSync(path.join(sessionsDir, '2026', '08', '04'), { recursive: true });
  const rollout = path.join(sessionsDir, '2026', '08', '04', 'rollout-child.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'thread-fallback-child' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: REASONING_SECRET }] } },
    { type: 'event_msg', timestamp: new Date(NOW).toISOString(), payload: { type: 'agent_message', message: 'Fallback public answer' } }
  ];
  fs.writeFileSync(rollout, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  const fallbackClient = {
    version: '0.144.0',
    async discover() {
      return { threads: [{ id: 'thread-fallback-child', parentThreadId: 'thread-fallback-parent', status: 'idle' }], capped: false, version: this.version };
    },
    async read() { throw new Error('thread store unavailable'); },
    async close() {}
  };
  const fallbackSource = new DelegateDataSource({
    watch: false, pollMs: 100, codexSessionsDir: sessionsDir,
    codexSubagentClientFactory: () => fallbackClient
  });
  try {
    fallbackSource.refreshRecords({ force: true });
    const journalBefore = fs.readFileSync(eventPath(fallbackJob.id));
    await fallbackSource.selectSubagent(fallbackJob.id);
    const result = await fallbackSource.selectSubagent(fallbackJob.id, 'thread-fallback-child');
    const snapshot = result.subagentsByJob[fallbackJob.id].snapshot;
    assert.equal(snapshot.mode, 'disk');
    assert.match(JSON.stringify(snapshot.events), /Fallback public answer/);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(REASONING_SECRET));
    assert.deepEqual(fs.readFileSync(eventPath(fallbackJob.id)), journalBefore);
  } finally { fallbackSource.close(); }
});

// The reasoning/thought early exit is only one of two layers. The layer that
// actually decides what a child may show is the itemEvents allow-list, which
// returns nothing for a kind it does not recognize. Nothing pinned that layer:
// removing the early exit fails a test, but making the allow-list fall through
// did not. A future item type carrying private content under a name that does
// not contain "reasoning" or "thought" is exactly what the allow-list is for.
test('an unrecognized child item kind projects no events at all', () => {
  const thread = {
    id: 'thread-unknown-kind',
    status: { type: 'completed' },
    turns: [{
      id: 'turn-unknown',
      status: 'completed',
      startedAt: NOW / 1000 - 10,
      items: [
        { id: 'x-1', type: 'internalMonologue', text: REASONING_SECRET, content: [{ type: 'text', text: REASONING_SECRET }] },
        { id: 'x-2', type: 'someFutureItemType', summary: [{ text: REASONING_SECRET }] },
        { id: 'ok-1', type: 'agentMessage', text: 'Public answer.' }
      ]
    }]
  };
  const snapshot = projectCodexChildSnapshot(thread, { now: NOW });
  assert.match(JSON.stringify(snapshot.events), /Public answer/, 'recognized items still project');
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(REASONING_SECRET), 'unrecognized kinds must contribute nothing');
  assert.equal(snapshot.events.length, 1, 'only the one recognized item became an event');
  assert.equal(snapshot.droppedReasoningCount, 0, 'these were dropped by the allow-list, not the reasoning early exit');
});
