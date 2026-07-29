import crypto from 'node:crypto';
import { auditUsageBands, readAuditLog, usageBandKey } from './stats.mjs';

const PLAN_MAX_CHARS = 32_000;
const PLAN_OUTPUT_TOKENS_FLOOR = 4_096;
const PLAN_OUTPUT_TOKENS_CEILING = 16_384;
const PLAN_RECOVERABLE_OVERRUN_RATIO = 0.20;
const INTERROGATION_OUTPUT_TOKENS_DEFAULT = 1_024;
// The wall clock a plan pass needs is a function of how much it is permitted to
// emit. Scaling the token budget while leaving the timeout a fixed 120s left a
// plan allowed 16,384 tokens unable to finish in the time it was given — the
// same defect the token scaling fixed, one unit over. Deriving seconds from the
// token budget keeps one scaling source, so the two cannot drift apart again.
const PLAN_TOKENS_PER_SECOND = 30;
const PLAN_TIMEOUT_FLOOR_SECONDS = 120;
const PLAN_TIMEOUT_CEILING_SECONDS = 900;
const APPROACH_KINDS = new Set([
  'inspect', 'edit', 'test', 'verify', 'docs', 'config', 'migration', 'refactor', 'other'
]);
const PLAN_CONSTRAINT_PATTERN = /\b(?:must|never|do not|required|requirement|non-negotiable|acceptance|allowed scope|hard fence|stop and report)\b/i;
const PLAN_LIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+[.)])\s+/;
const PLAN_SECTION_PATTERN = /^\s*(?:#{1,6}\s+|[A-Za-z][A-Za-z0-9 _/&().-]{2,}:)\s*$/;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.min(Math.max(number, minimum), maximum)
    : fallback;
}

export function planOutputTokenBudget(spec = '', env = process.env) {
  const text = String(spec || '');
  const lines = text ? text.split(/\r?\n/) : [];
  const metrics = {
    bytes: Buffer.byteLength(text),
    lines: lines.length,
    listItems: lines.filter((line) => PLAN_LIST_ITEM_PATTERN.test(line)).length,
    constraintLines: lines.filter((line) => PLAN_CONSTRAINT_PATTERN.test(line)).length,
    sectionLines: lines.filter((line) => PLAN_SECTION_PATTERN.test(line)).length
  };
  metrics.directiveMarkers = metrics.listItems + metrics.constraintLines + metrics.sectionLines;

  const configured = env.DELEGATE_PLAN_OUTPUT_TOKENS;
  if (configured != null && String(configured).trim() !== '') {
    return {
      limit: boundedInteger(configured, PLAN_OUTPUT_TOKENS_FLOOR, 128, PLAN_OUTPUT_TOKENS_CEILING),
      source: 'environment-override',
      floor: PLAN_OUTPUT_TOKENS_FLOOR,
      ceiling: PLAN_OUTPUT_TOKENS_CEILING,
      metrics
    };
  }

  return {
    // Live observations found plan output nearly flat across 2.6-6.1 KiB
    // packets, while raising this allowance simply moved the observed spend
    // upward. Packet bytes and directive markers remain useful diagnostics,
    // but they no longer buy a larger response.
    limit: PLAN_OUTPUT_TOKENS_FLOOR,
    source: 'structured-default',
    floor: PLAN_OUTPUT_TOKENS_FLOOR,
    ceiling: PLAN_OUTPUT_TOKENS_CEILING,
    metrics
  };
}

export function planOutputTokenLimit(env = process.env) {
  return planOutputTokenBudget('', env).limit;
}

export function planWallClockBudget(spec = '', env = process.env, parentTimeoutSeconds = null) {
  const budget = planOutputTokenBudget(spec, env);
  const configured = env.DELEGATE_PLAN_TIMEOUT_SECONDS;
  const overridden = configured != null && String(configured).trim() !== '';
  const derived = overridden
    ? boundedInteger(configured, PLAN_TIMEOUT_FLOOR_SECONDS, 30, PLAN_TIMEOUT_CEILING_SECONDS)
    : Math.min(
      PLAN_TIMEOUT_CEILING_SECONDS,
      Math.max(PLAN_TIMEOUT_FLOOR_SECONDS, Math.ceil(budget.limit / PLAN_TOKENS_PER_SECOND))
    );
  // A plan pass must never outlive the work it is planning. The previous
  // Math.max(60, ...) could hand a plan more wall clock than its own parent.
  const parent = Number(parentTimeoutSeconds);
  const bounded = Number.isFinite(parent) && parent > 0 ? Math.min(derived, parent) : derived;
  return {
    seconds: bounded,
    source: overridden ? 'environment-override' : 'token-budget-derived',
    clampedToParent: bounded !== derived,
    derivedSeconds: derived,
    tokenLimit: budget.limit,
    floor: PLAN_TIMEOUT_FLOOR_SECONDS,
    ceiling: PLAN_TIMEOUT_CEILING_SECONDS
  };
}

