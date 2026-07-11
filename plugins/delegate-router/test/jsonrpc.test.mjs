import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonRpcProcess } from '../bin/lib/jsonrpc.mjs';

test('JSON-RPC requests fail on a bounded deadline and the provider is stoppable', async () => {
  const rpc = new JsonRpcProcess(process.execPath, ['-e', 'process.stdin.resume()'], { requestTimeoutMs: 50 });
  await assert.rejects(() => rpc.request('initialize', {}), /timed out/);
  await rpc.stop();
});
