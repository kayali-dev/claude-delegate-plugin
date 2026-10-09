import { brokerError } from './errors.mjs';

export function providerConcurrencyLimit(provider, queued = false) {
  const configured = process.env[`DELEGATE_${provider.toUpperCase()}_MAX_CONCURRENT`];
  if (configured == null || configured === '') return queued ? 2 : 0;
  const limit = Number(configured);
  if (!Number.isInteger(limit) || limit < 0 || limit > 32) {
    throw brokerError('INVALID_REQUEST', 'provider MAX_CONCURRENT must be 0 (unlimited) or an integer from 1 to 32');
  }
  return limit;
}

export function controllerSession(job) {
  return job.controller?.sessionId || job.origin?.sessionId || null;
}
