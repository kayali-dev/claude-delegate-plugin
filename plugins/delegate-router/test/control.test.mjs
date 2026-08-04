import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { brokerError, normalizeBrokerError } from '../bin/lib/errors.mjs';
import { eventBlocks, wrapEventBlock } from '../bin/lib/tui/events.mjs';
import {
  appendJobEvent,
  createManagedJob,
  hashWorkingFile,
  inspectJob,
  inspectJobSummary,
  jobDiff,
  jobFiles,
  jobTranscript,
  jobTranscriptPage,
  jobUsage,
  launchManagedJob,
  launchManagedJobForCaller,
  listManagedJobs,
  pruneJobs,
  readJobEventPage,
  readJobEvents,
  redact,
  revertManagedJob,
  reviewRoundManagedJob,
  resumeManagedJob,
  submitControl,
  updateManagedJob
} from '../bin/lib/control.mjs';
import { filterDiffPaths, pathMatchesScope, validatedAllowedPaths } from '../bin/lib/control.mjs';
import { auditLogPath, loadJob, loadState, saveJob, saveState, setWindow } from '../bin/lib/state.mjs';

const jobsCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'delegate-jobs');
const controlMcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'delegate-control-mcp');

async function isolated(fn) {
  const previous = process.env.DELEGATE_STATE_FILE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-control-test-'));
  process.env.DELEGATE_STATE_FILE = path.join(directory, 'usage.json');
  try { return await fn(directory); }
  finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
  }
}

function brokerPackageVersion() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

test('managed jobs persist ordered redacted events and derived views', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', model: 'sol', mode: 'review', cwd: directory, prompt: 'review public code' });
  appendJobEvent(job.id, 'file.changed', { changes: [{ path: 'src/a.js', token: 'secret-value' }] });
  appendJobEvent(job.id, 'diff.updated', { diff: 'diff --git a/src/a.js b/src/a.js' });
  const events = readJobEvents(job.id);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
  assert.ok(!JSON.stringify(events).includes('sk-12345678901234567890'));
  assert.equal(jobFiles(job.id)[0].path, 'src/a.js');
  assert.match(jobDiff(job.id), /diff --git/);
  assert.equal(jobTranscript(job.id)[0].type, 'message.user');
  const eventFile = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  assert.equal(fs.statSync(eventFile).mode & 0o777, 0o600);
}));

test('delegate-jobs status keeps requested model display honest and strips empty attributes', () => isolated((directory) => {
  const auto = createManagedJob({ provider: 'cursor', model: 'auto', mode: 'review', cwd: directory, prompt: 'review' });
  updateManagedJob(auto.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
    current.model = 'auto';
    current.resolvedModel = 'default[]';
  });
  const autoStatus = spawnSync(process.execPath, [jobsCli, 'status', auto.id], { env: process.env, encoding: 'utf8' });
  assert.equal(autoStatus.status, 0, autoStatus.stderr);
  assert.match(autoStatus.stdout, /\sauto\s*$/m);
  assert.doesNotMatch(autoStatus.stdout, /default\[\]/);

  const explicitId = 'grok-4.5[effort=high,fast=true]';
  const explicit = createManagedJob({ provider: 'cursor', model: explicitId, mode: 'review', cwd: directory, prompt: 'review' });
  updateManagedJob(explicit.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
    current.resolvedModel = explicitId;
  });
  const explicitStatus = spawnSync(process.execPath, [jobsCli, 'status', explicit.id], { env: process.env, encoding: 'utf8' });
  assert.equal(explicitStatus.status, 0, explicitStatus.stderr);
  assert.equal(explicitStatus.stdout.trim().endsWith(explicitId), true);
}));

test('outbound prompt scan blocks credentials unless allowSensitive explicitly overrides', () => isolated((directory) => {
  try {
    createManagedJob({ provider: 'codex', cwd: directory, prompt: 'use token sk-12345678901234567890' });
    assert.fail('expected SECRET_IN_PROMPT');
  } catch (error) {
    assert.equal(error.code, 'SECRET_IN_PROMPT');
    assert.equal(error.retryable, false);
    assert.equal(error.provider, 'codex');
  }
  const allowed = createManagedJob({
    provider: 'codex',
    cwd: directory,
    prompt: 'use token sk-12345678901234567890',
    allowSensitive: true
  });
  const events = readJobEvents(allowed.id);
  assert.ok(events.some((event) => event.type === 'security.warning' && event.data.code === 'SECRET_IN_PROMPT'));
  assert.doesNotMatch(JSON.stringify(events), /sk-12345678901234567890/);
}));

test('idempotency replays return the same job id without launching another record', () => isolated((directory) => {
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const options = {
      provider: 'codex',
      mode: 'implement',
      cwd: directory,
      prompt: 'implement once',
      idempotencyKey: 'coordinator-wave-1'
    };
    const first = launchManagedJob(options);
    const replay = launchManagedJob(options);
    assert.equal(replay.id, first.id);
    assert.equal(replay.idempotencyKey, options.idempotencyKey);
    assert.equal(listManagedJobs().jobs.filter((job) => job.cwd === directory).length, 1);
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
}));

test('control commands use revisions and stable ids for exactly-once acceptance', () => isolated((directory) => {
  const created = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const current = inspectJob(created.id);
  const first = submitControl(created.id, { type: 'steer', correctionId: 'same-correction', text: 'use another API' }, current.revision);
  assert.equal(first.accepted, true);
  const duplicate = submitControl(created.id, { type: 'steer', correctionId: 'same-correction', text: 'use another API' }, current.revision);
  assert.equal(duplicate.duplicate, true);
  assert.throws(
    () => submitControl(created.id, { type: 'cancel', commandId: 'competing-command' }, current.revision),
    /REVISION_CONFLICT/
  );
  assert.equal(inspectJob(created.id).revision, current.revision + 1);
}));

test('event pagination resumes without duplicates and ignores a truncated tail', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'plan.updated', { plan: ['one'] });
  appendJobEvent(job.id, 'plan.updated', { plan: ['two'] });
  const first = readJobEvents(job.id, { limit: 2 });
  const second = readJobEvents(job.id, { afterSeq: first.at(-1).seq, limit: 10 });
  assert.deepEqual([...first, ...second].map((event) => event.seq), [1, 2, 3, 4]);
  fs.appendFileSync(path.join(directory, 'jobs', `${job.id}.events.jsonl`), '{"truncated":');
  assert.equal(readJobEvents(job.id).length, 4);
  appendJobEvent(job.id, 'plan.updated', { plan: ['recovered'] });
  assert.deepEqual(readJobEvents(job.id).map((event) => event.seq), [1, 2, 3, 4, 5]);
}));

test('inspect leaves a partial journal tail byte-for-byte unchanged', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const file = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  const expectedAt = readJobEvents(job.id).at(-1).at;
  fs.appendFileSync(file, '{"truncated":');
  const before = fs.readFileSync(file);
  const beforeSize = fs.statSync(file).size;
  assert.equal(inspectJob(job.id).lastActivityAt, expectedAt);
  assert.equal(fs.statSync(file).size, beforeSize);
  assert.deepEqual(fs.readFileSync(file), before);
}));

test('large diffs spill to private artifacts and remain fully inspectable', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const diff = `diff --git a/large b/large\n${'x'.repeat(70000)}`;
  const event = appendJobEvent(job.id, 'diff.updated', { diff });
  assert.equal(event.data.diff, undefined);
  assert.equal(fs.statSync(event.data.artifactPath).mode & 0o777, 0o600);
  assert.equal(jobDiff(job.id), diff);
}));

