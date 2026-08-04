import fs from 'node:fs';
import { JsonRpcProcess } from './jsonrpc.mjs';
import { redact } from './control.mjs';

export const CODEX_SUBAGENT_DISCOVERY_MIN_VERSION = '0.143.0';
export const CHILD_TRANSCRIPT_MAX_EVENTS = 500;
export const CHILD_TRANSCRIPT_MAX_CHARS = 512 * 1024;

const CHILD_TEXT_MAX = 16 * 1024;
const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_THREADS = 500;

function versionParts(value) {
  const match = String(value || '').match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/);
  return match ? match.slice(1).map((part) => Number(part || 0)) : null;
}

export function compareCodexVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function supportsCodexSubagentDiscovery(version) {
  const comparison = compareCodexVersions(version, CODEX_SUBAGENT_DISCOVERY_MIN_VERSION);
  return comparison != null && comparison >= 0;
}

function safeText(value, max = CHILD_TEXT_MAX) {
  return String(redact(String(value ?? ''), '', max) || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, max);
}

function token(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
}

function statusType(value) {
  if (typeof value === 'string') return safeText(value, 64) || 'unknown';
  return safeText(value?.type || value?.status, 64) || 'unknown';
}

function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 100_000_000_000 ? number * 1000 : number;
}

function childVersion(job = {}) {
  return job.outcomeProvenance?.providerCliVersion || job.providerCliVersion || null;
}

function packageVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function unsupportedDiscovery(message, details = {}) {
  return Object.assign(new Error(message), { code: 'SUBAGENT_DISCOVERY_UNSUPPORTED', ...details });
}

export function isCodexSubagentDiscoveryUnsupported(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 'SUBAGENT_DISCOVERY_UNSUPPORTED'
    || Number(error?.rpcCode) === -32601
    || message.includes('requires experimentalapi capability')
    || message.includes('not supported yet')
    || message.includes('method not found');
}

export function sanitizeCodexChildThread(thread = {}) {
  const id = safeText(thread.id, 256);
  if (!id) return null;
  return {
    id,
    parentThreadId: safeText(thread.parentThreadId, 256) || null,
    agentName: safeText(thread.agentNickname || thread.name, 256) || '',
    role: safeText(thread.agentRole, 256) || '',
    task: safeText(thread.preview, 2048) || '',
    status: statusType(thread.status),
    model: safeText(thread.model || thread.modelProvider, 256) || '',
    cwd: safeText(thread.cwd, 2048) || '',
    createdAtMs: timestampMs(thread.createdAt),
    updatedAtMs: timestampMs(thread.updatedAt || thread.recencyAt)
  };
}

function userText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => token(part?.type) === 'text')
    .map((part) => safeText(part?.text))
    .filter(Boolean)
    .join('\n');
}

