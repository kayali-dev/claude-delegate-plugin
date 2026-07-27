import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './process.mjs';

const MAX_CORRELATION_BYTES = 32 * 1024;
const DEFAULT_REQUEST_WAIT_MS = 2_000;
const DEFAULT_RESPONDER_MS = 15_000;
const MAX_WAIT_MS = 5_000;
const CORRELATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[a-f0-9-]{16,64}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function boundedMilliseconds(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

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

function safeCoordinatorPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function listCorrelationFiles(directory, prefix) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function monitorCorrelationDirectory(stateDirectory) {
  return path.join(path.resolve(String(stateDirectory)), 'monitor-correlation');
}

export function cleanupMonitorCorrelation(stateDirectory, now = Date.now()) {
  const directory = monitorCorrelationDirectory(stateDirectory);
  for (const file of listCorrelationFiles(directory, '')) {
    try {
      if (now - fs.statSync(file).mtimeMs > CORRELATION_RETENTION_MS) fs.rmSync(file, { force: true });
    } catch {}
  }
}

export function writeSessionCorrelationMarker(options = {}) {
  const sessionId = safeSessionId(options.sessionId);
  const coordinatorPid = safeCoordinatorPid(options.coordinatorPid);
  const workspaceId = typeof options.workspaceId === 'string' && options.workspaceId ? path.resolve(options.workspaceId) : null;
  const projectDir = typeof options.projectDir === 'string' && options.projectDir ? path.resolve(options.projectDir) : null;
  if (!sessionId) return { ok: false, reason: 'missing-session-id' };
  if (!coordinatorPid) return { ok: false, reason: 'missing-coordinator-pid' };
  if (!workspaceId) return { ok: false, reason: 'missing-workspace-id' };
  const now = Number(options.now ?? Date.now());
  const responderMs = boundedMilliseconds(
    options.responderMs ?? process.env.DELEGATE_MONITOR_CORRELATION_RESPONDER_MS,
    DEFAULT_RESPONDER_MS,
    60_000
  );
  const markerId = crypto.randomUUID();
  const directory = monitorCorrelationDirectory(options.stateDirectory);
  const marker = {
    version: 1,
    kind: 'session',
    markerId,
    sessionId,
    coordinatorPid,
    workspaceId,
    projectDir: projectDir || workspaceId,
    createdAtMs: now,
    expiresAtMs: now + responderMs
  };
  const file = path.join(directory, `session-${markerId}.json`);
  cleanupMonitorCorrelation(options.stateDirectory, now);
  privateJson(file, marker);
  return { ok: true, marker, file };
}

function validRequest(request, marker, now) {
  return request?.version === 1
    && request.kind === 'monitor-request'
    && request.status === 'pending'
    && SAFE_ID.test(String(request.requestId || ''))
    && safeCoordinatorPid(request.coordinatorPid) === marker.coordinatorPid
    && request.workspaceId === marker.workspaceId
    && Number(request.createdAtMs) <= now
    && Number(request.expiresAtMs) >= now;
}

function respondToRequests(marker, markerFile, now = Date.now()) {
  const directory = path.dirname(markerFile);
  let written = 0;
  for (const file of listCorrelationFiles(directory, 'request-')) {
    let request;
    try { request = readPrivateJson(file); } catch { continue; }
    if (!validRequest(request, marker, now)) continue;
    const response = {
      version: 1,
      kind: 'session-response',
      requestId: request.requestId,
      markerId: marker.markerId,
      sessionId: marker.sessionId,
      coordinatorPid: marker.coordinatorPid,
      workspaceId: marker.workspaceId,
      markerCreatedAtMs: marker.createdAtMs,
      createdAtMs: now
    };
    const responseFile = path.join(directory, `response-${request.requestId}-${marker.markerId}.json`);
    if (fs.existsSync(responseFile)) continue;
    try {
      privateJson(responseFile, response);
      written += 1;
    } catch {}
  }
  return written;
}

export function runSessionCorrelationResponder(markerFile, options = {}) {
  let marker;
  try { marker = readPrivateJson(markerFile); } catch { return { ok: false, reason: 'marker-unreadable' }; }
  if (marker?.version !== 1 || marker.kind !== 'session' || !SAFE_ID.test(String(marker.markerId || ''))) {
    return { ok: false, reason: 'marker-invalid' };
  }
  if (path.basename(markerFile) !== `session-${marker.markerId}.json`) {
    return { ok: false, reason: 'marker-path-mismatch' };
  }
  const durationMs = boundedMilliseconds(
    options.responderMs ?? process.env.DELEGATE_MONITOR_CORRELATION_RESPONDER_MS,
    DEFAULT_RESPONDER_MS,
    60_000
  );
  const deadline = Math.min(Number(marker.expiresAtMs), Date.now() + durationMs);
  let written = 0;
  while (Date.now() <= deadline && isProcessAlive(marker.coordinatorPid)) {
    written += respondToRequests(marker, markerFile);
    sleepSync(50);
  }
  return { ok: true, written };
}

function validResponse(response, request) {
  return response?.version === 1
    && response.kind === 'session-response'
    && response.requestId === request.requestId
    && SAFE_ID.test(String(response.markerId || ''))
    && safeSessionId(response.sessionId) != null
    && safeCoordinatorPid(response.coordinatorPid) === request.coordinatorPid
    && response.workspaceId === request.workspaceId
    && Number(response.createdAtMs) >= request.createdAtMs
    && Number(response.createdAtMs) <= request.expiresAtMs;
}

function correlationResponses(directory, request) {
  const prefix = `response-${request.requestId}-`;
  const responses = [];
  for (const file of listCorrelationFiles(directory, prefix)) {
    try {
      const response = readPrivateJson(file);
      if (validResponse(response, request)) responses.push(response);
    } catch {}
  }
  return responses;
}

export function resolveMonitorSession(options = {}) {
  const workspaceId = typeof options.workspaceId === 'string' && options.workspaceId ? path.resolve(options.workspaceId) : null;
  const coordinatorPid = safeCoordinatorPid(options.coordinatorPid ?? process.ppid);
  if (!workspaceId) return { ok: false, sessionId: null, reason: 'missing-workspace-id', recorded: false };
  if (!coordinatorPid) return { ok: false, sessionId: null, reason: 'missing-coordinator-pid', recorded: false };
  const now = Number(options.now ?? Date.now());
  const waitMs = boundedMilliseconds(
    options.waitMs ?? process.env.DELEGATE_MONITOR_CORRELATION_WAIT_MS,
    DEFAULT_REQUEST_WAIT_MS,
    MAX_WAIT_MS
  );
  const requestId = crypto.randomUUID();
  const directory = monitorCorrelationDirectory(options.stateDirectory);
  const requestFile = path.join(directory, `request-${requestId}.json`);
  const request = {
    version: 1,
    kind: 'monitor-request',
    requestId,
    status: 'pending',
    coordinatorPid,
    workspaceId,
    createdAtMs: now,
    expiresAtMs: now + waitMs
  };
  try {
    cleanupMonitorCorrelation(options.stateDirectory, now);
    privateJson(requestFile, request);
  } catch (error) {
    return {
      ok: false,
      sessionId: null,
      reason: `correlation-state-${String(error?.code || 'unavailable').toLowerCase()}`,
      recorded: false
    };
  }

  const deadline = now + waitMs;
  let responses = [];
  do {
    responses = correlationResponses(directory, request);
    if (Date.now() >= deadline) break;
    sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (true);
  const sessionIds = [...new Set(responses.map((response) => response.sessionId))];
  const ok = sessionIds.length === 1;
  const reason = ok
    ? null
    : sessionIds.length > 1 ? 'ambiguous-session-responses' : 'correlation-timeout';
  const record = {
    ...request,
    status: ok ? 'correlated' : 'degraded',
    effectiveScope: ok ? 'session' : 'workspace',
    sessionId: ok ? sessionIds[0] : null,
    reason,
    responseCount: responses.length,
    completedAtMs: Date.now()
  };
  let recorded = true;
  try { privateJson(requestFile, record); } catch { recorded = false; }
  return {
    ok,
    sessionId: ok ? sessionIds[0] : null,
    reason,
    recorded,
    requestId,
    requestFile
  };
}
