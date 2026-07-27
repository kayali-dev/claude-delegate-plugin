#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProcess } from '../bin/lib/jsonrpc.mjs';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.144.1');
  process.exit(0);
}

if (process.env.FAKE_CODEX_SPAWN_COUNT_FILE) {
  let count = 0;
  try { count = Number(fs.readFileSync(process.env.FAKE_CODEX_SPAWN_COUNT_FILE, 'utf8')) || 0; } catch {}
  fs.writeFileSync(process.env.FAKE_CODEX_SPAWN_COUNT_FILE, `${count + 1}\n`);
}

const lines = readline.createInterface({ input: process.stdin });
let activeTurn = null;
let timer = null;
let turnCount = 0;
let backchannel = null;
let backchannelReply = null;
let activePrompt = '';
let threadModel = null;
let interrogationQuestion = null;

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
  const planPass = activePrompt.includes('PLAN PASS ONLY');
  const variant = process.env.FAKE_CODEX_DIVERGENT_MODEL && String(threadModel).includes(process.env.FAKE_CODEX_DIVERGENT_MODEL)
    ? 'divergent'
    : 'convergent';
  const structuralPlan = variant === 'divergent'
    ? {
        targets: { files: ['src/alternate.js'], components: ['alternate-engine'] },
        approach: [{ kind: 'refactor', component: 'alternate-engine' }, { kind: 'test', component: 'alternate-engine' }],
        assumptions: [{ topic: 'ownership', choice: 'replace the alternate engine' }],
        risks: ['alternate path']
      }
    : {
        targets: { files: ['a.js', 'test/a.test.js'], components: ['core-engine'] },
        approach: [{ kind: 'edit', component: 'core-engine' }, { kind: 'test', component: 'core-engine' }],
        assumptions: [{ topic: 'ownership', choice: 'extend the core engine' }],
        risks: ['shared state']
      };
  const reply = interrogationQuestion
    ? `INTERROGATION ${interrogationQuestion.id}: the failing check said expected 2 but received 3; no action was taken.`
    : planPass && process.env.FAKE_CODEX_INCONCLUSIVE_MODEL && String(threadModel).includes(process.env.FAKE_CODEX_INCONCLUSIVE_MODEL)
      ? 'I need more context before I can produce a structural plan.'
      : planPass
        ? `\`\`\`json\n${JSON.stringify(structuralPlan)}\n\`\`\``
        : process.env.FAKE_CODEX_NUDGE === '1'
    ? turnCount === 1 ? 'I prepared the requested deliverable.' : `Complete findings inline: ${'evidence '.repeat(30)}`
    : backchannelReply || process.env.FAKE_CODEX_REPLY || 'done';
  send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-fake', turnId, itemId: 'message-1', delta: reply } });
  send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId, item: { type: 'agentMessage', id: 'message-1', text: reply, phase: 'final_answer', memoryCitation: null }, completedAtMs: Date.now() } });
  send({ jsonrpc: '2.0', method: 'turn/diff/updated', params: { threadId: 'thread-fake', turnId, diff: 'diff --git a/a.js b/a.js' } });
  sendUsage(turnId, Math.max(2, turnCount * 10 + (interrogationQuestion ? 4 : 0)));
  send({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 41, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 7, resetsAt: Math.floor(Date.now() / 1000) + 604800 } } } });
  send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-fake', turn: { id: turnId, status: 'completed', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
  interrogationQuestion = null;
}

