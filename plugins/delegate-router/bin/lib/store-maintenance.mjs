import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dataDir, jobsDir } from './state.mjs';

export const DEFAULT_STATE_BUDGET_BYTES = 1536 * 1024 * 1024;
export const DEFAULT_JOURNAL_CAP_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RECENT_TERMINAL_KEEP = 20;
export const DEFAULT_SWEEP_RECORD_LIMIT = 500;
export const DEFAULT_SWEEP_REMOVE_LIMIT = 25;
export const DEFAULT_SWEEP_COMPRESS_LIMIT = 25;
export const DEFAULT_SWEEP_FILE_LIMIT = 20_000;
export const STORE_HIGH_WATER_RATIO = 0.85;
const MIN_JOURNAL_CAP_BYTES = 64 * 1024;
const MAINTENANCE_LOG_MAX_BYTES = 1024 * 1024;
const MAINTENANCE_LOG_KEEP_BYTES = 512 * 1024;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function storePolicy(options = {}) {
  const budgetBytes = positiveInteger(
    options.budgetBytes ?? process.env.DELEGATE_STATE_BUDGET_BYTES,
    DEFAULT_STATE_BUDGET_BYTES
  );
  const journalCapBytes = positiveInteger(
    options.journalCapBytes ?? process.env.DELEGATE_JOB_JOURNAL_CAP_BYTES,
    DEFAULT_JOURNAL_CAP_BYTES,
    MIN_JOURNAL_CAP_BYTES
  );
  const recentTerminalKeep = positiveInteger(
    options.recentTerminalKeep ?? process.env.DELEGATE_RECENT_TERMINAL_KEEP,
    DEFAULT_RECENT_TERMINAL_KEEP,
    0
  );
  return {
    budgetBytes,
    journalCapBytes,
    recentTerminalKeep,
    highWaterBytes: Math.floor(budgetBytes * STORE_HIGH_WATER_RATIO)
  };
}

export function gzipJournalPath(plainFile) {
  return `${plainFile}.gz`;
}

export function resolveJournalFile(plainFile) {
  if (plainFile.endsWith('.gz')) return plainFile;
  if (fs.existsSync(plainFile)) return plainFile;
  const compressed = gzipJournalPath(plainFile);
  return fs.existsSync(compressed) ? compressed : plainFile;
}

export function journalFileForJob(id, directory = jobsDir()) {
  return resolveJournalFile(path.join(directory, `${id}.events.jsonl`));
}

export function journalStamp(plainFile) {
  const file = resolveJournalFile(plainFile);
  try {
    const value = fs.statSync(file);
    return value.isFile() ? `${file.endsWith('.gz') ? 'gz' : 'plain'}:${value.size}:${value.mtimeMs}` : '-';
  } catch {
    return '-';
  }
}

