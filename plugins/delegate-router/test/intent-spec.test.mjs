import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compileIntentSpec,
  confirmCompiledSpec,
  launchOptionsFromCompilation,
  NEVER_INFER_FIELDS,
  previewOptionsFromCompilation
} from '../bin/lib/intent-spec.mjs';
import { previewManagedJob } from '../bin/lib/control.mjs';
import { assembleProviderPrompt } from '../bin/lib/packet.mjs';
import { lintPacket, lintPacketDetails } from '../bin/lib/profiles.mjs';
import { projectJobAsWorkItem } from '../bin/lib/work-projection.mjs';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jobsCli = path.join(plugin, 'bin', 'delegate-jobs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result;
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-intent-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'feature.mjs'), 'export const feature = false;\n');
  fs.writeFileSync(path.join(root, 'test', 'feature.test.mjs'), 'import "../src/feature.mjs";\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `# Instructions

## Verification

\`\`\`bash
node --test test/*.test.mjs
\`\`\`
`);
  run('git', ['init', '-q'], root);
  run('git', ['add', '.'], root);
  run('git', ['-c', 'user.name=Delegate Test', '-c', 'user.email=delegate@example.invalid', 'commit', '-qm', 'fixture'], root);
  return root;
}

function completeOptions(root, overrides = {}) {
  return {
    cwd: root,
    mode: 'implement',
    sources: [{ kind: 'sentence', text: 'Enable the feature in `src/feature.mjs`.' }],
    explicit: {
      scopeClaim: ['src/feature.mjs', 'test/feature.test.mjs'],
      acceptanceCriteria: ['The feature is enabled.', 'The repository verification recipe passes.'],
      budget: { wallTimeSeconds: 900, maxRounds: 2, maxOutputTokens: 4000 }
    },
    authority: { allowedPaths: ['src/feature.mjs', 'test/feature.test.mjs'] },
    ...overrides
  };
}

test('sentence intent compiles a valid WorkSpec with visible provenance and P3 verification', (t) => {
  const root = repository(t);
  const compilation = compileIntentSpec(completeOptions(root));
  assert.equal(compilation.ready, true);
  assert.equal(compilation.workSpec.objective, 'Enable the feature in `src/feature.mjs`.');
  assert.deepEqual(compilation.workSpec.scopeClaim, ['src/feature.mjs', 'test/feature.test.mjs']);
  assert.equal(compilation.fields.objective.status, 'inferred');
  assert.equal(compilation.fields.objective.confidence, 'high');
  assert.match(compilation.fields.objective.provenance[0].kind, /^intent:sentence$/);
  assert.equal(compilation.fields.verifyRecipe.confidence, 'high');
  assert.equal(compilation.workSpec.verifyRecipe.command, 'node --test test/*.test.mjs');
  assert.equal(compilation.workSpec.verifyRecipe.commands[0].cwd, '.');
  assert.match(compilation.card, /WorkSpec confirmation/);
  assert.match(compilation.card, /HIGH · INFERRED/);
  assert.match(compilation.card, /WRITE DISPATCH: READY FOR EXPLICIT CONFIRMATION/);
});

test('plain intent never omits unresolved scope, criteria, budget, or write authority', (t) => {
  const root = repository(t);
  const compilation = compileIntentSpec({
    cwd: root,
    mode: 'implement',
    sources: [{ kind: 'sentence', text: 'Make the behavior safer.' }]
  });
  for (const field of ['scopeClaim', 'acceptanceCriteria', 'budget', 'authority.allowedPaths']) {
    assert.ok(compilation.unresolved.includes(field), field);
  }
  assert.equal(compilation.ready, false);
  assert.equal(compilation.workSpec, null);
  assert.match(compilation.card, /UNRESOLVED:/);
  assert.match(compilation.card, /WRITE DISPATCH: BLOCKED/);
  assert.throws(() => confirmCompiledSpec(compilation), /cannot be confirmed while unresolved/);
});

test('current diff supplies an attributable scope claim without turning it into allowedPaths', (t) => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, 'src', 'feature.mjs'), 'export const feature = true;\n');
  fs.writeFileSync(path.join(root, 'test', 'new.test.mjs'), 'import "../src/feature.mjs";\n');
  const compilation = compileIntentSpec({
    cwd: root,
    mode: 'implement',
    sources: [{ kind: 'diff' }],
    explicit: {
      acceptanceCriteria: ['The current change is completed and verified.'],
      budget: { wallTimeSeconds: 600, maxRounds: 1, maxOutputTokens: 2000 }
    }
  });
  assert.equal(compilation.fields.scopeClaim.status, 'inferred');
  assert.equal(compilation.fields.scopeClaim.confidence, 'medium');
  assert.deepEqual(compilation.fields.scopeClaim.value, ['src/feature.mjs', 'test/new.test.mjs']);
  assert.equal(compilation.authority.allowedPaths.value, null);
  assert.ok(compilation.unresolved.includes('authority.allowedPaths'));
  assert.match(compilation.fields.scopeClaim.provenance[0].kind, /repo:git-status/);
});