test('managed starts enforce provider allowance before spawning a worker', () => isolated((directory) => {
  const state = loadState();
  setWindow(state, 'cursor', 'primary', 95, { source: 'test' });
  saveState(state);
  assert.throws(() => launchManagedJob({ provider: 'cursor', cwd: directory, prompt: 'task' }), /QUOTA_GUARD/);
}));

test('redaction preserves numeric usage while hiding numeric and boolean secrets', () => {
  assert.deepEqual(redact({ inputTokens: 12, total_token_count: 20, password: 123456, token: 987654, secret: true }), {
    inputTokens: 12,
    total_token_count: 20,
    password: '[REDACTED]',
    token: '[REDACTED]',
    secret: '[REDACTED]'
  });
  const text = redact({ text: 'password=hunter2 AWS_SECRET_ACCESS_KEY=abcdef "apiKey":"value123" postgres://user:pass@db.local/app' }).text;
  assert.doesNotMatch(text, /hunter2|abcdef|value123|user:pass/);
});

// Every usage field name contains "token", so each one is presumed sensitive and
// must be rescued by name. A field the allow-list has never heard of is written
// to the journal as [REDACTED] — which is how the Claude transcript ingestor's
// cache counters were lost in a live run while every unit test stayed green,
// because the tests asserted on the normalizer's output and redaction happens
// one seam later.
test('usage counters from every ingestion path survive redaction, credential-shaped tokens do not', () => {
  const usage = redact({
    inputTokens: 4,
    outputTokens: 532,
    totalTokens: 536,
    cachedInputTokens: 11,
    cacheReadInputTokens: 1_625_967,
    cacheCreationInputTokens: 103_453,
    reasoningOutputTokens: 20_460,
    maxOutputTokens: 8_192,
    tokenCount: 7
  });
  assert.deepEqual(usage, {
    inputTokens: 4,
    outputTokens: 532,
    totalTokens: 536,
    cachedInputTokens: 11,
    cacheReadInputTokens: 1_625_967,
    cacheCreationInputTokens: 103_453,
    reasoningOutputTokens: 20_460,
    maxOutputTokens: 8_192,
    tokenCount: 7
  });
  // Rescuing usage names must not open a door: credential-shaped keys stay
  // redacted, and a string under an allow-listed usage key is still redacted,
  // so the rescue cannot be used to smuggle one through.
  assert.deepEqual(redact({
    authToken: 1234,
    apiToken: 'abc',
    refreshToken: 'r',
    accessToken: 'a',
    sessionToken: 's',
    cacheReadInputTokens: 'sk-live-not-a-number'
  }), {
    authToken: '[REDACTED]',
    apiToken: '[REDACTED]',
    refreshToken: '[REDACTED]',
    accessToken: '[REDACTED]',
    sessionToken: '[REDACTED]',
    cacheReadInputTokens: '[REDACTED]'
  });
});

test('compound provider usage counters survive journaling and Events rendering while credential tokens stay redacted', () => isolated((directory) => {
  const codexUsage = {
    total: {
      inputTokens: 120,
      cachedInputTokens: 80,
      reasoningOutputTokens: 14,
      outputTokens: 30,
      totalTokens: 150
    },
    last: {
      inputTokens: 20,
      cachedInputTokensCount: 10,
      reasoningOutputTokens: 4,
      outputTokens: 6
    },
    maxOutputTokens: 500
  };
  const cursorUsage = {
    sessionUpdate: 'usage_update',
    used: 12,
    size: 1000,
    tokenUsage: { inputTokens: 5, outputTokens: 2 }
  };
  const secrets = {
    authToken: 'auth-secret',
    refreshToken: 'refresh-secret',
    apiToken: 'api-secret',
    accessToken: 'access-secret',
    idToken: 'id-secret'
  };

  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'inspect usage' });
  appendJobEvent(job.id, 'usage.updated', { ...codexUsage, ...secrets });
  appendJobEvent(job.id, 'usage.updated', cursorUsage);
  const usageEvents = readJobEvents(job.id).filter((event) => event.type === 'usage.updated');

  assert.deepEqual(usageEvents[0].data.total, codexUsage.total);
  assert.deepEqual(usageEvents[0].data.last, codexUsage.last);
  assert.equal(usageEvents[0].data.maxOutputTokens, 500);
  for (const key of Object.keys(secrets)) assert.equal(usageEvents[0].data[key], '[REDACTED]', key);
  assert.deepEqual(usageEvents[1].data, cursorUsage);

  const blocks = eventBlocks(usageEvents);
  const rendered = blocks.map((block) => wrapEventBlock(block, 120, '', {
    now: usageEvents.at(-1).at,
    timestampMode: 'relative',
    expandedEvents: new Set([block.key])
  }).lines.join('\n')).join('\n');
  assert.match(rendered, /cachedInputTokens/);
  assert.match(rendered, /reasoningOutputTokens/);
  assert.match(rendered, /tokenUsage/);
  assert.match(rendered, /usage_update/);
  assert.doesNotMatch(rendered, /auth-secret|refresh-secret|api-secret|access-secret|id-secret/);
}));

test('usage-shaped token objects recurse but non-usage token keys never receive the exemption', () => {
  assert.deepEqual(redact({
    tokenUsage: {
      cachedInputTokens: 9,
      reasoningOutputTokens: 3,
      authToken: 'nested-auth-secret'
    }
  }), {
    tokenUsage: {
      cachedInputTokens: 9,
      reasoningOutputTokens: 3,
      authToken: '[REDACTED]'
    }
  });
  for (const key of ['authToken', 'refreshToken', 'apiToken', 'accessToken', 'idToken']) {
    assert.equal(redact({ [key]: 12345 })[key], '[REDACTED]', key);
    assert.equal(redact({ [key]: { inputTokens: 12 } })[key], '[REDACTED]', `${key} object`);
  }
});

test('broker error taxonomy carries closed codes, retryability, and provider attribution', () => {
  const invalid = brokerError('INVALID_MODEL', 'missing model', { provider: 'cursor' });
  assert.deepEqual({ code: invalid.code, retryable: invalid.retryable, provider: invalid.provider }, {
    code: 'INVALID_MODEL', retryable: false, provider: 'cursor'
  });
  const transport = normalizeBrokerError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), { provider: 'codex' });
  assert.deepEqual({ code: transport.code, retryable: transport.retryable, provider: transport.provider }, {
    code: 'TRANSPORT_ERROR', retryable: true, provider: 'codex'
  });
  for (const code of ['USER_INPUT_REQUIRED', 'BUDGET_EXCEEDED', 'QUOTA_GUARD', 'ACP_TIER_UNAVAILABLE']) {
    assert.equal(brokerError(code, 'same request cannot succeed').retryable, false, code);
  }
});

test('filtered event pages advance across nonmatches without skipping later matches', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'plan.updated', { plan: [] });
  const first = readJobEventPage(job.id, { afterSeq: 0, types: ['error'] });
  assert.equal(first.events.length, 0);
  assert.equal(first.nextSeq, 3);
  appendJobEvent(job.id, 'error', { message: 'failure' });
  const second = readJobEventPage(job.id, { afterSeq: first.nextSeq, types: ['error'] });
  assert.equal(second.events[0].type, 'error');
}));

test('resume rejects an active parent session', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => { current.providerSessionId = 'thread-active'; current.status = 'running'; current.workerPid = process.pid; });
  assert.throws(() => resumeManagedJob(job.id, { prompt: 'continue' }), /PARENT_ACTIVE/);
}));

