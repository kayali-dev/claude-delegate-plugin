import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attributeInterrogationUsage,
  awaitAmbiguityProbe,
  claimCommands,
  completeCommand,
  createManagedJob,
  inspectJob,
  launchManagedJob,
  readJobEvents,
  recordInterrogationAnswer,
  selectAmbiguityCandidate,
  submitControl,
  updateManagedJob,
  waitForPlanFirstLaunch
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

function approachEntries(entries) {
  return entries.map((entry) => {
    const separator = entry.indexOf(':');
    return { kind: entry.slice(0, separator), component: entry.slice(separator + 1) };
  });
}

function assertNonBlockingNamingVariance(left, right, expectedDimensions) {
  const parsedLeft = parseStructuralPlan(planText(left));
  const parsedRight = parseStructuralPlan(planText(right));
  const comparison = compareStructuralPlans(parsedLeft, parsedRight);
  assert.equal(comparison.verdict, 'convergent');
  assert.equal(comparison.evidence?.assessment, 'same-work-different-naming');
  assert.equal(comparison.evidence?.blocking, false);
  assert.ok(comparison.signals.some((signal) => (
    signal.dimension === 'targets.files'
    && signal.strength === 'strong'
    && signal.effect === 'agreement'
  )));
  for (const dimension of expectedDimensions) {
    assert.ok(comparison.variances.some((entry) => (
      entry.dimension === dimension
      && entry.blocking === false
      && ['weak', 'moderate'].includes(entry.strength)
    )), `missing non-blocking ${dimension} variance: ${JSON.stringify(comparison)}`);
  }
  const presentation = planReviewPresentation(parsedLeft, comparison, { source: 'unavailable' });
  assert.equal(presentation.ambiguityQuestion, null);
  assert.match(presentation.question, /same work, different naming/i);
  assert.match(presentation.question, /not a conflict/i);
  return comparison;
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
    'FAKE_CODEX_PLAN_RETRY_OUTPUT_TOKENS', 'FAKE_CODEX_PLAN_OUTPUT_TOKENS_MODEL', 'FAKE_CURSOR_PLAN_RESPONSE',
    'FAKE_CURSOR_PLAN_OUTPUT_TOKENS'
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

function appendPlanProbeAudit(directory, { provider, model, outputValidity, at = Date.now() }) {
  const audit = path.join(directory, 'audit.jsonl');
  fs.appendFileSync(audit, `${JSON.stringify({
    jobId: `probe-${provider}-${model}-${at}`,
    at,
    planFirstOutcome: {
      requested: true,
      attempts: [{ role: 'independent-probe', provider, model, outputValidity }]
    }
  })}\n`);
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
  assert.deepEqual(inconclusive, {
    verdict: 'inconclusive',
    reason: 'one-or-both-plans-lack-valid-structural-output',
    inputs: { left: 'valid', right: 'no-valid-structural-json' },
    comparedDimensions: [],
    differences: []
  });
  assert.match(planReviewPresentation(left, inconclusive, { source: 'unavailable' }).question, /INCONCLUSIVE/);
  assert.equal(planReviewPresentation(left, inconclusive, { source: 'unavailable' }).ambiguityQuestion, null);
});

test('structural plans preserve path and identifier case while matching and dedupe use derived folded keys', () => {
  const parsed = parseStructuralPlan(planText(structuralPlan({
    targets: {
      files: ['src/genui/GenUiRenderer.tsx', 'src/genui/genuirenderer.tsx'],
      components: ['ServiceMap']
    },
    approach: [{ kind: 'EDIT', component: 'RenderNode.service-map' }],
    assumptions: [{ topic: 'interaction contract', choice: 'Use a pre-minted interactionId with onInteract.' }],
    risks: ['Preserve SVG viewBox casing.']
  })));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.targets.files, ['src/genui/GenUiRenderer.tsx']);
  assert.deepEqual(parsed.plan.targets.components, ['ServiceMap']);
  assert.deepEqual(parsed.plan.approach, [{ kind: 'edit', component: 'RenderNode.service-map' }]);
  assert.deepEqual(parsed.plan.assumptions, [
    { topic: 'interaction contract', choice: 'Use a pre-minted interactionId with onInteract.' }
  ]);
  assert.deepEqual(parsed.plan.risks, ['Preserve SVG viewBox casing.']);

  const presentation = planReviewPresentation(parsed, { verdict: 'inconclusive', reason: 'not-run' }, { source: 'unavailable' });
  assert.deepEqual(presentation.structuralPlan, parsed.plan);
  assert.equal(compareStructuralPlans(parsed, planText(structuralPlan({
    targets: { files: ['SRC/GENUI/GENUIRENDERER.TSX'], components: ['servicemap'] },
    approach: [{ kind: 'edit', component: 'rendernode.service-map' }],
    assumptions: [{ topic: 'INTERACTION CONTRACT', choice: 'use a pre-minted interactionid with oninteract' }],
    risks: ['preserve svg viewbox casing']
  }))).verdict, 'convergent');
});

