import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attributeInterrogationUsage,
  claimCommands,
  createManagedJob,
  inspectJob,
  launchManagedJob,
  readJobEvents,
  recordInterrogationAnswer,
  submitControl,
  updateManagedJob
} from '../bin/lib/control.mjs';
import {
  compareStructuralPlans,
  contractDigest,
  parseStructuralPlan,
  planOutputTokenBudget,
  planReviewPresentation
} from '../bin/lib/planning.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { projectJobAsWorkItem } from '../bin/lib/work-projection.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-acp.mjs');

function structuralPlan(overrides = {}) {
  return {
    targets: { files: ['src/core.js', 'test/core.test.js'], components: ['core-engine'] },
    approach: [
      { kind: 'edit', component: 'core-engine' },
      { kind: 'test', component: 'core-engine' }
    ],
    assumptions: [{ topic: 'ownership', choice: 'extend the core engine' }],
    risks: ['shared state'],
    ...overrides
  };
}

function planText(value) {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

async function isolated(fn) {
  const keys = [
    'DELEGATE_STATE_FILE', 'DELEGATE_CODEX_BIN', 'DELEGATE_CURSOR_BIN',
    'DELEGATE_CURSOR_LOGIN_SHELL', 'DELEGATE_MIN_CODEX_VERSION', 'DELEGATE_MIN_CURSOR_VERSION',
    'DELEGATE_ENABLED_PROVIDERS', 'DELEGATE_AMBIGUITY_CHECK', 'DELEGATE_SUPERVISOR',
    'DELEGATE_PLAN_OUTPUT_TOKENS',
    'FAKE_CODEX_REQUEST_LOG', 'FAKE_CURSOR_REQUEST_LOG', 'FAKE_CODEX_DIVERGENT_MODEL',
    'FAKE_CODEX_INCONCLUSIVE_MODEL', 'FAKE_CODEX_PLAN_OUTPUT_TOKENS',
    'FAKE_CODEX_PLAN_OUTPUT_TOKENS_MODEL'
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-plan-interrogate-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  process.env.DELEGATE_MIN_CODEX_VERSION = '0.0.0';
  process.env.DELEGATE_MIN_CURSOR_VERSION = '0.0.0';
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex';
  process.env.DELEGATE_SUPERVISOR = '0';
  try { return await fn(directory); }
  finally {
    for (const key of keys) {
      if (old[key] == null) delete process.env[key];
      else process.env[key] = old[key];
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

async function waitFor(id, predicate) {
  for (let index = 0; index < 500; index += 1) {
    const job = inspectJob(id);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${id}`);
}

test('structural plan comparison distinguishes convergence, divergence, and inconclusive output without prose similarity', () => {
  const left = parseStructuralPlan(planText(structuralPlan()));
  const convergent = compareStructuralPlans(left, parseStructuralPlan(planText(structuralPlan({
    risks: ['a differently worded risk is not a structural dimension']
  }))));
  assert.equal(convergent.verdict, 'convergent');
  assert.deepEqual(convergent.differences, []);
  assert.equal(planReviewPresentation(left, convergent, { source: 'unavailable' }).ambiguityQuestion, null);

  const divergent = compareStructuralPlans(left, parseStructuralPlan(planText(structuralPlan({
    targets: { files: ['src/alternate.js'], components: ['alternate-engine'] },
    approach: [
      { kind: 'refactor', component: 'alternate-engine' },
      { kind: 'test', component: 'alternate-engine' }
    ],
    assumptions: [{ topic: 'ownership', choice: 'replace the alternate engine' }]
  }))));
  assert.equal(divergent.verdict, 'divergent');
  assert.ok(divergent.differences.some((entry) => entry.dimension === 'targets.files'));
  assert.match(planReviewPresentation(left, divergent, { source: 'unavailable' }).ambiguityQuestion, /materially diverge/i);

  const inconclusive = compareStructuralPlans(left, parseStructuralPlan('A persuasive prose plan with no structural JSON.'));
  assert.equal(inconclusive.verdict, 'inconclusive');
  assert.match(planReviewPresentation(left, inconclusive, { source: 'unavailable' }).question, /INCONCLUSIVE/);
  assert.equal(planReviewPresentation(left, inconclusive, { source: 'unavailable' }).ambiguityQuestion, null);
});

test('plan output budget scales from a substantial floor to a documented ceiling and remains overridable', () => {
  const simple = planOutputTokenBudget('Objective: rename one local variable');
  assert.equal(simple.limit, 4_096);
  assert.equal(simple.floor, 4_096);
  assert.equal(simple.ceiling, 16_384);
  assert.equal(simple.source, 'packet-scaled-default');

  const complex = planOutputTokenBudget([
    'Objective: implement the complete cross-surface change',
    ...Array.from({ length: 50 }, (_, index) => `${index + 1}. Must preserve invariant ${index + 1}.`),
    'x'.repeat(13_000)
  ].join('\n'));
  assert.ok(complex.limit > simple.limit);
  assert.ok(complex.sizeSteps > 0);
  assert.ok(complex.complexitySteps > 0);

  const bounded = planOutputTokenBudget(`${'x'.repeat(100_000)}\n${'- must preserve this\n'.repeat(500)}`);
  assert.equal(bounded.limit, 16_384);
  assert.equal(planOutputTokenBudget('tiny', { DELEGATE_PLAN_OUTPUT_TOKENS: '3072' }).limit, 3_072);
});

test('write dry-runs announce the stricter plan-first default and both explicit escape hatches without creating state', () => isolated((directory) => {
  const before = fs.existsSync(path.join(directory, 'jobs')) ? fs.readdirSync(path.join(directory, 'jobs')) : [];
  const planned = launchManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    dryRun: true
  });
  assert.equal(planned.planFirst, true);
  assert.equal(planned.ambiguityCheck, true);
  const trivial = launchManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Rename one local variable',
    planFirst: false,
    ambiguityCheck: false,
    dryRun: true
  });
  assert.equal(trivial.planFirst, false);
  assert.equal(trivial.ambiguityCheck, false);
  const after = fs.existsSync(path.join(directory, 'jobs')) ? fs.readdirSync(path.join(directory, 'jobs')) : [];
  assert.deepEqual(after, before);
}));

test('plan-first confirmation continues the same Codex thread and switches only the confirmed turn to workspace-write', () => isolated(async (directory) => {
  const requestLog = path.join(directory, 'requests.jsonl');
  process.env.FAKE_CODEX_REQUEST_LOG = requestLog;
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    maxOutputTokens: 200,
    planFirst: true,
    ambiguityCheck: false
  });
  const running = runManagedProvider(created);
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation');
  assert.equal(presented.status, 'running');
  assert.equal(presented.planning.state, 'awaiting-confirmation');
  assert.deepEqual(presented.planning.presentation.predictedBlastRadius.files, ['a.js', 'test/a.test.js']);
  submitControl(created.id, {
    type: 'respond',
    requestId: presented.pendingInput.requestId,
    accept: true,
    commandId: 'confirm-plan'
  }, presented.revision);
  await running;
  const completed = inspectJob(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.planning.state, 'confirmed');
  assert.equal(completed.changedFiles.count, 1);
  const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1);
  const turns = requests.filter((request) => request.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].params.threadId, turns[1].params.threadId);
  assert.equal(turns[0].params.sandbox, 'read-only');
  assert.equal(turns[1].params.sandbox, 'workspace-write');
  assert.ok(readJobEvents(created.id).some((event) => event.type === 'plan.confirmed'));
}));

test('two independent cheap plan passes open only structural divergence questions and report inconclusive without a verdict', () => isolated(async (directory) => {
  const runComparison = async ({ divergentModel = null, inconclusiveModel = null }) => {
    if (divergentModel) process.env.FAKE_CODEX_DIVERGENT_MODEL = divergentModel;
    else delete process.env.FAKE_CODEX_DIVERGENT_MODEL;
    if (inconclusiveModel) process.env.FAKE_CODEX_INCONCLUSIVE_MODEL = inconclusiveModel;
    else delete process.env.FAKE_CODEX_INCONCLUSIVE_MODEL;
    const created = createManagedJob({
      provider: 'codex',
      model: 'sol',
      mode: 'implement',
      cwd: directory,
      prompt: 'Implement the bounded change',
      maxOutputTokens: 1_000,
      planFirst: true,
      ambiguityCheck: true
    });
    const running = runManagedProvider(created);
    const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation');
    const comparison = presented.planning.comparison;
    submitControl(created.id, {
      type: 'respond',
      requestId: presented.pendingInput.requestId,
      accept: false,
      commandId: `decline-${created.id}`
    }, presented.revision);
    await running;
    return { job: inspectJob(created.id), comparison };
  };

  const divergent = await runComparison({ divergentModel: 'luna' });
  assert.equal(divergent.comparison.verdict, 'divergent', JSON.stringify(divergent.job.planning));
  assert.match(divergent.job.planning.presentation.ambiguityQuestion, /materially diverge/i);
  assert.ok(divergent.job.planning.ambiguity.jobId);
  assert.equal(divergent.job.status, 'cancelled');

  const convergent = await runComparison({});
  assert.equal(convergent.comparison.verdict, 'convergent');
  assert.equal(convergent.job.planning.presentation.ambiguityQuestion, null);
  assert.equal(convergent.job.status, 'cancelled');

  const inconclusive = await runComparison({ inconclusiveModel: 'luna' });
  assert.equal(inconclusive.comparison.verdict, 'inconclusive');
  assert.equal(inconclusive.job.planning.presentation.ambiguityQuestion, null);
  assert.match(inconclusive.job.planning.presentation.question, /INCONCLUSIVE/);
  assert.equal(inconclusive.job.status, 'cancelled');
}));

test('a failed independent plan pass degrades loudly on the implement attempt and never blocks its launch', () => isolated(async (directory) => {
  process.env.DELEGATE_PLAN_OUTPUT_TOKENS = '128';
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS = '200';
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS_MODEL = 'luna';
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    planFirst: true,
    ambiguityCheck: true
  });
  const running = runManagedProvider(created);
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation');
  assert.equal(presented.status, 'running');
  assert.equal(presented.planPass.state, 'degraded');
  assert.equal(presented.planPass.reason, 'plan-output-token-budget-exceeded');
  assert.equal(presented.planPass.errorCode, 'BUDGET_EXCEEDED');
  assert.match(presented.planPass.jobId, /^codex-/);
  assert.equal(presented.planning.ambiguity.state, 'degraded');
  assert.equal(presented.planning.comparison.verdict, 'inconclusive');
  submitControl(created.id, {
    type: 'respond',
    requestId: presented.pendingInput.requestId,
    accept: true,
    commandId: 'confirm-after-plan-pass-degradation'
  }, presented.revision);
  await running;
  const completed = inspectJob(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.changedFiles.count, 1);
  assert.equal(completed.planPass.state, 'degraded');
  assert.ok(readJobEvents(created.id).some((event) => event.type === 'plan.degraded'
    && event.data.jobId === completed.planPass.jobId
    && event.data.fallback === 'single-plan-confirmation'));
}));

test('interrogation rejects authority fields and records answer plus observed token cost as WorkItem finding evidence', () => isolated((directory) => {
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement',
    maxOutputTokens: 200,
    planFirst: false,
    providerSessionId: 'thread-live'
  });
  updateManagedJob(created.id, (job) => {
    job.status = 'running';
    job.phase = 'running';
    job.workerPid = process.pid;
    job.usage = { total: { inputTokens: 20, outputTokens: 10 } };
  });
  const before = inspectJob(created.id);
  assert.throws(() => submitControl(created.id, {
    type: 'interrogate',
    question: 'why this approach?',
    budget: 1000
  }, before.revision), /question only|rejected fields/);
  const accepted = submitControl(created.id, {
    type: 'interrogate',
    question: 'what did the failing check actually say?',
    commandId: 'question-1'
  }, before.revision);
  const claimed = claimCommands(created.id)[0];
  assert.equal(claimed.command.contractDigest, contractDigest(before));
  recordInterrogationAnswer(created.id, claimed.command, 'Expected 2 but received 3.', {
    baselineOutputTokens: 10,
    transport: 'app-server',
    appliedAs: 'same-turn-read-only-question'
  });
  attributeInterrogationUsage(created.id, { total: { inputTokens: 30, outputTokens: 18 } });
  const job = inspectJob(created.id);
  assert.equal(accepted.accepted, true);
  assert.equal(job.interrogations[0].authority, 'evidence-only');
  assert.equal(job.interrogations[0].constraintsUnchanged, true);
  assert.equal(job.interrogations[0].cost.outputTokens, 8);
  const finding = projectJobAsWorkItem(job).findings.find((entry) => entry.id === 'interrogation-question-1');
  assert.match(finding.evidence.answer, /Expected 2/);
  assert.equal(finding.evidence.cost.outputTokens, 8);
}));

test('Codex interrogation round trip uses turn/steer framing, preserves the contract, and attributes provider tokens', () => isolated(async (directory) => {
  const requestLog = path.join(directory, 'interrogate-requests.jsonl');
  process.env.FAKE_CODEX_REQUEST_LOG = requestLog;
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement',
    maxOutputTokens: 500,
    planFirst: false
  });
  const digest = contractDigest(created);
  const running = runManagedProvider(created);
  const active = await waitFor(created.id, (job) => Boolean(job.providerTurnId));
  submitControl(created.id, {
    type: 'interrogate',
    question: 'what did the failing check actually say?',
    commandId: 'live-question'
  }, active.revision);
  await running;
  const completed = inspectJob(created.id);
  assert.equal(contractDigest(completed), digest);
  assert.equal(completed.interrogations[0].state, 'answered');
  assert.match(completed.interrogations[0].answer, /expected 2 but received 3/i);
  assert.ok(completed.interrogations[0].cost.outputTokens > 0);
  const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const steer = requests.find((request) => request.method === 'turn/steer');
  assert.match(steer.params.input[0].text, /READ-ONLY INTERROGATION live-question/);
  assert.match(steer.params.input[0].text, /take NO action/);
  assert.ok(readJobEvents(created.id).some((event) => event.type === 'finding.recorded'));
  assert.ok(readJobEvents(created.id).some((event) => event.type === 'interrogation.cost'));
}));

test('Cursor plan-first and interrogation reuse one ACP session while questions stay queued, read-only, and restart-honest', () => isolated(async (directory) => {
  process.env.DELEGATE_ENABLED_PROVIDERS = 'cursor';
  const planLog = path.join(directory, 'cursor-plan-requests.jsonl');
  process.env.FAKE_CURSOR_REQUEST_LOG = planLog;
  const planned = createManagedJob({
    provider: 'cursor',
    model: 'composer',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement with Cursor',
    maxOutputTokens: 500,
    planFirst: true,
    ambiguityCheck: false
  });
  const planningRun = runManagedProvider(planned);
  const presented = await waitFor(planned.id, (job) => job.pendingInput?.kind === 'plan-confirmation');
  submitControl(planned.id, {
    type: 'respond',
    requestId: presented.pendingInput.requestId,
    accept: true,
    commandId: 'cursor-confirm'
  }, presented.revision);
  await planningRun;
  const planRequests = fs.readFileSync(planLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(planRequests.filter((request) => request.method === 'session/new').length, 1);
  assert.equal(planRequests.filter((request) => request.method === 'session/prompt').length, 2);
  assert.deepEqual(planRequests.filter((request) => request.method === 'session/set_config_option' && request.params.configId === 'mode')
    .map((request) => request.params.value), ['plan', 'agent']);
  assert.equal(inspectJob(planned.id).planning.state, 'confirmed');

  const interrogationLog = path.join(directory, 'cursor-interrogation-requests.jsonl');
  process.env.FAKE_CURSOR_REQUEST_LOG = interrogationLog;
  const questioned = createManagedJob({
    provider: 'cursor',
    model: 'composer',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement with Cursor',
    maxOutputTokens: 500,
    planFirst: false
  });
  const questioningRun = runManagedProvider(questioned);
  const active = await waitFor(questioned.id, (job) => Boolean(job.providerSessionId));
  submitControl(questioned.id, {
    type: 'interrogate',
    question: 'what did the failing check actually say?',
    commandId: 'cursor-question'
  }, active.revision);
  await questioningRun;
  const completed = inspectJob(questioned.id);
  assert.equal(completed.interrogations[0].state, 'answered');
  assert.equal(completed.interrogations[0].appliedAs, 'queued-next-turn');
  assert.equal(completed.interrogations[0].cost.outputTokens, 3);
  const events = readJobEvents(questioned.id);
  assert.ok(events.some((event) => event.type === 'interrogation.queued'
    && event.data.appliedAs === 'queued-next-turn'
    && event.data.cursorSameTurn === false));
  const interrogationRequests = fs.readFileSync(interrogationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(interrogationRequests.filter((request) => request.method === 'session/prompt').length, 2);
  assert.equal(interrogationRequests.filter((request) => request.method === 'session/cancel').length, 0);
  assert.ok(interrogationRequests.some((request) => request.method === 'session/set_config_option'
    && request.params.configId === 'mode'
    && request.params.value === 'plan'));
}));
