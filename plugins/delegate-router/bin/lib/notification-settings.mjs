import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './state.mjs';
import { brokerError } from './errors.mjs';

export const NOTIFICATION_MODES = ['native', 'legacy-persistent', 'off'];
export function notificationSettingsPath(directory = dataDir()) { return path.join(directory, 'notifications.json'); }

export function notificationMode(directory = dataDir()) {
  let fd;
  try {
    fd = fs.openSync(notificationSettingsPath(directory), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('unsafe notification configuration');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value.version !== 1 || !NOTIFICATION_MODES.includes(value.mode)) throw new Error('invalid notification configuration');
    return value.mode;
  } catch (error) {
    if (error.code === 'ENOENT') return 'native';
    throw brokerError('STATE_ERROR', 'notification configuration unavailable');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function setNotificationMode(mode, directory = dataDir()) {
  if (!NOTIFICATION_MODES.includes(mode)) throw brokerError('INVALID_REQUEST', 'expected native, legacy-persistent, or off');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw brokerError('STATE_ERROR', 'unsafe notification configuration directory');
  const temporary = `${notificationSettingsPath(directory)}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, mode }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, notificationSettingsPath(directory));
  } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  return mode;
}
