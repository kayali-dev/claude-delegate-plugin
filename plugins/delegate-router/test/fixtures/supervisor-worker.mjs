#!/usr/bin/env node
import {
  appendJobEvent,
  updateManagedJob
} from '../../bin/lib/control.mjs';

const index = process.argv.indexOf('--job-id');
const jobId = index >= 0 ? process.argv[index + 1] : null;
if (!jobId) process.exit(2);

updateManagedJob(jobId, (job) => {
  job.status = 'running';
  job.phase = 'working';
  job.workerPid = process.pid;
});
appendJobEvent(jobId, 'job.state', { status: 'running', phase: 'working' });

const mode = process.env.DELEGATE_SUPERVISOR_TEST_WORKER_MODE || 'complete';
const delayMs = Number(process.env.DELEGATE_SUPERVISOR_TEST_WORKER_DELAY_MS || 100);

if (mode === 'exit-nonzero') {
  setTimeout(() => process.exit(7), delayMs);
} else if (mode === 'sleep') {
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    const completedAt = Math.floor(Date.now() / 1000);
    updateManagedJob(jobId, (job) => {
      job.status = 'completed';
      job.phase = 'completed';
      job.completedAt = completedAt;
      job.result = { text: 'supervisor fixture completed' };
      job.resultText = 'supervisor fixture completed';
    });
    appendJobEvent(jobId, 'job.completed', { status: 'completed' }, { lifecycle: true });
  }, delayMs);
}
