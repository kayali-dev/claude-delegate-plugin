import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  processIdentityIsAlive,
  readProcessIdentityTable,
  walkProcessIdentityChain
} from './process-identity.mjs';

const MAX_CORRELATION_BYTES = 32 * 1024;
const MAX_ANCESTOR_DEPTH = 24;
const MAX_GC_FILES = 128;
const MARKER_TTL_MS = 72 * 60 * 60 * 1000;
const RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[a-f0-9-]{16,64}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(temporary, 0o600); } catch {}
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readPrivateJson(file) {
  const details = fs.statSync(file);
  if (!details.isFile() || details.size <= 0 || details.size > MAX_CORRELATION_BYTES) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function safeSessionId(value) {
  if (value == null) return null;
  const sessionId = String(value).trim();
  return SAFE_SESSION_ID.test(sessionId) ? sessionId : null;
}

function safePid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function safeTime(value) {
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function normalizedChain(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANCESTOR_DEPTH) return null;
  const chain = [];
  const seen = new Set();
  for (const entry of value) {
    const pid = safePid(entry?.pid);
    const startTimeMs = safeTime(entry?.startTimeMs);
    if (!pid || !startTimeMs || seen.has(pid)) return null;
    seen.add(pid);
    chain.push({ pid, startTimeMs });
  }
  return chain;
}

function canonicalDirectory(value) {
  return typeof value === 'string' && value ? path.resolve(value) : null;
}

function timestampName(value) {
  return String(Math.max(0, Math.floor(Number(value) || 0))).padStart(13, '0');
}

function listCorrelationFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(?:session|request|response|resolution)-.+\.json$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function markerFromRecord(record, file) {
  if (record?.version !== 2 || record.kind !== 'session') return null;
  if (!SAFE_ID.test(String(record.markerId || ''))) return null;
  if (!path.basename(file).endsWith(`-${record.markerId}.json`)) return null;
  const sessionId = safeSessionId(record.sessionId);
  const coordinatorPid = safePid(record.coordinatorPid);
  const coordinatorStartTimeMs = safeTime(record.coordinatorStartTimeMs);
  const workspaceId = canonicalDirectory(record.workspaceId);
  const projectDir = canonicalDirectory(record.projectDir);
  const createdAtMs = safeTime(record.createdAtMs);
  const expiresAtMs = safeTime(record.expiresAtMs);
  const ancestorChain = normalizedChain(record.ancestorChain);
  if (!sessionId || !coordinatorPid || !coordinatorStartTimeMs || !workspaceId || !projectDir) return null;
  if (!createdAtMs || !expiresAtMs || expiresAtMs <= createdAtMs || !ancestorChain) return null;
  if (ancestorChain[0].pid !== coordinatorPid || ancestorChain[0].startTimeMs !== coordinatorStartTimeMs) return null;
  return {
    ...record,
    sessionId,
    coordinatorPid,
    coordinatorStartTimeMs,
    workspaceId,
    projectDir,
    createdAtMs,
    expiresAtMs,
    ancestorChain
  };
}

function recordExpired(record, file, now) {
  const explicitExpiry = safeTime(record?.expiresAtMs);
  if (explicitExpiry) return explicitExpiry <= now;
  const createdAtMs = safeTime(record?.createdAtMs ?? record?.completedAtMs);
  if (createdAtMs) return createdAtMs + RECORD_RETENTION_MS <= now;
  try { return fs.statSync(file).mtimeMs + RECORD_RETENTION_MS <= now; }
  catch { return true; }
}

export function monitorCorrelationDirectory(stateDirectory) {
  return path.join(path.resolve(String(stateDirectory)), 'monitor-correlation');
}

export function cleanupMonitorCorrelation(stateDirectory, now = Date.now(), options = {}) {
  const directory = monitorCorrelationDirectory(stateDirectory);
  let files;
  try { files = listCorrelationFiles(directory); }
  catch { return { examined: 0, removed: 0 }; }
  const table = options.processes instanceof Map
    ? { ok: options.processes.size > 0, processes: options.processes }
    : readProcessIdentityTable(options);
  let examined = 0;
  let removed = 0;
  for (const file of files.slice(0, MAX_GC_FILES)) {
    examined += 1;
    let record;
    try { record = readPrivateJson(file); }
    catch { record = null; }
    const marker = markerFromRecord(record, file);
    const obsoleteHandshake = record?.version === 1
      && ['session', 'monitor-request', 'session-response'].includes(record?.kind);
    const coordinatorGone = marker && table.ok
      ? !processIdentityIsAlive({
          pid: marker.coordinatorPid,
          startTimeMs: marker.coordinatorStartTimeMs
        }, table.processes)
      : false;
    const remove = recordExpired(record, file, now)
      || coordinatorGone
      || (obsoleteHandshake && recordExpired(record, file, now));
    if (!remove) continue;
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {}
  }
  return { examined, removed };
}

export function writeSessionCorrelationMarker(options = {}) {
  const sessionId = safeSessionId(options.sessionId);
  const coordinatorPid = safePid(options.coordinatorPid ?? process.ppid);
  const workspaceId = canonicalDirectory(options.workspaceId);
  const projectDir = canonicalDirectory(options.projectDir || options.workspaceId);
  if (!sessionId) return { ok: false, reason: 'missing-session-id' };
  if (!coordinatorPid) return { ok: false, reason: 'missing-coordinator-pid' };
  if (!workspaceId) return { ok: false, reason: 'missing-workspace-id' };

  let chainResult;
  const injectedChain = normalizedChain(options.ancestorChain);
  if (options.ancestorChain != null) {
    chainResult = injectedChain
      ? {
          ok: true,
          reason: null,
          chain: injectedChain,
          truncated: options.ancestorChainTruncated === true,
          processes: options.processes instanceof Map ? options.processes : new Map()
        }
      : { ok: false, reason: 'invalid-ancestor-chain', chain: [], processes: new Map() };
  } else {
    chainResult = walkProcessIdentityChain(coordinatorPid, options);
  }
  if (!chainResult.ok) return { ok: false, reason: chainResult.reason };
  if (chainResult.chain[0]?.pid !== coordinatorPid) {
    return { ok: false, reason: 'coordinator-chain-mismatch' };
  }

  const now = Number(options.now ?? Date.now());
  const markerTtlMs = Number(options.markerTtlMs ?? MARKER_TTL_MS);
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(markerTtlMs) || markerTtlMs <= 0) {
    return { ok: false, reason: 'invalid-marker-time' };
  }
  const markerId = crypto.randomUUID();
  const directory = monitorCorrelationDirectory(options.stateDirectory);
  const marker = {
    version: 2,
    kind: 'session',
    markerId,
    sessionId,
    coordinatorPid,
    coordinatorStartTimeMs: chainResult.chain[0].startTimeMs,
    ancestorChain: chainResult.chain,
    ancestorChainTruncated: chainResult.truncated === true,
    workspaceId,
    projectDir,
    createdAtMs: now,
    expiresAtMs: now + markerTtlMs
  };
  const file = path.join(directory, `session-${timestampName(now)}-${markerId}.json`);
  cleanupMonitorCorrelation(options.stateDirectory, now, { processes: chainResult.processes });
  privateJson(file, marker);
  return { ok: true, marker, file };
}

