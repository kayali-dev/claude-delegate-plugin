import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverCodexModels, validateCodexSelection } from '../bin/lib/model-catalog.mjs';

test('model catalogs are paginated, metadata-only, and connection-scoped', async () => {
  const calls = [];
  const rpc = { request: async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'max' }], inputModalities: ['text'] }], nextCursor: null }
      : { data: [{ model: 'gpt-6.1-sol', secret: 'must-not-retain', supportedReasoningEfforts: ['high', 'high'] }], nextCursor: 'next' };
  } };
  const catalog = await discoverCodexModels(rpc);
  assert.equal(catalog.complete, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.cursor, 'next');
  assert.ok(!JSON.stringify(catalog).includes('must-not-retain'));
  assert.deepEqual(catalog.models[0].efforts, ['high']);
  assert.equal(await discoverCodexModels(rpc), catalog);
  assert.equal(calls.length, 2);
  assert.throws(() => validateCodexSelection(catalog, 'luna', 'ultra'), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateCodexSelection(catalog, 'luna', 'max', ['image']), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateCodexSelection(catalog, 'gpt-unknown', 'high'), { code: 'INVALID_MODEL' });
  assert.equal(validateCodexSelection(catalog, 'sol', 'high').entitlementVerified, false);
  assert.equal(validateCodexSelection(catalog, 'auto', 'ultra').state, 'configuration-selected');
  assert.equal((await discoverCodexModels({ request: async () => ({ data: [], nextCursor: null }) })).models.length, 0);
});

test('missing, malformed, repeated-cursor and truncated catalogs remain explicitly unverified', async () => {
  for (const result of [null, {}, { data: [] }, { data: Array.from({ length: 101 }, (_, index) => ({ model: `m-${index}` })), nextCursor: null }]) {
    const catalog = await discoverCodexModels({ request: async () => result });
    assert.equal(validateCodexSelection(catalog, 'sol', 'ultra').state, 'unverified');
  }
  const legacy = await discoverCodexModels({ request: async () => { throw Object.assign(new Error('missing method'), { rpcCode: -32601 }); } });
  assert.equal(legacy.reason, 'method-unsupported');
  let calls = 0;
  const bounded = await discoverCodexModels({ request: async () => { calls++; return { data: [], nextCursor: 'same' }; } });
  assert.equal(calls, 2);
  assert.equal(bounded.complete, false);
  await assert.rejects(discoverCodexModels({ request: async () => { throw Object.assign(new Error('closed'), { code: 'TRANSPORT_ERROR' }); } }), { code: 'TRANSPORT_ERROR' });
});
