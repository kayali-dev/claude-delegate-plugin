import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { waitForChildExit, waitForCondition } from './helpers/wait.mjs';

test('bounded wait failures name the condition and last observed state', async () => {
  await assert.rejects(
    waitForCondition({
      description: "pendingInput.kind === 'plan-confirmation'",
      timeoutMs: 20,
      intervalMs: 5,
      observe: () => ({
        status: 'running',
        phase: 'running',
        planPass: { state: 'completed' },
        pendingInput: null
      }),
      predicate: (job) => job.pendingInput?.kind === 'plan-confirmation'
    }),
    /timed out waiting for pendingInput\.kind === 'plan-confirmation'; last saw \{"status":"running","phase":"running","planPass":\{"state":"completed"\}\}/
  );

  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() { this.killed = true; }
  });
  await assert.rejects(
    waitForChildExit({
      child,
      description: 'the fixture child to exit',
      timeoutMs: 10
    }),
    /timed out waiting for the fixture child to exit; last saw pid=123, exitCode=null, signalCode=null, killed=false/
  );
  assert.equal(child.killed, true);

  await assert.rejects(
    waitForCondition({
      description: 'an observer that keeps failing',
      timeoutMs: 10,
      intervalMs: 5,
      observe: () => { throw new Error('observer unavailable'); }
    }),
    /timed out waiting for an observer that keeps failing; last saw \{"error":"observer unavailable"\}/
  );
});
