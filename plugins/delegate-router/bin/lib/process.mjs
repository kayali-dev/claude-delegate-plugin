import { spawn } from 'node:child_process';

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(child, graceMs = 3000) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  }

  return new Promise((resolve) => {
    let finished = false;
    let timer;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    try { process.kill(-child.pid, 'SIGTERM'); } catch {
      try { child.kill('SIGTERM'); } catch { done(); return; }
    }
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
      done();
    }, graceMs);
    timer.unref?.();
  });
}

export function terminatePid(pid) {
  if (!isProcessAlive(pid)) return false;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    });
    killer.unref();
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
  }
  return true;
}
