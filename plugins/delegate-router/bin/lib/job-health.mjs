// Visible output is not a heartbeat. In particular, a model request, a long
// tool, or an active child may legitimately produce no journal entries.
export function managedTimeoutMs(job, name, fallbackSeconds = 3600, maximumSeconds = 86400) {
  if (Number.isFinite(job?.timeoutSeconds) && job.timeoutSeconds > 0) {
    return Math.min(Math.max(job.timeoutSeconds, 60), maximumSeconds) * 1000;
  }
  if (Number.isFinite(job?.effectiveTimeoutSeconds) && job.effectiveTimeoutSeconds > 0) {
    return Math.min(Math.max(job.effectiveTimeoutSeconds, 10), maximumSeconds) * 1000;
  }
  const value = Number(process.env[name] || fallbackSeconds);
  return (Number.isFinite(value) ? Math.min(Math.max(value, 10), maximumSeconds) : fallbackSeconds) * 1000;
}

export function jobTimeBudget(job, now = Date.now()) {
  const start = Number(job.createdAtMs || Number(job.createdAt || 0) * 1000);
  if (job.transport === 'claude-agent') return null;
  if (job.managedBy && job.managedBy !== 'delegate-control') return null;
  const managed = ['codex', 'cursor'].includes(job.provider);
  const limit = managed ? managedTimeoutMs(job, job.provider === 'codex' ? 'DELEGATE_CODEX_TIMEOUT_SECONDS' : 'DELEGATE_CURSOR_TIMEOUT_SECONDS') / 1000 : Number(job.timeoutSeconds);
  if (!(start > 0) || !(limit > 0)) return null;
  const end = Number(job.completedAtMs || Number(job.completedAt || 0) * 1000) || now;
  const elapsedSeconds = Math.max(0, (end - start) / 1000);
  return {
    source: 'wall-clock', limitSeconds: limit,
    elapsedSeconds: Math.floor(elapsedSeconds),
    remainingSeconds: Math.max(0, Math.ceil(limit - elapsedSeconds)),
    deadlineAt: start + limit * 1000,
    includesApprovalWait: true
  };
}

export function outputQuiet(job, lastActivityAt, now = Date.now(), seconds = 300) {
  return job.status === 'running' && !job.pendingInput
    && !['paused', 'user-input-required'].includes(job.phase)
    && lastActivityAt != null && now - lastActivityAt > seconds * 1000;
}
