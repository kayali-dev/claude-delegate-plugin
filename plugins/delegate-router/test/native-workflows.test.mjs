import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { previewNativeTask, readNativePreview, validateNativePreview, approvedNativePreview, launchNativePreview } from '../bin/lib/native-launch.mjs';
import { enqueueNativePreview, controlDispatchQueue, listDispatchQueue, pumpDispatchQueue } from '../bin/lib/dispatch-queue.mjs';
import { bindClaudeAgent, observeClaudeAgents } from '../bin/lib/native-agents.mjs';
import { claimJobController, createManagedJob, inspectJob, launchManagedJob, readJobEvents, appendJobEvent, submitControl } from '../bin/lib/control.mjs';
import { dispatchNative, nativeOverview } from '../bin/lib/native-bridge.mjs';
import { loadJob, saveJob, listJobs } from '../bin/lib/state.mjs';
import { brokerError } from '../bin/lib/errors.mjs';
import { jobTimeBudget } from '../bin/lib/job-health.mjs';
import { contextCandidates, managedResultId } from '../hooks/native-data.mjs';
import { agentTreeRows } from '../hooks/native-view.mjs';
import { scopeMonitorSnapshots } from '../bin/lib/monitor-runtime.mjs';
import { detectActionableEdges, formatEdgeLine } from '../bin/lib/monitor-policy.mjs';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-native-workflows-'));
  const before = { ...process.env };
  Object.assign(process.env, { DELEGATE_STATE_FILE: path.join(directory, 'state', 'usage.json'),
    DELEGATE_ENABLED_PROVIDERS: 'codex,cursor', DELEGATE_SUPERVISOR: '0' });
  delete process.env.DELEGATE_CODEX_MAX_CONCURRENT;
  delete process.env.DELEGATE_CURSOR_MAX_CONCURRENT;
  const projectDir = path.join(directory, 'workspace'); fs.mkdirSync(projectDir);
  const git = spawnSync('git', ['init', '-q'], { cwd: projectDir }); assert.equal(git.status, 0);
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, projectDir, sessionId: 'native-session' };
}
const draft = (extra = {}) => ({ objective: 'Inspect the repository for correctness issues', acceptance: 'Return concrete findings and verification evidence', provider: 'codex', model: 'sol', mode: 'review', ...extra });
const approved = (base, preview) => ({ sessionId: base.sessionId, projectDir: base.projectDir, previewId: preview.id, confirmed: true });

test('native task preview is bounded, private, enabled-provider aware and makes no job', (t) => {
  const base = setup(t);
  const preview = previewNativeTask({ ...base, draft: draft() });
  assert.match(preview.packet, /Acceptance criteria/); assert.match(preview.model, /^gpt-/);
  assert.equal(listJobs().length, 0); assert.equal(preview.timeoutSeconds, 3600);
  assert.equal(fs.statSync(path.join(base.directory, 'state', 'native-previews', `${preview.id}.json`)).mode & 0o777, 0o600);
  assert.doesNotThrow(() => validateNativePreview(readNativePreview(preview.id)));
  assert.throws(() => approvedNativePreview({ ...approved(base, preview), confirmed: false }), /confirmation/);
  assert.throws(() => approvedNativePreview({ ...approved(base, preview), sessionId: 'foreign' }), /another session/);
  assert.throws(() => previewNativeTask({ ...base, draft: draft({ arbitraryCommand: 'sh' }) }), /unsupported composer/);
  process.env.DELEGATE_ENABLED_PROVIDERS = 'cursor';
  assert.throws(() => previewNativeTask({ ...base, draft: draft() }), /disabled/);
});

test('native preview refuses missing write scope, escaped paths, secrets and model substitution', (t) => {
  const base = setup(t);
  assert.throws(() => previewNativeTask({ ...base, draft: draft({ mode: 'implement' }) }), /scope/);
  assert.throws(() => previewNativeTask({ ...base, draft: draft({ paths: '../private' }) }), /inside/);
  assert.throws(() => previewNativeTask({ ...base, draft: draft({ objective: 'Read api_key=secret-value-123456789' }) }), /credential/);
  assert.throws(() => previewNativeTask({ ...base, draft: draft({ provider: 'cursor', model: 'gpt-6.1-sol' }) }), /another provider/);
  const preview = previewNativeTask({ ...base, draft: draft({ mode: 'implement', paths: 'src' }) });
  assert.equal(preview.planFirst, true);
  assert.equal(preview.scope[0], 'src');
});

