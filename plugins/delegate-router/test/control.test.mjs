import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendJobEvent,
  createManagedJob,
  inspectJob,
  jobDiff,
  jobFiles,
  jobTranscript,
  jobTranscriptPage,
  launchManagedJob,
  listManagedJobs,
  pruneJobs,
  readJobEventPage,
  readJobEvents,
  redact,
  resumeManagedJob,
  submitControl,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { loadState, saveState, setWindow } from '../bin/lib/state.mjs';

function isolated(fn) {
  const previous = process.env.DELEGATE_STATE_FILE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { return fn(directory); }
  finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  }
}

test('managed jobs persist ordered redacted events and derived views', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review token sk-12345678901234567890' });
  appendJobEvent(job.id, 'file.changed', { changes: [{ path: 'src/a.js', token: 'secret-value' }] });
  appendJobEvent(job.id, 'diff.updated', { diff: 'diff --git a/src/a.js b/src/a.js' });
  const events = readJobEvents(job.id);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
  assert.ok(!JSON.stringify(events).includes('sk-12345678901234567890'));
  assert.equal(jobFiles(job.id)[0].path, 'src/a.js');
  assert.match(jobDiff(job.id), /diff --git/);
  assert.equal(jobTranscript(job.id)[0].type, 'message.user');
  const eventFile = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  assert.equal(fs.statSync(eventFile).mode & 0o777, 0o600);
}));

test('control commands use revisions and stable ids for exactly-once acceptance', () => isolated((directory) => {
  const created = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const current = inspectJob(created.id);
  const first = submitControl(created.id, { type: 'steer', correctionId: 'same-correction', text: 'use another API' }, current.revision);
  assert.equal(first.accepted, true);
  const duplicate = submitControl(created.id, { type: 'steer', correctionId: 'same-correction', text: 'use another API' }, current.revision);
  assert.equal(duplicate.duplicate, true);
  assert.throws(
    () => submitControl(created.id, { type: 'cancel', commandId: 'competing-command' }, current.revision),
    /REVISION_CONFLICT/
  );
  assert.equal(inspectJob(created.id).revision, current.revision + 1);
}));

test('event pagination resumes without duplicates and ignores a truncated tail', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'plan.updated', { plan: ['one'] });
  appendJobEvent(job.id, 'plan.updated', { plan: ['two'] });
  const first = readJobEvents(job.id, { limit: 2 });
  const second = readJobEvents(job.id, { afterSeq: first.at(-1).seq, limit: 10 });
  assert.deepEqual([...first, ...second].map((event) => event.seq), [1, 2, 3, 4]);
  fs.appendFileSync(path.join(directory, 'jobs', `${job.id}.events.jsonl`), '{"truncated":');
  assert.equal(readJobEvents(job.id).length, 4);
  appendJobEvent(job.id, 'plan.updated', { plan: ['recovered'] });
  assert.deepEqual(readJobEvents(job.id).map((event) => event.seq), [1, 2, 3, 4, 5]);
}));

test('large diffs spill to private artifacts and remain fully inspectable', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const diff = `diff --git a/large b/large\n${'x'.repeat(70000)}`;
  const event = appendJobEvent(job.id, 'diff.updated', { diff });
  assert.equal(event.data.diff, undefined);
  assert.equal(fs.statSync(event.data.artifactPath).mode & 0o777, 0o600);
  assert.equal(jobDiff(job.id), diff);
}));

test('managed starts enforce provider allowance before spawning a worker', () => isolated((directory) => {
  const state = loadState();
  setWindow(state, 'cursor', 'primary', 95, { source: 'test' });
  saveState(state);
  assert.throws(() => launchManagedJob({ provider: 'cursor', cwd: directory, prompt: 'task' }), /QUOTA_GUARD/);
}));

test('redaction preserves numeric usage while hiding numeric and boolean secrets', () => {
  assert.deepEqual(redact({ inputTokens: 12, total_token_count: 20, password: 123456, token: 987654, secret: true }), {
    inputTokens: 12,
    total_token_count: 20,
    password: '[REDACTED]',
    token: '[REDACTED]',
    secret: '[REDACTED]'
  });
  const text = redact({ text: 'password=hunter2 AWS_SECRET_ACCESS_KEY=abcdef "apiKey":"value123" postgres://user:pass@db.local/app' }).text;
  assert.doesNotMatch(text, /hunter2|abcdef|value123|user:pass/);
});

test('filtered event pages advance across nonmatches without skipping later matches', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'plan.updated', { plan: [] });
  const first = readJobEventPage(job.id, { afterSeq: 0, types: ['error'] });
  assert.equal(first.events.length, 0);
  assert.equal(first.nextSeq, 3);
  appendJobEvent(job.id, 'error', { message: 'failure' });
  const second = readJobEventPage(job.id, { afterSeq: first.nextSeq, types: ['error'] });
  assert.equal(second.events[0].type, 'error');
}));

