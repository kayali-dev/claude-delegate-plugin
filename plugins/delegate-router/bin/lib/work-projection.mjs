import crypto from 'node:crypto';
import { normalizeWorkSpec, WORK_SCHEMA_VERSION } from './work-model.mjs';

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length ? value : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function observedId(job) {
  return stringOrNull(job?.id) || stringOrNull(job?.jobId);
}

function safeIdPart(value) {
  const text = stringOrNull(value);
  if (!text) return 'unknown';
  if (/^[a-zA-Z0-9_-]+$/.test(text)) return text;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

export function projectedWorkId(rootJobId) {
  return `work-${safeIdPart(rootJobId)}`;
}

function rootIdFor(job, byId) {
  const declared = stringOrNull(job?.rootJobId);
  if (declared) return declared;
  let current = job;
  const seen = new Set();
  while (current) {
    const id = observedId(current);
    if (id) seen.add(id);
    const parentId = stringOrNull(current.parentJobId);
    if (!parentId || seen.has(parentId)) return id;
    const parent = byId.get(parentId);
    if (!parent) return parentId;
    current = parent;
  }
  return observedId(job);
}

function sortNumber(job) {
  if (Number.isFinite(job?.createdAtMs)) return job.createdAtMs;
  if (Number.isFinite(job?.createdAt)) return job.createdAt * 1000;
  return Number.POSITIVE_INFINITY;
}

function compareJobs(left, right) {
  return sortNumber(left) - sortNumber(right)
    || String(observedId(left) || '').localeCompare(String(observedId(right) || ''));
}

function orderRuns(records) {
  const byId = new Map(records.map((job) => [observedId(job), job]).filter(([id]) => id));
  const pending = [...records].sort(compareJobs);
  const ordered = [];
  const emitted = new Set();
  while (pending.length) {
    const ready = pending.findIndex((job) => {
      const parent = stringOrNull(job?.parentJobId);
      return !parent || !byId.has(parent) || emitted.has(parent);
    });
    const [next] = pending.splice(ready < 0 ? 0 : ready, 1);
    ordered.push(next);
    const id = observedId(next);
    if (id) emitted.add(id);
  }
  return ordered;
}

function verifyRecipe(job) {
  if (isRecord(job?.verify) && job.verify.command) {
    return {
      schemaVersion: WORK_SCHEMA_VERSION,
      command: stringOrNull(job.verify.command),
      timeoutSeconds: numberOrNull(job.verify.timeoutSeconds),
      source: job.verificationProfile?.recipe?.source == null ? null : copy(job.verificationProfile.recipe.source)
    };
  }
  const exception = stringOrNull(job?.verify?.exception)
    || (['no-recipe', 'exception', 'skipped'].includes(job?.verification?.state)
      ? stringOrNull(job.verification.reason) : null);
  return exception ? {
    schemaVersion: WORK_SCHEMA_VERSION,
    exception,
    reason: exception
  } : null;
}

function baseFor(job) {
  const dirtyHashes = isRecord(job?.baselineHashes) ? copy(job.baselineHashes) : null;
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    revision: stringOrNull(job?.base?.revision)
      || stringOrNull(job?.baseRevision)
      || stringOrNull(job?.gitBase),
    dirtyHashes
  };
}

function budgetFor(job) {
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    wallTimeSeconds: numberOrNull(job?.timeoutSeconds),
    maxRounds: numberOrNull(job?.autoFix?.maxRounds ?? job?.maxRounds),
    maxOutputTokens: numberOrNull(job?.maxOutputTokens)
  };
}

function scopeClaimFor(job) {
  if (Array.isArray(job?.allowedPaths) && job.allowedPaths.length) return copy(job.allowedPaths);
  return 'unfenced';
}

function projectAttempt(job) {
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    id: observedId(job),
    provider: stringOrNull(job?.provider),
    model: stringOrNull(job?.model) || stringOrNull(job?.requestedModel),
    mode: stringOrNull(job?.mode),
    transport: stringOrNull(job?.transport),
    managedBy: stringOrNull(job?.managedBy),
    sessionId: stringOrNull(job?.providerSessionId)
      || stringOrNull(job?.sessionId)
      || stringOrNull(job?.session),
    threadId: stringOrNull(job?.threadId),
    lifecycle: {
      schemaVersion: WORK_SCHEMA_VERSION,
      status: stringOrNull(job?.status),
      phase: stringOrNull(job?.phase),
      revision: numberOrNull(job?.revision),
      lastSeq: numberOrNull(job?.lastSeq),
      stopReason: stringOrNull(job?.stopReason),
      error: job?.error == null ? null : copy(job.error),
      createdAt: job?.createdAt ?? null,
      updatedAt: job?.updatedAt ?? null,
      completedAt: job?.completedAt ?? null,
      durationMs: numberOrNull(job?.durationMs)
    },
    usage: job?.usage == null ? null : copy(job.usage),
    changedFiles: job?.changedFiles == null ? null : copy(job.changedFiles),
    acceptance: job?.acceptance == null ? null : copy(job.acceptance)
  };
}

function projectedDecision(job) {
  const acceptance = job?.acceptance;
  if (!isRecord(acceptance)) return null;
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    state: stringOrNull(acceptance.state),
    by: stringOrNull(acceptance.decidedBy),
    at: acceptance.decidedAt ?? null,
    evidenceRefs: acceptance.evidenceDigest ? [acceptance.evidenceDigest] : [],
    blockedBy: Array.isArray(acceptance.blockedBy) ? copy(acceptance.blockedBy) : [],
    evidence: acceptance.evidence == null ? null : copy(acceptance.evidence)
  };
}