test('declared assumption paraphrases reduce to the same ordered parser-precedence decision', () => {
  const leftChoice = 'preserve fenced and whole-body precedence; scan balanced brace-aware objects only as the final candidate source.';
  const rightChoice = 'preserve fenced json precedence, then whole-body json, then scan for a balanced object; retain structural validation reasons.';
  const left = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'assumptions.parser-precedence', choice: leftChoice }]
  })));
  const right = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'Assumptions / Parser Precedence', choice: rightChoice }]
  })));

  const comparison = compareStructuralPlans(left, right);
  assert.equal(comparison.verdict, 'convergent');
  assert.deepEqual(comparison.differences, []);
  assert.equal(planReviewPresentation(left, comparison, { source: 'unavailable' }).ambiguityQuestion, null);
});

test('six verbatim component slug pairs are non-blocking naming variance when concrete files agree', () => {
  const leftComponents = [
    'degraded-plan-confirmation',
    'inspect-summary-view',
    'ceiling-bounded-plan-retry',
    'canonical-lifecycle-vocabulary',
    'input-blocked-list-filter',
    'verification-caveats'
  ];
  const rightComponents = [
    'degraded-plan-confirmation-policy',
    'inspect-summary-projection',
    'plan-budget-ceiling-retry',
    'lifecycle-outcome-vocabulary',
    'list-input-filter',
    'verification-engine-caveats'
  ];
  assertNonBlockingNamingVariance(
    structuralPlan({ targets: { files: ['plugins/delegate-router/bin/lib/planning.mjs'], components: leftComponents } }),
    structuralPlan({ targets: { files: ['plugins/delegate-router/bin/lib/planning.mjs'], components: rightComponents } }),
    ['targets.components']
  );
});

test('verbatim long worktree-default prose is non-blocking when both decisions keep shared default and worktree opt-in', () => {
  const leftChoice = 'Retain shared isolation as the default because mandatory worktrees would reject non-Git roots, unsupported Git shapes, sandbox-off, ingest, addDirs, and auto-fix workflows; keep worktree containment explicitly selectable through the existing isolation flag and prerequisites.';
  const rightChoice = 'Keep shared isolation as the backward-compatible default; make degraded write plans require confirmation and retain explicit worktree isolation as the discard-capable opt-in.';
  assertNonBlockingNamingVariance(
    structuralPlan({ assumptions: [{ topic: 'assumptions.worktree-default', choice: leftChoice }] }),
    structuralPlan({ assumptions: [{ topic: 'assumptions.worktree-default', choice: rightChoice }] }),
    ['assumptions.assumptions.worktree-default']
  );
});

test('verbatim multi-item approach grouping and slug variance are non-blocking when concrete files agree', () => {
  const leftApproach = approachEntries([
    'edit:write-launch-scope-policy',
    'edit:degraded-plan-confirmation',
    'edit:ceiling-bounded-plan-retry',
    'edit:verification-caveats',
    'edit:inspect-summary-view',
    'edit:input-blocked-list-filter',
    'edit:canonical-lifecycle-vocabulary',
    'test:degraded-plan-confirmation',
    'test:ceiling-bounded-plan-retry',
    'test:verification-caveats',
    'test:inspect-summary-view',
    'test:input-blocked-list-filter',
    'test:canonical-lifecycle-vocabulary',
    'docs:consumer-contract-docs',
    'verify:full-suite-proof'
  ]);
  const rightApproach = approachEntries([
    'inspect:degraded-plan-confirmation-policy',
    'edit:degraded-plan-confirmation-policy',
    'test:degraded-plan-confirmation-policy',
    'edit:plan-budget-ceiling-retry',
    'test:plan-budget-ceiling-retry',
    'edit:verification-engine-caveats',
    'test:verification-engine-caveats',
    'edit:inspect-summary-projection',
    'test:inspect-summary-projection',
    'edit:list-input-filter',
    'test:list-input-filter',
    'edit:lifecycle-outcome-vocabulary',
    'test:lifecycle-outcome-vocabulary',
    'docs:lifecycle-outcome-vocabulary',
    'verify:all-p2-regressions'
  ]);
  assertNonBlockingNamingVariance(
    structuralPlan({ approach: leftApproach }),
    structuralPlan({ approach: rightApproach }),
    ['approach.shape']
  );
});