test('public context is opt-in, capped and redacted before truncation without tool payloads', (t) => {
  const base = setup(t);
  const rows = contextCandidates([{ role: 'assistant', text: 'API_KEY=sk-12345678901234567890\nUseful context', toolUses: [{ input: 'never' }], reasoning: 'hidden' }, { role: 'user', text: 'x'.repeat(3000) }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].redacted, true); assert.equal(rows[1].truncated, true);
  assert.ok(!JSON.stringify(rows).includes('never')); assert.ok(!JSON.stringify(rows).includes('hidden'));
  const preview = previewNativeTask({ ...base, draft: draft({ context: rows.map(({ role, text }) => ({ role, text })) }) });
  assert.match(preview.packet, /Useful context/); assert.ok(!preview.packet.includes('sk-12345678901234567890'));
  assert.throws(() => previewNativeTask({ ...base, draft: draft({ context: Array.from({ length: 9 }, () => ({ role: 'user', text: 'excerpt' })) }) }), /eight/);
});

test('workspace drift invalidates approval rather than silently rebuilding the task', (t) => {
  const base = setup(t); const preview = previewNativeTask({ ...base, draft: draft() });
  fs.writeFileSync(path.join(base.projectDir, 'new.txt'), 'public test file');
  assert.throws(() => approvedNativePreview(approved(base, preview)), /workspace changed/);
});

test('queue approval is distinct from a running job and controls are revisioned and scoped', (t) => {
  const base = setup(t); const preview = previewNativeTask({ ...base, draft: draft() });
  const input = approved(base, preview);
  const queued = enqueueNativePreview({ ...input, priority: 1 });
  assert.equal(queued.state, 'pending'); assert.equal(listJobs().length, 0);
  assert.equal(enqueueNativePreview(input).id, queued.id);
  assert.equal(listDispatchQueue().length, 1);
  assert.equal(fs.statSync(path.join(base.directory, 'state', 'dispatch-queue.json')).mode & 0o777, 0o600);
  const control = { ...base, confirmed: true, queueId: queued.id, expectedRevision: 1, queueAction: 'cancel' };
  assert.throws(() => controlDispatchQueue({ ...control, sessionId: 'foreign' }), /another session/);
  assert.throws(() => controlDispatchQueue({ ...control, expectedRevision: 0 }), /revision changed/);
  assert.equal(controlDispatchQueue(control).state, 'cancelled');
});

test('queue admission retries only capacity/quota blockers, preserves pins and orders priority', async (t) => {
  const base = setup(t);
  const low = previewNativeTask({ ...base, draft: draft() });
  const high = previewNativeTask({ ...base, draft: draft({ objective: 'Inspect another bounded concern' }) });
  enqueueNativePreview({ ...approved(base, low), priority: -1 });
  enqueueNativePreview({ ...approved(base, high), priority: 2 });
  const order = [];
  await pumpDispatchQueue({ reserve: (options) => { order.push(options.idempotencyKey); throw brokerError('PROVIDER_BUSY', 'busy'); } });
  assert.deepEqual(order, [high.id, low.id]);
  assert.ok(listDispatchQueue().every((entry) => entry.state === 'pending' && entry.reason === 'PROVIDER_BUSY'));
  await pumpDispatchQueue({ reserve: (options) => launchManagedJob(options, { deferSubmit: true, concurrencyLimit: 1 }) });
  const rows = listDispatchQueue();
  assert.equal(rows.find((entry) => entry.id === high.id).state, 'dispatched');
  assert.equal(rows.find((entry) => entry.id === low.id).reason, 'PROVIDER_BUSY');
  const reserved = listJobs()[0]; assert.equal(reserved.model, readNativePreview(high.id).options.model);
  assert.equal(reserved.timeoutSeconds, 3600);
  let submits = 0;
  await pumpDispatchQueue({ reserve: () => { throw brokerError('PROVIDER_BUSY', 'busy'); }, submit: async (id) => { assert.equal(id, reserved.id); submits++; } });
  assert.equal(submits, 1); assert.equal(listJobs().length, 1);
});

test('queued workspace drift requires fresh approval, not an automatic provider run', async (t) => {
  const base = setup(t); const preview = previewNativeTask({ ...base, draft: draft() });
  enqueueNativePreview(approved(base, preview));
  fs.writeFileSync(path.join(base.projectDir, 'changed.txt'), 'new file');
  await pumpDispatchQueue({ reserve: () => { assert.fail('must not reserve on drift'); } });
  assert.equal(listDispatchQueue()[0].state, 'needs-reapproval'); assert.equal(listJobs().length, 0);
});

