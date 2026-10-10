import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForChildExit, waitForCondition } from './helpers/wait.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = path.join(root, 'bin', 'delegate-control-mcp');

test('control MCP initializes and exposes the complete supervision surface', async () => {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'codex,cursor' } });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  await waitForCondition({
    description: 'initialize and tools/list MCP responses',
    timeoutMs: 1_000,
    observe: () => ({ count: responses.length }),
    predicate: (state) => state.count >= 2,
    summarize: (state) => `responses=${state.count}`
  });
  child.stdin.end();
  await waitForChildExit({ child, description: 'the initialized control MCP process to exit' });
  assert.equal(responses[0].result.serverInfo.name, 'delegate-control');
  assert.equal(responses[0].result.protocolVersion, '2025-11-25');
  assert.match(responses[0].result.instructions, /Claude remains coordinator/);
  assert.equal(responses[1].result.tools.find((tool) => tool.name === 'delegate_inspect').annotations.readOnlyHint, true);
  assert.equal(responses[1].result.tools.find((tool) => tool.name === 'delegate_start').annotations.readOnlyHint, false);
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), [
    'delegate_start', 'delegate_inspect', 'delegate_list', 'delegate_stats', 'delegate_events', 'delegate_transcript', 'delegate_diff',
    'delegate_files', 'delegate_steer', 'delegate_cancel', 'delegate_release', 'delegate_respond', 'delegate_resume', 'delegate_review_round', 'delegate_usage',
    'delegate_work', 'delegate_decide', 'delegate_workspace_discard', 'delegate_integrate', 'delegate_integration', 'delegate_start_trivial', 'delegate_interrogate', 'delegate_verify'
  ]);
  const legacySchemas = responses[1].result.tools
    .filter((tool) => !['delegate_work', 'delegate_decide', 'delegate_workspace_discard', 'delegate_integrate', 'delegate_integration', 'delegate_start_trivial', 'delegate_interrogate', 'delegate_verify'].includes(tool.name))
    .map(({ name, inputSchema }) => {
      const legacy = structuredClone(inputSchema);
      if (['delegate_start', 'delegate_resume'].includes(name)) {
        delete legacy.properties.autoFix;
        delete legacy.properties.maxSubagents;
        delete legacy.properties.maxTotalOutputTokens;
        if (legacy.properties.reportSchema) legacy.properties.reportSchema.description = 'Best-effort structured final-result contract. Missing or invalid JSON never fails the job.';
        const verify = legacy.properties.verify;
        legacy.properties.verify = {
          type: 'object', required: ['command'], additionalProperties: false,
          properties: { command: verify.properties.command, timeoutSeconds: verify.properties.timeoutSeconds },
          ...(verify.description ? { description: verify.description } : {})
        };
      }
      if (name === 'delegate_start') {
        delete legacy.properties.isolation;
        delete legacy.properties.pathClaims;
        delete legacy.properties.resourceClaims;
        delete legacy.properties.allowUnscopedWrite;
      }
      if (name === 'delegate_resume') {
        delete legacy.properties.allowUnscopedWrite;
      }
      if (name === 'delegate_review_round') {
        delete legacy.properties.planFirst;
        delete legacy.properties.ambiguityCheck;
      }
      if (name === 'delegate_inspect') {
        delete legacy.properties.view;
      }
      if (name === 'delegate_list') {
        delete legacy.properties.phase;
        delete legacy.properties.blockedOnInput;
      }
      if (name === 'delegate_stats') {
        delete legacy.properties.model;
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
  const list = responses[1].result.tools.find((tool) => tool.name === 'delegate_list');
  const respond = responses[1].result.tools.find((tool) => tool.name === 'delegate_respond');
  const resume = responses[1].result.tools.find((tool) => tool.name === 'delegate_resume');
  const stats = responses[1].result.tools.find((tool) => tool.name === 'delegate_stats');
  const work = responses[1].result.tools.find((tool) => tool.name === 'delegate_work');
  const decide = responses[1].result.tools.find((tool) => tool.name === 'delegate_decide');
  const trivial = responses[1].result.tools.find((tool) => tool.name === 'delegate_start_trivial');
  const interrogate = responses[1].result.tools.find((tool) => tool.name === 'delegate_interrogate');
  const verify = responses[1].result.tools.find((tool) => tool.name === 'delegate_verify');
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
  assert.deepEqual(inspect.inputSchema.properties.view.enum, ['summary', 'full']);
  assert.equal(inspect.inputSchema.properties.view.default, 'full');
  assert.ok(list.inputSchema.properties.phase);
  assert.ok(list.inputSchema.properties.blockedOnInput);
  assert.ok(start.inputSchema.properties.allowUnscopedWrite);
  assert.ok(resume.inputSchema.properties.allowUnscopedWrite);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_release'));
  assert.deepEqual(respond.inputSchema.required, ['jobId', 'expectedRevision']);
  for (const option of ['requestId', 'answer', 'accept', 'response', 'commandId']) assert.ok(respond.inputSchema.properties[option], `delegate_respond.${option}`);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_review_round'));
  const reviewRound = responses[1].result.tools.find((tool) => tool.name === 'delegate_review_round');
  assert.equal(reviewRound.inputSchema.properties.planFirst.type, 'boolean');
  assert.equal(reviewRound.inputSchema.properties.ambiguityCheck.type, 'boolean');
  const integration = responses[1].result.tools.find((tool) => tool.name === 'delegate_integration');
  assert.equal(integration.inputSchema.additionalProperties, false);
  assert.deepEqual(integration.inputSchema.properties.action.enum, ['inspect', 'discard']);
  assert.equal(integration.annotations.readOnlyHint, false, 'combined inspect/discard must not advertise blanket read-only');
  assert.equal(stats.inputSchema.additionalProperties, false);
  assert.ok(stats.inputSchema.properties.since);
  assert.ok(resume.inputSchema.properties.maxOutputTokens);
  assert.ok(resume.inputSchema.properties.retryPolicy);
  assert.ok(resume.inputSchema.properties.verify);
  for (const tool of [start, resume]) {
    const verifySchema = tool.inputSchema.properties.verify;
    assert.equal(verifySchema.required, undefined, 'exception must not require a command');
    assert.ok(verifySchema.properties.exception);
    assert.deepEqual(verifySchema.oneOf.map((branch) => branch.required), [['command'], ['exception']]);
    assert.deepEqual(verifySchema.oneOf[1].not.anyOf, [{ required: ['command'] }, { required: ['timeoutSeconds'] }]);
    assert.equal(tool.inputSchema.properties.autoFix.properties.maxRounds.maximum, 100);
    assert.match(tool.inputSchema.properties.autoFix.description, /hard-caps execution at three/);
    assert.equal(tool.inputSchema.properties.maxSubagents.maximum, 16);
    assert.equal(tool.inputSchema.properties.maxSubagents.minimum, 0);
    assert.equal(tool.inputSchema.properties.maxTotalOutputTokens.minimum, 1);
  }
  assert.equal(stats.inputSchema.properties.model.maxLength, 128);
  assert.equal(work.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(work.inputSchema.properties), ['id', 'limit']);
  assert.equal(decide.inputSchema.additionalProperties, false);
  assert.deepEqual(decide.inputSchema.required, ['jobId', 'decision']);
  assert.deepEqual(trivial.inputSchema, start.inputSchema);
  assert.deepEqual(interrogate.inputSchema.required, ['jobId', 'expectedRevision', 'question']);
  assert.equal(interrogate.inputSchema.additionalProperties, false);
  assert.deepEqual(verify.inputSchema.required, ['jobId']);
  assert.equal(verify.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(verify.inputSchema.properties), ['jobId']);
  assert.deepEqual(integrate.inputSchema.required, ['jobIds']);
});

test('MCP servers negotiate unsupported wire versions rather than echoing them', () => {
  for (const executable of ['delegate-control-mcp', 'delegate-codex-mcp']) {
    const run = spawnSync(process.execPath, [path.join(root, 'bin', executable)], {
      encoding: 'utf8', env: { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'cursor' },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }) + '\n'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).result.protocolVersion, '2025-11-25');
  }
});

