function normalizedItemType(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// These item types have a dedicated durable representation somewhere in the
// Codex mapper. Keep the set phase-independent: a type handled first-class on
// completion must not fall back to provider.item when its start arrives.
export const CODEX_FIRST_CLASS_ITEM_TYPES = Object.freeze([
  'reasoning',
  'userMessage',
  'agentMessage',
  'plan',
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'collabToolCall',
  'collabAgentToolCall',
  'fileChange',
  'contextCompaction',
  'subAgentActivity'
]);

const FIRST_CLASS_NORMALIZED = new Set(CODEX_FIRST_CLASS_ITEM_TYPES.map(normalizedItemType));

export function isCodexFirstClassItemType(value) {
  return FIRST_CLASS_NORMALIZED.has(normalizedItemType(value));
}
