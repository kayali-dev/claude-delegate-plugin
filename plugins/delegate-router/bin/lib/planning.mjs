import crypto from 'node:crypto';
import { auditUsageBands, readAuditLog, usageBandKey } from './stats.mjs';

const PLAN_MAX_CHARS = 32_000;
const PLAN_OUTPUT_TOKENS_DEFAULT = 2_048;
const INTERROGATION_OUTPUT_TOKENS_DEFAULT = 1_024;
const APPROACH_KINDS = new Set([
  'inspect', 'edit', 'test', 'verify', 'docs', 'config', 'migration', 'refactor', 'other'
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.min(Math.max(number, minimum), maximum)
    : fallback;
}

export function planOutputTokenLimit(env = process.env) {
  return boundedInteger(env.DELEGATE_PLAN_OUTPUT_TOKENS, PLAN_OUTPUT_TOKENS_DEFAULT, 128, 16_384);
}

export function interrogationOutputTokenLimit(env = process.env) {
  return boundedInteger(env.DELEGATE_INTERROGATION_OUTPUT_TOKENS, INTERROGATION_OUTPUT_TOKENS_DEFAULT, 128, 8_192);
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
only what is needed to predict the work. End with exactly one fenced JSON object
using this structural contract:

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
