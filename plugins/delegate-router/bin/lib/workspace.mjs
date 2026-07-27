import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { brokerError } from './errors.mjs';
import { dataDir } from './state.mjs';

const GIT_TIMEOUT_MS = 120_000;
const SHAPE_MAX_BYTES = 16 * 1024 * 1024;
const PATCH_MAX_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function canonicalDirectory(value) {
  const resolved = path.resolve(value);
  try { return (fs.realpathSync.native || fs.realpathSync)(resolved); }
  catch { return path.normalize(resolved); }
}

function isInside(parent, candidate) {
  const relative = path.relative(canonicalDirectory(parent), canonicalDirectory(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runGit(cwd, args, options = {}) {
  return spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    ...args
  ], {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? SHAPE_MAX_BYTES,
    input: options.input,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    },
    windowsHide: true
  });
}

function gitFailure(result, fallback) {
  if (result.error?.code === 'ENOBUFS') return `${fallback}: bounded Git output exceeded the supported limit`;
  if (result.error?.code === 'ETIMEDOUT') return `${fallback}: Git command timed out`;
  return String(result.stderr || result.error?.message || fallback).trim();
}

function requireGit(cwd, args, label, options = {}) {
  const result = runGit(cwd, args, options);
  if (result.status !== 0) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', gitFailure(result, label));
  }
  return result.stdout;
}

function workspaceRootFor(jobId) {
  if (!SAFE_ID.test(jobId || '')) throw brokerError('INVALID_REQUEST', `invalid workspace owner id: ${jobId}`);
  return path.join(dataDir(), 'workspaces', jobId);
}

function integrationRootFor(integrationId) {
  if (!SAFE_ID.test(integrationId || '')) throw brokerError('INVALID_REQUEST', `invalid integration id: ${integrationId}`);
  return path.join(dataDir(), 'integrations', integrationId);
}

function boundedDirtyPaths(root) {
  const result = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.status !== 0) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', gitFailure(result, 'cannot inspect the owner working tree'));
  }
  const tokens = result.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index].slice(0, 2);
    const file = tokens[index].slice(3);
    if (file) files.push(file);
    if (/[RC]/.test(status) && tokens[index + 1]) files.push(tokens[++index]);
  }
  return [...new Set(files)];
}

function assertNoSubmodules(root, revision) {
  const result = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', revision]);
  if (result.status !== 0) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', gitFailure(result, 'bounded repository-shape inspection failed'));
  }
  if (result.stdout.split('\0').some((entry) => entry.startsWith('160000 '))) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', 'workspace isolation refuses repositories containing submodules in this phase');
  }
}

export function inspectWorkspaceRepository(ownerCwd, jobId = 'preview') {
  const requested = canonicalDirectory(ownerCwd);
  const rootOutput = requireGit(requested, ['rev-parse', '--show-toplevel'], 'workspace isolation requires a Git working tree').trim();
  const ownerRoot = canonicalDirectory(rootOutput);
  if (requested !== ownerRoot) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', 'workspace isolation currently requires cwd to be the Git repository root');
  }
  const bare = requireGit(ownerRoot, ['rev-parse', '--is-bare-repository'], 'cannot determine whether the repository is bare').trim();
  if (bare !== 'false') throw brokerError('UNSUPPORTED_GIT_SHAPE', 'workspace isolation refuses bare repositories');
  const baseRevision = requireGit(ownerRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], 'workspace isolation requires an immutable HEAD commit').trim();
  const baseTree = requireGit(ownerRoot, ['rev-parse', '--verify', `${baseRevision}^{tree}`], 'cannot resolve the immutable base tree').trim();
  const filters = runGit(ownerRoot, ['config', '--local', '--get-regexp', '^filter\\.']);
  if (filters.status === 0 && filters.stdout.trim()) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', 'workspace isolation refuses repositories with custom Git clean/smudge filters in this phase');
  }
  if (![0, 1].includes(filters.status)) {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', gitFailure(filters, 'cannot inspect repository-local Git filters'));
  }
  assertNoSubmodules(ownerRoot, baseRevision);
  const storageRoot = path.join(dataDir(), 'workspaces');
  if (isInside(ownerRoot, storageRoot)) {
    throw brokerError('WORKSPACE_STORAGE_UNSAFE', 'Delegate Router state is inside the owner repository; refusing to create a contained workspace there');
  }
  const symbolic = runGit(ownerRoot, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return {
    kind: 'git-worktree',
    ownedBy: 'delegate-router',
    ownerRoot,
    ownerCwd: ownerRoot,
    path: workspaceRootFor(jobId),
    cwd: workspaceRootFor(jobId),
    baseRevision,
    baseTree,
    detachedBase: symbolic.status !== 0,
    ownerDirtyPaths: boundedDirtyPaths(ownerRoot),
    state: 'planned'
  };
}

