import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = path.join(root, 'bin', 'delegate-control-mcp');

test('control MCP initializes and exposes the complete supervision surface', async () => {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'codex,cursor' } });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  for (let i = 0; i < 50 && responses.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(responses[0].result.serverInfo.name, 'delegate-control');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), [
    'delegate_start', 'delegate_inspect', 'delegate_list', 'delegate_stats', 'delegate_events', 'delegate_transcript', 'delegate_diff',
    'delegate_files', 'delegate_steer', 'delegate_cancel', 'delegate_release', 'delegate_respond', 'delegate_resume', 'delegate_review_round', 'delegate_usage',
    'delegate_work', 'delegate_decide', 'delegate_workspace_discard', 'delegate_integrate', 'delegate_start_trivial', 'delegate_interrogate'
  ]);
  const legacySchemas = responses[1].result.tools
    .filter((tool) => !['delegate_work', 'delegate_decide', 'delegate_workspace_discard', 'delegate_integrate', 'delegate_start_trivial', 'delegate_interrogate'].includes(tool.name))
    .map(({ name, inputSchema }) => {
      const legacy = structuredClone(inputSchema);
      if (name === 'delegate_start') {
        delete legacy.properties.isolation;
        delete legacy.properties.pathClaims;
        delete legacy.properties.resourceClaims;
      }
      if (name === 'delegate_stats') {
        delete legacy.properties.until;
        delete legacy.properties.recommendFor;
        legacy.properties.since.description = "Optional duration such as '24h' or '7d'.";
      }
      return { name, inputSchema: legacy };
    });
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacySchemas)).digest('hex'),
    '3e94db27a2c90ded374b1909a16ea9cff9c9df7cfd09737579b8d4fae6e42dc6',
    'existing MCP tool names/order/input schemas changed'
  );
  const start = responses[1].result.tools.find((tool) => tool.name === 'delegate_start');
  const inspect = responses[1].result.tools.find((tool) => tool.name === 'delegate_inspect');
  const respond = responses[1].result.tools.find((tool) => tool.name === 'delegate_respond');
  const resume = responses[1].result.tools.find((tool) => tool.name === 'delegate_resume');
  const stats = responses[1].result.tools.find((tool) => tool.name === 'delegate_stats');
  const work = responses[1].result.tools.find((tool) => tool.name === 'delegate_work');
  const decide = responses[1].result.tools.find((tool) => tool.name === 'delegate_decide');
  const trivial = responses[1].result.tools.find((tool) => tool.name === 'delegate_start_trivial');
  const interrogate = responses[1].result.tools.find((tool) => tool.name === 'delegate_interrogate');
  const integrate = responses[1].result.tools.find((tool) => tool.name === 'delegate_integrate');
  assert.ok(start.inputSchema.properties.idempotencyKey);
  assert.ok(start.inputSchema.properties.maxOutputTokens);
  assert.ok(start.inputSchema.properties.retryPolicy);
  assert.ok(start.inputSchema.properties.verify);
  for (const option of ['profile', 'groupId', 'startPaused', 'ingestFiles', 'autoNudge', 'reportSchema']) {
    assert.ok(start.inputSchema.properties[option], option);
  }
  for (const option of ['networkAllow', 'addDirs', 'approveMcps', 'cursorWorktree', 'cursorWorktreeBase']) {
    assert.ok(start.inputSchema.properties[option], `delegate_start.${option}`);
    assert.ok(resume.inputSchema.properties[option], `delegate_resume.${option}`);
  }
  assert.ok(stats.inputSchema.properties.until);
  assert.ok(stats.inputSchema.properties.recommendFor);
  for (const option of ['isolation', 'pathClaims', 'resourceClaims']) {
    assert.ok(start.inputSchema.properties[option], `delegate_start.${option}`);
  }
  assert.deepEqual(start.inputSchema.properties.waitFor.enum, ['session', 'turn', 'first-output']);
  assert.ok(start.inputSchema.properties.waitForSession);
  assert.ok(start.inputSchema.properties.dryRun);
  assert.ok(inspect.inputSchema.properties.resultWindow);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_release'));
  assert.deepEqual(respond.inputSchema.required, ['jobId', 'expectedRevision']);
  for (const option of ['requestId', 'answer', 'accept', 'response', 'commandId']) assert.ok(respond.inputSchema.properties[option], `delegate_respond.${option}`);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_review_round'));
  assert.equal(stats.inputSchema.additionalProperties, false);
  assert.ok(stats.inputSchema.properties.since);
  assert.ok(resume.inputSchema.properties.maxOutputTokens);
  assert.ok(resume.inputSchema.properties.retryPolicy);
  assert.ok(resume.inputSchema.properties.verify);
  assert.equal(work.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(work.inputSchema.properties), ['id', 'limit']);
  assert.equal(decide.inputSchema.additionalProperties, false);
  assert.deepEqual(decide.inputSchema.required, ['jobId', 'decision']);
  assert.deepEqual(trivial.inputSchema, start.inputSchema);
  assert.deepEqual(interrogate.inputSchema.required, ['jobId', 'expectedRevision', 'question']);
  assert.equal(interrogate.inputSchema.additionalProperties, false);
  assert.deepEqual(integrate.inputSchema.required, ['jobIds']);
});