test('launch origin comes from the coordinator project and continuation rounds never overwrite it', () => isolated((directory) => {
  const projectA = path.join(directory, 'project-a');
  const projectB = path.join(directory, 'project-b');
  const delegatedCwd = path.join(directory, 'delegated-target');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  fs.mkdirSync(delegatedCwd);
  const previous = {
    project: process.env.CLAUDE_PROJECT_DIR,
    session: process.env.CLAUDE_CODE_SESSION_ID,
    supervisor: process.env.DELEGATE_SUPERVISOR,
    codex: process.env.DELEGATE_CODEX_BIN
  };
  process.env.CLAUDE_PROJECT_DIR = projectA;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.DELEGATE_SUPERVISOR = '0';
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const cliLaunch = createManagedJob({
      provider: 'codex',
      mode: 'review',
      cwd: delegatedCwd,
      prompt: 'outside-session cli launch'
    });
    assert.equal(cliLaunch.origin.sessionId, null);
    assert.equal(cliLaunch.origin.workspaceId, fs.realpathSync(projectA));

    process.env.CLAUDE_CODE_SESSION_ID = 'coordinator-session-a';
    const resumeParent = createManagedJob({
      provider: 'codex',
      mode: 'review',
      cwd: delegatedCwd,
      prompt: 'parent'
    });
    assert.equal(resumeParent.origin.projectDir, fs.realpathSync(projectA));
    assert.notEqual(resumeParent.origin.projectDir, resumeParent.cwd);
    assert.equal(resumeParent.origin.cwd, fs.realpathSync(process.cwd()));
    assert.equal(resumeParent.origin.sessionId, 'coordinator-session-a');
    assert.equal(resumeParent.origin.workspaceId, fs.realpathSync(projectA));
    assert.equal(resumeParent.origin.brokerVersion, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.ok(Number.isFinite(resumeParent.origin.launchedAtMs));
    updateManagedJob(resumeParent.id, (job) => {
      job.status = 'completed';
      job.phase = 'completed';
      job.providerSessionId = 'origin-resume-thread';
    });

    process.env.CLAUDE_PROJECT_DIR = projectB;
    process.env.CLAUDE_CODE_SESSION_ID = 'coordinator-session-b';
    const resumed = resumeManagedJob(resumeParent.id, { prompt: 'continue' });
    assert.deepEqual(resumed.origin, resumeParent.origin);

    const reviewParent = createManagedJob({
      provider: 'codex',
      mode: 'review',
      cwd: delegatedCwd,
      prompt: 'review parent',
      origin: resumeParent.origin
    });
    updateManagedJob(reviewParent.id, (job) => {
      job.status = 'completed';
      job.phase = 'completed';
      job.providerSessionId = 'origin-review-thread';
    });
    const reviewed = reviewRoundManagedJob(reviewParent.id, { prompt: 'Address the finding.' });
    assert.deepEqual(reviewed.origin, resumeParent.origin);
  } finally {
    if (previous.project == null) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous.project;
    if (previous.session == null) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous.session;
    if (previous.supervisor == null) delete process.env.DELEGATE_SUPERVISOR;
    else process.env.DELEGATE_SUPERVISOR = previous.supervisor;
    if (previous.codex == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous.codex;
  }
}));

test('monitor scope never gates cross-session control operations', () => isolated((directory) => {
  const previous = {
    scope: process.env.DELEGATE_MONITOR_SCOPE,
    session: process.env.CLAUDE_CODE_SESSION_ID
  };
  process.env.DELEGATE_MONITOR_SCOPE = 'session';
  process.env.CLAUDE_CODE_SESSION_ID = 'coordinator-session-a';
  try {
    const workspaceId = fs.realpathSync(directory);
    const otherSession = createManagedJob({
      provider: 'codex',
      mode: 'review',
      cwd: directory,
      prompt: 'cross-session managed work',
      origin: {
        projectDir: workspaceId,
        cwd: workspaceId,
        sessionId: 'coordinator-session-b',
        workspaceId,
        brokerVersion: '0.34.0',
        launchedAtMs: Date.now()
      }
    });
    const running = updateManagedJob(otherSession.id, (job) => {
      job.status = 'running';
      job.phase = 'running';
      job.workerPid = process.pid;
    });
    const controlled = submitControl(otherSession.id, {
      type: 'cancel',
      commandId: 'cross-session-cancel'
    }, running.revision);
    assert.equal(controlled.accepted, true);
    assert.equal(controlled.commandId, 'cross-session-cancel');
    assert.equal(inspectJob(otherSession.id).origin.sessionId, 'coordinator-session-b');
  } finally {
    if (previous.scope == null) delete process.env.DELEGATE_MONITOR_SCOPE;
    else process.env.DELEGATE_MONITOR_SCOPE = previous.scope;
    if (previous.session == null) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous.session;
  }
}));

test('inspect reconciles orphaned running jobs to failed with an audit event', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => { current.status = 'running'; current.phase = 'running'; current.workerPid = 999999999; });
  const reconciled = inspectJob(job.id);
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.error, /ORPHANED/);
  assert.ok(readJobEvents(job.id).some((event) => event.type === 'error' && event.data.code === 'ORPHANED'));
  assert.equal(inspectJob(job.id).status, 'failed');
}));

