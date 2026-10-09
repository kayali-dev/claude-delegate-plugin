import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeWriterLocks, appendJobEvent, createManagedJob, updateManagedJob } from '../bin/lib/control.mjs';
import { createClaudeAgentStub } from '../bin/lib/agent-stubs.mjs';
import { paintFrame } from '../bin/lib/tui/components.mjs';
import { DelegateDataSource, tailAllJobs } from '../bin/lib/tui/datasource.mjs';
import { dashboardViewModel, fleetViewModel } from '../bin/lib/tui/viewmodels.mjs';
import { loadJob, saveJob } from '../bin/lib/state.mjs';
import { waitForEventState } from './helpers/wait.mjs';

async function isolated(fn) {
  const names = ['DELEGATE_STATE_FILE', 'DELEGATE_ENABLED_PROVIDERS', 'DELEGATE_CLAUDE_PROJECTS_DIR'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-source-'));
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  process.env.DELEGATE_CLAUDE_PROJECTS_DIR = path.join(root, 'claude-projects');
  try { return await fn(root); }
  finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function waitFor(source, predicate, description, timeoutMs = 2_500) {
  return waitForEventState({ source, predicate, description, timeoutMs });
}

function completePacket(objective) {
  return `# Objective\n${objective}\n\n# Allowed scope\nRead only.\n\n# Acceptance criteria\nComplete.\n\n# Return\nResult.`;
}

test('tailAllJobs discovers new job files and tails only new journal events', () => isolated(async (root) => {
  const source = tailAllJobs({ pollMs: 100, debounceMs: 5 });
  try {
    const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'inspect the code' });
    const discovered = await waitFor(source, (state) => state.jobs.some((entry) => entry.id === job.id), 'datasource fleet discovery to include the new job');
    assert.equal(discovered.eventsByJob[job.id], undefined, 'fleet discovery must not hydrate journals');
    assert.equal(source.metrics.journalPages, 0);

    const hydrated = await source.selectJob(job.id);
    const initialEvents = hydrated.eventsByJob[job.id];
    assert.ok(initialEvents.length >= 2);
    assert.equal(hydrated.hydrationByJob[job.id].loaded, true);
    const initialCursor = source.journalCursors.get(job.id);
    const initialMetric = source.metrics.journalEvents;

    appendJobEvent(job.id, 'message.completed', { text: 'findings' });
    const tailed = await waitFor(source, (state) => state.eventsByJob[job.id]?.some((event) => event.type === 'message.completed'), 'selected job events to include message.completed');
    assert.equal(tailed.eventsByJob[job.id].filter((event) => event.type === 'message.completed').length, 1);
    assert.ok(source.journalCursors.get(job.id) > initialCursor);
    assert.equal(source.metrics.journalEvents, initialMetric + 1);

    source.refresh();
    assert.equal(source.metrics.journalEvents, initialMetric + 1, 'quiet refresh must not re-append old journal events');
  } finally { source.close(); }
}));

