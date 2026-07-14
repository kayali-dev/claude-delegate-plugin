import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TuiFlightRecorder } from '../bin/lib/tui/diagnostics.mjs';
import { CellGrid, Screen } from '../bin/lib/tui/screen.mjs';

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

test('delegate-tui --analyze replays a diagnostic directory without a TTY', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-analyze-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recorder = new TuiFlightRecorder(directory);
  const output = { columns: 20, rows: 2, write() { return true; } };
  const screen = new Screen({ output, input: {}, columns: 20, rows: 2, diagnostics: recorder });
  const grid = new CellGrid(20, 2);
  grid.write(0, 0, 'assistant function');
  screen.render(grid);
  screen.markDiagnostic();
  recorder.close();
  const result = spawnSync(process.execPath, [tui, '--analyze', directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /frame 1: agreement/);
  assert.match(result.stdout, /TERMINAL-SIDE INTERPRETATION verdict/);
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

test('every TUI launch and continuation path suppresses direct packet-lint console output', () => {
  const source = fs.readFileSync(tui, 'utf8');
  assert.match(source, /function launchOptions\(\)[\s\S]*?reportLint: false,[\s\S]*?\n\s*};/);
  assert.match(source, /reviewRoundManagedJob\([^\n]+reportLint: false/);
  const resumes = [...source.matchAll(/resumeManagedJob\([^\n]+/g)].map((match) => match[0]);
  assert.ok(resumes.length >= 2);
  assert.ok(resumes.every((line) => line.includes('reportLint: false')), `unsuppressed resume call: ${resumes.find((line) => !line.includes('reportLint: false')) || 'none'}`);
});

test('dashboard is the default landing screen and F/Esc preserve progressive navigation', () => {
  const source = fs.readFileSync(tui, 'utf8');
  assert.match(source, /screen:\s*initialJobId\s*\?\s*'detail'\s*:\s*'dashboard'/);
  assert.match(source, /if \(key === 'F'\)[\s\S]*?ui\.screen = 'fleet'/);
  assert.match(source, /else if \(ui\.screen === 'fleet'\) \{\s*ui\.screen = 'dashboard'/);
  assert.match(source, /detailReturn:\s*initialJobId\s*\?\s*'dashboard'\s*:\s*'fleet'/);
  assert.match(source, /WIDTH_PROBE_GRAPHEMES\.every\(\(glyph\) => Object\.hasOwn\(cachedCandidate\.widths, glyph\)\)/);
});
