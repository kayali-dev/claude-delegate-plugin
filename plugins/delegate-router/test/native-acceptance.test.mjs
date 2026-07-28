import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createManagedJob,
  decideAcceptance,
  inspectJob
} from '../bin/lib/control.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { listJobs, saveJob } from '../bin/lib/state.mjs';
import {
  AUTO_FIX_HARD_CAP,
  autoFixMadeProgress,
  evaluateAutoFix
} from '../bin/lib/acceptance.mjs';
import { deriveVerificationProfile } from '../bin/lib/verification-profile.mjs';
import { detectActionableEdges, formatEdgeLine } from '../bin/lib/monitor-policy.mjs';
import { projectJobAsWorkItem } from '../bin/lib/work-projection.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(testDirectory);
const fakeCodex = path.join(testDirectory, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDirectory, 'fake-cursor-acp.mjs');
const cli = path.join(pluginRoot, 'bin', 'delegate-jobs');
const mcp = path.join(pluginRoot, 'bin', 'delegate-control-mcp');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function gitInit(directory) {
  const result = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function scenario(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  gitInit(directory);
  return directory;
}

async function cursorWrite(cwd, options = {}) {
  process.env.FAKE_CURSOR_WRITE = '1';
  const job = createManagedJob({
    provider: 'cursor',
    model: 'composer',
    mode: 'implement',
    cwd,
    prompt: 'make the fixture write',
    allowedPaths: ['new-file.txt', 'staged-file.txt', 'a.js'],
    ...options
  });
  await runManagedProvider(job);
  return inspectJob(job.id);
}

test('P3 derives verification, records real-tree evidence, gates additive acceptance, and bounds opt-in fix rounds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-native-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const previous = Object.fromEntries([
    'DELEGATE_STATE_FILE',
    'DELEGATE_ENABLED_PROVIDERS',
    'DELEGATE_CODEX_BIN',
    'DELEGATE_CURSOR_BIN',
    'DELEGATE_CURSOR_LOGIN_SHELL',
    'DELEGATE_VERIFY',
    'FAKE_CURSOR_WRITE',
    'FAKE_CODEX_FILE_CHANGES'
  ].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';

  const liveFixture = path.join(testDirectory, 'fixtures', 'native-acceptance-live');
  const liveProfile = deriveVerificationProfile(liveFixture, { cache: false });
  assert.equal(liveProfile.recipe.source.kind, 'instructions');
  assert.equal(liveProfile.recipe.commands[0].command, 'node verify.mjs');
  const liveCheck = spawnSync(process.execPath, ['verify.mjs'], { cwd: liveFixture, encoding: 'utf8' });
  assert.equal(liveCheck.status, 0, liveCheck.stderr);
  assert.match(liveCheck.stdout, /native acceptance live fixture passed/);

  const instructions = scenario(root, 'instructions');
  write(path.join(instructions, 'AGENTS.md'), '# Commands\n\n```bash\nnpm run instruction-check\n```\n');
  write(path.join(instructions, 'package.json'), JSON.stringify({ scripts: { check: 'node manifest-check.mjs' } }));
  const instructionProfile = deriveVerificationProfile(instructions, { cacheDirectory: path.join(root, 'cache') });
  assert.equal(instructionProfile.recipe.source.kind, 'instructions');
  assert.equal(instructionProfile.recipe.commands[0].command, 'npm run instruction-check');
  assert.equal(deriveVerificationProfile(instructions, { cacheDirectory: path.join(root, 'cache') }).cache.state, 'hit');

  const manifest = scenario(root, 'manifest');
  write(path.join(manifest, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@10.0.0',
    scripts: { check: 'node check.mjs', test: 'node --test', lint: 'eslint .' }
  }));
  const manifestProfile = deriveVerificationProfile(manifest, { cacheDirectory: path.join(root, 'cache') });
  assert.equal(manifestProfile.recipe.source.kind, 'package-manifest');
  assert.deepEqual(manifestProfile.recipe.commands.map((entry) => entry.command), ['pnpm run check']);

  const empty = scenario(root, 'empty');
  const emptyProfile = deriveVerificationProfile(empty, { cacheDirectory: path.join(root, 'cache') });
  assert.equal(emptyProfile.recipe, null);
  assert.match(emptyProfile.noRecipeReason, /No non-mutating verification command/);
  const noRecipe = createManagedJob({ provider: 'codex', mode: 'implement', cwd: empty, prompt: 'write if possible' });
  assert.equal(noRecipe.verification.state, 'no-recipe');
  assert.match(noRecipe.verification.reason, /No non-mutating verification command/);

  const passed = await cursorWrite(scenario(root, 'passed'), {
    verify: {
      command: 'node -e "if (!require(\'fs\').existsSync(\'new-file.txt\')) process.exit(9)"',
      timeoutSeconds: 10
    }
  });
  assert.equal(passed.status, 'completed');
  assert.equal(passed.verificationOrigin, 'broker');
  assert.equal(passed.verification.state, 'passed');
  assert.equal(passed.verification.exitCode, 0);
  assert.equal(passed.verification.inputChanged, false);
  assert.equal(passed.acceptance.state, 'ready-for-review');
  assert.equal(passed.acceptance.decidedBy, 'broker');
  assert.notEqual(passed.acceptance.state, 'accepted');

  const failed = await cursorWrite(scenario(root, 'failed'), {
    verify: { command: 'node -e "console.log(\'fail 2\'); process.exit(2)"', timeoutSeconds: 10 }
  });
  assert.equal(failed.status, 'completed');
  assert.equal(failed.verification.state, 'failed');
  assert.ok(failed.acceptance.blockedBy.includes('verification-failed'));
  const originalRepeatedFailure = structuredClone(failed.verification);
  const repeatedFailure = spawnSync(process.execPath, [cli, 'verify', failed.id], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.equal(repeatedFailure.status, 6, repeatedFailure.stderr);
  const stillFailed = inspectJob(failed.id);
  assert.equal(stillFailed.verificationEvidence.length, 2);
  assert.deepEqual(stillFailed.verificationEvidence[0], originalRepeatedFailure);
  assert.equal(stillFailed.verificationEvidence[1].state, 'failed');
  assert.equal(stillFailed.verificationEvidence[1].evidenceKind, 'reverification');
  assert.equal(stillFailed.acceptance.state, 'blocked');
  assert.ok(stillFailed.acceptance.blockedBy.includes('verification-failed'));
  const overrideAttempt = spawnSync(process.execPath, [
    cli,
    'verify',
    failed.id,
    '--verify-command',
    'node -e "process.exit(0)"'
  ], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.notEqual(overrideAttempt.status, 0);
  assert.match(overrideAttempt.stderr, /always reuses the recorded command/);
  assert.equal(inspectJob(failed.id).verificationEvidence.length, 2);
  const jobCountBeforeMcpReverification = listJobs().length;
  const rerunThroughMcp = spawnSync(process.execPath, [mcp], {
    encoding: 'utf8',
    env: { ...process.env },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'delegate_verify',
      arguments: { jobId: failed.id }
    } })}\n`
  });
  assert.equal(rerunThroughMcp.status, 0, rerunThroughMcp.stderr);
  const rerunThroughMcpPayload = JSON.parse(JSON.parse(rerunThroughMcp.stdout.trim()).result.content[0].text);
  assert.equal(rerunThroughMcpPayload.verification.state, 'failed');
  assert.equal(rerunThroughMcpPayload.verificationEvidence.length, 3);
  assert.deepEqual(rerunThroughMcpPayload.verificationEvidence[0], originalRepeatedFailure);
  assert.equal(listJobs().length, jobCountBeforeMcpReverification, 'local re-verification never creates a provider job');

  const repairedDirectory = scenario(root, 'repaired');
  write(path.join(repairedDirectory, 'verification-state.txt'), 'fail');
  const repairable = await cursorWrite(repairedDirectory, {
    verify: {
      command: 'node -e "if (require(\'fs\').readFileSync(\'verification-state.txt\', \'utf8\') !== \'pass\') process.exit(8)"',
      timeoutSeconds: 10
    }
  });
  const originalRepairableFailure = structuredClone(repairable.verification);
  assert.equal(originalRepairableFailure.state, 'failed');
  const jobCountBeforeReverification = listJobs().length;
  write(path.join(repairedDirectory, 'verification-state.txt'), 'pass');
  const repaired = spawnSync(process.execPath, [cli, 'verify', repairable.id], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.equal(repaired.status, 0, repaired.stderr);
  const repairedRecord = inspectJob(repairable.id);
  assert.equal(repairedRecord.verificationEvidence.length, 2);
  assert.deepEqual(repairedRecord.verificationEvidence[0], originalRepairableFailure);
  assert.equal(repairedRecord.verification.state, 'passed');
  assert.equal(repairedRecord.verification.evidenceKind, 'reverification');
  assert.equal(repairedRecord.verification.treeMovedSinceOriginal, true);
  assert.equal(repairedRecord.verification.treeMovedSincePrevious, true);
  assert.notEqual(
    repairedRecord.verificationEvidence[0].completedInput.digest,
    repairedRecord.verificationEvidence[1].input.digest
  );
  assert.equal(repairedRecord.acceptance.state, 'ready-for-review');
  assert.equal(listJobs().length, jobCountBeforeReverification, 'CLI re-verification never creates a provider job');
  const redundantRerun = spawnSync(process.execPath, [cli, 'verify', repairable.id], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.notEqual(redundantRerun.status, 0);
  assert.match(redundantRerun.stderr, /requires a live verification failure, timeout, or stale-input blocker/);
  assert.equal(inspectJob(repairable.id).verificationEvidence.length, 2);
  const acceptedAfterRepair = spawnSync(process.execPath, [cli, 'accept', repairable.id], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.equal(acceptedAfterRepair.status, 0, acceptedAfterRepair.stderr);
  assert.equal(inspectJob(repairable.id).acceptance.state, 'accepted');

  const timedOut = await cursorWrite(scenario(root, 'timeout'), {
    verify: { command: 'node -e "setTimeout(() => {}, 5000)"', timeoutSeconds: 1 }
  });
  assert.equal(timedOut.status, 'completed');
  assert.equal(timedOut.verification.state, 'timeout');
  assert.equal(timedOut.verification.timedOut, true);
  assert.ok(timedOut.acceptance.blockedBy.includes('verification-timeout'));

  process.env.FAKE_CODEX_FILE_CHANGES = '0';
  const zeroDirectory = scenario(root, 'zero');
  const zero = createManagedJob({
    provider: 'codex',
    model: 'sol',
    mode: 'implement',
    cwd: zeroDirectory,
    prompt: 'do not write',
    verify: { command: 'node -e "require(\'fs\').writeFileSync(\'verification-ran\', \'bad\')"', timeoutSeconds: 10 }
  });
  await runManagedProvider(zero);
  const zeroDone = inspectJob(zero.id);
  assert.equal(zeroDone.status, 'completed');
  assert.equal(zeroDone.verification.state, 'skipped');
  assert.ok(zeroDone.acceptance.blockedBy.includes('zero-changed-files'));
  assert.equal(fs.existsSync(path.join(zeroDirectory, 'verification-ran')), false);
  delete process.env.FAKE_CODEX_FILE_CHANGES;

  const scoped = await cursorWrite(scenario(root, 'scope'), {
    allowedPaths: ['allowed-only'],
    verify: { command: 'node -e "process.exit(0)"', timeoutSeconds: 10 }
  });
  assert.equal(scoped.status, 'completed');
  assert.ok(scoped.scopeViolations.length > 0);
  assert.ok(scoped.acceptance.blockedBy.includes('scope-violation'));

  process.env.DELEGATE_VERIFY = 'off';
  const disabled = await cursorWrite(scenario(root, 'disabled'));
  assert.equal(disabled.verification.state, 'skipped');
  assert.equal(disabled.verification.exception, 'DELEGATE_VERIFY=off');
  assert.equal(disabled.verificationOrigin, 'broker-policy');
  delete process.env.DELEGATE_VERIFY;

  const excepted = await cursorWrite(scenario(root, 'excepted'), {
    verify: { exception: 'No reliable non-mutating check exists for this fixture' }
  });
  assert.equal(excepted.verification.state, 'exception');
  assert.match(excepted.verification.reason, /No reliable/);
  assert.equal(excepted.acceptance.state, 'ready-for-review');

  const accepted = spawnSync(process.execPath, [cli, 'accept', passed.id, '--reason', 'owner reviewed evidence'], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  const acceptedRecord = inspectJob(passed.id);
  assert.equal(acceptedRecord.status, 'completed');
  assert.equal(acceptedRecord.acceptance.state, 'accepted');
  assert.match(acceptedRecord.acceptance.decidedBy, /^cli:/);
  assert.equal(acceptedRecord.acceptance.priorState, 'ready-for-review');
  assert.ok(acceptedRecord.acceptance.evidenceDigest);

  const blockedAccept = spawnSync(process.execPath, [cli, 'accept', failed.id], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.notEqual(blockedAccept.status, 0);
  assert.match(blockedAccept.stderr, /ACCEPTANCE_BLOCKED|job is blocked/);
  const rejected = spawnSync(process.execPath, [mcp], {
    encoding: 'utf8',
    env: { ...process.env },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'delegate_decide',
      arguments: { jobId: excepted.id, decision: 'rejected', reason: 'owner declined PASSWORD=synthetic-rejection-secret' }
    } })}\n`
  });
  assert.equal(rejected.status, 0, rejected.stderr);
  const rejectedPayload = JSON.parse(rejected.stdout.trim());
  assert.equal(JSON.parse(rejectedPayload.result.content[0].text).acceptance.state, 'rejected');
  assert.equal(inspectJob(excepted.id).acceptance.decidedBy, 'mcp:coordinator');
  const auditLines = fs.readFileSync(path.join(root, 'state', 'audit.jsonl'), 'utf8').trim().split('\n');
  const decisionAudit = auditLines.map(JSON.parse)
    .find((record) => record.jobId === excepted.id && record.recordType === 'acceptance-decision');
  assert.equal(decisionAudit.acceptanceDecision.decision, 'rejected');
  assert.match(decisionAudit.rejectionReason, /\[REDACTED\]/);
  assert.doesNotMatch(auditLines.join('\n'), /synthetic-rejection-secret/);

  const blockedEdges = detectActionableEdges({ job: failed, events: [], lastEventAt: Date.now() });
  assert.equal(blockedEdges[0].category, 'blocked');
  assert.doesNotMatch(blockedEdges.map((edge) => edge.category).join(','), /ready-for-review/);
  assert.match(formatEdgeLine(blockedEdges[0]), /blocked .*checks failed/);
  const readyEdges = detectActionableEdges({ job: { ...passed, acceptance: passed.acceptance }, events: [], lastEventAt: Date.now() });
  assert.match(formatEdgeLine(readyEdges[0]), /ready-for-review .*checks passed/);
  assert.ok(blockedEdges[0].priority < readyEdges[0].priority);

  const legacyId = 'codex-legacy-no-chain-abcdef';
  const legacyNow = Math.floor(Date.now() / 1000);
  saveJob({
    schemaVersion: 2,
    id: legacyId,
    provider: 'codex',
    mode: 'implement',
    status: 'completed',
    phase: 'completed',
    revision: 0,
    lastSeq: 0,
    cwd: passed.cwd,
    ownerCwd: passed.cwd,
    managedBy: 'delegate-control',
    createdAt: legacyNow - 1,
    updatedAt: legacyNow,
    completedAt: legacyNow,
    changedFiles: { count: 1, files: ['legacy.js'] },
    verificationOrigin: 'broker',
    verification: {
      state: 'passed',
      exitCode: 0,
      inputChanged: false,
      input: { repoRoot: passed.cwd, revision: null, digest: 'legacy-input' },
      completedInput: { repoRoot: passed.cwd, revision: null, digest: 'legacy-input' }
    }
  });
  const inspectedLegacy = inspectJob(legacyId);
  assert.equal(inspectedLegacy.verification.state, 'passed');
  assert.equal(inspectedLegacy.verificationEvidence.length, 1);
  assert.equal(inspectedLegacy.verificationEvidence[0].input.digest, 'legacy-input');
  assert.equal(decideAcceptance(legacyId, 'accepted').acceptance.state, 'accepted');

  assert.deepEqual(evaluateAutoFix({}), { action: 'stop', reason: 'off' });
  const deterministic = {
    status: 'completed',
    mode: 'implement',
    changedFiles: { count: 1 },
    verification: { state: 'failed', exitCode: 1, outputTail: 'fail 2' },
    scopeViolations: [],
    timeoutSeconds: 600,
    createdAt: Math.floor(Date.now() / 1000),
    autoFix: { maxRounds: 99, round: 1, startedAtMs: Date.now(), previousMetrics: { failures: 3, scopeViolations: 0 } }
  };
  assert.equal(AUTO_FIX_HARD_CAP, 3);
  assert.equal(evaluateAutoFix(deterministic).action, 'launch');
  assert.equal(evaluateAutoFix(deterministic).round, 2);
  assert.equal(autoFixMadeProgress({ failures: 2, scopeViolations: 0 }, { failures: 2, scopeViolations: 0 }), false);
  assert.equal(evaluateAutoFix({
    ...deterministic,
    autoFix: { ...deterministic.autoFix, previousMetrics: { failures: 2, scopeViolations: 0 } }
  }).reason, 'no-progress');
  assert.equal(evaluateAutoFix({
    ...deterministic,
    autoFix: { ...deterministic.autoFix, round: AUTO_FIX_HARD_CAP }
  }).reason, 'hard-cap');
  assert.equal(evaluateAutoFix({
    ...deterministic,
    result: { structured: { findings: [{ status: 'open' }] } }
  }).reason, 'judgment-required');
  assert.equal(evaluateAutoFix({
    ...deterministic,
    verification: { state: 'timeout', exitCode: 124, outputTail: 'timed out' }
  }).reason, 'verification-timeout');

  const legacy = projectJobAsWorkItem({
    id: 'legacy-no-acceptance',
    provider: 'codex',
    mode: 'implement',
    status: 'completed',
    changedFiles: { count: 1, files: ['legacy.js'] }
  });
  assert.equal(legacy.decision, null);
  assert.equal(legacy.runs[0].attempt.lifecycle.status, 'completed');
  assert.equal(projectJobAsWorkItem({
    ...legacy.runs[0].attempt,
    id: 'auto-fix-projection',
    autoFix: { maxRounds: 2 }
  }).spec.budget.maxRounds, 2);
});
