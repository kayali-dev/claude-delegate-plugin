import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createManagedJob,
  groupSummary,
  inspectJob,
  listManagedJobs,
  readJobEvents,
  submitControl,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { routeTask } from '../bin/lib/router.mjs';
import { aggregateAuditStats, auditUsageBands, usageBandKey } from '../bin/lib/stats.mjs';
import { loadProfile } from '../bin/lib/profiles.mjs';
import { loadJob } from '../bin/lib/state.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(testDir);
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-acp.mjs');

async function isolated(fn) {
  const names = [
    'DELEGATE_STATE_FILE', 'DELEGATE_PROFILES_DIR', 'DELEGATE_CODEX_BIN', 'DELEGATE_CURSOR_BIN',
    'DELEGATE_CURSOR_LOGIN_SHELL', 'DELEGATE_ENABLED_PROVIDERS', 'DELEGATE_MAX_CHANGED_FILES',
    'FAKE_CODEX_CRASH', 'FAKE_CODEX_NUDGE', 'FAKE_CODEX_REPLY', 'FAKE_CODEX_FILE_CHANGES', 'FAKE_CURSOR_INGEST'
  ];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-wave3-'));
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

async function waitFor(jobId, predicate) {
  for (let index = 0; index < 500; index += 1) {
    const job = inspectJob(jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for job state');
}

test('stats aggregate synthetic audit records and the CLI reads audit.jsonl', () => isolated(({ root }) => {
  const now = Date.now();
  const records = [
    { at: now - 1000, provider: 'codex', model: 'sol', mode: 'review', effort: 'xhigh', scopeViolationsCount: 0, outcome: { status: 'completed' }, usage: { total: { outputTokens: 100 } }, durationMs: 1000 },
    { at: now - 2000, provider: 'codex', model: 'sol', mode: 'review', effort: 'xhigh', parentJobId: 'root', rootJobId: 'root', nudgeCount: 1, scopeViolationsCount: 1, outcome: { status: 'completed' }, verification: { exitCode: 0 }, usage: { total: { outputTokens: 300 } }, durationMs: 3000 },
    { at: now - 10 * 86400000, provider: 'cursor', model: 'grok', mode: 'consult', effort: 'high', scopeViolationsCount: 0, outcome: { status: 'failed', errorCode: 'TIMEOUT' }, durationMs: 5000 }
  ];
  const stats = aggregateAuditStats(records, { since: '7d', now });
  assert.equal(stats.jobs, 2);
  assert.equal(stats.groups[0].jobs, 2);
  assert.equal(stats.groups[0].successes, 1);
  assert.equal(stats.groups[0].successRate, 0.5);
  assert.equal(stats.groups[0].resumeChains, 1);
  assert.equal(stats.groups[0].medianDurationMs, 1000);
  assert.equal(stats.groups[0].meanOutputTokens, 200);
  assert.equal(stats.groups[0].violationCount, 1);

  const audit = path.join(root, 'state', 'audit.jsonl');
  fs.mkdirSync(path.dirname(audit), { recursive: true });
  fs.writeFileSync(audit, `${records.map(JSON.stringify).join('\n')}\n`);
  const cli = spawnSync(process.execPath, [path.join(pluginRoot, 'bin', 'delegate-jobs'), 'stats', '--since', '7d', '--json'], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).jobs, 2);
}));

test('route candidates gain advisory usage bands without changing selection', () => {
  const records = [100, 200, 900].map((outputTokens) => ({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', usage: { total: { outputTokens } } }));
  const costBands = auditUsageBands(records);
  assert.deepEqual(costBands[usageBandKey('codex', 'sol', 'xhigh')], { p50OutputTokens: 200, p90OutputTokens: 900, samples: 3 });
  const route = routeTask({
    task: 'Review the security boundaries', mode: 'review', effort: 'xhigh', costBands,
    usage: { claude: { known: false }, codex: { known: false }, cursor: { known: false } },
    availability: { claude: true, codex: true, cursor: true }
  });
  assert.equal(route.primary.model, 'sol');
  assert.equal(route.primary.usageBand.samples, 3);
});

test('profiles merge defaults, explicit options win, lint warns, and bundled fallback loads', () => isolated(({ root, cwd }) => {
  const profiles = path.join(root, 'profiles');
  fs.mkdirSync(profiles);
  fs.writeFileSync(path.join(profiles, 'custom.md'), `---\nmode: review\nmodel: sol\neffort: high\nallowedPaths: src,test\n---\n# Objective\n{{objective}}\n\n# Allowed scope\nNamed scope.\n\n# Acceptance criteria\nEvidence.\n\n# Return\nInline.\n`);
  process.env.DELEGATE_PROFILES_DIR = profiles;
  const job = createManagedJob({ provider: 'codex', profile: 'custom', prompt: 'Check the parser', cwd, mode: 'consult', effort: 'low', allowedPaths: ['docs'] });
  const stored = loadJob(job.id);
  assert.equal(stored.mode, 'consult');
  assert.equal(stored.effort, 'low');
  assert.deepEqual(stored.allowedPaths, ['docs']);
  assert.match(fs.readFileSync(stored.promptPath, 'utf8'), /Check the parser/);

  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  try { createManagedJob({ provider: 'codex', prompt: 'bare objective', cwd }); }
  finally { console.error = originalError; }
  assert.match(warnings.join('\n'), /Objective.*Allowed scope.*Acceptance criteria.*Return/);

  const fallback = loadProfile('independent-review');
  assert.equal(fallback.local, false);
  const fallbackJob = createManagedJob({ provider: 'codex', profile: 'independent-review', prompt: 'Review this diff', cwd });
  assert.equal(fallbackJob.mode, 'review');
  assert.equal(fallbackJob.model, 'sol');
}));

test('fan-out groups filter list rows and summarize terminal state', () => isolated(({ cwd }) => {
  const first = createManagedJob({ provider: 'codex', cwd, prompt: 'first', groupId: 'review-set' });
  const second = createManagedJob({ provider: 'cursor', cwd, prompt: 'second', groupId: 'review-set' });
  updateManagedJob(first.id, (job) => { job.status = 'completed'; job.phase = 'completed'; job.completedAt = Math.floor(Date.now() / 1000); });
  assert.deepEqual(listManagedJobs({ groupId: 'review-set' }).jobs.map((job) => job.groupId), ['review-set', 'review-set']);
  assert.deepEqual(groupSummary('review-set'), { groupId: 'review-set', total: 2, running: 1, completed: 1, failed: 0, cancelled: 0, allTerminal: false });
  updateManagedJob(second.id, (job) => { job.status = 'cancelled'; job.phase = 'cancelled'; job.completedAt = Math.floor(Date.now() / 1000); });
  assert.equal(groupSummary('review-set').allTerminal, true);
}));

test('startPaused establishes a session, holds, releases, and supports cancel while paused', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const releasedJob = createManagedJob({ provider: 'codex', cwd, prompt: 'run after release', startPaused: true });
  const releasedRun = runManagedProvider(releasedJob);
  const paused = await waitFor(releasedJob.id, (job) => job.phase === 'paused');
  assert.ok(paused.providerSessionId);
  assert.equal(readJobEvents(releasedJob.id, { limit: 1000 }).some((event) => event.type === 'turn.started'), false);
  submitControl(releasedJob.id, { type: 'release', commandId: 'release-one' }, paused.revision);
  await releasedRun;
  assert.equal(inspectJob(releasedJob.id).status, 'completed');

  const cancelledJob = createManagedJob({ provider: 'codex', cwd, prompt: 'never run', startPaused: true });
  const cancelledRun = runManagedProvider(cancelledJob);
  const pausedAgain = await waitFor(cancelledJob.id, (job) => job.phase === 'paused');
  submitControl(cancelledJob.id, { type: 'cancel', commandId: 'cancel-paused' }, pausedAgain.revision);
  await cancelledRun;
  const cancelled = inspectJob(cancelledJob.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(readJobEvents(cancelledJob.id, { limit: 1000 }).some((event) => event.type === 'turn.started'), false);
}));

test('ingestFiles copies in, copies changed content back, and leaves failed staging in the checkpoint', () => isolated(async ({ root, cwd }) => {
  fs.chmodSync(fakeCursor, 0o755);
  spawnSync('git', ['init', '-q'], { cwd });
  const source = path.join(root, 'outside.txt');
  fs.writeFileSync(source, 'original\n');
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  process.env.FAKE_CURSOR_INGEST = '1';
  const success = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd, prompt: 'edit the staged input', ingestFiles: [source], allowedPaths: ['src'] });
  assert.ok(success.allowedPaths.some((entry) => entry.startsWith('.delegate-staging/')));
  await runManagedProvider(success);
  const completed = inspectJob(success.id);
  assert.match(fs.readFileSync(source, 'utf8'), /changed by provider/);
  assert.equal(fs.existsSync(path.join(cwd, completed.stagingDir)), false);
  assert.equal(completed.ingestCompletion.copiedBack.length, 1);

  delete process.env.FAKE_CURSOR_INGEST;
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_CRASH = '1';
  const failedSource = path.join(root, 'failed.txt');
  fs.writeFileSync(failedSource, 'keep staged\n');
  const failedJob = createManagedJob({ provider: 'codex', mode: 'implement', cwd, prompt: 'crash', ingestFiles: [failedSource] });
  await assert.rejects(runManagedProvider(failedJob));
  const failed = inspectJob(failedJob.id);
  assert.equal(failed.status, 'failed');
  assert.equal(fs.existsSync(path.join(cwd, failed.stagingDir)), true);
  assert.equal(failed.checkpoint.stagingDir, failed.stagingDir);
}));

test('autoNudge runs once in the same session and preserves firstAttemptText', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_NUDGE = '1';
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd, prompt: 'return complete findings', autoNudge: true });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.nudgeCount, 1);
  assert.match(completed.result.firstAttemptText, /prepared/);
  assert.match(completed.result.text, /Complete findings inline/);
  assert.equal(readJobEvents(job.id, { limit: 1000 }).filter((event) => event.type === 'job.nudge').length, 1);
}));

