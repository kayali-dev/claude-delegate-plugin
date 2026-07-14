import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  capEventsBySize,
  createManagedJob,
  diffStat,
  inspectJob,
  jobDiff,
  jobTranscriptPage,
  jobUsage,
  listManagedJobs,
  readJobEventPage,
  sliceDiff,
  updateManagedJob
} from '../bin/lib/control.mjs';
import {
  authorizeBearer,
  assertLoopbackBind,
  loadOrCreateServeToken,
  startDelegateServe
} from '../bin/lib/serve.mjs';
import { aggregateAuditStats, readAuditLog } from '../bin/lib/stats.mjs';
import { loadState, saveState } from '../bin/lib/state.mjs';
import { remoteActionMessage } from '../bin/lib/tui/action-policy.mjs';
import { DelegateDataSource } from '../bin/lib/tui/datasource.mjs';
import { assertDatasourceInterface } from '../bin/lib/tui/datasource-interface.mjs';
import { RemoteDatasource } from '../bin/lib/tui/remote-datasource.mjs';
import { scanClaudeSessions } from '../bin/lib/tui/sessions.mjs';
import { createViewModel } from '../bin/lib/tui/viewmodels.mjs';

const TOKEN = 'remote-test-token-0123456789abcdef';
const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function isolated(t) {
  const names = ['DELEGATE_STATE_FILE', 'DELEGATE_ENABLED_PROVIDERS', 'DELEGATE_CLAUDE_PROJECTS_DIR'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-remote-'));
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  process.env.DELEGATE_CLAUDE_PROJECTS_DIR = path.join(root, 'claude-projects');
  t.after(() => {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function syntheticStore(t) {
  const root = isolated(t);
  const job = createManagedJob({ provider: 'codex', mode: 'review', cwd: root, prompt: 'Inspect the synthetic store.' });
  appendJobEvent(job.id, 'message.completed', { text: 'Synthetic findings.' });
  appendJobEvent(job.id, 'usage.updated', { total: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } });
  appendJobEvent(job.id, 'diff.updated', {
    diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n-old\n+new\n'
  });
  updateManagedJob(job.id, (record) => {
    record.status = 'completed';
    record.phase = 'completed';
    record.completedAt = Math.floor(Date.now() / 1000);
  });

  const state = loadState();
  state.providers.codex.windows.primary = { usedPercent: 42, source: 'test', updatedAt: Math.floor(Date.now() / 1000) };
  saveState(state);

  const project = path.join(process.env.DELEGATE_CLAUDE_PROJECTS_DIR, '-synthetic');
  fs.mkdirSync(project, { recursive: true });
  const session = path.join(project, 'session-one.jsonl');
  fs.writeFileSync(session, `${JSON.stringify({ type: 'assistant', cwd: root, message: { content: 'Coordinating.' } })}\n`);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(session, future, future);
  return { root, job };
}

async function startTestServer(options = {}) {
  const logs = [];
  const running = await startDelegateServe({
    port: options.port ?? 0,
    env: { ...process.env, DELEGATE_SERVE_TOKEN: TOKEN },
    heartbeatMs: options.heartbeatMs || 25,
    eventPollMs: options.eventPollMs || 20,
    writeTimeoutMs: 2000,
    logger: (line) => logs.push(line)
  });
  return { ...running, logs, baseUrl: `http://127.0.0.1:${running.port}` };
}

function authorized(url, options = {}) {
  return fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${TOKEN}` } });
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function waitFor(source, predicate, timeoutMs = 4000) {
  const current = source.getState();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      source.off('change', changed);
      reject(new Error('timed out waiting for remote datasource state'));
    }, timeoutMs);
    const changed = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      source.off('change', changed);
      resolve(state);
    };
    source.on('change', changed);
  });
}

test('serve.mjs imports no managed-job mutation symbols', () => {
  const source = fs.readFileSync(path.join(pluginRoot, 'bin', 'lib', 'serve.mjs'), 'utf8');
  for (const symbol of ['submitControl', 'launchManagedJob', 'resumeManagedJob', 'revertManagedJob', 'reviewRoundManagedJob', 'updateManagedJob', 'saveJob']) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`));
  }
});

test('server bind validation is loopback-only and first-use tokens are private and stable', (t) => {
  assert.equal(assertLoopbackBind({ env: {} }), '127.0.0.1');
  assert.equal(assertLoopbackBind({ env: { DELEGATE_SERVE_HOST: 'localhost' } }), '127.0.0.1');
  assert.throws(() => assertLoopbackBind({ env: { DELEGATE_SERVE_BIND: '0.0.0.0' } }), /loopback-only/);
  assert.throws(() => assertLoopbackBind({ env: {}, host: '192.0.2.1' }), /loopback-only/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-serve-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = loadOrCreateServeToken({ env: {}, stateDir: root });
  const second = loadOrCreateServeToken({ env: {}, stateDir: root });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.token, second.token);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(first.tokenFile).mode & 0o777, 0o600);
});

