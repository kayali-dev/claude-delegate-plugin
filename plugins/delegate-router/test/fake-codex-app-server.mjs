#!/usr/bin/env node
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
let activeTurn = null;
let timer = null;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function complete() {
  if (!activeTurn) return;
  const turnId = activeTurn;
  activeTurn = null;
  send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-fake', turnId, itemId: 'message-1', delta: 'done' } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId, item: { type: 'agentMessage', id: 'message-1', text: 'done', phase: 'final_answer', memoryCitation: null }, completedAtMs: Date.now() } });
  send({ jsonrpc: '2.0', method: 'turn/diff/updated', params: { threadId: 'thread-fake', turnId, diff: 'diff --git a/a.js b/a.js' } });
  send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'thread-fake', turnId, tokenUsage: { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 }, modelContextWindow: 1000 } } });
  send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-fake', turn: { id: turnId, status: 'completed', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
}

lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { userAgent: 'fake' } });
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    send({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-fake' }, model: 'fake', cwd: process.cwd() } });
  } else if (request.method === 'turn/start') {
    activeTurn = `turn-${Date.now()}`;
    send({ jsonrpc: '2.0', id: request.id, result: { turn: { id: activeTurn, status: 'inProgress', items: [], itemsView: 'full', error: null } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-fake', turn: { id: activeTurn, status: 'inProgress', items: [], itemsView: 'full', error: null } } });
    send({ jsonrpc: '2.0', method: 'turn/plan/updated', params: { threadId: 'thread-fake', turnId: activeTurn, explanation: null, plan: [{ step: 'test', status: 'inProgress' }] } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: { type: 'fileChange', id: 'file-1', changes: [{ path: 'a.js', kind: 'update' }], status: 'completed' }, completedAtMs: Date.now() } });
    if (process.env.FAKE_CODEX_CRASH === '1') setTimeout(() => process.exit(7), 50);
    else timer = setTimeout(complete, 500);
  } else if (request.method === 'turn/steer') {
    send({ jsonrpc: '2.0', id: request.id, result: { turnId: activeTurn } });
  } else if (request.method === 'turn/interrupt') {
    clearTimeout(timer);
    send({ jsonrpc: '2.0', id: request.id, result: {} });
    const turnId = activeTurn;
    activeTurn = null;
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-fake', turn: { id: turnId, status: 'interrupted', items: [], itemsView: 'full', error: null } } });
  }
});
