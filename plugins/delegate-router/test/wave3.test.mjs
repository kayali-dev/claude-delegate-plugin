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
import {
  aggregateAudit,
  aggregateAuditStats,
  aggregateAuditTotals,
  aggregateVisibilityStats,
  attributeAuditOutputTokens,
  auditUsageBands,
  outputTokens,
  recommendOutcomeRouting,
  usageBandKey
} from '../bin/lib/stats.mjs';
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
  assert.deepEqual(stats.groups[0].rates.providerCompletion, {
    numerator: 2,
    sampleSize: 2,
    minimumSample: 10,
    status: 'insufficient-data',
    rate: null
  });
  assert.equal(stats.groups[0].rates.verificationPass.sampleSize, 0, 'historical verification without real-tree origin is not relabelled');
  assert.equal(stats.groups[0].rates.ownerAcceptance.sampleSize, 0);
  assert.equal(Object.hasOwn(stats.groups[0], 'successRate'), false);
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

test('outcome ledger separates sampled rates, cohorts fixed-era failures, and since version/date views', () => {
  const rows = [];
  const add = (jobId, date, brokerVersion, status, extra = {}) => rows.push({
    jobId,
    at: Date.parse(date),
    attemptAt: Date.parse(date),
    brokerVersion,
    provider: 'codex',
    model: 'sol',
    mode: 'review',
    outcome: { status, ...(extra.errorCode ? { errorCode: extra.errorCode } : {}) },
    ...(extra.verification == null ? {} : {
      verificationOrigin: 'broker',
      verification: { state: extra.verification },
      verificationOutcome: {
        labelAvailable: true,
        outcome: extra.verification === 'passed' ? 'pass' : 'fail'
      }
    }),
    ...(extra.acceptance == null ? {} : {
      acceptance: { state: extra.acceptance },
      acceptanceDecision: { decision: extra.acceptance, labelAvailable: true }
    })
  });
  for (let index = 0; index < 12; index += 1) {
    add(`current-${index}`, `2026-07-${String(20 + (index % 3)).padStart(2, '0')}T12:00:00Z`, '0.42.0', index === 11 ? 'failed' : 'completed', {
      verification: index < 10 ? index === 9 ? 'failed' : 'passed' : null,
      acceptance: index < 3 ? index === 2 ? 'rejected' : 'accepted' : null
    });
  }
  for (let index = 0; index < 12; index += 1) {
    add(`old-${index}`, `2026-07-${String(11 + (index % 3)).padStart(2, '0')}T12:00:00Z`, '0.20.0', 'failed', { errorCode: 'ORPHANED' });
  }

  const current = aggregateAudit(rows, { since: '0.42.0', now: Date.parse('2026-07-27T00:00:00Z') });
  assert.equal(current.jobs, 12);
  assert.equal(current.rates.providerCompletion.rate, 11 / 12);
  assert.equal(current.rates.providerCompletion.sampleSize, 12);
  assert.equal(current.rates.verificationPass.rate, 0.9);
  assert.equal(current.rates.verificationPass.sampleSize, 10);
  assert.equal(current.rates.ownerAcceptance.rate, null);
  assert.equal(current.rates.ownerAcceptance.sampleSize, 3);
  assert.equal(current.rates.ownerAcceptance.status, 'insufficient-data');

  const independent = aggregateAudit(Array.from({ length: 10 }, (_, index) => ({
    jobId: `post-process-${index}`,
    at: index + 1,
    provider: 'codex',
    mode: 'implement',
    outcome: { status: index === 0 ? 'failed' : 'completed' },
    providerCompletion: {
      finished: true,
      labelAvailable: true,
      status: 'completed'
    },
    verificationOrigin: 'broker',
    verification: { state: index < 8 ? 'passed' : 'failed' }
  })), { now: 100 });
  assert.equal(independent.rates.providerCompletion.rate, 1, 'broker post-processing failures do not erase provider completion');
  assert.equal(independent.rates.verificationPass.rate, 0.8, 'verification remains an independent real-tree measurement');

  const old = aggregateAudit(rows, { until: '2026-07-17', now: Date.parse('2026-07-27T00:00:00Z') });
  assert.equal(old.jobs, 12);
  assert.equal(old.orphanedJobs, 12);
  assert.equal(old.rates.providerCompletion.rate, 0);
  assert.deepEqual(old.cohorts.timeWindows.map((cohort) => [cohort.window, cohort.orphanedJobs]), [
    ['2026-07-11', 4],
    ['2026-07-12', 4],
    ['2026-07-13', 4]
  ]);
  assert.deepEqual(old.cohorts.brokerVersions.map((cohort) => [cohort.brokerVersion, cohort.orphanedJobs]), [['0.20.0', 12]]);

  const sinceDate = aggregateAudit(rows, { since: '2026-07-20', now: Date.parse('2026-07-27T00:00:00Z') });
  assert.equal(sinceDate.jobs, 12);
  assert.equal(sinceDate.selection.kind, 'date');

  const projected = aggregateAudit([{
    jobId: 'retained-historical',
    at: Date.parse('2026-07-21T12:00:00Z'),
    provider: 'codex',
    mode: 'review',
    outcome: { status: 'completed' }
  }], {
    since: '0.42.0',
    jobs: [{
      id: 'retained-historical',
      provider: 'codex',
      mode: 'review',
      status: 'completed',
      origin: { brokerVersion: '0.42.0' }
    }],
    now: Date.parse('2026-07-27T00:00:00Z')
  });
  assert.equal(projected.jobs, 1, 'retained job evidence enriches the view without rewriting historical audit rows');
  assert.equal(projected.cohorts.brokerVersions[0].brokerVersion, '0.42.0');
});

