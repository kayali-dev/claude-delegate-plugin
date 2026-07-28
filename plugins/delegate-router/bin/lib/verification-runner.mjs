import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { terminateProcessTree } from './process.mjs';
import { captureVerificationInput } from './verification-profile.mjs';

function verificationFailure(job, message, redact, exitCode = 127) {
  return {
    command: job.verify?.command || '[unavailable]',
    state: 'failed',
    exitCode,
    durationMs: 0,
    outputTail: redact(message, '', 2000)
  };
}

function verificationCommands(job) {
  let stored;
  try { stored = fs.readFileSync(job.verifyCommandPath, 'utf8'); }
  catch (error) { return { error: `verification command is unavailable: ${error.message}` }; }
  if (job.verify?.format !== 'recipe-v1') return { commands: [{ command: stored, cwd: '.' }] };
  try {
    const commands = JSON.parse(stored);
    if (!Array.isArray(commands) || !commands.length
      || !commands.every((entry) => entry && typeof entry.command === 'string' && entry.command.trim())) {
      return { error: 'derived verification recipe is invalid' };
    }
    return { commands };
  } catch (error) {
    return { error: `derived verification recipe is unreadable: ${error.message}` };
  }
}

function verificationCommandCwd(job, entry) {
  const root = job.workspace?.path || job.verificationProfile?.repoRoot || job.cwd;
  const resolved = path.resolve(root, entry.cwd || '.');
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`verification command cwd escapes repository root: ${entry.cwd}`);
  }
  return resolved;
}

async function executeVerificationCommand(job, entry, deadline, append, repositoryRoot) {
  let commandCwd;
  try { commandCwd = verificationCommandCwd(job, entry); }
  catch (error) { return { exitCode: 127, error: error.message, timedOut: false }; }
  return new Promise((resolve) => {
    let child;
    // Repository checks legitimately write temp fixtures, caches, coverage,
    // sockets, and other derived output under their root. The stable-input
    // digest below detects those writes; sandboxing is an explicit recipe
    // option and is never silently substituted for change detection.
    const sandboxRequested = job.verify?.sandboxWrites === true;
    let writeProtection = 'change-detection';
    try {
      const escapedRoot = repositoryRoot.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const sandboxProfile = `(version 1)(allow default)(deny file-write* (subpath "${escapedRoot}"))`;
      const sandboxProbe = sandboxRequested && process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')
        ? spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
          encoding: 'utf8',
          timeout: 2000,
          windowsHide: true
        })
        : null;
      const executable = sandboxProbe?.status === 0 ? '/usr/bin/sandbox-exec' : '/bin/sh';
      writeProtection = sandboxProbe?.status === 0 ? 'sandbox-exec'
        : sandboxRequested ? 'sandbox-unavailable' : 'change-detection';
      const args = sandboxProbe?.status === 0
        ? ['-p', sandboxProfile, '/bin/sh', '-e', '-c', entry.command]
        : ['-e', '-c', entry.command];
      child = spawn(executable, args, {
        cwd: commandCwd,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({ exitCode: 127, error: error.message, timedOut: false, writeProtection: 'unavailable' });
      return;
    }
    let settled = false;
    let timedOut = false;
    const finish = (exitCode, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : Number.isInteger(exitCode) ? exitCode : signal ? 128 : 1,
        timedOut,
        writeProtection
      });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => { append(error.message); finish(127); });
    child.once('exit', finish);
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child);
      finish(124);
    }, remaining);
    timer.unref?.();
  });
}

export async function executeVerification(job, options = {}) {
  const redact = typeof options.redact === 'function' ? options.redact : (value) => value;
  const loaded = verificationCommands(job);
  if (loaded.error) return verificationFailure(job, loaded.error, redact);
  const started = Date.now();
  const timeoutSeconds = Number(job.verify?.timeoutSeconds || 600);
  const deadline = started + timeoutSeconds * 1000;
  const before = captureVerificationInput(job.cwd);
  let output = '';
  let exitCode = 0;
  let timedOut = false;
  let writeProtection = 'change-detection';
  const executed = [];
  const append = (chunk) => { output = `${output}${String(chunk)}`.slice(-8192); };
  for (const entry of loaded.commands) {
    if (Date.now() >= deadline) {
      exitCode = 124;
      timedOut = true;
      break;
    }
    const result = await executeVerificationCommand(job, entry, deadline, append, before.repoRoot);
    executed.push({ command: entry.command, cwd: entry.cwd || '.' });
    if (result.error) append(result.error);
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    writeProtection = result.writeProtection || writeProtection;
    if (exitCode !== 0) break;
  }
  const after = captureVerificationInput(job.cwd);
  const completedAtMs = Date.now();
  const inputChanged = before.digest !== after.digest;
  const state = timedOut ? 'timeout'
    : exitCode !== 0 ? 'failed'
      : inputChanged ? 'stale' : 'passed';
  return {
    command: job.verify.command,
    commands: redact(executed),
    state,
    exitCode,
    timedOut,
    startedAtMs: started,
    completedAtMs,
    durationMs: completedAtMs - started,
    outputTail: redact(output.slice(-2000), '', 2000),
    input: before,
    completedInput: after,
    inputChanged,
    writeProtection
  };
}
