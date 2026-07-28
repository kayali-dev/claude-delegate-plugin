import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  createManagedJob,
  eventPath,
  pruneJobs,
  readJobEventPage,
  readJobEvents,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { readRecentJobEvents } from '../bin/lib/tui/datasource.mjs';
import { normalizeTranscriptEvents } from '../bin/lib/tui/transcript.mjs';
import { loadJob, saveJob } from '../bin/lib/state.mjs';
import { saveSupervisorLease } from '../bin/lib/supervisor-common.mjs';
import {
  DEFAULT_JOURNAL_CAP_BYTES,
  DEFAULT_RECENT_TERMINAL_KEEP,
  DEFAULT_STATE_BUDGET_BYTES,
  maintenanceLogPath,
  readJournalBuffer
} from '../bin/lib/store-maintenance.mjs';

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function isolated(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-store-maintenance-'));
  const previous = {
    state: process.env.DELEGATE_STATE_FILE,
    cap: process.env.DELEGATE_JOB_JOURNAL_CAP_BYTES
  };
  process.env.DELEGATE_STATE_FILE = path.join(root, 'usage.json');
  t.after(() => {
    if (previous.state == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous.state;
    if (previous.cap == null) delete process.env.DELEGATE_JOB_JOURNAL_CAP_BYTES;
    else process.env.DELEGATE_JOB_JOURNAL_CAP_BYTES = previous.cap;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  return fn(root);
}

function terminalJob(root, label, values = {}) {
  const job = createManagedJob({ provider: 'codex', cwd: root, prompt: label });
  updateManagedJob(job.id, (record) => {
    record.status = 'completed';
    record.phase = 'completed';
    record.completedAt = values.completedAt || Math.floor(Date.now() / 1000);
    if (values.acceptance) record.acceptance = values.acceptance;
  });
  if (values.createdAt != null) {
    const record = loadJob(job.id);
    record.createdAt = values.createdAt;
    record.updatedAt = values.createdAt;
    record.completedAt = values.createdAt;
    saveJob(record);
  }
  fs.mkdirSync(path.join(root, 'jobs', `${job.id}.artifacts`), { recursive: true });
  fs.writeFileSync(path.join(root, 'jobs', `${job.id}.artifacts`, 'payload.bin'), Buffer.alloc(4096, label));
  return loadJob(job.id);
}

test('store policy defaults are bounded developer-tool values', () => {
  assert.equal(DEFAULT_STATE_BUDGET_BYTES, 1536 * 1024 * 1024);
  assert.equal(DEFAULT_RECENT_TERMINAL_KEEP, 20);
  assert.equal(DEFAULT_JOURNAL_CAP_BYTES, 32 * 1024 * 1024);
});

test('budget reclaim deletes oldest eligible work but stops over budget with every protected class intact', (t) => isolated(t, (root) => {
  const now = Math.floor(Date.now() / 1000);
  const candidate = terminalJob(root, 'candidate', { createdAt: now - 600 });
  const ready = terminalJob(root, 'ready', {
    createdAt: now - 500,
    acceptance: { state: 'ready-for-review', blockedBy: [] }
  });
  const blocked = terminalJob(root, 'blocked', {
    createdAt: now - 400,
    acceptance: { state: 'blocked', blockedBy: ['verification'] }
  });
  const leased = terminalJob(root, 'leased', { createdAt: now - 300 });
  saveSupervisorLease({
    attemptId: leased.id,
    jobId: leased.id,
    pid: process.pid,
    ppid: process.ppid,
    heartbeatAt: Date.now(),
    expiresAt: Date.now() + 60_000
  });
  const queued = createManagedJob({ provider: 'codex', cwd: root, prompt: 'queued' });
  const running = createManagedJob({ provider: 'codex', cwd: root, prompt: 'running' });
  updateManagedJob(running.id, (record) => {
    record.status = 'running';
    record.phase = 'running';
  });
  const inputRequired = createManagedJob({ provider: 'codex', cwd: root, prompt: 'input-required' });
  updateManagedJob(inputRequired.id, (record) => {
    record.status = 'user-input-required';
    record.phase = 'waiting';
  });
  const newest = terminalJob(root, 'newest', { createdAt: now - 100 });

  const result = pruneJobs({
    maxAgeDays: 0,
    budgetBytes: 1,
    recentTerminalKeep: 1,
    maxRecordsExamined: 50,
    maxRecordsRemoved: 20,
    maxJournalsCompressed: 0
  });

  assert.deepEqual(result.removed.map((entry) => [entry.id, entry.reason]), [[candidate.id, 'budget']]);
  assert.equal(loadJob(candidate.id), null);
  assert.equal(loadJob(queued.id).status, 'queued', 'queued work is protected');
  assert.equal(loadJob(running.id).status, 'running', 'running work is protected');
  assert.equal(loadJob(inputRequired.id).status, 'user-input-required', 'input-required work is protected');
  assert.equal(loadJob(ready.id).acceptance.state, 'ready-for-review', 'unreviewed ready work is protected');
  assert.equal(loadJob(blocked.id).acceptance.state, 'blocked', 'blocked work is protected');
  assert.equal(loadJob(leased.id).status, 'completed', 'a live supervisor lease is protected');
  assert.equal(loadJob(newest.id).status, 'completed', 'the newest terminal history is protected');
  assert.equal(result.overBudget, true);
  assert.match(result.warnings.join('\n'), /remains .* over budget/);
  const log = fs.readFileSync(maintenanceLogPath(), 'utf8');
  assert.match(log, new RegExp(candidate.id));
  assert.match(log, /"reason":"budget"/);
  assert.match(log, /protected records and sweep bounds were retained/);
}));

test('one sweep caps record examination and removal and reports continuation', (t) => isolated(t, (root) => {
  const now = Math.floor(Date.now() / 1000);
  terminalJob(root, 'oldest', { createdAt: now - 300 });
  terminalJob(root, 'older', { createdAt: now - 200 });
  terminalJob(root, 'old', { createdAt: now - 100 });
  const result = pruneJobs({
    maxAgeDays: 0,
    budgetBytes: 1,
    recentTerminalKeep: 0,
    maxRecordsExamined: 2,
    maxRecordsRemoved: 1,
    maxJournalsCompressed: 0
  });
  assert.equal(result.examinedRecords, 2);
  assert.equal(result.removed.length, 1);
  assert.equal(result.continuationNeeded, true);
  assert.equal(result.overBudget, true);
}));

test('journal cap records one explicit marker and retains the head and latest tail', (t) => isolated(t, (root) => {
  process.env.DELEGATE_JOB_JOURNAL_CAP_BYTES = String(64 * 1024);
  const job = createManagedJob({ provider: 'codex', cwd: root, prompt: 'bounded journal' });
  for (let index = 0; index < 80; index += 1) {
    appendJobEvent(job.id, 'tool.output', { index, output: `${index}:`.padEnd(2048, 'x') });
  }
  const record = loadJob(job.id);
  const events = readJobEvents(job.id, { limit: 1000 });
  const marker = events.find((event) => event.type === 'journal.truncated');
  assert.ok(marker);
  assert.equal(marker.data.retained, 'head-and-tail');
  assert.equal(record.journalTruncation.retained, 'head-and-tail');
  assert.ok(record.journalTruncation.omittedEvents > 0);
  assert.equal(events[0].seq, 1);
  assert.ok(events.some((event) => event.type === 'message.user'));
  assert.equal(events.at(-1).data.index, 79);
  assert.ok(fs.statSync(eventPath(job.id)).size <= 64 * 1024);
  assert.match(JSON.stringify(normalizeTranscriptEvents(events)), /journal\.truncated/);
}));

test('terminal gzip remains transparent to event pagination and TUI transcript tails', (t) => isolated(t, (root) => {
  const job = createManagedJob({ provider: 'codex', cwd: root, prompt: 'compress me' });
  appendJobEvent(job.id, 'message.completed', { text: 'terminal transcript text' });
  updateManagedJob(job.id, (record) => {
    record.status = 'completed';
    record.phase = 'completed';
    record.completedAt = Math.floor(Date.now() / 1000);
  });
  appendJobEvent(job.id, 'job.completed', { status: 'completed' });
  appendJobEvent(job.id, 'acceptance.decided', { state: 'accepted' });

  const plain = path.join(root, 'jobs', `${job.id}.events.jsonl`);
  const compressed = `${plain}.gz`;
  assert.equal(fs.existsSync(plain), false);
  assert.equal(fs.existsSync(compressed), true);
  assert.equal(eventPath(job.id), compressed);

  const paged = [];
  let afterSeq = 0;
  for (;;) {
    const page = readJobEventPage(job.id, { afterSeq, limit: 2 });
    paged.push(...page.events);
    if (!page.hasMore) break;
    afterSeq = page.nextSeq;
  }
  assert.match(JSON.stringify(paged), /terminal transcript text/);
  assert.equal(paged.at(-1).type, 'acceptance.decided');

  const tuiTail = readRecentJobEvents(job.id, { maxBytes: 1024 * 1024, limit: 100 });
  assert.match(JSON.stringify(normalizeTranscriptEvents(tuiTail)), /terminal transcript text/);
}));

test('journal readers follow a plain-to-gzip handoff after resolving the disappearing plain path', (t) => isolated(t, (root) => {
  const plain = path.join(root, 'handoff.events.jsonl');
  const compressed = `${plain}.gz`;
  const payload = Buffer.from('{"seq":1,"type":"message.completed"}\n');
  fs.writeFileSync(plain, payload, { mode: 0o600 });
  const originalRead = fs.readFileSync;
  let forced = false;
  fs.readFileSync = function readWithForcedHandoff(file, ...args) {
    if (!forced && path.resolve(String(file)) === path.resolve(plain)) {
      forced = true;
      const source = originalRead.call(fs, file);
      fs.writeFileSync(compressed, zlib.gzipSync(source), { mode: 0o600 });
      fs.unlinkSync(plain);
    }
    return originalRead.call(fs, file, ...args);
  };
  try {
    assert.equal(readJournalBuffer(plain).toString('utf8'), payload.toString('utf8'));
    assert.equal(forced, true, 'the test must force the post-resolution unlink interleaving');
  } finally {
    fs.readFileSync = originalRead;
  }
}));

test('health JSON exposes store bytes, files, budget, and headroom', (t) => isolated(t, (root) => {
  createManagedJob({ provider: 'codex', cwd: root, prompt: 'health-visible' });
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'bin', 'delegate-health'), '--quick', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.store.bytes > 0);
  assert.ok(report.store.files > 0);
  assert.equal(report.store.budgetBytes, DEFAULT_STATE_BUDGET_BYTES);
  assert.equal(report.store.headroomBytes, report.store.budgetBytes - report.store.bytes);
}));

test('CLI, TUI, MCP, and supervisor idle all share maybePruneJobs', () => {
  const files = [
    'bin/delegate-jobs',
    'bin/delegate-tui',
    'bin/delegate-control-mcp',
    'bin/lib/supervisor-runtime.mjs'
  ];
  for (const file of files) {
    assert.match(fs.readFileSync(path.join(pluginRoot, file), 'utf8'), /maybePruneJobs/);
  }
});
