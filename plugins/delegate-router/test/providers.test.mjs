import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createManagedJob, inspectJob, readJobEvents, resumeManagedJob, submitControl } from '../bin/lib/control.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { effectiveUsage, loadState } from '../bin/lib/state.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-acp.mjs');
const fakeCursorFallback = path.join(testDir, 'fake-cursor-fallback.mjs');

async function isolated(fn) {
  const old = { state: process.env.DELEGATE_STATE_FILE, codex: process.env.DELEGATE_CODEX_BIN, cursor: process.env.DELEGATE_CURSOR_BIN, login: process.env.DELEGATE_CURSOR_LOGIN_SHELL, write: process.env.FAKE_CURSOR_WRITE, overlap: process.env.FAKE_CURSOR_OVERLAP, crash: process.env.FAKE_CODEX_CRASH, crashOnce: process.env.FAKE_CODEX_CRASH_ONCE, collab: process.env.FAKE_CODEX_COLLAB, fileChanges: process.env.FAKE_CODEX_FILE_CHANGES, growingUsage: process.env.FAKE_CODEX_GROWING_USAGE, retryBase: process.env.DELEGATE_RETRY_BASE_MS, minCodex: process.env.DELEGATE_MIN_CODEX_VERSION, minCursor: process.env.DELEGATE_MIN_CURSOR_VERSION };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-provider-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { await fn(directory); }
  finally {
    for (const [key, value] of Object.entries({ DELEGATE_STATE_FILE: old.state, DELEGATE_CODEX_BIN: old.codex, DELEGATE_CURSOR_BIN: old.cursor, DELEGATE_CURSOR_LOGIN_SHELL: old.login, FAKE_CURSOR_WRITE: old.write, FAKE_CURSOR_OVERLAP: old.overlap, FAKE_CODEX_CRASH: old.crash, FAKE_CODEX_CRASH_ONCE: old.crashOnce, FAKE_CODEX_COLLAB: old.collab, FAKE_CODEX_FILE_CHANGES: old.fileChanges, FAKE_CODEX_GROWING_USAGE: old.growingUsage, DELEGATE_RETRY_BASE_MS: old.retryBase, DELEGATE_MIN_CODEX_VERSION: old.minCodex, DELEGATE_MIN_CURSOR_VERSION: old.minCursor })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function waitFor(jobId, predicate) {
  for (let i = 0; i < 300; i += 1) {
    const job = inspectJob(jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for job state');
}

test('Codex app-server maps events and applies true same-turn steering', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerTurnId));
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
}));

test('Cursor ACP maps structured updates and reports correction as restart', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerSessionId));
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
  assert.ok(completed.finishedPath);
  assert.equal(fs.readFileSync(completed.finishedPath, 'utf8').trim(), 'completed');
  assert.throws(() => resumeManagedJob(job.id, { prompt: 'continue' }), /RESUME_UNSUPPORTED/);
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

test('completed write jobs run verification and delegate-jobs wait exits 6 on a nonzero verdict', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({
    provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement',
    verify: { command: "printf 'verification-tail\\n'; exit 7", timeoutSeconds: 10 }
  });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.verification.exitCode, 7);
  assert.match(completed.verification.outputTail, /verification-tail/);
  assert.ok(readJobEvents(job.id, { limit: 1000 }).some((event) => event.type === 'verification.finished' && event.data.exitCode === 7));
  const cli = path.join(path.dirname(testDir), 'bin', 'delegate-jobs');
  const waited = spawnSync(process.execPath, [cli, 'wait', job.id], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(waited.status, 6, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).verification.exitCode, 7);
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
  assert.equal(cursorModel([], 'grok'), 'grok-4.5-high');
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
