import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ATTEMPT_CAPABILITIES,
  ATTEMPT_DRIVER_LIFECYCLE,
  createAttemptDriver,
  legacyProviderCapabilities,
  resolveAttemptDriverMatrix,
  scheduleAttemptWorkflow,
  schedulingProfile
} from '../bin/lib/attempt-driver.mjs';
import {
  createManagedJob,
  inspectJob,
  submitControl
} from '../bin/lib/control.mjs';
import { managedAttemptDriver } from '../bin/lib/providers.mjs';

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const healthCli = path.join(pluginRoot, 'bin', 'delegate-health');
const fakeCodex = path.join(pluginRoot, 'test', 'fake-codex-app-server.mjs');
const fakeCursor = path.join(pluginRoot, 'test', 'fake-cursor-parity.mjs');

async function isolated(fn) {
  const previous = process.env.DELEGATE_STATE_FILE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-attempt-driver-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try {
    return await fn(directory);
  } finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  }
}

test('all three lanes expose the complete lifecycle contract behind one negotiated surface', async () => {
  for (const lane of ['codex-app-server', 'cursor-acp', 'cursor-headless']) {
    const calls = [];
    const lifecycle = Object.fromEntries(ATTEMPT_DRIVER_LIFECYCLE.map((method) => [
      method,
      async (value) => {
        calls.push([method, value]);
        return method;
      }
    ]));
    const driver = createAttemptDriver(lane, lifecycle);
    assert.deepEqual(Object.keys(driver.capabilities), ATTEMPT_CAPABILITIES);
    assert.equal(driver.negotiate().lane, lane);
    for (const method of ATTEMPT_DRIVER_LIFECYCLE) assert.equal(await driver[method]('value'), method);
    assert.deepEqual(calls.map(([method]) => method), ATTEMPT_DRIVER_LIFECYCLE);
  }
});

test('capability negotiation preserves honest lane non-parity and evidence provenance', () => {
  const matrix = resolveAttemptDriverMatrix({
    'codex-app-server': { ok: true, noTurn: true, version: '0.144.1' },
    'cursor-acp': { ok: true, noTurn: true, version: '2026.7.9', planMode: true },
    'cursor-headless': {
      ok: true,
      noTurn: true,
      version: '2026.7.9',
      planMode: true,
      mcpInjection: true
    }
  });
  assert.equal(matrix['codex-app-server'].capabilities.sameTurnSteering.supported, true);
  assert.equal(matrix['cursor-acp'].capabilities.sameTurnSteering.mode, 'restart-only');
  assert.equal(matrix['cursor-headless'].capabilities.liveShellStdout.mode, 'completion-only');
  assert.equal(matrix['codex-app-server'].capabilities.midTurnTokenUsage.supported, true);
  assert.equal(matrix['cursor-acp'].capabilities.midTurnTokenUsage.supported, false);
  assert.equal(matrix['cursor-acp'].capabilities.contextOccupancyUsage.supported, true);
  assert.equal(matrix['cursor-headless'].capabilities.contextOccupancyUsage.supported, false);
  assert.equal(matrix['cursor-acp'].capabilities.planMode.evidence.source, 'probed');
  assert.equal(matrix['cursor-headless'].capabilities.mcpInjection.evidence.source, 'probed');
  assert.equal(matrix['codex-app-server'].capabilities.mcpInjection.evidence.source, 'declared-from-documentation');
  for (const lane of Object.values(matrix)) {
    for (const entry of Object.values(lane.capabilities)) {
      assert.ok(['probed', 'declared-from-documentation'].includes(entry.evidence.source));
    }
  }
});

