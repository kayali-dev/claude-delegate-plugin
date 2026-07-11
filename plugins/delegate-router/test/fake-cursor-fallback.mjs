#!/usr/bin/env node
if (process.argv.includes('acp')) process.exit(1);
if (process.argv.includes('models')) {
  console.log('composer-2.5');
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
console.log(JSON.stringify({
  type: 'result', subtype: 'success', result: `headless:${prompt.slice(-4)}`,
  session_id: 'headless-session', usage: { inputTokens: 3, outputTokens: 1 }
}));
