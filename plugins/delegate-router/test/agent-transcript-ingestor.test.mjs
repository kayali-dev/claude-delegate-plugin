import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createClaudeAgentStub
} from '../bin/lib/agent-stubs.mjs';
import {
  ingestClaudeAgentTranscriptJob,
  normalizeClaudeAgentTranscript
} from '../bin/lib/agent-transcript-ingestor.mjs';
import { inspectJob, readJobEvents, submitControl } from '../bin/lib/control.mjs';

async function isolated(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-agent-transcript-'));
  const previous = process.env.DELEGATE_STATE_FILE;
  process.env.DELEGATE_STATE_FILE = path.join(root, 'state', 'usage.json');
  try { return await fn(root); }
  finally {
    if (previous == null) delete process.env.DELEGATE_STATE_FILE;
    else process.env.DELEGATE_STATE_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

function assistantLine({ id, block, output = 0, input = 2, cacheRead = 0, cacheCreation = 0, model = 'claude-opus-4-8' }) {
  return JSON.stringify({
    parentUuid: 'parent',
    isSidechain: true,
    agentId: 'display-name@session-example',
    type: 'assistant',
    uuid: `line-${id}-${output}-${block.type}`,
    timestamp: '2026-08-04T00:00:00.000Z',
    message: {
      model,
      id,
      type: 'message',
      role: 'assistant',
      content: [block],
      stop_reason: null,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
        service_tier: 'standard',
        cache_creation: {},
        iterations: []
      }
    }
  });
}

function toolResultLine(toolUseId, content, isError = false) {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-08-04T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }]
    }
  });
}

function transcriptJob(root, transcriptAgentId = 'a0a9ee00417f2e4b4') {
  const sidecar = path.join(root, 'coordinator');
  const subagents = path.join(sidecar, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const transcript = path.join(subagents, `agent-${transcriptAgentId}.jsonl`);
  fs.writeFileSync(transcript, '');
  const job = createClaudeAgentStub({
    sessionId: 'transcript-session',
    toolUseId: `tool-${transcriptAgentId}`,
    cwd: root,
    coordinatorSidecarDir: sidecar,
    transcriptAgentId,
    prompt: 'observe transcript',
    agentType: 'Explore'
  });
  return { job, transcript };
}

test('a growing transcript ingests each append once and preserves partial-line offsets', (t) => isolated(t, (root) => {
  const { job, transcript } = transcriptJob(root);
  const firstLine = assistantLine({
    id: 'msg-1',
    block: { type: 'thinking', thinking: 'private chain of thought' },
    output: 2
  });
  fs.appendFileSync(transcript, `${firstLine}\n`);
  const first = ingestClaudeAgentTranscriptJob(job.id);
  assert.ok(first.events.some((event) => event.type === 'activity'));
  assert.ok(first.events.some((event) => event.type === 'usage.updated'));
  assert.equal(inspectJob(job.id).model, 'claude-opus-4-8');

  const secondLine = assistantLine({
    id: 'msg-1',
    block: { type: 'text', text: 'working live' },
    output: 5
  });
  fs.appendFileSync(transcript, secondLine.slice(0, -1));
  const partial = ingestClaudeAgentTranscriptJob(job.id);
  assert.deepEqual(partial.events, []);
  const partialOffset = inspectJob(job.id).agentTranscriptIngestion.byteOffset;
  fs.appendFileSync(transcript, `${secondLine.slice(-1)}\n`);
  const second = ingestClaudeAgentTranscriptJob(job.id);
  assert.ok(second.events.some((event) => event.type === 'message.delta'));
  assert.ok(inspectJob(job.id).agentTranscriptIngestion.byteOffset > partialOffset);

  fs.appendFileSync(transcript, `${assistantLine({
    id: 'msg-2',
    block: { type: 'text', text: 'next message' },
    output: 7
  })}\n`);
  const third = ingestClaudeAgentTranscriptJob(job.id);
  assert.ok(third.events.some((event) => event.type === 'message.completed' && event.data.id === 'msg-1'));
  assert.ok(third.events.some((event) => event.type === 'message.delta' && event.data.id === 'msg-2'));
  const unchanged = ingestClaudeAgentTranscriptJob(job.id);
  assert.deepEqual(unchanged.events, [], 'unchanged file must not replay any event');

  fs.writeFileSync(transcript, `${assistantLine({
    id: 'replacement-message',
    block: { type: 'text', text: 'replacement content' },
    output: 1
  })}\n`);
  const replacement = ingestClaudeAgentTranscriptJob(job.id);
  assert.ok(replacement.events.some((event) => event.type === 'journal.truncated'
    && event.data.reason === 'transcript-replaced'));
  assert.ok(replacement.events.some((event) => event.type === 'message.delta'
    && event.data.id === 'replacement-message'));
}));

test('split response usage is last-wins per message id and cumulative across ids', () => {
  const split = [2, 2, 2, 2, 647].map((output, index) => assistantLine({
    id: 'msg-split',
    block: { type: index === 4 ? 'text' : 'thinking', ...(index === 4 ? { text: 'settled' } : { thinking: `hidden-${index}` }) },
    input: 10,
    cacheRead: 100,
    cacheCreation: 20,
    output
  }));
  const lines = [...split, assistantLine({
    id: 'msg-second',
    block: { type: 'text', text: 'second' },
    input: 4,
    cacheRead: 5,
    cacheCreation: 1,
    output: 11
  })];
  const result = normalizeClaudeAgentTranscript(lines, {}, { final: true });
  const usage = result.events.filter((event) => event.type === 'usage.updated').at(-1).data;
  assert.equal(usage.outputTokens, 658, '647 + 11, never 655 + 11');
  assert.equal(usage.inputTokens, 14, 'repeated input for split lines must count once');
  assert.equal(usage.cacheReadInputTokens, 105);
  assert.equal(usage.cacheCreationInputTokens, 21);
  assert.equal(result.state.usageByMessage.length, 2);
  assert.deepEqual(result.events.filter((event) => event.type === 'message.completed').map((event) => event.data.id), [
    'msg-split', 'msg-second'
  ], 'split content blocks must not fabricate per-line completions');
});

test('thinking fixtures produce a content-free marker and never persist thinking text', () => {
  const hidden = 'NONVACUOUS_PRIVATE_THOUGHT_17';
  const result = normalizeClaudeAgentTranscript([assistantLine({
    id: 'msg-thinking',
    block: { type: 'thinking', thinking: hidden },
    output: 3
  })]);
  const activity = result.events.find((event) => event.type === 'activity');
  assert.deepEqual(activity, { type: 'activity', data: { kind: 'reasoning' } });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(hidden));
});