function safeOwnedRoot(expectedRoot, candidate) {
  const expected = canonicalDirectory(expectedRoot);
  const resolved = canonicalDirectory(candidate);
  const relative = path.relative(expected, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw brokerError('WORKSPACE_PATH_UNSAFE', `refusing an unowned workspace path: ${candidate}`);
  }
  return resolved;
}

function removeOwnedWorktree(ownerRoot, workspacePath, expectedStorageRoot) {
  const target = safeOwnedRoot(expectedStorageRoot, workspacePath);
  let realTarget = target;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
      return { removed: true, gitRemoved: false, warning: 'workspace root was a symlink and only the link was removed' };
    }
    realTarget = canonicalDirectory(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, gitRemoved: false };
    throw error;
  }
  if (!isInside(expectedStorageRoot, realTarget) || realTarget === canonicalDirectory(ownerRoot)) {
    throw brokerError('WORKSPACE_PATH_UNSAFE', `refusing to discard workspace outside broker storage: ${realTarget}`);
  }
  const removed = runGit(ownerRoot, ['worktree', 'remove', '--force', '--', target]);
  let warning = null;
  if (removed.status !== 0) warning = gitFailure(removed, 'git worktree remove failed; removing only the validated broker directory');
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (error) {
    throw brokerError('WORKSPACE_DISCARD_FAILED', `cannot remove broker workspace ${target}: ${error.message}`);
  }
  runGit(ownerRoot, ['worktree', 'prune']);
  return { removed: true, gitRemoved: removed.status === 0, ...(warning ? { warning } : {}) };
}

export function allocateWorkspace(ownerCwd, jobId) {
  const planned = inspectWorkspaceRepository(ownerCwd, jobId);
  const storageRoot = path.join(dataDir(), 'workspaces');
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(storageRoot, 0o700); } catch {}
  if (fs.existsSync(planned.path)) {
    throw brokerError('WORKSPACE_CREATE_FAILED', `broker workspace path already exists: ${planned.path}`);
  }
  const created = runGit(planned.ownerRoot, [
    'worktree', 'add', '--detach', '--', planned.path, planned.baseRevision
  ]);
  if (created.status !== 0) {
    try { removeOwnedWorktree(planned.ownerRoot, planned.path, storageRoot); } catch {}
    throw brokerError('WORKSPACE_CREATE_FAILED', gitFailure(created, 'git worktree creation failed'));
  }
  try {
    const actualRoot = canonicalDirectory(requireGit(planned.path, ['rev-parse', '--show-toplevel'], 'created worktree is not a valid Git worktree').trim());
    const actualRevision = requireGit(planned.path, ['rev-parse', '--verify', 'HEAD^{commit}'], 'created worktree has no immutable HEAD').trim();
    if (actualRoot !== canonicalDirectory(planned.path) || actualRevision !== planned.baseRevision) {
      throw brokerError('WORKSPACE_CREATE_FAILED', 'created worktree does not match the requested immutable base');
    }
    const dirty = boundedDirtyPaths(planned.path);
    if (dirty.length) throw brokerError('WORKSPACE_CREATE_FAILED', `new workspace is unexpectedly dirty: ${dirty.slice(0, 5).join(', ')}`);
    return {
      ...planned,
      state: 'allocated',
      allocatedAt: new Date().toISOString()
    };
  } catch (error) {
    try { removeOwnedWorktree(planned.ownerRoot, planned.path, storageRoot); } catch {}
    throw error;
  }
}

function parseTreeEntry(output) {
  const record = String(output || '').split('\0').find(Boolean);
  if (!record) return null;
  const match = record.match(/^(\d{6})\s+\S+\s+([0-9a-f]{40,64})\t/);
  return match ? { mode: match[1], oid: match[2] } : null;
}

