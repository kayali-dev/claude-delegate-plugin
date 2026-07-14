import { spawnSync } from 'node:child_process';

export function copyToClipboard(value, options = {}) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return false;
  const platform = options.platform || process.platform;
  const spawn = options.spawn || spawnSync;
  const candidates = platform === 'darwin'
    ? [['pbcopy', []]]
    : platform === 'linux' ? [['xclip', ['-selection', 'clipboard']]] : [];
  for (const [command, args] of candidates) {
    try {
      const result = spawn(command, args, { input: text, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
      if (result?.status === 0) return true;
    } catch {}
  }
  return false;
}
