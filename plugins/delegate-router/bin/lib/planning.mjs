import crypto from 'node:crypto';
import { auditUsageBands, readAuditLog, usageBandKey } from './stats.mjs';

const PLAN_MAX_CHARS = 32_000;
const PLAN_OUTPUT_TOKENS_FLOOR = 8_192;
const PLAN_OUTPUT_TOKENS_CEILING = 16_384;
const PLAN_RECOVERABLE_OVERRUN_RATIO = 0.20;
const INTERROGATION_OUTPUT_TOKENS_DEFAULT = 1_024;
// The wall clock a plan pass needs is a function of how much it is permitted to
// emit. Scaling the token budget while leaving the timeout a fixed 120s left a
// plan allowed 16,384 tokens unable to finish in the time it was given — the
// same defect the token scaling fixed, one unit over. Deriving seconds from the
// token budget keeps one scaling source, so the two cannot drift apart again.
const PLAN_TOKENS_PER_SECOND = 30;
const PLAN_TIMEOUT_FLOOR_SECONDS = 300;
const PLAN_TIMEOUT_CEILING_SECONDS = 900;
// Both axes are deliberately generous rather than fitted to observed spend. The
// two failure modes are not symmetric: too small means plan-first silently does
// not work, which is exactly what happened for fifteen consecutive jobs, while
// too large costs a few tokens only if the model actually fills the room — and
// the compact JSON contract plus the recoverable-overrun band already bound
// that. The independent planner also prefers PROVIDER independence, so a Codex
// parent with Cursor enabled plans on Cursor, which is materially slower to
// first token; it therefore carries a higher floor again on both axes.
const PLAN_PROVIDER_TUNING = Object.freeze({
  cursor: Object.freeze({ outputTokens: 12_288, timeoutFloorSeconds: 600 })
});

function providerTuning(provider) {
  return PLAN_PROVIDER_TUNING[String(provider || '').toLowerCase()] || null;
}
const APPROACH_KINDS = new Set([
  'inspect', 'edit', 'test', 'verify', 'docs', 'config', 'migration', 'refactor', 'other'
]);
export const STRUCTURAL_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['targets', 'approach', 'assumptions', 'risks'],
  properties: {
    targets: {
      type: 'object', additionalProperties: false, required: ['files', 'components'],
      properties: { files: { type: 'array', items: { type: 'string' } }, components: { type: 'array', items: { type: 'string' } } }
    },
    approach: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['kind', 'component'],
        properties: { kind: { type: 'string', enum: [...APPROACH_KINDS] }, component: { type: 'string' } }
      }
    },
    assumptions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['topic', 'choice'],
        properties: { topic: { type: 'string' }, choice: { type: 'string' } }
      }
    },
    risks: { type: 'array', items: { type: 'string' } }
  }
};
const PLAN_CONSTRAINT_PATTERN = /\b(?:must|never|do not|required|requirement|non-negotiable|acceptance|allowed scope|hard fence|stop and report)\b/i;
const PLAN_LIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+[.)])\s+/;
const PLAN_SECTION_PATTERN = /^\s*(?:#{1,6}\s+|[A-Za-z][A-Za-z0-9 _/&().-]{2,}:)\s*$/;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.min(Math.max(number, minimum), maximum)
    : fallback;
}

export function planOutputTokenBudget(spec = '', env = process.env, options = {}) {
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

  const tuning = providerTuning(options.provider);
  return {
    // Live observations found plan output nearly flat across 2.6-6.1 KiB
    // packets, while raising this allowance simply moved the observed spend
    // upward. Packet bytes and directive markers remain useful diagnostics,
    // but they no longer buy a larger response. That evidence is Codex-only,
    // so a slower/more verbose provider may carry its own default.
    limit: tuning?.outputTokens || PLAN_OUTPUT_TOKENS_FLOOR,
    source: tuning ? `provider-default:${String(options.provider).toLowerCase()}` : 'structured-default',
    floor: PLAN_OUTPUT_TOKENS_FLOOR,
    ceiling: PLAN_OUTPUT_TOKENS_CEILING,
    metrics
  };
}

