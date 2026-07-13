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

test('bootstrap links every delegate command to the shim and is idempotent', () => {
  const userBin = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-shim-test-'));
  const env = { ...process.env, DELEGATE_USER_BIN: userBin };
  for (let round = 0; round < 2; round += 1) {
    const result = spawnSync(process.execPath, [bootstrap], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
  }
  for (const name of ['delegate-config', 'delegate-route', 'delegate-health', 'delegate-cursor', 'delegate-jobs', 'delegate-tui', 'delegate-usage', 'delegate-claude-usage']) {
    assert.equal(fs.readlinkSync(path.join(userBin, name)), shim);
  }
});

test('shim executes the resolved binary under the invoked command name', () => {
  const userBin = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-shim-test-'));
  spawnSync(process.execPath, [bootstrap], { env: { ...process.env, DELEGATE_USER_BIN: userBin }, encoding: 'utf8' });
  const result = spawnSync(path.join(userBin, 'delegate-health'), ['--quick'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Delegate Router/);
});

test('shim refuses direct invocation', () => {
  const result = spawnSync(shim, [], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not invoked directly/);
});
