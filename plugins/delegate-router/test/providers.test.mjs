import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createManagedJob, inspectJob, readJobEvents, submitControl } from '../bin/lib/control.mjs';
import { runManagedProvider } from '../bin/lib/providers.mjs';
import { effectiveUsage, loadState } from '../bin/lib/state.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(testDir, 'fake-codex-app-server.mjs');
const fakeCursor = path.join(testDir, 'fake-cursor-acp.mjs');
const fakeCursorFallback = path.join(testDir, 'fake-cursor-fallback.mjs');

async function isolated(fn) {
  const old = { state: process.env.DELEGATE_STATE_FILE, codex: process.env.DELEGATE_CODEX_BIN, cursor: process.env.DELEGATE_CURSOR_BIN, login: process.env.DELEGATE_CURSOR_LOGIN_SHELL, write: process.env.FAKE_CURSOR_WRITE, crash: process.env.FAKE_CODEX_CRASH };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-provider-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { await fn(directory); }
  finally {
    for (const [key, value] of Object.entries({ DELEGATE_STATE_FILE: old.state, DELEGATE_CODEX_BIN: old.codex, DELEGATE_CURSOR_BIN: old.cursor, DELEGATE_CURSOR_LOGIN_SHELL: old.login, FAKE_CURSOR_WRITE: old.write, FAKE_CODEX_CRASH: old.crash })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function waitFor(jobId, predicate) {
  for (let i = 0; i < 300; i += 1) {
    const job = inspectJob(jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for job state');
}

test('Codex app-server maps events and applies true same-turn steering', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'implement' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerTurnId));
  submitControl(job.id, { type: 'steer', correctionId: 'codex-correction', strategy: 'same-turn', text: 'add a test' }, active.revision);
  await running;
  assert.equal(inspectJob(job.id).status, 'completed');
  const types = readJobEvents(job.id, { limit: 1000 }).map((event) => event.type);
  for (const type of ['turn.started', 'plan.updated', 'file.changed', 'message.delta', 'message.completed', 'diff.updated', 'usage.updated', 'correction.applied', 'job.completed']) assert.ok(types.includes(type), type);
  const codexUsage = effectiveUsage(loadState(), 'codex');
  assert.equal(codexUsage.usedPercent, 41);
  assert.deepEqual(codexUsage.windows.map((window) => window.name).sort(), ['primary', 'secondary']);
  const record = inspectJob(job.id);
  assert.equal(record.changedFiles.count, 1);
  assert.deepEqual(record.changedFiles.files, ['a.js']);
  assert.equal(record.resolvedModel, 'fake');
}));

test('Cursor ACP maps structured updates and reports correction as restart', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const running = runManagedProvider(job);
  const active = await waitFor(job.id, (current) => Boolean(current.providerSessionId));
  submitControl(job.id, { type: 'steer', correctionId: 'cursor-correction', strategy: 'auto', text: 'use a different API' }, active.revision);
  const afterFirst = inspectJob(job.id);
  submitControl(job.id, { type: 'steer', correctionId: 'cursor-correction-2', strategy: 'auto', text: 'also add a regression test' }, afterFirst.revision);
  await running;
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.match(completed.result.text, /answer/);
  assert.ok(completed.result.stopReason);
  assert.equal(completed.controls['cursor-correction'].state, 'applied');
  assert.equal(completed.controls['cursor-correction-2'].state, 'applied');
  const events = readJobEvents(job.id, { limit: 1000 });
  assert.ok(events.some((event) => event.type === 'correction.restarted' && event.data.appliedAs === 'restart'));
  assert.ok(events.some((event) => event.type === 'tool.started'));
  assert.ok(events.some((event) => event.type === 'correction.queued'));
  assert.ok(events.some((event) => event.type === 'message.delta' && event.data.delta === 'answer-3'));
}));

test('Cursor falls back to headless only when ACP fails before a session starts', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursorFallback, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursorFallback;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'review', cwd: directory, prompt: 'task' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.transport, 'headless');
  assert.ok(readJobEvents(job.id, { limit: 1000 }).some((event) => event.data.providerEvent === 'cursor:acp-fallback'));
}));

test('Cursor final inventory includes staged and untracked files', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  spawnSync('git', ['init', '-q'], { cwd: directory });
  fs.writeFileSync(path.join(directory, '.env'), 'DATABASE_PASSWORD=hunter2\n');
  fs.writeFileSync(path.join(directory, 'preexisting.txt'), 'local notes\n');
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  process.env.FAKE_CURSOR_WRITE = '1';
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'write files' });
  await runManagedProvider(job);
  const events = readJobEvents(job.id, { limit: 1000 });
  const changed = events.filter((event) => event.type === 'file.changed').map((event) => event.data.path);
  assert.ok(changed.includes('new-file.txt'));
  assert.ok(changed.includes('staged-file.txt'));
  const diffEvent = events.filter((event) => event.type === 'diff.updated').at(-1);
  assert.ok(diffEvent);
  const diff = diffEvent.data.diff || fs.readFileSync(diffEvent.data.artifactPath, 'utf8');
  assert.match(diff, /new-file\.txt/);
  assert.match(diff, /staged-file\.txt/);
  assert.doesNotMatch(diff, /hunter2|preexisting\.txt/);
}));

