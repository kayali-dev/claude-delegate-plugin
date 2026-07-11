import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  effectiveUsage,
  loadJob,
  loadState,
  saveJob,
  saveState,
  setWindow
} from '../bin/lib/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = path.join(root, 'bin', 'delegate-quota-hook');

function withStateFile(fn) {
  const previous = process.env.DELEGATE_STATE_FILE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-router-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { return fn(process.env.DELEGATE_STATE_FILE); }
  finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  }
}

test('usage windows and background jobs persist atomically', () => withStateFile(() => {
  const state = loadState();
  setWindow(state, 'codex', 'primary', 91, { source: 'test' });
  saveState(state);
  assert.equal(effectiveUsage(loadState(), 'codex').usedPercent, 91);
  saveJob({ id: 'cursor-test-job', status: 'running', createdAt: 1 });
  assert.equal(loadJob('cursor-test-job').status, 'running');
}));

test('quota hook blocks Codex above threshold and honors explicit environment override', () => withStateFile((file) => {
  const state = loadState();
  setWindow(state, 'codex', 'primary', 95, { source: 'test' });
  saveState(state);
  const input = JSON.stringify({ tool_name: 'mcp__delegate_codex__codex', tool_input: { prompt: 'task' } });
  const blocked = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: file } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Blocked codex delegation/);
  const managedInput = JSON.stringify({ tool_name: 'mcp__delegate_control__delegate_start', tool_input: { provider: 'codex', prompt: 'task' } });
  const managedBlocked = spawnSync(process.execPath, [hook], { input: managedInput, encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: file } });
  assert.equal(managedBlocked.status, 2);
  const prefixedInput = JSON.stringify({ tool_name: 'mcp__plugin_delegate-router_delegate_control__delegate_start', tool_input: { provider: 'codex', prompt: 'task' } });
  const prefixedBlocked = spawnSync(process.execPath, [hook], { input: prefixedInput, encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: file } });
  assert.equal(prefixedBlocked.status, 2);
  const prefixedDirect = JSON.stringify({ tool_name: 'mcp__plugin_delegate-router_delegate_codex__codex', tool_input: { prompt: 'task' } });
  const prefixedDirectBlocked = spawnSync(process.execPath, [hook], { input: prefixedDirect, encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: file } });
  assert.equal(prefixedDirectBlocked.status, 2);
  const unrelated = JSON.stringify({ tool_name: 'mcp__other_server__codex_helper', tool_input: {} });
  const unrelatedAllowed = spawnSync(process.execPath, [hook], { input: unrelated, encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: file } });
  assert.equal(unrelatedAllowed.status, 0);
  const allowed = spawnSync(process.execPath, [hook], {
    input,
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_STATE_FILE: file, DELEGATE_ALLOW_OVER_LIMIT: 'codex' }
  });
  assert.equal(allowed.status, 0);

  const replyInput = JSON.stringify({ tool_name: 'mcp__delegate_codex__codex-reply', tool_input: { threadId: 'thread-1', prompt: 'continue' } });
  const continuation = spawnSync(process.execPath, [hook], {
    input: replyInput,
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_STATE_FILE: file }
  });
  assert.equal(continuation.status, 0);

  const nearExhausted = loadState();
  setWindow(nearExhausted, 'codex', 'primary', 99, { source: 'test' });
  saveState(nearExhausted);
  const blockedContinuation = spawnSync(process.execPath, [hook], {
    input: replyInput,
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_STATE_FILE: file }
  });
  assert.equal(blockedContinuation.status, 2);
}));