test('bearer auth is constant-time shaped and unauthorized responses do not disclose token state', async (t) => {
  syntheticStore(t);
  assert.equal(authorizeBearer(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(authorizeBearer('Bearer wrong-but-same-length-000000000000', TOKEN), false);
  assert.equal(authorizeBearer('Bearer x', TOKEN), false);
  const running = await startTestServer();
  t.after(() => running.close());

  const absent = await fetch(`${running.baseUrl}/v1/health`);
  const wrong = await fetch(`${running.baseUrl}/v1/health`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(absent.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(await absent.text(), 'Unauthorized\n');
  assert.equal(await wrong.text(), 'Unauthorized\n');
  assert.equal(absent.headers.get('cache-control'), 'no-store');
  assert.equal(absent.headers.get('access-control-allow-origin'), null);
});

test('read-only endpoints match existing store readers and reject unsafe job ids', async (t) => {
  const { job } = syntheticStore(t);
  const running = await startTestServer();
  t.after(() => running.close());

  const healthResponse = await authorized(`${running.baseUrl}/v1/health`);
  const health = await healthResponse.json();
  assert.equal(health.version, '0.21.0');
  assert.ok(health.uptime >= 0);
  assert.equal(healthResponse.headers.get('cache-control'), 'no-store');
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), null);

  const listResponse = await authorized(`${running.baseUrl}/v1/jobs?limit=100`);
  assert.deepEqual(await listResponse.json(), jsonValue(listManagedJobs({ limit: 100, activeOnly: false })));

  const inspectedResponse = await authorized(`${running.baseUrl}/v1/jobs/${job.id}`);
  assert.deepEqual(await inspectedResponse.json(), jsonValue(inspectJob(job.id)));

  const eventOptions = { afterSeq: 0, limit: 1000 };
  const eventsResponse = await authorized(`${running.baseUrl}/v1/jobs/${job.id}/events?afterSeq=0&limit=1000`);
  assert.deepEqual(await eventsResponse.json(), capEventsBySize(readJobEventPage(job.id, eventOptions), 60_000));

  const transcriptResponse = await authorized(`${running.baseUrl}/v1/jobs/${job.id}/transcript?afterSeq=0&limit=1000&verbose=true`);
  assert.deepEqual(await transcriptResponse.json(), capEventsBySize(jobTranscriptPage(job.id, { ...eventOptions, verbose: true }), 60_000));

  const diff = jobDiff(job.id);
  const statResponse = await authorized(`${running.baseUrl}/v1/jobs/${job.id}/diff?statOnly=true`);
  assert.deepEqual(await statResponse.json(), diffStat(diff));
  const diffResponse = await authorized(`${running.baseUrl}/v1/jobs/${job.id}/diff?offset=0&maxChars=1000`);
  assert.deepEqual(await diffResponse.json(), sliceDiff(diff, { offset: 0, maxChars: 1000 }));

  const usageResponse = await authorized(`${running.baseUrl}/v1/usage`);
  const usage = await usageResponse.json();
  assert.equal(usage.providers.find((provider) => provider.name === 'codex').allowance.usedPercent, 42);
  const jobUsageResponse = await authorized(`${running.baseUrl}/v1/jobs/${job.id}/usage`);
  assert.deepEqual(await jobUsageResponse.json(), jsonValue(jobUsage(job.id)));

  const sessionsResponse = await authorized(`${running.baseUrl}/v1/sessions`);
  assert.deepEqual(await sessionsResponse.json(), scanClaudeSessions({ env: process.env }));

  const statsResponse = await authorized(`${running.baseUrl}/v1/stats?since=7d`);
  const stats = await statsResponse.json();
  const expectedStats = aggregateAuditStats(readAuditLog(), { since: '7d' });
  assert.deepEqual({ ...stats, generatedAt: 0 }, { ...expectedStats, generatedAt: 0 });

  const unsafe = await authorized(`${running.baseUrl}/v1/jobs/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(unsafe.status, 400);
  assert.equal(await unsafe.text(), 'Bad request\n');
  const unsafeSelector = await authorized(`${running.baseUrl}/v1/jobs/${job.id}/diff?paths=..%2Fsecret`);
  assert.equal(unsafeSelector.status, 400);
  const unknown = await authorized(`${running.baseUrl}/v1/not-real`);
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), 'Not found\n');
  assert.ok(running.logs.every((line) => /^(?:GET) \/\S* \d{3} \d+ms$/.test(line)));
  assert.ok(running.logs.every((line) => !line.includes(TOKEN)));
});

test('SSE streams appended events and heartbeat comments', async (t) => {
  const { job } = syntheticStore(t);
  const running = await startTestServer({ heartbeatMs: 20, eventPollMs: 15 });
  t.after(() => running.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const latestSeq = readJobEventPage(job.id, { afterSeq: 0, limit: 1000 }).latestSeq;
  const response = await fetch(`${running.baseUrl}/v1/jobs/${job.id}/events/stream?afterSeq=${latestSeq}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  appendJobEvent(job.id, 'message.completed', { text: 'SSE appended finding' });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (!received.includes('SSE appended finding') || !received.includes(': heartbeat'))) {
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), 1000))
    ]);
    if (result.done) break;
    received += decoder.decode(result.value, { stream: true });
  }
  assert.match(received, /SSE appended finding/);
  assert.match(received, /: heartbeat/);
  controller.abort();
});

