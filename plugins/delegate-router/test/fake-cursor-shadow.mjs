#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--version')) {
  console.log('cursor-agent 2026.07.09-a3815c0');
  process.exit(0);
}
if (process.argv.includes('models')) {
  console.log('composer-2.5');
  process.exit(0);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CURSOR_SHADOW_WRITE === '1') {
  fs.writeFileSync(path.join(process.cwd(), 'shadow-edit.txt'), 'cursor shadow edit\n');
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'composer-2.5', permissionMode: 'plan' }));
console.log(JSON.stringify({ type: 'thinking', text: 'hidden thought text must not be journaled' }));
console.log(JSON.stringify({ type: 'assistant', timestamp_ms: Date.now(), message: { content: [{ text: 'Cursor visible response' }] } }));
console.log(JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'cursor-tool-1', tool_call: { ShellToolCall: { args: { command: 'inspect' } } } }));
console.log(JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'cursor-tool-1', tool_call: { ShellToolCall: { result: { success: true } } } }));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Cursor visible response',
  session_id: 'cursor-shadow-session',
  receivedChars: prompt.length,
  usage: { inputTokens: 30, outputTokens: 6 }
}));
