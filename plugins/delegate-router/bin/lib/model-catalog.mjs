import { brokerError } from './errors.mjs';
import { resolveCodexModel } from './models.mjs';

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const cache = new WeakMap();

// Cache only within one initialized connection. A new account, client, or
// provider process never inherits another connection's catalog evidence.
export async function discoverCodexModels(rpc, { timeoutMs = 2000, maxPages = 8 } = {}) {
  if (cache.has(rpc)) return cache.get(rpc);
  const pending = (async () => {
    const deadline = Date.now() + Math.max(100, Math.min(10000, timeoutMs));
    const models = new Map();
    const cursors = new Set();
    let cursor = null;
    let truncated = false;
    for (let page = 0; page < Math.min(16, maxPages); page += 1) {
      if (Date.now() >= deadline) break;
      let result;
      try {
        result = await rpc.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) }, Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (error.code === 'TRANSPORT_ERROR') throw error;
        return { state: 'unavailable', reason: error.rpcCode === -32601 ? 'method-unsupported' : 'discovery-failed', models: [...models.values()], complete: false };
      }
      if (!Array.isArray(result?.data)) return { state: 'unavailable', reason: 'invalid-catalog', models: [...models.values()], complete: false };
      truncated ||= result.data.length > 100;
      for (const entry of result.data.slice(0, 100)) {
        const id = typeof entry?.model === 'string' ? entry.model : entry?.id;
        if (!MODEL_ID.test(id || '')) continue;
        const efforts = Array.isArray(entry.supportedReasoningEfforts)
          ? [...new Set(entry.supportedReasoningEfforts.map(item => typeof item === 'string' ? item : item?.reasoningEffort).filter(item => EFFORTS.has(item)))]
          : null;
        const modalities = Array.isArray(entry.inputModalities)
          ? [...new Set(entry.inputModalities.filter(item => ['text', 'image', 'audio', 'file'].includes(item)))]
          : null;
        models.set(id, { id, efforts, modalities });
      }
      if (!result.nextCursor) return { state: 'available', models: [...models.values()], complete: !truncated };
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    return { state: 'partial', reason: 'catalog-bound', models: [...models.values()], complete: false };
  })();
  cache.set(rpc, pending);
  return pending;
}

export function validateCodexSelection(catalog, requested, effort, modalities = ['text']) {
  const model = resolveCodexModel(requested);
  const entry = catalog.models.find(item => item.id === model);
  if (model && !entry && catalog.complete && catalog.models.length) {
    throw brokerError('INVALID_MODEL', `Codex model '${model}' is absent from the current client catalog; refresh the client or choose an available explicit model.`, { provider: 'codex' });
  }
  if (entry?.efforts?.length && effort && !entry.efforts.includes(effort)) {
    throw brokerError('INVALID_REQUEST', `Codex model '${model}' does not support effort '${effort}'; supported: ${entry.efforts.join(', ')}.`, { provider: 'codex' });
  }
  if (entry?.modalities?.length && modalities.some(item => !entry.modalities.includes(item))) {
    throw brokerError('INVALID_REQUEST', `Codex model '${model}' does not support the requested input modalities.`, { provider: 'codex' });
  }
  return {
    state: entry ? 'validated' : model ? 'unverified' : 'configuration-selected',
    source: 'model/list', requestedModel: requested, model,
    supportedEfforts: entry?.efforts || null, inputModalities: entry?.modalities || null,
    catalogComplete: catalog.complete, reason: catalog.reason || null,
    entitlementVerified: false
  };
}