test('inspect and list expose journal-tail activity and flag stalled running jobs', () => isolated((directory) => {
  const previous = process.env.DELEGATE_STALL_SECONDS;
  process.env.DELEGATE_STALL_SECONDS = '1';
  try {
    const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
    updateManagedJob(job.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
    const file = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
    const oldAt = Date.now() - 5000;
    const oldEvents = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => ({ ...JSON.parse(line), at: oldAt }));
    fs.writeFileSync(file, `${oldEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const stalled = inspectJob(job.id);
    assert.equal(stalled.lastActivityAt, oldAt);
    assert.equal(stalled.stalled, true);
    assert.equal(listManagedJobs().jobs.find((row) => row.id === job.id).stalled, true);
    const fresh = appendJobEvent(job.id, 'plan.updated', { plan: ['continue'] });
    const active = inspectJob(job.id);
    assert.equal(active.lastActivityAt, fresh.at);
    assert.equal(active.stalled, false);
  } finally {
    if (previous == null) delete process.env.DELEGATE_STALL_SECONDS;
    else process.env.DELEGATE_STALL_SECONDS = previous;
  }
}));

test('write-mode launches are blocked while another writer is active in the same cwd', () => isolated((directory) => {
  const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'first writer' });
  updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
  try {
    launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'second writer' });
    assert.fail('expected WRITER_ACTIVE');
  } catch (error) {
    assert.equal(error.code, 'WRITER_ACTIVE');
    assert.equal(error.retryable, true);
    assert.equal(error.provider, 'codex');
    assert.equal(error.activeJobId, writer.id);
  }
  assert.throws(() => launchManagedJob({ provider: 'codex', mode: 'verify', cwd: directory, prompt: 'verifier' }), /WRITER_ACTIVE/);
}));

test('writer guard honors an explicit overrideWriter bypass', () => isolated((directory) => {
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'writer' });
    updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = process.pid; });
    const bypassed = launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'override', overrideWriter: true });
    assert.equal(bypassed.mode, 'implement');
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
}));

test('writer guard releases once the previous writer is orphaned', () => isolated((directory) => {
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const writer = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'writer' });
    updateManagedJob(writer.id, (current) => { current.status = 'running'; current.workerPid = 999999999; });
    const next = launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'next writer' });
    assert.equal(next.mode, 'implement');
    assert.equal(inspectJob(writer.id).status, 'failed');
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
}));

test('revision conflicts carry the current revision for one-step retry', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const revision = inspectJob(job.id).revision;
  submitControl(job.id, { type: 'steer', correctionId: 'first', text: 'adjust' }, revision);
  try {
    submitControl(job.id, { type: 'cancel', commandId: 'second' }, revision);
    assert.fail('expected REVISION_CONFLICT');
  } catch (error) {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.retryable, true);
    assert.equal(error.provider, 'codex');
    assert.equal(error.currentRevision, revision + 1);
  }
}));

test('transcript pages omit deltas by default and paginate with nextSeq', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'message.delta', { id: 'm', delta: 'He' });
  appendJobEvent(job.id, 'message.delta', { id: 'm', delta: 'llo' });
  appendJobEvent(job.id, 'message.completed', { id: 'm', text: 'Hello' });
  const page = jobTranscriptPage(job.id);
  assert.deepEqual(page.events.map((event) => event.type), ['message.user', 'message.completed']);
  assert.equal(page.hasMore, false);
  const verbose = jobTranscriptPage(job.id, { verbose: true });
  assert.equal(verbose.events.filter((event) => event.type === 'message.delta').length, 2);
  const first = jobTranscriptPage(job.id, { limit: 1 });
  assert.equal(first.events.length, 1);
  const second = jobTranscriptPage(job.id, { afterSeq: first.nextSeq });
  assert.equal(second.events.at(-1).type, 'message.completed');
  assert.equal(jobTranscript(job.id).filter((event) => event.type === 'message.delta').length, 2);
}));

test('delegate transcript pages admit first-class context-compaction marker events', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'compaction.started', { itemId: 'compact-1' });
  appendJobEvent(job.id, 'compaction.completed', { itemId: 'compact-1' });
  appendJobEvent(job.id, 'provider.event', { providerEvent: 'item/completed', itemType: 'contextCompaction', itemId: 'compact-1' });
  const types = jobTranscriptPage(job.id).events.map((event) => event.type);
  assert.deepEqual(types, ['message.user', 'compaction.started', 'compaction.completed']);
}));

test('delegate transcript admits provider items and plain-text first-class subagent lifecycle lines', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  appendJobEvent(job.id, 'subagent.started', {
    id: 'agent-1', correlationId: 'agent-1', type: 'reviewer', task: 'Inspect parser', status: 'running'
  });
  appendJobEvent(job.id, 'subagent.progress', {
    id: 'agent-1', correlationId: 'agent-1', type: 'reviewer', task: 'Inspect parser', status: 'interacted'
  });
  appendJobEvent(job.id, 'subagent.completed', {
    id: 'agent-1', correlationId: 'agent-1', type: 'reviewer', task: 'Inspect parser',
    status: 'completed', durationMs: 1250, output: 'full findings'
  });
  appendJobEvent(job.id, 'provider.item', {
    itemType: 'futureWidget', itemId: 'future-1', phase: 'completed', payloadCaptured: true,
    item: { type: 'futureWidget', id: 'future-1', answer: 42 },
    text: 'futureWidget completed: answer=42'
  });
  const events = jobTranscriptPage(job.id).events;
  assert.deepEqual(events.map((event) => event.type), [
    'message.user', 'subagent.started', 'subagent.progress', 'subagent.completed', 'provider.item'
  ]);
  assert.match(events.find((event) => event.type === 'subagent.started').data.text, /^Codex agent running: Inspect parser$/);
  assert.match(events.find((event) => event.type === 'subagent.completed').data.text, /^Codex agent completed \(1250ms\): Inspect parser$/);
  assert.equal(events.at(-1).data.text, 'futureWidget completed: answer=42');
}));

test('delegate transcript retroactively normalizes Codex and Cursor file changes into compact counted lines', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const journal = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  const start = loadJob(job.id).lastSeq;
  const legacy = [
    {
      v: 1, seq: start + 1, at: Date.now(), jobId: job.id, provider: 'codex', type: 'file.changed', redacted: true,
      data: { changes: [
        { path: path.join(directory, 'src/a.js'), kind: 'update', diff: '--- a/src/a.js\n+++ b/src/a.js\n-old\n+new\n+extra\n' },
        { path: path.join(directory, 'src/no-count.js'), kind: 'update' },
        { path: path.join(directory, 'src/old.js'), newPath: path.join(directory, 'src/new.js'), kind: 'rename', diff: '--- a/src/old.js\n+++ b/src/new.js\n-before\n+after\n' },
        { path: path.join(directory, 'src/gone.js'), kind: 'delete', diff: '--- a/src/gone.js\n+++ /dev/null\n-one\n-two\n' }
      ] }
    },
    {
      v: 1, seq: start + 2, at: Date.now(), jobId: job.id, provider: 'cursor', type: 'file.changed', redacted: true,
      data: { changes: [{ path: path.join(directory, 'src/cursor.js'), oldText: 'same\nold\n', newText: 'same\nnew\nextra\n', kind: 'edit' }] }
    }
  ];
  fs.appendFileSync(journal, `${legacy.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const page = jobTranscriptPage(job.id);
  const changes = page.events.filter((event) => event.type === 'file.changed');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.flatMap((event) => event.data.text.split('\n')), [
    '✎ src/a.js (+2 −1)',
    '✎ src/no-count.js',
    '✎ src/old.js renamed → src/new.js (+1 −1)',
    '✎ src/gone.js deleted (+0 −2)',
    '✎ src/cursor.js (+2 −1)'
  ]);
  const serialized = JSON.stringify(changes);
  assert.doesNotMatch(serialized, /\[object Object\]|NaN|oldText|newText|\"diff\"/);
  assert.equal(changes[0].data.changes[1].added, undefined, 'diff-less legacy changes do not invent zero counts');
  const full = readJobEvents(job.id).filter((event) => event.type === 'file.changed');
  assert.deepEqual(full[0].data.changes.map(({ added, removed }) => [added, removed]), [[2, 1], [undefined, undefined], [1, 1], [0, 2]]);
  assert.deepEqual(full[1].data.changes.map(({ added, removed }) => [added, removed]), [[2, 1]]);
}));

test('prune removes aged terminal jobs and preserves active ones', () => isolated((directory) => {
  const done = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'old' });
  updateManagedJob(done.id, (current) => { current.status = 'completed'; current.completedAt = Math.floor(Date.now() / 1000) - 30 * 86400; });
  const active = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'active' });
  const result = pruneJobs({ maxAgeDays: 14 });
  assert.deepEqual(result.pruned, [done.id]);
  assert.throws(() => inspectJob(done.id), /job not found/);
  assert.equal(inspectJob(active.id).status, 'queued');
  assert.ok(!fs.existsSync(path.join(directory, 'jobs', `${done.id}.events.jsonl`)));
  assert.ok(!fs.existsSync(path.join(directory, 'jobs', `${done.id}.prompt`)));
}));

test('prune reconciles stale queued debris before applying terminal retention', () => isolated((directory) => {
  const stale = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'abandoned queue record' });
  const old = Math.floor(Date.now() / 1000) - 30 * 86400;
  const record = loadJob(stale.id);
  record.createdAt = old;
  record.updatedAt = old;
  saveJob(record);

  const reconciled = pruneJobs({ maxAgeDays: 14 });
  assert.deepEqual(reconciled.pruned, []);
  assert.equal(loadJob(stale.id).status, 'failed');
  assert.equal(loadJob(stale.id).errorCode, 'ORPHANED');

  const agedTerminal = loadJob(stale.id);
  agedTerminal.completedAt = old;
  agedTerminal.updatedAt = old;
  saveJob(agedTerminal);
  const pruned = pruneJobs({ maxAgeDays: 14 });
  assert.deepEqual(pruned.pruned, [stale.id]);
  assert.equal(loadJob(stale.id), null);
}));