export function interrogationOutputTokenLimit(env = process.env) {
  return boundedInteger(env.DELEGATE_INTERROGATION_OUTPUT_TOKENS, INTERROGATION_OUTPUT_TOKENS_DEFAULT, 128, 8_192);
}

export function planHardOutputTokenLimit(limit) {
  const nominal = Math.max(1, Number(limit) || PLAN_OUTPUT_TOKENS_FLOOR);
  return Math.floor(nominal * (1 + PLAN_RECOVERABLE_OVERRUN_RATIO));
}

export function planFirstDefault(mode, options = {}, env = process.env) {
  if (!['implement', 'verify'].includes(mode)) return false;
  if (options.planFirst === false) return false;
  return String(env.DELEGATE_PLAN_FIRST ?? '1') !== '0';
}

export function ambiguityDefault(options = {}, env = process.env) {
  if (options.ambiguityCheck === false) return false;
  return String(env.DELEGATE_AMBIGUITY_CHECK ?? '1') !== '0';
}

export function planPrompt(providerPacket) {
  return `${providerPacket}

PLAN PASS ONLY — READ-ONLY.
Do not modify files, run destructive commands, or begin implementation. Inspect
only what is needed to predict the work. Be compact: do not narrate analysis,
repeat the task packet, quote source, or explain the schema. Prefer short stable
component names, combine related targets, and stop immediately after the JSON
fence. The complete answer should normally stay under 500 words.

Return exactly one fenced JSON object using this structural contract:

\`\`\`json
{
  "targets": {
    "files": ["repo/relative/path"],
    "components": ["stable-component-id"]
  },
  "approach": [
    { "kind": "inspect|edit|test|verify|docs|config|migration|refactor|other", "component": "stable-component-id" }
  ],
  "assumptions": [
    { "topic": "stable-topic-id", "choice": "declared interpretation" }
  ],
  "risks": ["short risk statement"]
}
\`\`\`

Use empty arrays when a dimension cannot be predicted. Do not perform the work;
the coordinator must explicitly confirm the presented plan before any write.`;
}

export const IMPLEMENT_CONFIRMED_PROMPT = [
  'The coordinator explicitly confirmed the presented plan.',
  'Continue in this same provider session and implement it under the original objective, scope, permissions, sandbox, network, timeout, and token budget.',
  'Do not treat the confirmation as authority to widen any constraint.'
].join(' ');

export function interrogationPrompt(interrogationId, question) {
  return [
    `READ-ONLY INTERROGATION ${interrogationId}.`,
    'Answer the coordinator question from your live context, but take NO action:',
    String(question).trim(),
    'Do not edit files, run tools, change the plan or objective, widen scope, request privileges, alter budgets, or continue implementation because of this question.',
    `Begin the answer with "INTERROGATION ${interrogationId}:" and return evidence only.`
  ].join('\n');
}

function fencedJsonCandidates(text) {
  const values = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of String(text || '').matchAll(pattern)) values.push(match[1]);
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) values.push(trimmed);
  return values.reverse();
}

function normalizedString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

