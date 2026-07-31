#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--version')) {
  console.log('cursor-agent 2026.07.09-a3815c0');
  process.exit(0);
}

if (process.argv.includes('models')) {
  console.log('composer-2.5 - Composer');
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
let pending = null;
let count = 0;
let currentMode = 'agent';

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function finish() {
  if (!pending) return;
  const { id, text } = pending;
  pending = null;
  const structuralPlan = {
    targets: { files: ['a.js', 'test/a.test.js'], components: ['cursor-core'] },
    approach: [{ kind: 'edit', component: 'cursor-core' }, { kind: 'test', component: 'cursor-core' }],
    assumptions: [{ topic: 'ownership', choice: 'extend cursor core' }],
    risks: ['shared state']
  };
  const planResponse = process.env.FAKE_CURSOR_PLAN_RESPONSE || 'valid';
  const answer = text.includes('PLAN PASS ONLY')
    ? planResponse === 'invalid'
      ? 'I inspected the task and prepared the requested plan, but there is no structural JSON deliverable.'
      : planResponse === 'narrated-valid'
        ? `I inspected the bounded task.\n\n${JSON.stringify(structuralPlan)}\n\nThat is the recommended plan.`
        : `\`\`\`json\n${JSON.stringify(structuralPlan)}\n\`\`\``
    : text.includes('READ-ONLY INTERROGATION')
      ? `${text.match(/READ-ONLY INTERROGATION ([A-Za-z0-9_-]+)/)?.[1] || 'question'}: expected 2 but received 3; no action was taken`
      : `answer-${count}`;
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_message_chunk', messageId: `message-${count}`, content: { type: 'text', text: answer } } } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'usage_update', used: 12, size: 1000 } } });
  const configuredPlanTokens = Number(process.env.FAKE_CURSOR_PLAN_OUTPUT_TOKENS);
  const outputTokens = text.includes('PLAN PASS ONLY')
    && Number.isFinite(configuredPlanTokens)
    && configuredPlanTokens >= 0
    ? configuredPlanTokens
    : count * 3;
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: count * 5, outputTokens } } });
}

lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_CURSOR_REQUEST_LOG && request.id != null) {
    fs.appendFileSync(process.env.FAKE_CURSOR_REQUEST_LOG, `${JSON.stringify({ method: request.method, params: request.params })}\n`);
  }
  if (request.method === 'session/cancel' && request.id == null) {
    if (pending) {
      const id = pending.id;
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
  } else if (request.method === 'session/set_config_option') {
    if (request.params?.configId === 'mode') currentMode = request.params.value;
    send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
  else if (request.method === 'session/prompt') {
    const promptText = request.params?.prompt?.map((item) => item.text || '').join('\n') || '';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'plan', entries: [
      { content: 'Search repo for the old name', priority: 'medium', status: 'pending' },
      { content: 'Rename and update call sites', priority: 'high', status: 'pending' }
    ] } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_thought_chunk' } } });
    count += 1;
    if (count === 1 && currentMode === 'agent' && process.env.FAKE_CURSOR_WRITE === '1') {
      fs.writeFileSync('new-file.txt', 'new file\n');
      fs.writeFileSync('staged-file.txt', 'staged file\n');
      spawnSync('git', ['add', 'staged-file.txt']);
    }
    if (count === 1 && process.env.FAKE_CURSOR_OVERLAP === '1') {
      fs.appendFileSync('tracked-overlap.txt', 'agent line\n');
    }
    if (count === 1 && process.env.FAKE_CURSOR_INGEST === '1') {
      const staging = path.join(process.cwd(), '.delegate-staging');
      const jobDirectory = fs.readdirSync(staging).map((name) => path.join(staging, name)).find((item) => fs.statSync(item).isDirectory());
      const staged = fs.readdirSync(jobDirectory).map((name) => path.join(jobDirectory, name)).find((item) => fs.statSync(item).isFile());
      fs.appendFileSync(staged, 'changed by provider\n');
    }
    pending = { id: request.id, text: promptText };
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'tool_call', toolCallId: `tool-${count}`, title: 'Edit a.js', status: 'in_progress', locations: [{ path: 'a.js' }] } } });
    setTimeout(finish, count === 1 ? 500 : 50);
  }
});
