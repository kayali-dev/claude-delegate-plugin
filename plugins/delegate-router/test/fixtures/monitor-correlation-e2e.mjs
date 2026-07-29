import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { waitForChildExit, waitForCondition } from '../helpers/wait.mjs';

const pluginRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const hookBin = path.join(pluginRoot, 'bin', 'delegate-session-hook');
const monitorBin = path.join(pluginRoot, 'bin', 'delegate-monitor');
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || process.argv[2] || 'fixture-session';
const workspace = path.resolve(process.argv[3] || process.cwd());
const delayMs = Math.max(0, Number(process.argv[4] || 0));

function correlationDirectory(root) {
  return path.join(root, 'monitor-correlation');
}

function records(root, prefix) {
  try {
    return fs.readdirSync(correlationDirectory(root))
      .filter((name) => name.startsWith(prefix))
      .map((name) => JSON.parse(fs.readFileSync(path.join(correlationDirectory(root), name), 'utf8')));
  } catch {
    return [];
  }
}

async function stop(child) {
  child.kill('SIGTERM');
  await waitForChildExit({ child, description: 'the monitor fixture process to exit after SIGTERM' });
}

async function runMonitor(root) {
  const env = {
    ...process.env,
    DELEGATE_STATE_FILE: path.join(root, 'usage.json'),
    CLAUDE_PROJECT_DIR: workspace,
    DELEGATE_MONITOR_SCOPE: 'session',
    DELEGATE_MONITOR_POLL_MS: '60000'
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  const child = spawn(process.execPath, [monitorBin], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const resolution = await waitForCondition({
    description: 'the monitor fixture to publish a resolution record',
    timeoutMs: 3_000,
    observe: () => records(root, 'resolution-')[0] || null
  });
  await stop(child);
  return {
    resolution,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

const matchedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-correlation-e2e-match-'));
const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-correlation-e2e-missing-'));
try {
  const hookEnv = {
    ...process.env,
    DELEGATE_STATE_FILE: path.join(matchedRoot, 'usage.json'),
    CLAUDE_PROJECT_DIR: workspace,
    CLAUDE_CODE_SESSION_ID: sessionId
  };
  const started = performance.now();
  const hook = spawnSync(process.execPath, [hookBin], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: workspace
    }),
    env: hookEnv
  });
  const hookDurationMs = Math.round((performance.now() - started) * 10) / 10;
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const matched = await runMonitor(matchedRoot);
  const missing = await runMonitor(missingRoot);
  const marker = records(matchedRoot, 'session-')[0] || null;
  const handshakeFiles = fs.readdirSync(correlationDirectory(matchedRoot))
    .filter((name) => /^(?:request|response)-/.test(name));
  process.stdout.write(`${JSON.stringify({
    currentLiveSessionId: sessionId,
    workspace,
    delayedMonitorStartMs: delayMs,
    hook: {
      exitCode: hook.status,
      durationMs: hookDurationMs,
      stderr: hook.stderr.trim()
    },
    marker: marker && {
      version: marker.version,
      ttlHours: (marker.expiresAtMs - marker.createdAtMs) / (60 * 60 * 1000),
      ancestorDepth: marker.ancestorChain?.length || 0,
      handshakeFiles
    },
    matchedMonitor: {
      status: matched.resolution?.status || null,
      effectiveScope: matched.resolution?.effectiveScope || null,
      sessionId: matched.resolution?.sessionId || null,
      reason: matched.resolution?.reason || null,
      commonAncestor: matched.resolution?.commonAncestor || null,
      stdout: matched.stdout,
      stderr: matched.stderr
    },
    missingMarkerMonitor: {
      status: missing.resolution?.status || null,
      effectiveScope: missing.resolution?.effectiveScope || null,
      reason: missing.resolution?.reason || null,
      stdout: missing.stdout,
      stderr: missing.stderr
    }
  }, null, 2)}\n`);
} finally {
  fs.rmSync(matchedRoot, { recursive: true, force: true });
  fs.rmSync(missingRoot, { recursive: true, force: true });
}
