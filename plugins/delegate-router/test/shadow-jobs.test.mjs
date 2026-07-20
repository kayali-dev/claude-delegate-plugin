import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendJobEvent,
  createManagedJob,
  createShadowJob,
  inspectJob,
  jobTranscript,
  readJobEvents,
  resumeManagedJob,
  reviewRoundManagedJob,
  submitControl,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { readAuditLog, aggregateAudit } from '../bin/lib/stats.mjs';
import { listJobs } from '../bin/lib/state.mjs';
import { directTransportActionMessage } from '../bin/lib/tui/action-policy.mjs';
import { fleetViewModel } from '../bin/lib/tui/viewmodels.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codexServer = path.join(root, 'bin', 'delegate-codex-mcp');
const cursorCli = path.join(root, 'bin', 'delegate-cursor');
const fakeCodex = path.join(root, 'test', 'fake-codex-mcp-server.mjs');
const fakeCursor = path.join(root, 'test', 'fake-cursor-shadow.mjs');

function isolated(t, prefix = 'delegate-shadow-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = {
    state: process.env.DELEGATE_STATE_FILE,
    enabled: process.env.DELEGATE_ENABLED_PROVIDERS,
    codex: process.env.DELEGATE_CODEX_BIN,
    cursor: process.env.DELEGATE_CURSOR_BIN,
    login: process.env.DELEGATE_CURSOR_LOGIN_SHELL
  };
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'state', 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      const key = { state: 'DELEGATE_STATE_FILE', enabled: 'DELEGATE_ENABLED_PROVIDERS', codex: 'DELEGATE_CODEX_BIN', cursor: 'DELEGATE_CURSOR_BIN', login: 'DELEGATE_CURSOR_LOGIN_SHELL' }[name];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

class LineServer {
  constructor(command, args, env) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.lines = [];
    this.stderr = '';
    this.pending = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.pending += chunk;
      for (;;) {
        const newline = this.pending.indexOf('\n');
        if (newline < 0) break;
        const raw = this.pending.slice(0, newline + 1);
        this.pending = this.pending.slice(newline + 1);
        let value = null;
        try { value = JSON.parse(raw.trim()); } catch {}
        this.lines.push({ raw, value });
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
  }