test('same-workspace claim preserves origin, deduplicates and closes native-control ownership races', (t) => {
  const base = setup(t);
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: base.projectDir, prompt: 'review', originSessionId: 'first', originProjectDir: base.projectDir });
  const request = { sessionId: 'second', projectDir: base.projectDir, confirmed: true, commandId: 'claim-1', expectedRevision: job.revision };
  assert.throws(() => claimJobController(job.id, { ...request, projectDir: base.directory }), /same recorded workspace/);
  assert.throws(() => claimJobController(job.id, { ...request, expectedRevision: 100 }), /revision changed/);
  const result = claimJobController(job.id, request);
  assert.equal(claimJobController(job.id, request).duplicate, true);
  assert.equal(loadJob(job.id).origin.sessionId, 'first'); assert.equal(loadJob(job.id).controller.sessionId, 'second');
  assert.throws(() => submitControl(job.id, { type: 'cancel', commandId: 'old-control', controllerSessionId: 'first' }, result.revision), /supervision/);
  assert.equal(nativeOverview({ sessionId: 'first' }).jobs.length, 0);
  assert.equal(nativeOverview({ sessionId: 'second' }).jobs[0].canCancel, true);
  const snapshot = { job: { ...loadJob(job.id), pendingInput: { requestId: 'q1' } }, events: [] };
  assert.equal(scopeMonitorSnapshots([snapshot], { sessionId: 'first' }).length, 0);
  assert.equal(scopeMonitorSnapshots([snapshot], { sessionId: 'second' }).length, 1);
  const edge = detectActionableEdges(snapshot, { recipientSessionId: 'second' })[0];
  assert.equal(edge.originSessionId, 'first'); assert.equal(edge.isOwnSession, true);
  assert.match(formatEdgeLine(edge), /controller.sessionId=second/);
  const legacy = { ...loadJob(job.id), id: 'legacy', origin: null }; saveJob(legacy);
  assert.throws(() => claimJobController('legacy', { ...request, expectedRevision: legacy.revision }), /same recorded workspace/);
});

test('lost launch acknowledgement reuses the job even after workspace drift', (t) => {
  const base = setup(t); const preview = previewNativeTask({ ...base, draft: draft() });
  const record = readNativePreview(preview.id);
  const reserved = launchManagedJob(record.options, { deferSubmit: true });
  fs.writeFileSync(path.join(base.projectDir, 'subsequent-change.txt'), 'public');
  const retry = launchNativePreview(approved(base, preview));
  assert.equal(retry.jobId, reserved.id); assert.equal(retry.duplicate, true); assert.equal(listJobs().length, 1);
});

test('configured concurrency rejects a second reservation and stable defaults match displayed budgets', (t) => {
  const base = setup(t);
  process.env.DELEGATE_CODEX_MAX_CONCURRENT = '1'; process.env.DELEGATE_CODEX_TIMEOUT_SECONDS = '1200';
  const options = { provider: 'codex', mode: 'review', cwd: base.projectDir, prompt: 'review' };
  const reserved = launchManagedJob(options, { deferSubmit: true });
  process.env.DELEGATE_CODEX_TIMEOUT_SECONDS = '7200';
  assert.equal(inspectJob(reserved.id).timeBudget.limitSeconds, 1200);
  assert.equal(loadJob(reserved.id).effectiveTimeoutSeconds, 1200);
  assert.throws(() => launchManagedJob(options, { deferSubmit: true }), /PROVIDER_BUSY/);
  process.env.DELEGATE_CODEX_MAX_CONCURRENT = 'invalid';
  assert.throws(() => launchManagedJob(options, { deferSubmit: true }), /MAX_CONCURRENT/);
});

test('native Claude binding correlates exact tool ID, host status wins over quiet output, absence does not end agents', (t) => {
  const base = setup(t);
  const first = bindClaudeAgent({ ...base, spawn: { toolUseId: 'toolu-first', agentId: 'host-first', type: 'Explore', description: 'First', model: 'inherited' } });
  const second = bindClaudeAgent({ ...base, spawn: { toolUseId: 'toolu-second', agentId: 'host-second', type: 'Explore', description: 'Second', parentId: 'host-first' } });
  observeClaudeAgents({ ...base, agents: [{ id: 'host-first', status: 'running', type: 'Explore' }, { id: 'host-second', status: 'waiting', parentId: 'host-first' }] });
  assert.equal(listJobs().length, 2); assert.equal(inspectJob(first.jobId).agentActivityState, 'active');
  assert.equal(inspectJob(second.jobId).agentActivityState, 'waiting');
  observeClaudeAgents({ ...base, agents: [] }); assert.equal(loadJob(first.jobId).status, 'running');
  observeClaudeAgents({ ...base, agents: [{ id: 'host-first', status: 'completed', type: 'Explore' }] });
  assert.equal(loadJob(first.jobId).status, 'completed');
  observeClaudeAgents({ ...base, agents: [{ id: 'host-first', status: 'running', type: 'Explore' }] });
  assert.equal(loadJob(first.jobId).status, 'completed');
  bindClaudeAgent({ ...base, spawn: { toolUseId: 'toolu-first', agentId: 'host-first', type: 'Explore' } });
  assert.equal(loadJob(first.jobId).agentLifecycle, 'completed');
  assert.ok(!JSON.stringify(readJobEvents(first.jobId)).includes('reasoning'));
});

