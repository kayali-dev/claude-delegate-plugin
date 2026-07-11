import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCursorArgs,
  resolveCursorModel,
  runCursor
} from '../bin/lib/cursor.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cursor.mjs');

test('Composer and Grok aliases select the newest eligible standard model', () => {
  assert.equal(resolveCursorModel('composer', ['composer-2.5', 'composer-3', 'composer-3-fast']), 'composer-3');
  assert.equal(resolveCursorModel('grok', ['grok-4.5-high', 'grok-5-high', 'grok-5-fast-high']), 'grok-5-high');
  assert.equal(resolveCursorModel('grok-xhigh', ['grok-4.5-xhigh', 'grok-5-xhigh']), 'grok-5-xhigh');
});

test('write mode uses sandboxed Smart Auto and never embeds the prompt in argv', () => {
  const args = buildCursorArgs({
    mode: 'implement', model: 'composer-2.5', cwd: '/tmp/project', approval: 'auto'
  });
  assert.ok(args.includes('--auto-review'));
  assert.ok(args.includes('--sandbox'));
  assert.ok(!args.includes('--force'));
  assert.ok(!args.join(' ').includes('super-secret-prompt'));
});

test('read-only mode uses plan mode without write approval flags', () => {
  const args = buildCursorArgs({ mode: 'review', model: 'grok-4.5-high', cwd: '/tmp/project' });
  assert.deepEqual(args.slice(-2), ['--mode', 'plan']);
  assert.ok(!args.includes('--auto-review'));
  assert.ok(!args.includes('--force'));
});

test('runCursor delivers the prompt over stdin and parses the result', async () => {
  const outcome = await runCursor({
    binary: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    prompt: 'stdin-only-prompt',
    timeoutMs: 5000
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.payload.received, 'stdin-only-prompt');
  assert.ok(!outcome.payload.argv.includes('stdin-only-prompt'));
});

test('runCursor terminates a timed-out process tree', async () => {
  const started = Date.now();
  const outcome = await runCursor({
    binary: process.execPath,
    args: [fixture, '--hang'],
    cwd: process.cwd(),
    prompt: 'timeout',
    timeoutMs: 100
  });
  assert.equal(outcome.status, 1);
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 5000);
});