  async request(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = this.lines.find((line) => line.value?.id === message.id && !line.value?.method);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for response ${message.id}: ${this.stderr}`);
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      if (this.child.exitCode != null) resolve();
      else this.child.once('exit', resolve);
    });
  }
}

async function startCodex(env = process.env) {
  const server = new LineServer(process.execPath, [codexServer], { ...env });
  await server.request({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shadow-test', version: '1' } } });
  return server;
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

test('direct Codex calls create redacted direct-mcp shadows with normalized transcript, audit, stats, and descriptions', async (t) => {
  const directory = isolated(t);
  const cwd = path.join(directory, 'work');
  fs.mkdirSync(cwd);
  const server = await startCodex();
  try {
    const listed = await server.request({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} });
    assert.match(listed.value.result.tools.find((tool) => tool.name === 'codex').description, /shadow-journals/);
    assert.match(listed.value.result.tools.find((tool) => tool.name === 'codex-reply').description, /Prefer delegate_start or delegate_resume/);
    const response = await server.request({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'codex', arguments: {
      prompt: 'Review the parser', model: 'gpt-shadow', sandbox: 'read-only', cwd,
      config: { model_reasoning_effort: 'xhigh', synthetic_secret: 'must-redact' }
    } } });
    assert.equal(response.value.result.structuredContent.content, 'shadow codex reply 1');
    const jobs = await waitFor(() => {
      const current = listJobs();
      return current.length === 1 && current[0].status === 'completed' ? current : null;
    }, 'the direct Codex shadow to complete');
    assert.equal(jobs.length, 1);
    const job = inspectJob(jobs[0].id);
    assert.equal(job.transport, 'direct-mcp');
    assert.equal(job.direct, true);
    assert.equal(job.status, 'completed');
    assert.equal(job.model, 'gpt-shadow');
    assert.equal(job.effort, 'xhigh');
    assert.equal(job.directParams.config.synthetic_secret, '[REDACTED]');
    assert.equal(job.providerSessionId, '019f-shadow-codex-thread');
    assert.equal(fs.readFileSync(job.finishedPath, 'utf8').trim(), 'completed');
    const types = readJobEvents(job.id, { limit: 1000 }).map((event) => event.type);
    for (const type of ['message.user', 'message.delta', 'message.completed', 'plan.updated', 'tool.started', 'tool.output', 'tool.completed', 'file.changed', 'diff.updated', 'usage.updated', 'turn.completed']) {
      assert.ok(types.includes(type), type);
    }
    assert.equal(types.filter((type) => type === 'message.completed').length, 1, 'duplicate modern/legacy completion envelopes coalesce');
    const transcript = jobTranscript(job.id).map((event) => JSON.stringify(event.data)).join('\n');
    assert.match(transcript, /shadow codex reply 1/);
    assert.match(transcript, /shadow-edit\.txt/);
    assert.match(transcript, /\+1/);
    assert.doesNotMatch(transcript, /hidden synthetic reasoning/);
    const audit = readAuditLog();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].transport, 'direct-mcp');
    assert.equal(aggregateAudit(audit).totals.jobs, 1);
  } finally {
    await server.close();
  }
});

test('codex-reply creates a parented shadow and cumulative thread usage is chain-attributed once', async (t) => {
  const directory = isolated(t);
  const server = await startCodex();
  try {
    await server.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codex', arguments: { prompt: 'first', cwd: directory, sandbox: 'read-only' } } });
    const rootJob = await waitFor(() => listJobs().find((job) => job.status === 'completed'), 'the root Codex shadow to complete');
    await server.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codex-reply', arguments: { threadId: '019f-shadow-codex-thread', prompt: 'continue' } } });
    const jobs = await waitFor(() => {
      const current = listJobs();
      return current.length === 2 && current.every((job) => job.status === 'completed') ? current : null;
    }, 'both Codex shadow rounds to complete');
    const child = jobs.find((job) => job.id !== rootJob.id);
    assert.ok(child);
    assert.equal(child.parentJobId, rootJob.id);
    assert.equal(child.providerSessionId, rootJob.providerSessionId);
    const audit = readAuditLog();
    assert.equal(audit.length, 2);
    assert.equal(aggregateAudit(audit).totals.outputTokens, 18, '100/10 then 180/18 cumulative totals attribute only the 8-token reply delta');
    assert.ok(readJobEvents(child.id, { limit: 1000 }).some((event) => event.type === 'compaction.completed'));
  } finally {
    await server.close();
  }
});

test('direct transport control operations fail with DIRECT_TRANSPORT', (t) => {
  const directory = isolated(t);
  const job = createShadowJob({ provider: 'codex', transport: 'direct-mcp', prompt: 'read', cwd: directory, mode: 'review', workerPid: process.pid });
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
    current.providerSessionId = 'direct-thread';
    current.completedAt = Math.floor(Date.now() / 1000);
  });
  for (const command of [
    () => submitControl(job.id, { type: 'steer', text: 'x' }, 1),
    () => submitControl(job.id, { type: 'cancel' }, 1),
    () => submitControl(job.id, { type: 'respond', answer: 'x' }, 1),
    () => resumeManagedJob(job.id, { prompt: 'continue' }),
    () => reviewRoundManagedJob(job.id, { prompt: 'findings' })
  ]) assert.throws(command, (error) => error.code === 'DIRECT_TRANSPORT');
});

test('dead direct transport pids reconcile as orphaned and write terminal artifacts', (t) => {
  const directory = isolated(t);
  const job = createShadowJob({ provider: 'cursor', transport: 'direct-cli', prompt: 'read', cwd: directory, mode: 'review', workerPid: 999999999 });
  const failed = inspectJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ORPHANED');
  assert.equal(fs.readFileSync(failed.finishedPath, 'utf8').trim(), 'failed');
  assert.equal(readAuditLog()[0].transport, 'direct-cli');
});

test('Codex wrapper preserves the direct tool-result bytes and store failure degrades to one warning', async (t) => {
  const directory = isolated(t);
  const direct = new LineServer(process.execPath, [fakeCodex], { ...process.env });
  const directResponse = await direct.request({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'codex', arguments: { prompt: 'same bytes', cwd: directory, sandbox: 'read-only' } } });
  await direct.close();

  const stateDir = path.dirname(process.env.DELEGATE_STATE_FILE);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jobs'), 'block shadow store');
  const wrapped = await startCodex();
  const wrappedResponse = await wrapped.request({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'codex', arguments: { prompt: 'same bytes', cwd: directory, sandbox: 'read-only' } } });
  assert.equal(wrappedResponse.raw, directResponse.raw);
  assert.equal((wrapped.stderr.match(/shadow journaling unavailable/g) || []).length, 1);
  await wrapped.close();
});

test('direct Cursor foreground shadows normalized headless events, edit counts, audit, and stats', (t) => {
  const directory = isolated(t);
  const cwd = path.join(directory, 'cursor-work');
  fs.mkdirSync(cwd);
  spawnSync('git', ['init', '-q'], { cwd });
  const result = spawnSync(process.execPath, [cursorCli, '--model', 'composer', '--mode', 'review', '--cwd', cwd, '--prompt', 'Read only'], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_CURSOR_SHADOW_WRITE: '1' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, 'Cursor visible response');
  const job = inspectJob(listJobs()[0].id);
  assert.equal(job.transport, 'direct-cli');
  assert.equal(job.status, 'completed');
  assert.equal(job.directParams.model, 'composer');
  assert.equal(job.changedFiles.count, 1);
  const transcript = jobTranscript(job.id).map((event) => event.data?.text || event.data?.delta || '').join('\n');
  assert.match(transcript, /Cursor visible response/);
  assert.match(transcript, /✎ shadow-edit\.txt \(\+1 −0\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(path.dirname(process.env.DELEGATE_STATE_FILE), 'jobs', `${job.id}.events.jsonl`), 'utf8'), /hidden thought text/);
  const audit = readAuditLog();
  assert.equal(audit[0].transport, 'direct-cli');
  assert.equal(aggregateAudit(audit).totals.jobs, 1);
});

test('direct Cursor background mode creates one complete shadow job', async (t) => {
  const directory = isolated(t);
  const cwd = path.join(directory, 'cursor-background');
  fs.mkdirSync(cwd);
  spawnSync('git', ['init', '-q'], { cwd });
  const launched = spawnSync(process.execPath, [cursorCli, '--background', '--model', 'composer', '--mode', 'review', '--cwd', cwd, '--prompt', 'Background read'], {
    encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);
  const deadline = Date.now() + 5000;
  let job;
  while (Date.now() < deadline) {
    try { job = inspectJob(jobId); } catch {}
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job?.status, 'completed');
  assert.equal(job.transport, 'direct-cli');
  assert.equal(job.directParams.background, true);
  assert.equal(listJobs().filter((candidate) => candidate.transport === 'direct-cli').length, 1);
  assert.match(jobTranscript(job.id).map((event) => JSON.stringify(event.data)).join('\n'), /Cursor visible response/);
});

test('Cursor shadow store failure preserves foreground stdout bytes', (t) => {
  const directory = isolated(t);
  const goodCwd = path.join(directory, 'good');
  const failedCwd = path.join(directory, 'failed');
  fs.mkdirSync(goodCwd);
  fs.mkdirSync(failedCwd);
  const baseArgs = ['--model', 'composer', '--mode', 'review', '--prompt', 'Same Cursor result'];
  const normal = spawnSync(process.execPath, [cursorCli, ...baseArgs, '--cwd', goodCwd], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(normal.status, 0, normal.stderr);

  const failedState = path.join(directory, 'failed-state', 'usage.json');
  fs.mkdirSync(path.dirname(failedState), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(failedState), 'jobs'), 'block shadow store');
  const failed = spawnSync(process.execPath, [cursorCli, ...baseArgs, '--cwd', failedCwd], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: failedState }
  });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(failed.stdout, normal.stdout);
  assert.equal((failed.stderr.match(/shadow journaling unavailable/g) || []).length, 1);
});

test('fleet exposes direct and overlap badges while preserving Directory/Effort and action keys are read-only', (t) => {
  const directory = isolated(t);
  const writer = createManagedJob({ provider: 'codex', prompt: 'write', cwd: directory, mode: 'implement' });
  updateManagedJob(writer.id, (job) => { job.status = 'running'; job.phase = 'working'; job.workerPid = process.pid; });
  const direct = createShadowJob({
    provider: 'cursor', transport: 'direct-cli', prompt: 'write directly', cwd: directory,
    mode: 'implement', effort: 'high', writeCapable: true, workerPid: process.pid
  });
  assert.equal(direct.overlapsManagedWriter, true);
  const frame = fleetViewModel({
    jobs: [direct], providers: [], writerLocks: [], eventsByJob: {}, activityEventsByJob: {}, audit: [], groups: []
  }, { now: Date.now() }, { width: 120, height: 30 });
  const columns = frame.panes[0].content.columns;
  assert.ok(columns.some((column) => column.title === 'Directory'));
  assert.ok(columns.some((column) => column.title === 'Effort'));
  const badges = frame.panes[0].content.rows[0].cells[columns.findIndex((column) => column.key === 'badges')];
  assert.equal(badges.text, 'direct,writer!');
  assert.equal(directTransportActionMessage({ screen: 'detail' }, 's', direct), 'read-only: direct-transport job');
  assert.equal(directTransportActionMessage({ screen: 'detail' }, 'c', direct), 'read-only: direct-transport job');
});
