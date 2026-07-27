import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentResultStatus,
  completeClaudeAgentStub,
  createClaudeAgentStub
} from '../bin/lib/agent-stubs.mjs';
import {
  inspectJob,
  pruneJobs,
  readJobEvents
} from '../bin/lib/control.mjs';
import { loadJob, saveJob } from '../bin/lib/state.mjs';
import { deriveJobActivity } from '../bin/lib/tui/activity.mjs';

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = path.join(pluginRoot, 'bin', 'delegate-agent-hook');

async function isolated(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-agent-lifecycle-'));
  const previousState = process.env.DELEGATE_STATE_FILE;
  const previousQuiet = process.env.DELEGATE_AGENT_STUB_QUIET_SECONDS;
  const previousActive = process.env.DELEGATE_AGENT_STUB_ACTIVE_SECONDS;
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  process.env.DELEGATE_AGENT_STUB_QUIET_SECONDS = '1800';
  process.env.DELEGATE_AGENT_STUB_ACTIVE_SECONDS = '60';
  try { return await fn(root); }
  finally {
    if (previousState == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousState;
    if (previousQuiet == null) delete process.env.DELEGATE_AGENT_STUB_QUIET_SECONDS;
    else process.env.DELEGATE_AGENT_STUB_QUIET_SECONDS = previousQuiet;
    if (previousActive == null) delete process.env.DELEGATE_AGENT_STUB_ACTIVE_SECONDS;
    else process.env.DELEGATE_AGENT_STUB_ACTIVE_SECONDS = previousActive;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function backgroundStub(root, suffix = 'one', now = Date.now()) {
  const coordinator = path.join(root, `${suffix}.jsonl`);
  fs.writeFileSync(coordinator, '');
  const created = createClaudeAgentStub({
    sessionId: 'session-agent-lifecycle',
    toolUseId: `tool-${suffix}`,
    cwd: root,
    coordinatorSidecarDir: coordinator.replace(/\.jsonl$/, ''),
    prompt: 'bounded background task',
    agentType: 'general-purpose',
    now
  });
  return completeClaudeAgentStub({
    sessionId: 'session-agent-lifecycle',
    toolUseId: `tool-${suffix}`,
    ...agentResultStatus({ status: 'async_launched' }),
    agentId: `agent-${suffix}`,
    now
  });
}

function writeAgentTranscript(root, suffix, mtimeMs) {
  const directory = path.join(root, suffix, 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `agent-agent-${suffix}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: 'work' } })}\n`);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('SubagentStop correlates a background stub by agent_id and records the real terminal response', (t) => isolated(t, (root) => {
  const target = backgroundStub(root, 'target');
  const other = backgroundStub(root, 'other');
  const transcript = writeAgentTranscript(root, 'target', Date.now());
  const payload = {
    hook_event_name: 'SubagentStop',
    session_id: 'session-agent-lifecycle',
    agent_id: 'agent-target',
    agent_type: 'general-purpose',
    transcript_path: path.join(root, 'target.jsonl'),
    agent_transcript_path: transcript,
    last_assistant_message: 'actual background result',
    cwd: root
  };
  const run = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_AGENT_STUBS: '1' }
  });
  assert.equal(run.status, 0, run.stderr);
  const completed = inspectJob(target.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.agentLifecycle, 'completed');
  assert.equal(completed.transcriptPath, transcript);
  assert.equal(completed.resultText, 'actual background result');
  assert.equal(inspectJob(other.id).status, 'running');
  assert.equal(readJobEvents(target.id).filter((event) => event.type === 'job.completed').length, 1);
}));

test('a quiet background stub reconciles at read time to ended-unknown idempotently without fabricated success', (t) => isolated(t, (root) => {
  const stub = backgroundStub(root, 'quiet');
  writeAgentTranscript(root, 'quiet', Date.now() - 31 * 60 * 1000);
  const first = inspectJob(stub.id);
  assert.equal(first.status, 'failed');
  assert.equal(first.phase, 'ended-unknown');
  assert.equal(first.agentLifecycle, 'ended-unknown');
  assert.equal(first.errorCode, 'AGENT_COMPLETION_UNKNOWN');
  assert.match(first.error, /no completion signal; transcript quiet for 31m/);
  assert.notEqual(first.status, 'completed');
  const eventCount = readJobEvents(stub.id).length;
  const revision = first.revision;
  const second = inspectJob(stub.id);
  assert.equal(second.revision, revision);
  assert.equal(readJobEvents(stub.id).length, eventCount);
}));

test('a two-day-old pre-existing spawn-returned record heals on inspection without migration', (t) => isolated(t, (root) => {
  const twoDaysAgo = Date.now() - 2 * 86400 * 1000;
  const id = 'claude-agent-owner-shape';
  saveJob({
    schemaVersion: 2,
    id,
    provider: 'claude',
    mode: 'agent',
    status: 'running',
    phase: 'spawn-returned',
    revision: 2,
    lastSeq: 0,
    cwd: root,
    transport: 'claude-agent',
    managedBy: 'delegate-agent-hook',
    readOnly: true,
    toolUseId: 'legacy-tool',
    coordinatorSessionId: 'legacy-session',
    agentId: 'legacy-agent',
    agentLifecycle: 'spawn-returned',
    spawnReturnedAtMs: twoDaysAgo,
    createdAtMs: twoDaysAgo,
    createdAt: Math.floor(twoDaysAgo / 1000),
    updatedAt: Math.floor(twoDaysAgo / 1000)
  });
  const healed = inspectJob(id);
  assert.equal(healed.status, 'failed');
  assert.equal(healed.agentLifecycle, 'ended-unknown');
  assert.equal(loadJob(id).schemaVersion, 2);
  assert.match(healed.agentEndedReason, /transcript quiet for 2880m/);
}));

test('recent transcript growth stays active and quiet-within-window renders idle', (t) => isolated(t, (root) => {
  const active = backgroundStub(root, 'active');
  const activeFile = writeAgentTranscript(root, 'active', Date.now() - 10_000);
  let inspected = inspectJob(active.id);
  assert.equal(inspected.status, 'running');
  assert.equal(inspected.agentActivityState, 'active');
  assert.equal(deriveJobActivity(inspected, [], { now: Date.now() }).kind, 'active');

  const idleAt = Date.now() - 5 * 60 * 1000;
  fs.utimesSync(activeFile, new Date(idleAt), new Date(idleAt));
  inspected = inspectJob(active.id);
  assert.equal(inspected.status, 'running');
  assert.equal(inspected.agentActivityState, 'idle');
  assert.equal(deriveJobActivity(inspected, [], { now: Date.now() }).kind, 'idle');
}));

test('foreground Agent completion remains completed and the lifecycle hooks are registered additively', (t) => isolated(t, (root) => {
  const started = createClaudeAgentStub({
    sessionId: 'foreground-session',
    toolUseId: 'foreground-tool',
    cwd: root,
    prompt: 'foreground task',
    agentType: 'Explore'
  });
  const completed = completeClaudeAgentStub({
    sessionId: 'foreground-session',
    toolUseId: 'foreground-tool',
    status: 'completed',
    agentId: 'foreground-agent'
  });
  assert.equal(completed.id, started.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.agentLifecycle, 'completed');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.ok(hooks.PreToolUse);
  assert.ok(hooks.PostToolUse);
  assert.equal(hooks.SubagentStart[0].matcher, '*');
  assert.equal(hooks.SubagentStop[0].matcher, '*');
}));

test('retention reconciliation prunes old non-terminal agent stubs instead of accumulating them', (t) => isolated(t, (root) => {
  const old = backgroundStub(root, 'retention');
  const record = loadJob(old.id);
  const oldAt = Date.now() - 2 * 86400 * 1000;
  record.createdAtMs = oldAt;
  record.createdAt = Math.floor(oldAt / 1000);
  record.spawnReturnedAtMs = oldAt;
  record.spawnReturnedAt = Math.floor(oldAt / 1000);
  record.updatedAt = Math.floor(oldAt / 1000);
  saveJob(record);
  const result = pruneJobs({ maxAgeDays: 1 });
  assert.deepEqual(result.pruned, [old.id]);
  assert.equal(loadJob(old.id), null);
}));