function parseIndexEntry(output) {
  const record = String(output || '').split('\0').find(Boolean);
  if (!record) return null;
  const match = record.match(/^(\d{6})\s+([0-9a-f]{40,64})\s+0\t/);
  return match ? { mode: match[1], oid: match[2] } : null;
}

function manifestEntry(root, baseRevision, file, status) {
  const base = parseTreeEntry(requireGit(root, ['ls-tree', '-z', baseRevision, '--', file], `cannot inspect base path ${file}`));
  const result = parseIndexEntry(requireGit(root, ['ls-files', '--stage', '-z', '--', file], `cannot inspect result path ${file}`));
  if (base?.mode === '160000' || result?.mode === '160000') {
    throw brokerError('UNSUPPORTED_GIT_SHAPE', `change set contains a submodule path: ${file}`);
  }
  return {
    path: file,
    status,
    baseOid: base?.oid || null,
    baseMode: base?.mode || null,
    resultOid: result?.oid || null,
    resultMode: result?.mode || null
  };
}

function changedPathRecords(root, baseRevision) {
  const output = requireGit(root, ['diff', '--cached', '--name-status', '-z', baseRevision, '--', '.'], 'cannot enumerate the workspace change set');
  const tokens = output.split('\0').filter(Boolean);
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (/^[RC]\d{1,3}$/.test(status)) {
      const source = tokens[index++];
      const target = tokens[index++];
      if (!source || !target) throw brokerError('CHANGESET_CREATE_FAILED', 'malformed rename/copy inventory from Git');
      records.push({ path: source, status: `${status}:source` }, { path: target, status: `${status}:target` });
    } else {
      const file = tokens[index++];
      if (!file) throw brokerError('CHANGESET_CREATE_FAILED', 'malformed changed-path inventory from Git');
      records.push({ path: file, status });
    }
  }
  return records;
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function createWorkspaceChangeSet(job, artifactDirectory) {
  const workspace = job?.workspace;
  if (job?.isolation !== 'worktree' || workspace?.ownedBy !== 'delegate-router') {
    throw brokerError('INVALID_REQUEST', 'a broker-owned workspace job is required');
  }
  if (!fs.existsSync(workspace.path)) {
    throw brokerError('CHANGESET_CREATE_FAILED', 'the broker workspace is unavailable');
  }
  const actualRoot = canonicalDirectory(requireGit(workspace.path, ['rev-parse', '--show-toplevel'], 'workspace is no longer a Git worktree').trim());
  if (actualRoot !== canonicalDirectory(workspace.path)) {
    throw brokerError('WORKSPACE_PATH_UNSAFE', 'workspace Git root moved outside its broker-owned path');
  }
  requireGit(workspace.path, ['add', '-A', '--', '.'], 'cannot stage the isolated workspace for change-set capture');
  const unmerged = requireGit(workspace.path, ['ls-files', '-u', '-z'], 'cannot inspect the workspace index');
  if (unmerged) throw brokerError('CHANGESET_CONFLICT', 'workspace index contains unresolved entries; refusing to invent a resolution');
  const patchResult = runGit(workspace.path, [
    'diff', '--cached', '--binary', '--full-index', '--no-ext-diff', workspace.baseRevision, '--', '.'
  ], { maxBuffer: PATCH_MAX_BYTES });
  if (patchResult.status !== 0) {
    throw brokerError('CHANGESET_CREATE_FAILED', gitFailure(patchResult, 'cannot produce the portable Git patch'));
  }
  const patch = patchResult.stdout;
  const records = changedPathRecords(workspace.path, workspace.baseRevision);
  const files = records.map(({ path: file, status }) => manifestEntry(workspace.path, workspace.baseRevision, file, status));
  const id = `${job.id}-changeset-1`;
  const patchPath = path.join(artifactDirectory, `${id}.patch`);
  writePrivate(patchPath, patch);
  const digest = crypto.createHash('sha256').update(patch).digest('hex');
  return {
    changeSet: {
      schemaVersion: 1,
      id,
      base: {
        kind: 'git',
        revision: workspace.baseRevision,
        tree: workspace.baseTree
      },
      files,
      verification: job.verification || null,
      producedBy: job.id,
      containment: 'broker-workspace',
      patch: {
        format: 'git-binary-patch',
        path: patchPath,
        sha256: digest,
        bytes: Buffer.byteLength(patch)
      },
      createdAt: new Date().toISOString()
    },
    patch
  };
}