test('acceptance audit revisions coalesce without double-counting attempts or usage', () => {
  const terminal = {
    jobId: 'attempt-1',
    at: 1000,
    recordedAt: 1100,
    auditRevision: 2,
    provider: 'codex',
    mode: 'implement',
    outcome: { status: 'completed' },
    usage: { total: { outputTokens: 100 } },
    acceptance: { state: 'ready-for-review' }
  };
  const decision = {
    ...terminal,
    recordedAt: 1200,
    auditRevision: 3,
    recordType: 'acceptance-decision',
    acceptance: { state: 'accepted' },
    acceptanceDecision: { decision: 'accepted', labelAvailable: true }
  };
  const aggregate = aggregateAudit([terminal, decision], { now: 2000 });
  assert.equal(aggregate.jobs, 1);
  assert.equal(aggregate.totals.outputTokens, 100);
  assert.equal(aggregate.rates.ownerAcceptance.sampleSize, 1);
  assert.equal(aggregate.rates.ownerAcceptance.rate, null);
  assert.equal(aggregate.rates.ownerAcceptance.numerator, 1);
});

test('outcome-aware routing declines sparse labels and recommends only on separated 95% intervals', () => {
  const row = (provider, index, accepted) => ({
    jobId: `${provider}-${index}`,
    at: 1000 + index,
    provider,
    mode: 'review',
    taskShape: { mode: 'review', access: 'read', isolation: 'shared' },
    outcome: { status: 'completed' },
    acceptanceDecision: { decision: accepted ? 'accepted' : 'rejected', labelAvailable: true }
  });
  const sparse = [row('codex', 1, true), row('cursor', 1, false)];
  const declined = recommendOutcomeRouting(sparse, { taskShape: { mode: 'review', access: 'read' }, now: 5000 });
  assert.equal(declined.status, 'insufficient-data');
  assert.equal(declined.recommendation, null);
  assert.deepEqual(declined.confidence, { level: 0.95, method: 'wilson-score-interval' });
  assert.ok(declined.candidates.every((candidate) => candidate.observedRate == null && candidate.confidenceInterval == null));
  assert.equal(declined.staticRouterChanged, false);

  const labelled = [
    ...Array.from({ length: 40 }, (_, index) => row('codex', index, index < 36)),
    ...Array.from({ length: 40 }, (_, index) => row('cursor', index, index < 8))
  ];
  const recommended = recommendOutcomeRouting(labelled, { taskShape: { mode: 'review', access: 'read' }, now: 5000 });
  assert.equal(recommended.status, 'recommendation');
  assert.equal(recommended.recommendation.provider, 'codex');
  assert.equal(recommended.recommendation.sampleSize, 40);
  assert.ok(recommended.recommendation.confidenceInterval.lower
    > recommended.candidates.find((candidate) => candidate.provider === 'cursor').confidenceInterval.upper);
  assert.equal(routeTask({
    task: 'Review the security boundary',
    mode: 'review',
    usage: { claude: { known: false }, codex: { known: false }, cursor: { known: false } },
    availability: { claude: true, codex: true, cursor: true }
  }).primary.provider, 'codex', 'the static router remains independently deterministic');
});