test('scheduling profiles distinguish workflow, budget, checkpoint, and containment guarantees', () => {
  assert.deepEqual(schedulingProfile('codex-app-server'), {
    workflows: { planFirst: true, sameTurnSteering: true, coordinatorBackchannel: true },
    budgets: { outputTokens: 'mid-turn', contextOccupancy: 'unavailable' },
    checkpoints: { liveShellStdout: true, contextOccupancy: false },
    containment: { brokerWorktree: true, mode: 'broker-worktree' }
  });
  assert.deepEqual(schedulingProfile('cursor-acp'), {
    workflows: { planFirst: true, sameTurnSteering: false, coordinatorBackchannel: true },
    budgets: { outputTokens: 'unavailable', contextOccupancy: 'observable' },
    checkpoints: { liveShellStdout: false, contextOccupancy: true },
    containment: { brokerWorktree: true, mode: 'broker-worktree' }
  });
  assert.deepEqual(schedulingProfile('cursor-headless'), {
    workflows: { planFirst: true, sameTurnSteering: false, coordinatorBackchannel: true },
    budgets: { outputTokens: 'completion-only', contextOccupancy: 'unavailable' },
    checkpoints: { liveShellStdout: false, contextOccupancy: false },
    containment: { brokerWorktree: true, mode: 'broker-worktree' }
  });
});

test('a workflow is refused rather than degraded when its lane lacks the named capability', () => {
  assert.throws(
    () => scheduleAttemptWorkflow('cursor-acp', 'mid-turn-output-budget'),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_STRATEGY');
      assert.equal(error.capability, 'midTurnTokenUsage');
      assert.equal(error.lane, 'cursor-acp');
      assert.match(error.message, /lacks required capability 'midTurnTokenUsage'/);
      return true;
    }
  );
  assert.equal(scheduleAttemptWorkflow('codex-app-server', 'mid-turn-output-budget').ok, true);
});

test('driver scheduling preserves legacy job capabilities and the existing Cursor same-turn error', () => isolated((directory) => {
  assert.deepEqual(legacyProviderCapabilities('codex', 'app-server'), {
    events: true,
    transcript: 'live',
    diff: 'provider',
    files: 'provider',
    correction: 'same-turn',
    cancel: true,
    resume: true,
    usage: true,
    selfEnforcesProjectHooks: true
  });
  const job = createManagedJob({
    provider: 'cursor',
    transport: 'acp',
    model: 'composer',
    mode: 'implement',
    cwd: directory,
    prompt: 'implement'
  });
  assert.equal(managedAttemptDriver(job).id, 'cursor-acp');
  assert.deepEqual(job.capabilities, legacyProviderCapabilities('cursor', 'acp'));
  assert.throws(
    () => submitControl(job.id, {
      type: 'steer',
      correctionId: 'same-turn-refusal',
      strategy: 'same-turn',
      text: 'change direction'
    }, inspectJob(job.id).revision),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_STRATEGY');
      assert.equal(error.capability, 'sameTurnSteering');
      assert.equal(error.lane, 'cursor-acp');
      assert.equal(
        error.message,
        'UNSUPPORTED_STRATEGY: Cursor ACP has no same-turn steering; use strategy=auto or restart (applied as a cancel-and-resume restart)'
      );
      return true;
    }
  );
}));

test('health resolves the installed three-lane matrix with no model turn and honors only the provider env override', () => isolated((directory) => {
  fs.chmodSync(fakeCodex, 0o755);
  fs.chmodSync(fakeCursor, 0o755);
  const result = spawnSync(process.execPath, [healthCli, '--quick', '--capabilities', '--json'], {
    cwd: directory,
    env: {
      ...process.env,
      DELEGATE_ENABLED_PROVIDERS: 'codex,cursor',
      DELEGATE_CODEX_BIN: fakeCodex,
      DELEGATE_CURSOR_BIN: fakeCursor,
      DELEGATE_CURSOR_LOGIN_SHELL: '0'
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.attemptDriverProbe.noModelTurns, true);
  assert.equal(report.attemptDriverProbe.enabledProvidersOverrideHonored, true);
  assert.deepEqual(Object.keys(report.attemptDrivers), ['codex-app-server', 'cursor-acp', 'cursor-headless']);
  assert.equal(report.attemptDrivers['codex-app-server'].installation.source, 'probed');
  assert.equal(report.attemptDrivers['cursor-acp'].capabilities.planMode.evidence.source, 'probed');
  assert.equal(report.attemptDrivers['cursor-headless'].capabilities.mcpInjection.evidence.source, 'probed');
}));
