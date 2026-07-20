#!/usr/bin/env node
import readline from 'node:readline';

const threadId = '019f-shadow-codex-thread';
let turn = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (requestId, id, msg) => send({
  jsonrpc: '2.0',
  method: 'codex/event',
  params: { _meta: { requestId, threadId }, id, msg }
});

const tools = [
  {
    name: 'codex',
    description: 'Run a Codex session.',
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, model: { type: 'string' }, cwd: { type: 'string' }, sandbox: { type: 'string' }, config: { type: 'object' } } }
  },
  {
    name: 'codex-reply',
    description: 'Continue a Codex conversation.',
    inputSchema: { type: 'object', required: ['prompt'], properties: { threadId: { type: 'string' }, prompt: { type: 'string' } } }
  }
];

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id == null) return;
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: request.params?.protocolVersion || '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake-codex-mcp', version: '0.0.0' }
    } });
    return;
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools } });
    return;
  }
  if (request.method !== 'tools/call' || !['codex', 'codex-reply'].includes(request.params?.name)) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'not found' } });
    return;
  }
  if (process.env.FAKE_CODEX_MCP_CRASH === '1') process.exit(17);
  turn += 1;
  const text = `shadow codex reply ${turn}`;
  const prefix = `direct-${turn}`;
  event(request.id, `${prefix}-session`, {
    type: 'session_configured',
    thread_id: threadId,
    model: 'gpt-shadow',
    reasoning_effort: 'xhigh',
    cwd: request.params.arguments?.cwd || process.cwd()
  });
  event(request.id, `${prefix}-turn`, { type: 'turn_started', turn_id: `turn-${turn}` });
  event(request.id, `${prefix}-plan`, { type: 'plan_update', plan: [{ step: 'inspect', status: 'completed' }] });
  event(request.id, `${prefix}-delta`, { type: 'agent_message_content_delta', item_id: `message-${turn}`, delta: text });
  event(request.id, `${prefix}-tool-start`, { type: 'exec_command_begin', call_id: `call-${turn}`, command: 'git diff --stat', cwd: process.cwd() });
  event(request.id, `${prefix}-tool-output`, { type: 'exec_command_output_delta', call_id: `call-${turn}`, delta: 'one file\n' });
  event(request.id, `${prefix}-tool-end`, { type: 'exec_command_end', call_id: `call-${turn}`, exit_code: 0, status: 'completed' });
  event(request.id, `${prefix}-patch-start`, {
    type: 'patch_apply_begin',
    call_id: `patch-${turn}`,
    changes: { 'shadow-edit.txt': { kind: 'edit', diff: '--- a/shadow-edit.txt\n+++ b/shadow-edit.txt\n@@ -1 +1 @@\n-old\n+new\n' } }
  });
  event(request.id, `${prefix}-patch-end`, {
    type: 'patch_apply_end',
    call_id: `patch-${turn}`,
    status: 'completed',
    changes: { 'shadow-edit.txt': { kind: 'edit', diff: '--- a/shadow-edit.txt\n+++ b/shadow-edit.txt\n@@ -1 +1 @@\n-old\n+new\n' } }
  });
  event(request.id, `${prefix}-diff`, { type: 'turn_diff', unified_diff: 'diff --git a/shadow-edit.txt b/shadow-edit.txt\n--- a/shadow-edit.txt\n+++ b/shadow-edit.txt\n@@ -1 +1 @@\n-old\n+new\n' });
  if (turn > 1) event(request.id, `${prefix}-compact`, { type: 'context_compacted' });
  event(request.id, `${prefix}-usage`, {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: turn === 1 ? 100 : 180, output_tokens: turn === 1 ? 10 : 18 } }
  });
  event(request.id, `${prefix}-reasoning-start`, {
    type: 'item_started',
    item: { type: 'Reasoning', id: `reasoning-${turn}`, content: [{ type: 'Text', text: 'hidden synthetic reasoning' }] }
  });
  event(request.id, `${prefix}-message`, {
    type: 'item_completed',
    item: { type: 'AgentMessage', id: `message-${turn}`, content: [{ type: 'Text', text }], phase: 'final_answer' }
  });
  event(request.id, `${prefix}-legacy-message`, { type: 'agent_message', item_id: `message-${turn}`, message: text });
  event(request.id, `${prefix}-complete`, { type: 'turn_complete', turn_id: `turn-${turn}` });
  send({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: { threadId, content: text }
    }
  });
});
