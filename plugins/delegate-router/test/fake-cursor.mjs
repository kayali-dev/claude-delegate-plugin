#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('cursor-agent 2026.07.09-a3815c0');
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.argv.includes('--hang') || (process.env.FAKE_CURSOR_HANG === '1' && !process.argv.includes('models'))) {
  await new Promise((resolve) => setTimeout(resolve, 60000));
}
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 'fake-session',
  received: prompt,
  argv: process.argv.slice(2),
  usage: { inputTokens: 10, outputTokens: 2 }
}));
