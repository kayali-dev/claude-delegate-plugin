export const BROKER_ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'NOT_FOUND',
  'LOCK_TIMEOUT',
  'WRITER_ACTIVE',
  'QUOTA_GUARD',
  'REVISION_CONFLICT',
  'INVALID_MODEL',
  'WRONG_LANE',
  'RESUME_UNSUPPORTED',
  'ACP_TIER_UNAVAILABLE',
  'USER_INPUT_REQUIRED',
  'ORPHANED',
  'SECRET_IN_PROMPT',
  'BUDGET_EXCEEDED',
  'PROVIDER_DISABLED',
  'PARENT_ACTIVE',
  'SESSION_UNAVAILABLE',
  'UNMANAGED_JOB',
  'JOB_TERMINAL',
  'UNSUPPORTED_STRATEGY',
  'TIMEOUT',
  'RPC_TIMEOUT',
  'TRANSPORT_ERROR',
  'PROVIDER_ERROR',
  'STATE_ERROR',
  'INTERNAL'
]);

const ERROR_CODES = new Set(BROKER_ERROR_CODES);
const RETRYABLE = new Set([
  'LOCK_TIMEOUT',
  'WRITER_ACTIVE',
  'REVISION_CONFLICT',
  'ORPHANED',
  'PARENT_ACTIVE',
  'TIMEOUT',
  'RPC_TIMEOUT',
  'TRANSPORT_ERROR',
  'PROVIDER_ERROR',
  'STATE_ERROR'
]);

function codeFromMessage(message) {
  const candidate = String(message || '').match(/^([A-Z][A-Z0-9_]+):/)?.[1];
  return ERROR_CODES.has(candidate) ? candidate : null;
}

export function brokerError(code, message, options = {}) {
  if (!ERROR_CODES.has(code)) throw new Error(`Unknown broker error code: ${code}`);
  const error = new Error(String(message || '').startsWith(`${code}:`) ? String(message) : `${code}: ${message}`);
  error.code = code;
  error.retryable = options.retryable ?? RETRYABLE.has(code);
  if (options.provider) error.provider = options.provider;
  for (const [key, value] of Object.entries(options)) {
    if (!['retryable', 'provider'].includes(key) && value !== undefined) error[key] = value;
  }
  return error;
}

export function normalizeBrokerError(value, options = {}) {
  const error = value instanceof Error ? value : new Error(String(value));
  const originalCode = typeof error.code === 'string' ? error.code : null;
  const code = ERROR_CODES.has(originalCode)
    ? originalCode
    : codeFromMessage(error.message)
      || options.defaultCode
      || (options.provider ? 'TRANSPORT_ERROR' : 'INTERNAL');
  if (!ERROR_CODES.has(code)) return normalizeBrokerError(error, { ...options, defaultCode: 'INTERNAL' });
  if (originalCode && originalCode !== code && !error.causeCode) error.causeCode = originalCode;
  error.code = code;
  error.retryable = typeof error.retryable === 'boolean' ? error.retryable : RETRYABLE.has(code);
  if (!error.provider && options.provider) error.provider = options.provider;
  return error;
}