test('control MCP adds bounded resources and common-flow prompts without changing tools', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-mcp-native-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
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
  await waitForCondition({
    description: 'all control MCP resource, prompt, and tool responses',
    timeoutMs: 3_000,
    observe: () => ({ count: responses.length, expected: requests.length }),
    predicate: (state) => state.count >= state.expected,
    summarize: (state) => `responses=${state.count}/${state.expected}`
  });
  child.stdin.end();
  await waitForChildExit({ child, description: 'the control MCP resource process to exit' });
  assert.equal(responses.length, requests.length, JSON.stringify(responses));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.deepEqual(byId.get(1).result.capabilities, {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false }
  });
  assert.equal(byId.get(2).result.tools.length, 23);
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
  assert.equal(responses[1].result.tools.length, 23);
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
  await waitForCondition({
    description: 'three delegate_stats MCP responses',
    timeoutMs: 2_000,
    observe: () => ({ count: responses.length }),
    predicate: (state) => state.count >= 3,
    summarize: (state) => `responses=${state.count}/3`
  });
  child.stdin.end();
  await waitForChildExit({ child, description: 'the control MCP stats process to exit' });
  try {
    const aggregate = JSON.parse(responses.find((response) => response.id === 1).result.content[0].text);
    assert.equal(aggregate.jobs, 2, JSON.stringify(aggregate));
    assert.equal(aggregate.groups.length, 2);
    assert.equal(aggregate.rates.providerCompletion.sampleSize, 2);
    assert.equal(aggregate.rates.providerCompletion.rate, null);
    assert.equal(aggregate.rates.verificationPass.sampleSize, 0);
    assert.equal(aggregate.rates.ownerAcceptance.sampleSize, 0);
    assert.deepEqual(aggregate.planFirst, {
      requested: 0,
      completed: 0,
      degraded: 0,
      recovered: 0,
      structurallyInvalidProbes: 0,
      structurallyInvalidReasons: {},
      comparableProbes: 0,
      unparseableProbes: 0,
      unusableProbes: 0,
      outputValidityUnknown: 0,
      structuralOutputSampleSize: 0,
      structuralValidityRate: null,
      wastedOutputTokens: 0,
      wastedOutputTokensObserved: 0,
      wastedOutputTokensReserved: 0,
      probeOutputHealth: {
        status: 'insufficient-data',
        minimumRepeatedFailures: 3,
        sampleSize: 0,
        comparableProbes: 0,
        unparseableProbes: 0,
        validityRate: null,
        structurallyInvalidReasons: {},
        wastedOutputTokens: 0,
        wastedOutputTokensObserved: 0,
        wastedOutputTokensReserved: 0
      },
      otherDegradedProbes: 0,
      fallbackAttempts: 0,
      pending: 0,
      unknown: 0,
      completionRate: null,
      degradationRate: null
    });
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
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('delegate_files adds lower-bound metadata without changing its input schema', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-mcp-files-'));
  const previousState = process.env.DELEGATE_STATE_FILE;
  const previousProviders = process.env.DELEGATE_ENABLED_PROVIDERS;
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex';
  try {
    const { appendJobEvent, createManagedJob, updateManagedJob } = await import('../bin/lib/control.mjs');
    const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'implement', cwd: directory, prompt: 'touch one observed file' });
    appendJobEvent(job.id, 'file.changed', { path: 'observed.js', kind: 'update' });
    updateManagedJob(job.id, (current) => {
      current.status = 'completed';
      current.phase = 'completed';
      current.changedFiles = { count: 1, files: ['observed.js'] };
    });

    const child = spawn(process.execPath, [server], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE, DELEGATE_ENABLED_PROVIDERS: 'codex' }
    });
    const lines = readline.createInterface({ input: child.stdout });
    const responses = [];
    lines.on('line', (line) => responses.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'delegate_files', arguments: { jobId: job.id }
    } })}\n`);
    await waitForCondition({
      description: 'delegate_files lower-bound response',
      timeoutMs: 2_000,
      observe: () => responses[0] || null
    });
    child.stdin.end();
    await waitForChildExit({ child, description: 'delegate_files MCP process to exit' });
    const payload = JSON.parse(responses[0].result.content[0].text);
    assert.equal(payload.count, 1);
    assert.equal(payload.countIsLowerBound, true);
    assert.equal(payload.attributionConfidence, 'best-effort');
    assert.deepEqual(payload.files.map((entry) => entry.path), ['observed.js']);
  } finally {
    if (previousState == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousState;
    if (previousProviders == null) delete process.env.DELEGATE_ENABLED_PROVIDERS;
    else process.env.DELEGATE_ENABLED_PROVIDERS = previousProviders;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('delegate_respond waits for applied and rejected terminal command outcomes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-mcp-respond-'));
  const previousState = process.env.DELEGATE_STATE_FILE;
  const previousProviders = process.env.DELEGATE_ENABLED_PROVIDERS;
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'cursor';
  try {
    const {
      claimCommands,
      completeCommand,
      createManagedJob,
      updateManagedJob
    } = await import('../bin/lib/control.mjs');
    const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'consult', cwd: directory, prompt: 'answer without changing files' });
    const requestId = 'cursor-question-1';
    const waiting = updateManagedJob(job.id, (current) => {
      current.status = 'running';
      current.phase = 'user-input-required';
      current.stopReason = 'USER_INPUT_REQUIRED';
      current.pid = process.pid;
      current.pendingInput = {
        requestId,
        kind: 'question',
        method: 'cursor/ask_question',
        origin: 'cursor-acp',
        payload: { question: 'Which directory?' },
        expiresAt: Date.now() + 5_000
      };
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
    const settle = waitForCondition({
      description: 'delegate_respond command intake to become claimable',
      timeoutMs: 2_000,
      observe: () => claimCommands(job.id, { includeTypes: ['respond'] })[0] || null
    }).then((claimed) => {
      updateManagedJob(job.id, (current) => {
        current.pendingInput = null;
        current.phase = 'prompting';
        current.stopReason = null;
      });
      completeCommand(job.id, claimed, {
        ok: true,
        appliedAs: 'input-response',
        requestId
      });
    });
    await waitForCondition({
      description: 'the delegate_respond MCP result',
      timeoutMs: 2_000,
      observe: () => ({ count: responses.length }),
      predicate: (state) => state.count >= 1,
      summarize: (state) => `responses=${state.count}`
    });
    await settle;
    const rejectedJob = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'consult', cwd: directory, prompt: 'reject stale input' });
    const rejectedRequestId = 'cursor-question-rejected';
    const rejectedWaiting = updateManagedJob(rejectedJob.id, (current) => {
      current.status = 'running';
      current.phase = 'user-input-required';
      current.stopReason = 'USER_INPUT_REQUIRED';
      current.pid = process.pid;
      current.pendingInput = {
        requestId: rejectedRequestId,
        kind: 'question',
        method: 'cursor/ask_question',
        origin: 'cursor-acp',
        payload: { question: 'This request will become stale.' },
        expiresAt: Date.now() + 5_000
      };
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_respond', arguments: {
      jobId: rejectedJob.id,
      expectedRevision: rejectedWaiting.revision,
      requestId: rejectedRequestId,
      answer: 'stale answer',
      commandId: 'mcp-response-rejected'
    } } })}\n`);
    const reject = waitForCondition({
      description: 'the second delegate_respond command intake to become claimable',
      timeoutMs: 2_000,
      observe: () => claimCommands(rejectedJob.id, { includeTypes: ['respond'] })[0] || null
    }).then((claimed) => {
      completeCommand(rejectedJob.id, claimed, {
        ok: false,
        error: 'worker no longer accepts input',
        requestId: rejectedRequestId
      });
    });
    await waitForCondition({
      description: 'the rejected delegate_respond MCP result',
      timeoutMs: 2_000,
      observe: () => ({ count: responses.length }),
      predicate: (state) => state.count >= 2,
      summarize: (state) => `responses=${state.count}`
    });
    await reject;
    child.stdin.end();
    await waitForChildExit({ child, description: 'the delegate_respond MCP process to exit' });
    const result = JSON.parse(responses[0].result.content[0].text);
    assert.deepEqual(result, {
      command: {
        id: 'mcp-response-1',
        claimed: true,
        state: 'applied',
        duplicate: false
      },
      request: {
        id: requestId,
        kind: 'question',
        answered: true,
        outcome: 'answered',
        appliedAs: 'input-response'
      },
      revision: waiting.revision + 2,
      phase: 'prompting'
    });
    const rejected = responses[1].result;
    assert.equal(rejected.isError, true);
    assert.deepEqual(JSON.parse(rejected.content[0].text), {
      error: 'INVALID_REQUEST: response command mcp-response-rejected was rejected: worker no longer accepts input',
      code: 'INVALID_REQUEST',
      retryable: false,
      provider: 'cursor',
      command: {
        id: 'mcp-response-rejected',
        claimed: true,
        state: 'rejected'
      },
      request: {
        id: rejectedRequestId,
        kind: 'question',
        answered: false
      }
    });
  } finally {
    if (previousState == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previousState;
    if (previousProviders == null) delete process.env.DELEGATE_ENABLED_PROVIDERS;
    else process.env.DELEGATE_ENABLED_PROVIDERS = previousProviders;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
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
  assert.match(result.stdout, /verify <job-id>/);
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
