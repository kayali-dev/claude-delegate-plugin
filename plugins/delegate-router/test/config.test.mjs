import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { enabledProviders, providerEnabled, saveEnabledProviders } from '../bin/lib/state.mjs';
import { waitForChildExit, waitForCondition } from './helpers/wait.mjs';

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

test('delegate-health surfaces the never-pruned audit log path', () => isolated((directory) => {
  const result = spawnSync(process.execPath, [path.join(plugin, 'bin', 'delegate-health'), '--quick', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE, DELEGATE_ENABLED_PROVIDERS: 'codex' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).auditLogFile, path.join(directory, 'audit.jsonl'));
}));

test('delegate-health degrades loudly for three recent unparseable plan probes and names the rate', () => isolated((directory) => {
  const attempts = [9_024, 7_804, 4_031].map((outputTokens, index) => ({
    jobId: `probe-${index}`,
    role: 'independent-probe',
    state: 'degraded',
    probeStatus: 'completed',
    outputValidity: 'unparseable',
    structurallyInvalid: true,
    parserReason: 'no-valid-structural-json',
    reason: 'plan-structural-output-invalid:no-valid-structural-json',
    outputTokens,
    wastedOutputTokens: outputTokens,
    costBasis: 'observed'
  }));
  const record = {
    jobId: 'recent-plan-health',
    at: Date.now(),
    provider: 'codex',
    mode: 'implement',
    taskShape: { planFirst: true },
    planFirstOutcome: {
      requested: true,
      state: 'degraded',
      degraded: true,
      completionReached: false,
      attempts
    }
  };
  fs.writeFileSync(path.join(directory, 'audit.jsonl'), `${JSON.stringify(record)}\n`);
  const env = { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE, DELEGATE_ENABLED_PROVIDERS: 'codex' };
  const jsonResult = spawnSync(process.execPath, [path.join(plugin, 'bin', 'delegate-health'), '--quick', '--json'], {
    encoding: 'utf8', env
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const report = JSON.parse(jsonResult.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.planFirstProbeHealth, {
    window: '7d',
    status: 'degraded',
    minimumRepeatedFailures: 3,
    sampleSize: 3,
    comparableProbes: 0,
    unparseableProbes: 3,
    validityRate: 0,
    structurallyInvalidReasons: { 'no-valid-structural-json': 3 },
    wastedOutputTokens: 20_859,
    wastedOutputTokensObserved: 20_859,
    wastedOutputTokensReserved: 0
  });
  const textResult = spawnSync(process.execPath, [path.join(plugin, 'bin', 'delegate-health'), '--quick'], {
    encoding: 'utf8', env
  });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(textResult.stdout, /Delegate Router .*: degraded/);
  assert.match(textResult.stdout, /Plan probe output health \(7d\): DEGRADED — 0\/3 comparable \(0\.0% validity\), 3 unparseable, 20859 wasted output tokens \(20859 observed, 0 reserved\)/);
}));

test('Cursor-only control MCP advertises only Cursor and Codex MCP exposes no tools', async () => {
  const env = { ...process.env, DELEGATE_ENABLED_PROVIDERS: 'cursor' };
  const child = spawn(process.execPath, [path.join(plugin, 'bin', 'delegate-control-mcp')], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
  await waitForCondition({
    description: 'the Cursor-only control MCP tools/list response',
    timeoutMs: 500,
    intervalMs: 10,
    observe: () => ({ count: responses.length }),
    predicate: (state) => state.count >= 1,
    summarize: (state) => `responses=${state.count}`
  });
  child.stdin.end();
  await waitForChildExit({ child, description: 'the Cursor-only control MCP process to exit' });
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
  fs.symlinkSync(path.join(plugin, 'bin', 'delegate-work-state'), path.join(userBin, 'delegate-work-state'));
  fs.writeFileSync(settingsFile, `${JSON.stringify({ statusLine: { type: 'command', command: `printf 'original-line'` }, otherSetting: true })}\n`);
  const env = { ...process.env, DELEGATE_CLAUDE_SETTINGS: settingsFile, DELEGATE_USER_BIN: userBin };

  const enabled = spawnSync(process.execPath, [configBin, 'statusline', 'enable'], { encoding: 'utf8', env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const report = JSON.parse(enabled.stdout);
  assert.equal(report.status, 'enabled');
  assert.equal(report.wrappedExisting, true);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.statusLine.command, report.wrapper);
  assert.equal(settings.statusLine.refreshInterval, 5);
  assert.equal(settings.otherSetting, true);
  assert.equal(settings.footerLinksRegexes.length, 1);
  assert.match(settings.footerLinksRegexes[0].pattern, /codex/);
  assert.match(settings.footerLinksRegexes[0].url, /^vscode:\/\/file/);
  const jobBadgePattern = new RegExp(settings.footerLinksRegexes[0].pattern);
  assert.equal(jobBadgePattern.exec('codex-mabc123-abcdef')?.groups?.job, 'codex-mabc123-abcdef');
  assert.equal(jobBadgePattern.exec('cursor-mabc123-xyz789')?.groups?.job, 'cursor-mabc123-xyz789');

  const payload = JSON.stringify({
    model: { display_name: 'Fable' },
    rate_limits: {
      five_hour: { used_percentage: 42.4, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 9.1, resets_at: Math.floor(Date.now() / 1000) + 86400 }
    }
  });
  const rendered = spawnSync('bash', [report.wrapper], { input: payload, encoding: 'utf8', env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, 'D idle · codex ? · original-line');
  const chipOptOut = spawnSync('bash', [report.wrapper], {
    input: payload,
    encoding: 'utf8',
    env: { ...env, DELEGATE_NATIVE_STATUSLINE: '0' }
  });
  assert.equal(chipOptOut.status, 0, chipOptOut.stderr);
  assert.equal(chipOptOut.stdout, 'original-line');
  const claude = JSON.parse(fs.readFileSync(process.env.DELEGATE_STATE_FILE, 'utf8')).providers.claude;
  assert.equal(claude.windows.five_hour.usedPercent, 42.4);
  assert.equal(claude.windows.seven_day.usedPercent, 9.1);

  const again = spawnSync(process.execPath, [configBin, 'statusline', 'enable'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(again.stdout).status, 'already-enabled');

  const disabled = spawnSync(process.execPath, [configBin, 'statusline', 'disable'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(disabled.stdout).status, 'disabled');
  const restored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(restored.statusLine.command, `printf 'original-line'`);
  assert.equal(Object.hasOwn(restored, 'footerLinksRegexes'), false);
  assert.ok(!fs.existsSync(report.wrapper));
}));

test('statusline enable without an existing status line installs the minimal renderer', () => isolated((directory) => {
  const configBin = path.join(plugin, 'bin', 'delegate-config');
  const settingsFile = path.join(directory, 'settings.json');
  const userBin = path.join(directory, 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.symlinkSync(path.join(plugin, 'bin', 'delegate-claude-usage'), path.join(userBin, 'delegate-claude-usage'));
  fs.symlinkSync(path.join(plugin, 'bin', 'delegate-work-state'), path.join(userBin, 'delegate-work-state'));
  const env = { ...process.env, DELEGATE_CLAUDE_SETTINGS: settingsFile, DELEGATE_USER_BIN: userBin };

  const enabled = spawnSync(process.execPath, [configBin, 'statusline', 'enable'], { encoding: 'utf8', env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const report = JSON.parse(enabled.stdout);
  assert.equal(report.wrappedExisting, false);
  const payload = JSON.stringify({ model: { display_name: 'Fable' }, rate_limits: { five_hour: { used_percentage: 12 } } });
  const rendered = spawnSync('bash', [report.wrapper], { input: payload, encoding: 'utf8', env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, 'D idle · codex ? · Fable | 5h 12%\n');
  const disabled = spawnSync(process.execPath, [configBin, 'statusline', 'disable'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(disabled.stdout).status, 'disabled');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), 'statusLine'), false);
}));

test('footer link opt-out removes only the Delegate Router entry and preserves user badges', () => isolated((directory) => {
  const configBin = path.join(plugin, 'bin', 'delegate-config');
  const settingsFile = path.join(directory, 'settings.json');
  const userBadge = {
    type: 'regex',
    pattern: '\\b(?<issue>APP-\\d+)\\b',
    url: 'https://issues.example.test/{issue}',
    label: '{issue}'
  };
  fs.writeFileSync(settingsFile, `${JSON.stringify({ footerLinksRegexes: [userBadge] })}\n`);
  const env = { ...process.env, DELEGATE_CLAUDE_SETTINGS: settingsFile };
  const enabled = spawnSync(process.execPath, [configBin, 'footer-links', 'enable'], { encoding: 'utf8', env });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).footerLinksRegexes.length, 2);
  const disabled = spawnSync(process.execPath, [configBin, 'footer-links', 'disable'], { encoding: 'utf8', env });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).footerLinksRegexes, [userBadge]);
}));