test('stats attribute Codex chain deltas across every token aggregate and preserve reset and window semantics', () => {
  const base = { provider: 'codex', model: 'gpt-5.6-sol', mode: 'review', effort: 'xhigh', outcome: { status: 'completed' } };
  const records = [
    { ...base, at: 1000, jobId: 'root', rootJobId: 'root', usage: { total: { outputTokens: 100 } } },
    { ...base, at: 2000, jobId: 'round-1', parentJobId: 'root', rootJobId: 'root', usage: { total: { outputTokens: 300 } } },
    { ...base, at: 3000, jobId: 'round-2', parentJobId: 'root', rootJobId: 'root', usage: { total: { outputTokens: 450 } } },
    { ...base, at: 4000, jobId: 'standalone', rootJobId: 'standalone', usage: { total: { outputTokens: 50 } } }
  ];
  assert.deepEqual(attributeAuditOutputTokens(records), [100, 200, 150, 50]);
  const aggregate = aggregateAudit(records, { now: 5000 });
  assert.equal(aggregate.groups[0].meanOutputTokens, 125);
  assert.equal(aggregate.totals.outputTokens, 500);
  assert.equal(aggregateAuditTotals(records, { now: 5000 }).outputTokens, 500);
  assert.deepEqual(auditUsageBands(records, { now: 5000 })[usageBandKey('codex', 'sol', 'xhigh')], {
    p50OutputTokens: 100,
    p90OutputTokens: 200,
    samples: 4
  });

  const reset = [
    { ...base, at: 1000, jobId: 'reset-root', rootJobId: 'reset-root', usage: { total: { outputTokens: 100 } } },
    { ...base, at: 2000, jobId: 'reset-1', parentJobId: 'reset-root', rootJobId: 'reset-root', usage: { total: { outputTokens: 50 } } },
    { ...base, at: 3000, jobId: 'reset-2', parentJobId: 'reset-root', rootJobId: 'reset-root', usage: { total: { outputTokens: 70 } } }
  ];
  assert.deepEqual(attributeAuditOutputTokens(reset), [100, 50, 20], 'a lower counter is a full fresh-thread sample and resets the delta baseline');

  const windowNow = 8 * 86400000;
  const crossWindow = [
    { ...base, at: windowNow - 7 * 86400000 - 1, jobId: 'older-root', rootJobId: 'older-root', usage: { total: { outputTokens: 100 } } },
    { ...base, at: windowNow - 7 * 86400000, jobId: 'boundary-child', parentJobId: 'older-root', rootJobId: 'older-root', usage: { total: { outputTokens: 160 } } }
  ];
  assert.deepEqual(aggregateAuditTotals(crossWindow, { since: '7d', now: windowNow }), {
    jobs: 1,
    terminalStatuses: { completed: 1, failed: 0, cancelled: 0 },
    outputTokens: 60
  });
});

