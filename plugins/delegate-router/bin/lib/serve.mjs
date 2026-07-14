import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  capEventsBySize,
  diffStat,
  filterDiffPaths,
  inspectJob,
  jobDiff,
  jobTranscriptPage,
  jobUsage,
  listManagedJobs,
  readJobEventPage,
  sliceDiff
} from './control.mjs';
import {
  avoidPercentFor,
  dataDir,
  effectiveUsage,
  enabledProviders,
  loadState,
  providerNames,
  warningPercentFor
} from './state.mjs';
import { aggregateAuditStats, readAuditLog } from './stats.mjs';
import { scanClaudeSessions } from './tui/sessions.mjs';

export const SERVE_HOST = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 4263;
export const SAFE_JOB_ID = /^[a-zA-Z0-9_-]+$/;

const MAX_CONNECTIONS = 16;
const MAX_JSON_BYTES = 256 * 1024;
const EVENT_RESPONSE_BUDGET = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_EVENT_POLL_MS = 500;
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
const STATUS_VALUES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const BIND_ENV_NAMES = ['DELEGATE_SERVE_HOST', 'DELEGATE_SERVE_BIND', 'DELEGATE_SERVE_ADDRESS', 'HOST'];

function runtimeVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validateToken(token, source) {
  const value = String(token || '').trim();
  if (!value || /\s/.test(value)) throw new Error(`${source} must be a non-empty token without whitespace`);
  return value;
}

export function assertLoopbackBind(options = {}) {
  const env = options.env || process.env;
  const requested = [options.host, ...BIND_ENV_NAMES.map((name) => env[name])].filter((value) => value != null && String(value).trim());
  for (const value of requested) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(String(value).trim().toLowerCase())) {
      throw new Error(`delegate-tui --serve is loopback-only; refusing bind address ${value}`);
    }
  }
  return SERVE_HOST;
}

