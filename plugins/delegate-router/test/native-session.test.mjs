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
const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');

function assertValidSessionStartHookOutput(stdout) {
  const output = JSON.parse(stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  const specific = output.hookSpecificOutput;
  assert.equal(specific.hookEventName, 'SessionStart');
  const allowed = new Set([
    'hookEventName',
    'additionalContext',
    'initialUserMessage',
    'sessionTitle',
    'watchPaths',
    'reloadSkills'
  ]);
  for (const key of Object.keys(specific)) {
    assert.ok(allowed.has(key), `unsupported SessionStart hookSpecificOutput field: ${key}`);
  }
  assert.ok(Array.isArray(specific.watchPaths));
  if (Object.hasOwn(specific, 'additionalContext')) assert.equal(typeof specific.additionalContext, 'string');
  return specific;
}

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
    job('codex-expired-b-abcdef', {
      status: 'running',
      phase: 'input-timeout',
      stopReason: 'input-timeout',
      pendingInput: { question: 'expired secret question', timedOut: true },
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
  assert.ok(!context.includes('human input: codex-expired-b-abcdef'));
  assert.equal(NATIVE_CONTEXT_MAX_BYTES, 2_048);
});

test('SessionStart source=compact rehydrates bounded state with a validator-supported payload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-native-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
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
  const invoke = (hookEventName, extra = {}, environment = env) => spawnSync(process.execPath, [sessionHook], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: hookEventName,
      session_id: 'session-native',
      cwd: workspace,
      ...extra
    }),
    env: environment
  });

  const registeredEvents = Object.entries(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks)
    .filter(([, groups]) => groups.some((group) => group.hooks.some((hook) => hook.command?.includes('/bin/delegate-session-hook'))))
    .map(([event]) => event);
  assert.deepEqual(registeredEvents, ['SessionStart']);

  const started = invoke('SessionStart', { source: 'compact' });
  assert.equal(started.status, 0, started.stderr);
  const sessionOutput = assertValidSessionStartHookOutput(started.stdout);
  assert.deepEqual(sessionOutput.watchPaths, [path.join(root, 'collision-watch.signal')]);
  assert.ok(sessionOutput.additionalContext.startsWith(`Delegate work (session; bounded metadata only, max 2048 bytes):
active: codex-live-native-abcdef [codex running]
Use these IDs directly with delegate_inspect/resume; delegate_list is only the overflow or new-session fallback.`));
  assert.match(sessionOutput.additionalContext, /Delegate notification mode: native/);
  assert.match(sessionOutput.additionalContext, /sessionId "session-native"/);
  assert.match(sessionOutput.additionalContext, /invoke delegate-router:monitor-fallback yourself/);
  assert.ok(Buffer.byteLength(sessionOutput.additionalContext, 'utf8') <= NATIVE_CONTEXT_MAX_BYTES);

  const optedOut = invoke('SessionStart', { source: 'compact' }, { ...env, DELEGATE_NATIVE_CONTEXT: '0' });
  assert.equal(optedOut.status, 0, optedOut.stderr);
  const optedOutOutput = assertValidSessionStartHookOutput(optedOut.stdout);
  assert.equal(Object.hasOwn(optedOutOutput, 'additionalContext'), false);

  const unsupported = invoke('PostCompact', { trigger: 'auto', compact_summary: 'not consumed' });
  assert.equal(unsupported.status, 0);
  assert.equal(unsupported.stdout, '');
});
