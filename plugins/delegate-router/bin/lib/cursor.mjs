import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
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
      || newestModel(ids, /^grok-(\d+(?:\.\d+)*)-high$/, '4.5')
      || 'grok-4.5-high';
  }
  if (requested === 'grok-xhigh') {
    return process.env.DELEGATE_CURSOR_GROK_XHIGH_MODEL
      || newestModel(ids, /^grok-(\d+(?:\.\d+)*)-xhigh$/, '4.5')
      || 'grok-4.5-xhigh';
  }
  if (requested === 'auto') return 'auto';
  if (ids.length && !ids.includes(requested)) {
    throw new Error(`Cursor model '${requested}' is unavailable. Run agent models or cursor-agent models.`);
  }
  return requested;
}

export function isReadOnlyMode(mode) {
  return mode === 'consult' || mode === 'plan' || mode === 'review';
}

export function buildCursorArgs({ mode, model, cwd, approval = 'auto', resume = null }) {
  const readOnly = isReadOnlyMode(mode);
  const outputFormat = readOnly ? 'json' : 'stream-json';
  const args = ['--print', '--output-format', outputFormat];
  if (!readOnly) args.push('--stream-partial-output');
  args.push('--model', model, '--workspace', cwd);
  if (resume) args.push('--resume', resume);
  // Headless runs are non-interactive and cannot answer the workspace-trust
  // prompt; trust is granted explicitly while sandbox/mode flags still bound
  // what the agent may do.
  args.push('--trust');
  if (mode === 'consult') args.push('--mode', 'ask');
  else if (mode === 'plan' || mode === 'review') args.push('--mode', 'plan');
  else {
    args.push('--sandbox', 'enabled');
    if (approval === 'force') args.push('--force');
    else args.push('--auto-review');
  }
  return args;
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
