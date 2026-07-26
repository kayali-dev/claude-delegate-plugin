import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WORK_SCHEMA_VERSION,
  createWorkSpec,
  validateWorkSpec
} from '../bin/lib/work-model.mjs';
import {
  projectChainAsWorkItem,
  projectJobAsWorkItem,
  projectJobsAsWorkItems
} from '../bin/lib/work-projection.mjs';
import {
  readWorkItem,
  updateWorkItem,
  workDir,
  writeWorkItem
} from '../bin/lib/work-store.mjs';
import { saveJob } from '../bin/lib/state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jobsCli = path.join(root, 'bin', 'delegate-jobs');
const controlMcp = path.join(root, 'bin', 'delegate-control-mcp');

function withState(directory, action) {
  const previous = process.env.DELEGATE_STATE_FILE;
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { return action(); }
  finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  }
}

function fileSnapshot(directory) {
  const snapshot = {};
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const stat = fs.statSync(absolute);
        snapshot[path.relative(directory, absolute)] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          mode: stat.mode & 0o777
        };
      }
    }
  };
  visit(directory);
  return snapshot;
}

async function mcpWork(env, args) {
  const child = spawn(process.execPath, [controlMcp], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'delegate_work', arguments: args }
  })}\n`);
  for (let index = 0; index < 100 && responses.length < 1; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(responses.length, 1);
  return JSON.parse(responses[0].result.content[0].text);
}

test('historical fixture corpus projects totally with stable ids and explicit gaps', () => {
  const corpus = [
    {
      schemaVersion: 1,
      id: 'codex-old-orphan',
      provider: 'codex',
      status: 'failed',
      phase: 'failed',
      error: { code: 'ORPHANED' },
      createdAt: 1
    },
    {
      schemaVersion: 2,
      id: 'codex-direct-mcp',
      provider: 'codex',
      transport: 'direct-mcp',
      managedBy: 'delegate-shadow',
      providerSessionId: 'thread-direct',
      status: 'completed'
    },
    {
      id: 'cursor-direct-cli',
      provider: 'cursor',
      transport: 'direct-cli',
      managedBy: 'delegate-shadow',
      session: 'cursor-chat',
      status: 'completed'
    },
    {
      id: 'external-codex-row',
      provider: 'codex',
      transport: 'external-codex',
      managedBy: 'codex-session-scanner',
      status: 'running',
      promptSummary: 'external read-only work'
    },
    {
      id: 'claude-agent-stub',
      provider: 'claude',
      transport: 'claude-agent',
      managedBy: 'delegate-agent-hook',
      agentType: 'Explore',
      status: 'running',
      result: null
    },
    {
      id: 'codex-fenced',
      provider: 'codex',
      status: 'completed',
      allowedPaths: ['bin/lib/**', 'test/**'],
      verify: { command: 'node --test test/*.test.mjs', timeoutSeconds: 600 }
    },
    {
      id: 'codex-findings',
      provider: 'codex',
      status: 'completed',
      result: {
        structured: {
          findings: [{ id: 'F-1', severity: 'high', criterion: 'No writes', status: 'open' }]
        }
      }
    },
    {
      id: 'cursor-cancelled',
      provider: 'cursor',
      mode: 'review',
      status: 'cancelled',
      stopReason: 'cancelled'
    }
  ];

  for (const record of corpus) {
    let first;
    let second;
    assert.doesNotThrow(() => { first = projectJobAsWorkItem(record); });
    assert.doesNotThrow(() => { second = projectJobAsWorkItem(record); });
    assert.equal(first.id, second.id);
    assert.equal(first.runs.length, 1);
    assert.equal(first.runs[0].attempt.id, record.id);
    assert.equal(first.decision, null);
  }
  assert.equal(projectJobAsWorkItem(corpus[0]).spec.scopeClaim, 'unfenced');
  assert.equal(projectJobAsWorkItem(corpus[0]).spec.verifyRecipe, null);
  assert.deepEqual(projectJobAsWorkItem(corpus[5]).spec.scopeClaim, ['bin/lib/**', 'test/**']);
  assert.equal(projectJobAsWorkItem(corpus[5]).spec.verifyRecipe.command, 'node --test test/*.test.mjs');
  assert.equal(projectJobAsWorkItem(corpus[6]).findings[0].id, 'F-1');
  assert.doesNotThrow(() => projectJobAsWorkItem(null));
});

test('five-deep chains and sibling review rounds collapse into one ordered work item', () => {
  const chain = Array.from({ length: 5 }, (_, index) => ({
    id: `round-${index}`,
    rootJobId: index ? 'round-0' : undefined,
    parentJobId: index ? `round-${index - 1}` : null,
    provider: 'codex',
    model: 'sol',
    mode: index ? 'review' : 'implement',
    status: 'completed',
    createdAt: index + 1
  }));
  const projected = projectJobsAsWorkItems([...chain].reverse());
  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, 'work-round-0');
  assert.equal(projected[0].runs.length, 5);
  assert.deepEqual(projected[0].runs.map((run) => run.attempt.id), chain.map((job) => job.id));
  assert.deepEqual(
    projectChainAsWorkItem([...chain].reverse()).runs.map((run) => run.attempt.id),
    chain.map((job) => job.id)
  );

  const siblings = [
    chain[0],
    { ...chain[1], id: 'review-a', parentJobId: 'round-0', createdAt: 10 },
    { ...chain[1], id: 'review-b', parentJobId: 'round-0', createdAt: 11 }
  ];
  const siblingProjection = projectJobsAsWorkItems(siblings);
  assert.equal(siblingProjection.length, 1);
  assert.deepEqual(siblingProjection[0].runs.map((run) => run.attempt.id), ['round-0', 'review-a', 'review-b']);
});

test('WorkSpec validation accepts a minimal valid spec and reports malformed fields actionably', () => {
  const valid = createWorkSpec({
    objective: 'Introduce the compatibility schema',
    scopeClaim: ['bin/lib/**'],
    acceptanceCriteria: [],
    verifyRecipe: { exception: 'manual-only', reason: 'No deterministic command exists' },
    budget: { wallTimeSeconds: 300, maxRounds: 1, maxOutputTokens: 2000 },
    base: { revision: 'abc123', dirtyHashes: {} }
  });
  assert.equal(valid.schemaVersion, WORK_SCHEMA_VERSION);
  assert.equal(validateWorkSpec(valid), true);
  assert.throws(
    () => createWorkSpec({
      objective: '',
      scopeClaim: [],
      acceptanceCriteria: [''],
      verifyRecipe: { command: '', timeoutSeconds: 0 },
      budget: { wallTimeSeconds: 0, maxRounds: -1, maxOutputTokens: null },
      base: { revision: '', dirtyHashes: [] }
    }),
    (error) => {
      assert.match(error.message, /objective must be a non-empty string/);
      assert.match(error.message, /scopeClaim/);
      assert.match(error.message, /verifyRecipe\.command/);
      assert.match(error.message, /budget\.wallTimeSeconds/);
      assert.match(error.message, /base\.revision/);
      return true;
    }
  );
});

test('future WorkItem fields and schema versions survive write-read-update round trips', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-work-store-'));
  try {
    withState(directory, () => {
      const original = {
        schemaVersion: WORK_SCHEMA_VERSION + 1,
        id: 'work-future',
        spec: { schemaVersion: WORK_SCHEMA_VERSION + 1, objective: 'future', futureSpecField: { enabled: true } },
        futureTopLevel: ['preserve-me']
      };
      writeWorkItem(original);
      assert.deepEqual(readWorkItem(original.id), original);
      updateWorkItem(original.id, (current) => {
        current.timestamps = { updatedAt: 123 };
      });
      const updated = readWorkItem(original.id);
      assert.deepEqual(updated.futureTopLevel, ['preserve-me']);
      assert.deepEqual(updated.spec.futureSpecField, { enabled: true });
      assert.equal(updated.schemaVersion, WORK_SCHEMA_VERSION + 1);
      assert.equal(updated.timestamps.updatedAt, 123);
      assert.equal(fs.statSync(workDir()).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(workDir(), 'work-future.json')).mode & 0o777, 0o600);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI and MCP work surfaces return projections without changing the store', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-work-surface-'));
  const stateFile = path.join(directory, 'usage.json');
  const env = {
    ...process.env,
    DELEGATE_STATE_FILE: stateFile,
    DELEGATE_ENABLED_PROVIDERS: 'codex,cursor'
  };
  try {
    withState(directory, () => {
      saveJob({
        schemaVersion: 2,
        id: 'codex-surface-root',
        provider: 'codex',
        model: 'sol',
        mode: 'implement',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
        allowedPaths: ['bin/lib/**']
      });
      saveJob({
        schemaVersion: 2,
        id: 'codex-surface-child',
        parentJobId: 'codex-surface-root',
        provider: 'codex',
        model: 'sol',
        mode: 'review',
        status: 'completed',
        createdAt: 3,
        updatedAt: 4
      });
      fs.writeFileSync(path.join(directory, 'jobs', '.last-prune'), `${Date.now()}\n`, { mode: 0o600 });
    });
    const before = fileSnapshot(directory);
    const cli = spawnSync(process.execPath, [
      jobsCli,
      'work',
      '--id',
      'codex-surface-child',
      '--json'
    ], { env, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const cliResult = JSON.parse(cli.stdout);
    assert.equal(cliResult.workItems.length, 1);
    assert.equal(cliResult.workItems[0].id, 'work-codex-surface-root');
    assert.equal(cliResult.workItems[0].runs.length, 2);
    assert.deepEqual(fileSnapshot(directory), before);

    const mcpResult = await mcpWork(env, { id: 'work-codex-surface-root', limit: 1 });
    assert.deepEqual(mcpResult, cliResult);
    assert.deepEqual(fileSnapshot(directory), before);
    assert.equal(fs.existsSync(path.join(directory, 'work')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
