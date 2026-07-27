export const WORK_SCHEMA_VERSION = 1;

export const WORK_DECISION_STATES = Object.freeze([
  'ready-for-review',
  'blocked',
  'accepted',
  'rejected',
  'superseded'
]);

export const FINDING_STATUSES = Object.freeze(['open', 'resolved', 'regressed']);

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}

function schemaVersion(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : WORK_SCHEMA_VERSION;
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeVerifyRecipe(value) {
  if (!isRecord(value)) return null;
  if ('command' in value) {
    return {
      ...copy(value),
      schemaVersion: schemaVersion(value.schemaVersion),
      command: nullableString(value.command),
      timeoutSeconds: nullableNumber(value.timeoutSeconds)
    };
  }
  if ('exception' in value || 'reason' in value) {
    return {
      ...copy(value),
      schemaVersion: schemaVersion(value.schemaVersion),
      exception: nullableString(value.exception),
      reason: nullableString(value.reason)
    };
  }
  return null;
}

function normalizeBudget(value) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    wallTimeSeconds: nullableNumber(source.wallTimeSeconds),
    maxRounds: nullableNumber(source.maxRounds),
    maxOutputTokens: nullableNumber(source.maxOutputTokens)
  };
}

function normalizeBase(value) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    revision: nullableString(source.revision),
    dirtyHashes: isRecord(source.dirtyHashes) ? copy(source.dirtyHashes) : null
  };
}

function normalizeStep(value) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    id: nullableString(source.id),
    dependsOn: Array.isArray(source.dependsOn) ? copy(source.dependsOn) : [],
    runIds: Array.isArray(source.runIds) ? copy(source.runIds) : []
  };
}

function normalizeRun(value) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    id: nullableString(source.id),
    stepId: nullableString(source.stepId),
    sequence: Number.isSafeInteger(source.sequence) ? source.sequence : null,
    attempt: source.attempt == null ? null : normalizeAttempt(source.attempt)
  };
}

function normalizeTimestamps(value) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null,
    completedAt: source.completedAt ?? null
  };
}

export class WorkModelValidationError extends TypeError {
  constructor(type, issues) {
    super(`Invalid ${type}: ${issues.join('; ')}`);
    this.name = 'WorkModelValidationError';
    this.type = type;
    this.issues = issues;
  }
}

function reject(type, issues) {
  if (issues.length) throw new WorkModelValidationError(type, issues);
  return true;
}

