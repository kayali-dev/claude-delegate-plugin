import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brokerError, normalizeBrokerError } from '../bin/lib/errors.mjs';
import {
  appendJobEvent,
  createManagedJob,
  inspectJob,
  jobDiff,
  jobFiles,
  jobTranscript,
  jobTranscriptPage,
  jobUsage,
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
import { filterDiffPaths, pathMatchesScope, validatedAllowedPaths } from '../bin/lib/control.mjs';
import { auditLogPath, loadState, saveState, setWindow } from '../bin/lib/state.mjs';

async function isolated(fn) {
  const previous = process.env.DELEGATE_STATE_FILE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { return await fn(directory); }
  finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  }
}

test('managed jobs persist ordered redacted events and derived views', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review public code' });
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

test('outbound prompt scan blocks credentials unless allowSensitive explicitly overrides', () => isolated((directory) => {
  try {
    createManagedJob({ provider: 'codex', cwd: directory, prompt: 'use token sk-12345678901234567890' });
    assert.fail('expected SECRET_IN_PROMPT');
  } catch (error) {
    assert.equal(error.code, 'SECRET_IN_PROMPT');
    assert.equal(error.retryable, false);
    assert.equal(error.provider, 'codex');
  }
  const allowed = createManagedJob({
    provider: 'codex',
    cwd: directory,
    prompt: 'use token sk-12345678901234567890',
    allowSensitive: true
  });
  const events = readJobEvents(allowed.id);
  assert.ok(events.some((event) => event.type === 'security.warning' && event.data.code === 'SECRET_IN_PROMPT'));
  assert.doesNotMatch(JSON.stringify(events), /sk-12345678901234567890/);
}));

test('idempotency replays return the same job id without launching another record', () => isolated((directory) => {
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const options = {
      provider: 'codex',
      mode: 'implement',
      cwd: directory,
      prompt: 'implement once',
      idempotencyKey: 'coordinator-wave-1'
    };
    const first = launchManagedJob(options);
    const replay = launchManagedJob(options);
    assert.equal(replay.id, first.id);
    assert.equal(replay.idempotencyKey, options.idempotencyKey);
    assert.equal(listManagedJobs().jobs.filter((job) => job.cwd === directory).length, 1);
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
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

test('inspect leaves a partial journal tail byte-for-byte unchanged', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const file = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  const expectedAt = readJobEvents(job.id).at(-1).at;
  fs.appendFileSync(file, '{"truncated":');
  const before = fs.readFileSync(file);
  const beforeSize = fs.statSync(file).size;
  assert.equal(inspectJob(job.id).lastActivityAt, expectedAt);
  assert.equal(fs.statSync(file).size, beforeSize);
  assert.deepEqual(fs.readFileSync(file), before);
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

test('broker error taxonomy carries closed codes, retryability, and provider attribution', () => {
  const invalid = brokerError('INVALID_MODEL', 'missing model', { provider: 'cursor' });
  assert.deepEqual({ code: invalid.code, retryable: invalid.retryable, provider: invalid.provider }, {
    code: 'INVALID_MODEL', retryable: false, provider: 'cursor'
  });
  const transport = normalizeBrokerError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), { provider: 'codex' });
  assert.deepEqual({ code: transport.code, retryable: transport.retryable, provider: transport.provider }, {
    code: 'TRANSPORT_ERROR', retryable: true, provider: 'codex'
  });
  for (const code of ['USER_INPUT_REQUIRED', 'BUDGET_EXCEEDED', 'QUOTA_GUARD', 'ACP_TIER_UNAVAILABLE']) {
    assert.equal(brokerError(code, 'same request cannot succeed').retryable, false, code);
  }
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

test('inspect and list expose journal-tail activity and flag stalled running jobs', () => isolated((directory) => {
  const previous = process.env.DELEGATE_STALL_SECONDS;
  process.env.DELEGATE_STALL_SECONDS = '1';
  try {
    const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
    updateManagedJob(job.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
    const file = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
    const oldAt = Date.now() - 5000;
    const oldEvents = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => ({ ...JSON.parse(line), at: oldAt }));
    fs.writeFileSync(file, `${oldEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const stalled = inspectJob(job.id);
    assert.equal(stalled.lastActivityAt, oldAt);
    assert.equal(stalled.stalled, true);
    assert.equal(listManagedJobs().jobs.find((row) => row.id === job.id).stalled, true);
    const fresh = appendJobEvent(job.id, 'plan.updated', { plan: ['continue'] });
    const active = inspectJob(job.id);
    assert.equal(active.lastActivityAt, fresh.at);
    assert.equal(active.stalled, false);
  } finally {
    if (previous == null) delete process.env.DELEGATE_STALL_SECONDS;
    else process.env.DELEGATE_STALL_SECONDS = previous;
  }
}));

test('write-mode launches are blocked while another writer is active in the same cwd', () => isolated((directory) => {
  const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'first writer' });
  updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
  try {
    launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'second writer' });
    assert.fail('expected WRITER_ACTIVE');
  } catch (error) {
    assert.equal(error.code, 'WRITER_ACTIVE');
    assert.equal(error.retryable, true);
    assert.equal(error.provider, 'codex');
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
    assert.equal(error.retryable, true);
    assert.equal(error.provider, 'codex');
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

test('terminal audit log is one-line-per-transition, redacted, private, and never pruned', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => {
    current.status = 'failed';
    current.phase = 'failed';
    current.completedAt = Math.floor(Date.now() / 1000) - 30 * 86400;
    current.error = 'PASSWORD=synthetic-audit-secret';
    current.errorCode = 'PROVIDER_ERROR';
    current.changedFiles = { count: 2, files: ['a.js', 'b.js'] };
    current.scopeViolations = [{ path: 'b.js' }];
    current.usage = { inputTokens: 5, outputTokens: 3 };
  });
  updateManagedJob(job.id, (current) => { current.phase = 'failed'; });
  const file = auditLogPath();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.jobId, job.id);
  assert.equal(record.provider, 'codex');
  assert.equal(record.changedFilesCount, 2);
  assert.equal(record.scopeViolationsCount, 1);
  assert.equal(record.outcome.status, 'failed');
  assert.doesNotMatch(lines[0], /synthetic-audit-secret/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  pruneJobs({ maxAgeDays: 14 });
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
}));

test('timeoutSeconds is validated, stored, and inherited by resume', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 7200, maxOutputTokens: 5000 });
  assert.equal(inspectJob(job.id).timeoutSeconds, 7200);
  assert.equal(inspectJob(job.id).maxOutputTokens, 5000);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 5 }), /timeoutSeconds/);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 1.5 }), /timeoutSeconds/);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', maxOutputTokens: 0 }), /maxOutputTokens/);
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
  assert.match(securityPreamble(false), /tooling that consumes them internally .* is allowed/);
  assert.match(securityPreamble(false), /Preserve pre-existing changes/);
  assert.match(securityPreamble(true), /explicitly authorized/);
  assert.match(securityPreamble(true), /Preserve pre-existing changes/);
  assert.match(securityPreamble(true), /allowed scope/);
}));

test('GPT models are refused on cursor while codex is enabled and under its avoid band', () => isolated((directory) => {
  // Codex enabled, usage unknown (not exhausted): the native lane is available.
  assert.throws(
    () => launchManagedJob({ provider: 'cursor', model: 'gpt-5.6-sol-xhigh', mode: 'review', cwd: directory, prompt: 'review' }),
    /WRONG_LANE/
  );
  // Explicit user request bypasses the lane guard.
  process.env.DELEGATE_CURSOR_BIN = '/usr/bin/false';
  try {
    const overridden = launchManagedJob({ provider: 'cursor', model: 'gpt-5.6-sol-xhigh', mode: 'review', cwd: directory, prompt: 'review', overrideLane: true });
    assert.equal(overridden.provider, 'cursor');
    // Codex at its avoid band frees the cursor lane without an override.
    const state = loadState();
    setWindow(state, 'codex', 'primary', 95, { resetsAt: Math.floor(Date.now() / 1000) + 3600, source: 'test' });
    saveState(state);
    const fallback = launchManagedJob({ provider: 'cursor', model: 'gpt-5.6-terra', mode: 'review', cwd: directory, prompt: 'review' });
    assert.equal(fallback.provider, 'cursor');
  } finally {
    delete process.env.DELEGATE_CURSOR_BIN;
  }
}));

test('scope matching, allowedPaths validation, and diff path filtering', () => {
  assert.equal(pathMatchesScope('src/app/page.tsx', ['src/app']), true);
  assert.equal(pathMatchesScope('src/app.ts', ['src/app']), false);
  assert.equal(pathMatchesScope('docs/notes.md', ['docs/notes.md']), true);
  assert.equal(pathMatchesScope('packages/ai/test/x.test.mjs', ['packages/*/test']), true);
  assert.equal(pathMatchesScope('anything/else.js', ['src']), false);
  assert.deepEqual(validatedAllowedPaths(['./src/', 'docs']), ['src', 'docs']);
  assert.throws(() => validatedAllowedPaths(['../escape']), /repo-relative/);
  assert.throws(() => validatedAllowedPaths([]), /non-empty/);
  const diff = 'diff --git a/src/a.js b/src/a.js\n+one\ndiff --git a/docs/b.md b/docs/b.md\n+two\n';
  assert.match(filterDiffPaths(diff, ['src']), /src\/a\.js/);
  assert.doesNotMatch(filterDiffPaths(diff, ['src']), /docs\/b\.md/);
  assert.equal(filterDiffPaths(diff, null), diff);
});

test('jobFiles dedupes absolute and relative reports of the same file', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  appendJobEvent(job.id, 'file.changed', { path: path.join(directory, 'src/demo.html') });
  appendJobEvent(job.id, 'file.changed', { path: 'src/demo.html', status: 'M ' });
  const files = jobFiles(job.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/demo.html');
  assert.equal(files[0].status, 'M ');
}));

test('list rows carry session and rootJobId for resume chains', () => isolated((directory) => {
  const root = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'root' });
  updateManagedJob(root.id, (current) => { current.providerSessionId = 'thread-chain'; });
  const child = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'child', parentJobId: root.id, providerSessionId: 'thread-chain' });
  const grandchild = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'grandchild', parentJobId: child.id, providerSessionId: 'thread-chain' });
  const rows = listManagedJobs({ limit: 10 }).jobs;
  const row = rows.find((item) => item.id === grandchild.id);
  assert.equal(row.rootJobId, root.id);
  assert.equal(row.session, 'thread-chain');
  assert.equal(rows.find((item) => item.id === root.id).rootJobId, undefined);
}));

test('sandbox off is validated, stored, and maps to full access across providers', async () => isolated(async (directory) => {
  const { codexSandboxMode, codexSpawnArgs } = await import('../bin/lib/providers.mjs');
  const defaulted = createManagedJob({ provider: 'codex', mode: 'review', cwd: directory, prompt: 'task' });
  assert.equal(inspectJob(defaulted.id).sandbox, null);
  assert.equal(codexSandboxMode(defaulted), 'read-only');
  assert.equal(codexSandboxMode({ ...defaulted, mode: 'implement' }), 'workspace-write');
  assert.ok(codexSpawnArgs(defaulted).includes('tools.web_search=false'));
  const off = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task', sandbox: 'off' });
  assert.equal(inspectJob(off.id).sandbox, 'off');
  assert.equal(codexSandboxMode(off), 'danger-full-access');
  assert.ok(codexSpawnArgs(off).includes('tools.web_search=true'));
  const events = readJobEvents(off.id, { limit: 10 });
  assert.equal(events.find((event) => event.type === 'job.created').data.sandbox, 'off');
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', sandbox: 'yolo' }), /sandbox must be/);
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

test('effort is validated against the known reasoning ladder', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', effort: 'xhigh' });
  assert.equal(inspectJob(job.id).effort, 'xhigh');
  const unset = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  assert.equal(inspectJob(unset.id).effort, null);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', effort: 'turbo' }), /effort must be one of/);
}));

test('cursor same-turn steering is rejected at the control boundary', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const revision = inspectJob(job.id).revision;
  assert.throws(
    () => submitControl(job.id, { type: 'steer', correctionId: 'st', strategy: 'same-turn', text: 'change' }, revision),
    /UNSUPPORTED_STRATEGY/
  );
  const auto = submitControl(job.id, { type: 'steer', correctionId: 'st2', strategy: 'auto', text: 'change' }, revision);
  assert.equal(auto.accepted, true);
}));

test('list previews object results and exposes provenance fields', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.result = { text: 'the final answer text', stopReason: 'end_turn' };
    current.resolvedModel = 'composer-2.5';
    current.changedFiles = { count: 2, files: ['a.js', 'b.js'] };
  });
  const listed = listManagedJobs().jobs.find((item) => item.id === job.id);
  assert.equal(listed.resultPreview, 'the final answer text');
  assert.equal(listed.resolvedModel, 'composer-2.5');
  assert.equal(listed.changedFiles.count, 2);
}));

test('diff stat and windowing bound large diffs', async () => {
  const { diffStat, sliceDiff } = await import('../bin/lib/control.mjs');
  const diff = [
    'diff --git a/src/one.js b/src/one.js',
    '--- a/src/one.js', '+++ b/src/one.js',
    '+added line', '+another added', '-removed line',
    'diff --git a/src/two.js b/src/two.js',
    '--- a/src/two.js', '+++ b/src/two.js',
    '+only addition'
  ].join('\n');
  const stat = diffStat(diff);
  assert.equal(stat.totalFiles, 2);
  assert.deepEqual(stat.files[0], { path: 'src/one.js', additions: 2, deletions: 1 });
  assert.equal(stat.totalAdditions, 3);
  const first = sliceDiff(diff, { offset: 0, maxChars: 1000 });
  assert.equal(first.nextOffset, null);
  assert.equal(first.totalChars, diff.length);
  const window = sliceDiff('x'.repeat(5000), { offset: 0, maxChars: 1000 });
  assert.equal(window.diff.length, 1000);
  assert.equal(window.nextOffset, 1000);
  const next = sliceDiff('x'.repeat(5000), { offset: 4500, maxChars: 1000 });
  assert.equal(next.diff.length, 500);
  assert.equal(next.nextOffset, null);
});

test('event responses are capped by serialized size, preserving the cursor', async () => {
  const { capEventsBySize } = await import('../bin/lib/control.mjs');
  const big = (seq) => ({ seq, type: 'tool.output', data: { delta: 'y'.repeat(30000) } });
  const page = { events: [big(1), big(2), big(3)], nextSeq: 3, latestSeq: 3, hasMore: false };
  const capped = capEventsBySize(page, 65000);
  assert.equal(capped.events.length, 2);
  assert.equal(capped.nextSeq, 2);
  assert.equal(capped.hasMore, true);
  assert.equal(capped.truncated, 'response-size');
  const small = { events: [{ seq: 1, type: 'x', data: {} }], nextSeq: 1, latestSeq: 1, hasMore: false };
  assert.equal(capEventsBySize(small, 65000), small);
});

test('usage reports distinguish missing provider data from zero', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', cwd: directory, prompt: 'task' });
  const usage = jobUsage(job.id);
  assert.equal(usage.observedAvailable, false);
  assert.match(usage.note, /did not emit usage/);
}));

test('usage reports chain-cumulative totals through the current continuation', () => isolated((directory) => {
  const root = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'root' });
  appendJobEvent(root.id, 'usage.updated', { total: { inputTokens: 10, outputTokens: 4 } });
  const child = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'child', parentJobId: root.id });
  appendJobEvent(child.id, 'usage.updated', { inputTokens: 6, outputTokens: 3 });
  const usage = jobUsage(child.id);
  assert.deepEqual(usage.chainCumulative.jobIds, [root.id, child.id]);
  assert.equal(usage.chainCumulative.rootJobId, root.id);
  assert.equal(usage.chainCumulative.inputTokens, 16);
  assert.equal(usage.chainCumulative.outputTokens, 7);
  assert.equal(usage.chainCumulative.totalTokens, 23);
}));
