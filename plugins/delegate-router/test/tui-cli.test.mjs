import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tui = path.join(plugin, 'bin', 'delegate-tui');

test('delegate-tui help prints usage without entering the alternate screen', () => {
  const result = spawnSync(process.execPath, [tui, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: delegate-tui/m);
  assert.doesNotMatch(result.stdout + result.stderr, /\u001b\[\?1049h/);
});

test('delegate-tui exits 2 with a clear message when stdout is not a TTY', () => {
  const result = spawnSync(process.execPath, [tui], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /stdout is not a TTY/);
  assert.doesNotMatch(result.stdout + result.stderr, /\u001b\[\?1049h/);
});