test('stats token parsing skips nulls but preserves real zero and numeric strings', () => {
  assert.equal(outputTokens({ usage: { outputTokens: null } }), null);
  assert.equal(outputTokens({ usage: { outputTokens: undefined } }), null);
  assert.equal(outputTokens({ usage: { outputTokens: 0 } }), 0);
  assert.equal(outputTokens({ usage: { outputTokens: '1200' } }), 1200);
  assert.equal(outputTokens({ usage: { outputTokens: null, completionTokens: '1200' } }), 1200);
});

test('combined audit aggregate captures one clock snapshot for groups, totals, and generatedAt', () => {
  const options = { since: '1s' };
  let clockReads = 0;
  Object.defineProperty(options, 'now', { get: () => 10_000 + clockReads++ });
  const aggregate = aggregateAudit([{ at: 9000, provider: 'codex', outcome: { status: 'completed' }, usage: { total: { outputTokens: 1 } } }], options);
  assert.equal(clockReads, 1);
  assert.equal(aggregate.generatedAt, 10_000);
  assert.equal(aggregate.jobs, 1);
  assert.equal(aggregate.totals.jobs, 1);
});

test('visibility ledger shares one clock snapshot across rates, recommendation, and allowance views', () => {
  const options = { since: '1s', recommendFor: { mode: 'review' }, history: [] };
  let clockReads = 0;
  Object.defineProperty(options, 'now', { get: () => 10_000 + clockReads++ });
  const aggregate = aggregateVisibilityStats([
    { at: 9000, jobId: 'one', provider: 'codex', mode: 'review', outcome: { status: 'completed' } }
  ], options);
  assert.equal(clockReads, 1);
  assert.equal(aggregate.generatedAt, 10_000);
  assert.equal(aggregate.routingRecommendation.matchingAttempts, 1);
});

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
  assert.equal(warnings.length, 1);
  assert.match(warnings.join('\n'), /Objective.*Allowed scope.*Acceptance criteria.*Return/);
  assert.equal(warnings[0].split('\n\n')[1], 'Objective:\nAllowed scope:\nAcceptance criteria:\nReturn:');

  const fallback = loadProfile('independent-review');
  assert.equal(fallback.local, false);
  assert.equal(fallback.defaults.reportSchema.properties.findings.items.properties.severity.enum[0], 'blocking');
  const fallbackJob = createManagedJob({ provider: 'codex', profile: 'independent-review', prompt: 'Review this diff', cwd });
  assert.equal(fallbackJob.mode, 'review');
  assert.equal(fallbackJob.model, 'sol');
  assert.deepEqual(fallbackJob.reportSchema, fallback.defaults.reportSchema);
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

test('independent-review parses conforming findings and flags nonconforming structured output without failing', () => isolated(async ({ cwd }) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_REPLY = 'Complete inline findings.\n```json\n{"objectiveMet":false,"findings":[{"severity":"blocking","file":"src/a.js","line":12,"summary":"Broken guard","evidence":"The branch accepts invalid input."}],"clean":false}\n```';
  const parsedJob = createManagedJob({ provider: 'codex', profile: 'independent-review', cwd, prompt: 'Review the parser' });
  await runManagedProvider(parsedJob);
  const parsed = inspectJob(parsedJob.id);
  assert.deepEqual(parsed.result.structured.findings, [{
    severity: 'blocking', file: 'src/a.js', line: 12, summary: 'Broken guard', evidence: 'The branch accepts invalid input.'
  }]);
  assert.equal(parsed.objectiveMet, false);
  assert.equal(parsed.structuredMissing, undefined);

  process.env.FAKE_CODEX_REPLY = 'Inline fallback remains available.\n```json\n{"objectiveMet":"partial","findings":[],"clean":true}\n```';
  const missingJob = createManagedJob({ provider: 'codex', profile: 'independent-review', cwd, prompt: 'Review the parser' });
  await runManagedProvider(missingJob);
  const missing = inspectJob(missingJob.id);
  assert.equal(missing.status, 'completed');
  assert.equal(missing.structuredMissing, true);
  assert.equal(missing.result.structured, undefined);
}));
