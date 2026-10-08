import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManagedJob, inspectJob, jobUsage, previewManagedJob, pruneJobs, updateManagedJob } from '../bin/lib/control.mjs';
import { managedAttemptDriver, recordUsage } from '../bin/lib/providers.mjs';
import { recordWorkBudgetUsage, workBudgetSnapshot } from '../bin/lib/work-budget.mjs';
import { jobsDir, loadJob } from '../bin/lib/state.mjs';

function state(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-work-budget-'));
  const previous = process.env.DELEGATE_STATE_FILE;
  process.env.DELEGATE_STATE_FILE = path.join(root, 'usage.json');
  t.after(() => {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE; else process.env.DELEGATE_STATE_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function job(cwd, extra = {}) { return createManagedJob({ provider: 'codex', mode: 'consult', prompt: 'bounded evidence', cwd, ...extra }); }

test('work budgets deduplicate resumed Codex counters and include independent planners and Cursor attempts', t => {
  const cwd = state(t);
  const root = job(cwd, { maxTotalOutputTokens: 50, maxSubagents: 0 });
  const first = { ...root, providerSessionId: 'first-thread' };
  assert.equal(recordWorkBudgetUsage(first, 10).observedOutputTokens, 10);
  const continued = job(cwd, { parentJobId: root.id });
  assert.equal(recordWorkBudgetUsage({ ...continued, providerSessionId: 'first-thread' }, 25).observedOutputTokens, 25);
  assert.equal(recordWorkBudgetUsage(first, 10).observedOutputTokens, 25, 'stale reports never refund output');
  assert.equal(workBudgetSnapshot(root).counterDecreasesObserved, true);
  const planner = job(cwd, { planningFor: root.id });
  assert.equal(planner.maxSubagents, 0);
  assert.equal(recordWorkBudgetUsage({ ...planner, providerSessionId: 'planner-thread' }, 8).observedOutputTokens, 33);
  const cursorA = job(cwd, { provider: 'cursor', parentJobId: continued.id });
  const cursorB = job(cwd, { provider: 'cursor', parentJobId: cursorA.id });
  recordWorkBudgetUsage({ ...cursorA, providerSessionId: 'same-cursor-chat' }, 5);
  assert.equal(recordWorkBudgetUsage({ ...cursorB, providerSessionId: 'same-cursor-chat' }, 5).observedOutputTokens, 43);
  const file = path.join(jobsDir(), `${root.id}.artifacts`, 'work-budget.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes('first-thread'), false);
  assert.equal(workBudgetSnapshot(root).remainingOutputTokens, 7);
});

test('exhausted, corrupt, missing, or changed inherited work budgets fail closed', t => {
  const cwd = state(t);
  const root = job(cwd, { maxTotalOutputTokens: 10 });
  assert.throws(() => job(cwd, { parentJobId: root.id, maxTotalOutputTokens: 11 }), error => error.code === 'INVALID_REQUEST');
  recordWorkBudgetUsage(root, 10);
  assert.throws(() => job(cwd, { parentJobId: root.id }), error => error.code === 'BUDGET_EXCEEDED');
  const file = path.join(jobsDir(), `${root.id}.artifacts`, 'work-budget.json');
  fs.writeFileSync(file, '{}');
  assert.throws(() => job(cwd, { parentJobId: root.id }), error => error.code === 'STATE_ERROR');
  fs.unlinkSync(file);
  assert.throws(() => workBudgetSnapshot(root), error => error.code === 'STATE_ERROR');
});

test('budget preflight is non-mutating and provider usage returns the ordinary cancellation error', async t => {
  const cwd = state(t);
  const preview = previewManagedJob({ provider: 'codex', prompt: 'evidence', cwd, maxTotalOutputTokens: 20, maxSubagents: 0 });
  assert.equal(preview.workBudget.maxOutputTokens, 20);
  assert.equal(preview.maxSubagents, 0);
  assert.equal(fs.existsSync(jobsDir()), false);
  for (const invalid of [0, -1, 1.5, NaN, '10']) assert.throws(() => job(cwd, { maxTotalOutputTokens: invalid }), error => error.code === 'INVALID_REQUEST');
  const root = job(cwd, { maxTotalOutputTokens: 20 });
  updateManagedJob(root.id, current => { current.providerSessionId = 'main-thread'; });
  const revision = inspectJob(root.id).revision;
  const error = recordUsage(root, { total: { inputTokens: 3, outputTokens: 21, totalTokens: 24 } });
  assert.equal(error.code, 'BUDGET_EXCEEDED');
  assert.equal(inspectJob(root.id).revision, revision);
  assert.equal(jobUsage(root.id).workBudget.observedOutputTokens, 21);
  assert.equal(jobUsage(root.id).workBudget.unknownUsageIsNotZero, true);
  let invoked = false;
  await assert.rejects(() => managedAttemptDriver(root).prompt(() => { invoked = true; }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(invoked, false, 'known exhaustion blocks later turns without sending a provider request');
});

test('native-child counters and absent output are not invented as parent usage, and ledger faults return cancellation errors', t => {
  const cwd = state(t);
  const root = job(cwd, { maxTotalOutputTokens: 100 });
  updateManagedJob(root.id, current => { current.providerSessionId = 'parent-thread'; });
  recordUsage(root, { total: { outputTokens: 999 } }, { sessionId: 'child-thread' });
  assert.equal(inspectJob(root.id).usage, undefined);
  assert.equal(workBudgetSnapshot(root).observedOutputTokens, 0);
  recordUsage(root, { total: { inputTokens: 20 } }, { sessionId: 'parent-thread' });
  const file = path.join(jobsDir(), `${root.id}.artifacts`, 'work-budget.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).counters, {});
  fs.writeFileSync(file, '{}');
  assert.equal(recordUsage(root, { total: { outputTokens: 1 } }).code, 'STATE_ERROR');
});

test('an active descendant protects its accepted historical budget root from retention', t => {
  const cwd = state(t);
  const root = job(cwd, { maxTotalOutputTokens: 100 });
  const child = job(cwd, { parentJobId: root.id });
  updateManagedJob(root.id, current => {
    current.status = 'completed'; current.phase = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000) - 10 * 86400;
    current.acceptance = { state: 'accepted' };
  });
  pruneJobs({ maxAgeDays: 1, recentTerminalKeep: 0, logger: () => {} });
  assert.ok(loadJob(root.id));
  assert.ok(loadJob(child.id));
  assert.equal(workBudgetSnapshot(child).remainingOutputTokens, 100);
});