test('terminal audit log is one-line-per-transition, redacted, private, and never pruned', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => {
    current.status = 'failed';
    current.phase = 'failed';
    current.completedAt = Math.floor(Date.now() / 1000) - 30 * 86400;
    current.error = 'PASSWORD=synthetic-audit-secret';
    current.errorCode = 'PROVIDER_ERROR';
    current.changedFiles = { count: 2, files: ['a.js', 'b.js'] };
    current.scopeViolations = [{ path: 'b.js' }];
    current.usage = { inputTokens: 5, outputTokens: 3 };
  });
  updateManagedJob(job.id, (current) => { current.phase = 'failed'; });
  const file = auditLogPath();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.jobId, job.id);
  assert.equal(record.provider, 'codex');
  assert.equal(record.changedFilesCount, 2);
  assert.equal(record.changedFilesCountIsLowerBound, true);
  assert.equal(record.scopeViolationsCount, 1);
  assert.equal(record.outcome.status, 'failed');
  assert.equal(record.recordType, 'terminal');
  assert.equal(record.outcomeLedgerSchemaVersion, 1);
  // Read the live version: pinning a literal turns every release into a failure
  // (fourth occurrence of this class today — see v0.30.0 and v0.36.0).
  assert.equal(record.brokerVersion, brokerPackageVersion());
  assert.equal(record.adapterId, 'app-server');
  assert.equal(record.adapterVersion, brokerPackageVersion());
  assert.equal(record.providerCliVersion, null);
  assert.equal(record.providerCliVersionSource, 'pending');
  assert.equal(record.policyVersion, 1);
  assert.equal(record.eventSchemaVersion, 1);
  assert.equal(record.taskShape.mode, 'implement');
  assert.equal(record.taskShape.access, 'write');
  assert.equal(record.packetFeatures.canonicalSections.Objective, false);
  assert.equal(record.providerCompletion.completed, false);
  assert.equal(record.verificationOutcome.labelAvailable, false);
  assert.deepEqual(record.findings, { total: 0, open: 0, resolved: 0, truncated: false, items: [] });
  assert.equal(record.acceptanceDecision.decision, null);
  assert.equal(record.rejectionReason, null);
  assert.doesNotMatch(lines[0], /synthetic-audit-secret/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  pruneJobs({ maxAgeDays: 14 });
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
}));

test('timeoutSeconds is validated, stored, and inherited by resume', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 7200, maxOutputTokens: 5000 });
  assert.equal(inspectJob(job.id).timeoutSeconds, 7200);
  assert.equal(inspectJob(job.id).maxOutputTokens, 5000);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 5 }), /timeoutSeconds/);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', timeoutSeconds: 1.5 }), /timeoutSeconds/);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.equal(inspectJob(job.id).timeoutSeconds, 7200);
}));

test('retryPolicy and verify options validate, persist, and default safely', () => isolated((directory) => {
  const configured = createManagedJob({
    provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task',
    retryPolicy: { maxAttempts: 3, retryOn: ['transport', 'rate-limit'] },
    verify: { command: 'node --version' }
  });
  const record = inspectJob(configured.id);
  assert.deepEqual(record.retryPolicy, { maxAttempts: 3, retryOn: ['transport', 'rate-limit'] });
  assert.equal(record.retries, 0);
  assert.deepEqual(record.verify, { command: 'node --version', timeoutSeconds: 600 });
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', retryPolicy: { maxAttempts: 6, retryOn: ['transport'] } }), /maxAttempts/);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', retryPolicy: { maxAttempts: 2, retryOn: ['budget'] } }), /retryOn/);
  assert.throws(() => createManagedJob({ provider: 'codex', mode: 'review', cwd: directory, prompt: 'task', verify: { command: 'true' } }), /write modes/);
}));

test('write jobs launched from a dirty baseline emit baseline.dirty with bounded paths', () => isolated((directory) => {
  spawnSync('git', ['init', '-q'], { cwd: directory });
  fs.writeFileSync(path.join(directory, 'local.txt'), 'pre-existing local work\n');
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task' });
  const warning = readJobEvents(job.id).find((event) => event.type === 'baseline.dirty');
  assert.equal(warning.data.count, 1);
  assert.deepEqual(warning.data.paths, ['local.txt']);
}));

test('inspect exposes shared resumability and driftReport derivations', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task', allowedPaths: ['src'] });
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.providerSessionId = 'thread-drift';
    current.baselineFiles = ['src/existing.js'];
    current.changedFiles = {
      count: 3,
      files: ['src/existing.js', 'src/new.js', 'outside.js'],
      entries: [
        { path: 'src/existing.js', status: ' M' },
        { path: 'src/new.js', status: '??' },
        { path: 'outside.js', kind: 'create' }
      ]
    };
  });
  const inspected = inspectJob(job.id);
  assert.deepEqual(inspected.resumable, { ok: true, reason: 'the terminal job has a resumable provider session' });
  assert.deepEqual(inspected.driftReport, {
    modified: ['src/existing.js'],
    newFiles: ['src/new.js', 'outside.js'],
    outsideScope: ['outside.js']
  });
  updateManagedJob(job.id, (current) => { current.reviewFlowEngaged = true; });
  const blocked = inspectJob(job.id);
  assert.equal(blocked.resumable.ok, false);
  assert.match(blocked.resumable.reason, /multi-agent review flow/);
  assert.throws(() => resumeManagedJob(job.id, { prompt: 'continue' }), /RESUME_UNSUPPORTED/);
}));

test('delegate-jobs revert restores owned files, skips overlap, and dry-run touches nothing', () => isolated((directory) => {
  const git = (...args) => spawnSync('git', ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', ...args], { cwd: directory, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
  fs.writeFileSync(path.join(directory, 'deleted.txt'), 'restore me\n');
  fs.writeFileSync(path.join(directory, 'overlap.txt'), 'baseline\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  fs.appendFileSync(path.join(directory, 'overlap.txt'), 'user edit\n');
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task' });
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'job edit\n');
  fs.writeFileSync(path.join(directory, 'created.txt'), 'job file\n');
  fs.unlinkSync(path.join(directory, 'deleted.txt'));
  fs.appendFileSync(path.join(directory, 'overlap.txt'), 'job overlap\n');
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.changedFiles = {
      count: 4,
      files: ['tracked.txt', 'created.txt', 'deleted.txt', 'overlap.txt'],
      entries: [
        { path: 'tracked.txt', finalHash: hashWorkingFile(directory, 'tracked.txt') },
        { path: 'created.txt', status: '??', finalHash: hashWorkingFile(directory, 'created.txt') },
        { path: 'deleted.txt', kind: 'delete', finalHash: hashWorkingFile(directory, 'deleted.txt') },
        { path: 'overlap.txt', preexisting: true, overlapsPreexisting: true, finalHash: hashWorkingFile(directory, 'overlap.txt') }
      ]
    };
  });
  const before = {
    tracked: fs.readFileSync(path.join(directory, 'tracked.txt'), 'utf8'),
    created: fs.readFileSync(path.join(directory, 'created.txt'), 'utf8'),
    overlap: fs.readFileSync(path.join(directory, 'overlap.txt'), 'utf8')
  };
  const dry = revertManagedJob(job.id, { dryRun: true });
  assert.equal(dry.reverted.length, 3);
  assert.equal(dry.skipped.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'tracked.txt'), 'utf8'), before.tracked);
  assert.equal(fs.readFileSync(path.join(directory, 'created.txt'), 'utf8'), before.created);

  const cli = fileURLToPath(new URL('../bin/delegate-jobs', import.meta.url));
  const reverted = spawnSync(process.execPath, [cli, 'revert', job.id], {
    encoding: 'utf8', env: { ...process.env, DELEGATE_STATE_FILE: process.env.DELEGATE_STATE_FILE }
  });
  assert.equal(reverted.status, 0, reverted.stderr);
  const summary = JSON.parse(reverted.stdout);
  assert.equal(summary.reverted.length, 3);
  assert.equal(summary.skipped[0].path, 'overlap.txt');
  assert.equal(summary.conflicts.length, 0);
  assert.equal(fs.readFileSync(path.join(directory, 'tracked.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.existsSync(path.join(directory, 'created.txt')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'deleted.txt'), 'utf8'), 'restore me\n');
  assert.equal(fs.readFileSync(path.join(directory, 'overlap.txt'), 'utf8'), before.overlap);
}));

