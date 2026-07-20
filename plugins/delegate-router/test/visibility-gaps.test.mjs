import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  brokerOwnedCodexThreadIds,
  externalThreadStats,
  readCodexThreadTail,
  scanExternalCodexThreads
} from '../bin/lib/codex-sessions.mjs';
import {
  agentResultStatus,
  completeClaudeAgentStub,
  coordinatorSidecarDirectory,
  createClaudeAgentStub,
  deriveAgentId
} from '../bin/lib/agent-stubs.mjs';
import { captureCodexAllowanceSnapshot } from '../bin/lib/allowance.mjs';
import { inspectJob, readJobEvents } from '../bin/lib/control.mjs';
import { loadJob, listJobs } from '../bin/lib/state.mjs';
import {
  aggregateAuditStats,
  computeUnattributedBurnMarkers,
  unattributedBurnSummary
} from '../bin/lib/stats.mjs';
import { CompositeDatasource } from '../bin/lib/tui/composite-datasource.mjs';
import { directTransportActionMessage } from '../bin/lib/tui/action-policy.mjs';
import { DelegateDataSource } from '../bin/lib/tui/datasource.mjs';
import { RemoteDatasource } from '../bin/lib/tui/remote-datasource.mjs';
import { resolveRemoteTargets } from '../bin/lib/tui/remote-config.mjs';
import { encodeProjectDirectory } from '../bin/lib/tui/sessions.mjs';
import { detailViewModel, fleetViewModel } from '../bin/lib/tui/viewmodels.mjs';
import { renderFrameToString } from '../bin/lib/tui/components.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(testDir);
const hook = path.join(pluginRoot, 'bin', 'delegate-agent-hook');

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeRollout(file, meta, records = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[
    { type: 'session_meta', payload: meta },
    ...records
  ].map(JSON.stringify).join('\n')}\n`);
}

test('external Codex scanner excludes personal and broker-owned threads while including proven app-server work', (t) => {
  const root = tempRoot(t, 'delegate-codex-scan-');
  const sessions = path.join(root, 'sessions', '2026', '07', '20');
  writeRollout(path.join(sessions, 'interactive.jsonl'), {
    id: 'personal-thread', session_id: 'personal-thread', timestamp: '2026-07-20T00:00:00Z', cwd: root,
    originator: 'codex-tui', source: 'cli'
  }, [{ type: 'event_msg', payload: { type: 'agent_message', message: 'private interactive work' } }]);
  writeRollout(path.join(sessions, 'owned.jsonl'), {
    id: 'owned-thread', session_id: 'owned-thread', timestamp: '2026-07-20T00:00:01Z', cwd: root,
    originator: 'delegate-router', source: 'app-server'
  });
  writeRollout(path.join(sessions, 'external.jsonl'), {
    id: 'external-thread', session_id: 'external-thread', timestamp: '2026-07-20T00:00:02Z', cwd: root,
    originator: 'codex_cli_rs', source: 'app-server'
  }, [
    { type: 'event_msg', payload: { type: 'agent_message', message: 'reviewed sk-1234567890abcdefghijkl safely' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } } } }
  ]);
  const duplicate = path.join(sessions, 'external-older-rollout.jsonl');
  writeRollout(duplicate, {
    id: 'external-thread', session_id: 'external-thread', timestamp: '2026-07-19T00:00:00Z', cwd: root,
    originator: 'codex_cli_rs', source: 'app-server'
  });
  fs.utimesSync(duplicate, new Date('2026-07-19T00:00:00Z'), new Date('2026-07-19T00:00:00Z'));

  const scan = scanExternalCodexThreads({
    sessionsDir: path.join(root, 'sessions'),
    ownedIds: new Set(['owned-thread']),
    maxThreads: 10,
    tailBytes: 4096
  });
  assert.equal(scan.threads.length, 1);
  assert.equal(scan.threads[0].providerSessionId, 'external-thread');
  assert.equal(scan.threads[0].external, true);
  assert.equal(scan.threads[0].readOnly, true);
  assert.equal(scan.ownedExcluded, 1);
  assert.equal(scan.personalExcluded, 1);
  assert.equal(scan.duplicatesExcluded, 1);
  assert.deepEqual(externalThreadStats(scan), {
    threadCount: 1,
    usageThreadCount: 1,
    tokenTotals: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
  });
  const tail = readCodexThreadTail(scan.sources.get(scan.threads[0].id), { tailBytes: 4096 });
  assert.ok(tail.bytesRead <= 4096);
  assert.doesNotMatch(JSON.stringify(tail.events), /sk-1234567890abcdefghijkl/);
  assert.match(JSON.stringify(tail.events), /\[REDACTED\]/);
});

test('unattributed burn math suppresses chain-attributed windows and records aggregate-only empty windows', () => {
  const snapshots = [
    { kind: 'allowance-snapshot', provider: 'codex', at: 1000, windows: [{ name: 'primary', usedPercent: 10, resetsAt: 999 }] },
    { kind: 'allowance-snapshot', provider: 'codex', at: 2000, windows: [{ name: 'primary', usedPercent: 12, resetsAt: 999 }] },
    { kind: 'allowance-snapshot', provider: 'codex', at: 3000, windows: [{ name: 'primary', usedPercent: 15, resetsAt: 999 }] }
  ];
  const base = { provider: 'codex', who: 'delegate-control', transport: 'app-server', outcome: { status: 'completed' } };
  const audit = [
    { ...base, at: 1500, jobId: 'root', rootJobId: 'root', usage: { total: { outputTokens: 100 } } },
    { ...base, at: 1900, jobId: 'child', parentJobId: 'root', rootJobId: 'root', usage: { total: { outputTokens: 150 } } }
  ];
  const markers = computeUnattributedBurnMarkers(snapshots, audit);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].windowStartAt, 2000);
  assert.equal(markers[0].windowEndAt, 3000);
  assert.equal(markers[0].amountPercent, 3);
  assert.equal(Object.hasOwn(markers[0], 'threadId'), false);

  const noFalsePositive = computeUnattributedBurnMarkers(snapshots.slice(0, 2), audit);
  assert.deepEqual(noFalsePositive, []);

  const state = { history: [snapshots[0]], providers: { codex: { windows: {} } } };
  const captured = captureCodexAllowanceSnapshot(state, { primary: { usedPercent: 14, resetsAt: 999 } }, {
    now: 2000, source: 'test', auditRecords: [], jobs: []
  });
  assert.equal(captured.markers.length, 1);
  assert.equal(state.history.filter((entry) => entry.kind === 'unattributed-burn').length, 1);
  assert.equal(unattributedBurnSummary(state.history, { now: 2500 }).markerCount, 1);
});

test('Agent hook creates and completes one read-only stub, derives transcript, honors kill switch, and swallows store failure', (t) => {
  const root = tempRoot(t, 'delegate-agent-hook-');
  const stateFile = path.join(root, 'state', 'usage.json');
  const coordinator = path.join(root, 'projects', 'coordinator.jsonl');
  const subagents = path.join(root, 'projects', 'coordinator', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(coordinator, '');
  const transcript = path.join(subagents, 'agent-reviewer-abc123.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-20T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'bounded finding' }] } })}\n`);
  const environment = { ...process.env, DELEGATE_STATE_FILE: stateFile, DELEGATE_AGENT_STUBS: '1' };
  const pre = {
    session_id: 'coordinator-session', tool_use_id: 'toolu_agent_1', transcript_path: coordinator,
    cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { prompt: 'Review token=sk-1234567890abcdefghijkl', subagent_type: 'general-purpose', model: 'opus', name: 'reviewer' }
  };
  const startedAt = performance.now();
  const preRun = spawnSync(process.execPath, [hook], { input: JSON.stringify(pre), encoding: 'utf8', env: environment });
  assert.equal(preRun.status, 0, preRun.stderr);
  assert.ok(performance.now() - startedAt < 1000);

  const previous = process.env.DELEGATE_STATE_FILE;
  process.env.DELEGATE_STATE_FILE = stateFile;
  t.after(() => {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  });
  const stub = listJobs()[0];
  assert.equal(stub.transport, 'claude-agent');
  assert.equal(stub.groupId, 'claude-session-coordinator-session');
  assert.doesNotMatch(stub.promptSummary, /sk-1234567890abcdefghijkl/);

  const postRun = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ ...pre, hook_event_name: 'PostToolUse', tool_response: 'agent_id: reviewer\ncompleted' }),
    encoding: 'utf8', env: environment
  });
  assert.equal(postRun.status, 0, postRun.stderr);
  const completed = inspectJob(stub.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.agentLifecycle, 'completed');
  assert.equal(completed.agentId, 'reviewer');
  assert.equal(completed.coordinatorSidecarDir, coordinator.replace(/\.jsonl$/, ''));
  assert.equal(completed.transcriptPath, transcript);
  assert.deepEqual(readJobEvents(stub.id, { limit: 20 }).map((event) => event.type), ['job.created', 'job.completed']);
  const stats = aggregateAuditStats([JSON.parse(fs.readFileSync(path.join(root, 'state', 'audit.jsonl'), 'utf8').trim())]);
  assert.equal(stats.groups[0].transport, 'claude-agent');

  const backgroundCoordinator = path.join(root, 'projects', 'background-coordinator.jsonl');
  fs.writeFileSync(backgroundCoordinator, '');
  const backgroundPayload = {
    ...pre,
    tool_use_id: 'toolu_background',
    transcript_path: backgroundCoordinator,
    tool_input: { ...pre.tool_input, prompt: 'Work in the background' }
  };
  createClaudeAgentStub({
    sessionId: backgroundPayload.session_id,
    toolUseId: backgroundPayload.tool_use_id,
    cwd: backgroundPayload.cwd,
    coordinatorSidecarDir: coordinatorSidecarDirectory(backgroundPayload.transcript_path),
    prompt: backgroundPayload.tool_input.prompt,
    agentType: backgroundPayload.tool_input.subagent_type,
    agentName: backgroundPayload.tool_input.name,
    model: backgroundPayload.tool_input.model
  });
  const backgroundPost = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      ...backgroundPayload,
      hook_event_name: 'PostToolUse',
      tool_response: {
        status: 'async_launched', agentId: 'background123', description: 'background review',
        prompt: 'Work in the background', outputFile: path.join(root, 'agent-output.txt'), resolvedModel: 'claude-opus'
      }
    }),
    encoding: 'utf8', env: environment
  });
  assert.equal(backgroundPost.status, 0, backgroundPost.stderr);
  const background = listJobs().find((job) => job.toolUseId === 'toolu_background');
  assert.equal(background.status, 'running');
  assert.equal(background.phase, 'spawn-returned');
  assert.equal(background.agentLifecycle, 'spawn-returned');
  assert.equal(background.agentId, 'background123');
  assert.equal(background.coordinatorSidecarDir, backgroundCoordinator.replace(/\.jsonl$/, ''));
  assert.equal(background.transcriptPath, null, 'PostToolUse precedes the background transcript file');
  assert.deepEqual(readJobEvents(background.id, { limit: 20 }).map((event) => event.type), ['job.created', 'job.spawn-returned']);

  const projectsDir = path.join(root, 'claude-projects');
  const source = new DelegateDataSource({ watch: false, pollMs: 100_000, projectsDir });
  source.refreshRecords({ force: true });
  const revisionBeforeLink = inspectJob(background.id).revision;
  return (async () => {
    try {
      let selected = await source.selectJob(background.id);
      assert.equal(selected.hydrationByJob[background.id].transcriptMissing, true);
      const missingFrame = detailViewModel(selected, { jobId: background.id, detailTab: 0, follow: true }, { width: 150, height: 20 });
      assert.equal(missingFrame.panes[0].content.kind, 'empty');
      assert.equal(missingFrame.panes[0].content.message, 'subagent transcript not found (yet) — background agents link once the file appears; reopen to retry');
      assert.match(renderFrameToString(missingFrame), /subagent transcript not found \(yet\).*reopen to retry/);

      const backgroundSubagents = path.join(backgroundCoordinator.replace(/\.jsonl$/, ''), 'subagents');
      fs.mkdirSync(backgroundSubagents, { recursive: true });
      const backgroundTranscript = path.join(backgroundSubagents, 'agent-background123.jsonl');
      const activeAt = Date.now() - 30_000;
      fs.writeFileSync(backgroundTranscript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(activeAt).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'first live line' }] } })}\n`);
      fs.utimesSync(backgroundTranscript, new Date(activeAt), new Date(activeAt));
      await source.selectJob(null);
      selected = await source.selectJob(background.id);
      assert.equal(selected.jobs.find((job) => job.id === background.id).transcriptPath, backgroundTranscript);
      assert.equal(selected.eventsByJob[background.id].length, 1);
      assert.equal(source.metrics.readOnlyTranscriptReads, 1);
      const persisted = inspectJob(background.id);
      assert.equal(persisted.transcriptPath, backgroundTranscript);
      assert.equal(persisted.revision, revisionBeforeLink, 'lazy transcript persistence does not advance revision');

      let fleet = fleetViewModel(selected, { now: activeAt + 30_000 }, { width: 110, height: 20 });
      let activityColumn = fleet.panes[0].content.columns.findIndex((column) => column.key === 'activity');
      let backgroundRow = fleet.panes[0].content.rows.find((row) => row.id === background.id);
      assert.match(backgroundRow.cells[activityColumn].text, /active.*30s/);

      const secondAt = activeAt + 1000;
      fs.appendFileSync(backgroundTranscript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(secondAt).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'second live line' }] } })}\n`);
      fs.utimesSync(backgroundTranscript, new Date(secondAt), new Date(secondAt));
      selected = source.refreshRecords();
      assert.equal(selected.eventsByJob[background.id].length, 2, 'followed transcript picks up appended lines');
      assert.equal(source.metrics.readOnlyTranscriptReads, 2);
      source.refreshRecords();
      assert.equal(source.metrics.readOnlyTranscriptReads, 2, 'unchanged mtime and size cost no transcript read');

      await source.selectJob(null);
      fs.appendFileSync(backgroundTranscript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(secondAt + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'unselected line' }] } })}\n`);
      fs.utimesSync(backgroundTranscript, new Date(secondAt + 1000), new Date(secondAt + 1000));
      source.refreshRecords();
      assert.equal(source.metrics.readOnlyTranscriptReads, 2, 'deselected read-only transcript is not polled');

      selected = await source.selectJob(background.id);
      assert.equal(selected.eventsByJob[background.id].length, 3);
      const idleAt = Date.now() - 301_000;
      fs.utimesSync(backgroundTranscript, new Date(idleAt), new Date(idleAt));
      selected = source.refreshRecords();
      fleet = fleetViewModel(selected, { now: idleAt + 301_000 }, { width: 110, height: 20 });
      activityColumn = fleet.panes[0].content.columns.findIndex((column) => column.key === 'activity');
      backgroundRow = fleet.panes[0].content.rows.find((row) => row.id === background.id);
      assert.match(backgroundRow.cells[activityColumn].text, /idle.*5m/);

      const fallbackCwd = path.join(root, 'fallback-cwd');
      fs.mkdirSync(fallbackCwd);
      const fallbackPayload = {
        ...pre, cwd: fallbackCwd, tool_use_id: 'toolu_fallback',
        tool_input: { ...pre.tool_input, prompt: 'Find my sidecar without a coordinator transcript' }
      };
      delete fallbackPayload.transcript_path;
      createClaudeAgentStub({
        sessionId: fallbackPayload.session_id,
        toolUseId: fallbackPayload.tool_use_id,
        cwd: fallbackPayload.cwd,
        prompt: fallbackPayload.tool_input.prompt,
        agentType: fallbackPayload.tool_input.subagent_type,
        agentName: fallbackPayload.tool_input.name,
        model: fallbackPayload.tool_input.model
      });
      const fallbackResult = { status: 'async_launched', agentId: 'fallback456', description: 'fallback' };
      completeClaudeAgentStub({
        sessionId: fallbackPayload.session_id,
        toolUseId: fallbackPayload.tool_use_id,
        cwd: fallbackPayload.cwd,
        ...agentResultStatus(fallbackResult),
        agentId: deriveAgentId(fallbackResult),
        transcriptPath: null
      });
      const fallback = listJobs().find((job) => job.toolUseId === 'toolu_fallback');
      assert.equal(fallback.coordinatorSidecarDir, null);
      const olderSession = path.join(projectsDir, encodeProjectDirectory(fallbackCwd), 'older-session');
      const olderSubagents = path.join(olderSession, 'subagents');
      fs.mkdirSync(olderSubagents, { recursive: true });
      fs.writeFileSync(path.join(olderSubagents, 'agent-fallback456.jsonl'), `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'stale fallback' } })}\n`);
      fs.utimesSync(olderSession, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      const fallbackSession = path.join(projectsDir, encodeProjectDirectory(fallbackCwd), 'newest-session');
      const fallbackSubagents = path.join(fallbackSession, 'subagents');
      fs.mkdirSync(fallbackSubagents, { recursive: true });
      const fallbackTranscript = path.join(fallbackSubagents, 'agent-fallback456.jsonl');
      fs.writeFileSync(fallbackTranscript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'cwd-scoped fallback' } })}\n`);
      fs.utimesSync(fallbackSession, new Date(), new Date());
      source.refreshRecords({ force: true });
      const fallbackSelected = await source.selectJob(fallback.id);
      assert.equal(fallbackSelected.jobs.find((job) => job.id === fallback.id).transcriptPath, fallbackTranscript);
      assert.equal(inspectJob(fallback.id).transcriptPath, fallbackTranscript);
    } finally {
      source.close();
    }

    const killedRoot = path.join(root, 'killed');
    const killed = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ ...pre, tool_use_id: 'toolu_killed' }), encoding: 'utf8',
      env: { ...environment, DELEGATE_STATE_FILE: path.join(killedRoot, 'usage.json'), DELEGATE_AGENT_STUBS: '0' }
    });
    assert.equal(killed.status, 0);
    assert.equal(fs.existsSync(path.join(killedRoot, 'jobs')), false);

    const broken = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ ...pre, tool_use_id: 'toolu_broken' }), encoding: 'utf8',
      env: { ...environment, DELEGATE_STATE_FILE: '/dev/null/usage.json' }
    });
    assert.equal(broken.status, 0);
    assert.match(broken.stderr, /Agent call continues/);
    assert.equal(broken.stderr.trim().split('\n').length, 1);
  })();
});

