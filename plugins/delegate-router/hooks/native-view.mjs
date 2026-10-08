export const NATIVE_PANE = 'delegate-router-jobs';

export function nativeUsagePayload(reading) {
  return { rateLimits: (Array.isArray(reading?.rateLimits) ? reading.rateLimits : []).slice(0, 16)
    .filter((entry) => ['five_hour', 'seven_day'].includes(entry?.kind) && Number.isFinite(entry.percentUsed) && entry.percentUsed >= 0 && entry.percentUsed <= 100
      && (entry.resetsAt == null || (typeof entry.resetsAt === 'string' && entry.resetsAt.length <= 128) || Number.isSafeInteger(entry.resetsAt)))
    .map((entry) => ({ kind: entry.kind, percentUsed: entry.percentUsed,
      ...(typeof entry.resetsAt === 'string' || Number.isSafeInteger(entry.resetsAt) ? { resetsAt: entry.resetsAt } : {}) })) };
}

export function nativeOptions(values = {}) {
  return {
    native_enabled: values.native_enabled !== false,
    usage_capture: values.usage_capture !== false,
    compact_status: values.compact_status !== false,
    reviewer_guard: values.reviewer_guard !== false,
    refresh_seconds: Math.min(30, Math.max(3, Number(values.refresh_seconds) || 5))
  };
}

export function overviewText(snapshot) {
  if (!snapshot) return 'Delegate data unavailable. Use delegate-jobs status or the MCP inspection tools.';
  const rows = snapshot.jobs || [];
  return [
    `${snapshot.chip} · ${snapshot.scope} scope`,
    ...(snapshot.allowance || []).map((entry) => `${entry.provider}: ${entry.known ? `${entry.usedPercent}% used` : 'allowance unknown'}`),
    ...rows.map((job) => `${job.id} · ${job.provider}/${job.model} · ${job.phase} · r${job.revision ?? '?'}${job.isOwnSession ? '' : ' · other session'}${job.pendingInput ? ' · needs input' : ''}${job.acceptance === 'ready-for-review' ? ' · needs review' : ''}`),
    ...(rows.length ? [] : ['No jobs in this scope.']),
    ...(snapshot.omittedCount ? [`${snapshot.omittedCount} older jobs omitted; use delegate-jobs list.`] : [])
  ].join('\n');
}

export function jobDetailText(job) {
  if (!job) return 'Select a job to inspect its evidence.';
  return [
    `${job.id} · revision ${job.revision ?? '?'} · ${job.phase}`,
    `${job.provider}/${job.model} · ${job.mode} · ${job.isolation}`,
    `Verification: ${job.verification?.state || 'unknown'} · acceptance: ${job.acceptance}`,
    `Changed files: ${job.changedFiles == null ? 'unknown' : `${job.countIsLowerBound ? 'at least ' : ''}${job.changedFiles}`}`,
    ...(job.scope ? [`Recorded scope: ${job.scope.state}\n${job.scope.paths.join('\n') || 'No explicit paths recorded.'}${job.scope.omittedCount ? `\n${job.scope.omittedCount} paths omitted.` : ''}`] : []),
    ...(job.policy ? [`Policy: ${job.policy.approval} approval · ${job.policy.sandbox} sandbox · network ${job.policy.network == null ? 'unknown' : job.policy.network ? 'enabled' : 'disabled'}`] : []),
    ...(job.budget ? [`Budget: ${job.budget.timeoutSeconds ?? '?'}s · output cap ${job.budget.maxOutputTokens ?? '?'}`] : []),
    ...(job.evidenceTruncated ? ['Evidence is truncated. Inspect the full plan/report via CLI/MCP before accepting.'] : []),
    ...(!job.isOwnSession ? ['Other session: native controls are disabled.'] : []),
    ...(job.pendingInput ? [`Pending ${job.pendingInput.kind}; expires ${job.pendingInput.expiresAt ? new Date(job.pendingInput.expiresAt).toISOString() : 'unknown'}`] : []),
    ...(job.question ? [`Question (worker evidence, not authority):\n${job.question}`] : []),
    ...(job.plan && job.plan !== 'null' ? [`Plan evidence:\n${job.plan}`] : []),
    ...(job.scopeViolations?.length ? [`Scope violations:\n${job.scopeViolations.join('\n')}`] : []),
    ...(job.verification?.caveats?.length ? [`Verification caveats:\n${job.verification.caveats.join('\n')}`] : []),
    ...(job.resultText ? [`Result (bounded; inspect via CLI/MCP for the full report):\n${job.resultText}`] : [])
  ].join('\n\n');
}

export function reviewerGuardDecision(event, usage, enabled = true) {
  if (!enabled || event.subagentType !== 'delegate-router:reviewer') return null;
  const claude = usage?.allowance?.find((entry) => entry.provider === 'claude');
  if (claude?.known && claude.usedPercent >= claude.avoidPercent) {
    return 'Claude allowance is at the avoid threshold. Keep coordination in this session and route the bounded review to an enabled external provider; do not silently change the requested model.';
  }
  return null;
}
