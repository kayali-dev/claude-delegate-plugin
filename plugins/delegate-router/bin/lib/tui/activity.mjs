import { deriveToolDescriptor, normalizeCompactionEvents, toolActivityLabel, toolEventKey } from './transcript.mjs';
import { CHROME_GLYPHS, CHROME_SEPARATOR } from './glyphs.mjs';
import { formatDisplayValue } from './display.mjs';
import { classifySession, DEFAULT_SESSION_ACTIVE_SECONDS } from './sessions.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PHASES = new Set(['verifying', 'retrying', 'paused', 'starting']);

export const ACTIVITY_CAPABILITIES = Object.freeze({
  'codex:app-server': Object.freeze({ thinking: true, streaming: true, tools: true, approvals: true, needsInput: true, visibility: 'full' }),
  'codex:external': Object.freeze({ thinking: false, streaming: false, tools: false, approvals: false, needsInput: false, visibility: 'bounded-tail' }),
  'claude:agent-hook': Object.freeze({ thinking: false, streaming: false, tools: false, approvals: false, needsInput: false, visibility: 'hook-only' }),
  'cursor:acp': Object.freeze({ thinking: true, streaming: true, tools: true, approvals: true, needsInput: true, visibility: 'near-full' }),
  'cursor:headless': Object.freeze({ thinking: true, streaming: true, tools: true, approvals: false, needsInput: false, visibility: 'near-full' })
});

export function activityTransportKey(job = {}) {
  if (job.external || job.transport === 'external') return 'codex:external';
  if (job.transport === 'claude-agent') return 'claude:agent-hook';
  if (job.provider === 'cursor') return ['headless', 'direct-cli'].includes(job.transport) ? 'cursor:headless' : 'cursor:acp';
  return 'codex:app-server';
}

function eventAt(event) {
  const value = Number(event?.at || 0);
  return Number.isFinite(value) ? value : 0;
}

