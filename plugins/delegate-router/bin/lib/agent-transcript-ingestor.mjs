import fs from 'node:fs';
import path from 'node:path';
import { appendJobEventsAndUpdate, redact } from './control.mjs';
import { loadJob } from './state.mjs';
import {
  resolveStoredAgentTranscriptPath,
  transcriptAgentIdForJob,
  transcriptPathMatchesAgentId
} from './agent-transcript-paths.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const DEFAULT_AGENT_EVENT_BYTES = 16 * 1024;
export const DEFAULT_AGENT_EVENT_LIMIT = 10_000;
export const DEFAULT_AGENT_READ_BYTES = 1024 * 1024;
export const DEFAULT_AGENT_LINE_BYTES = 512 * 1024;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function utf8Prefix(value, maximum) {
  const text = String(value || '');
  if (byteLength(text) <= maximum) return text;
  const suffix = '\n[TRUNCATED]';
  const budget = Math.max(0, maximum - byteLength(suffix));
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}${suffix}`;
}

function boundedUserText(value, maximum) {
  const safe = String(redact(String(value ?? ''), '', Number.POSITIVE_INFINITY));
  return { value: utf8Prefix(safe, maximum), truncated: byteLength(safe) > maximum };
}

function boundedUserPayload(value, maximum) {
  const safe = redact(value, '', Number.POSITIVE_INFINITY);
  let serialized;
  try { serialized = JSON.stringify(safe); }
  catch { serialized = JSON.stringify(String(safe)); }
  if (byteLength(serialized) <= maximum) return { value: safe, truncated: false };
  const preview = utf8Prefix(serialized, Math.max(64, maximum - 64));
  return { value: { truncated: true, preview }, truncated: true };
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cacheReadInputTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = tokenCount(usage.cache_creation_input_tokens);
  if (!(inputTokens || outputTokens || cacheReadInputTokens || cacheCreationInputTokens)) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens
  };
}

function sameUsage(left, right) {
  return left?.inputTokens === right?.inputTokens
    && left?.outputTokens === right?.outputTokens
    && left?.totalTokens === right?.totalTokens
    && left?.cacheReadInputTokens === right?.cacheReadInputTokens
    && left?.cacheCreationInputTokens === right?.cacheCreationInputTokens;
}

function initialTotals(value = {}) {
  return {
    inputTokens: tokenCount(value.inputTokens),
    outputTokens: tokenCount(value.outputTokens),
    totalTokens: tokenCount(value.totalTokens),
    cacheReadInputTokens: tokenCount(value.cacheReadInputTokens),
    cacheCreationInputTokens: tokenCount(value.cacheCreationInputTokens)
  };
}

export function initialClaudeTranscriptState(value = {}) {
  return {
    lastMessageId: typeof value.lastMessageId === 'string' ? value.lastMessageId : null,
    activeMessageOpen: value.activeMessageOpen === true,
    activeMessageHasText: value.activeMessageHasText === true,
    activeMessageText: typeof value.activeMessageText === 'string' ? value.activeMessageText : '',
    usageByMessage: Array.isArray(value.usageByMessage)
      ? value.usageByMessage.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string').map(([id, usage]) => [id, initialTotals(usage)])
      : [],
    usageTotals: initialTotals(value.usageTotals),
    observedModel: typeof value.observedModel === 'string' ? value.observedModel : null,
    ingestedEvents: tokenCount(value.ingestedEvents),
    omittedEvents: tokenCount(value.omittedEvents),
    payloadTruncations: tokenCount(value.payloadTruncations),
    invalidLines: tokenCount(value.invalidLines),
    oversizedLines: tokenCount(value.oversizedLines),
    eventLimitMarkerEmitted: value.eventLimitMarkerEmitted === true,
    payloadMarkerEmitted: value.payloadMarkerEmitted === true,
    invalidMarkerEmitted: value.invalidMarkerEmitted === true,
    oversizedMarkerEmitted: value.oversizedMarkerEmitted === true
  };
}

function contentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (message?.content && typeof message.content === 'object') return [message.content];
  if (typeof message?.content === 'string') return [{ type: 'text', text: message.content }];
  return [];
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    try { return JSON.stringify(item); } catch { return String(item); }
  }).join('\n');
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function fileChangeForTool(block, maximum) {
  const name = String(block?.name || '');
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return null;
  const input = block?.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
  const rawPath = name === 'NotebookEdit'
    ? input.notebook_path ?? input.notebookPath ?? input.file_path ?? input.filePath ?? input.path
    : input.file_path ?? input.filePath ?? input.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const safePath = boundedUserText(rawPath, maximum);
  const change = { path: safePath.value, kind: name === 'Write' ? 'create' : 'edit' };
  return { change, truncated: safePath.truncated };
}

function lineArray(lines) {
  if (Array.isArray(lines)) return lines.map((line) => String(line));
  if (typeof lines !== 'string') return [];
  return lines.split(/\r?\n/).filter((line) => line.length > 0);
}

// Pure and offset-agnostic: callers supply only complete JSONL lines plus the
// persisted accumulator. No I/O, timers, mutable module state, or raw provider
// records escape this function.
export function normalizeClaudeAgentTranscript(lines, carried = {}, options = {}) {
  const state = initialClaudeTranscriptState(carried);
  const events = [];
  const usageByMessage = new Map(state.usageByMessage);
  const maxEventBytes = positiveInteger(options.maxEventBytes, DEFAULT_AGENT_EVENT_BYTES, 1024);
  const maxEvents = positiveInteger(options.maxEvents, DEFAULT_AGENT_EVENT_LIMIT, 1);
  const maxLineBytes = positiveInteger(options.maxLineBytes, DEFAULT_AGENT_LINE_BYTES, 1024);

  const marker = (reason, data) => events.push({
    type: 'journal.truncated',
    data: { source: 'claude-transcript', reason, ...data }
  });
  const emit = (type, data, truncated = false) => {
    if (state.ingestedEvents >= maxEvents) {
      state.omittedEvents += 1;
      if (!state.eventLimitMarkerEmitted) {
        state.eventLimitMarkerEmitted = true;
        marker('event-limit', {
          eventLimit: maxEvents,
          ingestedEvents: state.ingestedEvents,
          omittedEvents: state.omittedEvents
        });
      }
      return;
    }
    events.push({ type, data });
    state.ingestedEvents += 1;
    if (truncated) {
      state.payloadTruncations += 1;
      if (!state.payloadMarkerEmitted) {
        state.payloadMarkerEmitted = true;
        marker('event-bytes', {
          perEventBytes: maxEventBytes,
          ingestedEvents: state.ingestedEvents,
          payloadTruncations: state.payloadTruncations
        });
      }
    }
  };
  const completeActiveMessage = () => {
    if (!state.activeMessageOpen || !state.activeMessageHasText) return;
    const text = boundedUserText(state.activeMessageText, Math.max(256, maxEventBytes - 512));
    emit('message.completed', { id: state.lastMessageId, text: text.value }, text.truncated);
    state.activeMessageOpen = false;
    state.activeMessageHasText = false;
    state.activeMessageText = '';
  };
  const beginMessage = (messageId) => {
    if (state.activeMessageOpen && state.lastMessageId !== messageId) completeActiveMessage();
    if (!state.activeMessageOpen || state.lastMessageId !== messageId) {
      state.lastMessageId = messageId;
      state.activeMessageOpen = true;
      state.activeMessageHasText = false;
      state.activeMessageText = '';
    }
  };

  for (const line of lineArray(lines)) {
    if (state.eventLimitMarkerEmitted) {
      state.omittedEvents += 1;
      continue;
    }
    if (byteLength(line) > maxLineBytes) {
      state.oversizedLines += 1;
      if (!state.oversizedMarkerEmitted) {
        state.oversizedMarkerEmitted = true;
        marker('line-bytes', { maxLineBytes, oversizedLines: state.oversizedLines });
      }
      continue;
    }
    let record;
    try { record = JSON.parse(line); }
    catch {
      state.invalidLines += 1;
      if (!state.invalidMarkerEmitted) {
        state.invalidMarkerEmitted = true;
        marker('invalid-json', { invalidLines: state.invalidLines });
      }
      continue;
    }
    const message = record?.message;
    const role = String(message?.role || record?.type || '');
    const rawMessageId = typeof message?.id === 'string' ? message.id : null;
    const messageId = rawMessageId ? boundedUserText(rawMessageId, 256).value : null;
    if (role === 'assistant' && messageId) beginMessage(messageId);
    if (!state.observedModel && typeof message?.model === 'string') {
      state.observedModel = boundedUserText(message.model, 128).value || null;
    }

    for (const block of contentBlocks(message)) {
      if (!block || typeof block !== 'object') continue;
      if (role === 'assistant' && block.type === 'thinking') {
        emit('activity', { kind: 'reasoning' });
        continue;
      }
      if (role === 'assistant' && block.type === 'text') {
        const text = boundedUserText(block.text, Math.max(256, maxEventBytes - 512));
        emit('message.delta', { id: messageId, delta: text.value }, text.truncated);
        if (messageId) {
          state.activeMessageHasText = true;
          const combined = boundedUserText(`${state.activeMessageText}${block.text ?? ''}`, Math.max(256, maxEventBytes - 512));
          state.activeMessageText = combined.value;
          if (combined.truncated) {
            state.payloadTruncations += 1;
            if (!state.payloadMarkerEmitted) {
              state.payloadMarkerEmitted = true;
              marker('event-bytes', {
                perEventBytes: maxEventBytes,
                ingestedEvents: state.ingestedEvents,
                payloadTruncations: state.payloadTruncations
              });
            }
          }
        }
        continue;
      }
      if (role === 'assistant' && block.type === 'tool_use') {
        const toolCallId = boundedUserText(block.id, 256);
        const title = boundedUserText(block.name, 256);
        const args = boundedUserPayload(block.input, Math.max(512, Math.floor(maxEventBytes / 2)));
        emit('tool.started', {
          toolCallId: toolCallId.value,
          title: title.value,
          kind: title.value,
          args: args.value
        }, toolCallId.truncated || title.truncated || args.truncated);
        const file = fileChangeForTool(block, Math.max(256, maxEventBytes - 512));
        if (file) emit('file.changed', { changes: [file.change], phase: 'started' }, file.truncated);
        continue;
      }
      if (role === 'user' && block.type === 'tool_result') {
        const toolCallId = boundedUserText(block.tool_use_id, 256);
        const output = boundedUserText(toolResultText(block.content), Math.max(256, maxEventBytes - 512));
        const data = {
          toolCallId: toolCallId.value,
          status: block.is_error === true ? 'failed' : 'completed',
          output: output.value
        };
        emit('tool.completed', data, toolCallId.truncated || output.truncated);
        emit('tool.output', { toolCallId: toolCallId.value, output: output.value }, toolCallId.truncated || output.truncated);
      }
    }

    if (role === 'assistant' && messageId) {
      const usage = normalizedUsage(message?.usage);
      if (usage) {
        const previous = usageByMessage.get(messageId);
        if (!sameUsage(previous, usage)) {
          for (const name of Object.keys(state.usageTotals)) {
            state.usageTotals[name] = Math.max(0, state.usageTotals[name] - Number(previous?.[name] || 0) + usage[name]);
          }
          usageByMessage.set(messageId, usage);
          emit('usage.updated', {
            ...state.usageTotals,
            source: 'claude-transcript'
          });
        }
      }
    }
  }

  if (options.final === true) completeActiveMessage();
  state.usageByMessage = [...usageByMessage.entries()];
  return { events, state };
}

function resetForReplacement(checkpoint) {
  return initialClaudeTranscriptState({
    ingestedEvents: checkpoint.ingestedEvents,
    omittedEvents: checkpoint.omittedEvents,
    payloadTruncations: checkpoint.payloadTruncations,
    invalidLines: checkpoint.invalidLines,
    oversizedLines: checkpoint.oversizedLines,
    eventLimitMarkerEmitted: checkpoint.eventLimitMarkerEmitted,
    payloadMarkerEmitted: checkpoint.payloadMarkerEmitted,
    invalidMarkerEmitted: checkpoint.invalidMarkerEmitted,
    oversizedMarkerEmitted: checkpoint.oversizedMarkerEmitted
  });
}

function transcriptFileFor(job) {
  const transcriptAgentId = transcriptAgentIdForJob(job);
  if (!transcriptAgentId) return null;
  const direct = transcriptPathMatchesAgentId(job.transcriptPath, transcriptAgentId)
    ? path.normalize(job.transcriptPath) : null;
  try { if (direct && fs.statSync(direct).isFile()) return direct; } catch {}
  return resolveStoredAgentTranscriptPath({
    transcriptAgentId,
    coordinatorSidecarDir: job.coordinatorSidecarDir,
    allowMissing: false
  }) || direct || resolveStoredAgentTranscriptPath({
    transcriptAgentId,
    coordinatorSidecarDir: job.coordinatorSidecarDir,
    allowMissing: true
  });
}

export function isClaudeAgentTailCandidate(job) {
  return job?.managedBy === 'delegate-agent-hook'
    && job?.transport === 'claude-agent'
    && Boolean(transcriptAgentIdForJob(job))
    && job?.agentTranscriptIngestion?.closed !== true;
}

export function ingestClaudeAgentTranscriptJob(jobOrId, options = {}) {
  const id = typeof jobOrId === 'string' ? jobOrId : jobOrId?.id;
  const job = id ? loadJob(id) : null;
  if (!job || !isClaudeAgentTailCandidate(job)) return { open: false, events: [], reason: 'not-correlated' };
  const file = transcriptFileFor(job);
  if (!file) return { open: true, events: [], reason: 'transcript-unresolved' };
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return { open: true, events: [], reason: 'transcript-not-file' };
  } catch (error) {
    if (error.code === 'ENOENT') return { open: true, events: [], reason: 'transcript-missing' };
    throw error;
  }

  const prior = initialClaudeTranscriptState(job.agentTranscriptIngestion || {});
  const priorOffset = tokenCount(job.agentTranscriptIngestion?.byteOffset);
  const replaced = stat.size < priorOffset;
  const offset = replaced ? 0 : priorOffset;
  const maxReadBytes = positiveInteger(options.maxReadBytes ?? process.env.DELEGATE_AGENT_TAIL_READ_BYTES, DEFAULT_AGENT_READ_BYTES, 1024);
  const available = Math.min(Math.max(0, stat.size - offset), maxReadBytes);
  let completeBytes = 0;
  let lines = [];
  if (available > 0) {
    const descriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(available);
      const bytesRead = fs.readSync(descriptor, buffer, 0, available, offset);
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        completeBytes = newline + 1;
        lines = chunk.subarray(0, completeBytes).toString('utf8').split(/\r?\n/).slice(0, -1);
      }
    } finally { fs.closeSync(descriptor); }
  }
  const nextOffset = offset + completeBytes;
  const terminal = TERMINAL.has(job.status);
  let fullyRead = nextOffset === stat.size;
  if (fullyRead && stat.size > 0) {
    const descriptor = fs.openSync(file, 'r');
    try {
      const last = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, last, 0, 1, stat.size - 1);
      fullyRead = last[0] === 0x0a;
    } finally { fs.closeSync(descriptor); }
  }
  const carried = replaced ? resetForReplacement(prior) : prior;
  const normalized = normalizeClaudeAgentTranscript(lines, carried, {
    final: terminal && fullyRead,
    maxEventBytes: options.maxEventBytes ?? process.env.DELEGATE_AGENT_EVENT_BYTES,
    maxEvents: options.maxEvents ?? process.env.DELEGATE_AGENT_EVENT_LIMIT,
    maxLineBytes: options.maxLineBytes ?? process.env.DELEGATE_AGENT_LINE_BYTES
  });
  const entries = replaced ? [{
    type: 'journal.truncated',
    data: {
      source: 'claude-transcript',
      reason: 'transcript-replaced',
      previousOffset: priorOffset,
      observedSize: stat.size
    }
  }, ...normalized.events] : normalized.events;
  const closed = terminal && fullyRead;
  const previousJournalEvents = tokenCount(job.agentTranscriptIngestion?.journalEvents);
  const shouldPersist = replaced
    || completeBytes > 0
    || entries.length > 0
    || closed !== (job.agentTranscriptIngestion?.closed === true)
    || job.transcriptPath !== file
    || Number(job.agentTranscriptIngestion?.observedSize ?? -1) !== stat.size;
  if (!shouldPersist) return { open: !closed, events: [], file, offset: nextOffset, closed };
  const committed = appendJobEventsAndUpdate(id, entries, (current) => {
    current.transcriptPath = file;
    current.transcriptMtimeMs = stat.mtimeMs;
    current.transcriptSize = stat.size;
    current.agentTranscriptIngestion = {
      ...normalized.state,
      byteOffset: nextOffset,
      observedSize: stat.size,
      journalEvents: previousJournalEvents + entries.length,
      closed,
      ...(closed ? { finalDrainCompletedAt: Date.now() } : {})
    };
    if ((!current.model || current.model === 'inherited') && normalized.state.observedModel) {
      current.model = normalized.state.observedModel;
    }
  });
  return {
    open: !closed,
    events: committed.events,
    file,
    offset: nextOffset,
    closed,
    replaced
  };
}