function normalizedPath(value) {
  const text = normalizedString(value);
  if (!text) return null;
  return text.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function uniqueStrings(values, normalize) {
  if (!Array.isArray(values)) return null;
  const entries = values.map(normalize);
  if (entries.some((entry) => entry == null)) return null;
  return [...new Set(entries)].sort();
}

export function parseStructuralPlan(text) {
  let parsed = null;
  for (const candidate of fencedJsonCandidates(String(text || '').slice(-PLAN_MAX_CHARS))) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value;
        break;
      }
    } catch {}
  }
  if (!parsed) return { ok: false, reason: 'no-valid-structural-json' };
  const files = uniqueStrings(parsed.targets?.files, normalizedPath);
  const components = uniqueStrings(parsed.targets?.components, normalizedString);
  if (!files || !components) return { ok: false, reason: 'invalid-target-shape' };
  if (!Array.isArray(parsed.approach) || !Array.isArray(parsed.assumptions) || !Array.isArray(parsed.risks)) {
    return { ok: false, reason: 'missing-structural-dimensions' };
  }
  const approach = parsed.approach.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const kind = normalizedString(entry.kind);
    const component = normalizedString(entry.component);
    if (!kind || !APPROACH_KINDS.has(kind) || !component) return null;
    return { kind, component };
  });
  if (approach.some((entry) => entry == null)) return { ok: false, reason: 'invalid-approach-shape' };
  const assumptions = parsed.assumptions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const topic = normalizedString(entry.topic);
    const choice = normalizedString(entry.choice);
    return topic && choice ? { topic, choice } : null;
  });
  if (assumptions.some((entry) => entry == null)) return { ok: false, reason: 'invalid-assumption-shape' };
  const risks = uniqueStrings(parsed.risks, normalizedString);
  if (!risks) return { ok: false, reason: 'invalid-risk-shape' };
  return {
    ok: true,
    plan: {
      targets: { files, components },
      approach,
      assumptions: assumptions.sort((left, right) => left.topic.localeCompare(right.topic) || left.choice.localeCompare(right.choice)),
      risks
    }
  };
}

export function assessStructuralPlanOutput(text, observedOutputTokens, outputTokenLimit) {
  const observed = Number(observedOutputTokens);
  const limit = Number(outputTokenLimit);
  const parsed = parseStructuralPlan(text);
  const bounded = Number.isFinite(observed) && Number.isFinite(limit) && limit > 0;
  const overrunTokens = bounded ? Math.max(0, observed - limit) : null;
  const overrunRatio = bounded ? overrunTokens / limit : null;
  const hardLimit = bounded ? planHardOutputTokenLimit(limit) : null;
  const base = {
    parsed,
    observedOutputTokens: Number.isFinite(observed) ? observed : null,
    outputTokenLimit: Number.isFinite(limit) ? limit : null,
    hardOutputTokenLimit: hardLimit,
    overrunTokens,
    overrunPercent: overrunRatio == null ? null : overrunRatio * 100
  };
  if (!bounded || observed <= limit) return { ...base, state: 'within-budget', recoverable: false };
  if (!parsed.ok) {
    return {
      ...base,
      state: 'rejected',
      recoverable: false,
      reason: `over-budget-plan-${parsed.reason}`
    };
  }
  if (observed <= hardLimit) {
    return {
      ...base,
      state: 'recovered',
      recoverable: true,
      reason: 'marginal-structural-plan-overrun'
    };
  }
  return {
    ...base,
    state: 'rejected',
    recoverable: false,
    reason: 'runaway-plan-output-token-budget-exceeded'
  };
}