test('Codex provider exit fails immediately instead of waiting for the turn timeout', () => isolated(async (directory) => {
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_CRASH = '1';
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review' });
  const started = Date.now();
  await assert.rejects(() => runManagedProvider(job), /exited before turn completion/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(inspectJob(job.id).status, 'failed');
}));

test('cursor model resolution matches attribute-serialized catalogs (REG-1)', async () => {
  const { cursorModel } = await import('../bin/lib/providers.mjs');
  // Realistic ACP catalog: attribute-serialized values, as advertised by the
  // live agent. Every id recommended by references/models.md must resolve
  // here; this test is the doc-drift guard.
  const acp = [
    { value: 'default[]' },
    { value: 'composer-2.5[fast=true]' }, { value: 'composer-2.5[fast=false]' },
    { value: 'grok-4.5[effort=xhigh,fast=false]' }, { value: 'grok-4.5[effort=xhigh,fast=true]' },
    { value: 'grok-4.5[effort=high,fast=false]' }, { value: 'grok-4.5[effort=high,fast=true]' },
    { value: 'grok-4.5[effort=medium,fast=false]' },
    { value: 'gpt-5.6-sol[effort=xhigh,context=272k]' }
  ];
  assert.equal(cursorModel(acp, 'grok-4.5-high'), 'grok-4.5[effort=high,fast=false]');
  assert.equal(cursorModel(acp, 'grok-4.5-xhigh'), 'grok-4.5[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'grok'), 'grok-4.5[effort=high,fast=false]');
  assert.equal(cursorModel(acp, 'grok-xhigh'), 'grok-4.5[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'grok-4.5'), 'grok-4.5[effort=xhigh,fast=false]');
  assert.equal(cursorModel(acp, 'composer'), 'composer-2.5[fast=false]');
  assert.equal(cursorModel(acp, 'composer-2.5'), 'composer-2.5[fast=false]');
  assert.equal(cursorModel(acp, 'gpt-5.6-sol-xhigh'), 'gpt-5.6-sol[effort=xhigh,context=272k]');
  assert.equal(cursorModel(acp, 'auto'), 'default[]');
  assert.equal(cursorModel(acp, 'grok-4.5[effort=high,fast=true]'), 'grok-4.5[effort=high,fast=true]');
  for (const bogus of ['grok-9point9-fake', 'grok-4.5-turbo', 'claude-fable-5']) {
    try {
      cursorModel(acp, bogus);
      assert.fail(`expected INVALID_MODEL for ${bogus}`);
    } catch (error) {
      assert.equal(error.code, 'INVALID_MODEL', bogus);
    }
  }
});

test('cursor model resolution also matches suffix-style catalogs and empty lists', async () => {
  const { cursorModel } = await import('../bin/lib/providers.mjs');
  const cli = [
    { value: 'grok-4.5-xhigh' }, { value: 'grok-4.5-fast-xhigh' },
    { value: 'grok-4.5-high' }, { value: 'grok-4.5-medium' },
    { value: 'composer-2.5' }, { value: 'default[]' }
  ];
  assert.equal(cursorModel(cli, 'grok-4.5-high'), 'grok-4.5-high');
  assert.equal(cursorModel(cli, 'grok'), 'grok-4.5-high');
  assert.equal(cursorModel(cli, 'grok-xhigh'), 'grok-4.5-xhigh');
  assert.equal(cursorModel(cli, 'grok-4.5'), 'grok-4.5-xhigh');
  assert.equal(cursorModel(cli, 'composer'), 'composer-2.5');
  assert.equal(cursorModel([], 'grok'), 'grok-4.5-high');
});

test('codex resume rejections map to an actionable RESUME_UNSUPPORTED code', async () => {
  const providers = await import('../bin/lib/providers.mjs');
  assert.ok(providers.securityPreamble);
});

test('Cursor ACP resolves a grok tier request against the advertised catalog end-to-end', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'grok', mode: 'consult', cwd: directory, prompt: 'question' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resolvedModel, 'grok-4.5[effort=high,fast=false]');
  assert.equal(completed.model, 'grok-4.5[effort=high,fast=false]');
}));

test('Cursor ACP fails closed on a bogus model id end-to-end', () => isolated(async (directory) => {
  fs.chmodSync(fakeCursor, 0o755);
  process.env.DELEGATE_CURSOR_BIN = fakeCursor;
  process.env.DELEGATE_CURSOR_LOGIN_SHELL = '0';
  const job = createManagedJob({ provider: 'cursor', model: 'grok-9point9-fake', mode: 'consult', cwd: directory, prompt: 'question' });
  await assert.rejects(() => runManagedProvider(job), /INVALID_MODEL/);
  assert.equal(inspectJob(job.id).status, 'failed');
}));