test('control MCP adds bounded resources and common-flow prompts without changing tools', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-mcp-native-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'usage.json');
  const jobs = path.join(directory, 'jobs');
  const workspace = path.join(directory, 'workspace');
  const jobId = 'codex-native-resource-abcdef';
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    providers: {
      claude: { windows: {} },
      codex: { windows: { primary: { usedPercent: 41, updatedAt: Math.floor(Date.now() / 1000), source: 'test' } } },
      cursor: { windows: {} }
    },
    history: []
  })}\n`);
  fs.writeFileSync(path.join(jobs, `${jobId}.json`), `${JSON.stringify({
    id: jobId,
    provider: 'codex',
    mode: 'review',
    status: 'running',
    phase: 'running',
    managedBy: 'delegate-control',
    pid: process.pid,
    createdAt: Math.floor(Date.now() / 1000),
    origin: { sessionId: 'session-native-mcp', workspaceId: workspace, projectDir: workspace },
    prompt: 'this prompt must never enter the active resource'
  })}\n`);
  const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
  fs.writeFileSync(path.join(jobs, `${jobId}.events.jsonl`), `${JSON.stringify({
    v: 1,
    seq: 1,
    at: Date.now(),
    jobId,
    provider: 'codex',
    type: 'diff.updated',
    data: { diff }
  })}\n`);

  const child = spawn(process.execPath, [server], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workspace,
    env: {
      ...process.env,
      DELEGATE_STATE_FILE: stateFile,
      DELEGATE_ENABLED_PROVIDERS: 'codex,cursor',
      CLAUDE_PROJECT_DIR: workspace,
      CLAUDE_CODE_SESSION_ID: 'session-native-mcp'
    }
  });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'resources/list', params: {} },
    { id: 4, method: 'resources/templates/list', params: {} },
    { id: 5, method: 'resources/read', params: { uri: 'delegate://work/active' } },
    { id: 6, method: 'resources/read', params: { uri: `delegate://job/${jobId}/diff` } },
    { id: 7, method: 'prompts/list', params: {} },
    {
      id: 8,
      method: 'prompts/get',
      params: {
        name: 'delegate_start_scoped_review',
        arguments: { objective: 'Review auth', scope: 'src/auth/**', acceptanceCriteria: 'Rank concrete findings' }
      }
    },
    {
      id: 9,
      method: 'prompts/get',
      params: {
        name: 'delegate_resume_with_findings',
        arguments: { jobId, findings: 'Fix the verified race and rerun tests.' }
      }
    }
  ];
  for (const request of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
  for (let index = 0; index < 150 && responses.length < requests.length; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(responses.length, requests.length, JSON.stringify(responses));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.deepEqual(byId.get(1).result.capabilities, {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false }
  });
  assert.equal(byId.get(2).result.tools.length, 21);
  assert.deepEqual(byId.get(3).result.resources.map((resource) => resource.uri), [
    'delegate://work/active',
    'delegate://repo/profile'
  ]);
  assert.deepEqual(byId.get(4).result.resourceTemplates.map((resource) => resource.uriTemplate), [
    'delegate://job/{id}/diff'
  ]);
  const active = byId.get(5).result.contents[0];
  assert.equal(active.mimeType, 'application/json');
  assert.match(active.text, new RegExp(jobId));
  assert.match(active.text, /"runningCount": 1/);
  assert.ok(!active.text.includes('this prompt must never enter'));
  assert.equal(byId.get(6).result.contents[0].text, diff);
  assert.deepEqual(byId.get(7).result.prompts.map((prompt) => prompt.name), [
    'delegate_start_scoped_review',
    'delegate_resume_with_findings'
  ]);
  assert.match(byId.get(8).result.messages[0].content.text, /managed, read-only independent review/);
  assert.match(byId.get(9).result.messages[0].content.text, new RegExp(jobId));
});