function overlap(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function structuralDifference(dimension, left, right, reason) {
  return { dimension, left, right, reason };
}

export function compareStructuralPlans(leftInput, rightInput) {
  const left = leftInput?.ok === true ? leftInput : parseStructuralPlan(leftInput);
  const right = rightInput?.ok === true ? rightInput : parseStructuralPlan(rightInput);
  if (!left.ok || !right.ok) {
    return {
      verdict: 'inconclusive',
      reason: 'one-or-both-plans-lack-valid-structural-output',
      inputs: { left: left.ok ? 'valid' : left.reason, right: right.ok ? 'valid' : right.reason },
      comparedDimensions: [],
      differences: []
    };
  }
  const comparable = [];
  const differences = [];
  const targetOverlaps = [];
  for (const dimension of ['files', 'components']) {
    const a = left.plan.targets[dimension];
    const b = right.plan.targets[dimension];
    if (!a.length || !b.length) continue;
    comparable.push(`targets.${dimension}`);
    const shared = overlap(a, b);
    targetOverlaps.push(shared.length > 0);
    if (!shared.length) {
      differences.push(structuralDifference(`targets.${dimension}`, a, b, 'disjoint-target-sets'));
    }
  }
  if (left.plan.approach.length && right.plan.approach.length) {
    comparable.push('approach.shape');
    const a = left.plan.approach.map((entry) => `${entry.kind}:${entry.component}`);
    const b = right.plan.approach.map((entry) => `${entry.kind}:${entry.component}`);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push(structuralDifference('approach.shape', a, b, 'ordered-approach-shapes-differ'));
    }
  }
  const leftAssumptions = new Map(left.plan.assumptions.map((entry) => [entry.topic, entry.choice]));
  const rightAssumptions = new Map(right.plan.assumptions.map((entry) => [entry.topic, entry.choice]));
  const sharedTopics = [...leftAssumptions.keys()].filter((topic) => rightAssumptions.has(topic)).sort();
  if (sharedTopics.length) {
    comparable.push('assumptions');
    for (const topic of sharedTopics) {
      const a = leftAssumptions.get(topic);
      const b = rightAssumptions.get(topic);
      if (a !== b) {
        differences.push(structuralDifference(`assumptions.${topic}`, a, b, 'declared-assumptions-conflict'));
      }
    }
  }
  if (differences.length) {
    return {
      verdict: 'divergent',
      reason: 'material-structural-divergence',
      comparedDimensions: comparable,
      differences,
      plans: { left: left.plan, right: right.plan }
    };
  }
  const approachCompared = comparable.includes('approach.shape');
  const targetCompared = targetOverlaps.length > 0;
  if (comparable.length >= 2 && approachCompared && targetCompared && targetOverlaps.some(Boolean)) {
    return {
      verdict: 'convergent',
      reason: 'structural-target-and-approach-agreement',
      comparedDimensions: comparable,
      differences: [],
      plans: { left: left.plan, right: right.plan }
    };
  }
  return {
    verdict: 'inconclusive',
    reason: 'insufficient-comparable-structural-dimensions',
    comparedDimensions: comparable,
    differences: [],
    plans: { left: left.plan, right: right.plan }
  };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function observedPlanEstimate(job, records = readAuditLog()) {
  const bands = auditUsageBands(records);
  const tokenBand = bands[usageBandKey(job.provider, job.requestedModel || job.model, job.effort)] || null;
  const durations = records.filter((record) => record.provider === job.provider
    && (record.requestedModel === (job.requestedModel || job.model) || record.model === (job.requestedModel || job.model))
    && record.effort === job.effort
    && Number.isFinite(Number(record.durationMs)))
    .map((record) => Number(record.durationMs));
  return {
    outputTokens: tokenBand
      ? { p50: tokenBand.p50OutputTokens, p90: tokenBand.p90OutputTokens, samples: tokenBand.samples }
      : null,
    durationMs: durations.length
      ? { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9), samples: durations.length }
      : null,
    source: tokenBand || durations.length ? 'observed-audit-bands' : 'unavailable'
  };
}

export function planReviewPresentation(primary, comparison, estimate) {
  const parsed = primary?.ok === true ? primary : parseStructuralPlan(primary);
  const plan = parsed.ok ? parsed.plan : null;
  const divergence = comparison?.verdict === 'divergent'
    ? comparison.differences.map((entry) => `${entry.dimension}: ${entry.reason}`).join('; ')
    : null;
  const ambiguityQuestion = divergence
    ? `The independent plans materially diverge: ${divergence}. Which structural reading should govern implementation?`
    : null;
  const comparisonSummary = comparison?.verdict === 'inconclusive'
    ? `Ambiguity comparison is INCONCLUSIVE (${comparison.reason}); no ambiguity verdict was inferred.`
    : comparison?.verdict === 'convergent'
      ? 'Independent plans converge structurally; no ambiguity question was opened.'
      : ambiguityQuestion;
  return {
    structuralPlan: plan,
    predictedBlastRadius: plan ? {
      files: plan.targets.files,
      components: plan.targets.components
    } : { files: [], components: [] },
    estimate,
    comparison,
    ambiguityQuestion,
    question: [
      ambiguityQuestion || 'Review the read-only plan before implementation.',
      comparisonSummary,
      'Accept to continue this same provider session into implementation, or decline to stop without writes.'
    ].filter(Boolean).join(' ')
  };
}

export function planRequestId(jobId) {
  return `plan-${crypto.createHash('sha256').update(String(jobId)).digest('hex').slice(0, 24)}`;
}

export function contractDigest(job) {
  const contract = {
    mode: job.mode,
    allowedPaths: job.allowedPaths ?? null,
    approval: job.approval,
    timeoutSeconds: job.timeoutSeconds,
    maxOutputTokens: job.maxOutputTokens,
    network: job.network === true,
    sandbox: job.sandbox ?? null,
    allowSensitive: job.allowSensitive === true
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}