export function loadOrCreateServeToken(options = {}) {
  const env = options.env || process.env;
  const directory = path.resolve(String(options.stateDir || dataDir()));
  const tokenFile = path.join(directory, 'serve-token');
  if (env.DELEGATE_SERVE_TOKEN != null) {
    return { token: validateToken(env.DELEGATE_SERVE_TOKEN, 'DELEGATE_SERVE_TOKEN'), tokenFile, created: false, source: 'env' };
  }
  try {
    const token = validateToken(fs.readFileSync(tokenFile, 'utf8'), tokenFile);
    try { fs.chmodSync(tokenFile, 0o600); } catch {}
    return { token, tokenFile, created: false, source: 'file' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(tokenFile, `${generated}\n`, { flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch {}
    return { token: generated, tokenFile, created: true, source: 'file' };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const token = validateToken(fs.readFileSync(tokenFile, 'utf8'), tokenFile);
    try { fs.chmodSync(tokenFile, 0o600); } catch {}
    return { token, tokenFile, created: false, source: 'file' };
  }
}

function bearerToken(header) {
  const match = String(header || '').match(/^Bearer ([^\s]+)$/);
  return match?.[1] || '';
}

export function authorizeBearer(header, expectedToken) {
  const suppliedDigest = crypto.createHash('sha256').update(bearerToken(header)).digest();
  const expectedDigest = crypto.createHash('sha256').update(String(expectedToken)).digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function integerParam(searchParams, name, options = {}) {
  const raw = searchParams.get(name);
  if (raw == null || raw === '') return options.defaultValue;
  if (!/^-?\d+$/.test(raw)) throw requestError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (options.min ?? 0) || value > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw requestError(`${name} must be between ${options.min ?? 0} and ${options.max ?? Number.MAX_SAFE_INTEGER}`);
  }
  return value;
}

function booleanParam(searchParams, name, defaultValue = false) {
  const raw = searchParams.get(name);
  if (raw == null || raw === '') return defaultValue;
  if (['1', 'true'].includes(raw.toLowerCase())) return true;
  if (['0', 'false'].includes(raw.toLowerCase())) return false;
  throw requestError(`${name} must be true or false`);
}

function statusParams(searchParams) {
  const values = searchParams.getAll('status').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  for (const value of values) if (!STATUS_VALUES.has(value)) throw requestError(`invalid status: ${value}`);
  return values;
}

function diffSelectors(searchParams) {
  const values = searchParams.getAll('paths').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  if (values.length > 50) throw requestError('paths accepts at most 50 diff selectors');
  for (const value of values) {
    const segments = value.replaceAll('\\', '/').split('/');
    if (value.length > 512 || path.isAbsolute(value) || value.includes('\0') || segments.includes('..')) {
      throw requestError('paths accepts only bounded repository-relative diff selectors');
    }
  }
  return values;
}

function providerUsage() {
  const usage = loadState();
  const configured = new Set(enabledProviders());
  return {
    providers: providerNames().map((name) => ({
      name,
      enabled: name === 'claude' || configured.has(name),
      allowance: effectiveUsage(usage, name),
      warningPercent: warningPercentFor(name),
      avoidPercent: avoidPercentFor(name),
      lastVerified: usage.lastVerified?.[name] || null
    }))
  };
}

function setResponseHeaders(response, contentType) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (contentType) response.setHeader('Content-Type', contentType);
}

function writeBody(response, body, writeTimeoutMs) {
  if (response.destroyed || response.writableEnded) return;
  if (response.write(body)) {
    response.end();
    return;
  }
  const timeout = setTimeout(() => response.destroy(), writeTimeoutMs);
  timeout.unref?.();
  const clear = () => clearTimeout(timeout);
  response.once('drain', () => {
    clear();
    if (!response.destroyed) response.end();
  });
  response.once('close', clear);
}

function sendStatic(response, statusCode, body, writeTimeoutMs) {
  response.statusCode = statusCode;
  setResponseHeaders(response, 'text/plain; charset=utf-8');
  writeBody(response, body, writeTimeoutMs);
}

function sendJson(response, value, writeTimeoutMs) {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
    sendStatic(response, 413, 'Response too large\n', writeTimeoutMs);
    return;
  }
  response.statusCode = 200;
  setResponseHeaders(response, 'application/json; charset=utf-8');
  writeBody(response, body, writeTimeoutMs);
}

function jobIdFromSegment(segment) {
  let id;
  try { id = decodeURIComponent(segment); }
  catch { throw requestError('Invalid job id'); }
  if (!SAFE_JOB_ID.test(id)) throw requestError('Invalid job id');
  return id;
}

function errorStatus(error) {
  if (error?.statusCode) return error.statusCode;
  if (error?.code === 'NOT_FOUND') return 404;
  if (error?.code === 'INVALID_REQUEST') return 400;
  return 500;
}

function routeRequest(url) {
  if (url.pathname === '/v1/health') return { name: 'health' };
  if (url.pathname === '/v1/jobs') return { name: 'jobs' };
  if (url.pathname === '/v1/usage') return { name: 'usage' };
  if (url.pathname === '/v1/sessions') return { name: 'sessions' };
  if (url.pathname === '/v1/stats') return { name: 'stats' };
  const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/(events(?:\/stream)?|transcript|diff|usage))?$/);
  if (!match) return null;
  return { name: match[2] === 'usage' ? 'job-usage' : match[2] || 'job', id: jobIdFromSegment(match[1]) };
}

function eventPage(id, searchParams) {
  return capEventsBySize(readJobEventPage(id, {
    afterSeq: integerParam(searchParams, 'afterSeq', { min: 0, defaultValue: 0 }),
    limit: integerParam(searchParams, 'limit', { min: 1, max: 1000, defaultValue: 200 })
  }), EVENT_RESPONSE_BUDGET);
}

function transcriptPage(id, searchParams) {
  return capEventsBySize(jobTranscriptPage(id, {
    afterSeq: integerParam(searchParams, 'afterSeq', { min: 0, defaultValue: 0 }),
    limit: integerParam(searchParams, 'limit', { min: 1, max: 1000, defaultValue: 200 }),
    verbose: booleanParam(searchParams, 'verbose', true)
  }), EVENT_RESPONSE_BUDGET);
}

function writeSse(response, text, stream, writeTimeoutMs) {
  if (stream.blocked || response.destroyed || response.writableEnded) return false;
  if (response.write(text)) return true;
  stream.blocked = true;
  stream.slowTimer = setTimeout(() => response.destroy(), writeTimeoutMs);
  stream.slowTimer.unref?.();
  response.once('drain', () => {
    clearTimeout(stream.slowTimer);
    stream.slowTimer = null;
    stream.blocked = false;
  });
  return false;
}