lines.on('line', async (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_CODEX_REQUEST_LOG && request.id != null) {
    fs.appendFileSync(process.env.FAKE_CODEX_REQUEST_LOG, `${JSON.stringify({ method: request.method, params: request.params })}\n`);
  }
  if (request.id == null) return;
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { userAgent: 'fake' } });
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    threadModel = request.params?.model || threadModel;
    backchannel = request.params?.config?.mcp_servers?.delegate_backchannel || null;
    if (process.env.FAKE_CODEX_REJECT_BACKCHANNEL === '1' && backchannel) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'fake rejected MCP config' } });
      return;
    }
    send({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'thread-fake' }, model: 'fake', cwd: process.cwd() } });
  } else if (request.method === 'turn/start') {
    turnCount += 1;
    activePrompt = request.params?.input?.map((item) => item.text || '').join('\n') || '';
    activeTurn = `turn-${Date.now()}`;
    send({ jsonrpc: '2.0', id: request.id, result: { turn: { id: activeTurn, status: 'inProgress', items: [], itemsView: 'full', error: null } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-fake', turn: { id: activeTurn, status: 'inProgress', items: [], itemsView: 'full', error: null } } });
    send({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-fake', turnId: activeTurn, item: { type: 'reasoning', id: 'reasoning-1' } } });
    if (process.env.FAKE_CODEX_COMPACTION === '1') {
      send({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-fake', turnId: activeTurn, item: { type: 'contextCompaction', id: 'compaction-1' } } });
    }
    send({ jsonrpc: '2.0', method: 'turn/plan/updated', params: { threadId: 'thread-fake', turnId: activeTurn, explanation: null, plan: [{ step: 'test', status: 'inProgress' }] } });
    const fileChanges = activePrompt.includes('PLAN PASS ONLY')
      ? 0
      : Math.max(0, Number(process.env.FAKE_CODEX_FILE_CHANGES ?? 1));
    if (!activePrompt.includes('PLAN PASS ONLY') && process.env.FAKE_CODEX_WRITE_PATH) {
      const target = path.resolve(process.cwd(), process.env.FAKE_CODEX_WRITE_PATH);
      const relative = path.relative(process.cwd(), target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('FAKE_CODEX_WRITE_PATH must stay inside the fake provider cwd');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, process.env.FAKE_CODEX_WRITE_CONTENT || 'fake provider write\n');
    }
    for (let index = 0; index < fileChanges; index += 1) {
      const changedPath = index === 0 ? 'a.js' : `file-${index}.js`;
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: { type: 'fileChange', id: `file-${index}`, changes: [{ path: changedPath, kind: 'update' }], status: 'completed' }, completedAtMs: Date.now() } });
    }
    if (process.env.FAKE_CODEX_COLLAB === '1') {
      const prompt = 'Inspect the implementation and return the complete findings';
      const output = `Subagent completed the delegated review. ${'Detailed evidence from the delegated agent. '.repeat(40)}`;
      const agent = { threadId: 'agent-fake-1', agentNickname: 'reviewer', agentRole: 'reviewer' };
      send({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-fake', turnId: activeTurn, item: {
        type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'inProgress',
        receiverThreadIds: ['agent-fake-1'], receiverAgents: [agent], prompt,
        agentsStates: { 'agent-fake-1': 'running' }
      } } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: {
        type: 'subAgentActivity', id: 'activity-1', kind: 'started',
        agentThreadId: 'agent-fake-1', agentPath: 'root/reviewer'
      }, completedAtMs: Date.now() } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: {
        type: 'subAgentActivity', id: 'activity-2', kind: 'interacted',
        agentThreadId: 'agent-fake-1', agentPath: 'root/reviewer'
      }, completedAtMs: Date.now() } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: {
        type: 'collabAgentToolCall', id: 'collab-1', tool: 'wait', status: 'completed',
        receiverThreadIds: ['agent-fake-1'], receiverAgents: [agent], prompt,
        agentsStates: { 'agent-fake-1': { completed: output } }
      }, completedAtMs: Date.now() } });
    }
    if (process.env.FAKE_CODEX_COMPACTION === '1') {
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-fake', turnId: activeTurn, item: { type: 'contextCompaction', id: 'compaction-1' }, completedAtMs: Date.now() } });
    }
    if (process.env.FAKE_CODEX_BACKCHANNEL === '1') {
      if (!backchannel?.command || !Array.isArray(backchannel.args)) {
        send({ jsonrpc: '2.0', method: 'error', params: { threadId: 'thread-fake', turnId: activeTurn, message: 'back-channel was not injected' } });
        process.exit(8);
      }
      const broker = new JsonRpcProcess(backchannel.command, backchannel.args, { cwd: process.cwd() });
      try {
        send({ jsonrpc: '2.0', method: 'turn/diff/updated', params: {
          threadId: 'thread-fake',
          turnId: activeTurn,
          diff: 'diff --git a/a.js b/a.js\n+work completed before the question'
        } });
        await broker.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'fake-codex-provider', version: '1' } });
        const response = await broker.request('tools/call', {
          name: 'ask_coordinator',
          arguments: {
            question: 'Which implementation target should use API_KEY=question-secret-value?',
            options: ['src', 'test'],
            urgency: 'blocking'
          }
        }, 10_000);
        backchannelReply = response.content?.[0]?.text || JSON.stringify(response);
      } finally {
        await broker.stop();
      }
      complete();
      return;
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
    const text = request.params?.input?.map((item) => item.text || '').join('\n') || '';
    const match = text.match(/READ-ONLY INTERROGATION ([A-Za-z0-9_-]+)/);
    if (match) interrogationQuestion = { id: match[1], text };
    send({ jsonrpc: '2.0', id: request.id, result: { turnId: activeTurn } });
  } else if (request.method === 'turn/interrupt') {
    clearTimeout(timer);
    send({ jsonrpc: '2.0', id: request.id, result: {} });
    const turnId = activeTurn;
    activeTurn = null;
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-fake', turn: { id: turnId, status: 'interrupted', items: [], itemsView: 'full', error: null } } });
  }
});