test('verbatim sticky-plan assumption and approach differences are non-blocking when concrete files agree', () => {
  const leftApproach = approachEntries([
    'edit:pane-summary-height-pressure',
    'edit:detail-plan-summary',
    'edit:detail-plan-tab',
    'edit:detail-plan-navigation',
    'edit:keymap-registry',
    'test:tui-plan-regressions',
    'docs:tui-reference',
    'docs:unreleased-changelog',
    'verify:tui-plan-regressions'
  ]);
  const rightApproach = approachEntries([
    'edit:detail-plan-summary',
    'edit:detail-plan-tab',
    'edit:detail-tab-navigation',
    'edit:keymap-generated-docs',
    'test:plan-surface-tests',
    'verify:detail-plan-summary',
    'docs:keymap-generated-docs'
  ]);
  const leftAssumptions = [
    { topic: 'assumptions.palette', choice: 'Reuse existing semantic and surface tokens; introduce no palette token.' },
    { topic: 'assumptions.summary-pressure', choice: 'Use pane-summary rows for plan state plus existing tab metrics above 30 rows, and retain only the coordinator-critical plan row at 30 rows or fewer.' }
  ];
  const rightAssumptions = [
    { topic: 'assumptions.palette', choice: 'Reuse existing semantic and surface tokens; introduce no new palette token.' },
    { topic: 'assumptions.summary-pressure', choice: 'Use the existing pane summary strip and reduce plan summary rows under the documented 30-row height-pressure threshold.' }
  ];
  const comparison = assertNonBlockingNamingVariance(
    structuralPlan({ approach: leftApproach, assumptions: leftAssumptions }),
    structuralPlan({ approach: rightApproach, assumptions: rightAssumptions }),
    ['assumptions.assumptions.palette', 'assumptions.assumptions.summary-pressure', 'approach.shape']
  );
  assert.equal(comparison.variances.filter((entry) => entry.dimension.startsWith('assumptions.')).length, 2);
});

test('disjoint concrete file targets remain a strong blocking divergence', () => {
  const comparison = compareStructuralPlans(
    parseStructuralPlan(planText(structuralPlan({
      targets: { files: ['plugins/delegate-router/bin/lib/planning.mjs'], components: ['structural-plan-comparison'] }
    }))),
    parseStructuralPlan(planText(structuralPlan({
      targets: { files: ['plugins/delegate-router/bin/lib/control.mjs'], components: ['structural-plan-comparison'] }
    })))
  );
  assert.equal(comparison.verdict, 'divergent');
  assert.equal(comparison.evidence?.assessment, 'material-conflict');
  assert.equal(comparison.evidence?.blocking, true);
  assert.ok(comparison.differences.some((entry) => (
    entry.dimension === 'targets.files'
    && entry.strength === 'strong'
    && entry.blocking === true
  )));
});

test('a genuine same-topic assumption conflict stays divergent and presents both decisions', () => {
  const leftChoice = 'preserve fenced and whole-body precedence; scan balanced brace-aware objects only as the final candidate source.';
  const rightChoice = 'preserve whole-body json precedence, then fenced json, then scan for a balanced object.';
  const left = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'assumptions.parser-precedence', choice: leftChoice }]
  })));
  const right = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'assumptions.parser-precedence', choice: rightChoice }]
  })));

  const comparison = compareStructuralPlans(left, right);
  assert.equal(comparison.verdict, 'divergent');
  assert.equal(comparison.evidence.assessment, 'material-conflict');
  assert.equal(comparison.evidence.blocking, true);
  assert.equal(comparison.differences[0].reason, 'declared-assumptions-conflict');
  assert.equal(comparison.differences[0].strength, 'strong');
  assert.equal(comparison.differences[0].blocking, true);
  assert.deepEqual(comparison.differences[0].decisions, {
    left: 'keep fenced-json -> keep whole-body-json -> scan balanced-object',
    right: 'keep whole-body-json -> keep fenced-json -> scan balanced-object'
  });
  const question = planReviewPresentation(left, comparison, { source: 'unavailable' }).ambiguityQuestion;
  assert.match(question, /keep fenced-json -> keep whole-body-json/);
  assert.match(question, /keep whole-body-json -> keep fenced-json/);
});

test('verbatim asymmetric terse precedence inversion remains a strong blocking conflict', () => {
  const leftChoice = 'preserve fenced and whole-body precedence; scan balanced brace-aware objects only as the final candidate source.';
  const rightChoice = 'scan balanced objects FIRST, before any fenced block.';
  const left = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'assumptions.parser-precedence', choice: leftChoice }]
  })));
  const right = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'assumptions.parser-precedence', choice: rightChoice }]
  })));

  const comparison = compareStructuralPlans(left, right);
  assert.equal(comparison.verdict, 'divergent');
  assert.equal(comparison.evidence.assessment, 'material-conflict');
  assert.equal(comparison.evidence.blocking, true);
  assert.equal(comparison.differences[0].dimension, 'assumptions.assumptions.parser-precedence');
  assert.equal(comparison.differences[0].reason, 'declared-assumptions-conflict');
  assert.equal(comparison.differences[0].strength, 'strong');
  assert.equal(comparison.differences[0].blocking, true);
});

