import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
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
    'delegate_start', 'delegate_inspect', 'delegate_list', 'delegate_events', 'delegate_transcript', 'delegate_diff',
    'delegate_files', 'delegate_steer', 'delegate_cancel', 'delegate_release', 'delegate_respond', 'delegate_resume', 'delegate_review_round', 'delegate_usage'
  ]);
  const start = responses[1].result.tools.find((tool) => tool.name === 'delegate_start');
  const inspect = responses[1].result.tools.find((tool) => tool.name === 'delegate_inspect');
  const respond = responses[1].result.tools.find((tool) => tool.name === 'delegate_respond');
  const resume = responses[1].result.tools.find((tool) => tool.name === 'delegate_resume');
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
  assert.deepEqual(start.inputSchema.properties.waitFor.enum, ['session', 'turn', 'first-output']);
  assert.ok(start.inputSchema.properties.waitForSession);
  assert.ok(start.inputSchema.properties.dryRun);
  assert.ok(inspect.inputSchema.properties.resultWindow);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_release'));
  assert.deepEqual(respond.inputSchema.required, ['jobId', 'expectedRevision']);
  for (const option of ['requestId', 'answer', 'accept', 'response', 'commandId']) assert.ok(respond.inputSchema.properties[option], `delegate_respond.${option}`);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_review_round'));
  assert.ok(resume.inputSchema.properties.maxOutputTokens);
  assert.ok(resume.inputSchema.properties.retryPolicy);
  assert.ok(resume.inputSchema.properties.verify);
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
  for (const flag of ['--profile', '--group', '--start-paused', '--ingest-files', '--auto-nudge', '--report-schema']) {
    assert.match(result.stdout, new RegExp(flag), flag);
  }
  assert.match(result.stdout, /release <job-id>/);
  assert.match(result.stdout, /stats \[--since/);
  assert.match(result.stdout, /audit backfill/);
  assert.match(result.stdout, /--wait-for session\|turn\|first-output/);
  assert.match(result.stdout, /--wait-for-session/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /review-round <job-id> --prompt/);
  assert.match(result.stdout, /result <job-id> \[--find text\] \[--offset N\] \[--max-chars N\]/);
});
