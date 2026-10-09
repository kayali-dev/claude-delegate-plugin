import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentResultStatus,
  completeClaudeAgentStub,
  correlateClaudeSubagentStart,
  createClaudeAgentStub,
  resolveStoredAgentTranscriptPath
} from '../bin/lib/agent-stubs.mjs';
import { ingestClaudeAgentTranscriptJob } from '../bin/lib/agent-transcript-ingestor.mjs';
import {
  inspectJob,
  pruneJobs,
  readJobEvents
} from '../bin/lib/control.mjs';
import { loadJob, saveJob } from '../bin/lib/state.mjs';
import { deriveJobActivity } from '../bin/lib/tui/activity.mjs';
import { readProcessIdentityTable } from '../bin/lib/process-identity.mjs';

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
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
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
    transcriptAgentId: transcriptId(suffix),
    now
  });
}

function transcriptId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function writeAgentTranscript(root, suffix, mtimeMs) {
  const directory = path.join(root, suffix, 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `agent-${transcriptId(suffix)}.jsonl`);
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
    agent_id: transcriptId('target'),
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
  assert.equal(completed.transcriptAgentId, transcriptId('target'));
  assert.equal(completed.transcriptPath, transcript);
  assert.equal(completed.resultText, 'actual background result');
  assert.equal(inspectJob(other.id).status, 'running');
  assert.equal(readJobEvents(target.id).filter((event) => event.type === 'job.completed').length, 1);
}));

test('SubagentStart exact sidecar correlation survives a later display-name PostToolUse overwrite', (t) => isolated(t, (root) => {
  const sessionId = 'namespace-session';
  const transcriptAgentId = 'a0a9ee00417f2e4b4';
  const sidecar = path.join(root, 'coordinator');
  const coordinatorTranscript = `${sidecar}.jsonl`;
  const subagents = path.join(sidecar, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(coordinatorTranscript, '');
  const target = createClaudeAgentStub({
    sessionId,
    toolUseId: 'toolu_exact_target',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    prompt: 'target',
    agentType: 'Explore'
  });
  createClaudeAgentStub({
    sessionId,
    toolUseId: 'toolu_newer_wrong',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    prompt: 'newer candidate',
    agentType: 'Explore',
    now: Date.now() + 1000
  });
  const transcript = path.join(subagents, `agent-${transcriptAgentId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'resolved' }] } })}\n`);
  fs.writeFileSync(path.join(subagents, `agent-${transcriptAgentId}.meta.json`), JSON.stringify({
    agentType: 'Explore',
    description: 'Map contract-redlining patterns',
    toolUseId: 'toolu_exact_target',
    spawnDepth: 1
  }));

  const correlated = correlateClaudeSubagentStart({
    sessionId,
    transcriptAgentId,
    agentType: 'Explore',
    coordinatorSidecarDir: sidecar
  });
  assert.equal(correlated.id, target.id, 'sidecar toolUseId must beat the newer heuristic candidate');
  assert.equal(correlated.transcriptAgentId, transcriptAgentId);
  assert.equal(correlated.spawnDepth, 1);
  assert.equal(correlated.agentName, 'Map contract-redlining patterns');

  const postRun = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_use_id: 'toolu_exact_target',
      transcript_path: coordinatorTranscript,
      cwd: root,
      tool_name: 'Agent',
      tool_response: { status: 'completed', agentId: 'plan-auditor@session-ba7e9b10' }
    }),
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_AGENT_STUBS: '1', DELEGATE_AGENT_TAIL: '0' }
  });
  assert.equal(postRun.status, 0, postRun.stderr);
  const post = inspectJob(target.id);
  assert.equal(post.agentId, 'plan-auditor@session-ba7e9b10');
  assert.equal(post.transcriptAgentId, transcriptAgentId, 'display identity must not clobber transcript identity');
  assert.equal(resolveStoredAgentTranscriptPath({
    transcriptAgentId: post.transcriptAgentId,
    coordinatorSidecarDir: post.coordinatorSidecarDir
  }), transcript);
  assert.equal(resolveStoredAgentTranscriptPath({
    transcriptAgentId: post.agentId,
    coordinatorSidecarDir: post.coordinatorSidecarDir
  }), null, 'display-shaped legacy ids must never be searched as transcript ids');
  const ingested = ingestClaudeAgentTranscriptJob(post.id);
  assert.ok(ingested.events.some((event) => event.type === 'message.delta' && event.data.delta === 'resolved'));
}));

