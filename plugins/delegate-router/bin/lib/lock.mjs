import fs from 'node:fs';
import path from 'node:path';
import { brokerError } from './errors.mjs';

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw brokerError('LOCK_TIMEOUT', `Timed out acquiring lock ${lockPath}`);
      sleepSync(LOCK_WAIT_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