test('claude-agent detail uses ingested journal events or transcript fallback, never both', () => isolated(async (root) => {
  const transcriptAgentId = 'f5f9ee00417f2e40';
  const sidecar = path.join(root, 'coordinator');
  const subagents = path.join(sidecar, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const transcript = path.join(subagents, `agent-${transcriptAgentId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-04T00:00:00.000Z',
    message: { id: 'fallback-message', role: 'assistant', content: [{ type: 'text', text: 'fallback text' }] }
  })}\n`);
  const job = createClaudeAgentStub({
    sessionId: 'tui-agent-session',
    toolUseId: 'toolu_tui_agent',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    transcriptAgentId,
    transcriptPath: transcript,
    prompt: 'show one source'
  });
  const source = new DelegateDataSource({ watch: false, pollMs: 100_000 });
  try {
    source.refreshRecords({ force: true });
    let selected = await source.selectJob(job.id);
    assert.equal(selected.eventsByJob[job.id].length, 1);
    assert.equal(selected.eventsByJob[job.id][0].source, 'claude-agent-transcript');
    assert.equal(source.metrics.readOnlyTranscriptReads, 1);

    appendJobEvent(job.id, 'message.delta', { id: 'journal-message', delta: 'journal text' });
    updateManagedJob(job.id, (current) => {
      current.agentTranscriptIngestion = { journalEvents: 1, closed: false };
    }, { incrementRevision: false });
    await source.selectJob(null);
    source.refreshRecords({ force: true });
    selected = await source.selectJob(job.id);
    assert.ok(selected.eventsByJob[job.id].some((event) => event.type === 'message.delta' && event.data.id === 'journal-message'));
    assert.ok(selected.eventsByJob[job.id].every((event) => event.source !== 'claude-agent-transcript'));
    assert.equal(source.metrics.readOnlyTranscriptReads, 1, 'journal hydration must not also reread the transcript');
  } finally { source.close(); }
}));

test('datasource exposes provider allowance, stats inputs, and active writer ownership read-only', () => isolated(async (root) => {
  const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: root, prompt: 'implement' });
  updateManagedJob(writer.id, (job) => { job.status = 'running'; job.phase = 'working'; job.workerPid = process.pid; });
  const reader = createManagedJob({ provider: 'cursor', mode: 'review', cwd: root, prompt: 'review' });
  const continuation = createManagedJob({ provider: 'cursor', mode: 'review', cwd: root, prompt: 'continue', parentJobId: reader.id, providerSessionId: 'chat-test' });
  const locks = activeWriterLocks();
  assert.deepEqual(locks.map((lock) => lock.jobId), [writer.id]);
  assert.ok(!locks.some((lock) => lock.jobId === reader.id));

  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    const state = source.hydrateMetadata({ force: true });
    assert.equal(state.writerLocks[0].cwd, path.resolve(root));
    assert.equal(state.jobs.find((job) => job.id === continuation.id).rootJobId, reader.id);
    assert.equal(state.providers.find((provider) => provider.name === 'codex').enabled, true);
    assert.equal(state.stats.since, '7d');
    assert.ok(state.profiles.includes('independent-review'));
  } finally { source.close(); }
}));

test('startup paints from 35 job records without touching journals and stays under 500ms', () => isolated((root) => {
  for (let index = 0; index < 35; index += 1) {
    const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: completePacket(`job ${index}`) });
    for (let event = 0; event < 20; event += 1) appendJobEvent(job.id, 'message.delta', { text: 'x'.repeat(200) });
  }
  const started = performance.now();
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    const firstPaint = source.getState();
    paintFrame(fleetViewModel(firstPaint, { now: Date.now() }, { width: 100, height: 30 }));
    const firstFrameMs = performance.now() - started;
    assert.equal(firstPaint.jobs.length, 35);
    assert.deepEqual(firstPaint.eventsByJob, {});
    assert.equal(source.metrics.journalPages, 0);
    assert.ok(source.metrics.startupMs < 500, `record-only startup took ${source.metrics.startupMs.toFixed(1)}ms`);
    assert.ok(firstFrameMs < 500, `startup through first painted frame took ${firstFrameMs.toFixed(1)}ms`);
  } finally { source.close(); }
}));

test('first detail selection loads completed-job history from seq zero before following', () => isolated(async (root) => {
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'historical prompt' });
  appendJobEvent(job.id, 'message.completed', { text: 'historical findings' });
  updateManagedJob(job.id, (record) => {
    record.status = 'completed';
    record.phase = 'completed';
    record.completedAt = Math.floor(Date.now() / 1000);
  });
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    assert.equal(source.getState().eventsByJob[job.id], undefined);
    const selected = await source.selectJob(job.id);
    assert.ok(selected.eventsByJob[job.id].some((event) => event.type === 'message.user'));
    assert.ok(selected.eventsByJob[job.id].some((event) => event.data?.text === 'historical findings'));
    assert.equal(selected.hydrationByJob[job.id].loading, false);
    assert.equal(source.journalCursors.get(job.id), selected.eventsByJob[job.id].at(-1).seq);
  } finally { source.close(); }
}));

