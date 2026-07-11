const MODEL_PROVIDER = {
  fable: 'claude', opus: 'claude', sonnet: 'claude', haiku: 'claude', current: 'claude',
  sol: 'codex', terra: 'codex', luna: 'codex',
  grok: 'cursor', 'grok-xhigh': 'cursor', composer: 'cursor'
};

function inferKind(task, mode) {
  const text = task.toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (mode === 'review' || /\b(review|audit|security|vulnerabil|threat model|race condition)\b/.test(text)) return 'verification';
  if (/\b(research|investigate the market|finance|financial|legal|scientific|science|data analysis|literature)\b/.test(text)) return 'broad-research';
  if (/\b(screenshot|image|visual|vision|product strategy|architecture|architect|migration strategy|tradeoff)\b/.test(text)) return 'judgment';
  if (/\b(debug|failing test|flaky|terminal|shell|performance|profile|frontend|browser|playwright)\b/.test(text)) return 'hard-engineering';
  if (wordCount < 14 && !/\b(implement|build|refactor|debug|review|research|migrate|multi-file|bulk)\b/.test(text)) return 'small-contextual';
  if (/\b(refactor|implement|add|build|rename|update|tests?|multi-file|mechanical|bulk)\b/.test(text)) return 'implementation';
  return 'general';
}

function candidatesFor(kind, mode) {
  const candidates = [
    { provider: 'claude', model: 'sonnet', score: 55, reason: 'keeps current conversational context and avoids handoff overhead' },
    { provider: 'cursor', model: 'composer', score: 45, reason: 'efficient coding specialist for clear implementation work' },
    { provider: 'codex', model: 'sol', score: 43, reason: 'strong terminal-heavy coding and verification agent' },
    { provider: 'cursor', model: 'grok', score: 38, reason: 'broad cross-domain tool user with strong recovery behavior' },
    { provider: 'codex', model: 'terra', score: 37, reason: 'cost-balanced substantial coding route' },
    { provider: 'claude', model: 'opus', score: 36, reason: 'complex reasoning with no external-provider handoff' },
    { provider: 'claude', model: 'fable', score: 34, reason: 'highest-capability Claude route for ambiguous long-horizon work' },
    { provider: 'codex', model: 'luna', score: 30, reason: 'fast bounded Codex route' },
    { provider: 'claude', model: 'haiku', score: 28, reason: 'cheap route for simple bounded work' }
  ];
  const boost = (provider, model, amount) => {
    const candidate = candidates.find((item) => item.provider === provider && item.model === model);
    if (candidate) candidate.score += amount;
  };
  if (kind === 'implementation') { boost('cursor', 'composer', 45); boost('codex', 'terra', 22); }
  if (kind === 'hard-engineering') { boost('codex', 'sol', 50); boost('claude', 'opus', 20); }
  if (kind === 'verification') { boost('codex', 'sol', 55); boost('claude', 'opus', 20); }
  if (kind === 'broad-research') { boost('cursor', 'grok', 55); boost('claude', 'opus', 25); boost('codex', 'sol', 10); }
  if (kind === 'judgment') { boost('claude', 'fable', 60); boost('claude', 'opus', 45); boost('cursor', 'grok', 25); }
  if (kind === 'small-contextual') { boost('claude', 'sonnet', 55); boost('claude', 'haiku', 35); }
  if (mode === 'implement') boost('cursor', 'composer', 15);
  if (mode === 'review' || mode === 'verify') boost('codex', 'sol', 20);
  return candidates;
}

export function routeTask({
  task,
  mode = 'implement',
  kind = 'auto',
  provider = 'auto',
  model = 'auto',
  usage = {},
  availability = { claude: true, codex: true, cursor: true },
  avoidPercent = 90,
  warningPercent = 80,
  overrideLimit = false
}) {
  const resolvedKind = kind === 'auto' ? inferKind(task, mode) : kind;
  let candidates = candidatesFor(resolvedKind, mode);
  const explicitProvider = provider !== 'auto' ? provider : model !== 'auto' ? MODEL_PROVIDER[model] : null;
  if (explicitProvider) candidates = candidates.filter((item) => item.provider === explicitProvider);
  if (model !== 'auto') {
    const matching = candidates.find((item) => item.model === model);
    candidates = matching
      ? [{ ...matching, score: matching.score + 100, reason: 'explicit model override' }]
      : [{ provider: explicitProvider, model, score: 200, reason: 'explicit model override' }];
  }

  const threshold = (value, provider, fallback) => {
    if (value && typeof value === 'object') return Number.isFinite(value[provider]) ? value[provider] : fallback;
    return Number.isFinite(value) ? value : fallback;
  };
  candidates = candidates.map((candidate) => {
    const current = usage[candidate.provider] || { known: false, usedPercent: null };
    const updated = { ...candidate, usage: current.known ? current.usedPercent : null };
    const avoid = threshold(avoidPercent, candidate.provider, 90);
    const warn = threshold(warningPercent, candidate.provider, 80);
    if (!availability[candidate.provider]) return { ...updated, eligible: false, excluded: 'provider unavailable' };
    if (!overrideLimit && current.known && current.usedPercent >= avoid) {
      return { ...updated, eligible: false, excluded: `provider at ${current.usedPercent}% (avoid ${avoid}%)` };
    }
    if (current.known && current.usedPercent >= warn) {
      updated.score -= 25;
      updated.reason += `; provider is at ${current.usedPercent}%, so equivalent fallbacks are preferred`;
    }
    return { ...updated, eligible: true };
  });

  const eligible = candidates.filter((item) => item.eligible).sort((a, b) => b.score - a.score);
  if (!eligible.length) {
    return { kind: resolvedKind, mode, primary: null, fallbacks: [], excluded: candidates };
  }
  return {
    kind: resolvedKind,
    mode,
    delegate: eligible[0].provider !== 'claude',
    primary: eligible[0],
    fallbacks: eligible.slice(1, 4),
    excluded: candidates.filter((item) => !item.eligible)
  };
}
