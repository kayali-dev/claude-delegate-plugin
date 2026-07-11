#!/usr/bin/env node
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