test('opposing defaults on the same assumption topic remain a strong blocking conflict', () => {
  const left = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{
      topic: 'assumptions.worktree-default',
      choice: 'Keep shared isolation as the default and keep worktree isolation opt-in.'
    }]
  })));
  const right = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{
      topic: 'assumptions.worktree-default',
      choice: 'Keep worktree isolation as the default and retain shared isolation only for compatibility.'
    }]
  })));
  const comparison = compareStructuralPlans(left, right);
  assert.equal(comparison.verdict, 'divergent');
  assert.equal(comparison.evidence.blocking, true);
  assert.equal(comparison.differences[0].dimension, 'assumptions.assumptions.worktree-default');
  assert.equal(comparison.differences[0].strength, 'strong');
});

test('high-confidence asymmetric negation, exclusive scope, and terse-versus-verbose opposition remain blocking', () => {
  const cases = [
    {
      topic: 'assumptions.worktree-use',
      left: 'Never use worktree isolation outside Git repositories.',
      right: 'Use worktree isolation outside Git repositories when the caller explicitly opts in.'
    },
    {
      topic: 'assumptions.parser-scope',
      left: 'Use only fenced JSON.',
      right: 'Use fenced JSON and whole-body JSON.'
    },
    {
      topic: 'assumptions.worktree-default',
      left: 'Keep shared isolation as the default.',
      right: 'Remove shared isolation as the default because mandatory worktrees should govern every write.'
    }
  ];

  for (const entry of cases) {
    const comparison = compareStructuralPlans(
      parseStructuralPlan(planText(structuralPlan({
        assumptions: [{ topic: entry.topic, choice: entry.left }]
      }))),
      parseStructuralPlan(planText(structuralPlan({
        assumptions: [{ topic: entry.topic, choice: entry.right }]
      })))
    );
    assert.equal(comparison.verdict, 'divergent', `${entry.topic}: ${JSON.stringify(comparison)}`);
    assert.equal(comparison.evidence.blocking, true);
    assert.equal(comparison.differences[0].reason, 'declared-assumptions-conflict');
    assert.equal(comparison.differences[0].strength, 'strong');
  }
});

test('assumption normalization ignores case punctuation and filler but preserves enumerated order', () => {
  const left = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'write lifecycle', choice: 'First: validate the input; then persist the output.' }]
  })));
  const equivalent = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'Lifecycle, Write', choice: '1) VALIDATE input. 2) Then save output!' }]
  })));
  assert.equal(compareStructuralPlans(left, equivalent).verdict, 'convergent');

  const reordered = parseStructuralPlan(planText(structuralPlan({
    assumptions: [{ topic: 'write lifecycle', choice: 'First persist the output; then validate the input.' }]
  })));
  assert.equal(compareStructuralPlans(left, reordered).verdict, 'divergent');
});

test('component wording and approach ordering are weak while approach content remains non-blocking moderate evidence', () => {
  const left = parseStructuralPlan(planText(structuralPlan({
    targets: { files: ['src/core.js'], components: ['structural-plan comparator'] },
    approach: [
      { kind: 'edit', component: 'structural-plan comparator' },
      { kind: 'test', component: 'decision normalization' }
    ]
  })));
  const equivalent = parseStructuralPlan(planText(structuralPlan({
    targets: { files: ['./src/core.js'], components: ['Plan structural comparison'] },
    approach: [
      { kind: 'test', component: 'normalization decision component' },
      { kind: 'edit', component: 'plan structural comparison' }
    ]
  })));
  assert.equal(compareStructuralPlans(left, equivalent).verdict, 'convergent');

  const changed = parseStructuralPlan(planText(structuralPlan({
    targets: { files: ['src/core.js'], components: ['Plan structural comparison'] },
    approach: [
      { kind: 'refactor', component: 'plan structural comparison' },
      { kind: 'test', component: 'normalization decision component' }
    ]
  })));
  const contentVariance = compareStructuralPlans(left, changed);
  assert.equal(contentVariance.verdict, 'convergent');
  assert.ok(contentVariance.variances.some((entry) => (
    entry.dimension === 'approach.shape'
    && entry.strength === 'moderate'
    && entry.blocking === false
  )));
});

