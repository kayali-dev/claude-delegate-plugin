#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('models')) {
  console.log('composer-2.5 - Composer');
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
let pending = null;
let count = 0;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function finish() {
  if (!pending) return;
  const id = pending;
  pending = null;
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_message_chunk', messageId: `message-${count}`, content: { type: 'text', text: `answer-${count}` } } } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'usage_update', used: 12, size: 1000 } } });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } } });
}

lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'session/cancel' && request.id == null) {
    if (pending) {
      const id = pending;
      pending = null;
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    }
    return;
  }
  if (request.id == null) return;
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (request.method === 'session/new' || request.method === 'session/load') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      sessionId: 'cursor-session',
      configOptions: [
        { id: 'mode', currentValue: 'agent', options: [{ value: 'agent' }, { value: 'plan' }, { value: 'ask' }] },
        { id: 'model', currentValue: 'composer-2.5[fast=true]', options: [{ value: 'composer-2.5[fast=true]' }, { value: 'composer-2.5[fast=false]' }, { value: 'grok-4.5[effort=high,fast=false]' }] }
      ]
    } });
  } else if (request.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: request.id, result: {} });
  else if (request.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'plan', entries: [
      { content: 'Search repo for the old name', priority: 'medium', status: 'pending' },
      { content: 'Rename and update call sites', priority: 'high', status: 'pending' }
    ] } } });
    count += 1;
    if (count === 1 && process.env.FAKE_CURSOR_WRITE === '1') {
      fs.writeFileSync('new-file.txt', 'new file\n');
      fs.writeFileSync('staged-file.txt', 'staged file\n');
      spawnSync('git', ['add', 'staged-file.txt']);
    }
    if (count === 1 && process.env.FAKE_CURSOR_OVERLAP === '1') {
      fs.appendFileSync('tracked-overlap.txt', 'agent line\n');
    }
    pending = request.id;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'tool_call', toolCallId: `tool-${count}`, title: 'Edit a.js', status: 'in_progress', locations: [{ path: 'a.js' }] } } });
    setTimeout(finish, count === 1 ? 500 : 50);
  }
});
