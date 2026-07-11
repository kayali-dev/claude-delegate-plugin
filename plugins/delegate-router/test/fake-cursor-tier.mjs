#!/usr/bin/env node
import readline from 'node:readline';

if (process.argv.includes('models')) {
  console.log('grok-4.5-xhigh - Cursor Grok 4.5');
  console.log('grok-4.5-high - Cursor Grok 4.5 Medium');
  console.log('composer-2.5 - Composer');
  process.exit(0);
}
if (process.argv.includes('--print')) {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: 'xhigh-answer',
    session_id: 'headless-tier-session', argv: process.argv.slice(2),
    usage: { inputTokens: 5, outputTokens: 2 }
  }));
  process.exit(0);
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id == null) return;
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: {} });
  else if (request.method === 'session/new' || request.method === 'session/load') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      sessionId: 'acp-tier-session',
      configOptions: [{ id: 'model', options: [{ value: 'grok-4.5[effort=high,fast=true]' }, { value: 'default[]' }] }]
    } });
  } else send({ jsonrpc: '2.0', id: request.id, result: {} });
});