test('native host snapshots adopt missing hook rows but never accept unknown status or expose raw fields', (t) => {
  const base = setup(t);
  observeClaudeAgents({ ...base, agents: [{ id: 'missed', status: 'idle', description: 'api_key=private-value-12345', reasoning: 'never retain' }, { id: 'bad', status: 'invented' }] });
  assert.equal(listJobs().length, 1);
  assert.ok(!JSON.stringify(listJobs()).includes('private-value-12345')); assert.ok(!JSON.stringify(listJobs()).includes('never retain'));
  const row = nativeOverview({ sessionId: base.sessionId }).jobs[0];
  assert.equal(row.hostStatus, 'idle'); assert.equal(row.observedOutputTokens, null);
});

test('evidence paging pins content version, permits only recorded paths and supports literal search', async (t) => {
  const base = setup(t); const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: base.projectDir, prompt: 'review' });
  appendJobEvent(job.id, 'file.changed', { changes: [{ path: 'src/a.js' }] });
  appendJobEvent(job.id, 'diff.updated', { diff: `diff --git a/src/a.js b/src/a.js\n${'+line\n'.repeat(8000)}+needle` });
  const first = await dispatchNative('diff', { jobId: job.id, offset: 0 });
  assert.equal(first.diff.length, 32000); assert.equal(first.nextOffset, 32000);
  const second = await dispatchNative('diff', { jobId: job.id, offset: first.nextOffset, evidenceVersion: first.evidenceVersion });
  assert.match(second.diff, /needle/);
  const found = await dispatchNative('diff', { jobId: job.id, file: 'src/a.js', find: 'needle' }); assert.equal(found.diff, 'needle');
  await assert.rejects(dispatchNative('diff', { jobId: job.id, file: '../../private' }), /recorded changed file/);
  appendJobEvent(job.id, 'diff.updated', { diff: 'new evidence' });
  await assert.rejects(dispatchNative('diff', { jobId: job.id, offset: 32000, evidenceVersion: first.evidenceVersion }), /evidence changed/);
});

test('wall-clock budget is independent of last output and approval wait; agent usage stays unknown', () => {
  const job = { createdAtMs: 100000, timeoutSeconds: 60, lastActivityAt: 100001, phase: 'user-input-required' };
  assert.equal(jobTimeBudget(job, 130000).remainingSeconds, 30);
  assert.equal(jobTimeBudget({ ...job, lastActivityAt: 130000 }, 130000).remainingSeconds, 30);
  assert.equal(jobTimeBudget(job, 170000).remainingSeconds, 0);
  assert.equal(jobTimeBudget({ createdAtMs: 100000 }, 170000), null);
  assert.deepEqual(agentTreeRows([{ id: 'child', parentAgentId: 'parent-host' }, { id: 'parent', agentId: 'parent-host' }]).map((row) => [row.id, row.depth]), [['parent', 0], ['child', 1]]);
  assert.equal(managedResultId({ result: { content: [{ text: '{"jobId":"bounded-id"}' }] } }), 'bounded-id');
});

test('large native fleets retain serialized-response bounds and honest omission counts', (t) => {
  setup(t);
  const jobs = Array.from({ length: 100 }, (_, n) => ({ id: `long-${n}`, provider: 'codex', mode: 'review', status: 'running', model: 'sol',
    origin: { sessionId: 'native-session', workspaceId: 'x'.repeat(2048) },
    result: { subagents: Array.from({ length: 16 }, () => ({ id: 'i'.repeat(128), task: 't'.repeat(128), status: 'running' })) } }));
  const overview = nativeOverview({ sessionId: 'native-session' }, { jobs, queue: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 128000);
  assert.equal(overview.omittedCount, 100 - overview.jobs.length); assert.ok(overview.jobs.length > 0);
});