function validateVersion(value, issues) {
  if (!Number.isSafeInteger(value?.schemaVersion) || value.schemaVersion <= 0) {
    issues.push('schemaVersion must be a positive integer');
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function normalizeWorkSpec(value = {}) {
  const source = isRecord(value) ? value : {};
  const scopeClaim = Array.isArray(source.scopeClaim)
    ? copy(source.scopeClaim)
    : ['repo-wide', 'unfenced'].includes(source.scopeClaim) ? source.scopeClaim : null;
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    objective: nullableString(source.objective),
    scopeClaim,
    acceptanceCriteria: Array.isArray(source.acceptanceCriteria) ? copy(source.acceptanceCriteria) : [],
    verifyRecipe: normalizeVerifyRecipe(source.verifyRecipe),
    budget: normalizeBudget(source.budget),
    base: normalizeBase(source.base)
  };
}

export function validateWorkSpec(value, options = {}) {
  const issues = [];
  if (!isRecord(value)) return reject('WorkSpec', ['value must be an object']);
  validateVersion(value, issues);
  if (!nonEmptyString(value.objective)) issues.push('objective must be a non-empty string');
  const scoped = Array.isArray(value.scopeClaim)
    && value.scopeClaim.length > 0
    && value.scopeClaim.every(nonEmptyString);
  const explicit = value.scopeClaim === 'repo-wide';
  const projected = options.allowProjectionGaps === true && value.scopeClaim === 'unfenced';
  if (!scoped && !explicit && !projected) {
    issues.push("scopeClaim must be a non-empty array of paths/globs or 'repo-wide'");
  }
  if (!Array.isArray(value.acceptanceCriteria) || !value.acceptanceCriteria.every(nonEmptyString)) {
    issues.push('acceptanceCriteria must be an array of non-empty strings');
  }
  if (!isRecord(value.verifyRecipe)) {
    issues.push('verifyRecipe must contain a command or a recorded exception');
  } else if ('command' in value.verifyRecipe) {
    if (!nonEmptyString(value.verifyRecipe.command)) issues.push('verifyRecipe.command must be a non-empty string');
    if (!positiveInteger(value.verifyRecipe.timeoutSeconds)) issues.push('verifyRecipe.timeoutSeconds must be a positive integer');
  } else {
    if (!nonEmptyString(value.verifyRecipe.exception)) issues.push('verifyRecipe.exception must be a non-empty string');
    if (!nonEmptyString(value.verifyRecipe.reason)) issues.push('verifyRecipe.reason must be a non-empty string');
  }
  if (!isRecord(value.budget)) {
    issues.push('budget must be an object');
  } else {
    for (const field of ['wallTimeSeconds', 'maxRounds', 'maxOutputTokens']) {
      if (!positiveInteger(value.budget[field])) issues.push(`budget.${field} must be a positive integer`);
    }
  }
  if (!isRecord(value.base)) {
    issues.push('base must be an object');
  } else {
    if (!nonEmptyString(value.base.revision)) issues.push('base.revision must be a non-empty string');
    if (!isRecord(value.base.dirtyHashes)) issues.push('base.dirtyHashes must be an object');
    else if (!Object.values(value.base.dirtyHashes).every(nonEmptyString)) {
      issues.push('base.dirtyHashes values must be non-empty strings');
    }
  }
  return reject('WorkSpec', issues);
}

export function createWorkSpec(value) {
  const normalized = normalizeWorkSpec(value);
  validateWorkSpec(normalized);
  return normalized;
}

export function normalizeAttempt(value = {}) {
  const source = isRecord(value) ? value : {};
  const lifecycle = isRecord(source.lifecycle) ? source.lifecycle : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    id: nullableString(source.id),
    provider: nullableString(source.provider),
    model: nullableString(source.model),
    mode: nullableString(source.mode),
    transport: nullableString(source.transport),
    managedBy: nullableString(source.managedBy),
    sessionId: nullableString(source.sessionId),
    threadId: nullableString(source.threadId),
    lifecycle: {
      ...copy(lifecycle),
      schemaVersion: schemaVersion(lifecycle.schemaVersion),
      status: nullableString(lifecycle.status),
      phase: nullableString(lifecycle.phase),
      revision: nullableNumber(lifecycle.revision),
      lastSeq: nullableNumber(lifecycle.lastSeq),
      stopReason: nullableString(lifecycle.stopReason),
      error: lifecycle.error == null ? null : copy(lifecycle.error),
      createdAt: lifecycle.createdAt ?? null,
      updatedAt: lifecycle.updatedAt ?? null,
      completedAt: lifecycle.completedAt ?? null,
      durationMs: nullableNumber(lifecycle.durationMs)
    },
    usage: source.usage == null ? null : copy(source.usage),
    changedFiles: source.changedFiles == null ? null : copy(source.changedFiles)
  };
}

export function validateAttempt(value) {
  const issues = [];
  if (!isRecord(value)) return reject('Attempt', ['value must be an object']);
  validateVersion(value, issues);
  if (!nonEmptyString(value.id)) issues.push('id must be a non-empty string');
  for (const field of ['provider', 'model', 'mode']) {
    if (!nonEmptyString(value[field])) issues.push(`${field} must be a non-empty string`);
  }
  if (!isRecord(value.lifecycle)) issues.push('lifecycle must be an object');
  return reject('Attempt', issues);
}

export function createAttempt(value) {
  const normalized = normalizeAttempt(value);
  validateAttempt(normalized);
  return normalized;
}