function commonAncestor(markerChain, monitorChain) {
  const markerIdentities = new Map(
    markerChain.map((identity, depth) => [`${identity.pid}:${identity.startTimeMs}`, depth])
  );
  for (let monitorDepth = 0; monitorDepth < monitorChain.length; monitorDepth += 1) {
    const identity = monitorChain[monitorDepth];
    const markerDepth = markerIdentities.get(`${identity.pid}:${identity.startTimeMs}`);
    if (markerDepth != null) return { identity, monitorDepth, markerDepth };
  }
  return null;
}

function correlationStateReason(error) {
  return `correlation-state-${String(error?.code || 'unavailable').toLowerCase()}`;
}

function writeResolution(options) {
  const now = Number(options.now ?? Date.now());
  const resolutionId = crypto.randomUUID();
  const record = {
    version: 2,
    kind: 'monitor-resolution',
    resolutionId,
    monitorPid: safePid(options.monitorPid),
    monitorParentPid: safePid(options.monitorParentPid),
    workspaceId: options.workspaceId,
    createdAtMs: now,
    expiresAtMs: now + RECORD_RETENTION_MS,
    status: options.ok ? 'correlated' : 'degraded',
    effectiveScope: options.ok ? 'session' : 'workspace',
    sessionId: options.ok ? options.sessionId : null,
    reason: options.reason || null,
    markerId: options.markerId || null,
    commonAncestor: options.commonAncestor || null,
    matchDepth: options.matchDepth ?? null,
    candidateCount: Number(options.candidateCount || 0)
  };
  const file = path.join(
    monitorCorrelationDirectory(options.stateDirectory),
    `resolution-${timestampName(now)}-${resolutionId}.json`
  );
  privateJson(file, record);
  return { record, file };
}

