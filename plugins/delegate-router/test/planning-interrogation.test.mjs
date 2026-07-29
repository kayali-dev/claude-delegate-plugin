import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  assessStructuralPlanOutput,
  compareStructuralPlans,
  contractDigest,
  parseStructuralPlan,
  planHardOutputTokenLimit,
  planOutputTokenBudget,
  planPrompt,
  planWallClockBudget,
  planReviewPresentation
} from '../bin/lib/planning.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { projectJobAsWorkItem } from '../bin/lib/work-projection.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-acp.mjs');
const jobsCli = path.join(testDir, '..', 'bin', 'delegate-jobs');
const controlMcp = path.join(testDir, '..', 'bin', 'delegate-control-mcp');

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
    'DELEGATE_PLAN_OUTPUT_TOKENS', 'DELEGATE_PLAN_TIMEOUT_SECONDS',
    'DELEGATE_PLAN_LAUNCH_WAIT_SECONDS',
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

test('plan output budget stays structural instead of scaling on packet bytes and remains overridable', () => {
  const simple = planOutputTokenBudget('Objective: rename one local variable');
  assert.equal(simple.limit, 4_096);
  assert.equal(simple.floor, 4_096);
  assert.equal(simple.ceiling, 16_384);
  assert.equal(simple.source, 'structured-default');

  const complex = planOutputTokenBudget([
    'Objective: implement the complete cross-surface change',
    ...Array.from({ length: 50 }, (_, index) => `${index + 1}. Must preserve invariant ${index + 1}.`),
    'x'.repeat(13_000)
  ].join('\n'));
  assert.equal(complex.limit, simple.limit, 'packet size and directive markers do not buy more output');
  assert.ok(complex.metrics.bytes > simple.metrics.bytes);
  assert.ok(complex.metrics.directiveMarkers > simple.metrics.directiveMarkers);

  const bounded = planOutputTokenBudget(`${'x'.repeat(100_000)}\n${'- must preserve this\n'.repeat(500)}`);
  assert.equal(bounded.limit, 4_096);
  assert.equal(planOutputTokenBudget('tiny', { DELEGATE_PLAN_OUTPUT_TOKENS: '3072' }).limit, 3_072);
});

test('plan wall clock derives from the token budget instead of a fixed cap', () => {
  const simple = planWallClockBudget('Objective: rename one local variable');
  assert.equal(simple.floor, 120);
  assert.equal(simple.source, 'token-budget-derived');
  assert.ok(simple.seconds >= 120, 'small packets keep at least the previous cap');

  const configured = planWallClockBudget('same packet', { DELEGATE_PLAN_OUTPUT_TOKENS: '16384' });
  assert.ok(configured.seconds > simple.seconds, 'a larger explicit token budget earns more wall clock');
  assert.equal(configured.tokenLimit, 16_384);
  assert.ok(configured.seconds <= configured.ceiling);

  const saturated = planWallClockBudget(`${'x'.repeat(100_000)}\n${'- must preserve this\n'.repeat(500)}`);
  assert.equal(saturated.tokenLimit, 4_096);
  assert.ok(saturated.seconds <= 900, 'the ceiling bounds a saturated budget');

  // A plan pass must never outlive the work it plans; the previous
  // Math.max(60, ...) could hand it more wall clock than its own parent.
  const clamped = planWallClockBudget('x'.repeat(60_000), {}, 90);
  assert.equal(clamped.seconds, 90);
  assert.equal(clamped.clampedToParent, true);
  assert.ok(clamped.derivedSeconds > 90);

  const overridden = planWallClockBudget('tiny', { DELEGATE_PLAN_TIMEOUT_SECONDS: '300' });
  assert.equal(overridden.seconds, 300);
  assert.equal(overridden.source, 'environment-override');
  assert.equal(planWallClockBudget('tiny', { DELEGATE_PLAN_TIMEOUT_SECONDS: '99999' }).seconds, 900);
});