test('tool calls correlate with results, redact payloads, and Edit emits file.changed', () => {
  const secret = 'sk-1234567890abcdefghijkl';
  const result = normalizeClaudeAgentTranscript([
    assistantLine({
      id: 'msg-tool',
      block: {
        type: 'tool_use',
        id: 'toolu_edit_1',
        name: 'Edit',
        input: { file_path: 'src/example.mjs', old_string: 'old', new_string: secret },
        caller: { type: 'direct' }
      },
      output: 9
    }),
    toolResultLine('toolu_edit_1', `saved ${secret}`)
  ]);
  const started = result.events.find((event) => event.type === 'tool.started');
  const completed = result.events.find((event) => event.type === 'tool.completed');
  const output = result.events.find((event) => event.type === 'tool.output');
  const changed = result.events.find((event) => event.type === 'file.changed');
  assert.equal(started.data.toolCallId, 'toolu_edit_1');
  assert.equal(completed.data.toolCallId, started.data.toolCallId);
  assert.equal(output.data.toolCallId, started.data.toolCallId);
  assert.deepEqual(changed.data, { changes: [{ path: 'src/example.mjs', kind: 'edit' }], phase: 'started' });
  assert.doesNotMatch(JSON.stringify(result), /sk-1234567890abcdefghijkl/);
});

test('event and payload caps emit explicit journal.truncated markers', () => {
  const lines = Array.from({ length: 5 }, (_, index) => assistantLine({
    id: `cap-${index}`,
    block: { type: 'text', text: 'x'.repeat(5000) },
    output: index + 1
  }));
  const result = normalizeClaudeAgentTranscript(lines, {}, {
    final: true,
    maxEvents: 2,
    maxEventBytes: 1024
  });
  const markers = result.events.filter((event) => event.type === 'journal.truncated');
  assert.ok(markers.some((event) => event.data.reason === 'event-bytes'));
  assert.ok(markers.some((event) => event.data.reason === 'event-limit'));
  assert.ok(result.state.omittedEvents > 0);
});

test('ingestion does not make claude-agent cancel, steer, or respond controllable', (t) => isolated(t, (root) => {
  const { job, transcript } = transcriptJob(root, 'c2c9ee00417f2e4d');
  fs.appendFileSync(transcript, `${assistantLine({
    id: 'msg-read-only',
    block: { type: 'text', text: 'observed' },
    output: 4
  })}\n`);
  ingestClaudeAgentTranscriptJob(job.id);
  const revision = inspectJob(job.id).revision;
  for (const type of ['cancel', 'steer', 'respond']) {
    assert.throws(
      () => submitControl(job.id, { type, commandId: `cmd-${type}`, text: 'no authority', requestId: 'request-1' }, revision),
      (error) => error.code === 'READ_ONLY_TRANSPORT'
    );
  }
}));
