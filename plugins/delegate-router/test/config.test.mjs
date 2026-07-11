import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { enabledProviders, providerEnabled, saveEnabledProviders } from '../bin/lib/state.mjs';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function isolated(fn) {
  const previous = process.env.DELEGATE_STATE_FILE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-config-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { return fn(directory); }
  finally { if (previous == null) delete process.env.DELEGATE_STATE_FILE; else process.env.DELEGATE_STATE_FILE = previous; }
}

test('provider configuration persists codex-only, cursor-only, and both modes', () => isolated(() => {
  assert.deepEqual(saveEnabledProviders(['codex']), ['codex']);
  assert.deepEqual(enabledProviders(), ['codex']);
  assert.equal(providerEnabled('codex'), true);
  assert.equal(providerEnabled('cursor'), false);
  assert.deepEqual(saveEnabledProviders(['cursor']), ['cursor']);
  assert.deepEqual(saveEnabledProviders(['cursor', 'codex']), ['codex', 'cursor']);
}));

test('Cursor-only control MCP advertises only Cursor and Codex MCP exposes no tools', async () => {
  const env = { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'cursor' };
  const child = spawn(process.execPath, [path.join(plugin, 'bin', 'delegate-control-mcp')], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
  for (let i = 0; i < 50 && !responses.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  const start = responses[0].result.tools.find((tool) => tool.name === 'delegate_start');
  assert.deepEqual(start.inputSchema.properties.provider.enum, ['cursor']);

  const disabled = spawnSync(process.execPath, [path.join(plugin, 'bin', 'delegate-codex-mcp')], {
    env,
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
    encoding: 'utf8'
  });
  assert.equal(disabled.status, 0);
  assert.deepEqual(JSON.parse(disabled.stdout).result.tools, []);
});

test('installer rejects conflicting provider modes without changing configuration', () => {
  const result = spawnSync('bash', [path.join(path.dirname(plugin), '..', 'install.sh'), '--codex-only', '--cursor-only'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Choose only one provider mode/);
});