function startEventStream(request, response, id, searchParams, options) {
  inspectJob(id);
  const stream = {
    cursor: integerParam(searchParams, 'afterSeq', { min: 0, defaultValue: 0 }),
    blocked: false,
    pumping: false,
    slowTimer: null,
    poll: null,
    heartbeat: null
  };
  response.statusCode = 200;
  setResponseHeaders(response, 'text/event-stream; charset=utf-8');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  options.streams.add(response);
  writeSse(response, 'retry: 1000\n\n', stream, options.writeTimeoutMs);

  const cleanup = () => {
    if (stream.poll) clearInterval(stream.poll);
    if (stream.heartbeat) clearInterval(stream.heartbeat);
    if (stream.slowTimer) clearTimeout(stream.slowTimer);
    options.streams.delete(response);
  };
  request.once('close', cleanup);
  response.once('close', cleanup);

  const pump = () => {
    if (stream.pumping || stream.blocked || response.destroyed || response.writableEnded) return;
    stream.pumping = true;
    try {
      for (let pages = 0; pages < 5; pages += 1) {
        const page = capEventsBySize(readJobEventPage(id, { afterSeq: stream.cursor, limit: 200 }), EVENT_RESPONSE_BUDGET);
        for (const event of page.events) {
          if (!writeSse(response, `id: ${event.seq}\nevent: job-event\ndata: ${JSON.stringify(event)}\n\n`, stream, options.writeTimeoutMs)) break;
          stream.cursor = Math.max(stream.cursor, Number(event.seq || 0));
        }
        if (stream.blocked || !page.hasMore || page.nextSeq <= stream.cursor) break;
        stream.cursor = Math.max(stream.cursor, Number(page.nextSeq || 0));
      }
    } catch (error) {
      writeSse(response, `event: stream-error\ndata: ${JSON.stringify({ code: error?.code || 'READ_ERROR' })}\n\n`, stream, options.writeTimeoutMs);
      response.end();
    } finally {
      stream.pumping = false;
    }
  };
  pump();
  stream.poll = setInterval(pump, options.eventPollMs);
  stream.poll.unref?.();
  stream.heartbeat = setInterval(() => {
    writeSse(response, `: heartbeat ${Date.now()}\n\n`, stream, options.writeTimeoutMs);
  }, options.heartbeatMs);
  stream.heartbeat.unref?.();
}

