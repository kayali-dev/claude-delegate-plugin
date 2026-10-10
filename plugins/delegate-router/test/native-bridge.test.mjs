import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeUsageWindows, captureClaudeUsage } from '../bin/lib/claude-usage.mjs';
import { dispatchNative, nativeOverview } from '../bin/lib/native-bridge.mjs';
import { negotiateMcpVersion, toolAnnotations } from '../bin/lib/mcp-contract.mjs';
import { nativeOptions, overviewText, reviewerGuardDecision, orderedJobRows, readablePlan } from '../hooks/native-view.mjs';
import { loadState, saveJob, saveState, effectiveUsage } from '../bin/lib/state.mjs';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function isolated(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-native-bridge-'));
  const before = { state: process.env.DELEGATE_STATE_FILE, providers: process.env.DELEGATE_ENABLED_PROVIDERS };
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex';
  t.after(() => {
    if (before.state == null) delete process.env.DELEGATE_STATE_FILE; else process.env.DELEGATE_STATE_FILE = before.state;
    if (before.providers == null) delete process.env.DELEGATE_ENABLED_PROVIDERS; else process.env.DELEGATE_ENABLED_PROVIDERS = before.providers;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function job(id, extra = {}) {
  return {
    id, managedBy: 'delegate-control', provider: 'codex', model: 'sol', mode: 'review',
    status: 'running', phase: 'running', revision: 3, lastSeq: 0, pid: process.pid,
    origin: { sessionId: 'native-session', workspaceId: '/tmp/native-project', projectDir: '/tmp/native-project' },
    ...extra
  };
}

test('native inspection retains shared base and nested Codex output usage', async (t) => {
  isolated(t);
  saveJob(job('usage-job', { baseRevision: 'abc123', usage: { total: { outputTokens: 99 } } }));
  const result = await dispatchNative('inspect', { sessionId: 'native-session', jobId: 'usage-job' });
  assert.equal(result.observedOutputTokens, 99);
  assert.equal(result.baseRevision, 'abc123');
  saveJob(job('input-only-job', { usage: { inputTokens: 99 } }));
  const unknown = await dispatchNative('inspect', { sessionId: 'native-session', jobId: 'input-only-job' });
  assert.equal(unknown.observedOutputTokens, null, 'input-only usage does not establish zero output');
});

test('native job ordering keeps attention ahead of active work and history', () => {
  const rows = [{ id: 'done', status: 'completed' }, { id: 'run', status: 'running' },
    { id: 'review', acceptance: 'ready-for-review' }, { id: 'failed', status: 'failed' }, { id: 'answer', pendingInput: {} }];
  assert.deepEqual(orderedJobRows(rows).map((row) => row.id), ['answer', 'failed', 'review', 'run', 'done']);
  assert.deepEqual(orderedJobRows(rows, false).map((row) => row.id), ['answer', 'failed', 'review', 'run']);
});

test('native structural plans render readable exact evidence without hiding unknown fields', () => {
  const plan = { targets: { files: ['src/A.js'], components: ['Core'] }, approach: [{ kind: 'edit', component: 'Core' }],
    assumptions: [{ topic: 'scope', choice: 'unchanged' }], risks: ['review required'] };
  const formatted = readablePlan(JSON.stringify(plan));
  for (const value of ['src/A.js', 'Core', 'edit', 'scope', 'unchanged', 'review required']) assert.ok(formatted.includes(value));
  assert.match(formatted, /### Files/);
  const unknown = JSON.stringify({ ...plan, extra: 'do not hide' });
  assert.equal(readablePlan(unknown), unknown);
  assert.equal(readablePlan('truncated JSON'), 'truncated JSON');
});

test('official native usage handles ISO resets and rejects malformed or unrelated windows', (t) => {
  isolated(t);
  const reset = new Date(Date.now() + 3600_000).toISOString();
  const payload = { rateLimits: [
    { kind: 'five_hour', percentUsed: 41.2, resetsAt: reset, credential: 'never copy' },
    { kind: 'seven_day', percentUsed: 7.1 },
    { kind: 'context', percentUsed: 99 },
    { kind: 'spend_limit', percentUsed: 105 },
    { kind: 'five_hour', percentUsed: '99' },
    { kind: 'seven_day', percentUsed: 91, resetsAt: 'invalid' }
  ], reasoning: 'do not retain' };
  assert.deepEqual(claudeUsageWindows(payload).map((window) => window.name), ['five_hour', 'seven_day']);
  assert.equal(captureClaudeUsage(payload).captured, 2);
  const state = loadState();
  assert.equal(effectiveUsage(state, 'claude').usedPercent, 41.2);
  assert.equal(state.providers.claude.windows.five_hour.resetsAt, Math.floor(Date.parse(reset) / 1000));
  assert.equal(state.providers.claude.windows.five_hour.source, 'claude-mod');
  assert.ok(!JSON.stringify(state).includes('never copy'));
  assert.ok(!JSON.stringify(state).includes('do not retain'));
  assert.equal(fs.statSync(process.env.DELEGATE_STATE_FILE).mode & 0o777, 0o600);
  assert.equal(captureClaudeUsage({ rateLimits: [] }).captured, 0);
  assert.equal(effectiveUsage(loadState(), 'claude').usedPercent, 41.2);
});

test('native overview is session scoped, closed field, bounded and labels foreign controls', (t) => {
  isolated(t);
  const jobs = [job('own-job', { prompt: 'password=very-secret', changedFiles: { count: 2 } }),
    job('foreign-job', { origin: { sessionId: 'other', workspaceId: '/tmp/native-project' } }),
    job('legacy-job', { origin: null }),
    job('input-job', { pendingInput: { requestId: 'q1', kind: 'question', question: 'secret question', expiresAt: Date.now() + 300_000 } })];
  const state = loadState();
  const session = nativeOverview({ sessionId: 'native-session', scope: 'session' }, { jobs, usageState: state, enabled: ['codex'] });
  assert.deepEqual(session.jobs.map((value) => value.id), ['input-job', 'own-job']);
  assert.equal(session.jobs[0].canAnswer, true);
  assert.equal(session.jobs[1].countIsLowerBound, true);
  assert.ok(!JSON.stringify(session).includes('very-secret'));
  assert.ok(!JSON.stringify(session).includes('secret question'));
  const workspace = nativeOverview({ sessionId: 'native-session', scope: 'workspace', projectDir: '/tmp/native-project' }, { jobs, usageState: state, enabled: ['codex'] });
  assert.equal(workspace.jobs.find((value) => value.id === 'foreign-job').canCancel, false);
  const many = nativeOverview({ scope: 'all' }, { jobs: Array.from({ length: 100 }, (_, n) => job(`job-${n}`)), usageState: state, enabled: ['codex'] });
  assert.equal(many.jobs.length, 40);
  assert.equal(many.omittedCount, 60);
  assert.match(overviewText(many), /older jobs omitted/);
});

test('native controls require ownership, confirmation, revision and stable identity', async (t) => {
  isolated(t);
  saveJob(job('controlled-job'));
  const base = { sessionId: 'native-session', jobId: 'controlled-job', expectedRevision: 3, commandId: 'native-command', confirmed: true };
  await assert.rejects(dispatchNative('cancel', { ...base, confirmed: false }), /human confirmation/);
  await assert.rejects(dispatchNative('cancel', { ...base, sessionId: 'other' }), /owning Claude session/);
  await assert.rejects(dispatchNative('cancel', { ...base, expectedRevision: 2 }), /REVISION_CONFLICT/);
  await assert.rejects(dispatchNative('cancel', { ...base, commandId: '' }), /stable commandId/);
  await assert.rejects(dispatchNative('cancel', { ...base, sandbox: 'off' }), /unsupported native input/);
  const result = await dispatchNative('cancel', base);
  assert.equal(result.state, 'queued-or-duplicate');
  assert.equal((await dispatchNative('cancel', base)).duplicate, true);
  assert.equal((await dispatchNative('cancel', { ...base, expectedRevision: 4 })).duplicate, true);
  await assert.rejects(dispatchNative('start', base), /unsupported native action/);
  const snapshot = await dispatchNative('snapshot', { sessionId: 'native-session' });
  assert.deepEqual(snapshot.enabledProviders, ['codex']);
});

test('native input decisions preserve plan booleans and reject disabled providers', async (t) => {
  isolated(t);
  saveJob(job('plan-job', { phase: 'user-input-required', pendingInput: { requestId: 'q-plan', kind: 'plan-confirmation', expiresAt: Date.now() + 300_000 } }));
  const base = { sessionId: 'native-session', jobId: 'plan-job', expectedRevision: 3, commandId: 'native-plan', confirmed: true, requestId: 'q-plan' };
  await assert.rejects(dispatchNative('respond', { ...base, answer: 'approve' }), /boolean decision/);
  saveJob(job('cursor-disabled', { provider: 'cursor' }));
  await assert.rejects(dispatchNative('cancel', { ...base, jobId: 'cursor-disabled' }), /PROVIDER_DISABLED/);
  await dispatchNative('respond', { ...base, accept: false });
});

test('native CLI bounds input and returns JSON errors without exposing hidden fields', (t) => {
  isolated(t);
  const bin = path.join(plugin, 'bin', 'delegate-native');
  const run = spawnSync(process.execPath, [bin, 'snapshot'], { input: JSON.stringify({ sessionId: 'native-session' }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  const large = spawnSync(process.execPath, [bin, 'snapshot'], { input: ' '.repeat(65537), encoding: 'utf8' });
  assert.equal(large.status, 1);
  assert.equal(JSON.parse(large.stdout).ok, false);
});

test('native evidence is bounded, redacted and marks truncation instead of presenting a complete plan', async (t) => {
  isolated(t);
  saveJob(job('evidence-job', {
    resultText: 'password=example-secret-value\n' + 'result '.repeat(3_000),
    planning: { primary: { steps: ['step '.repeat(3_000)] } },
    originalAllowedPaths: Array.from({ length: 60 }, (_, n) => `src/file-${n}.ts`),
    approval: 'auto', sandbox: 'auto', network: false, timeoutSeconds: 300, maxOutputTokens: 2_000,
    rawProviderPayload: 'untrusted hidden payload', reasoning: 'hidden model reasoning'
  }));
  const evidence = await dispatchNative('inspect', { sessionId: 'native-session', jobId: 'evidence-job' });
  assert.equal(evidence.evidenceTruncated, true);
  assert.equal(evidence.scope.paths.length, 40);
  assert.equal(evidence.scope.omittedCount, 20);
  assert.ok(evidence.resultText.length <= 8_000);
  assert.ok(evidence.plan.length <= 8_000);
  assert.equal(evidence.policy.network, false);
  assert.equal(evidence.budget.maxOutputTokens, 2_000);
  assert.ok(!JSON.stringify(evidence).includes('example-secret-value'));
  assert.ok(!JSON.stringify(evidence).includes('hidden payload'));
  assert.ok(!JSON.stringify(evidence).includes('hidden model reasoning'));
});

test('expired input, legacy shadows and disabled providers have honest native controls', (t) => {
  isolated(t);
  const jobs = [
    job('expired-input', { pendingInput: { kind: 'question', requestId: 'q-expired', expiresAt: Date.now() - 1 } }),
    job('shadow-job', { managedBy: 'delegate-shadow' }),
    job('disabled-cursor', { provider: 'cursor' }),
    job('claude-review', { provider: 'claude', managedBy: 'delegate-agent-hook' })
  ];
  const view = nativeOverview({ sessionId: 'native-session' }, { jobs, enabled: ['codex'], usageState: loadState() });
  const expired = view.jobs.find((value) => value.id === 'expired-input');
  assert.equal(expired.pendingInput, null);
  assert.equal(expired.canAnswer, false);
  assert.equal(expired.canSteer, false);
  assert.equal(expired.canCancel, true);
  for (const id of ['shadow-job', 'disabled-cursor', 'claude-review']) assert.equal(view.jobs.find((value) => value.id === id).canCancel, false);
  assert.equal(view.jobs.find((value) => value.id === 'claude-review').providerEnabled, true);
  assert.deepEqual(view.allowance.map((value) => value.provider), ['claude', 'codex']);
});

test('MCP negotiation does not echo unsupported revisions and tool hints preserve mutation distinctions', () => {
  assert.equal(negotiateMcpVersion('2025-11-25'), '2025-11-25');
  assert.equal(negotiateMcpVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateMcpVersion('2026-07-28'), '2025-11-25');
  assert.equal(negotiateMcpVersion('untrusted'), '2025-11-25');
  assert.equal(toolAnnotations('delegate_inspect').readOnlyHint, true);
  assert.equal(toolAnnotations('delegate_integrate').destructiveHint, true);
  assert.equal(toolAnnotations('delegate_start').idempotentHint, false);
});

test('native options are conservative and reviewer guard never rewrites a model', () => {
  assert.equal(nativeOptions({ refresh_seconds: 0 }).refresh_seconds, 5);
  assert.equal(nativeOptions({ refresh_seconds: 999 }).refresh_seconds, 30);
  assert.equal(nativeOptions({ native_enabled: false }).native_enabled, false);
  const usage = { allowance: [{ provider: 'claude', known: true, usedPercent: 95, avoidPercent: 90 }] };
  assert.match(reviewerGuardDecision({ subagentType: 'delegate-router:reviewer', model: 'opus' }, usage), /do not silently change/);
  assert.equal(reviewerGuardDecision({ subagentType: 'Explore' }, usage), null);
  assert.equal(reviewerGuardDecision({ subagentType: 'delegate-router:reviewer' }, { allowance: [] }), null);
});