test('RemoteDatasource satisfies the local interface, renders remote identity, tails SSE, and disables mutations', async (t) => {
  const { job } = syntheticStore(t);
  const running = await startTestServer();
  t.after(() => running.close());
  const local = new DelegateDataSource({ watch: false });
  assert.equal(assertDatasourceInterface(local), local);
  local.close();

  const source = new RemoteDatasource({
    baseUrl: running.baseUrl,
    token: TOKEN,
    pollMs: 100,
    retryBaseMs: 20,
    retryMaxMs: 100,
    requestTimeoutMs: 1000
  });
  t.after(() => source.close());
  assert.equal(assertDatasourceInterface(source), source);
  source.start();
  const connected = await waitFor(source, (state) => state.remote.connection.status === 'connected' && state.jobs.some((entry) => entry.id === job.id));
  assert.equal(connected.remote.host, `127.0.0.1:${running.port}`);
  assert.equal(source.readOnly, true);

  const frame = createViewModel(connected, { screen: 'fleet', now: Date.now() }, { width: 120, height: 30 });
  assert.match(frame.title.text, /^\[remote\]/);
  assert.match(frame.title.right, new RegExp(`127\\.0\\.0\\.1:${running.port}`));
  assert.ok(frame.panes[0].content.columns.some((column) => column.key === 'host'));
  assert.match(frame.status.right, /read-only remote/);
  assert.equal(remoteActionMessage({ remote: connected.remote, screen: 'detail' }, 's'), 'read-only remote: control actions are disabled');
  assert.equal(remoteActionMessage({ remote: connected.remote, screen: 'fleet' }, 'N'), 'read-only remote: control actions are disabled');
  assert.equal(remoteActionMessage({ remote: null, screen: 'detail' }, 's'), null);

  await source.selectJob(job.id);
  const selected = source.getState();
  assert.equal(selected.hydrationByJob[job.id].loaded, true);
  assert.ok(selected.eventsByJob[job.id].some((event) => event.data?.text === 'Synthetic findings.'));
  appendJobEvent(job.id, 'message.completed', { text: 'Remote datasource live event' });
  const tailed = await waitFor(source, (state) => state.eventsByJob[job.id]?.some((event) => event.data?.text === 'Remote datasource live event'));
  assert.equal(tailed.remote.connection.status, 'connected');
  const before = JSON.stringify(tailed.jobs);
  await source.reconcileVisibleJobs([job.id]);
  assert.equal(JSON.stringify(source.getState().jobs), before);
});

test('RemoteDatasource reports connection loss and advances retry state without crashing', async (t) => {
  syntheticStore(t);
  const running = await startTestServer();
  const source = new RemoteDatasource({
    baseUrl: running.baseUrl,
    token: TOKEN,
    pollMs: 100,
    retryBaseMs: 20,
    retryMaxMs: 80,
    requestTimeoutMs: 250
  }).start();
  t.after(() => source.close());
  await waitFor(source, (state) => state.remote.connection.status === 'connected');
  await running.close({ timeoutMs: 200 });
  const retrying = await waitFor(source, (state) => state.remote.connection.status === 'retrying' && state.remote.connection.attempt >= 1, 4000);
  assert.ok(retrying.remote.connection.retryAt >= Date.now() - 1000);
  assert.match(retrying.remote.connection.error, /fetch|connect|request|unavailable/i);
});
