import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { probeLegacyCodexMcp } from '../bin/lib/codex-cli.mjs';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakeModern = path.join(plugin, 'test/fake-codex-app-server.mjs');

test('legacy MCP probing executes only bounded top-level help with closed stdin', () => {
  const result = probeLegacyCodexMcp('chosen-codex', { run(binary, args, options) {
    assert.equal(binary, 'chosen-codex');
    assert.deepEqual(args, ['--help']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.timeout, 3000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 128 * 1024);
    return { status: 0, stdout: 'Usage: codex\n\nCommands:\n  mcp-server  Run MCP\n  app-server  Run app server\n\nOptions:\n  --help  Help\n' };
  } });
  assert.deepEqual(result, { available: true, reason: 'command-advertised' });
});

for (const [label, stdout] of [
  ['modern command catalog', 'Commands:\n  app-server  Run app server\n  mcp  Manage external MCP servers\n\nOptions:\n  --help  Help'],
  ['legacy mention outside the command catalog', 'Commands:\n  app-server  Run app server\n\nExamples:\n  mcp-server was removed'],
  ['different command suffix', 'Commands:\n  mcp-server-other  Not the MCP server\n\nOptions:\n  --help  Help'],
  ['missing command catalog', 'mcp-server'],
  ['empty output', '']
]) {
  test(`legacy MCP is unavailable for ${label}`, () => {
    const result = probeLegacyCodexMcp('chosen-codex', { run: () => ({ status: 0, stdout }) });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'command-not-advertised');
    assert.match(result.note, /delegate_control managed app-server/);
  });
}

for (const [label, result] of [
  ['nonzero exit', { status: 1, stdout: 'Commands:\n  mcp-server  Run MCP', stderr: 'synthetic-secret' }],
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }],
  ['output overflow', { status: null, error: { code: 'ENOBUFS' } }]
]) {
  test(`legacy MCP help ${label} fails closed without leaking diagnostics`, () => {
    const probe = probeLegacyCodexMcp('chosen-codex', { run: () => result });
    assert.equal(probe.available, false);
    assert.equal(probe.reason, 'help-probe-failed');
    assert.doesNotMatch(JSON.stringify(probe), /synthetic-secret/);
  });
}

test('legacy MCP help exceptions fail closed', () => {
  const result = probeLegacyCodexMcp('chosen-codex', { run() { throw new Error('synthetic-secret'); } });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'help-probe-failed');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});

test('removed native MCP stays healthy and empty without launching a provider session', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-codex-removed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawnCount = path.join(directory, 'provider-spawns');
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'codex', arguments: { prompt: 'must never become a model turn' } } },
    { id: 4, method: 'resources/templates/list' },
    { id: 5, method: 'ping' }
  ];
  const run = spawnSync(process.execPath, [path.join(plugin, 'bin/delegate-codex-mcp')], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'codex', DELEGATE_CODEX_BIN: fakeModern,
      DELEGATE_STATE_FILE: path.join(directory, 'usage.json'), FAKE_CODEX_SPAWN_COUNT_FILE: spawnCount },
    input: requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n').join('')
  });
  assert.equal(run.status, 0, run.stderr);
  const responses = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, requests.length);
  assert.equal(responses[0].result.serverInfo.name, 'delegate-codex-unavailable');
  assert.match(responses[0].result.instructions, /managed app-server/);
  assert.deepEqual(responses[1].result.tools, []);
  assert.equal(responses[2].error.code, -32601);
  assert.match(responses[2].error.message, /no model turn was started/);
  assert.deepEqual(responses[3].result.resourceTemplates, []);
  assert.deepEqual(responses[4].result, {});
  assert.equal(fs.existsSync(spawnCount), false);
  assert.equal(fs.existsSync(path.join(directory, 'jobs')), false);
});

test('provider-disabled native MCP does not even probe the executable', () => {
  const run = spawnSync(process.execPath, [path.join(plugin, 'bin/delegate-codex-mcp')], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'cursor', DELEGATE_CODEX_BIN: '/does/not/exist/codex' },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n'
  });
  assert.equal(run.status, 0, run.stderr);
  const response = JSON.parse(run.stdout);
  assert.equal(response.result.serverInfo.name, 'delegate-codex-disabled');
  assert.equal(response.result.instructions, undefined);
  assert.equal(run.stderr, '');
});

test('quick health reports the unavailable optional fallback without invoking a model', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-codex-health-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawnCount = path.join(directory, 'provider-spawns');
  const run = spawnSync(process.execPath, [path.join(plugin, 'bin/delegate-health'), '--quick', '--json'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'codex', DELEGATE_CODEX_BIN: fakeModern,
      DELEGATE_STATE_FILE: path.join(directory, 'usage.json'), FAKE_CODEX_SPAWN_COUNT_FILE: spawnCount }
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.codex.enabled, true);
  assert.equal(report.control.installed, true);
  assert.equal(report.codex.legacyMcp.available, false);
  assert.equal(report.codex.legacyMcp.reason, 'command-not-advertised');
  assert.equal(fs.existsSync(spawnCount), false);
});
