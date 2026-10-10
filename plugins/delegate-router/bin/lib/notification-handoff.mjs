import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './state.mjs';
import { withFileLock } from './lock.mjs';
import { NotificationPolicy } from './monitor-policy.mjs';
import { brokerError } from './errors.mjs';

export const NATIVE_NOTIFICATION_LEASE_MS = 120_000;
const DELIVERY_GRACE_MS = 15_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

function canonical(directory) {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
}

// One recipient and ambient scope, not the scope selected in the dashboard.
// Shared policy state transfers dedupe, cooldown and rate limits between surfaces.
export class NotificationHandoff {
  constructor(options = {}) {
    this.directory = path.join(options.stateDirectory || dataDir(), 'notification-handoff');
    const identity = [options.scope || 'session', options.sessionId || null, canonical(options.projectDir || process.cwd())];
    const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    this.file = path.join(this.directory, `${digest}.json`);
    this.policy = options.policy || new NotificationPolicy(options.policyOptions);
  }

  read() {
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || (stat.mode & 0o077)
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw brokerError('STATE_ERROR', 'unsafe notification handoff record');
      }
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (value.version !== 1) throw brokerError('STATE_ERROR', 'unsupported notification handoff record');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, leaseUntil: 0 };
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  transaction(fn) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw brokerError('STATE_ERROR', 'unsafe notification handoff directory');
    }
    return withFileLock(`${this.file}.lock`, () => fn(this.read()));
  }

  write(record) {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw brokerError('STATE_ERROR', 'notification handoff exceeds its storage bound');
    const temporary = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, serialized);
      fs.closeSync(fd);
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  scan(source, loadSnapshots, options = {}) {
    if (!['native', 'monitor'].includes(source)) throw brokerError('INVALID_REQUEST', 'invalid notification surface');
    const now = options.now ?? Date.now();
    return this.transaction((record) => {
      if (source === 'monitor' && record.leaseUntil > now) return { standby: true, lines: [] };
      this.policy.restore(record.policy);
      const retrying = Array.isArray(record.delivery?.lines);
      let lines = record.delivery?.lines;
      if (!Array.isArray(lines)) lines = this.policy.observe(loadSnapshots(), options);
      // Provider output is never stored here: only redacted, closed-policy
      // notification lines and opaque edge identities can cross this boundary.
      if (lines.length > 5000 || lines.some((line) => typeof line !== 'string' || line.length > 2048)) {
        throw brokerError('STATE_ERROR', 'notification delivery exceeds its bound');
      }
      const deliveryId = source === 'native' && lines.length
        ? record.delivery?.id || crypto.randomBytes(16).toString('hex') : null;
      this.write({ version: 1, policy: this.policy.checkpoint(), updatedAt: now,
        leaseUntil: source === 'native' ? (retrying ? record.leaseUntil : now + (lines.length ? DELIVERY_GRACE_MS : NATIVE_NOTIFICATION_LEASE_MS)) : 0,
        delivery: deliveryId ? { id: deliveryId, lines } : null });
      return { standby: false, lines, deliveryId };
    });
  }

  acknowledge(deliveryId, now = Date.now()) {
    if (!/^[a-f0-9]{32}$/.test(deliveryId || '')) throw brokerError('INVALID_REQUEST', 'invalid notification delivery ID');
    return this.transaction((record) => {
      if (record.delivery?.id !== deliveryId) throw brokerError('CAS_CONFLICT', 'notification delivery changed; refresh');
      this.write({ ...record, delivery: null, leaseUntil: now + NATIVE_NOTIFICATION_LEASE_MS, updatedAt: now });
      return { acknowledged: true };
    });
  }

  release() {
    return this.transaction((record) => {
      this.write({ ...record, leaseUntil: 0 });
      return { released: true };
    });
  }
}