class FakeDatasource extends EventEmitter {
  constructor(state, options = {}) {
    super();
    this.state = state;
    this.readOnly = options.readOnly !== false;
    this.host = options.host;
    this.selected = [];
  }
  getState() { return structuredClone(this.state); }
  start() { return this; }
  refresh() { return this.getState(); }
  selectJob(id) { this.selected.push(id); return Promise.resolve(this.getState()); }
  close() {}
}

function childState(host, job, status = 'connected') {
  return {
    jobs: [job], eventsByJob: {}, activityEventsByJob: {}, diffsByJob: {}, diffStatsByJob: {}, hydrationByJob: {},
    providers: [], writerLocks: [], profiles: [], groups: [], audit: [], metadataReady: true, sessions: [],
    sessionScan: { status: 'ready', available: true, scanned: 0, totalFiles: 0 },
    externalScan: { status: 'ready', available: true, scanned: 0, totalFiles: 0 },
    stats: { since: '7d', jobs: 0, groups: [] },
    remote: { enabled: true, host, connection: { status, attempt: status === 'connected' ? 0 : 1, error: status === 'connected' ? null : 'down' } },
    error: null
  };
}

test('composite datasource namespaces jobs, preserves host labels, and isolates one down host', async () => {
  const first = new FakeDatasource(childState('alpha:4263', { id: 'same', provider: 'codex', status: 'running', mode: 'review', cwd: '/a' }), { host: 'alpha:4263' });
  const second = new FakeDatasource(childState('beta:4263', { id: 'same', provider: 'cursor', status: 'completed', mode: 'review', cwd: '/b' }), { host: 'beta:4263' });
  const composite = new CompositeDatasource([
    { source: first, label: 'alpha' },
    { source: second, label: 'beta' }
  ]);
  const initial = composite.getState();
  assert.equal(initial.jobs.length, 2);
  assert.equal(new Set(initial.jobs.map((job) => job.id)).size, 2);
  assert.deepEqual(initial.jobs.map((job) => job.host).sort(), ['alpha', 'beta']);
  assert.equal(initial.remote.connection.status, 'connected');

  second.state = childState('beta:4263', { id: 'same', provider: 'cursor', status: 'completed', mode: 'review', cwd: '/b' }, 'retrying');
  second.emit('change', second.getState());
  const degraded = composite.getState();
  assert.equal(degraded.remote.connection.status, 'degraded');
  assert.equal(degraded.jobs.some((job) => job.host === 'alpha'), true);
  assert.equal(degraded.remote.hosts.find((host) => host.label === 'beta').connection.status, 'retrying');

  const selected = degraded.jobs.find((job) => job.host === 'alpha');
  await composite.selectJob(selected.id);
  assert.equal(first.selected.at(-1), 'same');
  composite.close();
});