export function planOutputTokenLimit(env = process.env) {
  return planOutputTokenBudget('', env).limit;
}

export function planWallClockBudget(spec = '', env = process.env, parentTimeoutSeconds = null, options = {}) {
  const budget = planOutputTokenBudget(spec, env, options);
  const tuning = providerTuning(options.provider);
  const floorSeconds = tuning?.timeoutFloorSeconds || PLAN_TIMEOUT_FLOOR_SECONDS;
  const configured = env.DELEGATE_PLAN_TIMEOUT_SECONDS;
  const overridden = configured != null && String(configured).trim() !== '';
  const derived = overridden
    ? boundedInteger(configured, PLAN_TIMEOUT_FLOOR_SECONDS, 30, PLAN_TIMEOUT_CEILING_SECONDS)
    : Math.min(
      PLAN_TIMEOUT_CEILING_SECONDS,
      Math.max(floorSeconds, Math.ceil(budget.limit / PLAN_TOKENS_PER_SECOND))
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
    floor: floorSeconds,
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

export function planPrompt(providerPacket, lane = {}) {
  const laneReinforcement = lane.provider === 'cursor'
    ? `

CURSOR PLAN-LANE FINAL-ANSWER CONTRACT: process narration without the structural
JSON deliverable is invalid. Your entire final message must be the single fenced
JSON object requested above: begin with the opening fence, end with the closing
fence, and emit nothing before or after it.`
    : '';
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
the coordinator must explicitly confirm the presented plan before any write.${laneReinforcement}`;
}

export function planRetryPrompt(providerPacket, lane = {}, retryLimit = PLAN_OUTPUT_TOKENS_CEILING) {
  return `${planPrompt(providerPacket, lane)}

RETRY 1 OF 1. The previous plan attempt exceeded its hard output limit and was
not usable. Produce a fresh compact structural object within ${retryLimit}
output tokens. Do not repeat analysis from the previous attempt. If this retry
cannot satisfy the contract, stop with the best bounded structural object you
can produce; the broker will degrade to explicit confirmation rather than
starting write work automatically.`;
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

function balancedJsonCandidates(text) {
  const values = [];
  const source = String(text || '');
  const starts = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!starts.length) {
      if (character === '{') {
        starts.push(index);
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') starts.push(index);
    else if (character === '}') {
      const start = starts.pop();
      values.push(source.slice(start, index + 1));
    }
  }
  return values.reverse();
}

function structuralJsonCandidates(text) {
  const source = String(text || '');
  const fenced = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of source.matchAll(pattern)) fenced.push(match[1]);
  const trimmed = source.trim();
  const wholeBody = trimmed.startsWith('{') && trimmed.endsWith('}') ? [trimmed] : [];
  const balanced = balancedJsonCandidates(source)
    .filter((candidate) => candidate !== trimmed);
  // The last explicit deliverable is authoritative. A malformed last fence
  // must not resurrect an earlier, superseded plan from the same answer.
  if (fenced.length) return [fenced.at(-1)];
  if (wholeBody.length) return wholeBody;
  return balanced;
}

function displayString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ')
    : null;
}

function foldedStringKey(value) {
  return displayString(value)?.toLowerCase() || null;
}

function displayPath(value) {
  const text = displayString(value);
  if (!text) return null;
  return text.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function foldedPathKey(value) {
  return displayPath(value)?.toLowerCase() || null;
}

function uniqueStrings(values, normalize, comparisonKey) {
  if (!Array.isArray(values)) return null;
  const entries = values.map(normalize);
  if (entries.some((entry) => entry == null)) return null;
  const unique = new Map();
  for (const entry of entries) {
    const key = comparisonKey(entry);
    if (!key || unique.has(key)) continue;
    unique.set(key, entry);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}

const SEMANTIC_WORD_ALIASES = new Map([
  ['comparators', 'compare'], ['comparator', 'compare'], ['comparisons', 'compare'],
  ['comparison', 'compare'], ['comparing', 'compare'], ['compared', 'compare'],
  ['normalizers', 'normalize'], ['normalizer', 'normalize'], ['normalization', 'normalize'],
  ['normalizing', 'normalize'], ['normalized', 'normalize'],
  ['validators', 'validate'], ['validator', 'validate'], ['validation', 'validate'],
  ['validating', 'validate'], ['validated', 'validate'],
  ['preserves', 'preserve'], ['preserved', 'preserve'], ['preserving', 'preserve'],
  ['retains', 'retain'], ['retained', 'retain'], ['retaining', 'retain'],
  ['scans', 'scan'], ['scanned', 'scan'], ['scanning', 'scan'],
  ['rejects', 'reject'], ['rejected', 'reject'], ['rejecting', 'reject'],
  ['allows', 'allow'], ['allowed', 'allow'], ['allowing', 'allow'],
  ['persists', 'persist'], ['persisted', 'persist'], ['persisting', 'persist'],
  ['saves', 'persist'], ['saved', 'persist'], ['saving', 'persist'], ['save', 'persist'],
  ['notifies', 'notify'], ['notified', 'notify'], ['notifying', 'notify'],
  ['plans', 'plan'], ['components', 'component'], ['assumptions', 'assumption'],
  ['targets', 'target'], ['parsers', 'parser'], ['files', 'file'], ['objects', 'object'],
  ['steps', 'step'], ['choices', 'choice'], ['decisions', 'decision'], ['updates', 'update'],
  ['inputs', 'input'], ['outputs', 'output'], ['reasons', 'reason']
]);
const LABEL_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'component', 'implementation', 'logic', 'module', 'surface'
]);
const DECISION_FILLER_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'be', 'been', 'being', 'by', 'choice', 'decision',
  'do', 'does', 'for', 'from', 'in', 'is', 'it', 'must', 'of', 'on', 'or', 'policy',
  'required', 'same', 'should', 'that', 'the', 'this', 'to', 'was', 'were', 'will',
  'with', 'would'
]);
const DECISION_NEGATIONS = new Set(['dont', 'never', 'no', 'not', 'without']);
const DECISION_ACTIONS = new Map([
  ['accept', 'accept'], ['allow', 'accept'], ['permit', 'accept'],
  ['preserve', 'keep'], ['retain', 'keep'], ['keep', 'keep'],
  ['scan', 'scan'], ['search', 'scan'], ['inspect', 'scan'],
  ['reject', 'reject'], ['refuse', 'reject'],
  ['skip', 'skip'], ['ignore', 'skip'], ['omit', 'skip'],
  ['use', 'use'], ['select', 'use'], ['choose', 'use'],
  ['replace', 'replace'], ['overwrite', 'replace'],
  ['extend', 'extend'], ['add', 'extend'],
  ['remove', 'remove'], ['delete', 'remove'],
  ['validate', 'validate'], ['check', 'validate'],
  ['persist', 'persist'], ['notify', 'notify'], ['report', 'notify']
]);
const DECISION_TERMS = new Map([
  ['decisiontermfencedjson', 'fenced-json'],
  ['decisiontermwholebodyjson', 'whole-body-json'],
  ['decisiontermbalancedobject', 'balanced-object']
]);

function semanticSource(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '');
}

function semanticWords(value) {
  return semanticSource(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function canonicalSemanticWord(word) {
  return SEMANTIC_WORD_ALIASES.get(word) || word;
}

function semanticLabelKey(value) {
  const words = [...new Set(semanticWords(value).map(canonicalSemanticWord))];
  const meaningful = words.filter((word) => !LABEL_FILLER_WORDS.has(word));
  return (meaningful.length ? meaningful : words).sort().join('-');
}

function decisionText(value) {
  return semanticSource(value)
    .replace(/[-_/]+/g, ' ')
    .replace(/\bfenced(?:\s+(?:json|object|code|block))?\b/g, ' decisiontermfencedjson ')
    .replace(/\b(?:whole|entire)\s+body(?:\s+(?:json|object|document))?\b/g, ' decisiontermwholebodyjson ')
    .replace(/\bbalanced(?:\s+brace\s+aware)?(?:\s+(?:json|brace))?\s+objects?\b/g, ' decisiontermbalancedobject ');
}

function anchoredDecision(tokens) {
  if (tokens.filter((word) => DECISION_TERMS.has(word)).length < 2) return null;
  const ordered = [];
  let action = 'use';
  let negated = false;
  let pendingNegation = false;
  for (const rawWord of tokens) {
    const word = canonicalSemanticWord(rawWord);
    if (DECISION_NEGATIONS.has(word)) {
      pendingNegation = true;
      continue;
    }
    const nextAction = DECISION_ACTIONS.get(word);
    if (nextAction) {
      action = nextAction;
      negated = pendingNegation;
      pendingNegation = false;
      continue;
    }
    const term = DECISION_TERMS.get(word);
    if (!term) continue;
    const prefix = negated || pendingNegation ? 'not-' : '';
    ordered.push(`${prefix}${action} ${term}`);
    pendingNegation = false;
  }
  return ordered;
}

function canonicalDecisionWord(word) {
  const canonical = canonicalSemanticWord(word);
  if (DECISION_NEGATIONS.has(canonical)) return 'not';
  return DECISION_ACTIONS.get(canonical) || canonical;
}

function normalizedDecision(choice) {
  const source = decisionText(choice);
  const words = semanticWords(source);
  const anchored = anchoredDecision(words);
  if (anchored) {
    return {
      key: `ordered:${anchored.join('>')}`,
      summary: anchored.join(' -> '),
      ordered: true,
      orderEvidence: 'anchored-precedence',
      parts: anchored
    };
  }

  const explicitSequence = /\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|then|next|finally|lastly)\b|\b\d+\s*[.)]/.test(source);
  const hasExplicitOrder = explicitSequence || source.includes(';');
  const marked = source
    .replace(/\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|then|next|finally|lastly)\b\s*[:,.)-]*/g, '|')
    .replace(/\b\d+\s*[.)]\s*/g, '|')
    .replace(/;/g, hasExplicitOrder ? '|' : ' ');
  const steps = marked.split('|').map((step) => [...new Set(semanticWords(step)
    .map(canonicalDecisionWord)
    .filter((word) => !DECISION_FILLER_WORDS.has(word)))]
    .sort()
    .join(' ')).filter(Boolean);
  const normalized = hasExplicitOrder ? steps : [[...new Set(steps.flatMap((step) => step.split(' ')))].sort().join(' ')];
  return {
    key: `${hasExplicitOrder ? 'ordered' : 'decision'}:${normalized.join('>')}`,
    summary: normalized.join(' -> '),
    ordered: hasExplicitOrder,
    orderEvidence: explicitSequence ? 'explicit-sequence' : null,
    parts: normalized
  };
}

export function parseStructuralPlan(text) {
  let parsed = null;
  for (const candidate of structuralJsonCandidates(String(text || '').slice(-PLAN_MAX_CHARS))) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value;
        break;
      }
    } catch {}
  }
  if (!parsed) return { ok: false, reason: 'no-valid-structural-json' };
  const files = uniqueStrings(parsed.targets?.files, displayPath, foldedPathKey);
  const components = uniqueStrings(parsed.targets?.components, displayString, foldedStringKey);
  if (!files || !components) return { ok: false, reason: 'invalid-target-shape' };
  if (!Array.isArray(parsed.approach) || !Array.isArray(parsed.assumptions) || !Array.isArray(parsed.risks)) {
    return { ok: false, reason: 'missing-structural-dimensions' };
  }
  const approach = parsed.approach.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const kind = foldedStringKey(entry.kind);
    const component = displayString(entry.component);
    if (!kind || !APPROACH_KINDS.has(kind) || !component) return null;
    return { kind, component };
  });
  if (approach.some((entry) => entry == null)) return { ok: false, reason: 'invalid-approach-shape' };
  const assumptions = parsed.assumptions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const topic = displayString(entry.topic);
    const choice = displayString(entry.choice);
    return topic && choice ? { topic, choice } : null;
  });
  if (assumptions.some((entry) => entry == null)) return { ok: false, reason: 'invalid-assumption-shape' };
  const risks = uniqueStrings(parsed.risks, displayString, foldedStringKey);
  if (!risks) return { ok: false, reason: 'invalid-risk-shape' };
  return {
    ok: true,
    plan: {
      targets: { files, components },
      approach,
      assumptions: assumptions.sort((left, right) => (
        foldedStringKey(left.topic).localeCompare(foldedStringKey(right.topic))
        || foldedStringKey(left.choice).localeCompare(foldedStringKey(right.choice))
      )),
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

function structuralDifference(dimension, left, right, reason, details = {}) {
  return { dimension, left, right, reason, ...details };
}

function structuralSignal(dimension, strength, effect, reason, details = {}) {
  return { dimension, strength, effect, reason, ...details };
}

function blockingDifference(dimension, left, right, reason, details = {}) {
  return structuralDifference(dimension, left, right, reason, {
    strength: 'strong',
    blocking: true,
    ...details
  });
}

function nonBlockingVariance(dimension, left, right, reason, strength = 'weak', details = {}) {
  return structuralDifference(dimension, left, right, reason, {
    strength,
    blocking: false,
    ...details
  });
}

function assumptionIndex(assumptions) {
  return new Map(assumptions.map((entry) => [semanticLabelKey(entry.topic), entry]));
}

function approachShape(approach) {
  return approach.map((entry) => `${entry.kind}:${semanticLabelKey(entry.component)}`).sort();
}

function sameMembers(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function labelTokens(value) {
  return new Set(semanticLabelKey(value).split('-').filter(Boolean));
}

function labelOverlap(left, right) {
  const a = labelTokens(left);
  const b = labelTokens(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size);
}

function relatedLabelPairs(left, right) {
  return left.flatMap((a) => right
    .map((b) => ({ left: a, right: b, overlap: labelOverlap(a, b) }))
    .filter((entry) => entry.overlap >= 0.5))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 12);
}

function decisionPartTerm(part) {
  const separator = part.indexOf(' ');
  return separator < 0 ? part : part.slice(separator + 1);
}

function sharedOrderIsInverted(leftDecision, rightDecision) {
  if (!leftDecision.orderEvidence || !rightDecision.orderEvidence) return false;
  const termIndex = (parts) => {
    const result = new Map();
    for (const part of parts) {
      const term = decisionPartTerm(part);
      if (!result.has(term)) result.set(term, result.size);
    }
    return result;
  };
  const left = termIndex(leftDecision.parts);
  const right = termIndex(rightDecision.parts);
  const shared = [...left.keys()].filter((term) => right.has(term));
  for (let a = 0; a < shared.length; a += 1) {
    for (let b = a + 1; b < shared.length; b += 1) {
      const first = shared[a];
      const second = shared[b];
      if ((left.get(first) - left.get(second)) * (right.get(first) - right.get(second)) < 0) {
        return true;
      }
    }
  }
  return false;
}

function decisionTerms(choice) {
  const terms = semanticWords(decisionText(choice))
    .map((word) => DECISION_TERMS.get(word))
    .filter(Boolean);
  return [...new Set(terms)];
}

function exclusiveDecisionScopeConflict(leftChoice, rightChoice) {
  const exclusive = (choice) => /\b(?:exclusively|only|solely)\b/.test(semanticSource(choice));
  const leftExclusive = exclusive(leftChoice);
  const rightExclusive = exclusive(rightChoice);
  if (!leftExclusive && !rightExclusive) return false;
  const leftTerms = decisionTerms(leftChoice);
  const rightTerms = decisionTerms(rightChoice);
  if (!leftTerms.length || !rightTerms.length) return false;
  if (leftExclusive && rightExclusive) return !sameMembers(leftTerms, rightTerms);
  const allowed = new Set(leftExclusive ? leftTerms : rightTerms);
  const asserted = leftExclusive ? rightTerms : leftTerms;
  return asserted.some((term) => !allowed.has(term));
}

function explicitDecisionConflict(leftChoice, rightChoice, leftDecision, rightDecision) {
  if (leftDecision.key === rightDecision.key) return false;
  if (sharedOrderIsInverted(leftDecision, rightDecision)) return true;
  if (exclusiveDecisionScopeConflict(leftChoice, rightChoice)) return true;

  const words = (choice) => [...new Set(semanticWords(choice)
    .map(canonicalDecisionWord)
    .filter((word) => !DECISION_FILLER_WORDS.has(word)))].sort();
  const leftWords = words(leftChoice);
  const rightWords = words(rightChoice);
  const leftNegated = leftWords.includes('not');
  const rightNegated = rightWords.includes('not');
  if (leftNegated !== rightNegated) {
    const leftAssertion = leftWords.filter((word) => word !== 'not');
    const rightAssertion = rightWords.filter((word) => word !== 'not');
    const sharedAssertion = overlap(leftAssertion, rightAssertion);
    const assertionCoverage = sharedAssertion.length
      / Math.max(1, Math.min(leftAssertion.length, rightAssertion.length));
    const decisionActions = new Set(DECISION_ACTIONS.values());
    const sharedAction = sharedAssertion.some((word) => decisionActions.has(word));
    if (assertionCoverage >= 0.75 && (sharedAction || sharedAssertion.length >= 3)) return true;
  }

  const defaultSubject = (choice) => {
    const sourceWords = semanticWords(choice).map(canonicalDecisionWord);
    const index = sourceWords.indexOf('default');
    if (index < 1) return null;
    const knownSubjects = new Set([
      'broker', 'codex', 'cursor', 'direct', 'headless', 'inline', 'isolated',
      'shared', 'supervisor', 'worktree'
    ]);
    return sourceWords.slice(0, index).filter((word) => knownSubjects.has(word)).at(-1) || null;
  };
  const leftDefault = defaultSubject(leftChoice);
  const rightDefault = defaultSubject(rightChoice);
  if (leftDefault && rightDefault && leftDefault !== rightDefault) return true;

  const opposingActions = [
    ['accept', 'reject'],
    ['extend', 'remove'],
    ['keep', 'remove'],
    ['use', 'replace']
  ];
  const actionWords = new Set(opposingActions.flat());
  const leftActions = leftWords.filter((word) => actionWords.has(word));
  const rightActions = rightWords.filter((word) => actionWords.has(word));
  const leftSubjects = leftWords.filter((word) => !actionWords.has(word) && word !== 'not');
  const rightSubjects = rightWords.filter((word) => !actionWords.has(word) && word !== 'not');
  const sharedSubjects = overlap(leftSubjects, rightSubjects);
  const subjectCoverage = sharedSubjects.length / Math.max(1, Math.min(leftSubjects.length, rightSubjects.length));
  return leftActions.length === 1
    && rightActions.length === 1
    && subjectCoverage >= 0.75
    && opposingActions.some(([a, b]) => (
      (leftActions[0] === a && rightActions[0] === b)
      || (leftActions[0] === b && rightActions[0] === a)
    ));
}

function directApproachConflicts(left, right) {
  const index = (approach) => {
    const result = new Map();
    for (const entry of approach) {
      const key = semanticLabelKey(entry.component);
      if (!result.has(key)) result.set(key, { component: entry.component, kinds: new Set() });
      result.get(key).kinds.add(entry.kind);
    }
    return result;
  };
  const a = index(left);
  const b = index(right);
  return [...a.keys()].filter((key) => b.has(key) && overlap([...a.get(key).kinds], [...b.get(key).kinds]).length === 0)
    .map((key) => ({
      component: a.get(key).component,
      leftKinds: [...a.get(key).kinds].sort(),
      rightKinds: [...b.get(key).kinds].sort()
    }));
}

function comparisonEvidence(assessment, signals, blocking) {
  const conflict = signals.filter((signal) => signal.effect === 'conflict');
  const agreement = signals.filter((signal) => signal.effect === 'agreement');
  return {
    assessment,
    blocking,
    strongestAgreement: agreement.find((signal) => signal.strength === 'strong')?.dimension || null,
    strongestConflict: conflict.find((signal) => signal.strength === 'strong')?.dimension || null,
    weakDimensions: signals.filter((signal) => signal.strength === 'weak' && signal.effect === 'variance')
      .map((signal) => signal.dimension)
  };
}

function boundedDifferenceValue(value, limit = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
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
  const variances = [];
  const signals = [];
  let targetAgreement = false;

  const leftFiles = left.plan.targets.files;
  const rightFiles = right.plan.targets.files;
  if (leftFiles.length && rightFiles.length) {
    comparable.push('targets.files');
    const a = leftFiles.map(foldedPathKey);
    const b = rightFiles.map(foldedPathKey);
    const shared = overlap(a, b);
    if (!shared.length) {
      const difference = blockingDifference('targets.files', leftFiles, rightFiles, 'disjoint-target-sets');
      differences.push(difference);
      signals.push(structuralSignal('targets.files', 'strong', 'conflict', difference.reason));
    } else {
      targetAgreement = true;
      signals.push(structuralSignal('targets.files', 'strong', 'agreement', 'concrete-file-targets-overlap', {
        shared: overlap(leftFiles.map(foldedPathKey), rightFiles.map(foldedPathKey))
      }));
      if (!sameMembers(a, b)) {
        const variance = nonBlockingVariance(
          'targets.files', leftFiles, rightFiles, 'partially-overlapping-file-targets', 'moderate'
        );
        variances.push(variance);
        signals.push(structuralSignal('targets.files', 'moderate', 'variance', variance.reason));
      }
    }
  }

  const leftComponents = left.plan.targets.components;
  const rightComponents = right.plan.targets.components;
  if (leftComponents.length && rightComponents.length) {
    comparable.push('targets.components');
    const a = leftComponents.map(semanticLabelKey);
    const b = rightComponents.map(semanticLabelKey);
    const shared = overlap(a, b);
    if (shared.length) targetAgreement = true;
    if (!sameMembers(a, b)) {
      const variance = nonBlockingVariance(
        'targets.components',
        leftComponents,
        rightComponents,
        'component-labels-vary',
        'weak',
        { relatedLabels: relatedLabelPairs(leftComponents, rightComponents) }
      );
      variances.push(variance);
      signals.push(structuralSignal('targets.components', 'weak', 'variance', variance.reason));
    } else {
      signals.push(structuralSignal('targets.components', 'weak', 'agreement', 'component-labels-match'));
    }
  }

  if (left.plan.approach.length && right.plan.approach.length) {
    comparable.push('approach.shape');
    const a = left.plan.approach.map((entry) => `${entry.kind}:${entry.component}`);
    const b = right.plan.approach.map((entry) => `${entry.kind}:${entry.component}`);
    const normalizedA = approachShape(left.plan.approach);
    const normalizedB = approachShape(right.plan.approach);
    const directConflicts = directApproachConflicts(left.plan.approach, right.plan.approach);
    if (JSON.stringify(normalizedA) !== JSON.stringify(normalizedB)) {
      const kindsA = left.plan.approach.map((entry) => entry.kind);
      const kindsB = right.plan.approach.map((entry) => entry.kind);
      const strength = directConflicts.length || !sameMembers(kindsA, kindsB) ? 'moderate' : 'weak';
      const variance = nonBlockingVariance(
        'approach.shape', a, b, 'approach-content-labels-or-granularity-vary', strength,
        { operationDifferences: directConflicts }
      );
      variances.push(variance);
      signals.push(structuralSignal('approach.shape', strength, 'variance', variance.reason));
    } else if (JSON.stringify(left.plan.approach.map((entry) => `${entry.kind}:${semanticLabelKey(entry.component)}`))
        !== JSON.stringify(right.plan.approach.map((entry) => `${entry.kind}:${semanticLabelKey(entry.component)}`))) {
      const variance = nonBlockingVariance('approach.order', a, b, 'approach-order-varies');
      variances.push(variance);
      signals.push(structuralSignal('approach.order', 'weak', 'variance', variance.reason));
    } else {
      signals.push(structuralSignal('approach.shape', 'moderate', 'agreement', 'approach-content-matches'));
    }
  }
  const leftAssumptions = assumptionIndex(left.plan.assumptions);
  const rightAssumptions = assumptionIndex(right.plan.assumptions);
  const sharedTopics = [...leftAssumptions.keys()].filter((topic) => rightAssumptions.has(topic)).sort();
  if (sharedTopics.length) {
    comparable.push('assumptions');
    for (const topicKey of sharedTopics) {
      const leftEntry = leftAssumptions.get(topicKey);
      const rightEntry = rightAssumptions.get(topicKey);
      const a = normalizedDecision(leftEntry.choice);
      const b = normalizedDecision(rightEntry.choice);
      if (a.key !== b.key) {
        const dimension = `assumptions.${leftEntry.topic}`;
        const decisions = { left: a.summary, right: b.summary };
        if (explicitDecisionConflict(leftEntry.choice, rightEntry.choice, a, b)) {
          differences.push(blockingDifference(
            dimension, leftEntry.choice, rightEntry.choice, 'declared-assumptions-conflict', { decisions }
          ));
          signals.push(structuralSignal(dimension, 'strong', 'conflict', 'declared-assumptions-conflict'));
        } else {
          const variance = nonBlockingVariance(
            dimension, leftEntry.choice, rightEntry.choice, 'assumption-wording-varies', 'weak', { decisions }
          );
          variances.push(variance);
          signals.push(structuralSignal(dimension, 'weak', 'variance', variance.reason));
        }
      } else {
        signals.push(structuralSignal(
          `assumptions.${leftEntry.topic}`, 'moderate', 'agreement', 'declared-assumptions-match'
        ));
      }
    }
  }
  if (differences.length) {
    return {
      verdict: 'divergent',
      reason: 'material-structural-divergence',
      comparedDimensions: comparable,
      differences,
      variances,
      signals,
      evidence: comparisonEvidence('material-conflict', signals, true),
      plans: { left: left.plan, right: right.plan }
    };
  }
  const approachCompared = comparable.includes('approach.shape');
  if (comparable.length >= 2 && approachCompared && targetAgreement) {
    const assessment = variances.length ? 'same-work-different-naming' : 'substantive-agreement';
    return {
      verdict: 'convergent',
      reason: variances.length ? 'structural-agreement-with-naming-variance' : 'structural-target-and-approach-agreement',
      comparedDimensions: comparable,
      differences: [],
      variances,
      signals,
      evidence: comparisonEvidence(assessment, signals, false),
      plans: { left: left.plan, right: right.plan }
    };
  }
  return {
    verdict: 'inconclusive',
    reason: 'insufficient-comparable-structural-dimensions',
    comparedDimensions: comparable,
    differences: [],
    variances,
    signals,
    evidence: comparisonEvidence(variances.length ? 'weak-variance-only' : 'insufficient-evidence', signals, false),
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
    ? comparison.differences.map((entry) => {
      const left = boundedDifferenceValue(entry.decisions?.left || entry.left);
      const right = boundedDifferenceValue(entry.decisions?.right || entry.right);
      return `${entry.dimension} (${entry.reason}): left "${left}" vs right "${right}"`;
    }).join('; ')
    : null;
  const variance = comparison?.verdict !== 'divergent' && comparison?.variances?.length
    ? comparison.variances.map((entry) => {
      const left = boundedDifferenceValue(entry.decisions?.left || entry.left);
      const right = boundedDifferenceValue(entry.decisions?.right || entry.right);
      return `${entry.dimension} (${entry.strength}): left "${left}" vs right "${right}"`;
    }).join('; ')
    : null;
  const ambiguityQuestion = divergence
    ? `The independent plans materially diverge: ${divergence}. Which structural reading should govern implementation?`
    : null;
  const comparisonSummary = comparison?.verdict === 'inconclusive'
    ? variance
      ? `Ambiguity comparison is INCONCLUSIVE (${comparison.reason}); the observed differences are weak naming or organization variance, not a demonstrated conflict: ${variance}. No ambiguity verdict was inferred.`
      : `Ambiguity comparison is INCONCLUSIVE (${comparison.reason}); no ambiguity verdict was inferred.`
    : comparison?.verdict === 'convergent'
      ? variance
        ? `Independent plans describe the same work, different naming or organization: ${variance}. This is non-blocking variance, not a conflict; no ambiguity question was opened.`
        : 'Independent plans converge structurally; no ambiguity question was opened.'
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
