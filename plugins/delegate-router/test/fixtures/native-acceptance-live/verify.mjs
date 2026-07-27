import fs from 'node:fs';

const evidence = fs.readFileSync(new URL('./evidence.txt', import.meta.url), 'utf8');
if (!evidence.includes('broker-verification-passed')) {
  console.error('missing broker-verification-passed marker');
  process.exit(1);
}
console.log('native acceptance live fixture passed');