test('compact plan framing and structural recovery accept marginal overruns but reject both observed runaways', () => {
  const prompt = planPrompt('Objective: inspect the bounded change');
  assert.match(prompt, /normally stay under 500 words/);
  assert.match(prompt, /stop immediately after the JSON\s+fence/);
  const valid = planText(structuralPlan());
  const marginal = assessStructuralPlanOutput(valid, 4_162, 4_096);
  assert.equal(marginal.state, 'recovered');
  assert.equal(marginal.recoverable, true);
  assert.equal(marginal.hardOutputTokenLimit, planHardOutputTokenLimit(4_096));

  for (const [observed, cap] of [[66_428, 2_048], [77_912, 4_096]]) {
    const runaway = assessStructuralPlanOutput(valid, observed, cap);
    assert.equal(runaway.state, 'rejected');
    assert.equal(runaway.recoverable, false);
    assert.equal(runaway.reason, 'runaway-plan-output-token-budget-exceeded');
  }
  const invalid = assessStructuralPlanOutput('unfinished prose', 4_162, 4_096);
  assert.equal(invalid.state, 'rejected');
  assert.match(invalid.reason, /no-valid-structural-json/);
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

test('a realistic five-kilobyte packet recovers a marginal plan overrun and reaches a comparison verdict', () => isolated(async (directory) => {
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS = '4162';
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS_MODEL = 'luna';
  const packet = [
    'Objective: implement the bounded cross-surface change',
    ...Array.from({ length: 20 }, (_, index) => `${index + 1}. Must preserve directive ${index + 1} and its focused regression.`),
    `Relevant context: ${'bounded context '.repeat(245)}`
  ].join('\n');
  assert.ok(Buffer.byteLength(packet) >= 4_800 && Buffer.byteLength(packet) <= 5_800);
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: packet,
    planFirst: true,
    ambiguityCheck: true
  });
  const running = runManagedProvider(created);
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation');
  assert.equal(presented.planPass.state, 'recovered');
  assert.equal(presented.planPass.outputTokenLimit, 4_096);
  assert.equal(presented.planPass.outputTokens, 4_162);
  assert.equal(presented.planning.comparison.verdict, 'convergent');
  assert.ok(readJobEvents(created.id).some((event) => event.type === 'plan.recovered'));
  submitControl(created.id, {
    type: 'respond',
    requestId: presented.pendingInput.requestId,
    accept: true,
    commandId: 'confirm-recovered-plan'
  }, presented.revision);
  await running;
  assert.equal(inspectJob(created.id).status, 'completed');
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
  assert.equal(presented.planPass.reason, 'runaway-plan-output-token-budget-exceeded');
  assert.equal(presented.planPass.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(presented.planPass.outputTokenLimit, 128);
  assert.equal(presented.planPass.outputTokens, 200);
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

test('CLI and MCP launch responses surface plan degradation with observed-versus-cap numbers', () => isolated(async (directory) => {
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS = '66428';
  process.env.DELEGATE_PLAN_LAUNCH_WAIT_SECONDS = '10';
  const packet = [
    '# Objective',
    'Implement the bounded fake change.',
    '# Allowed scope',
    'Only the fake test workspace.',
    '# Acceptance criteria',
    'The fake provider completes.',
    '# Return',
    'Return the result.'
  ].join('\n');
  const assertWarning = (result) => {
    assert.equal(result.launchNotice.state, 'degraded');
    assert.equal(result.launchNotice.level, 'warning');
    assert.equal(result.launchNotice.reason, 'runaway-plan-output-token-budget-exceeded');
    assert.equal(result.launchNotice.observedOutputTokens, 66_428);
    assert.equal(result.launchNotice.outputTokenLimit, 4_096);
    assert.match(result.launchNotice.message, /observed 66428 output tokens vs cap 4096/);
    assert.equal(result.launchNotice.blocking, false);
  };

  const cli = spawnSync(process.execPath, [
    jobsCli, 'start',
    '--provider', 'codex',
    '--model', 'sol',
    '--mode', 'implement',
    '--cwd', directory,
    '--prompt', packet
  ], { encoding: 'utf8', env: process.env, timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assertWarning(cliResult);
  await waitFor(cliResult.id, (job) => ['completed', 'failed', 'cancelled'].includes(job.status));

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'delegate_start',
      arguments: {
        provider: 'codex',
        model: 'sol',
        mode: 'implement',
        cwd: directory,
        prompt: packet
      }
    }
  };
  const mcp = spawnSync(process.execPath, [controlMcp], {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const response = JSON.parse(mcp.stdout.trim());
  const mcpResult = JSON.parse(response.result.content[0].text);
  assertWarning(mcpResult);
  await waitFor(mcpResult.id, (job) => ['completed', 'failed', 'cancelled'].includes(job.status));
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
