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

test('statusline enable wraps an existing command, captures usage, and disable restores it', () => isolated((directory) => {
  const configBin = path.join(plugin, 'bin', 'delegate-config');
  const settingsFile = path.join(directory, 'settings.json');
  const userBin = path.join(directory, 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.symlinkSync(path.join(plugin, 'bin', 'delegate-claude-usage'), path.join(userBin, 'delegate-claude-usage'));
  fs.writeFileSync(settingsFile, `${JSON.stringify({ statusLine: { type: 'command', command: `printf 'original-line'` }, otherSetting: true })}\n`);
  const env = { ...process.env, DELEGATE_CLAUDE_SETTINGS: settingsFile, DELEGATE_USER_BIN: userBin };

  const enabled = spawnSync(process.execPath, [configBin, 'statusline', 'enable'], { encoding: 'utf8', env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const report = JSON.parse(enabled.stdout);
  assert.equal(report.status, 'enabled');
  assert.equal(report.wrappedExisting, true);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.statusLine.command, report.wrapper);
  assert.equal(settings.otherSetting, true);

  const payload = JSON.stringify({
    model: { display_name: 'Fable' },
    rate_limits: {
      five_hour: { used_percentage: 42.4, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 9.1, resets_at: Math.floor(Date.now() / 1000) + 86400 }
    }
  });
  const rendered = spawnSync('bash', [report.wrapper], { input: payload, encoding: 'utf8', env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, 'original-line');
  const claude = JSON.parse(fs.readFileSync(process.env.DELEGATE_STATE_FILE, 'utf8')).providers.claude;
  assert.equal(claude.windows.five_hour.usedPercent, 42.4);
  assert.equal(claude.windows.seven_day.usedPercent, 9.1);

  const again = spawnSync(process.execPath, [configBin, 'statusline', 'enable'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(again.stdout).status, 'already-enabled');

  const disabled = spawnSync(process.execPath, [configBin, 'statusline', 'disable'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(disabled.stdout).status, 'disabled');
  const restored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(restored.statusLine.command, `printf 'original-line'`);
  assert.ok(!fs.existsSync(report.wrapper));
}));

test('statusline enable without an existing status line installs the minimal renderer', () => isolated((directory) => {
  const configBin = path.join(plugin, 'bin', 'delegate-config');
  const settingsFile = path.join(directory, 'settings.json');
  const userBin = path.join(directory, 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.symlinkSync(path.join(plugin, 'bin', 'delegate-claude-usage'), path.join(userBin, 'delegate-claude-usage'));
  const env = { ...process.env, DELEGATE_CLAUDE_SETTINGS: settingsFile, DELEGATE_USER_BIN: userBin };

  const enabled = spawnSync(process.execPath, [configBin, 'statusline', 'enable'], { encoding: 'utf8', env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const report = JSON.parse(enabled.stdout);
  assert.equal(report.wrappedExisting, false);
  const payload = JSON.stringify({ model: { display_name: 'Fable' }, rate_limits: { five_hour: { used_percentage: 12 } } });
  const rendered = spawnSync('bash', [report.wrapper], { input: payload, encoding: 'utf8', env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Fable \| 5h 12%/);
  const disabled = spawnSync(process.execPath, [configBin, 'statusline', 'disable'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(disabled.stdout).status, 'disabled');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), 'statusLine'), false);
}));
