import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditLogPath, dataDir, jobsDir, providerConfigPath, statePath } from './state.mjs';

export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 600;

const INSTRUCTION_NAMES = ['CLAUDE.md', 'AGENTS.md'];
const QUALITY_HEADING = /^(?:commands?|quality|development workflow|verification|required verification|tests?|testing)(?:\s|$)/i;
const QUALITY_COMMAND = /(?:^|[\s/._-])(?:test|tests|check|checks|lint|typecheck|type-check|verify|verification)(?:$|[\s/._:-])/i;
const MUTATING_COMMAND = /(?:^|[;&|]\s*|\n\s*)(?:rm|mv|cp|install|git\s+(?:commit|reset|checkout|restore|clean)|(?:npm|pnpm|bun|yarn)\s+(?:install|add|remove)|[^#\n]*\s--fix(?:\s|$))/i;
const MANIFEST_SCRIPT_ORDER = ['check', 'checks', 'test', 'lint', 'typecheck'];

function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalDirectory(value) {
  const resolved = path.resolve(value);
  try { return (fs.realpathSync.native || fs.realpathSync)(resolved); }
  catch { return path.normalize(resolved); }
}

export function verificationRepositoryRoot(cwd) {
  const resolved = canonicalDirectory(cwd);
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: resolved,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  return result.status === 0 && result.stdout.trim()
    ? canonicalDirectory(result.stdout.trim())
    : resolved;
}

export function verificationRepositoryRevision(cwd) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function instructionDirectories(cwd, root) {
  const directories = [];
  let current = canonicalDirectory(cwd);
  const canonicalRoot = canonicalDirectory(root);
  for (;;) {
    directories.push(current);
    if (current === canonicalRoot) break;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${canonicalRoot}${path.sep}`)) break;
    current = parent;
  }
  return directories;
}

function sourceCandidates(cwd, root) {
  const candidates = [];
  for (const directory of instructionDirectories(cwd, root)) {
    for (const name of INSTRUCTION_NAMES) {
      const file = path.join(directory, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) candidates.push({ kind: 'instructions', file });
    }
  }
  const manifestDirectories = [...new Set([canonicalDirectory(cwd), canonicalDirectory(root)])];
  for (const directory of manifestDirectories) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) candidates.push({ kind: 'manifest', file });
  }
  return candidates;
}

function candidateSnapshot(candidates) {
  return candidates.map((candidate) => {
    let content = '';
    try { content = fs.readFileSync(candidate.file, 'utf8'); } catch {}
    return { ...candidate, digest: sha(content), content };
  });
}

function cacheFile(root, cacheDirectory = path.join(dataDir(), 'verification-profiles')) {
  return path.join(cacheDirectory, `${sha(canonicalDirectory(root))}.json`);
}

function cacheKey(root, snapshots) {
  return sha(JSON.stringify({
    root: canonicalDirectory(root),
    sources: snapshots.map(({ kind, file, digest }) => ({ kind, file: canonicalDirectory(file), digest }))
  }));
}

function sectionBlocks(content) {
  const lines = String(content).split(/\r?\n/);
  const blocks = [];
  let heading = null;
  let inFence = false;
  let fence = [];
  for (const line of lines) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!inFence && match) {
      heading = QUALITY_HEADING.test(match[1].trim()) ? match[1].trim() : null;
      continue;
    }
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fence = [];
      } else {
        const lines = fence.map((candidate) => candidate.trim().replace(/^\$\s+/, ''))
          .filter((candidate) => candidate && !candidate.startsWith('#'));
        const directoryChange = lines.findLast((candidate) => /^cd\s+[a-zA-Z0-9_./-]+$/.test(candidate));
        const candidates = lines
          .map((candidate) => candidate.replace(/\s+#.*$/, '').trim())
          .filter((candidate) => QUALITY_COMMAND.test(candidate) && !MUTATING_COMMAND.test(candidate));
        const checks = candidates.filter((candidate) => /(?:^|[\s:-])checks?(?:$|[\s:-])/.test(candidate));
        const selected = checks.length ? [checks[0]] : candidates;
        if (heading) {
          for (const candidate of selected) {
            blocks.push({
              command: directoryChange && directoryChange !== candidate
                ? `${directoryChange}\n${candidate}`
                : candidate,
              section: heading
            });
          }
        }
        inFence = false;
        fence = [];
      }
      continue;
    }
    if (inFence) fence.push(line);
  }
  return blocks;
}

function instructionRecipe(snapshots, root) {
  for (const snapshot of snapshots.filter((candidate) => candidate.kind === 'instructions')) {
    const blocks = sectionBlocks(snapshot.content);
    if (!blocks.length) continue;
    return {
      commands: blocks.map(({ command }) => ({
        command,
        cwd: path.relative(root, path.dirname(snapshot.file)) || '.'
      })),
      timeoutSeconds: DEFAULT_VERIFY_TIMEOUT_SECONDS,
      source: {
        kind: 'instructions',
        path: snapshot.file,
        sections: [...new Set(blocks.map(({ section }) => section))],
        precedence: 'CLAUDE.md then AGENTS.md, nearest cwd to repository root; qualifying quality sections before manifests'
      }
    };
  }
  return null;
}

function packageManager(manifest, directory) {
  const declared = typeof manifest.packageManager === 'string'
    ? manifest.packageManager.split('@')[0].trim()
    : '';
  if (['bun', 'pnpm', 'npm', 'yarn'].includes(declared)) return declared;
  if (fs.existsSync(path.join(directory, 'bun.lock')) || fs.existsSync(path.join(directory, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(directory, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function manifestRecipe(snapshots, root) {
  for (const snapshot of snapshots.filter((candidate) => candidate.kind === 'manifest')) {
    let manifest;
    try { manifest = JSON.parse(snapshot.content); } catch { continue; }
    const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
    const names = MANIFEST_SCRIPT_ORDER.filter((name) => typeof scripts[name] === 'string'
      && scripts[name].trim()
      && !MUTATING_COMMAND.test(scripts[name]));
    if (!names.length) continue;
    const selected = names.includes('check') ? ['check']
      : names.includes('checks') ? ['checks']
        : names;
    const directory = path.dirname(snapshot.file);
    const manager = packageManager(manifest, directory);
    return {
      commands: selected.map((name) => ({
        command: `${manager} run ${name}`,
        cwd: path.relative(root, directory) || '.',
        script: name
      })),
      timeoutSeconds: DEFAULT_VERIFY_TIMEOUT_SECONDS,
      source: {
        kind: 'package-manifest',
        path: snapshot.file,
        scripts: selected,
        packageManager: manager,
        precedence: 'check, checks, then test + lint + typecheck'
      }
    };
  }
  return null;
}

export function deriveVerificationProfile(cwd, options = {}) {
  const root = verificationRepositoryRoot(cwd);
  const snapshots = candidateSnapshot(sourceCandidates(cwd, root));
  const key = cacheKey(root, snapshots);
  const file = cacheFile(root, options.cacheDirectory);
  if (options.cache !== false) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.cacheKey === key && cached.repoRoot === root) return { ...cached, cache: { state: 'hit', path: file } };
    } catch {}
  }

  const recipe = instructionRecipe(snapshots, root) || manifestRecipe(snapshots, root);
  const profile = {
    schemaVersion: 1,
    repoRoot: root,
    cacheKey: key,
    derivedAt: new Date().toISOString(),
    recipe,
    ...(recipe ? {} : {
      noRecipeReason: 'No non-mutating verification command was found in a Commands, Quality, Development Workflow, Verification, Tests, or Testing instruction section, or in package.json scripts named check, checks, test, lint, or typecheck.'
    })
  };
  if (options.cache !== false) {
    try { privateWrite(file, `${JSON.stringify(profile, null, 2)}\n`); } catch {}
  }
  return {
    ...profile,
    cache: options.cache === false ? { state: 'disabled', path: null } : { state: 'miss', path: file }
  };
}

function statusEntries(cwd) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) return [];
  const raw = result.stdout.split('\0').filter(Boolean);
  const internalState = [
    dataDir() === path.resolve(cwd) ? null : dataDir(),
    jobsDir(),
    auditLogPath(),
    statePath(),
    providerConfigPath(),
    path.join(dataDir(), 'verification-profiles')
  ].filter(Boolean).map((candidate) => path.relative(cwd, candidate).replaceAll('\\', '/').replace(/\/+$/, ''))
    .filter((candidate) => candidate && candidate !== '..' && !candidate.startsWith('../') && !path.isAbsolute(candidate));
  const internal = (file) => internalState.some((candidate) => file === candidate || file.startsWith(`${candidate}/`));
  const entries = [];
  for (let index = 0; index < raw.length; index += 1) {
    const status = raw[index].slice(0, 2);
    const name = raw[index].slice(3);
    if (name && !internal(name)) {
      entries.push({ status, name });
    }
    if (/[RC]/.test(status) && raw[index + 1]) {
      const source = raw[++index];
      if (!internal(source)) {
        entries.push({ status: `${status}:source`, name: source });
      }
    }
  }
  return entries;
}

// This deliberately fingerprints names and metadata, not file contents. It
// detects coordinator/provider overlap without reading credential-like files
// or persisting repository content in the broker state.
export function captureVerificationInput(cwd) {
  const root = verificationRepositoryRoot(cwd);
  const entries = statusEntries(root).map((entry) => {
    const absolute = path.join(root, entry.name);
    try {
      const stat = fs.lstatSync(absolute);
      return { ...entry, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, type: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other' };
    } catch {
      return { ...entry, absent: true };
    }
  });
  const revision = verificationRepositoryRevision(root);
  return {
    repoRoot: root,
    revision,
    digest: sha(JSON.stringify({ revision, entries }))
  };
}