test('failing check derives a mechanical criterion but keeps diagnostic scope low-confidence', (t) => {
  const root = repository(t);
  const compilation = compileIntentSpec({
    cwd: root,
    mode: 'implement',
    sources: [{
      kind: 'failure',
      text: 'FAIL test/feature.test.mjs:12\nAssertionError: expected true but received false'
    }],
    explicit: { budget: { wallTimeSeconds: 600, maxRounds: 1, maxOutputTokens: 2000 } }
  });
  assert.equal(compilation.fields.objective.confidence, 'medium');
  assert.equal(compilation.fields.acceptanceCriteria.confidence, 'medium');
  assert.equal(compilation.fields.scopeClaim.confidence, 'low');
  assert.deepEqual(compilation.fields.scopeClaim.candidate, ['test/feature.test.mjs']);
  assert.ok(compilation.unresolved.includes('scopeClaim'));
  assert.match(compilation.card, /LOW · UNRESOLVED/);
});

test('TODO intent derives the exact comment and its file without reading outside the repository', (t) => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, 'src', 'feature.mjs'), '// TODO: enable the guarded feature\nexport const feature = false;\n');
  const compilation = compileIntentSpec({
    ...completeOptions(root),
    sources: [{ kind: 'todo', path: 'src/feature.mjs:1' }]
  });
  assert.equal(compilation.fields.objective.value, 'enable the guarded feature');
  assert.equal(compilation.fields.objective.confidence, 'high');
  assert.match(compilation.fields.objective.provenance[0].source, /src\/feature\.mjs:1/);
  assert.throws(() => compileIntentSpec({
    cwd: root,
    sources: [{ kind: 'todo', path: '../outside.mjs' }]
  }), /inside the repository/);
});

test('task records are evidence, never an implicit allowedPaths grant', (t) => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, 'task.json'), `${JSON.stringify({
    objective: 'Enable the recorded feature',
    allowedPaths: ['src/feature.mjs'],
    acceptanceCriteria: ['The recorded feature is enabled'],
    budget: { wallTimeSeconds: 700, maxRounds: 2, maxOutputTokens: 2500 }
  })}\n`);
  const compilation = compileIntentSpec({
    cwd: root,
    mode: 'implement',
    sources: [{ kind: 'task-record', path: 'task.json' }]
  });
  assert.deepEqual(compilation.fields.scopeClaim.value, ['src/feature.mjs']);
  assert.equal(compilation.fields.scopeClaim.status, 'inferred');
  assert.equal(compilation.authority.allowedPaths.value, null);
  assert.ok(compilation.unresolved.includes('authority.allowedPaths'));
  assert.match(compilation.fields.scopeClaim.note, /does not grant allowedPaths/);
});

test('repository conventions fill verification only and expose the remaining gaps', (t) => {
  const root = repository(t);
  const compilation = compileIntentSpec({
    cwd: root,
    mode: 'implement',
    sources: [{ kind: 'conventions' }]
  });
  assert.equal(compilation.fields.verifyRecipe.status, 'inferred');
  assert.equal(compilation.fields.verifyRecipe.confidence, 'high');
  assert.equal(compilation.fields.objective.status, 'unresolved');
  assert.ok(compilation.unresolved.includes('objective'));
  assert.ok(compilation.unresolved.includes('acceptanceCriteria'));
});

test('confirmation is the only bridge to launch options and never adds privilege fields', (t) => {
  const root = repository(t);
  const compilation = compileIntentSpec(completeOptions(root));
  const preview = previewOptionsFromCompilation(compilation);
  assert.equal(preview.specCompilation.confirmed, false);
  assert.throws(() => launchOptionsFromCompilation(compilation), /requires explicit confirmation/);
  const confirmed = confirmCompiledSpec(compilation, 'automation-flag');
  const options = launchOptionsFromCompilation(confirmed);
  assert.equal(options.specCompilation.confirmed, true);
  assert.equal(options.timeoutSeconds, 900);
  assert.equal(options.maxOutputTokens, 4000);
  for (const field of ['network', 'sandbox', 'approval', 'allowSensitive', 'overrideWriter']) {
    assert.equal(Object.hasOwn(options, field), false, field);
  }
  assert.deepEqual(NEVER_INFER_FIELDS, [
    'scope widening beyond the stated intent',
    'network access',
    'sandbox disablement',
    'budget increases',
    'allowedPaths',
    'privileges'
  ]);
});

