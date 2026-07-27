#!/usr/bin/env node
import { launchManagedJob } from '../../bin/lib/control.mjs';

const cwd = process.argv[2];
const job = launchManagedJob({
  provider: 'codex',
  mode: 'review',
  cwd,
  prompt: process.env.DELEGATE_SUPERVISOR_LAUNCHER_PROMPT
    || 'Objective: read one fixture\nAllowed scope: read only\nAcceptance criteria: return one line\nReturn: one line',
  reportLint: false
});
process.stdout.write(`${JSON.stringify({
  id: job.id,
  executionOwner: job.executionOwner,
  workerPid: job.workerPid,
  pid: job.pid,
  launcherPid: process.pid,
  launcherPpid: process.ppid
})}\n`);
const holdMs = Number(process.env.DELEGATE_SUPERVISOR_LAUNCHER_HOLD_MS || 0);
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
