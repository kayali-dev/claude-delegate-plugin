import fs from 'node:fs';
import path from 'node:path';
import { dataDir, jobsDir } from './state.mjs';
import {
  journalFileForJob,
  journalStamp,
  readJournalTail
} from './store-maintenance.mjs';

const SAFE_JOB_ID = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_MAX_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_JOURNAL_TAIL_BYTES = 256 * 1024;
const DEFAULT_MAX_JOBS = 5000;
const DEFAULT_MAX_TAIL_EVENTS = 2000;
const MAX_PREFERENCE_BYTES = 16 * 1024;

function stamp(file) {
  try {
    const value = fs.statSync(file);
    return value.isFile() ? `${value.size}:${value.mtimeMs}` : '-';
  } catch {
    return '-';
  }
}

function readBoundedFile(file, maximum) {
  const details = fs.statSync(file);
  if (!details.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'NOT_FILE' });
  if (details.size > maximum) throw Object.assign(new Error(`file exceeds ${maximum} byte read bound`), { code: 'READ_BOUND' });
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(details.size);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function jobIds(directory, maximum) {
  const ids = [];
  let handle;
  try { handle = fs.opendirSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return ids;
    throw error;
  }
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry || ids.length >= maximum) break;
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (SAFE_JOB_ID.test(id)) ids.push(id);
    }
  } finally {
    handle.closeSync();
  }
  return ids;
}

export function parseSnoozeUntil(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function preferenceSnoozed(preference, now = Date.now()) {
  const until = parseSnoozeUntil(preference?.snoozeUntil);
  return until != null && until > now;
}

export class MonitorStore {
  constructor(options = {}) {
    this.directory = path.resolve(String(options.jobsDirectory || jobsDir()));
    this.stateDirectory = path.resolve(String(options.stateDirectory || dataDir()));
    this.preferenceFile = path.resolve(String(options.preferenceFile || path.join(this.stateDirectory, 'monitor.json')));
    this.maxRecordBytes = Math.max(1024, Number(options.maxRecordBytes || DEFAULT_MAX_RECORD_BYTES));
    this.journalTailBytes = Math.max(1024, Number(options.journalTailBytes || DEFAULT_JOURNAL_TAIL_BYTES));
    this.maxJobs = Math.max(1, Number(options.maxJobs || DEFAULT_MAX_JOBS));
    this.maxTailEvents = Math.max(1, Number(options.maxTailEvents || DEFAULT_MAX_TAIL_EVENTS));
    this.onError = options.onError || (() => {});
    this.cache = new Map();
    this.preferenceStamp = null;
    this.preference = {};
  }

  readSnapshot(id) {
    const recordFile = path.join(this.directory, `${id}.json`);
    const journalPlainFile = path.join(this.directory, `${id}.events.jsonl`);
    const journalFile = journalFileForJob(id, this.directory);
    const recordStamp = stamp(recordFile);
    const currentJournalStamp = journalStamp(journalPlainFile);
    const previous = this.cache.get(id);
    if (previous?.recordStamp === recordStamp && previous?.journalStamp === currentJournalStamp) return previous.snapshot;
    try {
      const record = recordStamp === previous?.recordStamp
        ? previous.snapshot.job
        : { ...JSON.parse(readBoundedFile(recordFile, this.maxRecordBytes)), id };
      const events = currentJournalStamp === previous?.journalStamp
        ? previous.snapshot.events
        : readJournalTail(journalFile, this.journalTailBytes, this.maxTailEvents);
      const lastEventAt = [...events].reverse()
        .map((event) => Number(event?.at))
        .find((value) => Number.isFinite(value) && value > 0) || null;
      const snapshot = Object.freeze({ job: Object.freeze(record), events: Object.freeze(events), lastEventAt });
      this.cache.set(id, { recordStamp, journalStamp: currentJournalStamp, snapshot });
      return snapshot;
    } catch (error) {
      this.onError(`job-read:${error.code || error.name || 'error'}`, error);
      return previous?.snapshot || null;
    }
  }

  scan() {
    let ids;
    try { ids = jobIds(this.directory, this.maxJobs); }
    catch (error) {
      this.onError(`directory-read:${error.code || error.name || 'error'}`, error);
      return [...this.cache.values()].map((entry) => entry.snapshot);
    }
    const seen = new Set(ids);
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
    return ids.map((id) => this.readSnapshot(id)).filter(Boolean);
  }

  readPreference() {
    const currentStamp = stamp(this.preferenceFile);
    if (currentStamp === this.preferenceStamp) return this.preference;
    this.preferenceStamp = currentStamp;
    if (currentStamp === '-') {
      this.preference = {};
      return this.preference;
    }
    try {
      const parsed = JSON.parse(readBoundedFile(this.preferenceFile, MAX_PREFERENCE_BYTES));
      this.preference = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      this.onError(`preference-read:${error.code || error.name || 'error'}`, error);
      this.preference = {};
    }
    return this.preference;
  }
}
