import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeWriterLocks, appendJobEvent, createManagedJob, updateManagedJob } from '../bin/lib/control.mjs';
import { paintFrame } from '../bin/lib/tui/components.mjs';
import { DelegateDataSource, tailAllJobs } from '../bin/lib/tui/datasource.mjs';
import { fleetViewModel } from '../bin/lib/tui/viewmodels.mjs';
import { loadJob, saveJob } from '../bin/lib/state.mjs';

async function isolated(fn) {
  const names = ['DELEGATE_STATE_FILE', 'DELEGATE_ENABLED_PROVIDERS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-source-'));
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  try { return await fn(root); }
  finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function waitFor(source, predicate, timeoutMs = 2500) {
  const current = source.getState();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      source.off('change', changed);
      reject(new Error('timed out waiting for datasource change'));
    }, timeoutMs);
    const changed = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      source.off('change', changed);
      resolve(state);
    };
    source.on('change', changed);
  });
}

function completePacket(objective) {
  return `# Objective\n${objective}\n\n# Allowed scope\nRead only.\n\n# Acceptance criteria\nComplete.\n\n# Return\nResult.`;
}

test('tailAllJobs discovers new job files and tails only new journal events', () => isolated(async (root) => {
  const source = tailAllJobs({ pollMs: 100, debounceMs: 5 });
  try {
    const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'inspect the code' });
    const discovered = await waitFor(source, (state) => state.jobs.some((entry) => entry.id === job.id));
    assert.equal(discovered.eventsByJob[job.id], undefined, 'fleet discovery must not hydrate journals');
    assert.equal(source.metrics.journalPages, 0);

    const hydrated = await source.selectJob(job.id);
    const initialEvents = hydrated.eventsByJob[job.id];
    assert.ok(initialEvents.length >= 2);
    assert.equal(hydrated.hydrationByJob[job.id].loaded, true);
    const initialCursor = source.journalCursors.get(job.id);
    const initialMetric = source.metrics.journalEvents;

    appendJobEvent(job.id, 'message.completed', { text: 'findings' });
    const tailed = await waitFor(source, (state) => state.eventsByJob[job.id]?.some((event) => event.type === 'message.completed'));
    assert.equal(tailed.eventsByJob[job.id].filter((event) => event.type === 'message.completed').length, 1);
    assert.ok(source.journalCursors.get(job.id) > initialCursor);
    assert.equal(source.metrics.journalEvents, initialMetric + 1);

    source.refresh();
    assert.equal(source.metrics.journalEvents, initialMetric + 1, 'quiet refresh must not re-append old journal events');
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
  const started = performance.now();
  source.close();
  await hydration;
  const elapsed = performance.now() - started;
  assert.equal(source.pollTimer, null);
  assert.equal(source.debounceTimer, null);
  assert.deepEqual(source.watchers, []);
  assert.equal(source.immediates.size, 0);
  assert.ok(elapsed < 200, `datasource close took ${elapsed.toFixed(1)}ms`);
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