test('native MCP opt-out hides only resources and prompts while preserving every tool', () => {
  const result = spawnSync(process.execPath, [server], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DELEGATE_ENABLED_PROVIDERS: 'codex,cursor',
      DELEGATE_NATIVE_MCP: '0'
    },
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} }
    ].map((request) => JSON.stringify(request)).join('\n') + '\n'
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses[0].result.capabilities, { tools: { listChanged: false } });
  assert.equal(responses[1].result.tools.length, 21);
  assert.equal(responses[2].error.code, -32601);
});

test('delegate_stats returns filtered audit aggregates and totals and rejects job parameters', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-mcp-stats-'));
  const stateFile = path.join(directory, 'usage.json');
  const now = Date.now();
  const records = [
    { at: now - 1000, provider: 'codex', model: 'sol', mode: 'review', outcome: { status: 'completed' }, usage: { total: { outputTokens: 120 } } },
    { at: now - 2000, provider: 'cursor', model: 'grok', mode: 'consult', outcome: { status: 'failed' }, usage: { outputTokens: 30 } },
    { at: now - 10 * 86400000, provider: 'codex', model: 'sol', mode: 'review', outcome: { status: 'cancelled' }, usage: { total: { outputTokens: 900 } } }
  ];
  fs.writeFileSync(path.join(directory, 'audit.jsonl'), `${records.map(JSON.stringify).join('\n')}\n`);
  const child = spawn(process.execPath, [server], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DELEGATE_STATE_FILE: stateFile, DELEGATE_ENABLED_PROVIDERS: 'codex' }
  });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate_stats', arguments: { since: '7d' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_stats', arguments: { since: '7d', jobId: 'not-allowed' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_stats', arguments: { since: '2026-01-01', recommendFor: { mode: 'review', access: 'read' } } } })}\n`);
  for (let i = 0; i < 100 && responses.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  try {
    const aggregate = JSON.parse(responses.find((response) => response.id === 1).result.content[0].text);
    assert.equal(aggregate.jobs, 2, JSON.stringify(aggregate));
    assert.equal(aggregate.groups.length, 2);
    assert.equal(aggregate.rates.providerCompletion.sampleSize, 2);
    assert.equal(aggregate.rates.providerCompletion.rate, null);
    assert.equal(aggregate.rates.verificationPass.sampleSize, 0);
    assert.equal(aggregate.rates.ownerAcceptance.sampleSize, 0);
    assert.deepEqual(aggregate.totals, {
      jobs: 2,
      terminalStatuses: { completed: 1, failed: 1, cancelled: 0 },
      outputTokens: 150
    });
    const rejected = responses.find((response) => response.id === 2).result;
    assert.equal(rejected.isError, true);
    assert.deepEqual(JSON.parse(rejected.content[0].text), {
      error: 'INVALID_REQUEST: delegate_stats unknown parameter: jobId',
      code: 'INVALID_REQUEST',
      retryable: false,
      provider: null
    });
    const recommendation = JSON.parse(responses.find((response) => response.id === 3).result.content[0].text).routingRecommendation;
    assert.equal(recommendation.status, 'insufficient-data');
    assert.equal(recommendation.recommendation, null);
    assert.deepEqual(recommendation.confidence, { level: 0.95, method: 'wilson-score-interval' });
    assert.equal(recommendation.staticRouterChanged, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('delegate_respond queues a revision-safe answer through the control inbox', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-mcp-respond-'));
  const previousState = process.env.DELEGATE_STATE_FILE;
  const previousProviders = process.env.DELEGATE_ENABLED_PROVIDERS;
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'cursor';
  try {
    const { createManagedJob, updateManagedJob } = await import('../bin/lib/control.mjs');
    const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'consult', cwd: directory, prompt: 'answer without changing files' });
    const requestId = 'cursor-question-1';
    const waiting = updateManagedJob(job.id, (current) => {
      current.status = 'running';
      current.phase = 'user-input-required';
      current.stopReason = 'USER_INPUT_REQUIRED';
      current.pid = process.pid;
      current.pendingInput = { requestId, method: 'cursor/ask_question', payload: { question: 'Which directory?' } };
    });
    const child = spawn(process.execPath, [server], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE, DELEGATE_ENABLED_PROVIDERS: 'cursor' }
    });
    const lines = readline.createInterface({ input: child.stdout });
    const responses = [];
    lines.on('line', (line) => responses.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate_respond', arguments: {
      jobId: job.id,
      expectedRevision: waiting.revision,
      requestId,
      answer: 'src',
      commandId: 'mcp-response-1'
    } } })}\n`);
    for (let i = 0; i < 100 && responses.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
    const result = JSON.parse(responses[0].result.content[0].text);
    assert.deepEqual(result, {
      accepted: true,
      commandId: 'mcp-response-1',
      revision: waiting.revision + 1,
      phase: 'responding'
    });
  } finally {
    if (previousState == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousState;
    if (previousProviders == null) delete process.env.DELEGATE_ENABLED_PROVIDERS;
    else process.env.DELEGATE_ENABLED_PROVIDERS = previousProviders;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('delegate-jobs help has CLI parity for caller options', () => {
  const cli = path.join(root, 'bin', 'delegate-jobs');
  const result = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--idempotency-key/);
  assert.match(result.stdout, /--max-output-tokens/);
  assert.match(result.stdout, /resume[^\n]+--max-output-tokens/);
  assert.match(result.stdout, /--retry-max-attempts/);
  assert.match(result.stdout, /--retry-on/);
  assert.match(result.stdout, /--verify-command/);
  assert.match(result.stdout, /--verify-timeout-seconds/);
  assert.match(result.stdout, /revert <job-id> \[--dry-run\]/);
  for (const flag of ['--isolation', '--path-claims', '--resource-claims']) assert.match(result.stdout, new RegExp(flag), flag);
  assert.match(result.stdout, /workspace discard <job-id>/);
  assert.match(result.stdout, /integrate <job-id>/);
  for (const flag of ['--profile', '--group', '--start-paused', '--ingest-files', '--auto-nudge', '--report-schema']) {
    assert.match(result.stdout, new RegExp(flag), flag);
  }
  assert.match(result.stdout, /release <job-id>/);
  assert.match(result.stdout, /stats \[--since/);
  assert.match(result.stdout, /audit backfill/);
  assert.match(result.stdout, /--wait-for session\|turn\|first-output/);
  assert.match(result.stdout, /--wait-for-session/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /work \[--json\] \[--id <job-or-work-id>\]/);
  assert.match(result.stdout, /review-round <job-id> --prompt/);
  assert.match(result.stdout, /result <job-id> \[--find text\] \[--offset N\] \[--max-chars N\]/);
});
