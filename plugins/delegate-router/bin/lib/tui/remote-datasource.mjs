import { EventEmitter } from 'node:events';
import path from 'node:path';
import { aggregateJobGroups } from './datasource.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WRITE_MODES = new Set(['implement', 'verify']);
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_MAX_DIFF_CHARS = 2_000_000;

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('remote datasource URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('remote datasource URL must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function remoteJob(job) {
  return {
    ...job,
    workerAlive: TERMINAL.has(job.status) ? undefined : true,
    managedBy: job.managed ? 'delegate-control' : job.managedBy
  };
}

function remoteWriterLocks(jobs) {
  return jobs.filter((job) => job.managed && WRITE_MODES.has(job.mode) && !TERMINAL.has(job.status)).map((job) => ({
    cwd: path.resolve(job.cwd || '/'),
    jobId: job.id,
    provider: job.provider || null,
    mode: job.mode,
    status: job.status,
    phase: job.phase || null
  })).sort((left, right) => left.cwd.localeCompare(right.cwd) || left.jobId.localeCompare(right.jobId));
}

function emptyState(host) {
  return {
    jobs: [],
    eventsByJob: {},
    diffsByJob: {},
    diffStatsByJob: {},
    hydrationByJob: {},
    usage: null,
    providers: [],
    writerLocks: [],
    profiles: [],
    groups: [],
    audit: [],
    metadataReady: false,
    sessions: [],
    sessionScan: { status: 'loading', available: null, scanned: 0, totalFiles: 0, capped: false, error: null },
    stats: { since: '7d', jobs: 0, groups: [] },
    remote: {
      enabled: true,
      host,
      connection: { status: 'connecting', attempt: 0, error: null, retryAt: null }
    },
    updatedAt: null,
    error: null
  };
}

function backoff(attempt, base, maximum) {
  return Math.min(maximum, base * (2 ** Math.max(0, attempt - 1)));
}

function abortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export class RemoteDatasource extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseUrl = normalizeBaseUrl(options.baseUrl || options.connect);
    this.host = this.baseUrl.host;
    this.token = String(options.token || '').trim();
    if (!this.token) throw new Error('remote datasource token is required');
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('global fetch is unavailable; Node.js 18 or later is required');
    this.pollMs = Math.max(100, Number(options.pollMs || 5000));
    this.retryBaseMs = Math.max(10, Number(options.retryBaseMs || 250));
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(options.retryMaxMs || 30_000));
    this.requestTimeoutMs = Math.max(100, Number(options.requestTimeoutMs || 10_000));
    this.maxEvents = Math.max(100, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
    this.maxDiffChars = Math.max(200_000, Number(options.maxDiffChars || DEFAULT_MAX_DIFF_CHARS));
    this.readOnly = true;
    this.kind = 'remote';
    this.closed = false;
    this.started = false;
    this.followJobId = null;
    this.eventCursor = 0;
    this.fleetOnline = false;
    this.streamOnline = true;
    this.fleetAttempt = 0;
    this.streamAttempt = 0;
    this.pollTimer = null;
    this.streamRetryTimer = null;
    this.streamController = null;
    this.requests = new Set();
    this.state = emptyState(this.host);
  }

  getState() {
    return clone(this.state);
  }

  endpoint(relative) {
    return new URL(relative.replace(/^\//, ''), `${this.baseUrl.href.replace(/\/?$/, '/')}`).href;
  }

  async request(relative, options = {}) {
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(this.endpoint(relative), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal
      });
      if (!response.ok) throw Object.assign(new Error(`remote request failed with HTTP ${response.status}`), { status: response.status });
      if (options.response) return response;
      return await response.json();
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  start() {
    if (this.closed) throw new Error('RemoteDatasource is closed');
    if (this.started) return this;
    this.started = true;
    void this.pollFleet();
    return this;
  }

  publish() {
    if (!this.closed) this.emit('change', this.getState());
  }

  connectionStatus(error = null, retryAt = null) {
    const connected = this.fleetOnline && (!this.followJobId || this.streamOnline);
    const attempt = Math.max(this.fleetAttempt, this.streamAttempt);
    this.state = {
      ...this.state,
      remote: {
        ...this.state.remote,
        connection: {
          status: connected ? 'connected' : this.started ? 'retrying' : 'connecting',
          attempt,
          error: connected ? null : String(error?.message || this.state.remote.connection.error || 'connection unavailable').slice(0, 240),
          retryAt: connected ? null : retryAt || this.state.remote.connection.retryAt
        }
      },
      error: null,
      updatedAt: Date.now()
    };
  }

  schedulePoll(delay) {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollFleet();
    }, delay);
    this.pollTimer.unref?.();
  }

  async pollFleet() {
    if (this.closed) return this.getState();
    try {
      const [listed, usage, sessions, stats] = await Promise.all([
        this.request('/v1/jobs?limit=100'),
        this.request('/v1/usage'),
        this.request('/v1/sessions'),
        this.request('/v1/stats?since=7d')
      ]);
      if (this.closed) return this.getState();
      const previous = new Map(this.state.jobs.map((job) => [job.id, job]));
      const jobs = (listed.jobs || []).map((job) => remoteJob(this.followJobId === job.id ? { ...previous.get(job.id), ...job } : job));
      const { sessions: sessionRows = [], ...sessionSummary } = sessions || {};
      this.fleetOnline = true;
      this.fleetAttempt = 0;
      this.state = {
        ...this.state,
        jobs,
        groups: aggregateJobGroups(jobs),
        writerLocks: remoteWriterLocks(jobs),
        providers: usage.providers || [],
        metadataReady: true,
        sessions: sessionRows,
        sessionScan: { status: sessions?.available ? 'ready' : 'unavailable', ...sessionSummary },
        stats: stats || { since: '7d', jobs: 0, groups: [] },
        updatedAt: Date.now(),
        error: null
      };
      this.connectionStatus();
      this.publish();
      this.schedulePoll(this.pollMs);
    } catch (error) {
      if (this.closed || abortError(error)) return this.getState();
      this.fleetOnline = false;
      this.fleetAttempt += 1;
      const delay = backoff(this.fleetAttempt, this.retryBaseMs, this.retryMaxMs);
      this.connectionStatus(error, Date.now() + delay);
      this.publish();
      this.schedulePoll(delay);
    }
    return this.getState();
  }

  refresh() {
    return this.pollFleet();
  }

  async loadEventHistory(id) {
    const events = [];
    let cursor = 0;
    for (let pages = 0; pages < 100 && !this.closed && this.followJobId === id; pages += 1) {
      const page = await this.request(`/v1/jobs/${encodeURIComponent(id)}/events?afterSeq=${cursor}&limit=1000`);
      for (const event of page.events || []) {
        if (Number(event.seq || 0) > cursor) events.push(event);
        cursor = Math.max(cursor, Number(event.seq || 0));
      }
      if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
      cursor = Math.max(cursor, Number(page.nextSeq || 0));
      if (!page.hasMore) break;
    }
    return { events, cursor };
  }

  async loadDiff(id) {
    const stat = await this.request(`/v1/jobs/${encodeURIComponent(id)}/diff?statOnly=true`);
    let offset = 0;
    let diff = '';
    while (!this.closed && this.followJobId === id && diff.length < this.maxDiffChars) {
      const remaining = Math.min(200_000, this.maxDiffChars - diff.length);
      const page = await this.request(`/v1/jobs/${encodeURIComponent(id)}/diff?offset=${offset}&maxChars=${remaining}`);
      diff += String(page.diff || '');
      if (page.nextOffset == null || Number(page.nextOffset) <= offset) break;
      offset = Number(page.nextOffset);
    }
    return { diff, stat };
  }

  async selectJob(id) {
    this.stopStream();
    this.followJobId = id || null;
    this.streamOnline = !id;
    this.streamAttempt = 0;
    if (!id) {
      this.connectionStatus();
      this.publish();
      return this.getState();
    }

    this.state = {
      ...this.state,
      hydrationByJob: { ...this.state.hydrationByJob, [id]: { loading: true, loaded: false, error: null } },
      updatedAt: Date.now()
    };
    this.connectionStatus();
    this.publish();
    try {
      const [job, history, diff] = await Promise.all([
        this.request(`/v1/jobs/${encodeURIComponent(id)}`),
        this.loadEventHistory(id),
        this.loadDiff(id)
      ]);
      if (this.closed || this.followJobId !== id) return this.getState();
      this.eventCursor = history.cursor;
      const jobs = this.state.jobs.some((entry) => entry.id === id)
        ? this.state.jobs.map((entry) => entry.id === id ? remoteJob({ ...entry, ...job }) : entry)
        : [remoteJob(job), ...this.state.jobs];
      this.state = {
        ...this.state,
        jobs,
        groups: aggregateJobGroups(jobs),
        eventsByJob: { ...this.state.eventsByJob, [id]: history.events },
        diffsByJob: { ...this.state.diffsByJob, [id]: diff.diff },
        diffStatsByJob: { ...this.state.diffStatsByJob, [id]: diff.stat },
        hydrationByJob: { ...this.state.hydrationByJob, [id]: { loading: false, loaded: true, error: null } },
        updatedAt: Date.now()
      };
      this.publish();
    } catch (error) {
      if (!this.closed && this.followJobId === id && !abortError(error)) {
        this.state = {
          ...this.state,
          hydrationByJob: { ...this.state.hydrationByJob, [id]: { loading: false, loaded: false, error: error.message } },
          updatedAt: Date.now()
        };
        this.streamOnline = false;
        this.connectionStatus(error);
        this.publish();
      }
    }
    if (!this.closed && this.followJobId === id) void this.openStream(id);
    return this.getState();
  }

  appendStreamEvent(id, event) {
    if (this.closed || this.followJobId !== id) return;
    const current = this.state.eventsByJob[id] || [];
    if (current.some((entry) => Number(entry.seq) === Number(event.seq))) return;
    const events = [...current, event];
    if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
    this.eventCursor = Math.max(this.eventCursor, Number(event.seq || 0));
    const jobs = this.state.jobs.map((job) => job.id === id ? {
      ...job,
      lastActivityAt: Math.max(Number(job.lastActivityAt || 0), Number(event.at || 0)) || job.lastActivityAt
    } : job);
    this.state = { ...this.state, jobs, eventsByJob: { ...this.state.eventsByJob, [id]: events }, updatedAt: Date.now() };
    this.publish();
    if (event.type === 'diff.updated') void this.refreshSelectedDiff(id);
  }

  async refreshSelectedDiff(id) {
    try {
      const diff = await this.loadDiff(id);
      if (this.closed || this.followJobId !== id) return;
      this.state = {
        ...this.state,
        diffsByJob: { ...this.state.diffsByJob, [id]: diff.diff },
        diffStatsByJob: { ...this.state.diffStatsByJob, [id]: diff.stat },
        updatedAt: Date.now()
      };
      this.publish();
    } catch {}
  }

  consumeSseChunk(id, parser, chunk) {
    parser.buffer += chunk.replaceAll('\r\n', '\n');
    for (;;) {
      const boundary = parser.buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const block = parser.buffer.slice(0, boundary);
      parser.buffer = parser.buffer.slice(boundary + 2);
      if (!block || block.startsWith(':')) continue;
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { this.appendStreamEvent(id, JSON.parse(data)); } catch {}
    }
  }

  scheduleStreamRetry(id, error) {
    if (this.closed || this.followJobId !== id) return;
    this.streamOnline = false;
    this.streamAttempt += 1;
    const delay = backoff(this.streamAttempt, this.retryBaseMs, this.retryMaxMs);
    this.connectionStatus(error, Date.now() + delay);
    this.publish();
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = null;
      void this.openStream(id);
    }, delay);
    this.streamRetryTimer.unref?.();
  }

  async openStream(id) {
    if (this.closed || this.followJobId !== id) return;
    this.stopStream(false);
    const controller = new AbortController();
    this.streamController = controller;
    try {
      const response = await this.fetch(this.endpoint(`/v1/jobs/${encodeURIComponent(id)}/events/stream?afterSeq=${this.eventCursor}`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`remote event stream failed with HTTP ${response.status}`);
      if (!response.body?.getReader) throw new Error('remote event stream body is unavailable');
      this.streamOnline = true;
      this.streamAttempt = 0;
      this.connectionStatus();
      this.publish();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = { buffer: '' };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.consumeSseChunk(id, parser, decoder.decode(value, { stream: true }));
      }
      if (!this.closed && this.followJobId === id) throw new Error('remote event stream closed');
    } catch (error) {
      if (this.closed || this.followJobId !== id || abortError(error)) return;
      this.scheduleStreamRetry(id, error);
    } finally {
      if (this.streamController === controller) this.streamController = null;
    }
  }

  stopStream(clearRetry = true) {
    if (this.streamController) this.streamController.abort();
    this.streamController = null;
    if (clearRetry && this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    if (clearRetry) this.streamRetryTimer = null;
  }

  reconcileVisibleJobs() {
    return Promise.resolve(this.getState());
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.pollTimer = null;
    this.streamRetryTimer = null;
    this.stopStream();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
}

export function connectRemoteDatasource(options = {}) {
  return new RemoteDatasource(options).start();
}