test('RemoteDatasource ages out only its own stale rows after repeated failure', async () => {
  let online = true;
  const fetch = async (url) => {
    if (!online) throw new Error('host down');
    const pathname = new URL(url).pathname;
    const value = pathname.endsWith('/jobs') ? { jobs: [{ id: 'one', provider: 'codex', status: 'completed', mode: 'review', cwd: '/x' }] }
      : pathname.endsWith('/usage') ? { providers: [] }
        : pathname.endsWith('/sessions') ? { available: true, sessions: [], scanned: 0, totalFiles: 0 }
          : { since: '7d', jobs: 0, groups: [] };
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const source = new RemoteDatasource({ baseUrl: 'http://127.0.0.1:4991', token: 'token', fetch, pollMs: 100, rowTtlMs: 100, retryBaseMs: 10 });
  source.started = true;
  await source.pollFleet();
  assert.equal(source.getState().jobs.length, 1);
  source.lastSuccessAt = Date.now() - 1000;
  online = false;
  await source.pollFleet();
  assert.equal(source.getState().jobs.length, 0);
  assert.equal(source.getState().remote.connection.status, 'retrying');
  source.close();
});

test('remote config merges CLI precedence and pairs repeatable token files by order', (t) => {
  const root = tempRoot(t, 'delegate-remotes-');
  const configToken = path.join(root, 'config-token');
  const cliToken = path.join(root, 'cli-token');
  fs.writeFileSync(configToken, 'config-secret\n', { mode: 0o600 });
  fs.writeFileSync(cliToken, 'cli-secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'remotes.json'), JSON.stringify([
    { url: 'http://127.0.0.1:4101', tokenFile: configToken, label: 'configured' },
    { url: 'http://127.0.0.1:4102', tokenFile: configToken, label: 'second' }
  ]));
  const targets = resolveRemoteTargets({
    stateDir: root,
    connects: ['http://127.0.0.1:4101', 'http://127.0.0.1:4103'],
    tokenFiles: [cliToken],
    env: { DELEGATE_CONNECT_TOKEN: 'fallback-secret' }
  });
  assert.equal(targets.length, 3);
  assert.equal(targets.find((target) => target.url === 'http://127.0.0.1:4101/').source, 'cli');
  assert.equal(targets.find((target) => target.url === 'http://127.0.0.1:4101/').token, 'cli-secret');
  assert.equal(targets.find((target) => target.url === 'http://127.0.0.1:4103/').token, 'fallback-secret');
});