test('record-only refresh advances fleet heartbeat without hydrating an unselected journal', () => isolated((root) => {
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'heartbeat record' });
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    const before = source.getState().jobs.find((entry) => entry.id === job.id).lastActivityAt;
    const record = loadJob(job.id);
    record.updatedAt += 10;
    saveJob(record);
    const after = source.refresh().jobs.find((entry) => entry.id === job.id).lastActivityAt;
    assert.equal(after, before + 10000);
    assert.equal(source.metrics.journalPages, 0);
  } finally { source.close(); }
}));

test('close tears down polls, debounce work, watchers, and deferred hydration immediately', () => isolated(async (root) => {
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'close promptly' });
  const source = tailAllJobs({ pollMs: 2000, debounceMs: 80 });
  source.scheduleRefresh('all');
  const hydration = source.selectJob(job.id);
  source.close();
  // Teardown of an fs.watch handle is a synchronous OS call whose latency is
  // unbounded on macOS FSEvents: measured at 13-30ms typically but >9s at the
  // tail, independent of this code and of host load. It accounted for 100% of
  // this assertion's elapsed time, making the bound a coin flip rather than a
  // regression guard. Time only the deferred hydration settling, which is the
  // cancellation property this test actually names.
  const started = performance.now();
  await hydration;
  const elapsed = performance.now() - started;
  assert.equal(source.pollTimer, null);
  assert.equal(source.sessionPollTimer, null);
  assert.equal(source.debounceTimer, null);
  assert.deepEqual(source.watchers, []);
  assert.equal(source.immediates.size, 0);
  assert.ok(elapsed < 200, `deferred hydration took ${elapsed.toFixed(1)}ms to settle after close`);
}));

test('leaving detail cancels deferred journal hydration until that job is selected again', () => isolated(async (root) => {
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'cancel lazy hydration' });
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    const pending = source.selectJob(job.id);
    await source.selectJob(null);
    await pending;
    assert.equal(source.metrics.journalPages, 0);
    assert.equal(source.getState().hydrationByJob[job.id].loaded, false);

    const selected = await source.selectJob(job.id);
    assert.ok(selected.eventsByJob[job.id].length >= 2);
    assert.equal(selected.hydrationByJob[job.id].loaded, true);
  } finally { source.close(); }
}));

test('lazy visible-row reconciliation is deferred and capped at five jobs per batch', () => isolated(async (root) => {
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: completePacket(`stale ${index}`) });
    const record = loadJob(job.id);
    record.createdAt = Math.floor(Date.now() / 1000) - 700;
    record.updatedAt = record.createdAt;
    saveJob(record);
    ids.push(job.id);
  }
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    const compactFrame = fleetViewModel(source.getState(), { now: Date.now() }, { width: 100, height: 8 });
    assert.equal(compactFrame.meta.reconcileJobIds.length, 3, 'only rows inside the painted table window are eligible');
    const firstFrame = fleetViewModel(source.getState(), { now: Date.now() }, { width: 100, height: 30 });
    assert.deepEqual(new Set(firstFrame.meta.reconcileJobIds), new Set(ids));
    assert.ok(source.getState().jobs.every((job) => job.status === 'queued'), 'first paint must precede persistence');

    const firstBatch = await source.reconcileVisibleJobs(firstFrame.meta.reconcileJobIds, { limit: 5 });
    assert.equal(firstBatch.jobs.filter((job) => job.status === 'failed').length, 5);
    assert.equal(firstBatch.jobs.filter((job) => job.status === 'queued').length, 3);
    assert.equal(firstBatch.jobs.filter((job) => job.tuiReconciledFrom === 'queued').length, 5);
    assert.equal(source.metrics.reconciliations, 5);

    const secondFrame = fleetViewModel(firstBatch, { now: Date.now() }, { width: 100, height: 30 });
    await source.reconcileVisibleJobs(secondFrame.meta.reconcileJobIds, { limit: 5 });
    assert.equal(source.getState().jobs.filter((job) => job.status === 'failed').length, 8);
    assert.equal(source.metrics.reconciliations, 8);
  } finally { source.close(); }
}));

