import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bootstrap = path.join(root, 'bin', 'delegate-bootstrap');
const shim = path.join(root, 'bin', 'delegate-shim');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function temporaryRoot(t, label = 'delegate-shim-test-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeRegistry(home, installPath, version = packageVersion) {
  const directory = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installed_plugins.json'), JSON.stringify({
    plugins: { 'delegate-router@delegate-skill': [{ scope: 'user', installPath, version }] }
  }));
}

function installedFixture(t, version = packageVersion) {
  const directory = temporaryRoot(t, 'delegate-bootstrap-installed-');
  const home = path.join(directory, 'home');
  const userBin = path.join(directory, 'bin');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'delegate-skill', 'delegate-router', version);
  const currentShim = path.join(installPath, 'bin', 'delegate-shim');
  fs.mkdirSync(path.dirname(currentShim), { recursive: true });
  fs.mkdirSync(userBin, { recursive: true });
  fs.writeFileSync(currentShim, '# current shim\n');
  fs.writeFileSync(path.join(installPath, 'package.json'), JSON.stringify({ version }));
  writeRegistry(home, installPath, version);
  return { directory, home, userBin, installPath, currentShim, env: { ...process.env, HOME: home, DELEGATE_USER_BIN: userBin } };
}

function invokeShim(t, home, name = 'delegate-tui', args = ['--help']) {
  const directory = temporaryRoot(t, 'delegate-shim-invoke-');
  const command = path.join(directory, name);
  fs.symlinkSync(shim, command);
  return spawnSync(command, args, { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

test('bootstrap links every delegate command to the shim and is idempotent', (t) => {
  const directory = temporaryRoot(t);
  const home = path.join(directory, 'home');
  const userBin = path.join(directory, 'bin');
  const env = { ...process.env, HOME: home, DELEGATE_USER_BIN: userBin };
  for (let round = 0; round < 2; round += 1) {
    const result = spawnSync(process.execPath, [bootstrap], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
  }
  for (const name of ['delegate-config', 'delegate-route', 'delegate-health', 'delegate-cursor', 'delegate-jobs', 'delegate-tui', 'delegate-usage', 'delegate-claude-usage']) {
    assert.equal(fs.readlinkSync(path.join(userBin, name)), shim);
  }
});

test('shim executes the resolved binary under the invoked command name', (t) => {
  const directory = temporaryRoot(t);
  const home = path.join(directory, 'home');
  const userBin = path.join(directory, 'bin');
  const env = { ...process.env, HOME: home, DELEGATE_USER_BIN: userBin };
  spawnSync(process.execPath, [bootstrap], { env, encoding: 'utf8' });
  const result = spawnSync(path.join(userBin, 'delegate-health'), ['--quick'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Delegate Router/);
  assert.match(result.stderr, /installed registry lookup failed; falling back to sibling/);
});

test('shim refuses direct invocation', () => {
  const result = spawnSync(shim, [], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not invoked directly/);
});

test('shim warns once when the installed version lacks the invoked binary', (t) => {
  const directory = temporaryRoot(t, 'delegate-shim-missing-installed-');
  const home = path.join(directory, 'home');
  const installPath = path.join(directory, 'installed');
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, 'package.json'), JSON.stringify({ version: '0.23.0' }));
  writeRegistry(home, installPath, '0.23.0');
  const result = invokeShim(t, home);
  assert.equal(result.status, 0);
  assert.match(result.stderr.trim(), new RegExp(`delegate-shim: installed 0\\.23\\.0 lacks delegate-tui; falling back to sibling ${escapeRegExp(packageVersion)}$`));
  assert.equal(result.stderr.match(/delegate-shim:/g)?.length, 1);
});

test('shim warns once when the installed registry lookup fails', (t) => {
  const directory = temporaryRoot(t, 'delegate-shim-missing-registry-');
  const home = path.join(directory, 'home');
  fs.mkdirSync(home, { recursive: true });
  const result = invokeShim(t, home);
  assert.equal(result.status, 0);
  assert.match(result.stderr.trim(), new RegExp(`delegate-shim: installed registry lookup failed; falling back to sibling ${escapeRegExp(packageVersion)}$`));
  assert.equal(result.stderr.match(/delegate-shim:/g)?.length, 1);
});

test('bootstrap retargets a stale Delegate Router cache shim to the current install', (t) => {
  const fixture = installedFixture(t);
  const staleShim = path.join(fixture.home, '.claude', 'plugins', 'cache', 'delegate-skill', 'delegate-router', '0.22.0', 'bin', 'delegate-shim');
  fs.mkdirSync(path.dirname(staleShim), { recursive: true });
  fs.writeFileSync(staleShim, '# stale shim\n');
  const link = path.join(fixture.userBin, 'delegate-health');
  fs.symlinkSync(staleShim, link);
  const result = spawnSync(process.execPath, [bootstrap], { env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(fs.readlinkSync(link), fixture.currentShim);
});

test('bootstrap recreates a dangling Delegate Router cache shim link', (t) => {
  const fixture = installedFixture(t);
  const removedShim = path.join(fixture.home, '.claude', 'plugins', 'cache', 'delegate-skill', 'delegate-router', '0.21.0', 'bin', 'delegate-shim');
  const link = path.join(fixture.userBin, 'delegate-tui');
  fs.symlinkSync(removedShim, link);
  const result = spawnSync(process.execPath, [bootstrap], { env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(fs.readlinkSync(link), fixture.currentShim);
  assert.equal(fs.existsSync(link), true);
});

test('bootstrap leaves a user-custom delegate command file untouched', (t) => {
  const fixture = installedFixture(t);
  const custom = path.join(fixture.userBin, 'delegate-jobs');
  fs.writeFileSync(custom, '#!/bin/sh\necho custom\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [bootstrap], { env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(custom, 'utf8'), '#!/bin/sh\necho custom\n');
  assert.equal(fs.lstatSync(custom).isSymbolicLink(), false);
});
