import fs from 'node:fs';
import path from 'node:path';
import { brokerError, normalizeBrokerError } from './errors.mjs';
import { withFileLock } from './lock.mjs';
import { dataDir } from './state.mjs';

export function workDir() {
  return path.join(dataDir(), 'work');
}

function workPath(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw brokerError('INVALID_REQUEST', `Invalid work item id: ${id}`);
  }
  return path.join(workDir(), `${id}.json`);
}

function storedEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw brokerError('STATE_ERROR', 'Stored WorkItem must be an object');
  }
  if (typeof value.id !== 'string' || !value.id) {
    throw brokerError('STATE_ERROR', 'Stored WorkItem id must be a non-empty string');
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion <= 0) {
    throw brokerError('STATE_ERROR', 'Stored WorkItem schemaVersion must be a positive integer');
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

export function readWorkItem(id) {
  try {
    return storedEnvelope(JSON.parse(fs.readFileSync(workPath(id), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw normalizeBrokerError(error, { defaultCode: 'STATE_ERROR' });
  }
}

export function listWorkItems() {
  try {
    return fs.readdirSync(workDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => readWorkItem(name.slice(0, -5)))
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw normalizeBrokerError(error, { defaultCode: 'STATE_ERROR' });
  }
}

export function writeWorkItem(workItem) {
  const record = storedEnvelope(clone(workItem));
  const file = workPath(record.id);
  fs.mkdirSync(workDir(), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return record;
}

// The updater receives the complete stored record. Unknown fields and future
// schema versions survive as long as the updater mutates or spreads that
// record instead of constructing a replacement from known fields.
export function updateWorkItem(id, updater) {
  if (typeof updater !== 'function') throw brokerError('INVALID_REQUEST', 'WorkItem updater must be a function');
  const file = workPath(id);
  return withFileLock(`${file}.lock`, () => {
    const current = readWorkItem(id);
    if (!current) throw brokerError('NOT_FOUND', `Work item not found: ${id}`);
    const editable = clone(current);
    const returned = updater(editable);
    const next = returned === undefined ? editable : returned;
    if (next?.id !== id) throw brokerError('INVALID_REQUEST', 'WorkItem updater cannot change id');
    return writeWorkItem(next);
  });
}