test('async PostToolUse before SubagentStart preserves both display and transcript identities', (t) => isolated(t, (root) => {
  const sessionId = 'async-namespace-session';
  const transcriptAgentId = 'b1b9ee00417f2e4c';
  const sidecar = path.join(root, 'async-coordinator');
  const subagents = path.join(sidecar, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const created = createClaudeAgentStub({
    sessionId,
    toolUseId: 'toolu_async_target',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    prompt: 'async target',
    agentType: 'Explore'
  });
  completeClaudeAgentStub({
    sessionId,
    toolUseId: 'toolu_async_target',
    ...agentResultStatus({ status: 'async_launched' }),
    agentId: 'landscape-researcher@session-1e3f2225'
  });
  fs.writeFileSync(path.join(subagents, `agent-${transcriptAgentId}.meta.json`), JSON.stringify({
    agentType: 'Explore', description: 'Landscape', toolUseId: 'toolu_async_target', spawnDepth: 1
  }));
  const correlated = correlateClaudeSubagentStart({
    sessionId,
    transcriptAgentId,
    agentType: 'Explore',
    coordinatorSidecarDir: sidecar
  });
  assert.equal(correlated.id, created.id);
  assert.equal(correlated.agentId, 'landscape-researcher@session-1e3f2225');
  assert.equal(correlated.transcriptAgentId, transcriptAgentId);
}));

test('a nested transcript with a readable sidecar never binds to an unrelated pending stub', (t) => isolated(t, (root) => {
  const sessionId = 'nested-correlation-session';
  const transcriptAgentId = 'c2c9ee00417f2e4d';
  const sidecar = path.join(root, 'nested-coordinator');
  const subagents = path.join(sidecar, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const first = createClaudeAgentStub({
    sessionId,
    toolUseId: 'toolu_pending_one',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    prompt: 'first depth-one task',
    agentType: 'Explore'
  });
  const second = createClaudeAgentStub({
    sessionId,
    toolUseId: 'toolu_pending_two',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    prompt: 'second depth-one task',
    agentType: 'Explore',
    now: Date.now() + 1000
  });
  fs.writeFileSync(path.join(subagents, `agent-${transcriptAgentId}.jsonl`), `${JSON.stringify({
    type: 'assistant',
    message: { id: 'nested-message', role: 'assistant', content: [{ type: 'text', text: 'nested work' }] }
  })}\n`);
  fs.writeFileSync(path.join(subagents, `agent-${transcriptAgentId}.meta.json`), JSON.stringify({
    agentType: 'Explore',
    description: 'Nested task without a coordinator stub',
    toolUseId: 'toolu_nested_without_stub',
    spawnDepth: 2
  }));

  const correlated = correlateClaudeSubagentStart({
    sessionId,
    transcriptAgentId,
    agentType: 'Explore',
    coordinatorSidecarDir: sidecar
  });
  assert.equal(correlated, null, 'readable sidecars must never fall through to agentType guessing');
  assert.equal(inspectJob(first.id).transcriptAgentId, null);
  assert.equal(inspectJob(second.id).transcriptAgentId, null);
}));

test('a quiet background stub stays running with unknown activity instead of fabricating failure', (t) => isolated(t, (root) => {
  const stub = backgroundStub(root, 'quiet');
  writeAgentTranscript(root, 'quiet', Date.now() - 31 * 60 * 1000);
  const first = inspectJob(stub.id);
  assert.equal(first.status, 'running');
  assert.equal(first.agentActivityState, 'unknown');
  assert.equal(first.errorCode, undefined);
  assert.notEqual(first.status, 'completed');
  const eventCount = readJobEvents(stub.id).length;
  const revision = first.revision;
  const second = inspectJob(stub.id);
  assert.equal(second.revision, revision);
  assert.equal(readJobEvents(stub.id).length, eventCount);
}));

test('old legacy records without a coordinator identity do not infer death from silence', (t) => isolated(t, (root) => {
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
  assert.equal(healed.status, 'running');
  assert.equal(healed.agentActivityState, 'unknown');
  assert.equal(loadJob(id).schemaVersion, 2);
  assert.equal(healed.agentEndedReason, undefined);
}));

test('quiet orphan reconciliation requires confirmed coordinator exit and is idempotent', (t) => isolated(t, (root) => {
  if (!readProcessIdentityTable().ok) { t.skip('process identity inspection unavailable in sandbox'); return; }
  const stub = backgroundStub(root, 'confirmed-orphan');
  writeAgentTranscript(root, 'confirmed-orphan', Date.now() - 31 * 60 * 1000);
  const record = loadJob(stub.id); record.coordinatorIdentity = { pid: 999999999, startTimeMs: 1 }; saveJob(record);
  const first = inspectJob(stub.id);
  assert.equal(first.status, 'failed'); assert.equal(first.agentLifecycle, 'ended-unknown');
  assert.match(first.error, /coordinator process confirmed gone/);
  const count = readJobEvents(stub.id).length;
  assert.equal(inspectJob(stub.id).revision, first.revision); assert.equal(readJobEvents(stub.id).length, count);
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

test('SubagentStart launches the tail supervisor fire-and-forget without changing hook exit behavior', (t) => isolated(t, async (root) => {
  const transcriptAgentId = 'e4e9ee00417f2e4f';
  const coordinator = path.join(root, 'hook-coordinator.jsonl');
  const sidecar = coordinator.replace(/\.jsonl$/, '');
  const subagents = path.join(sidecar, 'subagents');
  const marker = path.join(root, 'supervisor-invocation.json');
  const fakeSupervisor = path.join(root, 'fake-supervisor.mjs');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(coordinator, '');
  fs.writeFileSync(fakeSupervisor, `import fs from 'node:fs'; fs.writeFileSync(process.env.DELEGATE_AGENT_SUPERVISOR_MARKER, JSON.stringify(process.argv.slice(2)));\n`);
  createClaudeAgentStub({
    sessionId: 'hook-supervisor-session',
    toolUseId: 'toolu_hook_supervisor',
    cwd: root,
    coordinatorSidecarDir: sidecar,
    prompt: 'launch supervisor',
    agentType: 'Explore'
  });
  fs.writeFileSync(path.join(subagents, `agent-${transcriptAgentId}.meta.json`), JSON.stringify({
    agentType: 'Explore', description: 'Launch test', toolUseId: 'toolu_hook_supervisor', spawnDepth: 1
  }));
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'SubagentStart',
      session_id: 'hook-supervisor-session',
      agent_id: transcriptAgentId,
      agent_type: 'Explore',
      transcript_path: coordinator,
      cwd: root
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      DELEGATE_AGENT_STUBS: '1',
      DELEGATE_AGENT_TAIL: '1',
      DELEGATE_SUPERVISOR: '1',
      DELEGATE_AGENT_SUPERVISOR_BIN: fakeSupervisor,
      DELEGATE_AGENT_SUPERVISOR_MARKER: marker
    }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - startedAt < 1000, 'hook must not await supervisor startup');
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['start', '--json']);
}));

test('retention does not prune a quiet agent with no positive completion or death evidence', (t) => isolated(t, (root) => {
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
  assert.deepEqual(result.pruned, []);
  assert.equal(loadJob(old.id).status, 'running');
}));
