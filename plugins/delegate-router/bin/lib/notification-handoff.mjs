import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './state.mjs';
import { withFileLock } from './lock.mjs';
import { NotificationPolicy, detectActionableEdges, edgeIdentity } from './monitor-policy.mjs';
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
      const wakes = new Map((Array.isArray(record.wakes) ? record.wakes : []).map((entry) => [entry.jobId, entry]));
      if (source === 'native' && !retrying) for (const edge of this.policy.offeredEdges) {
        if (edge.isOwnSession !== true || !(options.enabled || ['codex', 'cursor', 'claude']).includes(edge.job?.provider)
          || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(edge.jobId) || !Number.isSafeInteger(edge.observedAtRevision)) continue;
        wakes.set(edge.jobId, { jobId: edge.jobId, revision: edge.observedAtRevision, identity: edgeIdentity(edge), at: now });
      }
      this.write({ ...record, version: 1, policy: this.policy.checkpoint(), updatedAt: now,
        wakes: source === 'native' ? [...wakes.values()].slice(-40) : [],
        wakeIntent: source === 'native' ? record.wakeIntent : null,
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
      this.write({ ...record, leaseUntil: 0, wakeIntent: null });
      return { released: true };
    });
  }

  setDeliveryEnabled(enabled) {
    return this.transaction((record) => {
      this.write({ ...record, nativeDisabled: !enabled, ...(enabled ? {} : { leaseUntil: 0, wakeIntent: null }) });
      return { enabled };
    });
  }

  // Only opaque edge identities, revisions and job ids survive a restart.
  // Revalidate current ownership, provider, revision and edge at dispatch time;
  // neither notification text nor worker content becomes a prompt instruction.
  wake(loadSnapshots, options = {}) {
    const now = options.now ?? Date.now();
    return this.transaction((record) => {
      const snapshots = loadSnapshots();
      const valid = (Array.isArray(record.wakes) ? record.wakes : []).filter((entry) => {
        if (now - entry.at > 24 * 60 * 60 * 1000) return false;
        const observation = snapshots.find(({ job }) => job?.id === entry.jobId && job.revision === entry.revision);
        if (!observation || !(options.enabled || []).includes(observation.job.provider)) return false;
        return detectActionableEdges(observation, { now, recipientSessionId: options.sessionId })
          .some((edge) => edge.isOwnSession && edgeIdentity(edge) === entry.identity);
      });
      let intent = record.wakeIntent;
      if (intent && (now - intent.at > 5 * 60 * 1000 || !valid.some((entry) => intent.keys.includes(`${entry.jobId}:${entry.identity}`)))) intent = null;
      if (options.deliveryId) {
        const entries = intent?.id === options.deliveryId ? valid.filter((entry) => intent.keys.includes(`${entry.jobId}:${entry.identity}`)) : [];
        const allowed = options.allowed === true && entries.length > 0;
        // Consume before starting the turn: a crash can lose a wake, but can
        // never automatically replay an already admitted paid follow-up.
        this.write({ ...record, wakes: allowed ? valid.filter((entry) => !entries.includes(entry)) : valid, wakeIntent: null });
        return { allowed, jobIds: allowed ? entries.map((entry) => entry.jobId) : [] };
      }
      if (!intent && options.allowed === true && valid.length) intent = { id: crypto.randomBytes(16).toString('hex'), at: now,
        keys: valid.map((entry) => `${entry.jobId}:${entry.identity}`) };
      this.write({ ...record, wakes: valid, wakeIntent: intent });
      return { deliveryId: options.allowed === true ? intent?.id || null : null,
        jobIds: options.allowed === true && intent ? valid.filter((entry) => intent.keys.includes(`${entry.jobId}:${entry.identity}`)).map((entry) => entry.jobId) : [] };
    });
  }
}