function workingEntry(root, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.split('/').includes('..')) {
    return { error: 'manifest path is unsafe' };
  }
  const components = file.split('/').slice(0, -1);
  let parent = root;
  for (const component of components) {
    parent = path.join(parent, component);
    try {
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink()) return { error: 'target ancestor is now a symlink' };
      if (!stat.isDirectory()) return { error: 'target ancestor is not a directory' };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { error: error.message };
    }
  }
  const absolute = path.join(root, file);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    return { error: error.message };
  }
  if (stat.isDirectory()) return { error: 'path is now a directory' };
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    const hashed = runGit(root, ['hash-object', '--stdin'], { input: target });
    return hashed.status === 0
      ? { mode: '120000', oid: hashed.stdout.trim() }
      : { error: gitFailure(hashed, 'cannot hash current symlink') };
  }
  if (!stat.isFile()) return { error: 'path is not a regular file or symlink' };
  const hashed = runGit(root, ['hash-object', `--path=${file}`, '--', file]);
  if (hashed.status !== 0) return { error: gitFailure(hashed, 'cannot hash current file') };
  return {
    mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
    oid: hashed.stdout.trim()
  };
}

export function preflightWorkspaceChangeSets(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) throw brokerError('INVALID_REQUEST', 'at least one workspace job is required');
  const ownerRoots = [...new Set(jobs.map((job) => canonicalDirectory(job?.workspace?.ownerRoot || '')))];
  if (ownerRoots.length !== 1 || !ownerRoots[0]) {
    throw brokerError('INVALID_REQUEST', 'change sets must belong to one owner repository');
  }
  const ownerRoot = ownerRoots[0];
  const conflicts = [];
  const claimed = new Map();
  for (const job of jobs) {
    if (job.isolation !== 'worktree' || job.workspace?.ownedBy !== 'delegate-router' || !job.changeSet?.patch?.path) {
      conflicts.push({ jobId: job.id, path: null, reason: 'portable workspace change set is unavailable' });
      continue;
    }
    try {
      if (!isInside(dataDir(), job.changeSet.patch.path) || isInside(ownerRoot, job.changeSet.patch.path)) {
        conflicts.push({ jobId: job.id, path: null, reason: 'change-set patch is outside private broker storage' });
        continue;
      }
      const patch = fs.readFileSync(job.changeSet.patch.path);
      const digest = crypto.createHash('sha256').update(patch).digest('hex');
      if (digest !== job.changeSet.patch.sha256 || patch.length !== job.changeSet.patch.bytes) {
        conflicts.push({ jobId: job.id, path: null, reason: 'change-set patch digest or byte count does not match its manifest' });
        continue;
      }
    } catch (error) {
      conflicts.push({ jobId: job.id, path: null, reason: `change-set patch is unreadable: ${error.message}` });
      continue;
    }
    for (const file of job.changeSet.files || []) {
      if (claimed.has(file.path)) {
        conflicts.push({
          jobId: job.id,
          path: file.path,
          reason: `multiple change sets touch the same path (${claimed.get(file.path)} and ${job.id}); composition does not invent a resolution`
        });
        continue;
      }
      claimed.set(file.path, job.id);
      const current = workingEntry(ownerRoot, file.path);
      if (current?.error) {
        conflicts.push({ jobId: job.id, path: file.path, reason: current.error });
      } else if (file.baseOid == null) {
        if (current != null) conflicts.push({ jobId: job.id, path: file.path, reason: 'target exists but was absent at the immutable base' });
      } else if (current == null) {
        conflicts.push({ jobId: job.id, path: file.path, reason: 'target is absent but existed at the immutable base' });
      } else if (current.oid !== file.baseOid || current.mode !== file.baseMode) {
        conflicts.push({ jobId: job.id, path: file.path, reason: 'target content or mode moved since the immutable base' });
      }
    }
  }
  const currentRevision = requireGit(ownerRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], 'owner repository has no current HEAD commit').trim();
  return {
    ok: conflicts.length === 0,
    ownerRoot,
    currentRevision,
    conflicts
  };
}