test('revert refuses a file edited after the job final hash was recorded', () => isolated((directory) => {
  const git = (...args) => spawnSync('git', ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', ...args], { cwd: directory });
  git('init', '-q');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task' });
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'job final\n');
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.changedFiles = { count: 1, files: ['tracked.txt'], entries: [{ path: 'tracked.txt', finalHash: hashWorkingFile(directory, 'tracked.txt') }] };
  });
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'later edit\n');
  const result = revertManagedJob(job.id);
  assert.equal(result.reverted.length, 0);
  assert.match(result.conflicts[0].reason, /changed after/);
  assert.equal(fs.readFileSync(path.join(directory, 'tracked.txt'), 'utf8'), 'later edit\n');
}));

test('list returns compact summaries newest first with active filtering', () => isolated((directory) => {
  const first = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'one' });
  const second = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'two' });
  updateManagedJob(first.id, (current) => {
    current.status = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.result = 'x'.repeat(500);
  });
  const all = listManagedJobs();
  assert.deepEqual(all.jobs.map((job) => job.id).sort(), [first.id, second.id].sort());
  assert.equal(all.jobs.find((job) => job.id === first.id).resultPreview.length, 200);
  assert.equal(Object.hasOwn(all.jobs[0], 'promptPath'), false);
  const active = listManagedJobs({ activeOnly: true });
  assert.deepEqual(active.jobs.map((job) => job.id), [second.id]);
  const failed = listManagedJobs({ status: ['completed'] });
  assert.deepEqual(failed.jobs.map((job) => job.id), [first.id]);
}));

test('inspect summary is materially smaller while retaining monitor-critical fields', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task' });
  const tail = 'verification output '.repeat(240);
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
    current.origin = { ...current.origin, sessionId: 'session-summary-size' };
    current.result = tail;
    current.resultText = tail;
    current.changedFiles = {
      count: 5,
      files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
      entries: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'].map((file) => ({ path: file, finalHash: 'a'.repeat(64) }))
    };
    current.verification = { state: 'passed', exitCode: 0, outputTail: tail, caveats: [] };
    current.verificationEvidence = [structuredClone(current.verification)];
    current.acceptance = {
      state: 'ready-for-review',
      evidence: { verification: structuredClone(current.verification), changes: structuredClone(current.changedFiles) }
    };
  });
  const full = inspectJob(job.id);
  const summary = inspectJobSummary(job.id);
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  assert.ok(summaryBytes < fullBytes / 10, `summary=${summaryBytes} full=${fullBytes}`);
  assert.deepEqual(summary, {
    id: job.id,
    status: 'completed',
    phase: 'completed',
    origin: { sessionId: 'session-summary-size' },
    pendingInput: null,
    attention: null,
    acceptance: { state: 'ready-for-review' },
    changedFiles: { count: 5 },
    verification: { state: 'passed' },
    conclusion: { disposition: 'completed', health: 'healthy', reason: null }
  });
}));

test('phase and blocked-on-input filters return exactly live human gates on library, CLI, and MCP surfaces', () => isolated((directory) => {
  const gated = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'gated' });
  const ordinary = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'ordinary' });
  const expired = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'expired' });
  const completed = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'completed' });
  updateManagedJob(gated.id, (current) => {
    current.status = 'running';
    current.phase = 'user-input-required';
    current.pid = process.pid;
    current.pendingInput = { requestId: 'gate-1', kind: 'plan-confirmation', requiresHumanDecision: true };
  });
  updateManagedJob(ordinary.id, (current) => {
    current.status = 'running';
    current.phase = 'running';
    current.pid = process.pid;
  });
  updateManagedJob(expired.id, (current) => {
    current.status = 'running';
    current.phase = 'input-timeout';
    current.pid = process.pid;
    current.pendingInput = { requestId: 'gate-expired', kind: 'question', timedOut: true, timedOutAt: 1234 };
    current.attention = null;
  });
  updateManagedJob(completed.id, (current) => {
    current.status = 'completed';
    current.phase = 'completed';
  });

  assert.deepEqual(listManagedJobs({ phase: ['user-input-required'] }).jobs.map((row) => row.id), [gated.id]);
  assert.deepEqual(listManagedJobs({ blockedOnInput: true }).jobs.map((row) => row.id), [gated.id]);
  const expiredRow = listManagedJobs({ phase: ['input-timeout'] }).jobs.find((row) => row.id === expired.id);
  assert.deepEqual(expiredRow.pendingInput, {
    requestId: 'gate-expired',
    kind: 'question',
    requiresHumanDecision: false,
    expiresAt: null,
    timedOut: true,
    timedOutAt: 1234
  });
  assert.equal(expiredRow.attention, null);
  const expiredRevision = inspectJob(expired.id).revision;
  assert.throws(() => submitControl(expired.id, {
    type: 'respond', requestId: 'gate-expired', answer: 'too late', commandId: 'expired-response'
  }, expiredRevision), (error) => error.code === 'INVALID_REQUEST' && /no live pending/.test(error.message));
  assert.equal(inspectJob(expired.id).controls?.['expired-response'], undefined);

  const cli = spawnSync(process.execPath, [jobsCli, 'list', '--blocked-on-input', '--json'], {
    env: process.env,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).map((row) => row.id), [gated.id]);
  const expiredCli = spawnSync(process.execPath, [jobsCli, 'list', '--phase', 'input-timeout', '--json'], {
    env: process.env,
    encoding: 'utf8'
  });
  assert.equal(expiredCli.status, 0, expiredCli.stderr);
  const expiredCliRow = JSON.parse(expiredCli.stdout).find((row) => row.id === expired.id);
  assert.equal(expiredCliRow.phase, 'input-timeout');
  assert.equal(expiredCliRow.pendingInput.timedOut, true);
  assert.equal(expiredCliRow.attention, null);

  const mcp = spawnSync(process.execPath, [controlMcp], {
    env: process.env,
    encoding: 'utf8',
    input: `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'delegate_list', arguments: { blockedOnInput: true } }
    })}\n`
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const result = JSON.parse(JSON.parse(mcp.stdout.trim()).result.content[0].text);
  assert.deepEqual(result.jobs.map((row) => row.id), [gated.id]);
}));