function projectedFindings(job, workId, runIndex) {
  const structured = Array.isArray(job?.result?.structured?.findings)
    ? job.result.structured.findings
    : [];
  const evidence = Array.isArray(job?.findings) ? job.findings : [];
  const values = [...structured, ...evidence];
  return values.map((finding, findingIndex) => {
    const source = isRecord(finding) ? finding : {};
    return {
      schemaVersion: WORK_SCHEMA_VERSION,
      id: stringOrNull(source.id) || `${workId}-finding-${runIndex + 1}-${findingIndex + 1}`,
      severity: stringOrNull(source.severity),
      criterion: stringOrNull(source.criterion) || stringOrNull(source.acceptanceCriterion),
      status: ['open', 'resolved', 'regressed'].includes(source.status) ? source.status : null,
      introducedBy: stringOrNull(source.introducedBy),
      resolvedBy: stringOrNull(source.resolvedBy),
      ...(source.evidence == null ? {} : { evidence: copy(source.evidence) })
    };
  });
}

function changedFileEntries(job) {
  const changed = job?.changedFiles;
  if (Array.isArray(changed)) return copy(changed);
  if (!isRecord(changed)) return [];
  if (Array.isArray(changed.entries)) return copy(changed.entries);
  if (Array.isArray(changed.files)) return copy(changed.files);
  return [];
}

function projectedChangeSet(job, workId, runIndex, base) {
  if (job?.changedFiles == null) return null;
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    id: `${workId}-changes-${runIndex + 1}`,
    base: copy(base),
    files: changedFileEntries(job),
    verification: job?.verification == null ? null : copy(job.verification),
    producedBy: observedId(job)
  };
}

function timestamp(records, field, direction) {
  const values = records.map((job) => job?.[field]).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return direction === 'min' ? Math.min(...values) : Math.max(...values);
}

export function projectChainAsWorkItem(jobs = []) {
  const records = Array.isArray(jobs) && jobs.length ? jobs.map((job) => (isRecord(job) ? job : {})) : [{}];
  const byId = new Map(records.map((job) => [observedId(job), job]).filter(([id]) => id));
  const ordered = orderRuns(records);
  const rootJobId = rootIdFor(ordered[0], byId);
  const workId = projectedWorkId(rootJobId);
  const root = byId.get(rootJobId) || ordered[0];
  const projectedSpec = {
    schemaVersion: WORK_SCHEMA_VERSION,
    objective: stringOrNull(root?.objective) || stringOrNull(root?.promptSummary),
    scopeClaim: scopeClaimFor(root),
    acceptanceCriteria: Array.isArray(root?.acceptanceCriteria) ? copy(root.acceptanceCriteria) : [],
    verifyRecipe: verifyRecipe(root),
    budget: budgetFor(root),
    base: baseFor(root)
  };
  const spec = isRecord(root?.workSpec) ? normalizeWorkSpec(root.workSpec) : projectedSpec;
  const stepId = `${workId}-step-1`;
  const runIdByJobId = new Map(ordered.map((job, index) => [observedId(job), `${workId}-run-${index + 1}`]).filter(([id]) => id));
  const runs = ordered.map((job, index) => ({
    schemaVersion: WORK_SCHEMA_VERSION,
    id: `${workId}-run-${index + 1}`,
    stepId,
    sequence: index + 1,
    parentRunId: runIdByJobId.get(stringOrNull(job?.parentJobId)) || null,
    attempt: projectAttempt(job)
  }));
  const findings = ordered.flatMap((job, index) => projectedFindings(job, workId, index));
  const changeSets = ordered
    .map((job, index) => projectedChangeSet(job, workId, index, spec.base))
    .filter(Boolean);
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    id: workId,
    rootJobId,
    spec,
    steps: [{
      schemaVersion: WORK_SCHEMA_VERSION,
      id: stepId,
      dependsOn: [],
      runIds: runs.map((run) => run.id)
    }],
    runs,
    findings,
    changeSets,
    decision: projectedDecision(ordered.findLast((job) => isRecord(job?.acceptance))),
    timestamps: {
      schemaVersion: WORK_SCHEMA_VERSION,
      createdAt: timestamp(ordered, 'createdAt', 'min'),
      updatedAt: timestamp(ordered, 'updatedAt', 'max'),
      completedAt: timestamp(ordered, 'completedAt', 'max')
    }
  };
}

export function projectJobAsWorkItem(job) {
  return projectChainAsWorkItem([job]);
}

export function projectJobsAsWorkItems(jobs = []) {
  if (!Array.isArray(jobs) || !jobs.length) return [];
  const records = jobs.map((job) => (isRecord(job) ? job : {}));
  const byId = new Map(records.map((job) => [observedId(job), job]).filter(([id]) => id));
  const groups = new Map();
  for (const [index, job] of records.entries()) {
    const root = rootIdFor(job, byId);
    const key = root == null ? `anonymous-${index}` : root;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return [...groups.values()]
    .map(projectChainAsWorkItem)
    .sort((left, right) => {
      const leftAt = Number(left.timestamps.updatedAt ?? left.timestamps.createdAt);
      const rightAt = Number(right.timestamps.updatedAt ?? right.timestamps.createdAt);
      const byTime = (Number.isFinite(rightAt) ? rightAt : -Infinity) - (Number.isFinite(leftAt) ? leftAt : -Infinity);
      return byTime || left.id.localeCompare(right.id);
    });
}
