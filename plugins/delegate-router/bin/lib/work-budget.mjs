import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brokerError } from './errors.mjs';
import { withFileLock } from './lock.mjs';
import { jobsDir, loadJob } from './state.mjs';

// A work budget spans broker continuations and independent planning jobs.
// It counts reported output, not allowance percentages or context occupancy.
function ledgerPath(budget) {
  if (!/^(?:codex|cursor)-[a-z0-9-]+$/.test(budget?.rootJobId) || !Number.isSafeInteger(budget?.maxOutputTokens) || budget.maxOutputTokens < 1) throw brokerError('STATE_ERROR', 'invalid work-budget root or limit');
  return path.join(jobsDir(), `${budget.rootJobId}.artifacts`, 'work-budget.json');
}

function snapshot(budget, ledger) {
  const observedOutputTokens = Object.values(ledger.counters).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(observedOutputTokens)) throw brokerError('STATE_ERROR', 'work-budget counters overflow');
  return {
    ...budget, observedOutputTokens,
    remainingOutputTokens: Math.max(0, budget.maxOutputTokens - observedOutputTokens),
    exhausted: observedOutputTokens >= budget.maxOutputTokens,
    exceeded: observedOutputTokens > budget.maxOutputTokens,
    accounting: 'provider-reported-output-only',
    counterSemantics: 'thread-or-attempt-high-watermarks',
    counterDecreasesObserved: ledger.counterDecreasesObserved === true,
    unknownUsageIsNotZero: true
  };
}

function readLedger(budget) {
  const file = ledgerPath(budget);
  let ledger;
  try {
    if (fs.statSync(file).size > 65536) throw new Error('oversized ledger');
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (ledger.version !== 1 || ledger.rootJobId !== budget.rootJobId || ledger.maxOutputTokens !== budget.maxOutputTokens
      || !ledger.counters || typeof ledger.counters !== 'object' || Array.isArray(ledger.counters)
      || Object.keys(ledger.counters).length > 256
      || ledger.counterDecreasesObserved != null && typeof ledger.counterDecreasesObserved !== 'boolean'
      || Object.entries(ledger.counters).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid ledger');
  } catch (error) { throw brokerError('STATE_ERROR', `work-budget ledger is unavailable or corrupt: ${error.message}`); }
  return ledger;
}

function writeLedger(budget, ledger) {
  const file = ledgerPath(budget);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function resolveWorkBudget(options, id) {
  const requested = options.maxTotalOutputTokens ?? null;
  if (requested != null && (!Number.isSafeInteger(requested) || requested < 1)) throw brokerError('INVALID_REQUEST', 'maxTotalOutputTokens must be a positive integer');
  const parentId = options.parentJobId || options.planningFor;
  const inherited = parentId ? loadJob(parentId)?.workBudget : null;
  if (inherited) {
    if (requested != null && requested !== inherited.maxOutputTokens) throw brokerError('INVALID_REQUEST', 'a continuation cannot change the work-level output budget; start an independent work item');
    if (workBudgetSnapshot({ workBudget: inherited }).exhausted) throw brokerError('BUDGET_EXCEEDED', 'work-level output budget is exhausted');
    return { ...inherited };
  }
  return requested == null ? null : { rootJobId: id, maxOutputTokens: requested };
}

export function initializeWorkBudget(job) {
  if (!job.workBudget || job.workBudget.rootJobId !== job.id) return;
  const budget = job.workBudget;
  withFileLock(`${ledgerPath(budget)}.lock`, () => {
    // Root IDs are unique. Never reset an existing ledger, even on a retry.
    if (fs.existsSync(ledgerPath(budget))) readLedger(budget);
    else writeLedger(budget, { version: 1, ...budget, counters: {} });
  });
}

export function workBudgetSnapshot(job) {
  return job.workBudget ? snapshot(job.workBudget, readLedger(job.workBudget)) : null;
}

export function recordWorkBudgetUsage(job, outputTokens) {
  if (!job.workBudget) return null;
  if (outputTokens == null) return workBudgetSnapshot(job);
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) throw brokerError('STATE_ERROR', 'work-budget output usage must be a nonnegative integer');
  const budget = job.workBudget;
  return withFileLock(`${ledgerPath(budget)}.lock`, () => {
    const ledger = readLedger(budget);
    // Codex reports thread-cumulative counters. Resuming the same thread must
    // not add the old prefix again. Cursor reports per-attempt output instead.
    const identity = job.provider === 'codex' && job.providerSessionId
      ? `codex:thread:${job.providerSessionId}` : `${job.provider}:job:${job.id}`;
    const key = crypto.createHash('sha256').update(identity).digest('hex');
    if (!Object.hasOwn(ledger.counters, key) && Object.keys(ledger.counters).length >= 256) throw brokerError('STATE_ERROR', 'work-budget session bound exceeded');
    if ((ledger.counters[key] || 0) > outputTokens) ledger.counterDecreasesObserved = true;
    ledger.counters[key] = Math.max(ledger.counters[key] || 0, outputTokens);
    const result = snapshot(budget, ledger);
    writeLedger(budget, ledger);
    return result;
  });
}
