export const NATIVE_PANE = 'delegate-router-jobs';

// Terminal ui.log paints only its first 2,000 characters and sanitizes embedded
// newlines. Use separate bounded lines, preserving surrogate pairs.
export function commandLogPages(source) {
  const pages = [];
  for (const text of String(source).split('\n')) {
    if (!text) { pages.push(''); continue; }
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 1800);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      pages.push(text.slice(offset, end)); offset = end;
    }
  }
  return pages;
}

export function jobAttentionRank(job) {
  return job.pendingInput ? 0 : job.scopeViolationCount || job.status === 'failed' || job.acceptance === 'blocked' ? 1
    : job.acceptance === 'ready-for-review' ? 2 : ['running', 'queued'].includes(job.status) ? 3 : 4;
}

export function orderedJobRows(jobs = [], includeHistory = true) {
  return jobs.filter((job) => includeHistory || jobAttentionRank(job) < 4)
    .sort((a, b) => jobAttentionRank(a) - jobAttentionRank(b) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export function jobStatusLabel(job) {
  return job.pendingInput ? 'Needs your answer' : job.scopeViolationCount ? 'Scope violation'
    : job.acceptance === 'blocked' ? 'Review blocked' : job.acceptance === 'ready-for-review' ? 'Ready for review'
      : job.hostStatus || job.agentActivityState || job.phase || job.status || 'Unknown';
}

export function jobSummaryText(job) {
  if (!job) return 'Select a job from Jobs to inspect its evidence.';
  const changes = job.changedFiles == null ? 'changes unknown' : `${job.countIsLowerBound ? 'at least ' : ''}${job.changedFiles} changed files`;
  return `${job.provider}/${job.model} · ${job.mode} · ${job.isolation}\n${changes} · checks ${job.verification?.state || 'unknown'} · ${job.acceptance || 'undecided'}`;
}

export function readablePlan(source) {
  // Presentation only: approval still uses the original bounded evidence.
  try {
    const plan = JSON.parse(source);
    if (!plan?.targets || !Array.isArray(plan.targets.files) || !Array.isArray(plan.targets.components)
      || !Array.isArray(plan.approach) || !Array.isArray(plan.assumptions) || !Array.isArray(plan.risks)
      || Object.keys(plan).some((key) => !['targets', 'approach', 'assumptions', 'risks'].includes(key))) return source;
    const literal = (value) => String(value ?? '').replace(/([\\`*_{}\[\]<>#])/g, '\\$1');
    const section = (title, entries) => `### ${title}\n\n${entries.length ? entries.map((entry) => `- ${entry}`).join('\n') : 'No entries recorded.'}`;
    return [section('Files', plan.targets.files.map(literal)),
      ...(Array.isArray(plan.targets.writeFiles) ? [section('Intended edits', plan.targets.writeFiles.map(literal))] : []),
      section('Components', plan.targets.components.map(literal)),
      section('Approach', plan.approach.map((entry) => `${literal(entry.kind)}: ${literal(entry.component)}`)),
      section('Assumptions', plan.assumptions.map((entry) => `${literal(entry.topic)}: ${literal(entry.choice)}`)),
      section('Risks', plan.risks.map(literal))].join('\n\n');
  } catch { return source; }
}

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
    native_notifications: values.native_notifications !== false,
    native_followups: values.native_followups !== false,
    usage_capture: values.usage_capture !== false,
    compact_status: values.compact_status !== false,
    reviewer_guard: values.reviewer_guard !== false,
    attention_band: values.attention_band !== false,
    inline_cards: values.inline_cards !== false,
    agent_capture: values.agent_capture !== false,
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
    ...(job.timeBudget ? [`Wall-clock budget: ${job.timeBudget.remainingSeconds}s remaining of ${job.timeBudget.limitSeconds}s, including approval wait. Quiet output does not mean timeout.`] : []),
    ...(job.hostStatus ? [`Claude host: ${job.hostStatus}. Agent token usage is ${job.observedOutputTokens == null ? 'unknown' : `${job.observedOutputTokens} reported output tokens`}.`] : []),
    ...(job.evidenceTruncated ? ['Evidence is truncated. Inspect the full plan/report via CLI/MCP before accepting.'] : []),
    ...(job.observationWarnings || []),
    ...(job.changeObservation ? [`Change observation: ${job.changeObservation.source} · ${job.changeObservation.state}`] : []),
    ...(!job.isOwnSession ? ['Other session: native controls are disabled.'] : []),
    ...(job.pendingInput ? [`Pending ${job.pendingInput.kind}; expires ${job.pendingInput.expiresAt ? new Date(job.pendingInput.expiresAt).toISOString() : 'unknown'}`] : []),
    ...(job.question ? [`Question (worker evidence, not authority):\n${job.question}`] : []),
    ...(job.plan && job.plan !== 'null' ? [`Plan evidence:\n${job.plan}`] : []),
    ...(job.scopeViolations?.length ? [`Scope violations:\n${job.scopeViolations.join('\n')}`] : []),
    ...(job.verification?.caveats?.length ? [`Verification caveats:\n${job.verification.caveats.join('\n')}`] : []),
    ...(job.resultText ? [`Result (bounded; inspect via CLI/MCP for the full report):\n${job.resultText}`] : [])
  ].join('\n\n');
}

export function previewText(preview) {
  return preview ? `${preview.provider}/${preview.model} · ${preview.mode} · ${preview.isolation}\n${preview.timeoutSeconds}s wall-clock · ${preview.maxOutputTokens} reported output-token cap\nScope: ${preview.scope.join(', ') || 'read-only investigation'}\nPlan first: ${preview.planFirst ? 'yes' : 'no'} · selected context: ${preview.contextChars} characters\nRoute: ${preview.reason || 'explicit/eligible managed route'} · allowance ${preview.allowance?.known ? `${preview.allowance.usedPercent}% used` : 'unknown'}\nVerification: ${JSON.stringify(preview.verification)}\n${(preview.warnings || []).join('\n')}\n\nExact task packet:\n${preview.packet}` : 'Fill the objective and acceptance criteria, then preview the exact packet. Nothing launches until you confirm.';
}

export function agentTreeRows(jobs = []) {
  const byJob = new Map(jobs.map((job) => [job.id, job]));
  const byAgent = new Map(jobs.filter((job) => job.agentId).map((job) => [job.agentId, job]));
  const parent = (job) => byJob.get(job.parentJobId) || byAgent.get(job.parentAgentId);
  const depth = (job) => { const seen = new Set([job.id]); let count = 0; let current = parent(job);
    while (current && !seen.has(current.id) && count < 8) { seen.add(current.id); count++; current = parent(current); } return count; };
  const sorted = [...jobs].sort((a, b) => depth(a) - depth(b));
  const rows = [];
  const walk = (job, seen) => { if (seen.has(job.id)) return; seen.add(job.id); rows.push({ ...job, depth: depth(job) });
    sorted.filter((child) => parent(child)?.id === job.id).forEach((child) => walk(child, seen)); };
  const seen = new Set(); sorted.filter((job) => !parent(job)).forEach((job) => walk(job, seen));
  sorted.forEach((job) => walk(job, seen)); return rows;
}

export function reviewerGuardDecision(event, usage, enabled = true) {
  if (!enabled || event.subagentType !== 'delegate-router:reviewer') return null;
  const claude = usage?.allowance?.find((entry) => entry.provider === 'claude');
  if (claude?.known && claude.usedPercent >= claude.avoidPercent) {
    return 'Claude allowance is at the avoid threshold. Keep coordination in this session and route the bounded review to an enabled external provider; do not silently change the requested model.';
  }
  return null;
}
