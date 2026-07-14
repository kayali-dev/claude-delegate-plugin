import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const originalEnvironment = Object.freeze({ ...process.env });
const contexts = new Map();

function restoreEnvironment(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function isolatedEnvironment(base, root) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DELEGATE_TUI_')) delete env[key];
  }
  for (const key of [
    'NO_COLOR', 'TMUX', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
    'DELEGATE_PROVIDER_CONFIG', 'DELEGATE_CONNECT_TOKEN', 'DELEGATE_SERVE_TOKEN'
  ]) delete env[key];
  env.HOME = path.join(root, 'home');
  env.XDG_STATE_HOME = path.join(root, 'xdg-state');
  env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  env.DELEGATE_ENABLED_PROVIDERS = 'codex,cursor';
  env.DELEGATE_CLAUDE_PROJECTS_DIR = path.join(root, 'claude-projects');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  return Object.freeze(env);
}

function createContext(label, base = originalEnvironment) {
  const safeLabel = path.basename(label || 'suite').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 48);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `delegate-tui-test-${safeLabel}-`));
  const env = isolatedEnvironment(base, root);
  for (const directory of [env.HOME, env.XDG_STATE_HOME, path.dirname(env.DELEGATE_STATE_FILE), env.DELEGATE_CLAUDE_PROJECTS_DIR]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return Object.freeze({
    root,
    env,
    stateFile: env.DELEGATE_STATE_FILE,
    stateDirectory: path.dirname(env.DELEGATE_STATE_FILE),
    preferencesFile: path.join(path.dirname(env.DELEGATE_STATE_FILE), 'tui-prefs.json'),
    projectsDirectory: env.DELEGATE_CLAUDE_PROJECTS_DIR
  });
}

function activate(context) {
  restoreEnvironment(context.env);
}

async function resetTuiRuntime(context) {
  activate(context);
  const [{ setUiTheme }, { configureGlyphs }, { clearGraphemeWidthOverrides }] = await Promise.all([
    import('../../bin/lib/tui/palette.mjs'),
    import('../../bin/lib/tui/glyphs.mjs'),
    import('../../bin/lib/tui/width.mjs')
  ]);
  clearGraphemeWidthOverrides();
  configureGlyphs({ env: context.env, widths: {} });
  setUiTheme('dark', context.env);
}

// Establish a safe environment while the remainder of a test module's static
// imports are evaluated. The public helper below claims this context for the
// importing test file and resets all live TUI singletons before tests run.
const bootstrapContext = createContext('bootstrap');
activate(bootstrapContext);
let bootstrapClaimed = false;

export async function useTuiTestHarness(metaUrl, callback) {
  const file = fileURLToPath(metaUrl);
  let context = contexts.get(file);
  if (!context) {
    context = !bootstrapClaimed ? bootstrapContext : createContext(path.basename(file), originalEnvironment);
    bootstrapClaimed = true;
    contexts.set(file, context);
    await resetTuiRuntime(context);
    after(() => {
      restoreEnvironment(originalEnvironment);
      fs.rmSync(context.root, { recursive: true, force: true });
    });
  }
  if (typeof callback !== 'function') return context;

  const nested = createContext(`${path.basename(file)}-nested`, process.env);
  await resetTuiRuntime(nested);
  try {
    return await callback(nested);
  } finally {
    fs.rmSync(nested.root, { recursive: true, force: true });
    await resetTuiRuntime(context);
  }
}
