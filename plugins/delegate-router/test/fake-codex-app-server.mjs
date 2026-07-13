#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.144.1');
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
let activeTurn = null;
let timer = null;

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function sendUsage(turnId, outputTokens) {
  send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
    threadId: 'thread-fake',
    turnId,
    tokenUsage: {
      total: { inputTokens: 10, outputTokens },
      last: { inputTokens: 10, outputTokens },
      modelContextWindow: 1000
    }
  } });
}
function complete() {
  if (!activeTurn) return;
  const turnId = activeTurn;
  activeTurn = null;
  send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-fake', turnId, itemId: 'message-1', delta: 'done' } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId, item: { type: 'agentMessage', id: 'message-1', text: 'done', phase: 'final_answer', memoryCitation: null }, completedAtMs: Date.now() } });
  send({ jsonrpc: '2.0', method: 'turn/diff/updated', params: { threadId: 'thread-fake', turnId, diff: 'diff --git a/a.js b/a.js' } });
  sendUsage(turnId, 2);
  send({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 41, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 7, resetsAt: Math.floor(Date.now() / 1000) + 604800 } } } });
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
    if (process.env.FAKE_CODEX_COLLAB === '1') {
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: { type: 'collabAgentToolCall', id: 'collab-1', status: 'completed' }, completedAtMs: Date.now() } });
    }
    const crashOnceMarker = path.join(process.cwd(), '.fake-codex-crashed-once');
    const shouldCrashOnce = process.env.FAKE_CODEX_CRASH_ONCE === '1' && !fs.existsSync(crashOnceMarker);
    if (shouldCrashOnce) fs.writeFileSync(crashOnceMarker, 'crashed\n');
    if (process.env.FAKE_CODEX_CRASH === '1' || shouldCrashOnce) setTimeout(() => process.exit(7), 50);
    else if (process.env.FAKE_CODEX_GROWING_USAGE === '1') {
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-fake', turnId: activeTurn, itemId: 'message-partial', delta: 'partial work' } });
      send({ jsonrpc: '2.0', method: 'turn/diff/updated', params: { threadId: 'thread-fake', turnId: activeTurn, diff: 'diff --git a/partial.js b/partial.js\n+partial' } });
      sendUsage(activeTurn, 2);
      setTimeout(() => { if (activeTurn) sendUsage(activeTurn, 6); }, 50);
      timer = setTimeout(complete, 500);
    } else timer = setTimeout(complete, 500);
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