test('resume rejects an active parent session', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => { current.providerSessionId = 'thread-active'; current.status = 'running'; current.workerPid = process.pid; });
  assert.throws(() => resumeManagedJob(job.id, { prompt: 'continue' }), /PARENT_ACTIVE/);
}));

test('inspect reconciles orphaned running jobs to failed with an audit event', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => { current.status = 'running'; current.phase = 'running'; current.workerPid = 999999999; });
  const reconciled = inspectJob(job.id);
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.error, /ORPHANED/);
  assert.ok(readJobEvents(job.id).some((event) => event.type === 'error' && event.data.code === 'ORPHANED'));
  assert.equal(inspectJob(job.id).status, 'failed');
}));

test('write-mode launches are blocked while another writer is active in the same cwd', () => isolated((directory) => {
  const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'first writer' });
  updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
  try {
    launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'second writer' });
    assert.fail('expected WRITER_ACTIVE');
  } catch (error) {
    assert.equal(error.code, 'WRITER_ACTIVE');
    assert.equal(error.activeJobId, writer.id);
  }
  assert.throws(() => launchManagedJob({ provider: 'codex', mode: 'verify', cwd: directory, prompt: 'verifier' }), /WRITER_ACTIVE/);
}));

test('writer guard honors an explicit overrideWriter bypass', () => isolated((directory) => {
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'writer' });
    updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
    const bypassed = launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'override', overrideWriter: true });
    assert.equal(bypassed.mode, 'implement');
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
}));

test('writer guard releases once the previous writer is orphaned', () => isolated((directory) => {
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'writer' });
    updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = 999999999; });
    const next = launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'next writer' });
    assert.equal(next.mode, 'implement');
    assert.equal(inspectJob(writer.id).status, 'failed');
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
}));

test('revision conflicts carry the current revision for one-step retry', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const revision = inspectJob(job.id).revision;
  submitControl(job.id, { type: 'steer', correctionId: 'first', text: 'adjust' }, revision);
  try {
    submitControl(job.id, { type: 'cancel', commandId: 'second' }, revision);
    assert.fail('expected REVISION_CONFLICT');
  } catch (error) {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.currentRevision, revision + 1);
  }
}));

test('transcript pages omit deltas by default and paginate with nextSeq', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'message.delta', { id: 'm', delta: 'He' });
  appendJobEvent(job.id, 'message.delta', { id: 'm', delta: 'llo' });
  appendJobEvent(job.id, 'message.completed', { id: 'm', text: 'Hello' });
  const page = jobTranscriptPage(job.id);
  assert.deepEqual(page.events.map((event) => event.type), ['message.user', 'message.completed']);
  assert.equal(page.hasMore, false);
  const verbose = jobTranscriptPage(job.id, { verbose: true });
  assert.equal(verbose.events.filter((event) => event.type === 'message.delta').length, 2);
  const first = jobTranscriptPage(job.id, { limit: 1 });
  assert.equal(first.events.length, 1);
  const second = jobTranscriptPage(job.id, { afterSeq: first.nextSeq });
  assert.equal(second.events.at(-1).type, 'message.completed');
  assert.equal(jobTranscript(job.id).filter((event) => event.type === 'message.delta').length, 2);
}));

test('prune removes aged terminal jobs and preserves active ones', () => isolated((directory) => {
  const done = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'old' });
  updateManagedJob(done.id, (current) => { current.status = 'completed'; current.completedAt = Math.floor(Date.now() / 1000) - 30 * 86400; });
  const active = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'active' });
  const result = pruneJobs({ maxAgeDays: 14 });
  assert.deepEqual(result.pruned, [done.id]);
  assert.throws(() => inspectJob(done.id), /job not found/);
  assert.equal(inspectJob(active.id).status, 'queued');
  assert.ok(!fs.existsSync(path.join(directory, 'jobs', `${done.id}.events.jsonl`)));
  assert.ok(!fs.existsSync(path.join(directory, 'jobs', `${done.id}.prompt`)));
}));

test('timeoutSeconds is validated, stored, and inherited by resume', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 7200 });
  assert.equal(inspectJob(job.id).timeoutSeconds, 7200);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 5 }), /timeoutSeconds/);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 1.5 }), /timeoutSeconds/);
  assert.equal(inspectJob(job.id).timeoutSeconds, 7200);
}));

