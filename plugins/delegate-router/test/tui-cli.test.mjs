import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

test('delegate-tui --job validates the id before TTY startup and unknown jobs exit 1', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-job-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, DELEGATE_STATE_FILE: path.join(directory, 'usage.json') };
  const unknown = spawnSync(process.execPath, [tui, '--job', 'missing-job'], { encoding: 'utf8', env });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /job not found: missing-job/);
  assert.doesNotMatch(unknown.stdout + unknown.stderr, /\u001b\[\?1049h/);

  fs.mkdirSync(path.join(directory, 'jobs'));
  fs.writeFileSync(path.join(directory, 'jobs', 'known-job.json'), JSON.stringify({ id: 'known-job', status: 'completed', provider: 'codex' }));
  const known = spawnSync(process.execPath, [tui, '--job', 'known-job'], { encoding: 'utf8', env });
  assert.equal(known.status, 2);
  assert.match(known.stderr, /stdout is not a TTY/);
  assert.doesNotMatch(known.stderr, /job not found/);
});
