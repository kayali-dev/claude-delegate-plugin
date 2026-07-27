import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildNativeWorkState,
  NATIVE_CONTEXT_MAX_BYTES,
  renderNativeAdditionalContext,
  renderWorkStateChip
} from '../bin/lib/native-session.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sessionHook = path.join(pluginRoot, 'bin', 'delegate-session-hook');

function usageState(usedPercent = 41) {
  const updatedAt = Math.floor(Date.now() / 1000);
  return {
    version: 1,
    providers: {
      claude: { windows: {} },
      codex: { windows: { primary: { usedPercent, updatedAt, source: 'test' } } },
      cursor: { windows: {} }
    },
    history: []
  };
}

function job(id, values = {}) {
  return {
    id,
    provider: 'codex',
    mode: 'review',
    status: 'completed',
    phase: 'completed',
    managedBy: 'delegate-control',
    createdAt: 1,
    updatedAt: 1,
    origin: {
      sessionId: 'session-native',
      workspaceId: '/tmp/native-workspace',
      projectDir: '/tmp/native-workspace'
    },
    ...values
  };
}

function workState(jobs) {
  return buildNativeWorkState({
    jobs,
    usageState: usageState(),
    enabled: ['codex', 'cursor'],
    scope: 'all'
  });
}

test('status-line work chip renders idle, running, and review-ready states exactly', () => {
  assert.equal(renderWorkStateChip({ workState: workState([]) }), 'D idle · codex 41%');
  assert.equal(renderWorkStateChip({ workState: workState([
    job('codex-running-a-abcdef', { status: 'running', phase: 'running', updatedAt: 3 }),
    job('cursor-running-b-abcdef', { provider: 'cursor', status: 'queued', phase: 'queued', updatedAt: 2 })
  ]) }), 'D 2 running · codex 41%');
  assert.equal(renderWorkStateChip({ workState: workState([
    job('codex-running-c-abcdef', { status: 'running', phase: 'running', updatedAt: 3 }),
    job('codex-review-d-abcdef', {
      acceptance: { state: 'ready-for-review', blockedBy: [] },
      providerSessionId: 'provider-session',
      updatedAt: 2
    })
  ]) }), 'D 1 running · 1 needs review · codex 41%');
});

test('native context is bounded, closed-field redacted, and orders actionable state by policy', () => {
  const jobs = [
    job('codex-policy-a-abcdef', {
      status: 'running',
      phase: 'running',
      scopeViolations: [{ path: 'do-not-render-this-path' }],
      prompt: 'api_key=sk-secret-prompt',
      diff: 'secret diff',
      error: 'secret free-form error',
      updatedAt: 50
    }),
    job('codex-human-b-abcdef', {
      status: 'running',
      phase: 'user-input-required',
      pendingInput: { question: 'secret question' },
      updatedAt: 49
    }),
    job('codex-review-c-abcdef', {
      acceptance: { state: 'ready-for-review' },
      providerSessionId: 'provider-session',
      updatedAt: 48
    }),
    job('codex-failed-d-abcdef', {
      status: 'failed',
      phase: 'failed',
      providerSessionId: 'provider-session',
      error: 'credential secret',
      updatedAt: 47
    }),
    ...Array.from({ length: 30 }, (_, index) => job(
      `codex-extra-${String(index).padStart(2, '0')}-abcdef`,
      { status: 'running', phase: 'running', updatedAt: 40 - index }
    ))
  ];
  const context = renderNativeAdditionalContext({
    workState: workState(jobs),
    maxBytes: 512
  });
  assert.ok(Buffer.byteLength(context, 'utf8') <= 512, Buffer.byteLength(context, 'utf8'));
  assert.match(context, /omitted: \d+ lower-priority item/);
  assert.ok(context.indexOf('policy breach:') < context.indexOf('human input:'));
  assert.ok(!context.includes('sk-secret-prompt'));
  assert.ok(!context.includes('do-not-render-this-path'));
  assert.ok(!context.includes('secret diff'));
  assert.ok(!context.includes('secret free-form error'));
  assert.equal(NATIVE_CONTEXT_MAX_BYTES, 2_048);
});

test('SessionStart and PostCompact inject identical bounded state while only SessionStart arms P2.5 watch paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-native-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'usage.json');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(usageState())}\n`);
  const active = job('codex-live-native-abcdef', {
    status: 'running',
    phase: 'running',
    origin: {
      sessionId: 'session-native',
      workspaceId: workspace,
      projectDir: workspace
    }
  });
  fs.writeFileSync(path.join(root, 'jobs', `${active.id}.json`), `${JSON.stringify(active)}\n`);
  const env = {
    ...process.env,
    DELEGATE_STATE_FILE: stateFile,
    DELEGATE_ENABLED_PROVIDERS: 'codex,cursor',
    CLAUDE_PROJECT_DIR: workspace,
    CLAUDE_CODE_SESSION_ID: 'session-native'
  };
  const invoke = (hookEventName) => spawnSync(process.execPath, [sessionHook], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: hookEventName,
      session_id: 'session-native',
      cwd: workspace
    }),
    env
  });
  const started = invoke('SessionStart');
  const compacted = invoke('PostCompact');
  assert.equal(started.status, 0, started.stderr);
  assert.equal(compacted.status, 0, compacted.stderr);
  const sessionOutput = JSON.parse(started.stdout).hookSpecificOutput;
  const compactOutput = JSON.parse(compacted.stdout).hookSpecificOutput;
  assert.deepEqual(sessionOutput.watchPaths, [path.join(root, 'collision-watch.signal')]);
  assert.equal(Object.hasOwn(compactOutput, 'watchPaths'), false);
  assert.equal(compactOutput.additionalContext, sessionOutput.additionalContext);
  assert.equal(sessionOutput.additionalContext, `Delegate work (session; bounded metadata only, max 2048 bytes):
active: codex-live-native-abcdef [codex running]
Use these IDs directly with delegate_inspect/resume; delegate_list is only the overflow or new-session fallback.`);
  assert.ok(Buffer.byteLength(sessionOutput.additionalContext, 'utf8') <= NATIVE_CONTEXT_MAX_BYTES);

  const optedOut = spawnSync(process.execPath, [sessionHook], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PostCompact',
      session_id: 'session-native',
      cwd: workspace
    }),
    env: { ...env, DELEGATE_NATIVE_CONTEXT: '0' }
  });
  assert.equal(optedOut.status, 0, optedOut.stderr);
  assert.equal(optedOut.stdout, '');
});
