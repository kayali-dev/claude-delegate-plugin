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
    'delegate_files', 'delegate_steer', 'delegate_cancel', 'delegate_resume', 'delegate_usage'
  ]);
  const start = responses[1].result.tools.find((tool) => tool.name === 'delegate_start');
  const resume = responses[1].result.tools.find((tool) => tool.name === 'delegate_resume');
  assert.ok(start.inputSchema.properties.idempotencyKey);
  assert.ok(start.inputSchema.properties.maxOutputTokens);
  assert.ok(resume.inputSchema.properties.maxOutputTokens);
});

test('delegate-jobs help has CLI parity for Wave 1 caller options', () => {
  const cli = path.join(root, 'bin', 'delegate-jobs');
  const result = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--idempotency-key/);
  assert.match(result.stdout, /--max-output-tokens/);
  assert.match(result.stdout, /resume[^\n]+--max-output-tokens/);
});
