import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataDir } from '../state.mjs';

function splitEditorCommand(value) {
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of String(value || '').trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('VISUAL/EDITOR contains an unmatched quote');
  if (current) parts.push(current);
  return parts;
}

function defaultSpawnEditor({ command, file, env }) {
  const [executable, ...args] = splitEditorCommand(command);
  if (!executable) return { status: 127, signal: null, error: new Error('editor command is empty') };
  return spawnSync(executable, [...args, file], { env, stdio: 'inherit' });
}

function privateScratchDirectory(root) {
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(scratch, 0o700); } catch {}
  const directory = fs.mkdtempSync(path.join(scratch, 'tui-editor-'));
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}

export function editTextInEditor(options = {}) {
  const env = options.env || process.env;
  const command = String(env.VISUAL || env.EDITOR || '').trim();
  const previous = String(options.text || '');
  if (!command) return { available: false, accepted: false, text: previous, status: null, signal: null };
  const directory = privateScratchDirectory(options.stateDirectory || dataDir());
  const file = path.join(directory, 'body.md');
  fs.writeFileSync(file, previous, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  let result = null;
  let suspended = false;
  try {
    suspended = options.screen?.suspend() === true;
    result = (options.spawnEditor || defaultSpawnEditor)({ command, file, env });
    const accepted = result?.status === 0 && !result?.signal;
    return {
      available: true,
      accepted,
      text: accepted ? fs.readFileSync(file, 'utf8') : previous,
      status: result?.status ?? null,
      signal: result?.signal || null,
      error: result?.error || null
    };
  } catch (error) {
    return { available: true, accepted: false, text: previous, status: result?.status ?? null, signal: result?.signal || null, error };
  } finally {
    try { fs.unlinkSync(file); } catch {}
    try { fs.rmdirSync(directory); } catch {}
    if (suspended) options.screen.resume();
  }
}

export { splitEditorCommand };