test('delegate-health --deep records a non-throwing live probe shape', () => isolated(({ root }) => {
  const stateFile = path.join(root, 'health-state', 'usage.json');
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'bin', 'delegate-health'), '--quick', '--deep', '--json'], {
    cwd: pluginRoot,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      DELEGATE_STATE_FILE: stateFile,
      DELEGATE_ENABLED_PROVIDERS: 'codex',
      DELEGATE_CODEX_BIN: fakeCodex,
      FAKE_CODEX_REPLY: 'ok'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deepAllowanceSpend, true);
  assert.equal(report.lastVerified.length, 1);
  assert.deepEqual(Object.keys(report.lastVerified[0]).sort(), ['at', 'cliVersion', 'durationMs', 'ok', 'provider']);
  assert.equal(report.lastVerified[0].ok, true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastVerified.codex.ok, true);
}));

test('Codex live large-write breaker fails with LARGE_WRITE and a checkpoint', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.DELEGATE_MAX_CHANGED_FILES = '2';
  process.env.FAKE_CODEX_FILE_CHANGES = '4';
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd, prompt: 'many edits' });
  await assert.rejects(runManagedProvider(job), (error) => error.code === 'LARGE_WRITE');
  const failed = inspectJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'LARGE_WRITE');
  assert.equal(failed.errorRetryable, false);
  assert.equal(failed.checkpoint.failureReason, 'LARGE_WRITE');
  assert.ok(readJobEvents(job.id, { limit: 1000 }).some((event) => event.type === 'large.write' && event.data.enforcement === 'live-interrupt'));
}));

test('reportSchema parses the last JSON fence and flags missing structured output without failing', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_REPLY = 'Earlier\n```json\n{"objectiveMet":false}\n```\nFinal\n```json\n{"objectiveMet":"partial","findings":2}\n```';
  const schema = { type: 'object', required: ['objectiveMet'] };
  const parsedJob = createManagedJob({ provider: 'codex', mode: 'review', cwd, prompt: 'structured report', reportSchema: schema });
  await runManagedProvider(parsedJob);
  const parsed = inspectJob(parsedJob.id);
  assert.deepEqual(parsed.result.structured, { objectiveMet: 'partial', findings: 2 });
  assert.equal(parsed.objectiveMet, 'partial');
  assert.equal(parsed.structuredMissing, undefined);

  process.env.FAKE_CODEX_REPLY = 'No structured block here.';
  const missingJob = createManagedJob({ provider: 'codex', mode: 'review', cwd, prompt: 'structured report', reportSchema: schema });
  await runManagedProvider(missingJob);
  const missing = inspectJob(missingJob.id);
  assert.equal(missing.status, 'completed');
  assert.equal(missing.structuredMissing, true);
}));
