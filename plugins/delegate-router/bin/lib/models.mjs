// Current aliases are routing policy, not a provider availability promise.
// Explicit IDs remain untouched so older pins and staged rollouts keep working.
export const CODEX_MODEL_ALIASES = Object.freeze({
  astra: 'gpt-6-astra',
  sol: 'gpt-6.1-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-6-luna'
});

export function resolveCodexModel(model) {
  return Object.hasOwn(CODEX_MODEL_ALIASES, model)
    ? CODEX_MODEL_ALIASES[model]
    : model === 'auto' ? null : model;
}

export function modelProvider(model) {
  if (Object.hasOwn(CODEX_MODEL_ALIASES, model) || /^gpt-/.test(model)) return 'codex';
  if (/^(?:claude-|fable(?:\[|$)|opus(?:\[|$)|sonnet(?:\[|$)|haiku(?:\[|$)|current$)/.test(model)) return 'claude';
  if (/^(?:(?:cursor-)?grok(?:-|\[|$)|composer(?:-|\[|$))/.test(model)) return 'cursor';
  return null;
}

export function isFableModel(model) {
  return /^(?:fable(?:\[|$)|claude-fable-)/.test(model);
}
