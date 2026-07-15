#!/usr/bin/env node
import readline from 'node:readline';

const scenario = process.env.FAKE_CURSOR_SCENARIO || 'normal';

if (process.argv.includes('--version')) {
  console.log('cursor-agent 2026.07.09-a3815c0');
  process.exit(0);
}
if (process.argv.includes('models')) {
  console.log('composer-2.5 - Composer');
  process.exit(0);
}
if (process.argv.includes('status')) {
  console.log(JSON.stringify({ authenticated: true, status: 'ready' }));
  process.exit(0);
}
if (process.argv.includes('about')) {
  console.log(JSON.stringify({ version: '2026.07.09-a3815c0' }));
  process.exit(0);
}
if (process.argv.includes('create-chat')) {
  if (scenario === 'create-chat-missing') {
    console.error('unknown subcommand create-chat');
    process.exit(2);
  }
  console.log(JSON.stringify({ chat_id: 'chat-created-parity' }));
  process.exit(0);
}
if (process.argv.includes('--print')) {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat-created-parity', model: 'composer-2.5', permissionMode: 'auto' }));
  console.log(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'never persist this thought', timestamp_ms: 1 }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'headless answer' }] }, timestamp_ms: 2 }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'headless answer' }] }, timestamp_ms: 3, model_call_id: 'buffered' }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'headless answer' }] } }));
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: 'headless answer', session_id: 'chat-created-parity',
    request_id: 'request-1', duration_ms: 5, duration_api_ms: 3,
    usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
    argv: process.argv.slice(2), promptHasReadOnlyPreamble: prompt.includes('Remain strictly read-only')
  }));
  process.exit(0);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const input = readline.createInterface({ input: process.stdin });
let nextServerId = 900;
let pendingPromptId = null;
let pendingCustomId = null;
let sessionId = 'acp-parity-session';

function sessionResult() {
  return {
    sessionId,
    configOptions: [
      { id: 'model', parameterizedModelPicker: { options: [{ value: 'composer-2.5' }, { value: 'default[]' }] } },
      { id: 'mode', options: [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }] }
    ]
  };
}

input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === pendingCustomId && (message.result !== undefined || message.error)) {
    const answer = message.result || {};
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: JSON.stringify(answer) } }
    } });
    send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });
    pendingCustomId = null;
    pendingPromptId = null;
    return;
  }
  if (message.id == null) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      capabilities: { loadSession: true, sessionList: true },
      modes: ['agent', 'plan', 'ask'],
      models: ['composer-2.5']
    } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: sessionResult() });
  } else if (message.method === 'session/load') {
    sessionId = message.params.sessionId;
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'user_message_chunk', messageId: 'old-user', content: { type: 'text', text: 'restored prompt' } }
    } });
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'old-agent', content: { type: 'text', text: 'restored answer' } }
    } });
    send({ jsonrpc: '2.0', id: message.id, result: sessionResult() });
  } else if (message.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    if (scenario === 'ask-question' || scenario === 'create-plan' || scenario === 'permission-force') {
      pendingPromptId = message.id;
      pendingCustomId = nextServerId++;
      if (scenario === 'permission-force') {
        send({
          jsonrpc: '2.0', id: pendingCustomId, method: 'session/request_permission',
          params: {
            toolCall: { kind: 'ShellToolCall', path: 'src/index.js' },
            options: [
              { optionId: 'always', kind: 'allow_always' },
              { optionId: 'once', kind: 'allow_once' },
              { optionId: 'reject', kind: 'reject_once' }
            ]
          }
        });
        return;
      }
      send({
        jsonrpc: '2.0', id: pendingCustomId,
        method: scenario === 'ask-question' ? 'cursor/ask_question' : 'cursor/create_plan',
        params: scenario === 'ask-question'
          ? { requestId: 'question-1', question: 'Which target?' }
          : { requestId: 'plan-1', plan: [{ step: 'Edit one file' }] }
      });
    } else {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId,
        update: { sessionUpdate: 'session_info_update', title: 'Parity session', model: 'composer-2.5' }
      } });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    }
  } else {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
