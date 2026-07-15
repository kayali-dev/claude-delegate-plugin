import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildCursorArgs,
  cursorProjectConfigFailure,
  evaluateCursorNetworkPreflight,
  inspectCursorProjectConfig,
  materializeCursorNetworkPolicy,
  resolveCursorBinary
} from '../bin/lib/cursor.mjs';
import {
  appendJobEvent,
  createManagedJob,
  DeltaRedactor,
  inspectJob,
  jobUsage,
  previewManagedJob,
  readJobEvents,
  submitControl
} from '../bin/lib/control.mjs';
import {
  cursorModelCatalog,
  cursorModelDetailed,
  mapCursorAcpUpdate,
  mapCursorAcpNotification,
  mapCursorHeadlessEvent,
  probeCursorAcpCapabilities,
  runManagedProvider
} from '../bin/lib/providers.mjs';
import { TranscriptProjector } from '../bin/lib/tui/transcript.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testDir, 'fake-cursor-parity.mjs');
const cursorModule = path.join(testDir, '..', 'bin', 'lib', 'cursor.mjs');
const healthCli = path.join(testDir, '..', 'bin', 'delegate-health');
const jobsCli = path.join(testDir, '..', 'bin', 'delegate-jobs');

async function isolated(fn, scenario = 'normal') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-cursor-parity-'));
  const previous = new Map();
  const values = {
    DELEGATE_STATE_FILE: path.join(root, 'state', 'usage.json'),
    DELEGATE_ENABLED_PROVIDERS: 'cursor',
    DELEGATE_CURSOR_BIN: fixture,
    DELEGATE_CURSOR_LOGIN_SHELL: '0',
    DELEGATE_CURSOR_HOME: path.join(root, 'home'),
    DELEGATE_MIN_CURSOR_VERSION: '2026.7.0',
    DELEGATE_ACP_GRACE_MS: '0',
    DELEGATE_CURSOR_INPUT_TIMEOUT_MS: '5000',
    FAKE_CURSOR_SCENARIO: scenario
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  try { return await fn(path.join(root, 'work'), root); }
  finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

test('headless read modes stream NDJSON and network elevation plus advanced flags preserve intent', () => {
  const normal = buildCursorArgs({ mode: 'review', model: 'composer-2.5', cwd: '/tmp/work' });
  assert.ok(normal.includes('stream-json'));
  assert.ok(normal.includes('--stream-partial-output'));
  assert.deepEqual(normal.slice(-2), ['--mode', 'plan']);
  const network = buildCursorArgs({
    mode: 'consult', model: 'composer-2.5', cwd: '/tmp/work', network: true, sandbox: 'off',
    addDirs: ['/tmp/one', '/tmp/two'], approveMcps: true, worktree: true, worktreeBase: '/tmp/base'
  });
  assert.ok(!network.includes('--mode'));
  assert.ok(network.includes('--force'));
  assert.deepEqual(network.filter((value) => value === '--add-dir').length, 2);
  assert.ok(network.includes('--approve-mcps'));
  assert.ok(network.includes('--worktree'));
  assert.ok(network.includes('--worktree-base'));
});

test('headless mapper dedupes assistant flushes, keeps thinking ephemeral, normalizes tools, and trusts final result usage', async () => isolated(async (cwd) => {
  const job = createManagedJob({ provider: 'cursor', transport: 'headless', mode: 'review', model: 'composer', cwd, prompt: 'review', maxOutputTokens: 20 });
  const deltas = new DeltaRedactor();
  const assistantParts = [];
  const ephemeral = {
    thinking() { appendJobEvent(job.id, 'activity', { kind: 'thinking' }); },
    output() { appendJobEvent(job.id, 'activity', { kind: 'output' }); }
  };
  const context = { deltas, assistantParts, ephemeral };
  mapCursorHeadlessEvent(job, { type: 'thinking', subtype: 'delta', text: 'hidden-thought-secret', timestamp_ms: 1 }, context);
  mapCursorHeadlessEvent(job, { type: 'assistant', timestamp_ms: 2, message: { content: [{ text: 'draft' }] } }, context);
  mapCursorHeadlessEvent(job, { type: 'assistant', timestamp_ms: 3, model_call_id: 'buffered', message: { content: [{ text: 'draft' }] } }, context);
  mapCursorHeadlessEvent(job, { type: 'assistant', message: { content: [{ text: 'draft' }] } }, context);
  mapCursorHeadlessEvent(job, {
    type: 'tool_call', subtype: 'completed', call_id: 'shell-1',
    tool_call: { shellToolCall: { args: { command: 'pwd', requestedSandboxPolicy: { type: 'TYPE_WORKSPACE_READWRITE', networkAccess: false } }, result: { rejected: { reason: 'policy denied' } } } }
  }, context);
  mapCursorHeadlessEvent(job, { type: 'usage_update', outputTokens: 999 }, context);
  mapCursorHeadlessEvent(job, { type: 'result', result: 'final answer', session_id: 'chat-1', usage: { inputTokens: 5, outputTokens: 2 } }, context);
  const events = readJobEvents(job.id);
  assert.equal(events.filter((event) => event.type === 'message.delta').length, 1);
  assert.equal(events.find((event) => event.type === 'message.completed').data.text, 'final answer');
  assert.equal(events.filter((event) => event.type === 'usage.updated').length, 1);
  const tool = events.find((event) => event.type === 'tool.completed').data;
  assert.equal(tool.rejectedReason, 'policy denied');
  assert.deepEqual(tool.requestedSandboxPolicy, { type: 'TYPE_WORKSPACE_READWRITE', networkAccess: false });
  assert.ok(!JSON.stringify(events).includes('hidden-thought-secret'));
}));

test('network preflight covers mode, sandbox, force, config enums, explicit domains, and fail-fast gates', async () => isolated(async (cwd, root) => {
  const off = evaluateCursorNetworkPreflight({ cwd, mode: 'review', network: false, sandbox: null });
  assert.equal(off.expectedEgress, 'not-requested');
  const forced = evaluateCursorNetworkPreflight({ cwd, mode: 'review', network: true, sandbox: 'off' });
  assert.equal(forced.effectiveMode, 'agent');
  assert.equal(forced.force, true);
  const homeCursor = path.join(root, 'home', '.cursor');
  fs.mkdirSync(homeCursor, { recursive: true });
  for (const value of ['user_config_only', 'user_config_with_defaults', 'allow_all', 'allowlist', 'enabled']) {
    fs.writeFileSync(path.join(homeCursor, 'cli-config.json'), JSON.stringify({ sandbox: { networkAccess: value } }));
    const result = evaluateCursorNetworkPreflight({ cwd, mode: 'implement', network: true, sandbox: null, networkAllow: ['api.example.com'] }, { default: 'deny', allow: ['api.example.com'] });
    assert.equal(result.expectedEgress, 'sandbox-allowlist');
  }
  fs.writeFileSync(path.join(homeCursor, 'cli-config.json'), JSON.stringify({ sandbox: { networkAccess: 'bogus' } }));
  assert.throws(
    () => evaluateCursorNetworkPreflight({ cwd, mode: 'implement', network: true, sandbox: null }, { default: 'allow' }),
    /sandbox\.networkAccess/
  );
  fs.writeFileSync(path.join(homeCursor, 'cli-config.json'), JSON.stringify({ sandbox: { networkAccess: 'user_config_only' } }));
  assert.throws(
    () => evaluateCursorNetworkPreflight({ cwd, mode: 'review', network: true, sandbox: null, networkAllow: ['blocked.example.com'] }, { default: 'deny', allow: ['blocked.example.com'], deny: ['*.example.com'] }),
    /denies requested domain/
  );
  assert.throws(
    () => evaluateCursorNetworkPreflight({ cwd, mode: 'review', network: true, sandbox: null, networkAllow: [] }, { default: 'deny', allow: [] }),
    /contains no usable domains/
  );
}));

test('sandbox.json materializes by merge, restores exact prior bytes, and exit cleanup covers provider crash paths', async () => isolated(async (cwd) => {
  const directory = path.join(cwd, '.cursor');
  const file = path.join(directory, 'sandbox.json');
  fs.mkdirSync(directory, { recursive: true });
  const prior = '{\n  "other": true,\n  "networkPolicy": {"deny":["blocked.example"],"allow":["existing.example"]}\n}\n';
  fs.writeFileSync(file, prior, { mode: 0o640 });
  const mutations = [];
  const materialized = materializeCursorNetworkPolicy({ cwd, network: true, sandbox: null, networkAllow: ['api.example'] }, (type) => mutations.push(type));
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(merged.other, true);
  assert.equal(merged.networkPolicy.default, 'deny');
  assert.deepEqual(merged.networkPolicy.allow, ['existing.example', 'api.example']);
  materialized.cleanup();
  assert.equal(fs.readFileSync(file, 'utf8'), prior);
  assert.deepEqual(mutations, ['network.policy.materialized', 'network.policy.restored']);

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { materializeCursorNetworkPolicy } from ${JSON.stringify(pathToFileURL(cursorModule).href)};
    materializeCursorNetworkPolicy({ cwd: process.argv[1], network: true, sandbox: null, networkAllow: ['crash.example'] });
    process.exit(23);
  `, cwd], { encoding: 'utf8' });
  assert.equal(child.status, 23);
  assert.equal(fs.readFileSync(file, 'utf8'), prior);
}));

test('ACP mapper covers every update variant, raw output, nested diffs, replay, and context occupancy without budget coupling', async () => isolated(async (cwd) => {
  const job = createManagedJob({ provider: 'cursor', mode: 'review', model: 'composer', cwd, prompt: 'review', maxOutputTokens: 1 });
  const context = { sessionId: 'acp-1', messageParts: [], deltas: new DeltaRedactor(), planHolder: {}, ephemeral: { thinking() {}, output() {} } };
  const updates = [
    { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { text: 'user' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { text: 'answer' } },
    { sessionUpdate: 'agent_thought_chunk', content: { text: 'hidden-acp-thought' } },
    { sessionUpdate: 'plan', entries: [{ content: 'one', status: 'pending' }] },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'lint' }] },
    { sessionUpdate: 'current_mode_update', mode: 'plan' },
    { sessionUpdate: 'session_info_update', title: 'A title', model: 'composer-2.5' },
    { sessionUpdate: 'config_option_update', configId: 'model', value: 'composer-2.5' },
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Edit', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Edit', status: 'completed', rawOutput: { stdout: 'ok', stderr: 'warn', exitCode: 0 }, content: { diff: { path: 'a.txt', oldText: 'old', newText: 'new' } } },
    { sessionUpdate: 'usage_update', used: 12, size: 100 }
  ];
  for (const update of updates) mapCursorAcpUpdate(job, update, context);
  mapCursorAcpNotification(job, 'cursor/update_todos', { todos: [{ text: 'one' }], merge: true }, 'acp-1');
  mapCursorAcpNotification(job, 'cursor/task', { title: 'subtask', status: 'running' }, 'acp-1');
  mapCursorAcpNotification(job, 'cursor/generate_image', { path: 'image.png' }, 'acp-1');
  const replayUpdate = { sessionUpdate: 'agent_message_chunk', messageId: 'old', content: { text: 'restored' } };
  mapCursorAcpUpdate(job, replayUpdate, { ...context, replay: true });
  mapCursorAcpUpdate(job, replayUpdate, { ...context, replay: true });
  const events = readJobEvents(job.id);
  assert.ok(events.some((event) => event.type === 'tool.status'));
  assert.equal(events.find((event) => event.type === 'tool.output').data.exitCode, 0);
  assert.ok(events.some((event) => event.type === 'file.changed'
    && event.data.changes?.some((change) => change.path === 'a.txt' && change.added === 1 && change.removed === 1)));
  assert.match(events.find((event) => event.type === 'diff.updated').data.diff, /-old[\s\S]*\+new/);
  assert.ok(events.some((event) => event.type === 'session.updated' && event.data.title === 'A title'));
  assert.ok(events.some((event) => event.type === 'mode.updated'));
  assert.ok(events.some((event) => event.type === 'commands.updated'));
  assert.ok(events.some((event) => event.type === 'plan.updated' && event.data.merge === true));
  assert.ok(events.some((event) => event.type === 'subagent.activity'));
  assert.ok(events.some((event) => event.type === 'artifact.created'));
  assert.ok(!JSON.stringify(events).includes('hidden-acp-thought'));
  assert.equal(events.filter((event) => event.replay === true).length, 1);
  assert.deepEqual(context.messageParts, ['answer']);
  const usage = jobUsage(job.id);
  assert.deepEqual(usage.contextOccupancy, { contextUsed: 12, contextSize: 100 });
  assert.equal(usage.observedAvailable, false);
  const blocks = new TranscriptProjector().project(events);
  assert.equal(blocks.find((block) => block.kind === 'restored').count, 1);
}));

for (const scenario of ['ask-question', 'create-plan']) {
  test(`${scenario} blocks for revisioned coordinator response and idempotent retry`, async () => isolated(async (cwd) => {
    const job = createManagedJob({ provider: 'cursor', mode: 'review', model: 'composer-2.5[fast=true]', cwd, prompt: 'review' });
    const running = runManagedProvider(job);
    const waiting = await waitFor(() => {
      const current = inspectJob(job.id);
      return current.pendingInput ? current : null;
    });
    assert.equal(waiting.phase, 'user-input-required');
    const commandId = `${scenario}-response`;
    const command = scenario === 'ask-question'
      ? { type: 'respond', commandId, requestId: waiting.pendingInput.requestId, answer: 'src' }
      : { type: 'respond', commandId, requestId: waiting.pendingInput.requestId, accept: false, answer: 'revise scope' };
    const responseArgs = [jobsCli, 'respond', job.id, '--expected-revision', String(waiting.revision), '--request-id', waiting.pendingInput.requestId, '--command-id', commandId];
    if (scenario === 'ask-question') responseArgs.push('--answer', 'src');
    else responseArgs.push('--reject', '--answer', 'revise scope');
    const cli = spawnSync(process.execPath, responseArgs, { env: process.env, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const accepted = JSON.parse(cli.stdout);
    assert.equal(accepted.accepted, true);
    const duplicate = submitControl(job.id, command, waiting.revision);
    assert.equal(duplicate.duplicate, true);
    await running;
    const completed = inspectJob(job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.pendingInput, null);
    assert.ok(readJobEvents(job.id).some((event) => event.type === 'input.resolved' && event.data.outcome === 'answered'));
  }, scenario));
}

test('blocking Cursor input rejects after the configured timeout with a durable stopReason', async () => isolated(async (cwd) => {
  process.env.DELEGATE_CURSOR_INPUT_TIMEOUT_MS = '40';
  const job = createManagedJob({ provider: 'cursor', mode: 'review', model: 'composer-2.5[fast=true]', cwd, prompt: 'review' });
  await assert.rejects(runManagedProvider(job), (error) => error.code === 'USER_INPUT_REQUIRED' && /timed out/.test(error.message));
  const failed = inspectJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stopReason, 'input-timeout');
  assert.equal(failed.pendingInput.timedOut, true);
}, 'ask-question'));

test('ACP force selects allow_once, never allow_always, and journals normalized ambiguous context', async () => isolated(async (cwd) => {
  const job = createManagedJob({ provider: 'cursor', mode: 'implement', model: 'composer-2.5[fast=true]', approval: 'force', cwd, prompt: 'implement' });
  await runManagedProvider(job);
  const resolved = readJobEvents(job.id).find((event) => event.type === 'approval.resolved');
  const completed = inspectJob(job.id);
  assert.equal(completed.cursorInitialize.capabilities.loadSession, true);
  assert.ok(completed.cursorConfigOptions.some((option) => option.id === 'model'));
  assert.ok(completed.cursorModels.some((option) => option.value === 'composer-2.5[fast=true]'));
  assert.equal(resolved.data.decision, 'allow_once');
  assert.equal(resolved.data.outcome.optionId, 'once');
  assert.equal(resolved.data.context.ambiguous, true);
  assert.deepEqual(resolved.data.context.paths, ['src/index.js']);
} , 'permission-force'));

test('headless pre-creates chats, falls back on older CLIs, and network read-only jobs carry the strict preamble', async () => isolated(async (cwd) => {
  const job = createManagedJob({ provider: 'cursor', transport: 'headless', mode: 'review', model: 'composer', cwd, prompt: 'review', network: true, sandbox: 'off' });
  await runManagedProvider(job);
  const completed = inspectJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.result.argv.includes('--resume'));
  assert.equal(completed.result.promptHasReadOnlyPreamble, true);
  assert.ok(readJobEvents(job.id).some((event) => event.type === 'session.created'));
  assert.ok(readJobEvents(job.id).some((event) => event.type === 'network.preflight' && event.data.force === true));
}, 'normal'));

test('create-chat missing is an explicit graceful fallback', async () => isolated(async (cwd) => {
  const job = createManagedJob({ provider: 'cursor', transport: 'headless', mode: 'review', model: 'composer', cwd, prompt: 'review' });
  await runManagedProvider(job);
  const event = readJobEvents(job.id).find((item) => item.data?.providerEvent === 'cursor:create-chat-fallback');
  assert.equal(event.data.reason, 'create-chat-unavailable');
}, 'create-chat-missing'));

test('session/load replay is tagged, excluded from live result assembly, and grouped as restored history', async () => isolated(async (cwd) => {
  const job = createManagedJob({
    provider: 'cursor', mode: 'review', model: 'composer-2.5[fast=true]', cwd, prompt: 'continue', providerSessionId: 'acp-restored-session'
  });
  await runManagedProvider(job);
  const events = readJobEvents(job.id);
  const replay = events.filter((event) => event.replay === true);
  assert.equal(replay.length, 2);
  assert.equal(inspectJob(job.id).result.text, '');
  const restored = new TranscriptProjector().project(events).find((block) => block.kind === 'restored');
  assert.equal(restored.count, 2);
}));

test('malformed project cli.json is diagnosed distinctly and names the exact file', async () => isolated(async (cwd) => {
  const directory = path.join(cwd, '.cursor');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'cli.json'), '{not json');
  const status = inspectCursorProjectConfig(cwd);
  assert.equal(status.ok, false);
  assert.match(status.file, /\.cursor[\\/]cli\.json$/);
  assert.throws(
    () => evaluateCursorNetworkPreflight({ cwd, mode: 'review', network: false, sandbox: null }),
    (error) => error.code === 'INVALID_REQUEST' && error.cursorErrorCode === 'CURSOR_PROJECT_CONFIG_INVALID'
  );
  const signature = cursorProjectConfigFailure(`invalid schema in ${status.file}`, cwd);
  assert.equal(signature.code, 'CURSOR_PROJECT_CONFIG_INVALID');
  const health = spawnSync(process.execPath, [healthCli, '--quick', '--json'], { cwd, env: process.env, encoding: 'utf8' });
  assert.equal(JSON.parse(health.stdout).cursor.projectConfig.code, 'CURSOR_PROJECT_CONFIG_INVALID');
}));

test('capability probe is no-turn and reproduces the installed select-option catalog shape', async () => isolated(async (cwd) => {
  const report = await probeCursorAcpCapabilities({ binary: fixture, cwd, timeoutMs: 2000, includeCatalog: true });
  assert.equal(report.ok, true);
  assert.equal(report.noTurn, true);
  assert.equal(report.initialize.loadSession, true);
  assert.deepEqual(report.honorsClientCapabilities, { terminal: false, fsRead: false, fsWrite: false });
  assert.ok(report.configOptionIds.includes('model'));
  assert.equal(report.session.models.currentModelId, 'default[]');
  const modelOption = report.session.configOptions.find((option) => option.id === 'model');
  assert.equal(modelOption.type, 'select');
  assert.equal(modelOption.parameterizedModelPicker, undefined);
  const catalog = cursorModelCatalog(modelOption);
  assert.deepEqual(cursorModelDetailed(catalog, 'composer-2.5'), { value: 'composer-2.5[fast=true]', fastCompromise: true });
  assert.deepEqual(cursorModelDetailed(catalog, 'grok-4.5[effort=high,fast=true]'), {
    value: 'grok-4.5[effort=high,fast=true]', fastCompromise: false
  });
}));

test('parameterizedModelPicker remains preferred when an ACP build advertises it', async () => isolated(async (cwd) => {
  const report = await probeCursorAcpCapabilities({ binary: fixture, cwd, timeoutMs: 2000, includeCatalog: true });
  const modelOption = report.session.configOptions.find((option) => option.id === 'model');
  assert.ok(modelOption.parameterizedModelPicker);
  assert.deepEqual(cursorModelCatalog(modelOption), modelOption.parameterizedModelPicker.options);
  assert.deepEqual(cursorModelDetailed(cursorModelCatalog(modelOption), 'composer-2.5'), {
    value: 'composer-2.5[fast=false]', fastCompromise: false
  });
}, 'picker-extension'));

test('delegate-health prefers status JSON and reports the versioned terminal/fs no-turn detail', async () => isolated(async (cwd) => {
  const result = spawnSync(process.execPath, [healthCli, '--json'], { cwd, env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cursor.statusFormat, 'json');
  assert.equal(report.cursor.capabilityProbe.probeVersion, 1);
  assert.equal(report.cursor.capabilityProbe.noTurn, true);
  assert.deepEqual(report.cursor.capabilityProbe.honorsClientCapabilities, { terminal: false, fsRead: false, fsWrite: false });
}));

test('advanced Cursor job fields validate, persist in dry-run broker output, and reach flags', async () => isolated(async (cwd) => {
  const preview = previewManagedJob({
    provider: 'cursor', mode: 'implement', model: 'composer', cwd, prompt: 'implement', network: true,
    networkAllow: ['api.example.com'], addDirs: ['../shared'], approveMcps: true,
    cursorWorktree: true, cursorWorktreeBase: '../base'
  });
  assert.deepEqual(preview.networkAllow, ['api.example.com']);
  assert.deepEqual(preview.addDirs, [path.resolve(cwd, '../shared')]);
  assert.equal(preview.approveMcps, true);
  assert.equal(preview.cursorWorktree, true);
  assert.equal(preview.cursorWorktreeBase, path.resolve(cwd, '../base'));
  const cli = spawnSync(process.execPath, [
    jobsCli, 'start', '--provider', 'cursor', '--mode', 'implement', '--model', 'composer', '--cwd', cwd,
    '--prompt', 'implement', '--network', '--network-allow', 'api.example.com', '--add-dir', '../one', '--add-dir', '../two',
    '--approve-mcps', '--cursor-worktree', '--cursor-worktree-base', '../base', '--dry-run'
  ], { env: process.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.addDirs.length, 2);
  assert.equal(parsed.approveMcps, true);
  assert.equal(parsed.cursorWorktree, true);
}));

test('live installed Cursor no-turn handshake (explicit opt-in)', {
  skip: process.env.DELEGATE_LIVE_CURSOR_HANDSHAKE === '1' && resolveCursorBinary()
    ? false
    : 'set DELEGATE_LIVE_CURSOR_HANDSHAKE=1; no model prompt is sent'
}, async () => {
  const report = await probeCursorAcpCapabilities({ binary: resolveCursorBinary(), cwd: process.cwd(), timeoutMs: 15000, includeCatalog: true });
  assert.equal(report.ok, true, report.error || report.errorCode);
  assert.equal(report.initialize.loadSession, true);
  assert.equal(report.initialize.resumeSession, false);
  const modelOption = report.session.configOptions.find((option) => option.id === 'model');
  assert.ok(modelOption, 'session/new advertises the model config option');
  const picker = modelOption.parameterizedModelPicker || modelOption.parameterized_model_picker;
  const catalog = cursorModelCatalog(modelOption);
  if (picker) assert.deepEqual(catalog, picker.options || picker.values, 'the picker catalog wins over ordinary options');
  else assert.equal(modelOption.type, 'select', 'this installed build uses the ordinary select-option fallback');
  const bracketed = catalog.find((option) => /\[[^\]]+=/.test(option.value));
  assert.ok(bracketed, 'catalog includes an attributed model variant');
  const plain = bracketed.name || bracketed.value.slice(0, bracketed.value.indexOf('['));
  assert.ok(catalog.some((option) => option.value === cursorModelDetailed(catalog, plain).value));
  assert.deepEqual(cursorModelDetailed(catalog, bracketed.value), { value: bracketed.value, fastCompromise: false });
});
