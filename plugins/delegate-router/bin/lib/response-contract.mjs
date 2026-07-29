import { brokerError } from './errors.mjs';

const AUTHORITY_FIELDS = new Set([
  'allowedPaths', 'scope', 'permissions', 'approval', 'approvals', 'budget',
  'timeout', 'timeoutSeconds', 'network', 'sandbox', 'sandboxOff',
  'cancel', 'steerJob', 'resume', 'resumeJob', 'command', 'control'
]);

function responseObject(command) {
  return command.response && typeof command.response === 'object' && !Array.isArray(command.response)
    ? command.response
    : null;
}

export function validateBackchannelResponse(command) {
  if (command.response != null && !responseObject(command)) {
    throw brokerError('INVALID_REQUEST', 'structured back-channel response must be an object');
  }
  const response = responseObject(command);
  if (response) {
    const keys = Object.keys(response);
    const forbidden = keys.filter((key) => AUTHORITY_FIELDS.has(key));
    const unknown = keys.filter((key) => !['answer', 'steer'].includes(key));
    if (forbidden.length || unknown.length) {
      throw brokerError('INVALID_REQUEST', `back-channel responses carry answer data only; rejected fields: ${[...new Set([...forbidden, ...unknown])].join(', ')}`);
    }
  }
  const answer = command.answer ?? response?.answer;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw brokerError('INVALID_REQUEST', 'back-channel response requires a non-empty answer string');
  }
  const steer = response?.steer;
  if (steer != null && (typeof steer !== 'string' || !steer.trim())) {
    throw brokerError('INVALID_REQUEST', 'back-channel steer must be a non-empty string');
  }
}

export function validatePendingResponse(pending, command, options = {}) {
  const details = {
    provider: options.provider,
    requestId: pending?.requestId || null,
    requestKind: pending?.kind || 'question',
    commandClaimed: false,
    requestAnswered: false
  };
  if (pending?.kind === 'plan-confirmation') {
    if (typeof command.accept !== 'boolean') {
      throw brokerError(
        'INVALID_REQUEST',
        'plan confirmation requires --accept or --reject (MCP: accept=true or accept=false); --answer is valid only for a free-form question',
        details
      );
    }
    if (command.response != null) {
      throw brokerError(
        'INVALID_REQUEST',
        'plan confirmation uses --accept or --reject, not --response-json (MCP: accept=true or accept=false)',
        details
      );
    }
    return;
  }
  if (pending?.origin === 'backchannel') {
    try {
      validateBackchannelResponse(command);
    } catch (error) {
      for (const [key, value] of Object.entries(details)) {
        if (value !== undefined) error[key] = value;
      }
      throw error;
    }
    return;
  }
  const hasAnswer = typeof command.answer === 'string';
  const hasDecision = typeof command.accept === 'boolean';
  const hasResponse = Boolean(responseObject(command));
  if (!hasAnswer && !hasDecision && !hasResponse) {
    throw brokerError('INVALID_REQUEST', 'respond requires answer, accept/reject, or a structured response object', details);
  }
}