function integrationId() {
  return `integration-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function integrationManifest(root, baseRevision) {
  return changedPathRecords(root, baseRevision)
    .map(({ path: file, status }) => manifestEntry(root, baseRevision, file, status));
}

export function composeWorkspaceChangeSets(jobs) {
  const preflight = preflightWorkspaceChangeSets(jobs);
  if (!preflight.ok) return { applied: false, stage: 'cas-preflight', conflicts: preflight.conflicts };
  const id = integrationId();
  const storageRoot = path.join(dataDir(), 'integrations');
  const target = integrationRootFor(id);
  if (isInside(preflight.ownerRoot, storageRoot)) {
    throw brokerError('WORKSPACE_STORAGE_UNSAFE', 'Delegate Router integration storage is inside the owner repository');
  }
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const created = runGit(preflight.ownerRoot, [
    'worktree', 'add', '--detach', '--', target, preflight.currentRevision
  ]);
  if (created.status !== 0) {
    try { removeOwnedWorktree(preflight.ownerRoot, target, storageRoot); } catch {}
    throw brokerError('INTEGRATION_CREATE_FAILED', gitFailure(created, 'integration worktree creation failed'));
  }
  const conflicts = [];
  try {
    for (const job of jobs) {
      for (const file of job.changeSet.files || []) {
        const represented = workingEntry(target, file.path);
        if (file.baseOid == null ? represented != null : represented?.oid !== file.baseOid || represented?.mode !== file.baseMode) {
          conflicts.push({
            jobId: job.id,
            path: file.path,
            reason: 'owner working content is not represented by current HEAD; integration refuses to omit or merge it'
          });
        }
      }
    }
    if (conflicts.length) {
      removeOwnedWorktree(preflight.ownerRoot, target, storageRoot);
      return { applied: false, stage: 'integration-base', conflicts };
    }
    for (const job of jobs) {
      const patchPath = job.changeSet.patch.path;
      const checked = runGit(target, ['apply', '--check', '--index', '--binary', '--whitespace=nowarn', '--', patchPath]);
      if (checked.status !== 0) {
        conflicts.push({ jobId: job.id, path: null, reason: gitFailure(checked, 'change set does not apply cleanly') });
        break;
      }
      const applied = runGit(target, ['apply', '--index', '--binary', '--whitespace=nowarn', '--', patchPath]);
      if (applied.status !== 0) {
        conflicts.push({ jobId: job.id, path: null, reason: gitFailure(applied, 'change set application failed') });
        break;
      }
    }
    if (conflicts.length) {
      removeOwnedWorktree(preflight.ownerRoot, target, storageRoot);
      return { applied: false, stage: 'compose', conflicts };
    }
    const patchResult = runGit(target, [
      'diff', '--cached', '--binary', '--full-index', '--no-ext-diff', preflight.currentRevision, '--', '.'
    ], { maxBuffer: PATCH_MAX_BYTES });
    if (patchResult.status !== 0) {
      throw brokerError('INTEGRATION_CREATE_FAILED', gitFailure(patchResult, 'cannot produce the integrated change set'));
    }
    const patchPath = path.join(storageRoot, `${id}.patch`);
    writePrivate(patchPath, patchResult.stdout);
    const record = {
      schemaVersion: 1,
      id,
      state: 'prepared',
      ownerRoot: preflight.ownerRoot,
      path: target,
      baseRevision: preflight.currentRevision,
      jobIds: jobs.map((job) => job.id),
      files: integrationManifest(target, preflight.currentRevision),
      patch: {
        format: 'git-binary-patch',
        path: patchPath,
        sha256: crypto.createHash('sha256').update(patchResult.stdout).digest('hex'),
        bytes: Buffer.byteLength(patchResult.stdout)
      },
      ownerApplied: false,
      createdAt: new Date().toISOString()
    };
    const recordPath = path.join(storageRoot, `${id}.json`);
    writePrivate(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return { applied: true, stage: 'integration-worktree', integration: { ...record, recordPath } };
  } catch (error) {
    try { removeOwnedWorktree(preflight.ownerRoot, target, storageRoot); } catch {}
    throw error;
  }
}

export function discardWorkspace(workspace) {
  if (workspace?.ownedBy !== 'delegate-router' || workspace?.kind !== 'git-worktree') {
    throw brokerError('INVALID_REQUEST', 'a broker-owned Git workspace is required');
  }
  const result = removeOwnedWorktree(workspace.ownerRoot, workspace.path, path.join(dataDir(), 'workspaces'));
  return {
    ...result,
    path: workspace.path,
    ownerRoot: workspace.ownerRoot,
    state: 'discarded',
    discardedAt: new Date().toISOString()
  };
}