test('structural plan parsing accepts narrated balanced JSON last while preserving fenced precedence and exact failures', () => {
  const expected = structuralPlan();
  const narrated = [
    'I inspected the requested surfaces and found the following bounded plan.',
    JSON.stringify(expected),
    'This is the plan I recommend after reviewing the repository.'
  ].join('\n\n');
  const parsed = parseStructuralPlan(narrated);
  assert.equal(parsed.ok, true);
  assert.equal(compareStructuralPlans(planText(expected), parsed).verdict, 'convergent');
  assert.equal(parseStructuralPlan(`Narrated unmatched brace { before the deliverable.\n${JSON.stringify(expected)}`).ok, true);

  assert.deepEqual(parseStructuralPlan('Narration only, with genuinely no object.'), {
    ok: false,
    reason: 'no-valid-structural-json'
  });

  const invalidFenced = planText({
    ...expected,
    targets: { files: 'src/core.js', components: ['core-engine'] }
  });
  const fencedWins = parseStructuralPlan(`${invalidFenced}\n${JSON.stringify(expected)}`);
  assert.deepEqual(fencedWins, { ok: false, reason: 'invalid-target-shape' });
  assert.deepEqual(parseStructuralPlan(`${planText(expected)}\n\`\`\`json\ninvalid\n\`\`\``), { ok: false, reason: 'no-valid-structural-json' });
  assert.deepEqual(parseStructuralPlan(`${planText(expected)}\n${invalidFenced}`), { ok: false, reason: 'invalid-target-shape' });
  assert.equal(parseStructuralPlan(JSON.stringify(expected)).ok, true, 'native JSON is accepted');
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

test('planner selection requires structural output capability and preserves model independence', () => isolated((directory) => {
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  const codexParent = { provider: 'codex', model: 'sol', requestedModel: 'sol' };
  const cursorParent = { provider: 'cursor', model: 'composer', requestedModel: 'composer' };

  const coldFallback = selectAmbiguityCandidate(codexParent);
  assert.deepEqual({ provider: coldFallback.provider, model: coldFallback.model, independentBy: coldFallback.independentBy }, {
    provider: 'codex', model: 'luna', independentBy: 'model'
  });
  for (const model of ['luna', 'gpt-6-luna', 'gpt-5.6-luna']) {
    assert.equal(selectAmbiguityCandidate({ provider: 'codex', model, requestedModel: model }).model, 'terra', 'Luna parents retain model-independent comparison after alias migration');
  }
  const capableProvider = selectAmbiguityCandidate(cursorParent);
  assert.deepEqual({ provider: capableProvider.provider, model: capableProvider.model, independentBy: capableProvider.independentBy }, {
    provider: 'codex', model: 'luna', independentBy: 'provider'
  });
  process.env.DELEGATE_ENABLED_PROVIDERS = 'cursor';
  assert.equal(selectAmbiguityCandidate(cursorParent), null);
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';

  appendPlanProbeAudit(directory, { provider: 'cursor', model: 'composer', outputValidity: 'comparable' });
  const observedCursor = selectAmbiguityCandidate(codexParent);
  assert.deepEqual({ provider: observedCursor.provider, model: observedCursor.model, independentBy: observedCursor.independentBy }, {
    provider: 'cursor', model: 'composer', independentBy: 'provider'
  });
}));

test('the independent planner budget remains provider-specific', () => {
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
  assert.doesNotMatch(prompt, /final message must END with the fenced JSON/);
  const cursorPrompt = planPrompt('Objective: inspect the bounded change', { provider: 'cursor', model: 'composer' });
  assert.match(cursorPrompt, /process narration without the structural\s+JSON deliverable is invalid/);
  assert.match(cursorPrompt, /entire final message must be the single fenced\s+JSON object/);
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
  assert.equal(presented.provider, 'codex');
  assert.equal(Object.hasOwn(presented.pendingInput, 'requestAliases'), false);
  assert.equal(presented.status, 'running');
  assert.equal(presented.planning.state, 'awaiting-confirmation');
  assert.equal(presented.pendingInput.requiresHumanDecision, true);
  assert.equal(presented.pendingInput.defaultAction, 'reject');
  const requested = readJobEvents(created.id).find((event) => event.type === 'input.requested');
  assert.equal(requested.data.requiresHumanDecision, true);
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

test('an invalid Cursor probe falls back once to a parent-provider model and preserves both attempt costs', () => isolated(async (directory) => {
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  appendPlanProbeAudit(directory, { provider: 'cursor', model: 'composer', outputValidity: 'comparable' });
  process.env.FAKE_CURSOR_PLAN_RESPONSE = 'invalid';
  process.env.FAKE_CURSOR_PLAN_OUTPUT_TOKENS = '9024';
  const cursorLog = path.join(directory, 'cursor-invalid-plan.jsonl');
  process.env.FAKE_CURSOR_REQUEST_LOG = cursorLog;
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    maxOutputTokens: 100_000,
    planFirst: true,
    ambiguityCheck: true
  });
  const running = runManagedProvider(created);
  const launched = await waitForPlanFirstLaunch(created.id);
  assert.equal(launched.launchNotice.state, 'completed');
  assert.equal(launched.launchNotice.reason, 'plan-structural-output-invalid:no-valid-structural-json');
  assert.match(launched.launchNotice.message, /Structurally invalid probe: plan-structural-output-invalid:no-valid-structural-json/);
  const presented = await waitFor(created.id, (job) => job.pendingInput?.kind === 'plan-confirmation', "pendingInput.kind === 'plan-confirmation'");
  assert.equal(presented.planning.comparison.verdict, 'convergent');
  assert.equal(presented.planPass.state, 'completed');
  assert.equal(presented.planPass.attemptCount, 2);
  assert.equal(presented.planPass.attempts.length, 2);
  const [invalidProbe, fallback] = presented.planPass.attempts;
  assert.equal(invalidProbe.role, 'independent-probe');
  assert.equal(invalidProbe.provider, 'cursor');
  assert.equal(invalidProbe.outputTokens, 9_024);
  assert.equal(invalidProbe.reason, 'plan-structural-output-invalid:no-valid-structural-json');
  assert.equal(invalidProbe.parserReason, 'no-valid-structural-json');
  assert.equal(invalidProbe.structurallyInvalid, true);
  assert.equal(invalidProbe.probeStatus, 'completed');
  assert.equal(invalidProbe.outputValidity, 'unparseable');
  assert.equal(invalidProbe.wastedOutputTokens, 9_024);
  assert.equal(fallback.role, 'model-fallback');
  assert.equal(fallback.provider, 'codex');
  assert.equal(fallback.model, 'luna');
  assert.equal(fallback.state, 'completed');
  assert.equal(fallback.probeStatus, 'completed');
  assert.equal(fallback.outputValidity, 'comparable');
  assert.equal(fallback.wastedOutputTokens, 0);
  assert.equal(presented.planPass.totalOutputTokens, invalidProbe.outputTokens + fallback.outputTokens);
  assert.equal(presented.planPass.wastedOutputTokens, invalidProbe.outputTokens);
  assert.equal(presented.planning.externalOutputTokensReserved, presented.planPass.totalOutputTokens);
  assert.equal(launched.launchNotice.planAttempts.length, 2);
  assert.equal(launched.launchNotice.totalPlanOutputTokens, presented.planPass.totalOutputTokens);
  assert.equal(launched.launchNotice.wastedPlanOutputTokens, invalidProbe.outputTokens);
  assert.equal(readJobEvents(created.id).filter((event) => event.type === 'plan.ambiguity.started'
    && event.data.attemptRole === 'model-fallback').length, 1);
  const requests = fs.readFileSync(cursorLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const cursorPlanPrompt = requests.find((request) => request.method === 'session/prompt').params.prompt[0].text;
  assert.match(cursorPlanPrompt, /process narration without the structural\s+JSON deliverable is invalid/);
  assert.match(cursorPlanPrompt, /entire final message must be the single fenced\s+JSON object/);
  submitControl(created.id, {
    type: 'respond',
    requestId: presented.pendingInput.requestId,
    accept: true,
    commandId: 'confirm-after-model-fallback'
  }, presented.revision);
  await running;
  assert.equal(inspectJob(created.id).status, 'completed');
}));

test('timeout, quota, and provider failures never trigger the structural-invalid fallback', () => isolated(async (directory) => {
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  for (const [name, errorCode] of [
    ['timeout', 'TIMEOUT'],
    ['quota', 'QUOTA_GUARD'],
    ['provider', 'PROVIDER_ERROR']
  ]) {
    const cwd = path.join(directory, name);
    fs.mkdirSync(cwd);
    const parent = createManagedJob({
      provider: 'codex',
      model: 'sol',
      mode: 'implement',
      cwd,
      prompt: `Implement the ${name} case`,
      maxOutputTokens: 100_000,
      planFirst: true,
      ambiguityCheck: true
    });
    const probe = createManagedJob({
      provider: 'cursor',
      model: 'composer',
      mode: 'plan',
      cwd,
      prompt: planPrompt(`Implement the ${name} case`, { provider: 'cursor', model: 'composer' }),
      maxOutputTokens: 12_288,
      planningFor: parent.id,
      planFirst: false,
      ambiguityCheck: false,
      idempotencyKey: `ambiguity-${parent.id}`
    });
    updateManagedJob(parent.id, (job) => {
      job.planning.ambiguity = {
        enabled: true,
        state: 'running',
        jobId: probe.id,
        provider: 'cursor',
        model: 'composer',
        independentBy: 'provider',
        outputTokenLimit: 12_288
      };
      job.planPass = { state: 'running', jobId: probe.id, outputTokenLimit: 12_288 };
    }, { incrementRevision: false });
    updateManagedJob(probe.id, (job) => {
      job.status = 'failed';
      job.phase = 'failed';
      job.errorCode = errorCode;
      job.resultText = 'Provider stopped without a structural object.';
      job.usage = { total: { inputTokens: 10, outputTokens: 25 } };
    }, { incrementRevision: false });
    const returned = await awaitAmbiguityProbe(parent.id);
    assert.equal(returned.id, probe.id);
    const inspected = inspectJob(parent.id);
    assert.equal(inspected.planPass.attempts.length, 1, `${name} must not launch a fallback`);
    assert.equal(inspected.planPass.attempts[0].fallbackEligible, false);
    assert.equal(inspected.planPass.attempts[0].parserReason, undefined);
    assert.equal(inspected.planPass.reason, `plan-pass-failed:${errorCode}`);
    assert.equal(readJobEvents(parent.id).filter((event) => event.type === 'plan.ambiguity.started'
      && event.data.attemptRole === 'model-fallback').length, 0);
  }
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

test('a failed independent plan pass degrades loudly and requires one explicit implement confirmation', () => isolated(async (directory) => {
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
  assert.equal(presented.planPass.attempts.length, 1);
  assert.equal(presented.planPass.attempts[0].fallbackEligible, false);
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
  assert.equal(readJobEvents(created.id).filter((event) => event.type === 'plan.ambiguity.started'
    && event.data.attemptRole === 'model-fallback').length, 0);
}));

test('a primary plan that breaches the hard limit retries once at the stored ceiling and succeeds', () => isolated(async (directory) => {
  process.env.DELEGATE_PLAN_OUTPUT_TOKENS = '8192';
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS = '12139';
  process.env.FAKE_CODEX_PLAN_RETRY_OUTPUT_TOKENS = '12000';
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    planFirst: true,
    ambiguityCheck: false
  });
  const running = runManagedProvider(created);
  const presented = await waitFor(
    created.id,
    (job) => job.pendingInput?.kind === 'plan-confirmation',
    "pendingInput.kind === 'plan-confirmation' after the ceiling retry"
  );
  assert.equal(presented.planning.state, 'awaiting-confirmation');
  assert.equal(presented.planning.retryCount, 1);
  assert.equal(presented.planning.planBudget.limit, 8192);
  assert.equal(presented.planning.planBudget.ceiling, 16384);
  assert.equal(presented.planning.planBudget.retryLimit, 16384);
  assert.equal(presented.planning.planOutputTokenLimit, 16384);
  const events = readJobEvents(created.id);
  assert.deepEqual(events.filter((event) => event.type === 'usage.updated')
    .map((event) => event.data.last?.outputTokens), [12139, 12000]);
  assert.deepEqual(presented.planning.attempts.map((attempt) => ({
    attempt: attempt.attempt,
    state: attempt.state,
    outputTokens: attempt.outputTokens,
    outputTokenLimit: attempt.outputTokenLimit
  })), [
    { attempt: 1, state: 'retrying', outputTokens: 12139, outputTokenLimit: 8192 },
    { attempt: 2, state: 'completed', outputTokens: 12000, outputTokenLimit: 16384 }
  ]);
  assert.equal(events.filter((event) => event.type === 'plan.retry.started').length, 1);
  assert.equal(events.filter((event) => event.type === 'plan.retry.completed').length, 1);
  assert.equal(events.filter((event) => event.type === 'plan.degraded').length, 0);
  submitControl(created.id, {
    type: 'respond',
    requestId: presented.pendingInput.requestId,
    accept: true,
    commandId: 'confirm-plan-after-ceiling-retry'
  }, presented.revision);
  await running;
  assert.equal(inspectJob(created.id).status, 'completed');
}));

test('a degraded write plan remains gated and a human decline has a healthy declined conclusion', () => isolated(async (directory) => {
  process.env.DELEGATE_PLAN_OUTPUT_TOKENS = '8192';
  process.env.FAKE_CODEX_PLAN_OUTPUT_TOKENS = '12139';
  process.env.FAKE_CODEX_PLAN_RETRY_OUTPUT_TOKENS = '20000';
  const created = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    planFirst: true,
    ambiguityCheck: false
  });
  const running = runManagedProvider(created);
  const gated = await waitFor(
    created.id,
    (job) => job.planning?.state === 'degraded' && job.pendingInput?.kind === 'plan-confirmation',
    "planning.state === 'degraded' at a human gate"
  );
  assert.equal(gated.status, 'running');
  assert.equal(gated.phase, 'user-input-required');
  assert.equal(gated.attention.state, 'user-input-required');
  assert.equal(gated.planning.confirmationRequired, true);
  assert.equal(gated.planning.retryCount, 1);
  assert.equal(readJobEvents(created.id).filter((event) => event.type === 'file.changed').length, 0);
  submitControl(created.id, {
    type: 'respond',
    requestId: gated.pendingInput.requestId,
    accept: false,
    commandId: 'decline-degraded-plan'
  }, gated.revision);
  await running;
  const declined = inspectJob(created.id);
  assert.equal(declined.status, 'cancelled');
  assert.equal(declined.phase, 'plan-declined');
  assert.deepEqual(declined.conclusion, {
    disposition: 'declined',
    health: 'healthy',
    reason: 'plan-declined'
  });
  const declinedEvent = readJobEvents(created.id).find((event) => event.type === 'plan.declined');
  assert.deepEqual(declinedEvent.data.conclusion, declined.conclusion);

  const failed = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'failed comparison' });
  updateManagedJob(failed.id, (current) => {
    current.status = 'failed';
    current.phase = 'failed';
    current.errorCode = 'PROVIDER_ERROR';
  });
  assert.deepEqual(inspectJob(failed.id).conclusion, {
    disposition: 'failed',
    health: 'unhealthy',
    reason: 'PROVIDER_ERROR'
  });
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
    assert.equal(result.launchNotice.outputTokenLimit, 16_384);
    assert.match(result.launchNotice.message, /observed 66428 output tokens vs cap 16384/);
    assert.equal(result.launchNotice.blocking, true);
    assert.match(result.launchNotice.message, /paused for explicit plan confirmation/);
  };
  const decline = async (id, commandId) => {
    const gated = await waitFor(id, (job) => job.pendingInput?.kind === 'plan-confirmation', 'degraded plan confirmation gate');
    submitControl(id, {
      type: 'respond',
      requestId: gated.pendingInput.requestId,
      accept: false,
      commandId
    }, gated.revision);
    return waitFor(id, (job) => job.status === 'cancelled', 'declined job to become cancelled');
  };

  const cli = spawnSync(process.execPath, [
    jobsCli, 'start',
    '--provider', 'codex',
    '--model', 'sol',
    '--mode', 'implement',
    '--cwd', directory,
    '--no-ambiguity-check',
    '--prompt', packet
  ], { encoding: 'utf8', env: process.env, timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assertWarning(cliResult);
  await decline(cliResult.id, 'decline-cli-degraded-plan');

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
        ambiguityCheck: false,
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
  await decline(mcpResult.id, 'decline-mcp-degraded-plan');
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

// recordPrimaryPlanDegradation() writes planning.state='degraded' together with
// confirmationRequired=true, and the confirmation gate is opened by a later,
// separate write. waitForPlanFirstLaunch() used to return inside that window,
// reporting blocking:false for a job that was about to pause for a human
// decision — a caller trusting it would proceed as though no gate were coming.
// This reproduced as a ~33% flake at test/planning-interrogation.test.mjs:1310,
// where every assertion passed except blocking. Pin the window directly rather
// than racing for it.
test('a degraded launch notice waits for the confirmation gate instead of reporting blocking:false', () => isolated(async (directory) => {
  process.env.DELEGATE_PLAN_LAUNCH_WAIT_SECONDS = '5';
  const job = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    planFirst: true,
    ambiguityCheck: false
  });
  // The exact state recordPrimaryPlanDegradation leaves behind: degraded, a
  // confirmation already known to be required, and no gate written yet.
  updateManagedJob(job.id, (current) => {
    current.planning = {
      ...current.planning,
      state: 'degraded',
      degraded: true,
      confirmationRequired: true,
      reason: 'runaway-plan-output-token-budget-exceeded',
      outputTokens: 66_428,
      outputTokenLimit: 16_384
    };
    current.pendingInput = null;
  }, { incrementRevision: false });

  let settled = false;
  const waiting = waitForPlanFirstLaunch(job.id).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false, 'the wait must not resolve while the gate it implies is still unwritten');

  updateManagedJob(job.id, (current) => {
    current.pendingInput = {
      requestId: 'plan-deterministic-gate',
      kind: 'plan-confirmation',
      requiresHumanDecision: true,
      question: 'Confirm the degraded plan.',
      options: ['accept-plan', 'decline-plan']
    };
  }, { incrementRevision: false });

  const result = await waiting;
  assert.equal(result.launchNotice.state, 'degraded');
  assert.equal(result.launchNotice.blocking, true, 'once the gate exists the notice must say it blocks');
}));

test('a degraded notice whose gate never opens still reports itself rather than the pending notice', () => isolated(async (directory) => {
  process.env.DELEGATE_PLAN_LAUNCH_WAIT_SECONDS = '1';
  const job = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: directory,
    prompt: 'Implement the bounded change',
    planFirst: true,
    ambiguityCheck: false
  });
  updateManagedJob(job.id, (current) => {
    current.planning = {
      ...current.planning,
      state: 'degraded',
      degraded: true,
      confirmationRequired: true,
      reason: 'runaway-plan-output-token-budget-exceeded',
      outputTokens: 66_428,
      outputTokenLimit: 16_384
    };
    current.pendingInput = null;
  }, { incrementRevision: false });

  const result = await waitForPlanFirstLaunch(job.id);
  // Waiting must not cost the caller the degraded evidence. On expiry
  // blocking:false is a measurement of a gate that never opened, not a race.
  assert.equal(result.launchNotice.state, 'degraded');
  assert.equal(result.launchNotice.reason, 'runaway-plan-output-token-budget-exceeded');
  assert.equal(result.launchNotice.blocking, false);
}));