test('write launch scope warnings block by default with explicit scoped and unscoped escape hatches', () => isolated(async (directory) => {
  await assert.rejects(() => launchManagedJobForCaller({
    provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task', planFirst: false
  }), /write launch requires an Allowed scope section or explicit allowedPaths/);

  const scoped = await launchManagedJobForCaller({
    provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task',
    allowedPaths: ['src'], planFirst: false, dryRun: true
  });
  assert.equal(scoped.launchBlocked, false);
  const override = await launchManagedJobForCaller({
    provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task',
    allowUnscopedWrite: true, planFirst: false, dryRun: true
  });
  assert.equal(override.launchBlocked, false);
  assert.equal(override.allowUnscopedWrite, true);
}));

test('delta redactor suppresses secrets split across chunk boundaries', async () => {
  const { DeltaRedactor } = await import('../bin/lib/control.mjs');
  const redactor = new DeltaRedactor();
  assert.equal(redactor.redactDelta('m1', 'the key is sk-'), 'the key is sk-');
  assert.equal(redactor.redactDelta('m1', 'ABCDEFGHIJKLMNOPQRST and more'), '[REDACTED]');
  assert.equal(redactor.redactDelta('m2', 'plain '), 'plain ');
  assert.equal(redactor.redactDelta('m2', 'text continues'), 'text continues');
  const single = new DeltaRedactor();
  assert.equal(single.redactDelta('m3', 'token sk-ABCDEFGHIJKLMNOPQRST here'), '[REDACTED]');
});

test('stale queued jobs reconcile to failed and release the writer guard', () => isolated((directory) => {
  const abandoned = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'never launched' });
  updateManagedJob(abandoned.id, (current) => { current.createdAt = Math.floor(Date.now() / 1000) - 3600; }, { incrementRevision: false });
  const previous = process.env.DELEGATE_CODEX_BIN;
  process.env.DELEGATE_CODEX_BIN = '/usr/bin/false';
  try {
    const next = launchManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'new writer' });
    assert.equal(next.mode, 'implement');
    assert.equal(inspectJob(abandoned.id).status, 'failed');
  } finally {
    if (previous == null) delete process.env.DELEGATE_CODEX_BIN;
    else process.env.DELEGATE_CODEX_BIN = previous;
  }
  const fresh = createManagedJob({ provider: 'codex', mode: 'consult', cwd: directory, prompt: 'fresh' });
  assert.equal(inspectJob(fresh.id).status, 'queued');
}));

test('network option is stored, defaults off, and shapes codex spawn args', async () => isolated(async (directory) => {
  const { codexSpawnArgs, securityPreamble } = await import('../bin/lib/providers.mjs');
  const off = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  assert.equal(inspectJob(off.id).network, false);
  assert.ok(codexSpawnArgs(off).includes('sandbox_workspace_write.network_access=false'));
  const on = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', network: true });
  assert.equal(inspectJob(on.id).network, true);
  assert.ok(codexSpawnArgs(on).includes('sandbox_workspace_write.network_access=true'));
  assert.match(securityPreamble(false), /Do not read, print, transmit/);
  assert.match(securityPreamble(false), /tooling that consumes them internally .* is allowed/);
  assert.match(securityPreamble(false), /Preserve pre-existing changes/);
  assert.match(securityPreamble(true), /explicitly authorized/);
  assert.match(securityPreamble(true), /Preserve pre-existing changes/);
  assert.match(securityPreamble(true), /allowed scope/);
}));

test('GPT models are refused on cursor while codex is enabled and under its avoid band', () => isolated((directory) => {
  // Codex enabled, usage unknown (not exhausted): the native lane is available.
  assert.throws(
    () => launchManagedJob({ provider: 'cursor', model: 'gpt-5.6-sol-xhigh', mode: 'review', cwd: directory, prompt: 'review' }),
    /WRONG_LANE/
  );
  // Explicit user request bypasses the lane guard.
  process.env.DELEGATE_CURSOR_BIN = '/usr/bin/false';
  try {
    const overridden = launchManagedJob({ provider: 'cursor', model: 'gpt-5.6-sol-xhigh', mode: 'review', cwd: directory, prompt: 'review', overrideLane: true });
    assert.equal(overridden.provider, 'cursor');
    // Codex at its avoid band frees the cursor lane without an override.
    const state = loadState();
    setWindow(state, 'codex', 'primary', 95, { resetsAt: Math.floor(Date.now() / 1000) + 3600, source: 'test' });
    saveState(state);
    const fallback = launchManagedJob({ provider: 'cursor', model: 'gpt-5.6-terra', mode: 'review', cwd: directory, prompt: 'review' });
    assert.equal(fallback.provider, 'cursor');
  } finally {
    delete process.env.DELEGATE_CURSOR_BIN;
  }
}));

test('scope matching, allowedPaths validation, and diff path filtering', () => {
  assert.equal(pathMatchesScope('src/app/page.tsx', ['src/app']), true);
  assert.equal(pathMatchesScope('src/app.ts', ['src/app']), false);
  assert.equal(pathMatchesScope('docs/notes.md', ['docs/notes.md']), true);
  assert.equal(pathMatchesScope('packages/ai/test/x.test.mjs', ['packages/*/test']), true);
  assert.equal(pathMatchesScope('anything/else.js', ['src']), false);
  assert.deepEqual(validatedAllowedPaths(['./src/', 'docs']), ['src', 'docs']);
  assert.throws(() => validatedAllowedPaths(['../escape']), /repo-relative/);
  assert.throws(() => validatedAllowedPaths([]), /non-empty/);
  const diff = 'diff --git a/src/a.js b/src/a.js\n+one\ndiff --git a/docs/b.md b/docs/b.md\n+two\n';
  assert.match(filterDiffPaths(diff, ['src']), /src\/a\.js/);
  assert.doesNotMatch(filterDiffPaths(diff, ['src']), /docs\/b\.md/);
  assert.equal(filterDiffPaths(diff, null), diff);
});

test('jobFiles dedupes absolute and relative reports of the same file', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  appendJobEvent(job.id, 'file.changed', { path: path.join(directory, 'src/demo.html') });
  appendJobEvent(job.id, 'file.changed', { path: 'src/demo.html', status: 'M ' });
  const files = jobFiles(job.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/demo.html');
  assert.equal(files[0].status, 'M ');
}));

test('list rows carry session and rootJobId for resume chains', () => isolated((directory) => {
  const root = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'root' });
  updateManagedJob(root.id, (current) => { current.providerSessionId = 'thread-chain'; });
  const child = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'child', parentJobId: root.id, providerSessionId: 'thread-chain' });
  const grandchild = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'grandchild', parentJobId: child.id, providerSessionId: 'thread-chain' });
  const rows = listManagedJobs({ limit: 10 }).jobs;
  const row = rows.find((item) => item.id === grandchild.id);
  assert.equal(row.rootJobId, root.id);
  assert.equal(row.session, 'thread-chain');
  assert.equal(rows.find((item) => item.id === root.id).rootJobId, undefined);
}));

test('sandbox off is validated, stored, and maps to full access across providers', async () => isolated(async (directory) => {
  const { codexSandboxMode, codexSpawnArgs } = await import('../bin/lib/providers.mjs');
  const defaulted = createManagedJob({ provider: 'codex', mode: 'review', cwd: directory, prompt: 'task' });
  assert.equal(inspectJob(defaulted.id).sandbox, null);
  assert.equal(codexSandboxMode(defaulted), 'read-only');
  assert.equal(codexSandboxMode({ ...defaulted, mode: 'implement' }), 'workspace-write');
  assert.ok(codexSpawnArgs(defaulted).includes('tools.web_search=false'));
  const off = createManagedJob({ provider: 'codex', mode: 'implement', cwd: directory, prompt: 'task', sandbox: 'off' });
  assert.equal(inspectJob(off.id).sandbox, 'off');
  assert.equal(codexSandboxMode(off), 'danger-full-access');
  assert.ok(codexSpawnArgs(off).includes('tools.web_search=true'));
  const events = readJobEvents(off.id, { limit: 10 });
  assert.equal(events.find((event) => event.type === 'job.created').data.sandbox, 'off');
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', sandbox: 'yolo' }), /sandbox must be/);
}));