test('compiled WorkSpec reaches the existing start preview and plan-first packet', (t) => {
  const root = repository(t);
  const compilation = confirmCompiledSpec(compileIntentSpec(completeOptions(root)), 'automation-flag');
  const compiled = launchOptionsFromCompilation(compilation);
  const preview = previewManagedJob({
    provider: 'codex',
    mode: 'implement',
    cwd: root,
    allowedPaths: ['src/feature.mjs', 'test/feature.test.mjs'],
    ...compiled
  });
  assert.equal(preview.planFirst, true);
  assert.equal(preview.specCompilation.confirmed, true);
  assert.equal(preview.workSpec.objective, compilation.workSpec.objective);
  assert.match(preview.packet, /Objective:\nEnable the feature/);
  assert.match(preview.packet, /Required verification:/);
  assert.equal(projectJobAsWorkItem({ id: 'compiled-attempt', workSpec: preview.workSpec }).spec.objective, compilation.workSpec.objective);
});

test('hand-written packets retain their exact provider packet and lint contract', (t) => {
  const root = repository(t);
  const packet = `Objective:
Keep the legacy packet.

Allowed scope:
src/feature.mjs

Acceptance criteria:
The packet stays byte-identical.

Return:
Outcome.`;
  const preview = previewManagedJob({
    provider: 'codex',
    mode: 'review',
    cwd: root,
    prompt: packet
  });
  assert.equal(preview.packet, assembleProviderPrompt({
    allowSensitive: false,
    allowedPaths: null,
    stagingDir: null,
    reportSchema: null
  }, packet));
  assert.equal(preview.workSpec, null);
  assert.equal(preview.specCompilation, null);
  assert.deepEqual(lintPacket(packet), []);
});

test('packet lint details name the compiler field that fills each missing section', () => {
  const packet = 'Objective:\nInspect it.';
  assert.deepEqual(lintPacket(packet), ['Allowed scope', 'Acceptance criteria', 'Return']);
  assert.deepEqual(lintPacketDetails(packet).map(({ section, inferredField }) => [section, inferredField]), [
    ['Allowed scope', 'scopeClaim'],
    ['Acceptance criteria', 'acceptanceCriteria'],
    ['Return', 'returnContract']
  ]);
});

test('CLI spec renders one card without creating broker state', (t) => {
  const root = repository(t);
  const stateFile = path.join(root, '.state', 'usage.json');
  const result = spawnSync(process.execPath, [
    jobsCli, 'spec',
    '--cwd', root,
    '--intent', 'Enable `src/feature.mjs`.',
    '--allowed-paths', 'src/feature.mjs,test/feature.test.mjs',
    '--acceptance', 'The feature is enabled.',
    '--timeout-seconds', '600',
    '--max-rounds', '1',
    '--max-output-tokens', '2000'
  ], {
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_STATE_FILE: stateFile, DELEGATE_ENABLED_PROVIDERS: 'codex,cursor' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^┌─ WorkSpec confirmation/m);
  assert.match(result.stdout, /WRITE DISPATCH: READY FOR EXPLICIT CONFIRMATION/);
  assert.equal(fs.existsSync(stateFile), false);
});

test('CLI intent starts never auto-launch writes and automation cannot confirm gaps', (t) => {
  const root = repository(t);
  const stateFile = path.join(root, '.state', 'usage.json');
  const common = [
    jobsCli, 'start',
    '--provider', 'codex',
    '--cwd', root,
    '--mode', 'implement',
    '--intent', 'Enable `src/feature.mjs`.',
    '--allowed-paths', 'src/feature.mjs,test/feature.test.mjs',
    '--acceptance', 'The feature is enabled.',
    '--timeout-seconds', '600',
    '--max-rounds', '1',
    '--max-output-tokens', '2000'
  ];
  const env = { ...process.env, DELEGATE_STATE_FILE: stateFile, DELEGATE_ENABLED_PROVIDERS: 'codex,cursor' };
  const unconfirmed = spawnSync(process.execPath, common, { encoding: 'utf8', env });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /requires interactive confirmation/);
  assert.match(unconfirmed.stderr, /WorkSpec confirmation/);
  assert.equal(fs.existsSync(path.join(path.dirname(stateFile), 'jobs')), false);

  const incomplete = spawnSync(process.execPath, [
    jobsCli, 'start',
    '--provider', 'codex',
    '--cwd', root,
    '--mode', 'implement',
    '--intent', 'Make it safer.',
    '--accept-spec'
  ], { encoding: 'utf8', env });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /WorkSpec has unresolved fields/);
  assert.match(incomplete.stderr, /WRITE DISPATCH: BLOCKED/);
  assert.equal(fs.existsSync(path.join(path.dirname(stateFile), 'jobs')), false);
});
