import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { brokerError } from './errors.mjs';
import { terminateProcessTree } from './process.mjs';

export function executableOnPath(name, searchPath = process.env.PATH || '') {
  if (!name) return null;
  if (name.includes(path.sep) || (process.platform === 'win32' && name.includes('/'))) {
    try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { return null; }
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of searchPath.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

export function resolveCursorBinary() {
  const override = process.env.DELEGATE_CURSOR_BIN || process.env.CURSOR_AGENT_PATH;
  return executableOnPath(override || 'agent') || executableOnPath('cursor-agent');
}

export function availableModelIds(binary, timeoutMs = 12000) {
  const result = spawnSync(binary, ['models'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id));
}

function versionParts(value) {
  return value.split('.').map(Number);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function newestModel(ids, expression, minimum) {
  const matches = ids.map((id) => {
    const match = id.match(expression);
    return match ? { id, version: match[1] } : null;
  }).filter(Boolean).filter((item) => compareVersions(item.version, minimum) >= 0);
  matches.sort((a, b) => compareVersions(b.version, a.version));
  return matches[0]?.id || null;
}

export function resolveCursorModel(requested, ids = []) {
  if (requested === 'composer') {
    return process.env.DELEGATE_CURSOR_COMPOSER_MODEL
      || newestModel(ids, /^composer-(\d+(?:\.\d+)*)$/, '2.5')
      || 'composer-2.5';
  }
  if (requested === 'grok' || requested === 'grok-high') {
    return process.env.DELEGATE_CURSOR_GROK_MODEL
      || newestModel(ids, /^(?:cursor-)?grok-(\d+(?:\.\d+)*)-high$/, '4.5')
      || 'grok-4.5-high';
  }
  if (requested === 'grok-xhigh') {
    return process.env.DELEGATE_CURSOR_GROK_XHIGH_MODEL
      || newestModel(ids, /^(?:cursor-)?grok-(\d+(?:\.\d+)*)-xhigh$/, '4.5')
      || 'grok-4.5-xhigh';
  }
  if (requested === 'auto') return 'auto';
  if (ids.length && !ids.includes(requested)) {
    throw brokerError('INVALID_MODEL', `Cursor model '${requested}' is unavailable. Run agent models or cursor-agent models.`, { provider: 'cursor' });
  }
  return requested;
}

export function isReadOnlyMode(mode) {
  return mode === 'consult' || mode === 'plan' || mode === 'review';
}

export function cursorLaunchCommand(binary, args, interactive = true) {
  if (process.platform !== 'darwin' || process.env.DELEGATE_CURSOR_LOGIN_SHELL === '0') return { command: binary, args };
  const shell = process.env.SHELL || '/bin/zsh';
  // Headless must not use -i: an interactive zsh reads the NDJSON stream as
  // shell commands. ACP keeps -i for keychain-backed login environments.
  const flags = interactive ? '-lic' : '-lc';
  return { command: shell, args: [flags, 'exec "$@"', 'delegate-cursor-shell', binary, ...args] };
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

export function buildCursorArgs({
  mode,
  model,
  cwd,
  approval = 'auto',
  resume = null,
  sandbox = null,
  network = false,
  addDirs = [],
  approveMcps = false,
  worktree = false,
  worktreeBase = null
}) {
  const readOnly = isReadOnlyMode(mode);
  const modeElevated = readOnly && network === true;
  const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output'];
  args.push('--model', model, '--workspace', cwd);
  if (resume) args.push('--resume', resume);
  for (const directory of uniqueStrings(addDirs)) args.push('--add-dir', directory);
  if (approveMcps) args.push('--approve-mcps');
  if (worktree) args.push('--worktree');
  if (worktreeBase) args.push('--worktree-base', worktreeBase);
  // Headless runs are non-interactive and cannot answer the workspace-trust
  // prompt; trust is granted explicitly while sandbox/mode flags still bound
  // what the agent may do.
  args.push('--trust');
  // sandbox 'off' is a deliberate caller decision (host CLIs, git, live web);
  // it disables sandboxing for read modes too, since those still need the
  // network the sandbox blocks.
  if (sandbox === 'off') args.push('--sandbox', 'disabled');
  if (!modeElevated && mode === 'consult') args.push('--mode', 'ask');
  else if (!modeElevated && (mode === 'plan' || mode === 'review')) args.push('--mode', 'plan');
  else {
    if (sandbox !== 'off') args.push('--sandbox', 'enabled');
    if (approval === 'force' || (network === true && sandbox === 'off')) args.push('--force');
    else args.push('--auto-review');
  }
  return args;
}

export function cursorProjectConfigPath(cwd) {
  return path.join(path.resolve(cwd), '.cursor', 'cli.json');
}

export function inspectCursorProjectConfig(cwd) {
  const file = cursorProjectConfigPath(cwd);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: true, exists: false, file };
    return { ok: false, exists: true, file, error: error.message };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
    const extra = Object.keys(value).filter((key) => key !== 'permissions');
    if (extra.length) throw new Error(`unsupported project keys: ${extra.join(', ')}`);
    if (value.permissions != null) {
      const permissions = value.permissions;
      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('permissions must be an object');
      const permissionExtra = Object.keys(permissions).filter((key) => !['allow', 'deny'].includes(key));
      if (permissionExtra.length) throw new Error(`unsupported permissions keys: ${permissionExtra.join(', ')}`);
      for (const key of ['allow', 'deny']) {
        if (permissions[key] != null && (!Array.isArray(permissions[key]) || !permissions[key].every((item) => typeof item === 'string'))) {
          throw new Error(`permissions.${key} must be an array of strings`);
        }
      }
    }
    return { ok: true, exists: true, file };
  } catch (error) {
    return { ok: false, exists: true, file, error: error.message };
  }
}

export function cursorProjectConfigFailure(stderr, cwd) {
  const text = String(stderr || '');
  const file = cursorProjectConfigPath(cwd);
  if (!/(?:\.cursor[\\/]cli\.json|cli\.json).*(?:invalid|malformed|parse|schema|unexpected)|(?:invalid|malformed|parse|schema|unexpected).*\.cursor[\\/]cli\.json/is.test(text)) return null;
  return {
    code: 'CURSOR_PROJECT_CONFIG_INVALID',
    file,
    message: `Cursor rejected ${file}; project cli.json supports only {"permissions":{"allow":[],"deny":[]}}`
  };
}

function readCursorNetworkAccess() {
  const file = path.join(process.env.DELEGATE_CURSOR_HOME || os.homedir(), '.cursor', 'cli-config.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = value?.sandbox?.networkAccess;
    if (raw == null) return { file, value: 'user_config_with_defaults', source: 'default' };
    const aliases = { allowlist: 'user_config_only', enabled: 'user_config_with_defaults' };
    return { file, value: aliases[raw] || raw, source: 'config' };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, value: 'user_config_with_defaults', source: 'default' };
    return { file, value: null, source: 'invalid', error: error.message };
  }
}

function domainMatchesRule(domain, rule) {
  const candidate = String(domain || '').toLowerCase();
  const pattern = String(rule || '').toLowerCase();
  if (!candidate || !pattern) return false;
  if (pattern === '*' || candidate === pattern) return true;
  if (pattern.startsWith('*.')) return candidate === pattern.slice(2) || candidate.endsWith(pattern.slice(1));
  return false;
}

export function evaluateCursorNetworkPreflight(job, policy = null) {
  const projectConfig = inspectCursorProjectConfig(job.cwd);
  if (!projectConfig.ok) {
    throw brokerError('INVALID_REQUEST', `CURSOR_PROJECT_CONFIG_INVALID: Cursor project config is invalid: ${projectConfig.file}: ${projectConfig.error}. Use only {"permissions":{"allow":[],"deny":[]}}`, {
      provider: 'cursor', file: projectConfig.file, cursorErrorCode: 'CURSOR_PROJECT_CONFIG_INVALID'
    });
  }
  const readOnly = isReadOnlyMode(job.mode);
  const sandboxEnabled = job.sandbox !== 'off';
  const force = job.network === true && !sandboxEnabled;
  const networkAccess = readCursorNetworkAccess();
  const supportedAccess = new Set(['user_config_only', 'user_config_with_defaults', 'allow_all']);
  if (job.network === true && sandboxEnabled && !supportedAccess.has(networkAccess.value)) {
    throw brokerError('INVALID_REQUEST', `Cursor sandbox network policy is unsatisfiable: set sandbox.networkAccess in ${networkAccess.file} to user_config_only, user_config_with_defaults, or allow_all`, {
      provider: 'cursor', file: networkAccess.file
    });
  }
  const requestedDomains = uniqueStrings(job.networkAllow || []);
  const denied = uniqueStrings(policy?.deny || []);
  const conflicts = requestedDomains.filter((domain) => denied.some((rule) => domainMatchesRule(domain, rule)));
  if (job.network === true && sandboxEnabled && conflicts.length) {
    throw brokerError('INVALID_REQUEST', `Cursor sandbox network policy denies requested domain(s) ${conflicts.join(', ')}; remove the matching entries from ${path.join(job.cwd, '.cursor', 'sandbox.json')} or omit them from networkAllow`, {
      provider: 'cursor', conflicts
    });
  }
  if (job.network === true && sandboxEnabled && Array.isArray(job.networkAllow) && requestedDomains.length === 0) {
    throw brokerError('INVALID_REQUEST', 'networkAllow was supplied but contains no usable domains; provide at least one domain or omit networkAllow for default allow', { provider: 'cursor' });
  }
  return {
    requested: job.network === true,
    requestedMode: job.mode,
    effectiveMode: job.network === true && readOnly ? 'agent' : job.mode === 'consult' ? 'ask' : readOnly ? 'plan' : 'agent',
    modeElevated: job.network === true && readOnly,
    sandbox: sandboxEnabled ? 'enabled' : 'disabled',
    force,
    cliNetworkAccess: networkAccess.value,
    cliNetworkAccessSource: networkAccess.source,
    sandboxPolicy: policy ? {
      default: policy.default || null,
      allow: uniqueStrings(policy.allow || []),
      deny: denied
    } : null,
    expectedEgress: job.network !== true ? 'not-requested'
      : force ? 'allowed-unsandboxed-force'
        : requestedDomains.length ? 'sandbox-allowlist' : 'sandbox-default-allow',
    webFetch: force ? 'allowed-by-force' : job.network === true ? 'approval-gated; this Cursor build requires force for WebFetch' : 'not-requested'
  };
}

export function materializeCursorNetworkPolicy(job, onMutation = () => {}) {
  if (job.network !== true || job.sandbox === 'off') return { policy: null, cleanup() {} };
  const directory = path.join(job.cwd, '.cursor');
  const file = path.join(directory, 'sandbox.json');
  const existed = fs.existsSync(file);
  const directoryExisted = fs.existsSync(directory);
  let previous = null;
  let previousMode = 0o600;
  let previousLink = null;
  let value = {};
  if (existed) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) previousLink = fs.readlinkSync(file);
    previous = fs.readFileSync(file);
    previousMode = fs.statSync(file).mode & 0o777;
    try { value = JSON.parse(previous.toString('utf8')); }
    catch (error) {
      throw brokerError('INVALID_REQUEST', `Cursor sandbox config is invalid: ${file}: ${error.message}`, { provider: 'cursor', file });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw brokerError('INVALID_REQUEST', `Cursor sandbox config must contain a JSON object: ${file}`, { provider: 'cursor', file });
    }
  }
  const requested = uniqueStrings(job.networkAllow || []);
  const current = value.networkPolicy && typeof value.networkPolicy === 'object' && !Array.isArray(value.networkPolicy)
    ? value.networkPolicy : {};
  const policy = {
    ...current,
    default: Array.isArray(job.networkAllow) ? 'deny' : 'allow',
    ...(requested.length || Array.isArray(job.networkAllow) ? { allow: uniqueStrings([...(current.allow || []), ...requested]) } : {})
  };
  const next = { ...value, networkPolicy: policy };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.sandbox.json.delegate-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, existed ? previousMode : 0o600); } catch {}
  onMutation('network.policy.materialized', { file, existed, policy });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (existed) {
        if (previousLink != null) {
          try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          fs.symlinkSync(previousLink, file);
        } else {
          fs.writeFileSync(file, previous, { mode: previousMode });
          try { fs.chmodSync(file, previousMode); } catch {}
        }
      } else {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!directoryExisted) {
          try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
        }
      }
      onMutation('network.policy.restored', { file, restored: existed ? 'previous-bytes' : 'absent' });
    } finally {
      process.off('exit', cleanup);
    }
  };
  process.once('exit', cleanup);
  return { policy, file, cleanup };
}

