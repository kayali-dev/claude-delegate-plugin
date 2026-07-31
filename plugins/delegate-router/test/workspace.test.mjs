import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  captureManagedWorkspace,
  createManagedJob,
  decideAcceptance,
  inspectJob,
  launchManagedJob,
  prepareManagedIntegration,
  preflightManagedIntegration,
  revertManagedJob,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { allocateWorkspace, discardWorkspace, preflightWorkspaceChangeSets } from '../bin/lib/workspace.mjs';

const fakeCodex = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url));

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || `${args.join(' ')} failed`);
  return result.stdout.trim();
}

function repository(t, name = 'repo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `delegate-workspace-${name}-`));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Delegate Test']);
  fs.writeFileSync(path.join(root, 'target.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'other\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  return root;
}

function withState(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-workspace-state-'));
  const previous = {
    state: process.env.DELEGATE_STATE_FILE,
    providers: process.env.DELEGATE_ENABLED_PROVIDERS,
    supervisor: process.env.DELEGATE_SUPERVISOR
  };
  process.env.DELEGATE_STATE_FILE = path.join(state, 'usage.json');
  process.env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  process.env.DELEGATE_SUPERVISOR = '0';
  t.after(() => {
    if (previous.state == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous.state;
    if (previous.providers == null) delete process.env.DELEGATE_ENABLED_PROVIDERS;
    else process.env.DELEGATE_ENABLED_PROVIDERS = previous.providers;
    if (previous.supervisor == null) delete process.env.DELEGATE_SUPERVISOR;
    else process.env.DELEGATE_SUPERVISOR = previous.supervisor;
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  return state;
}

function workspaceJob(root, extra = {}) {
  return createManagedJob({
    provider: 'codex',
    mode: 'implement',
    cwd: root,
    prompt: 'Objective:\nEdit target.\n\nAllowed scope:\ntarget.txt\n\nAcceptance criteria:\nChanged.\n\nReturn:\nEvidence.',
    allowedPaths: ['target.txt'],
    pathClaims: ['target.txt'],
    isolation: 'worktree',
    planFirst: false,
    ...extra
  });
}

function terminalize(id) {
  return updateManagedJob(id, (job) => {
    job.status = 'completed';
    job.phase = 'completed';
    job.completedAt = Math.floor(Date.now() / 1000);
    job.acceptance = {
      state: 'ready-for-review',
      blockedBy: [],
      evidence: {},
      decidedBy: 'test',
      decidedAt: new Date().toISOString()
    };
  });
}

test('broker workspace contains dirty-owner writes and discard cannot touch the owner tree', (t) => {
  withState(t);
  const root = repository(t, 'containment');
  fs.writeFileSync(path.join(root, 'other.txt'), 'owner dirty bytes\n');
  const ownerBefore = {
    target: fs.readFileSync(path.join(root, 'target.txt')),
    other: fs.readFileSync(path.join(root, 'other.txt')),
    status: git(root, ['status', '--porcelain=v1'])
  };
  const job = workspaceJob(root);
  assert.equal(job.isolation, 'worktree');
  assert.equal(job.containment, 'broker-workspace');
  assert.notEqual(job.cwd, root);
  assert.equal(job.workspace.baseRevision, git(root, ['rev-parse', 'HEAD']));
  assert.deepEqual(job.workspace.ownerDirtyPaths, ['other.txt']);

  fs.writeFileSync(path.join(job.cwd, 'target.txt'), 'isolated result\n');
  const captured = captureManagedWorkspace(job.id, { discard: true });
  assert.equal(captured.changeSet.files[0].path, 'target.txt');
  assert.equal(captured.changeSet.workspaceDiscarded, true);
  assert.equal(fs.existsSync(job.cwd), false);
  assert.deepEqual(fs.readFileSync(path.join(root, 'target.txt')), ownerBefore.target);
  assert.deepEqual(fs.readFileSync(path.join(root, 'other.txt')), ownerBefore.other);
  assert.equal(git(root, ['status', '--porcelain=v1']), ownerBefore.status);

  terminalize(job.id);
  assert.throws(() => revertManagedJob(job.id), /roll back only by discarding/);
});

test('a real managed provider process writes only in its isolated workspace and terminal capture discards it', async (t) => {
  withState(t);
  const root = repository(t, 'real-attempt');
  const previous = {
    bin: process.env.DELEGATE_CODEX_BIN,
    path: process.env.FAKE_CODEX_WRITE_PATH,
    content: process.env.FAKE_CODEX_WRITE_CONTENT,
    changes: process.env.FAKE_CODEX_FILE_CHANGES
  };
  process.env.DELEGATE_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_WRITE_PATH = 'target.txt';
  process.env.FAKE_CODEX_WRITE_CONTENT = 'provider candidate\n';
  process.env.FAKE_CODEX_FILE_CHANGES = '1';
  t.after(() => {
    for (const [key, value] of [
      ['DELEGATE_CODEX_BIN', previous.bin],
      ['FAKE_CODEX_WRITE_PATH', previous.path],
      ['FAKE_CODEX_WRITE_CONTENT', previous.content],
      ['FAKE_CODEX_FILE_CHANGES', previous.changes]
    ]) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const started = launchManagedJob({
    provider: 'codex',
    mode: 'implement',
    cwd: root,
    prompt: 'Objective:\nEdit target.\n\nAllowed scope:\ntarget.txt\n\nAcceptance criteria:\nChanged.\n\nReturn:\nEvidence.',
    allowedPaths: ['target.txt'],
    pathClaims: ['target.txt'],
    isolation: 'worktree',
    planFirst: false
  });
  let finished = started;
  for (let attempt = 0; attempt < 100
    && (!['completed', 'failed', 'cancelled'].includes(finished.status) || finished.workspace?.state !== 'discarded');
    attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    finished = inspectJob(started.id);
  }
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.changedFiles.count, 1);
  assert.equal(finished.changedFiles.countIsLowerBound, false);
  assert.equal(finished.changeSet.files[0].path, 'target.txt');
  assert.equal(finished.workspace.state, 'discarded');
  assert.equal(fs.existsSync(started.cwd), false);
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base\n');
});

test('strict CAS prepares a clean integration worktree and refuses moved owner content byte-for-byte', (t) => {
  withState(t);
  const root = repository(t, 'cas');
  const job = workspaceJob(root);
  fs.writeFileSync(path.join(job.cwd, 'target.txt'), 'candidate\n');
  captureManagedWorkspace(job.id, { discard: true });
  terminalize(job.id);

  const preflight = preflightManagedIntegration([job.id]);
  assert.equal(preflight.ok, true);
  const integrated = prepareManagedIntegration([job.id]);
  assert.equal(integrated.applied, true);
  assert.equal(integrated.stage, 'integration-worktree');
  assert.equal(fs.readFileSync(path.join(integrated.integration.path, 'target.txt'), 'utf8'), 'candidate\n');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base\n');
  assert.throws(
    () => decideAcceptance(job.id, 'accepted'),
    (error) => error.code === 'WORKSPACE_APPLY_DEFERRED'
  );
  assert.equal(inspectJob(job.id).acceptance.state, 'ready-for-review');

  fs.writeFileSync(path.join(root, 'target.txt'), 'owner moved\n');
  const before = fs.readFileSync(path.join(root, 'target.txt'));
  const refused = prepareManagedIntegration([job.id]);
  assert.equal(refused.applied, false);
  assert.equal(refused.stage, 'cas-preflight');
  assert.deepEqual(refused.conflicts.map((item) => item.path), ['target.txt']);
  assert.deepEqual(fs.readFileSync(path.join(root, 'target.txt')), before);
  assert.throws(
    () => decideAcceptance(job.id, 'accepted'),
    (error) => error.code === 'CAS_CONFLICT' && error.conflictingPaths.includes('target.txt')
  );
  assert.equal(inspectJob(job.id).acceptance.state, 'ready-for-review');
});

test('path and resource claims schedule workspace writers while shared launches retain the conservative whole-tree guard', (t) => {
  withState(t);
  const root = repository(t, 'claims');
  const first = workspaceJob(root, {
    pathClaims: ['src'],
    allowedPaths: ['src/a.mjs'],
    resourceClaims: ['port:3000']
  });
  updateManagedJob(first.id, (job) => {
    job.status = 'running';
    job.workerPid = process.pid;
  });
  assert.throws(
    () => launchManagedJob({
      provider: 'codex',
      mode: 'implement',
      cwd: root,
      prompt: 'overlap',
      allowedPaths: ['src/b.mjs'],
      pathClaims: ['src/b.mjs'],
      isolation: 'worktree',
      planFirst: false
    }),
    (error) => error.code === 'CLAIM_CONFLICT' && error.activeJobId === first.id
  );
  assert.throws(
    () => launchManagedJob({
      provider: 'codex',
      mode: 'implement',
      cwd: root,
      prompt: 'shared writer'
    }),
    (error) => error.code === 'WRITER_ACTIVE' && error.activeJobId === first.id
  );
  const otherRoot = repository(t, 'resource-claims');
  assert.throws(
    () => launchManagedJob({
      provider: 'codex',
      mode: 'implement',
      cwd: otherRoot,
      prompt: 'same global resource',
      allowedPaths: ['target.txt'],
      pathClaims: ['target.txt'],
      resourceClaims: ['port:3000'],
      isolation: 'worktree',
      planFirst: false
    }),
    (error) => error.code === 'CLAIM_CONFLICT'
      && error.activeJobId === first.id
      && error.conflictingResourceClaims.includes('port:3000')
  );
  updateManagedJob(first.id, (job) => {
    job.status = 'failed';
    job.phase = 'failed';
    job.completedAt = Math.floor(Date.now() / 1000);
  });
  captureManagedWorkspace(first.id, { discard: true });
});

test('composition stops when two change sets claim the same changed path', (t) => {
  withState(t);
  const root = repository(t, 'compose-conflict');
  const first = workspaceJob(root);
  const second = workspaceJob(root);
  fs.writeFileSync(path.join(first.cwd, 'target.txt'), 'one\n');
  fs.writeFileSync(path.join(second.cwd, 'target.txt'), 'two\n');
  captureManagedWorkspace(first.id, { discard: true });
  captureManagedWorkspace(second.id, { discard: true });
  terminalize(first.id);
  terminalize(second.id);
  const result = prepareManagedIntegration([first.id, second.id]);
  assert.equal(result.applied, false);
  assert.equal(result.stage, 'cas-preflight');
  assert.match(result.conflicts[0].reason, /does not invent a resolution/);
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base\n');
});

test('manifest conflicts survive a forced broker-state-root switch before preflight', (t) => {
  withState(t);
  const root = repository(t, 'compose-state-switch');
  const first = workspaceJob(root);
  const second = workspaceJob(root);
  fs.writeFileSync(path.join(first.cwd, 'target.txt'), 'one\n');
  fs.writeFileSync(path.join(second.cwd, 'target.txt'), 'two\n');
  captureManagedWorkspace(first.id, { discard: true });
  captureManagedWorkspace(second.id, { discard: true });
  terminalize(first.id);
  terminalize(second.id);
  const jobs = [inspectJob(first.id), inspectJob(second.id)];

  const capturedStateFile = process.env.DELEGATE_STATE_FILE;
  const switchedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-workspace-switched-state-'));
  t.after(() => fs.rmSync(switchedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  let result;
  try {
    process.env.DELEGATE_STATE_FILE = path.join(switchedRoot, 'usage.json');
    result = preflightWorkspaceChangeSets(jobs);
  } finally {
    process.env.DELEGATE_STATE_FILE = capturedStateFile;
  }

  assert.equal(result.ok, false);
  assert.match(result.conflicts[0].reason, /does not invent a resolution/);
  assert.equal(result.conflicts.filter((conflict) => /does not invent a resolution/.test(conflict.reason)).length, 1);
  assert.equal(result.conflicts.filter((conflict) => /outside private broker storage/.test(conflict.reason)).length, 2);
});

test('portable change sets preserve additions, deletions, and binary bytes in integration only', (t) => {
  withState(t);
  const root = repository(t, 'portable');
  const job = workspaceJob(root, {
    allowedPaths: ['target.txt', 'asset.bin'],
    pathClaims: ['.']
  });
  fs.rmSync(path.join(job.cwd, 'target.txt'));
  const binary = Buffer.from([0, 1, 2, 255, 10, 0, 42]);
  fs.writeFileSync(path.join(job.cwd, 'asset.bin'), binary);
  const captured = captureManagedWorkspace(job.id, { discard: true });
  assert.deepEqual(new Set(captured.changeSet.files.map((file) => file.path)), new Set(['target.txt', 'asset.bin']));
  terminalize(job.id);
  const integrated = prepareManagedIntegration([job.id]);
  assert.equal(integrated.applied, true);
  assert.equal(fs.existsSync(path.join(integrated.integration.path, 'target.txt')), false);
  assert.deepEqual(fs.readFileSync(path.join(integrated.integration.path, 'asset.bin')), binary);
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(root, 'asset.bin')), false);
});

test('rejecting an isolated attempt discards only its workspace and records the decision', (t) => {
  withState(t);
  const root = repository(t, 'reject');
  const job = workspaceJob(root);
  fs.writeFileSync(path.join(job.cwd, 'target.txt'), 'rejected candidate\n');
  captureManagedWorkspace(job.id);
  terminalize(job.id);
  const result = decideAcceptance(job.id, 'rejected', { reason: 'not wanted' });
  assert.equal(result.acceptance.state, 'rejected');
  assert.equal(fs.existsSync(job.cwd), false);
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'base\n');
});

test('unsupported Git shapes and unsafe creation fail before provider launch', (t) => {
  const state = withState(t);
  const root = repository(t, 'shapes');
  const subdirectory = path.join(root, 'src');
  fs.mkdirSync(subdirectory);
  assert.throws(
    () => workspaceJob(subdirectory),
    (error) => error.code === 'UNSUPPORTED_GIT_SHAPE' && /repository root/.test(error.message)
  );

  const child = repository(t, 'submodule-child');
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child']);
  git(root, ['commit', '-qam', 'add submodule']);
  assert.throws(
    () => workspaceJob(root),
    (error) => error.code === 'UNSUPPORTED_GIT_SHAPE' && /submodules/.test(error.message)
  );

  const clean = repository(t, 'create-failure');
  const occupied = path.join(state, 'workspaces', 'fixed-id');
  fs.mkdirSync(occupied, { recursive: true });
  const ownerBefore = fs.readFileSync(path.join(clean, 'target.txt'));
  assert.throws(
    () => allocateWorkspace(clean, 'fixed-id'),
    (error) => error.code === 'WORKSPACE_CREATE_FAILED'
  );
  assert.deepEqual(fs.readFileSync(path.join(clean, 'target.txt')), ownerBefore);
});

test('detached owners and owners that are existing linked worktrees are supported', (t) => {
  withState(t);
  const root = repository(t, 'existing-worktree');
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-owner-linked-'));
  fs.rmSync(linked, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  git(root, ['worktree', 'add', '--detach', '-q', linked, 'HEAD']);
  t.after(() => {
    spawnSync('git', ['worktree', 'remove', '--force', '--', linked], { cwd: root, encoding: 'utf8' });
    fs.rmSync(linked, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  const symbolic = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: linked, encoding: 'utf8' });
  assert.equal(symbolic.status, 1);
  const workspace = allocateWorkspace(linked, 'linked-owner');
  assert.equal(workspace.detachedBase, true);
  assert.equal(workspace.ownerRoot, fs.realpathSync(linked));
  const discarded = discardWorkspace(workspace);
  assert.equal(discarded.state, 'discarded');
  assert.equal(fs.existsSync(workspace.path), false);
});