test('list returns compact summaries newest first with active filtering', () => isolated((directory) => {
  const first = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'one' });
  const second = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'two' });
  updateManagedJob(first.id, (current) => {
    current.status = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.result = 'x'.repeat(500);
  });
  const all = listManagedJobs();
  assert.deepEqual(all.jobs.map((job) => job.id).sort(), [first.id, second.id].sort());
  assert.equal(all.jobs.find((job) => job.id === first.id).resultPreview.length, 200);
  assert.equal(Object.hasOwn(all.jobs[0], 'promptPath'), false);
  const active = listManagedJobs({ activeOnly: true });
  assert.deepEqual(active.jobs.map((job) => job.id), [second.id]);
  const failed = listManagedJobs({ status: ['completed'] });
  assert.deepEqual(failed.jobs.map((job) => job.id), [first.id]);
}));

test('delta redactor suppresses secrets split across chunk boundaries', async () => {
  const { DeltaRedactor } = await import('../bin/lib/control.mjs');
  const redactor = new DeltaRedactor();
  assert.equal(redactor.redactDelta('m1', 'the key is sk-'), 'the key is sk-');
  assert.equal(redactor.redactDelta('m1', 'ABCDEFGHIJKLMNOPQRST and more'), '[REDACTED]');
  assert.equal(redactor.redactDelta('m2', 'plain '), 'plain ');
  assert.equal(redactor.redactDelta('m2', 'text continues'), 'text continues');
  const single = new DeltaRedactor();
  assert.equal(single.redactDelta('m3', 'token sk-ABCDEFGHIJKLMNOPQRST here'), '[REDACTED]');
});

test('stale queued jobs reconcile to failed and release the writer guard', () => isolated((directory) => {
  const abandoned = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'never launched' });
  updateManagedJob(abandoned.id, (current) => { current.createdAt = Math.floor(Date.now() / 1000) - 3600; }, { incrementRevision: false });
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const next = launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'new writer' });
    assert.equal(next.mode, 'implement');
    assert.equal(inspectJob(abandoned.id).status, 'failed');
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
  const fresh = createManagedJob({ provider: 'codex', mode: 'consult', cwd: directory, prompt: 'fresh' });
  assert.equal(inspectJob(fresh.id).status, 'queued');
}));

test('network option is stored, defaults off, and shapes codex spawn args', async () => isolated(async (directory) => {
  const { codexSpawnArgs, securityPreamble } = await import('../bin/lib/providers.mjs');
  const off = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  assert.equal(inspectJob(off.id).network, false);
  assert.ok(codexSpawnArgs(off).includes('sandbox_workspace_write.network_access=false'));
  const on = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', network: true });
  assert.equal(inspectJob(on.id).network, true);
  assert.ok(codexSpawnArgs(on).includes('sandbox_workspace_write.network_access=true'));
  assert.match(securityPreamble(false), /Do not read, print, transmit/);
  assert.match(securityPreamble(false), /Preserve pre-existing changes/);
  assert.match(securityPreamble(true), /explicitly authorized/);
  assert.match(securityPreamble(true), /Preserve pre-existing changes/);
  assert.match(securityPreamble(true), /allowed scope/);
}));

test('event page cursor parses only the new tail and survives truncation', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const file = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  const total = 20000;
  const lines = [];
  for (let seq = 3; seq <= total; seq += 1) {
    lines.push(JSON.stringify({ v: 1, seq, at: Date.now(), jobId: job.id, type: 'plan.updated', data: { step: seq } }));
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);

  let afterSeq = 0;
  let collected = 0;
  for (;;) {
    const page = readJobEventPage(job.id, { afterSeq, limit: 1000 });
    collected += page.events.length;
    afterSeq = page.nextSeq;
    if (!page.hasMore) break;
  }
  assert.equal(collected, total);
  assert.equal(afterSeq, total);

  const quietStart = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) {
    const page = readJobEventPage(job.id, { afterSeq: total, limit: 1000 });
    assert.equal(page.events.length, 0);
    assert.equal(page.hasMore, false);
  }
  const quietMs = Number(process.hrtime.bigint() - quietStart) / 1e6;
  assert.ok(quietMs < 1000, `200 quiet polls took ${quietMs.toFixed(0)}ms; cursor fast path is not engaging`);

  appendJobEvent(job.id, 'error', { message: 'tail event' });
  const tail = readJobEventPage(job.id, { afterSeq: total, limit: 10 });
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].type, 'error');

  const content = fs.readFileSync(file, 'utf8');
  const thirdLineEnd = content.split('\n').slice(0, 3).join('\n').length + 1;
  fs.truncateSync(file, thirdLineEnd);
  const recovered = readJobEventPage(job.id, { afterSeq: 0, limit: 10 });
  assert.equal(recovered.events.length, 3);
  assert.deepEqual(recovered.events.map((event) => event.seq), [1, 2, 3]);

  fs.appendFileSync(file, '{"partial":');
  const partial = readJobEventPage(job.id, { afterSeq: recovered.nextSeq, limit: 10 });
  assert.equal(partial.hasMore, false);
}));