export function readJournalBuffer(file) {
  const resolved = resolveJournalFile(file);
  try {
    const bytes = fs.readFileSync(resolved);
    return resolved.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

export function readJournalText(file) {
  return readJournalBuffer(file).toString('utf8');
}

function atomicWritePrivate(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function replaceJournalBuffer(file, bytes) {
  const resolved = resolveJournalFile(file);
  if (resolved.endsWith('.gz')) {
    atomicWritePrivate(resolved, zlib.gzipSync(bytes, { level: zlib.constants.Z_BEST_SPEED }));
  } else {
    atomicWritePrivate(resolved, bytes);
  }
  return resolved;
}

export function appendJournalLine(file, line) {
  const resolved = resolveJournalFile(file);
  if (resolved.endsWith('.gz')) {
    const existing = readJournalBuffer(resolved);
    replaceJournalBuffer(resolved, Buffer.concat([existing, Buffer.from(line)]));
  } else {
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    fs.appendFileSync(resolved, line, { mode: 0o600 });
    try { fs.chmodSync(resolved, 0o600); } catch {}
  }
  return resolved;
}

export function compressJournalFile(plainFile) {
  const compressed = gzipJournalPath(plainFile);
  if (!fs.existsSync(plainFile)) {
    if (!fs.existsSync(compressed)) return null;
    const details = fs.statSync(compressed);
    return { file: compressed, beforeBytes: details.size, afterBytes: details.size, alreadyCompressed: true };
  }
  const source = fs.readFileSync(plainFile);
  const encoded = zlib.gzipSync(source, { level: zlib.constants.Z_BEST_SPEED });
  atomicWritePrivate(compressed, encoded);
  fs.unlinkSync(plainFile);
  return {
    file: compressed,
    beforeBytes: source.length,
    afterBytes: encoded.length,
    savedBytes: Math.max(0, source.length - encoded.length),
    alreadyCompressed: false
  };
}

export function readJournalTail(file, maximum, maxEvents) {
  const bytes = readJournalBuffer(file);
  if (!bytes.length) return [];
  const length = Math.min(bytes.length, maximum);
  const offset = bytes.length - length;
  let text = bytes.subarray(offset).toString('utf8');
  if (offset > 0) {
    const boundary = text.indexOf('\n');
    text = boundary < 0 ? '' : text.slice(boundary + 1);
  }
  if (text && !text.endsWith('\n')) text = text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1));
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events.slice(-maxEvents);
}

function addPathUsage(target, state) {
  if (state.examinedFiles >= state.maximum) {
    state.complete = false;
    return;
  }
  let details;
  try { details = fs.lstatSync(target); }
  catch (error) {
    if (error.code !== 'ENOENT') state.errors += 1;
    return;
  }
  state.examinedFiles += 1;
  if (!details.isDirectory() || details.isSymbolicLink()) {
    state.files += 1;
    state.bytes += details.size;
    return;
  }
  let entries;
  try { entries = fs.readdirSync(target); }
  catch {
    state.errors += 1;
    return;
  }
  for (const name of entries) {
    if (state.examinedFiles >= state.maximum) {
      state.complete = false;
      break;
    }
    addPathUsage(path.join(target, name), state);
  }
}

export function measurePaths(paths, options = {}) {
  const state = {
    bytes: 0,
    files: 0,
    examinedFiles: 0,
    complete: true,
    errors: 0,
    maximum: positiveInteger(options.maxFiles, DEFAULT_SWEEP_FILE_LIMIT)
  };
  for (const target of paths) {
    if (state.examinedFiles >= state.maximum) {
      state.complete = false;
      break;
    }
    addPathUsage(target, state);
  }
  delete state.maximum;
  return state;
}

export function measureStateStore(options = {}) {
  const policy = storePolicy(options);
  const usage = measurePaths([options.directory || dataDir()], { maxFiles: options.maxFiles });
  const headroomBytes = policy.budgetBytes - usage.bytes;
  return {
    directory: options.directory || dataDir(),
    ...usage,
    budgetBytes: policy.budgetBytes,
    headroomBytes,
    highWaterBytes: policy.highWaterBytes,
    highWater: usage.bytes >= policy.highWaterBytes,
    overBudget: usage.bytes > policy.budgetBytes
  };
}

export function maintenanceLogPath() {
  return path.join(dataDir(), 'maintenance.jsonl');
}

export function appendMaintenanceLog(entry) {
  const file = maintenanceLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = Buffer.alloc(0);
  try {
    const details = fs.statSync(file);
    if (details.size >= MAINTENANCE_LOG_MAX_BYTES) {
      const source = fs.readFileSync(file);
      let kept = source.subarray(Math.max(0, source.length - MAINTENANCE_LOG_KEEP_BYTES));
      const boundary = kept.indexOf(0x0a);
      if (boundary >= 0) kept = kept.subarray(boundary + 1);
      prefix = Buffer.concat([
        Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), type: 'log-truncated', kept: 'tail' })}\n`),
        kept
      ]);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (prefix.length) atomicWritePrivate(file, prefix);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

export function jobStatePaths(id, directory = jobsDir()) {
  const plainJournal = path.join(directory, `${id}.events.jsonl`);
  return {
    files: [
      plainJournal,
      gzipJournalPath(plainJournal),
      path.join(directory, `${id}.prompt`),
      path.join(directory, `${id}.verify`),
      path.join(directory, `${id}.out.log`),
      path.join(directory, `${id}.err.log`),
      path.join(directory, `${id}.lock`),
      path.join(directory, `${id}.finished`),
      path.join(directory, `${id}.json`)
    ],
    directories: [
      path.join(directory, `${id}.commands`),
      path.join(directory, `${id}.artifacts`)
    ]
  };
}

export function removeJobState(id, options = {}) {
  const targets = jobStatePaths(id, options.directory);
  const measured = measurePaths([...targets.files, ...targets.directories], { maxFiles: options.maxFiles });
  for (const file of targets.files) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  for (const directory of targets.directories) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
  return measured;
}

function timestampFromJobId(id) {
  const encoded = String(id).split('-')[1];
  if (!encoded || !/^[a-z0-9]+$/i.test(encoded)) return null;
  const value = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(value) ? value : null;
}

export function jobRecordIdsByAge(directory = jobsDir()) {
  let names;
  try {
    names = fs.readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map((name) => {
    const id = name.slice(0, -5);
    let timestamp = timestampFromJobId(id);
    if (timestamp == null) {
      try { timestamp = fs.statSync(path.join(directory, name)).mtimeMs; }
      catch { timestamp = 0; }
    }
    return { id, timestamp };
  }).sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}