export function normalizeFinding(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    id: nullableString(source.id),
    severity: nullableString(source.severity),
    criterion: nullableString(source.criterion),
    status: FINDING_STATUSES.includes(source.status) ? source.status : null,
    introducedBy: nullableString(source.introducedBy),
    resolvedBy: nullableString(source.resolvedBy)
  };
}

export function validateFinding(value) {
  const issues = [];
  if (!isRecord(value)) return reject('Finding', ['value must be an object']);
  validateVersion(value, issues);
  if (!nonEmptyString(value.id)) issues.push('id must be a non-empty string');
  if (!nonEmptyString(value.severity)) issues.push('severity must be a non-empty string');
  if (!nonEmptyString(value.criterion)) issues.push('criterion must be a non-empty string');
  if (!FINDING_STATUSES.includes(value.status)) issues.push(`status must be one of ${FINDING_STATUSES.join(', ')}`);
  return reject('Finding', issues);
}

export function createFinding(value) {
  const normalized = normalizeFinding(value);
  validateFinding(normalized);
  return normalized;
}

export function normalizeChangeSet(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    id: nullableString(source.id),
    base: source.base == null ? null : normalizeBase(source.base),
    files: Array.isArray(source.files) ? copy(source.files) : [],
    verification: source.verification == null ? null : copy(source.verification),
    producedBy: nullableString(source.producedBy)
  };
}

export function validateChangeSet(value) {
  const issues = [];
  if (!isRecord(value)) return reject('ChangeSet', ['value must be an object']);
  validateVersion(value, issues);
  if (!nonEmptyString(value.id)) issues.push('id must be a non-empty string');
  if (!isRecord(value.base)) issues.push('base must be an object');
  if (!Array.isArray(value.files)) issues.push('files must be an array');
  if (!nonEmptyString(value.producedBy)) issues.push('producedBy must be a non-empty string');
  return reject('ChangeSet', issues);
}

export function createChangeSet(value) {
  const normalized = normalizeChangeSet(value);
  validateChangeSet(normalized);
  return normalized;
}

export function normalizeDecision(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    state: WORK_DECISION_STATES.includes(source.state) ? source.state : null,
    by: nullableString(source.by),
    at: source.at ?? null,
    evidenceRefs: Array.isArray(source.evidenceRefs) ? copy(source.evidenceRefs) : []
  };
}

export function validateDecision(value) {
  const issues = [];
  if (!isRecord(value)) return reject('Decision', ['value must be an object']);
  validateVersion(value, issues);
  if (!WORK_DECISION_STATES.includes(value.state)) issues.push(`state must be one of ${WORK_DECISION_STATES.join(', ')}`);
  if (!nonEmptyString(value.by)) issues.push('by must be a non-empty string');
  if (value.at == null) issues.push('at is required');
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every(nonEmptyString)) {
    issues.push('evidenceRefs must be an array of non-empty strings');
  }
  return reject('Decision', issues);
}

export function createDecision(value) {
  const normalized = normalizeDecision(value);
  validateDecision(normalized);
  return normalized;
}

export function normalizeWorkItem(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    ...copy(source),
    schemaVersion: schemaVersion(source.schemaVersion),
    id: nullableString(source.id),
    spec: source.spec == null ? null : normalizeWorkSpec(source.spec),
    steps: Array.isArray(source.steps) ? source.steps.map(normalizeStep) : [],
    runs: Array.isArray(source.runs) ? source.runs.map(normalizeRun) : [],
    findings: Array.isArray(source.findings) ? source.findings.map(normalizeFinding) : [],
    changeSets: Array.isArray(source.changeSets) ? source.changeSets.map(normalizeChangeSet) : [],
    decision: source.decision == null ? null : normalizeDecision(
      typeof source.decision === 'string' ? { state: source.decision } : source.decision
    ),
    timestamps: normalizeTimestamps(source.timestamps)
  };
}