test('event page cursor parses only the new tail and survives truncation', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  const file = path.join(directory, 'jobs', `${job.id}.events.jsonl`);
  const total = 20000;
  const lines = [];
  for (let seq = 3; seq <= total; seq += 1) {
    lines.push(JSON.stringify({ v: 1, seq, at: Date.now(), jobId: job.id, type: 'plan.updated', data: { step: seq } }));
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);

  let afterSeq = 0;
  let collected = 0;
  for (;;) {
    const page = readJobEventPage(job.id, { afterSeq, limit: 1000 });
    collected += page.events.length;
    afterSeq = page.nextSeq;
    if (!page.hasMore) break;
  }
  assert.equal(collected, total);
  assert.equal(afterSeq, total);

  const quietStart = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) {
    const page = readJobEventPage(job.id, { afterSeq: total, limit: 1000 });
    assert.equal(page.events.length, 0);
    assert.equal(page.hasMore, false);
  }
  const quietMs = Number(process.hrtime.bigint() - quietStart) / 1e6;
  assert.ok(quietMs < 1000, `200 quiet polls took ${quietMs.toFixed(0)}ms; cursor fast path is not engaging`);

  appendJobEvent(job.id, 'error', { message: 'tail event' });
  const tail = readJobEventPage(job.id, { afterSeq: total, limit: 10 });
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].type, 'error');

  const content = fs.readFileSync(file, 'utf8');
  const thirdLineEnd = content.split('\n').slice(0, 3).join('\n').length + 1;
  fs.truncateSync(file, thirdLineEnd);
  const recovered = readJobEventPage(job.id, { afterSeq: 0, limit: 10 });
  assert.equal(recovered.events.length, 3);
  assert.deepEqual(recovered.events.map((event) => event.seq), [1, 2, 3]);

  fs.appendFileSync(file, '{"partial":');
  const partial = readJobEventPage(job.id, { afterSeq: recovered.nextSeq, limit: 10 });
  assert.equal(partial.hasMore, false);
}));

test('effort is validated against the known reasoning ladder', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', effort: 'xhigh' });
  assert.equal(inspectJob(job.id).effort, 'xhigh');
  const unset = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task' });
  assert.equal(inspectJob(unset.id).effort, null);
  assert.throws(() => createManagedJob({ provider: 'codex', cwd: directory, prompt: 'task', effort: 'turbo' }), /effort must be one of/);
}));

test('cursor same-turn steering is rejected at the control boundary', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', mode: 'implement', cwd: directory, prompt: 'implement' });
  const revision = inspectJob(job.id).revision;
  assert.throws(
    () => submitControl(job.id, { type: 'steer', correctionId: 'st', strategy: 'same-turn', text: 'change' }, revision),
    /UNSUPPORTED_STRATEGY/
  );
  const auto = submitControl(job.id, { type: 'steer', correctionId: 'st2', strategy: 'auto', text: 'change' }, revision);
  assert.equal(auto.accepted, true);
}));

test('list previews object results and exposes provenance fields', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', cwd: directory, prompt: 'task' });
  updateManagedJob(job.id, (current) => {
    current.status = 'completed';
    current.completedAt = Math.floor(Date.now() / 1000);
    current.result = { text: 'the final answer text', stopReason: 'end_turn' };
    current.resolvedModel = 'composer-2.5';
    current.changedFiles = { count: 2, files: ['a.js', 'b.js'] };
  });
  const listed = listManagedJobs().jobs.find((item) => item.id === job.id);
  assert.equal(listed.resultPreview, 'the final answer text');
  assert.equal(listed.resolvedModel, 'composer-2.5');
  assert.equal(listed.changedFiles.count, 2);
  assert.equal(listed.changedFiles.countIsLowerBound, true);
}));

test('diff stat and windowing bound large diffs', async () => {
  const { diffStat, sliceDiff } = await import('../bin/lib/control.mjs');
  const diff = [
    'diff --git a/src/one.js b/src/one.js',
    '--- a/src/one.js', '+++ b/src/one.js',
    '+added line', '+another added', '-removed line',
    'diff --git a/src/two.js b/src/two.js',
    '--- a/src/two.js', '+++ b/src/two.js',
    '+only addition'
  ].join('\n');
  const stat = diffStat(diff);
  assert.equal(stat.totalFiles, 2);
  assert.deepEqual(stat.files[0], { path: 'src/one.js', additions: 2, deletions: 1 });
  assert.equal(stat.totalAdditions, 3);
  const first = sliceDiff(diff, { offset: 0, maxChars: 1000 });
  assert.equal(first.nextOffset, null);
  assert.equal(first.totalChars, diff.length);
  const window = sliceDiff('x'.repeat(5000), { offset: 0, maxChars: 1000 });
  assert.equal(window.diff.length, 1000);
  assert.equal(window.nextOffset, 1000);
  const next = sliceDiff('x'.repeat(5000), { offset: 4500, maxChars: 1000 });
  assert.equal(next.diff.length, 500);
  assert.equal(next.nextOffset, null);
});

test('event responses are capped by serialized size, preserving the cursor', async () => {
  const { capEventsBySize } = await import('../bin/lib/control.mjs');
  const big = (seq) => ({ seq, type: 'tool.output', data: { delta: 'y'.repeat(30000) } });
  const page = { events: [big(1), big(2), big(3)], nextSeq: 3, latestSeq: 3, hasMore: false };
  const capped = capEventsBySize(page, 65000);
  assert.equal(capped.events.length, 2);
  assert.equal(capped.nextSeq, 2);
  assert.equal(capped.hasMore, true);
  assert.equal(capped.truncated, 'response-size');
  const small = { events: [{ seq: 1, type: 'x', data: {} }], nextSeq: 1, latestSeq: 1, hasMore: false };
  assert.equal(capEventsBySize(small, 65000), small);
});

test('usage reports distinguish missing provider data from zero', () => isolated((directory) => {
  const job = createManagedJob({ provider: 'cursor', model: 'composer', cwd: directory, prompt: 'task' });
  const usage = jobUsage(job.id);
  assert.equal(usage.observedAvailable, false);
  assert.match(usage.note, /did not emit usage/);
}));

test('usage reports chain-cumulative totals through the current continuation', () => isolated((directory) => {
  const root = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'root' });
  appendJobEvent(root.id, 'usage.updated', { total: { inputTokens: 10, outputTokens: 4 } });
  const child = createManagedJob({ provider: 'codex', cwd: directory, prompt: 'child', parentJobId: root.id });
  appendJobEvent(child.id, 'usage.updated', { inputTokens: 6, outputTokens: 3 });
  const usage = jobUsage(child.id);
  assert.deepEqual(usage.chainCumulative.jobIds, [root.id, child.id]);
  assert.equal(usage.chainCumulative.rootJobId, root.id);
  assert.equal(usage.chainCumulative.inputTokens, 16);
  assert.equal(usage.chainCumulative.outputTokens, 7);
  assert.equal(usage.chainCumulative.totalTokens, 23);
}));