function resolvedResult(options) {
  let recorded = true;
  let resolutionFile = null;
  let record = null;
  try {
    const written = writeResolution(options);
    resolutionFile = written.file;
    record = written.record;
  } catch {
    recorded = false;
  }
  return {
    ok: options.ok === true,
    sessionId: options.ok ? options.sessionId : null,
    reason: options.reason || null,
    recorded,
    markerId: options.markerId || null,
    commonAncestor: options.commonAncestor || null,
    matchDepth: options.matchDepth ?? null,
    candidateCount: Number(options.candidateCount || 0),
    resolutionFile,
    record
  };
}

export function resolveMonitorSession(options = {}) {
  const workspaceId = canonicalDirectory(options.workspaceId);
  const monitorPid = safePid(options.monitorPid ?? process.pid);
  const monitorParentPid = safePid(options.parentPid ?? options.coordinatorPid ?? process.ppid);
  const now = Number(options.now ?? Date.now());
  if (!workspaceId) {
    return { ok: false, sessionId: null, reason: 'missing-workspace-id', recorded: false };
  }
  if (!monitorParentPid) {
    return { ok: false, sessionId: null, reason: 'missing-coordinator-pid', recorded: false };
  }

  const chainResult = walkProcessIdentityChain(monitorParentPid, options);
  cleanupMonitorCorrelation(options.stateDirectory, now, { processes: chainResult.processes });
  if (!chainResult.ok) {
    return resolvedResult({
      stateDirectory: options.stateDirectory,
      now,
      ok: false,
      reason: chainResult.reason,
      workspaceId,
      monitorPid,
      monitorParentPid,
      candidateCount: 0
    });
  }

  let files;
  try { files = listCorrelationFiles(monitorCorrelationDirectory(options.stateDirectory)); }
  catch (error) {
    return {
      ok: false,
      sessionId: null,
      reason: correlationStateReason(error),
      recorded: false
    };
  }
  const candidates = [];
  for (const file of files) {
    if (!path.basename(file).startsWith('session-')) continue;
    let marker;
    try { marker = markerFromRecord(readPrivateJson(file), file); }
    catch { continue; }
    if (!marker || marker.expiresAtMs <= now || marker.workspaceId !== workspaceId) continue;
    if (!processIdentityIsAlive({
      pid: marker.coordinatorPid,
      startTimeMs: marker.coordinatorStartTimeMs
    }, chainResult.processes)) continue;
    const match = commonAncestor(marker.ancestorChain, chainResult.chain);
    if (!match) continue;
    candidates.push({ marker, match });
  }

  if (!candidates.length) {
    return resolvedResult({
      stateDirectory: options.stateDirectory,
      now,
      ok: false,
      reason: 'no-matching-session-marker',
      workspaceId,
      monitorPid,
      monitorParentPid,
      candidateCount: 0
    });
  }

  const bestDepth = Math.min(...candidates.map((candidate) => candidate.match.monitorDepth));
  const nearest = candidates.filter((candidate) => candidate.match.monitorDepth === bestDepth);
  const sessionIds = [...new Set(nearest.map((candidate) => candidate.marker.sessionId))];
  if (sessionIds.length !== 1) {
    return resolvedResult({
      stateDirectory: options.stateDirectory,
      now,
      ok: false,
      reason: 'ambiguous-session-markers',
      workspaceId,
      monitorPid,
      monitorParentPid,
      matchDepth: bestDepth,
      candidateCount: nearest.length
    });
  }

  nearest.sort((left, right) => (
    right.marker.createdAtMs - left.marker.createdAtMs
    || right.marker.markerId.localeCompare(left.marker.markerId)
  ));
  const selected = nearest[0];
  return resolvedResult({
    stateDirectory: options.stateDirectory,
    now,
    ok: true,
    reason: null,
    sessionId: selected.marker.sessionId,
    markerId: selected.marker.markerId,
    commonAncestor: selected.match.identity,
    matchDepth: selected.match.monitorDepth,
    candidateCount: nearest.length,
    workspaceId,
    monitorPid,
    monitorParentPid
  });
}
