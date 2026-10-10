import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeDirectory, compareDirectoryObservations } from '../bin/lib/file-observation.mjs';

test('bounded filesystem observation detects additions edits deletes and modes without retaining bodies', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-observe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'existing'), 'owner-body');
  fs.writeFileSync(path.join(root, 'deleted'), 'deleted-body');
  fs.writeFileSync(path.join(root, '.env'), 'credential-body');
  fs.symlinkSync('/outside-not-read', path.join(root, 'link'));
  const before = observeDirectory(root);
  assert.equal(before.files['.env'].hash, null);
  assert.ok(!JSON.stringify(before).includes('body'));
  fs.writeFileSync(path.join(root, 'existing'), 'candidate');
  fs.unlinkSync(path.join(root, 'deleted'));
  fs.writeFileSync(path.join(root, 'added'), 'new-body');
  const after = observeDirectory(root);
  assert.deepEqual(compareDirectoryObservations(before, after).map((file) => file.path), ['added', 'deleted', 'existing']);
  fs.chmodSync(path.join(root, 'existing'), 0o755);
  assert.deepEqual(compareDirectoryObservations(after, observeDirectory(root)).map((file) => file.path), ['existing']);
  assert.equal(observeDirectory(root, { maxEntries: 1 }).complete, false);
  assert.deepEqual(compareDirectoryObservations({ files: {}, complete: false }, after), []);
  assert.equal(observeDirectory(root, { exclude: [path.join(root, 'existing')] }).files.existing, undefined);
});