export function stripPromptArgs(args) {
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--prompt' || args[i] === '--prompt-file') {
      i += 1;
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

export function findValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) if (value[key] != null) return value[key];
  for (const child of Object.values(value)) {
    const found = findValue(child, keys);
    if (found != null) return found;
  }
  return null;
}

function progressFromEvent(event) {
  if (event?.type === 'tool_call' && event.subtype === 'started') {
    const tool = Object.keys(event.tool_call || {})[0]?.replace(/ToolCall$/, '') || 'tool';
    return `Cursor: ${tool}`;
  }
  if (event?.type === 'assistant') return 'Cursor: composing response';
  return null;
}

export async function runCursor({ binary, args, cwd, prompt, timeoutMs, onProgress, onEvent, onChild }) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    onChild?.(child);
    let stderr = '';
    let rawOutput = '';
    let finalPayload = null;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const lines = readline.createInterface({ input: child.stdout });

    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child);
    }, timeoutMs);
    timer.unref?.();

    const cancel = async () => {
      cancelled = true;
      await terminateProcessTree(child);
    };

    lines.on('line', (line) => {
      rawOutput += `${line}\n`;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      onEvent?.(event);
      if (event.type === 'result') finalPayload = event;
      const progress = progressFromEvent(event);
      if (progress) onProgress?.(progress, event);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      resolve({ status: 1, error: error.message, stderr, rawOutput, timedOut, cancelled, cancel });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!finalPayload && rawOutput.trim().startsWith('{')) {
        try { finalPayload = JSON.parse(rawOutput); } catch {}
      }
      const error = timedOut
        ? `Cursor timed out after ${Math.round(timeoutMs / 1000)} seconds`
        : cancelled
          ? 'Cursor was cancelled'
          : code === 0 && finalPayload
            ? null
            : stderr.trim() || finalPayload?.result || `Cursor exited with code ${code}`;
      resolve({
        status: error ? 1 : 0,
        exitCode: code,
        signal,
        payload: finalPayload,
        stderr,
        rawOutput,
        error,
        timedOut,
        cancelled,
        cancel
      });
    });
    child.stdin.end(prompt);
  });
}