function elapsedText(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function result(kind, label, glyph, since, now, tone, extra = {}) {
  const ageMs = since ? Math.max(0, now - since) : 0;
  const age = elapsedText(ageMs);
  return Object.freeze({ kind, label, glyph, since: since || now, ageMs, age, tone, text: `${glyph} ${label}${since ? `${CHROME_SEPARATOR}${age}` : ''}`, ...extra });
}

const signalCache = new WeakMap();

function activitySignals(events) {
  events = normalizeCompactionEvents(events);
  if (signalCache.has(events)) return signalCache.get(events);
  const open = new Map();
  const openCompactions = new Map();
  let approval = null;
  let needsInput = null;
  let delta = null;
  let signal = null;
  for (const event of events) {
    if (event.replay === true) continue;
    if (event.type === 'turn.started') needsInput = null;
    if (event.type === 'approval.requested') approval = event;
    else if (event.type === 'approval.resolved') approval = null;
    if (event.type === 'error' && (event.data?.code === 'USER_INPUT_REQUIRED'
      || /USER_INPUT_REQUIRED/.test(String(event.data?.error || event.data?.message || '')))) needsInput = event;
    if (event.type === 'input.requested') needsInput = event;
    else if (event.type === 'input.resolved') needsInput = null;
    if (event.type === 'tool.started') {
      const key = toolEventKey(event) || `seq-${event.seq || 0}`;
      open.set(key, event);
    } else if (event.type === 'tool.completed') {
      const key = toolEventKey(event);
      if (key) open.delete(key);
    }
    if (event.type === 'file.changed' && event.data?.phase) {
      const paths = (event.data.changes || []).map((change) => change?.path || change?.file || '').filter(Boolean).join('\0');
      const key = `file:${event.data.id || paths || event.seq || 0}`;
      if (event.data.phase === 'started' || event.data.status === 'inProgress' || event.data.status === 'in_progress') open.set(key, event);
      else open.delete(key);
    }
    if (event.type === 'compaction.started') {
      openCompactions.set(formatDisplayValue(event.data?.itemId) || `seq-${event.seq || 0}`, event);
    } else if (event.type === 'compaction.completed') {
      const itemId = formatDisplayValue(event.data?.itemId);
      if (itemId) openCompactions.delete(itemId);
      else openCompactions.delete([...openCompactions.keys()].at(-1));
    }
    if (event.type === 'message.delta') delta = event;
    if (event.type === 'activity' || event.type === 'message.delta' || event.type === 'message.completed'
      || event.type === 'tool.started' || event.type === 'tool.output' || event.type === 'tool.completed'
      || event.type === 'file.changed' || event.type === 'plan.updated' || event.type === 'approval.requested' || event.type === 'approval.resolved'
      || event.type === 'input.requested' || event.type === 'input.resolved'
      || event.type === 'compaction.started' || event.type === 'compaction.completed' || event.type === 'error') signal = event;
  }
  const value = {
    approval, needsInput, delta, signal, lastEvent: events.at(-1) || null,
    openTool: [...open.entries()].sort((left, right) => eventAt(right[1]) - eventAt(left[1]))[0] || null,
    openCompaction: [...openCompactions.values()].sort((left, right) => eventAt(right) - eventAt(left))[0] || null
  };
  signalCache.set(events, value);
  return value;
}

export function deriveJobActivity(job = {}, events = [], options = {}) {
  const now = Number(options.now ?? Date.now());
  const key = activityTransportKey(job);
  const capabilities = ACTIVITY_CAPABILITIES[key];
  const signals = activitySignals(events);
  const lastEvent = signals.lastEvent;
  const lastAt = eventAt(lastEvent) || Number(job.lastActivityAt || job.updatedAt * 1000 || job.createdAt * 1000 || now);
  if (job.transport === 'claude-agent' && job.agentLifecycle === 'spawn-returned') {
    const transcriptAt = Number(job.transcriptMtimeMs || job.spawnReturnedAtMs || job.createdAtMs || lastAt);
    const { active } = classifySession(transcriptAt, { now, activeSeconds: DEFAULT_SESSION_ACTIVE_SECONDS });
    return result(active ? 'active' : 'idle', active ? 'active' : 'idle', active ? '>' : '.', transcriptAt, now, active ? 'body' : 'dim', {
      capabilities, transportKey: key, visibilityNote: 'background completion is not exposed'
    });
  }
  if (job.external || job.transport === 'external') {
    return result('external', formatDisplayValue(job.activityLabel) || 'external activity', '.', lastAt, now, 'dim', {
      capabilities, transportKey: key, visibilityNote: 'bounded read-only tail'
    });
  }
  if (TERMINAL.has(job.status)) {
    const glyph = job.status === 'completed' ? CHROME_GLYPHS.success : job.status === 'failed' ? CHROME_GLYPHS.failure : '-';
    const tone = job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'dim' : 'body';
    return result(job.status, job.status, glyph, 0, now, tone, { capabilities, transportKey: key });
  }

  if (capabilities.approvals) {
    const approval = signals.approval;
    if (approval) return result('approval', 'approval', '!', eventAt(approval), now, 'warning', { capabilities, transportKey: key, sourceSeq: approval.seq });
  }

  if (capabilities.needsInput) {
    const input = signals.needsInput;
    if (input) return result('needs-input', 'needs input', '?', eventAt(input), now, 'warning', { capabilities, transportKey: key, sourceSeq: input.seq });
  }

  if (key === 'codex:app-server' && signals.openCompaction) {
    const compaction = signals.openCompaction;
    return result('compacting', 'compacting', CHROME_GLYPHS.spinner, eventAt(compaction), now, 'accent', {
      capabilities, transportKey: key, sourceSeq: compaction.seq
    });
  }

  if (capabilities.tools) {
    const openTool = signals.openTool;
    if (openTool) {
      const [toolKey, start] = openTool;
      const tool = deriveToolDescriptor(start, null, null, { now, jobCwd: job.cwd });
      return result('tool', `tool: ${toolActivityLabel(tool)}`, '$', eventAt(start), now, 'accent', {
        capabilities, transportKey: key, sourceSeq: start.seq, toolKey, tool
      });
    }
  }

  if (capabilities.thinking) {
    const signal = signals.signal;
    if (signal?.type === 'activity' && signal.data?.kind === 'thinking') {
      return result('thinking', 'thinking', '~', eventAt(signal), now, 'accent', { capabilities, transportKey: key, sourceSeq: signal.seq });
    }
  }

  if (capabilities.streaming) {
    const delta = signals.delta;
    if (delta && now - eventAt(delta) <= Number(options.streamingMs ?? 3000)) {
      return result('streaming', 'streaming', '>', eventAt(delta), now, 'accent', { capabilities, transportKey: key, sourceSeq: delta.seq });
    }
  }

  const phase = String(job.phase || '').toLowerCase();
  if (PHASES.has(phase)) {
    const glyph = phase === 'paused' ? '||' : phase === 'starting' ? '>' : phase === 'retrying' ? '~' : '+';
    return result(phase, phase, glyph, Number(job.updatedAt || 0) * 1000 || lastAt, now, phase === 'paused' ? 'paused' : 'accent', { capabilities, transportKey: key });
  }

  const idleMs = Math.max(0, now - lastAt);
  const configuredStall = Number(options.stallSeconds ?? process.env.DELEGATE_STALL_SECONDS ?? 300);
  const stallMs = (Number.isFinite(configuredStall) && configuredStall >= 0 ? configuredStall : 300) * 1000;
  if (job.stalled || idleMs > stallMs) return result('stalled', 'stalled', '!', lastAt, now, 'failed', { capabilities, transportKey: key, idleMs });
  if (idleMs > Number(options.quietMs ?? 30_000)) return result('quiet', 'quiet', '.', lastAt, now, 'dim', { capabilities, transportKey: key, idleMs });

  return result('working', 'working', '>', lastAt, now, 'body', { capabilities, transportKey: key, idleMs, visibilityNote: null });
}