test('completed history hydration stays settled across quiet refreshes and tails without loading churn', () => isolated(async (root) => {
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: completePacket('hydrate once') });
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  try {
    await source.selectJob(job.id);
    const pages = source.metrics.journalPages;
    const loading = [];
    source.on('change', (state) => loading.push(state.hydrationByJob[job.id]?.loading));
    source.refreshRecords();
    source.refreshRecords();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(source.metrics.journalPages, pages, 'unchanged journal is not hydrated again');
    assert.ok(!loading.includes(true), 'settled history never re-enters loading');

    appendJobEvent(job.id, 'message.completed', { text: 'one new tail event' });
    await source.selectJob(job.id);
    assert.equal(source.metrics.journalPages, pages + 1);
    assert.equal(source.getState().hydrationByJob[job.id].loading, false);
    assert.ok(!loading.includes(true), 'incremental tail reads do not show initial-history loading');
  } finally { source.close(); }
}));

test('fleet freshness follows unselected record, journal, and clock transitions within one refresh cycle', () => isolated(async (root) => {
  const jobs = [];
  for (let index = 0; index < 9; index += 1) {
    const created = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: completePacket(`fresh ${index}`) });
    updateManagedJob(created.id, (record) => {
      record.status = 'running';
      record.phase = 'working';
      record.workerPid = process.pid;
    });
    jobs.push(created.id);
  }
  const target = jobs[5];
  const source = new DelegateDataSource({ watch: false, pollMs: 100000 }).start();
  const activityText = (state, now = Date.now()) => {
    const frame = fleetViewModel(state, { now, selectedIndex: 1, scroll: 3 }, { width: 100, height: 14 });
    const activity = frame.panes[0].content.columns.findIndex((column) => column.key === 'activity');
    return frame.panes[0].content.rows.find((row) => row.id === target)?.cells[activity]?.text || '';
  };
  try {
    appendJobEvent(target, 'tool.started', { id: 'fresh-tool', item: { id: 'fresh-tool', type: 'commandExecution', command: ['node', '--test'], status: 'inProgress' } });
    let state = source.refresh({ force: true });
    assert.match(activityText(state), /tool:/, 'visible unselected row receives its journal tail');

    // A different screen may be focused; the next source refresh still
    // updates the shared store consumed by both Dashboard and Fleet.
    dashboardViewModel(state, { now: Date.now() }, { width: 100, height: 30 });
    appendJobEvent(target, 'tool.completed', { id: 'fresh-tool', item: { id: 'fresh-tool', type: 'commandExecution', command: ['node', '--test'], status: 'completed', exitCode: 0 } });
    state = source.refresh({ force: true });
    assert.doesNotMatch(activityText(state), /tool:/, 'tool completion replaces stale tool activity');

    updateManagedJob(target, (record) => {
      record.status = 'completed';
      record.phase = 'completed';
      record.completedAt = Math.floor(Date.now() / 1000);
    });
    state = source.refresh({ force: true });
    assert.match(activityText(state), /completed/, 'modified job record is re-read rather than cached by id');

    updateManagedJob(target, (record) => {
      record.status = 'running';
      record.phase = 'working';
      record.completedAt = null;
      record.workerPid = process.pid;
    });
    state = source.refresh({ force: true });
    const future = Date.now() + 600_000;
    assert.match(activityText(state, future), /quiet/, 'silence is informational rather than a stall');
    const dashboard = dashboardViewModel(state, { now: future }, { width: 100, height: 30 });
    assert.ok(!dashboard.meta.attentionJobIds.includes(target), 'quiet investigation does not need user intervention');
  } finally { source.close(); }
}));