export function createDelegateServeServer(options = {}) {
  const env = options.env || process.env;
  assertLoopbackBind({ env, host: options.host });
  const token = validateToken(options.token ?? env.DELEGATE_SERVE_TOKEN, 'serve token');
  const startedAt = Date.now();
  const heartbeatMs = Math.max(10, Number(options.heartbeatMs || DEFAULT_HEARTBEAT_MS));
  const eventPollMs = Math.max(10, Number(options.eventPollMs || DEFAULT_EVENT_POLL_MS));
  const writeTimeoutMs = Math.max(heartbeatMs + 1000, Number(options.writeTimeoutMs || DEFAULT_WRITE_TIMEOUT_MS));
  const logger = options.logger || ((line) => process.stderr.write(`${line}\n`));
  const streams = new Set();
  const sockets = new Set();

  const server = http.createServer((request, response) => {
    const requestStarted = performance.now();
    let logged = false;
    let pathname = '/';
    const log = () => {
      if (logged) return;
      logged = true;
      logger(`${request.method || 'GET'} ${pathname} ${response.statusCode || 0} ${Math.round(performance.now() - requestStarted)}ms`);
    };
    response.once('finish', log);
    response.once('close', log);
    request.socket.setTimeout(writeTimeoutMs, () => request.socket.destroy());

    let url;
    try {
      url = new URL(request.url || '/', `http://${SERVE_HOST}`);
      pathname = url.pathname;
    } catch {
      sendStatic(response, 400, 'Bad request\n', writeTimeoutMs);
      return;
    }
    if (!authorizeBearer(request.headers.authorization, token)) {
      sendStatic(response, 401, 'Unauthorized\n', writeTimeoutMs);
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendStatic(response, 405, 'Method not allowed\n', writeTimeoutMs);
      return;
    }

    try {
      const route = routeRequest(url);
      if (!route) {
        sendStatic(response, 404, 'Not found\n', writeTimeoutMs);
        return;
      }
      if (route.name === 'health') {
        sendJson(response, { version: runtimeVersion(), uptime: Math.max(0, (Date.now() - startedAt) / 1000) }, writeTimeoutMs);
        return;
      }
      if (route.name === 'jobs') {
        const status = statusParams(url.searchParams);
        const result = listManagedJobs({
          limit: integerParam(url.searchParams, 'limit', { min: 1, max: 100, defaultValue: 100 }),
          activeOnly: booleanParam(url.searchParams, 'activeOnly', false),
          ...(status.length ? { status } : {}),
          ...(url.searchParams.get('groupId') ? { groupId: url.searchParams.get('groupId') } : {})
        });
        sendJson(response, result, writeTimeoutMs);
        return;
      }
      if (route.name === 'usage') {
        sendJson(response, providerUsage(), writeTimeoutMs);
        return;
      }
      if (route.name === 'sessions') {
        sendJson(response, scanClaudeSessions({ env }), writeTimeoutMs);
        return;
      }
      if (route.name === 'stats') {
        sendJson(response, aggregateAuditStats(readAuditLog(), { since: url.searchParams.get('since') || '7d' }), writeTimeoutMs);
        return;
      }
      if (route.name === 'job') {
        sendJson(response, inspectJob(route.id), writeTimeoutMs);
        return;
      }
      if (route.name === 'events') {
        sendJson(response, eventPage(route.id, url.searchParams), writeTimeoutMs);
        return;
      }
      if (route.name === 'events/stream') {
        startEventStream(request, response, route.id, url.searchParams, { streams, heartbeatMs, eventPollMs, writeTimeoutMs });
        return;
      }
      if (route.name === 'transcript') {
        inspectJob(route.id);
        sendJson(response, transcriptPage(route.id, url.searchParams), writeTimeoutMs);
        return;
      }
      if (route.name === 'job-usage') {
        sendJson(response, jobUsage(route.id), writeTimeoutMs);
        return;
      }
      if (route.name === 'diff') {
        inspectJob(route.id);
        const filtered = filterDiffPaths(jobDiff(route.id), diffSelectors(url.searchParams));
        const result = booleanParam(url.searchParams, 'statOnly', false)
          ? diffStat(filtered)
          : sliceDiff(filtered, {
            offset: integerParam(url.searchParams, 'offset', { min: 0, defaultValue: 0 }),
            maxChars: integerParam(url.searchParams, 'maxChars', { min: 1000, max: 200000, defaultValue: 60000 })
          });
        sendJson(response, result, writeTimeoutMs);
      }
    } catch (error) {
      const status = errorStatus(error);
      const body = status === 404 ? 'Not found\n' : status === 400 ? 'Bad request\n' : 'Internal error\n';
      sendStatic(response, status, body, writeTimeoutMs);
    }
  });

  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (sockets.size > MAX_CONNECTIONS) socket.destroy();
  });
  server.delegateStreams = streams;
  server.delegateSockets = sockets;
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, SERVE_HOST);
  });
}

export async function closeDelegateServeServer(server, options = {}) {
  if (!server?.listening) return;
  for (const response of server.delegateStreams || []) {
    try { response.end(': shutdown\n\n'); } catch {}
  }
  const closed = new Promise((resolve) => server.close(resolve));
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 2000));
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const socket of server.delegateSockets || []) socket.destroy();
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([closed, timeout]);
}

export async function startDelegateServe(options = {}) {
  const env = options.env || process.env;
  const host = assertLoopbackBind({ env, host: options.host });
  const port = Number(options.port ?? DEFAULT_SERVE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('serve port must be an integer between 0 and 65535');
  const credentials = options.token
    ? { token: validateToken(options.token, 'serve token'), tokenFile: path.join(path.resolve(String(options.stateDir || dataDir())), 'serve-token'), created: false, source: 'option' }
    : loadOrCreateServeToken({ env, stateDir: options.stateDir });
  const server = createDelegateServeServer({ ...options, env, host, token: credentials.token });
  await listen(server, port);
  const address = server.address();
  return {
    server,
    host,
    port: typeof address === 'object' && address ? address.port : port,
    ...credentials,
    close: (closeOptions) => closeDelegateServeServer(server, closeOptions)
  };
}