test('Fleet renders external badge and Host column in wide and compact federation frames', () => {
  const now = Date.now();
  const external = {
    id: 'external-codex-thread', provider: 'codex', model: 'sol', mode: 'external', status: 'external', phase: 'external',
    transport: 'external', external: true, readOnly: true, cwd: '/workspace/external', host: 'alpha',
    createdAt: Math.floor((now - 60_000) / 1000), updatedAt: Math.floor(now / 1000), lastActivityAt: now,
    activityLabel: 'assistant: bounded result', approximateSizeLabel: '42K'
  };
  const store = {
    jobs: [external], eventsByJob: {}, activityEventsByJob: {}, diffsByJob: {}, diffStatsByJob: {}, hydrationByJob: {},
    providers: [], writerLocks: [], groups: [], audit: [], metadataReady: true, sessions: [], stats: { since: '7d', jobs: 0, groups: [] },
    remote: { enabled: true, federation: true, includeLocal: false, hosts: [{ label: 'alpha', connection: { status: 'connected' } }], connection: { status: 'connected' } }
  };
  for (const density of ['wide', 'compact']) {
    const frame = fleetViewModel(store, { now, remote: store.remote, fleetDensity: density, showExternals: true }, { width: 140, height: 24 });
    assert.equal(frame.panes[0].content.columns.some((column) => column.title === 'Host'), true, density);
    assert.ok(frame.panes[0].content.rows[0].style, `${density} external row is dimmed`);
    const rendered = renderFrameToString(frame);
    assert.match(rendered, /external/);
    assert.match(rendered, /alpha/);
    assert.match(rendered, /alpha connected/);
  }
  const hidden = fleetViewModel(store, { now, remote: store.remote, fleetDensity: 'wide', showExternals: false }, { width: 140, height: 24 });
  assert.equal(hidden.meta.visibleJobIds.length, 0);
  const activeOnly = fleetViewModel(store, { now, remote: store.remote, fleetDensity: 'wide', showExternals: true, activeOnly: true }, { width: 140, height: 24 });
  assert.equal(activeOnly.meta.visibleJobIds.length, 0);
  assert.equal(directTransportActionMessage({ screen: 'detail' }, 's', external), 'read-only: external Codex thread');
});
