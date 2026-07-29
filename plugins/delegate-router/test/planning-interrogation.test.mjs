import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attributeInterrogationUsage,
  claimCommands,
  completeCommand,
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
import { waitForChildExit, waitForCondition } from './helpers/wait.mjs';

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

function runNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    env: options.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (options.input != null) child.stdin.end(options.input);
  else child.stdin.end();
  return waitForChildExit({
    child,
    description: `Node child ${path.basename(args[0])} to exit`,
    timeoutMs: 35_000
  }).then(({ status, signal }) => ({ status, signal, stdout, stderr }));
}

function waitFor(id, predicate, description, timeoutMs = 5_000) {
  return waitForCondition({
    description,
    timeoutMs,
    intervalMs: 10,
    observe: () => inspectJob(id),
    predicate
  });
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
  assert.equal(simple.limit, 8_192);
  assert.equal(simple.floor, 8_192);
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
  assert.equal(bounded.limit, 8_192);
  assert.equal(planOutputTokenBudget('tiny', { DELEGATE_PLAN_OUTPUT_TOKENS: '3072' }).limit, 3_072);
});

test('plan wall clock derives from the token budget instead of a fixed cap', () => {
  const simple = planWallClockBudget('Objective: rename one local variable');
  assert.equal(simple.floor, 300);
  assert.equal(simple.source, 'token-budget-derived');
  assert.ok(simple.seconds >= 300, 'the floor is generous rather than fitted to observed spend');

  const configured = planWallClockBudget('same packet', { DELEGATE_PLAN_OUTPUT_TOKENS: '16384' });
  assert.ok(configured.seconds >= simple.seconds, 'a larger explicit token budget never earns less wall clock');
  assert.equal(configured.tokenLimit, 16_384);
  assert.ok(configured.seconds <= configured.ceiling);

  const saturated = planWallClockBudget(`${'x'.repeat(100_000)}\n${'- must preserve this\n'.repeat(500)}`);
  assert.equal(saturated.tokenLimit, 8_192);
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

test('the independent planner is budgeted for whoever actually plans, not the parent', () => {
  // ambiguityCandidate prefers PROVIDER independence, so a Codex parent with
  // Cursor enabled plans on Cursor. Cursor is materially slower to first token
  // and was hitting the old ceiling on owner machines while Codex/luna finished
  // in a median 46s. The budget-filling evidence behind the flat Codex default
  // was measured only on Codex, so Cursor carries its own floor rather than a
  // blanket raise that would regress Codex back into filling its allowance.
  const spec = 'x'.repeat(5_000);
  const codex = planOutputTokenBudget(spec, {}, { provider: 'codex' });
  const cursor = planOutputTokenBudget(spec, {}, { provider: 'cursor' });
  assert.equal(codex.limit, 8_192);
  assert.equal(codex.source, 'structured-default');
  assert.ok(cursor.limit > codex.limit, 'the slower provider gets a larger allowance');
  assert.equal(cursor.source, 'provider-default:cursor');
  assert.ok(cursor.limit <= cursor.ceiling);

  const codexClock = planWallClockBudget(spec, {}, 5_400, { provider: 'codex' });
  const cursorClock = planWallClockBudget(spec, {}, 5_400, { provider: 'cursor' });
  assert.equal(codexClock.seconds, 300, 'Codex keeps a generous floor rather than a fitted one');
  assert.ok(cursorClock.seconds > 120, 'Cursor clears the ceiling it was dying on');
  assert.ok(cursorClock.seconds > codexClock.seconds);
  assert.ok(cursorClock.seconds <= cursorClock.ceiling);

  // Provider tuning must not defeat the guards that already existed.
  assert.equal(planWallClockBudget(spec, {}, 300, { provider: 'cursor' }).seconds, 300);
  assert.equal(planWallClockBudget(spec, { DELEGATE_PLAN_TIMEOUT_SECONDS: '200' }, 5_400, { provider: 'cursor' }).seconds, 200);
  assert.equal(planOutputTokenBudget(spec, { DELEGATE_PLAN_OUTPUT_TOKENS: '3072' }, { provider: 'cursor' }).limit, 3_072);
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
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
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

test('CLI plan responses reject answer-only before intake and return the resolved request for accept', () => isolated(async (directory) => {
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
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
  const misuse = spawnSync(process.execPath, [
    jobsCli,
    'respond',
    created.id,
    '--expected-revision', String(presented.revision),
    '--request-id', presented.pendingInput.requestId,
    '--command-id', 'answer-only-plan',
    '--answer', 'Please proceed with the plan'
  ], { encoding: 'utf8', env: process.env });
  assert.equal(misuse.status, 1);
  assert.equal(misuse.stdout, '');
  assert.equal(
    misuse.stderr,
    'delegate-jobs: INVALID_REQUEST: plan confirmation requires --accept or --reject (MCP: accept=true or accept=false); --answer is valid only for a free-form question (retryable=false, provider=codex)\n'
  );
  const afterMisuse = inspectJob(created.id);
  assert.equal(afterMisuse.revision, presented.revision);
  assert.equal(afterMisuse.pendingInput.requestId, presented.pendingInput.requestId);
  assert.equal(afterMisuse.controls?.['answer-only-plan'], undefined);

  const accepted = await runNode([
    jobsCli,
    'respond',
    created.id,
    '--expected-revision', String(presented.revision),
    '--request-id', presented.pendingInput.requestId,
    '--command-id', 'accept-plan-cli',
    '--accept'
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal('accepted' in result, false);
  assert.deepEqual(result.command, {
    id: 'accept-plan-cli',
    claimed: true,
    state: 'applied',
    duplicate: false
  });
  assert.deepEqual(result.request, {
    id: presented.pendingInput.requestId,
    kind: 'plan-confirmation',
    answered: true,
    outcome: 'accepted',
    appliedAs: 'same-session-plan-confirmation'
  });
  await running;
  assert.equal(inspectJob(created.id).planning.state, 'confirmed');
}));

test('CLI respond exits non-zero when a claimed response is rejected asynchronously', () => isolated(async (directory) => {
  const job = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'consult',
    cwd: directory,
    prompt: 'Wait for a coordinator answer'
  });
  const requestId = 'question-async-rejection';
  const waiting = updateManagedJob(job.id, (current) => {
    current.status = 'running';
    current.phase = 'user-input-required';
    current.stopReason = 'USER_INPUT_REQUIRED';
    current.pid = process.pid;
    current.pendingInput = {
      requestId,
      kind: 'question',
      method: 'ask_coordinator',
      origin: 'backchannel',
      expiresAt: Date.now() + 5_000
    };
  });
  const response = runNode([
    jobsCli,
    'respond',
    job.id,
    '--expected-revision', String(waiting.revision),
    '--request-id', requestId,
    '--command-id', 'async-rejected-cli',
    '--answer', 'This arrives after the request becomes stale'
  ]);
  let earlyResult = null;
  response.then((result) => { earlyResult = result; });
  const claimed = await waitForCondition({
    description: 'the CLI response command to become claimable',
    timeoutMs: 5_000,
    observe: () => {
      const command = claimCommands(job.id, { includeTypes: ['respond'] })[0] || null;
      if (!command && earlyResult) throw new Error(`CLI exited early: status=${earlyResult.status}, stderr=${JSON.stringify(earlyResult.stderr)}`);
      return command;
    }
  });
  completeCommand(job.id, claimed, {
    ok: false,
    error: 'pending request expired after intake',
    requestId
  });
  const result = await response;
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'delegate-jobs: INVALID_REQUEST: response command async-rejected-cli was rejected: pending request expired after intake (retryable=false, provider=codex)\n'
  );
}));

test('MCP plan responses make both submit-time rejection and accepted resolution unmistakable', () => isolated(async (directory) => {
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
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
  const request = (id, arguments_) => `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'delegate_respond', arguments: arguments_ }
  })}\n`;
  const misuse = spawnSync(process.execPath, [controlMcp], {
    encoding: 'utf8',
    env: process.env,
    input: request(1, {
      jobId: created.id,
      expectedRevision: presented.revision,
      requestId: presented.pendingInput.requestId,
      answer: 'Please proceed with the plan',
      commandId: 'answer-only-plan-mcp'
    })
  });
  assert.equal(misuse.status, 0, misuse.stderr);
  const rejectedEnvelope = JSON.parse(misuse.stdout.trim());
  assert.equal(rejectedEnvelope.result.isError, true);
  const rejected = JSON.parse(rejectedEnvelope.result.content[0].text);
  assert.equal('accepted' in rejected, false);
  assert.equal(rejected.code, 'INVALID_REQUEST');
  assert.match(rejected.error, /--accept or --reject/);
  assert.deepEqual(rejected.command, {
    id: 'answer-only-plan-mcp',
    claimed: false,
    state: 'rejected-before-intake'
  });
  assert.deepEqual(rejected.request, {
    id: presented.pendingInput.requestId,
    kind: 'plan-confirmation',
    answered: false
  });

  const acceptedCall = runNode([controlMcp], {
    input: request(2, {
      jobId: created.id,
      expectedRevision: presented.revision,
      requestId: presented.pendingInput.requestId,
      accept: true,
      commandId: 'accept-plan-mcp'
    })
  });
  const acceptedProcess = await acceptedCall;
  assert.equal(acceptedProcess.status, 0, acceptedProcess.stderr);
  const acceptedEnvelope = JSON.parse(acceptedProcess.stdout.trim());
  assert.equal(acceptedEnvelope.result.isError, undefined);
  const accepted = JSON.parse(acceptedEnvelope.result.content[0].text);
  assert.equal('accepted' in accepted, false);
  assert.deepEqual(accepted.command, {
    id: 'accept-plan-mcp',
    claimed: true,
    state: 'applied',
    duplicate: false
  });
  assert.deepEqual(accepted.request, {
    id: presented.pendingInput.requestId,
    kind: 'plan-confirmation',
    answered: true,
    outcome: 'accepted',
    appliedAs: 'same-session-plan-confirmation'
  });
  await running;
  assert.equal(inspectJob(created.id).planning.state, 'confirmed');
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
    const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
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
  // Pin the allowance this test is exercising. It asserts that a MARGINAL
  // overrun recovers, which is a relationship between spend and cap, not a
  // property of whatever default ships — raising the shipped floor otherwise
  // turns 4162 into an underrun and the awaited state never arrives.
  process.env.DELEGATE_PLAN_OUTPUT_TOKENS = '4096';
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
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
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
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
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
  // Pin the cap this test reports on. It asserts that a runaway surfaces with
  // observed-versus-cap numbers, which is a relationship, not a property of
  // whatever default ships.
  process.env.DELEGATE_PLAN_OUTPUT_TOKENS = '4096';
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
  await waitFor(cliResult.id, (job) => ['completed', 'failed', 'cancelled'].includes(job.status), 'job status to become terminal');

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
  await waitFor(mcpResult.id, (job) => ['completed', 'failed', 'cancelled'].includes(job.status), 'job status to become terminal');
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
  const active = await waitFor(created.id, (job) => Boolean(job.providerTurnId), 'providerTurnId to be recorded');
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
  const presented = await waitFor(planned.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
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
  const active = await waitFor(questioned.id, (job) => Boolean(job.providerSessionId), 'providerSessionId to be recorded');
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