function itemEvents(item, at, phase = 'snapshot') {
  const kind = token(item?.type);
  const id = safeText(item?.id, 256) || `child-item-${at}`;
  if (kind === 'agent_message_delta') {
    const delta = safeText(item.delta);
    return delta ? [{ type: 'message.delta', at, data: { id, role: 'assistant', delta } }] : [];
  }
  if (kind === 'command_execution_output_delta') {
    const delta = safeText(item.delta);
    return delta ? [{ type: 'tool.output', at, data: { id, toolCallId: id, delta } }] : [];
  }
  if (kind === 'user_message') {
    if (phase === 'started') return [];
    const text = userText(item.content);
    return text ? [{ type: 'message.user', at, data: { id, role: 'user', text } }] : [];
  }
  if (kind === 'agent_message') {
    if (phase === 'started') return [];
    const text = safeText(item.text);
    return text ? [{ type: 'message.completed', at, data: { id, role: 'assistant', text } }] : [];
  }
  if (kind === 'plan') {
    if (phase === 'started') return [];
    const text = safeText(item.text);
    return text ? [{ type: 'plan.updated', at, data: { id, text } }] : [];
  }
  if (kind === 'plan_live_update') {
    const text = safeText(item.text);
    return text ? [{ type: 'plan.updated', at, data: { id, text } }] : [];
  }
  if (kind === 'command_execution') {
    const command = safeText(item.command, 4096);
    const output = safeText(item.aggregatedOutput);
    return [
      ...(phase !== 'completed' ? [{ type: 'tool.started', at, data: { id, toolCallId: id, name: 'command', command, cwd: safeText(item.cwd, 2048), status: safeText(item.status, 64) || 'completed' } }] : []),
      ...(phase !== 'started' && output ? [{ type: 'tool.output', at, data: { id, toolCallId: id, output } }] : []),
      ...(phase !== 'started' ? [{ type: 'tool.completed', at, data: { id, toolCallId: id, name: 'command', command, status: safeText(item.status, 64) || 'completed', exitCode: Number.isFinite(Number(item.exitCode)) ? Number(item.exitCode) : null } }] : [])
    ];
  }
  if (['mcp_tool_call', 'dynamic_tool_call', 'collab_tool_call'].includes(kind)) {
    const name = safeText(item.tool || item.name || item.server || kind, 256);
    const status = safeText(item.status, 64) || 'completed';
    return [
      ...(phase !== 'completed' ? [{ type: 'tool.started', at, data: { id, toolCallId: id, name, status } }] : []),
      ...(phase !== 'started' ? [{ type: 'tool.completed', at, data: { id, toolCallId: id, name, status } }] : [])
    ];
  }
  if (kind === 'file_change') {
    if (phase === 'started') return [];
    return (Array.isArray(item.changes) ? item.changes : []).flatMap((change) => {
      const changedPath = safeText(change?.path, 2048);
      return changedPath ? [{ type: 'file.changed', at, data: { path: changedPath, action: safeText(change?.kind, 64) || 'update' } }] : [];
    });
  }
  return [];
}

function projectedEvents(items, at, phase = 'snapshot') {
  const events = [];
  let droppedReasoningCount = 0;
  for (const item of items) {
    const kind = token(item?.type);
    if (kind.includes('reasoning') || kind.includes('thought')) {
      droppedReasoningCount += 1;
      continue;
    }
    events.push(...itemEvents(item, at, phase));
  }
  return { events, droppedReasoningCount };
}

export function projectCodexChildSnapshot(thread = {}, options = {}) {
  const events = [];
  let chars = 0;
  let droppedReasoningCount = 0;
  let truncated = false;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  outer: for (const turn of turns) {
    const at = timestampMs(turn?.completedAt || turn?.startedAt) || Number(options.now || Date.now());
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const batch = projectedEvents([item], at);
      droppedReasoningCount += batch.droppedReasoningCount;
      for (const projected of batch.events) {
        const size = JSON.stringify(projected).length;
        if (events.length >= CHILD_TRANSCRIPT_MAX_EVENTS || chars + size > CHILD_TRANSCRIPT_MAX_CHARS) {
          truncated = true;
          break outer;
        }
        chars += size;
        events.push({ schemaVersion: 1, seq: events.length + 1, redacted: true, ...projected });
      }
    }
  }
  const status = statusType(thread.status);
  return {
    thread: sanitizeCodexChildThread(thread),
    events,
    status,
    pointInTime: status === 'active' || turns.some((turn) => /progress|active|running/i.test(String(turn?.status || ''))),
    truncated,
    droppedReasoningCount,
    capturedAtMs: Number(options.now || Date.now())
  };
}

