import assert from 'node:assert/strict';
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
    'delegate_files', 'delegate_steer', 'delegate_cancel', 'delegate_release', 'delegate_resume', 'delegate_review_round', 'delegate_usage'
  ]);
  const start = responses[1].result.tools.find((tool) => tool.name === 'delegate_start');
  const inspect = responses[1].result.tools.find((tool) => tool.name === 'delegate_inspect');
  const resume = responses[1].result.tools.find((tool) => tool.name === 'delegate_resume');
  assert.ok(start.inputSchema.properties.idempotencyKey);
  assert.ok(start.inputSchema.properties.maxOutputTokens);
  assert.ok(start.inputSchema.properties.retryPolicy);
  assert.ok(start.inputSchema.properties.verify);
  for (const option of ['profile', 'groupId', 'startPaused', 'ingestFiles', 'autoNudge', 'reportSchema']) {
    assert.ok(start.inputSchema.properties[option], option);
  }
  assert.deepEqual(start.inputSchema.properties.waitFor.enum, ['session', 'turn', 'first-output']);
  assert.ok(start.inputSchema.properties.waitForSession);
  assert.ok(start.inputSchema.properties.dryRun);
  assert.ok(inspect.inputSchema.properties.resultWindow);
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_release'));
  assert.ok(responses[1].result.tools.find((tool) => tool.name === 'delegate_review_round'));
  assert.ok(resume.inputSchema.properties.maxOutputTokens);
  assert.ok(resume.inputSchema.properties.retryPolicy);
  assert.ok(resume.inputSchema.properties.verify);
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
