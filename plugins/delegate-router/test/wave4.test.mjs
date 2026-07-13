import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  backfillAuditLog,
  completeIngestedFiles,
  createManagedJob,
  inspectJob,
  launchManagedJob,
  readJobEvents,
  reviewRoundManagedJob,
  sliceResultText,
  submitControl,
  updateManagedJob,
  waitForJob,
  waitForSessionId
} from '../bin/lib/control.mjs';
import { assembleProviderPrompt } from '../bin/lib/packet.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { auditLogPath, listJobs, loadJob } from '../bin/lib/state.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(testDir);
const cli = path.join(pluginRoot, 'bin', 'delegate-jobs');
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');

async function isolated(fn) {
  const names = [
    'DELEGATE_STATE_FILE', 'DELEGATE_ENABLED_PROVIDERS', 'DELEGATE_CODEX_BIN',
    'DELEGATE_RETRY_BASE_MS', 'FAKE_CODEX_CRASH_ONCE', 'FAKE_CODEX_SPAWN_COUNT_FILE'
  ];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-wave4-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  try { return await fn({ root, cwd }); }
  finally {
    for (const name of names) {
      if (old[name] == null) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

async function waitUntil(jobId, predicate) {
  for (let index = 0; index < 300; index += 1) {
    const job = inspectJob(jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${jobId}`);
}

test('waitFor resolves turn and first-output milestones from the journal and times out boundedly', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;

  const turnJob = createManagedJob({ provider: 'codex', cwd, prompt: 'start a turn' });
  const turnRun = runManagedProvider(turnJob);
  await waitForJob(turnJob.id, 'turn', 2000);
  assert.ok(readJobEvents(turnJob.id, { limit: 1000 }).some((event) => event.type === 'turn.started'));
  await turnRun;

  const outputJob = createManagedJob({ provider: 'codex', cwd, prompt: 'produce output' });
  const outputRun = runManagedProvider(outputJob);
  await waitForJob(outputJob.id, 'first-output', 2000);
  assert.ok(readJobEvents(outputJob.id, { limit: 1000 }).some((event) => ['message.delta', 'message.completed', 'tool.started'].includes(event.type)));
  await outputRun;

  const quiet = createManagedJob({ provider: 'codex', cwd, prompt: 'remain queued' });
  const started = Date.now();
  const timedOut = await waitForJob(quiet.id, 'first-output', 20);
  assert.equal(timedOut.status, 'queued');
  assert.ok(Date.now() - started < 1000);

  updateManagedJob(quiet.id, (current) => { current.providerSessionId = 'compat-session'; }, { incrementRevision: false });
  assert.equal((await waitForSessionId(quiet.id, 100)).providerSessionId, 'compat-session');
}));

test('resultText windowing supports offset, find, absolute nextOffset, and CLI find misses', () => isolated(({ cwd }) => {
  const text = `${'a'.repeat(1200)}needle${'b'.repeat(1800)}`;
  const offset = sliceResultText(text, { offset: 1000, maxChars: 1000 });
  assert.equal(offset.offset, 1000);
  assert.equal(offset.resultText.length, 1000);
  assert.equal(offset.nextOffset, 2000);
  const found = sliceResultText(text, { find: 'needle', offset: 0, maxChars: 1000 });
  assert.equal(found.offset, 1200);
  assert.equal(found.resultText.startsWith('needle'), true);
  assert.equal(found.nextOffset, 2200);
  assert.throws(() => sliceResultText(text, { find: 'Needle' }), /does not contain: Needle/);

  const job = createManagedJob({ provider: 'codex', cwd, prompt: 'terminal result' });
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.resultText = text;
    current.result = text;
  });
  const windowed = spawnSync(process.execPath, [cli, 'result', job.id, '--find', 'needle', '--max-chars', '1000', '--json'], {
    encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(windowed.status, 0, windowed.stderr);
  assert.equal(JSON.parse(windowed.stdout).nextOffset, 2200);
  const missed = spawnSync(process.execPath, [cli, 'result', job.id, '--find', 'Needle'], {
    encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(missed.status, 1);
  assert.match(missed.stderr, /result text does not contain: Needle/);
}));

test('review-round resumes with diff stat, changed files, scope, and findings, and refuses active parents', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const parent = createManagedJob({ provider: 'codex', mode: 'review', cwd, prompt: 'first review', allowedPaths: ['src', 'test'] });
  appendJobEvent(parent.id, 'diff.updated', { diff: [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js', '+++ b/src/a.js',
    '+added', '-removed'
  ].join('\n') });
  updateManagedJob(parent.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.providerSessionId = 'thread-fake';
    current.changedFiles = { count: 1, files: ['src/a.js'], entries: [{ path: 'src/a.js' }] };
  });
  const child = reviewRoundManagedJob(parent.id, { prompt: 'Fix the missing boundary check.' });
  const packet = fs.readFileSync(loadJob(child.id).promptPath, 'utf8');
  assert.match(packet, new RegExp(`^Review round for job ${parent.id}\\.`));
  assert.match(packet, /\| src\/a\.js \| 1 \| 1 \|/);
  assert.match(packet, /Changed files:\n- src\/a\.js/);
  assert.match(packet, /Allowed paths:\n- src\n- test/);
  assert.match(packet, /Findings:\nFix the missing boundary check\./);
  await waitUntil(child.id, (job) => ['completed', 'failed'].includes(job.status));

  const beforeSecret = listJobs().length;
  assert.throws(() => reviewRoundManagedJob(parent.id, { prompt: 'API_KEY=abcdefghijklmnop' }), /looks like a credential/);
  assert.equal(listJobs().length, beforeSecret);

  const active = createManagedJob({ provider: 'codex', cwd, prompt: 'still active' });
  const before = listJobs().length;
  assert.throws(() => reviewRoundManagedJob(active.id, { prompt: 'findings' }), /only terminal jobs can be resumed/);
  assert.equal(listJobs().length, before);
}));

test('start dry-run creates no state or staging and shares byte-identical packet assembly with real starts', () => isolated(({ root, cwd }) => {
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'external input\n');
  const stagedPreview = launchManagedJob({
    provider: 'codex', cwd, prompt: 'preview ingest', mode: 'implement', allowedPaths: ['src'], ingestFiles: [outside], dryRun: true
  });
  assert.equal(stagedPreview.dryRun, true);
  assert.deepEqual(stagedPreview.ingestPlan.files.map((item) => item.source), [outside]);
  assert.equal(listJobs().length, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.delegate-staging')), false);

  const options = {
    provider: 'codex', cwd, prompt: 'Review the current parser.', profile: 'independent-review',
    allowedPaths: ['src'], reportSchema: { type: 'object', required: ['objectiveMet'] }
  };
  const preview = launchManagedJob({ ...options, dryRun: true });
  assert.equal(preview.mode, 'review');
  assert.equal(preview.model, 'sol');
  const real = createManagedJob(options);
  const stored = loadJob(real.id);
  const actualPacket = assembleProviderPrompt(stored, fs.readFileSync(stored.promptPath, 'utf8'));
  assert.equal(preview.packet, actualPacket);

  const cliPreview = spawnSync(process.execPath, [cli, 'start', '--provider', 'codex', '--cwd', cwd, '--prompt', 'CLI preview', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(cliPreview.status, 0, cliPreview.stderr);
  assert.equal(JSON.parse(cliPreview.stdout).dryRun, true);
  assert.equal(listJobs().length, 1);
}));

test('ingest copy-back preserves divergent sources, writes delegate-new, and still copies clean sources', () => isolated(({ root, cwd }) => {
  const divergentSource = path.join(root, 'divergent.txt');
  fs.writeFileSync(divergentSource, 'original\n');
  const divergentJob = createManagedJob({ provider: 'codex', cwd, prompt: 'edit ingest', mode: 'implement', ingestFiles: [divergentSource] });
  const divergentStored = loadJob(divergentJob.id);
  assert.ok(divergentStored.ingested[0].sourceHash);
  fs.appendFileSync(path.join(cwd, divergentStored.ingested[0].staged), 'provider edit\n');
  fs.writeFileSync(divergentSource, 'user edit\n');
  const divergent = completeIngestedFiles(divergentStored);
  assert.equal(fs.readFileSync(divergentSource, 'utf8'), 'user edit\n');
  assert.match(fs.readFileSync(`${divergentSource}.delegate-new`, 'utf8'), /provider edit/);
  assert.equal(divergent.diverged.length, 1);
  assert.ok(readJobEvents(divergentJob.id, { limit: 1000 }).some((event) => event.type === 'ingest.diverged'));

  const cleanSource = path.join(root, 'clean.txt');
  fs.writeFileSync(cleanSource, 'original\n');
  const cleanJob = createManagedJob({ provider: 'codex', cwd, prompt: 'edit clean ingest', mode: 'implement', ingestFiles: [cleanSource] });
  const cleanStored = loadJob(cleanJob.id);
  fs.appendFileSync(path.join(cwd, cleanStored.ingested[0].staged), 'provider edit\n');
  const clean = completeIngestedFiles(cleanStored);
  assert.match(fs.readFileSync(cleanSource, 'utf8'), /provider edit/);
  assert.equal(clean.copiedBack.length, 1);
  assert.equal(clean.diverged.length, 0);
}));

test('cancel and steer commands are settled during retry backoff without a second provider spawn', () => isolated(async ({ root, cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_CRASH_ONCE = '1';
  process.env.DELEGATE_RETRY_BASE_MS = '400';
  const spawnCount = path.join(root, 'spawn-count.txt');
  process.env.FAKE_CODEX_SPAWN_COUNT_FILE = spawnCount;
  const job = createManagedJob({
    provider: 'codex', cwd, prompt: 'retry then cancel',
    retryPolicy: { maxAttempts: 2, retryOn: ['transport'] }
  });
  const running = runManagedProvider(job);
  const retrying = await waitUntil(job.id, (current) => current.phase === 'retrying');
  submitControl(job.id, { type: 'steer', correctionId: 'between-attempts', text: 'change direction', strategy: 'auto' }, retrying.revision);
  const steered = inspectJob(job.id);
  submitControl(job.id, { type: 'cancel', commandId: 'cancel-backoff' }, steered.revision);
  await running;
  const cancelled = inspectJob(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.controls['cancel-backoff'].appliedAs, 'cancel-before-retry');
  assert.equal(cancelled.controls['between-attempts'].state, 'rejected');
  assert.match(cancelled.controls['between-attempts'].error, /between provider attempts/);
  assert.equal(Number(fs.readFileSync(spawnCount, 'utf8')), 1);
}));

test('audit backfill appends only missing terminal jobs and is idempotent', () => isolated(({ cwd }) => {
  const first = createManagedJob({ provider: 'codex', cwd, prompt: 'first terminal' });
  updateManagedJob(first.id, (current) => {
    current.status = 'completed'; current.phase = 'completed'; current.completedAt = Math.floor(Date.now() / 1000);
  });
  const second = createManagedJob({ provider: 'cursor', cwd, prompt: 'second terminal' });
  updateManagedJob(second.id, (current) => {
    current.status = 'failed'; current.phase = 'failed'; current.completedAt = Math.floor(Date.now() / 1000);
  });
  const audit = auditLogPath();
  const records = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  fs.writeFileSync(audit, `${JSON.stringify(records.find((record) => record.jobId === first.id))}\n`);

  const backfilled = spawnSync(process.execPath, [cli, 'audit', 'backfill', '--json'], {
    encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(backfilled.status, 0, backfilled.stderr);
  assert.deepEqual(JSON.parse(backfilled.stdout), { scanned: 2, backfilled: 1 });
  const after = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.length, 2);
  assert.equal(after.find((record) => record.jobId === second.id).backfilled, true);
  assert.deepEqual(backfillAuditLog(), { scanned: 2, backfilled: 0 });
  assert.equal(fs.readFileSync(audit, 'utf8').trim().split('\n').length, 2);
}));