export function validateWorkItem(value, options = {}) {
  const issues = [];
  if (!isRecord(value)) return reject('WorkItem', ['value must be an object']);
  validateVersion(value, issues);
  if (!nonEmptyString(value.id)) issues.push('id must be a non-empty string');
  try { validateWorkSpec(value.spec, options); } catch (error) {
    issues.push(...(error.issues || [error.message]).map((issue) => `spec.${issue}`));
  }
  if (!Array.isArray(value.steps)) issues.push('steps must be an array');
  if (!Array.isArray(value.runs)) issues.push('runs must be an array');
  if (!Array.isArray(value.findings)) issues.push('findings must be an array');
  if (!Array.isArray(value.changeSets)) issues.push('changeSets must be an array');
  if (!isRecord(value.timestamps)) issues.push('timestamps must be an object');
  if (value.decision != null) {
    try { validateDecision(value.decision); } catch (error) {
      issues.push(...(error.issues || [error.message]).map((issue) => `decision.${issue}`));
    }
  }
  if (Array.isArray(value.steps)) {
    const stepIds = new Set();
    const stepsById = new Map();
    for (const [index, step] of value.steps.entries()) {
      if (isRecord(step)) validateVersion(step, issues);
      if (!isRecord(step) || !nonEmptyString(step.id)) issues.push(`steps[${index}].id must be a non-empty string`);
      else if (stepIds.has(step.id)) issues.push(`steps[${index}].id must be unique`);
      else {
        stepIds.add(step.id);
        stepsById.set(step.id, step);
      }
      if (!Array.isArray(step?.dependsOn) || !step.dependsOn.every(nonEmptyString)) {
        issues.push(`steps[${index}].dependsOn must be an array of step ids`);
      }
    }
    for (const [index, step] of value.steps.entries()) {
      for (const dependency of step?.dependsOn || []) {
        if (!stepIds.has(dependency)) issues.push(`steps[${index}].dependsOn references unknown step ${dependency}`);
        if (dependency === step.id) issues.push(`steps[${index}] cannot depend on itself`);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) {
        issues.push(`steps contain a dependency cycle at ${id}`);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of stepsById.get(id)?.dependsOn || []) {
        if (stepsById.has(dependency)) visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of stepIds) visit(id);
  }
  if (Array.isArray(value.runs)) {
    const stepIds = new Set((value.steps || []).map((step) => step?.id));
    const runIds = new Set();
    for (const [index, run] of value.runs.entries()) {
      if (isRecord(run)) validateVersion(run, issues);
      if (!isRecord(run) || !nonEmptyString(run.id)) issues.push(`runs[${index}].id must be a non-empty string`);
      else if (runIds.has(run.id)) issues.push(`runs[${index}].id must be unique`);
      else runIds.add(run.id);
      if (!stepIds.has(run?.stepId)) issues.push(`runs[${index}].stepId must reference a step`);
      if (!positiveInteger(run?.sequence)) issues.push(`runs[${index}].sequence must be a positive integer`);
      try { validateAttempt(run?.attempt); } catch (error) {
        issues.push(...(error.issues || [error.message]).map((issue) => `runs[${index}].attempt.${issue}`));
      }
    }
  }
  if (Array.isArray(value.findings)) {
    for (const [index, finding] of value.findings.entries()) {
      try { validateFinding(finding); } catch (error) {
        issues.push(...(error.issues || [error.message]).map((issue) => `findings[${index}].${issue}`));
      }
    }
  }
  if (Array.isArray(value.changeSets)) {
    for (const [index, changeSet] of value.changeSets.entries()) {
      try { validateChangeSet(changeSet); } catch (error) {
        issues.push(...(error.issues || [error.message]).map((issue) => `changeSets[${index}].${issue}`));
      }
    }
  }
  return reject('WorkItem', issues);
}

export function createWorkItem(value) {
  const normalized = normalizeWorkItem(value);
  validateWorkItem(normalized);
  return normalized;
}