export function projectCodexChildNotification(method, params = {}, options = {}) {
  const at = timestampMs(params.completedAtMs || params.startedAtMs || params.at) || Number(options.now || Date.now());
  let items = [];
  let phase = 'completed';
  if (method === 'item/started' || method === 'item/completed') {
    items = params.item ? [params.item] : [];
    phase = method === 'item/started' ? 'started' : 'completed';
  } else if (method === 'item/agentMessage/delta') {
    items = [{ type: 'agentMessageDelta', id: params.itemId, delta: params.delta }];
  } else if (method === 'item/commandExecution/outputDelta') {
    items = [{ type: 'commandExecutionOutputDelta', id: params.itemId, delta: params.delta }];
  } else if (method === 'turn/plan/updated') {
    items = [{
      type: 'planLiveUpdate', id: params.turnId || `child-plan-${at}`,
      text: params.explanation || (Array.isArray(params.plan) ? params.plan.map((entry) => entry?.step).filter(Boolean).join('\n') : '')
    }];
  }
  const projected = projectedEvents(items, at, phase);
  if (/reasoning|thought/i.test(String(method))) projected.droppedReasoningCount += 1;
  const status = method === 'thread/status/changed' ? statusType(params.status) : null;
  return {
    events: projected.events.map((event, index) => ({ schemaVersion: 1, seq: index + 1, redacted: true, ...event })),
    droppedReasoningCount: projected.droppedReasoningCount,
    status,
    pointInTime: status == null ? null : status === 'active',
    capturedAtMs: at
  };
}

export class CodexSubagentClient {
  constructor(job, options = {}) {
    this.job = job;
    this.binary = options.binary || process.env.DELEGATE_CODEX_BIN || 'codex';
    this.version = options.version || childVersion(job);
    this.rpcFactory = options.rpcFactory || ((command, args, rpcOptions) => new JsonRpcProcess(command, args, rpcOptions));
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs || 15_000));
    this.rpc = null;
    this.starting = null;
  }

  get discoverySupported() {
    return supportsCodexSubagentDiscovery(this.version);
  }

  async start() {
    if (this.rpc) return this.rpc;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const rpc = this.rpcFactory(this.binary, ['app-server', '--stdio'], {
        cwd: this.job.cwd,
        requestTimeoutMs: this.requestTimeoutMs,
        onRequest: async (method) => { throw new Error(`read-only subagent client does not handle ${method}`); },
        onNotification: () => {},
        onStderr: () => {}
      });
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'delegate-router-tui', title: 'Delegate Router TUI', version: packageVersion() },
          capabilities: { experimentalApi: true, requestAttestation: false }
        });
        rpc.notify('initialized', {});
        this.rpc = rpc;
        return rpc;
      } catch (error) {
        await rpc.stop().catch(() => {});
        throw error;
      }
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async discover(ancestorThreadId) {
    if (!this.discoverySupported) {
      throw unsupportedDiscovery(`Codex ${this.version || 'version unknown'} is outside the version-gated subagent discovery surface`, { version: this.version });
    }
    const rpc = await this.start();
    const threads = [];
    let cursor = null;
    let capped = false;
    do {
      const page = await rpc.request('thread/list', {
        ancestorThreadId,
        cursor,
        limit: DISCOVERY_PAGE_SIZE,
        sortKey: 'created_at',
        sortDirection: 'asc'
      });
      for (const value of Array.isArray(page?.data) ? page.data : []) {
        const thread = sanitizeCodexChildThread(value);
        if (thread) threads.push(thread);
        if (threads.length >= DISCOVERY_MAX_THREADS) {
          capped = Boolean(page?.nextCursor) || (Array.isArray(page?.data) && page.data.indexOf(value) < page.data.length - 1);
          break;
        }
      }
      if (threads.length >= DISCOVERY_MAX_THREADS) break;
      cursor = page?.nextCursor || null;
    } while (cursor);
    return { threads, capped, version: this.version };
  }

  async read(threadId, options = {}) {
    const rpc = await this.start();
    const result = await rpc.request('thread/read', { threadId, includeTurns: true });
    return projectCodexChildSnapshot(result?.thread || {}, options);
  }

  async close() {
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) await rpc.stop().catch(() => {});
  }
}
