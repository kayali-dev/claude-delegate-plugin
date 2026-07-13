import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeWriterLocks,
  diffStat,
  eventPath,
  jobNeedsReconciliation,
  readJobEventPage,
  readLastCompleteEvent,
  reconcileJob
} from '../control.mjs';
import { isProcessAlive } from '../process.mjs';
import { profilesDir } from '../profiles.mjs';
import {
  auditLogPath,
  avoidPercentFor,
  dataDir,
  effectiveUsage,
  enabledProviders,
  jobsDir,
  listJobs,
  loadState,
  providerConfigPath,
  providerNames,
  statePath,
  warningPercentFor
} from '../state.mjs';
import { aggregateAuditStats, readAuditLog } from '../stats.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_MAX_EVENTS = 5000;

function readDiffArtifact(event) {
  if (typeof event?.data?.diff === 'string') return event.data.diff;
  if (!event?.data?.artifactPath) return '';
  try { return fs.readFileSync(event.data.artifactPath, 'utf8'); }
  catch { return ''; }
}

function bundledProfilesDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'delegate', 'profiles');
}

function profileNames() {
  const names = new Set();
  for (const directory of [profilesDir(), bundledProfilesDir()]) {
    try {
      for (const name of fs.readdirSync(directory)) if (name.endsWith('.md')) names.add(name.slice(0, -3));
    } catch {}
  }
  return [...names].sort();
}

function providerSnapshots(usageState) {
  const configured = new Set(enabledProviders());
  return providerNames().map((name) => ({
    name,
    enabled: name === 'claude' || configured.has(name),
    allowance: effectiveUsage(usageState, name),
    warningPercent: warningPercentFor(name),
    avoidPercent: avoidPercentFor(name),
    lastVerified: usageState.lastVerified?.[name] || null
  }));
}

function rootJobId(job, jobsById) {
  let current = job;
  const seen = new Set([job.id]);
  while (current.parentJobId && !seen.has(current.parentJobId)) {
    seen.add(current.parentJobId);
    const parent = jobsById.get(current.parentJobId);
    if (!parent) break;
    current = parent;
  }
  return current.id === job.id ? null : current.id;
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch { return '-'; }
}

function cloneState(state) {
  return {
    ...state,
    jobs: state.jobs.map((job) => ({ ...job })),
    eventsByJob: Object.fromEntries(Object.entries(state.eventsByJob).map(([id, events]) => [id, [...events]])),
    diffsByJob: { ...state.diffsByJob },
    diffStatsByJob: Object.fromEntries(Object.entries(state.diffStatsByJob).map(([id, stat]) => [id, { ...stat, files: [...stat.files] }])),
    hydrationByJob: Object.fromEntries(Object.entries(state.hydrationByJob).map(([id, hydration]) => [id, { ...hydration }])),
    providers: state.providers.map((provider) => ({
      ...provider,
      allowance: { ...provider.allowance, windows: [...provider.allowance.windows] }
    })),
    writerLocks: state.writerLocks.map((lock) => ({ ...lock })),
    profiles: [...state.profiles],
    stats: { ...state.stats, groups: [...state.stats.groups] }
  };
}

export class DelegateDataSource extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollMs = Math.max(100, Number(options.pollMs || 2000));
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? 80));
    this.maxEvents = Math.max(100, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
    this.watchEnabled = options.watch !== false;
    this.journalCursors = new Map();
    this.hydratedJobs = new Set();
    this.hydrations = new Map();
    this.events = new Map();
    this.diffs = new Map();
    this.followJobId = null;
    this.watchers = [];
    this.pollTimer = null;
    this.debounceTimer = null;
    this.pendingKinds = new Set();
    this.immediates = new Map();
    this.reconcileAttempts = new Map();
    this.reconciledByTui = new Map();
    this.reconcileTask = null;
    this.closed = false;
    this.recordsDigest = null;
    this.metadataStamp = null;
    this.metrics = { refreshes: 0, journalPages: 0, journalEvents: 0, reconciliations: 0, startupMs: null };
    this.state = {
      jobs: [], eventsByJob: {}, diffsByJob: {}, diffStatsByJob: {}, hydrationByJob: {},
      usage: null, providers: [], writerLocks: [], profiles: [], audit: [], metadataReady: false,
      stats: { since: '7d', jobs: 0, groups: [] }, updatedAt: null, error: null
    };
  }

  getState() {
    return cloneState(this.state);
  }

  yieldTurn() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const handle = setImmediate(() => {
        this.immediates.delete(handle);
        resolve();
      });
      this.immediates.set(handle, resolve);
    });
  }

  start() {
    if (this.closed) throw new Error('DelegateDataSource is closed');
    const started = performance.now();
    this.refreshRecords({ force: true });
    this.metrics.startupMs = performance.now() - started;
    if (this.watchEnabled) this.installWatchers();
    this.pollTimer = setInterval(() => this.scheduleRefresh('all'), this.pollMs);
    this.pollTimer.unref?.();
    void this.yieldTurn().then(() => { if (!this.closed) this.hydrateMetadata({ force: true }); });
    return this;
  }

  installWatchers() {
    const add = (target, kind, accept = null) => {
      try {
        const watcher = fs.watch(target, { persistent: false }, (_event, filename) => {
          if (accept && !accept(String(filename || ''))) return;
          this.scheduleRefresh(kind);
        });
        watcher.on('error', () => this.scheduleRefresh(kind));
        this.watchers.push(watcher);
        return true;
      } catch { return false; }
    };
    const jobChange = (name) => !name || name.endsWith('.json') || name.endsWith('.events.jsonl') || name.endsWith('.finished');
    if (!add(jobsDir(), 'jobs', jobChange)) add(dataDir(), 'jobs', (name) => !name || name === 'jobs');
    add(statePath(), 'metadata');
    add(auditLogPath(), 'metadata');
  }

  scheduleRefresh(kind = 'all') {
    if (this.closed) return;
    this.pendingKinds.add(kind);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const kinds = new Set(this.pendingKinds);
      this.pendingKinds.clear();
      if (kinds.has('all') || kinds.has('jobs')) this.refreshRecords();
      if (kinds.has('all') || kinds.has('metadata')) this.hydrateMetadata();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  activityFields(job, cached = null) {
    const recordActivityAt = job.updatedAt || job.createdAt ? (job.updatedAt || job.createdAt) * 1000 : null;
    const lastActivityAt = cached?.lastActivityAt == null
      ? recordActivityAt
      : recordActivityAt == null ? cached.lastActivityAt : Math.max(cached.lastActivityAt, recordActivityAt);
    const configured = Number(process.env.DELEGATE_STALL_SECONDS ?? 300);
    const stallSeconds = Number.isFinite(configured) && configured >= 0 ? configured : 300;
    return {
      lastActivityAt,
      stalled: job.status === 'running' && lastActivityAt != null && Date.now() - lastActivityAt > stallSeconds * 1000
    };
  }

  refreshRecords(options = {}) {
    if (this.closed) return this.getState();
    this.metrics.refreshes += 1;
    try {
      const rawJobs = listJobs();
      const ids = new Set(rawJobs.map((job) => job.id));
      const jobsById = new Map(rawJobs.map((job) => [job.id, job]));
      const cachedById = new Map(this.state.jobs.map((job) => [job.id, job]));
      const jobs = rawJobs.map((job) => ({
        ...job,
        ...this.activityFields(job, cachedById.get(job.id)),
        workerAlive: TERMINAL.has(job.status) ? undefined : isProcessAlive(job.workerPid || job.pid),
        tuiReconciledFrom: this.reconciledByTui.get(job.id) || null,
        rootJobId: rootJobId(job, jobsById)
      }));
      for (const id of [...this.journalCursors.keys()]) {
        if (ids.has(id)) continue;
        this.journalCursors.delete(id);
        this.hydratedJobs.delete(id);
        this.events.delete(id);
        this.diffs.delete(id);
        this.reconcileAttempts.delete(id);
        this.reconciledByTui.delete(id);
      }
      const digest = JSON.stringify(jobs.map((job) => [job.id, job.revision, job.status, job.phase, job.updatedAt, job.lastActivityAt, job.stalled, job.workerAlive]));
      const changed = options.force || digest !== this.recordsDigest;
      this.recordsDigest = digest;
      this.state = {
        ...this.state,
        jobs,
        writerLocks: activeWriterLocks(rawJobs),
        updatedAt: Date.now(),
        error: null
      };
      if (changed) this.emit('change', this.getState());
      if (this.followJobId && ids.has(this.followJobId)) void this.hydrateJob(this.followJobId);
    } catch (error) {
      this.state = { ...this.state, error: error.message, updatedAt: Date.now() };
      this.emit('warning', error);
      if (options.force) this.emit('change', this.getState());
    }
    return this.getState();
  }

  metadataFingerprint() {
    return [statePath(), auditLogPath(), providerConfigPath(), profilesDir(), bundledProfilesDir()].map(fileStamp).join('|');
  }

  hydrateMetadata(options = {}) {
    if (this.closed) return this.getState();
    const stamp = this.metadataFingerprint();
    if (!options.force && stamp === this.metadataStamp) return this.getState();
    try {
      const usage = loadState();
      const audit = readAuditLog();
      this.metadataStamp = stamp;
      this.state = {
        ...this.state,
        usage,
        providers: providerSnapshots(usage),
        profiles: profileNames(),
        audit,
        stats: aggregateAuditStats(audit, { since: '7d' }),
        metadataReady: true,
        updatedAt: Date.now(),
        error: null
      };
      this.emit('change', this.getState());
    } catch (error) {
      this.state = { ...this.state, error: error.message, updatedAt: Date.now() };
      this.emit('warning', error);
    }
    return this.getState();
  }

  publishJournal(id, hydration) {
    const last = readLastCompleteEvent(eventPath(id));
    const jobs = this.state.jobs.map((job) => job.id === id ? { ...job, ...this.activityFields(job, { lastActivityAt: last?.at }) } : job);
    this.state = {
      ...this.state,
      jobs,
      eventsByJob: Object.fromEntries([...this.events.entries()]),
      diffsByJob: Object.fromEntries([...this.diffs.entries()]),
      diffStatsByJob: Object.fromEntries([...this.diffs.entries()].map(([jobId, diff]) => [jobId, diffStat(diff)])),
      hydrationByJob: { ...this.state.hydrationByJob, [id]: hydration },
      updatedAt: Date.now()
    };
    this.emit('change', this.getState());
  }

  selectJob(id) {
    this.followJobId = id || null;
    if (!id) return Promise.resolve(this.getState());
    return this.hydrateJob(id);
  }

  reconcileVisibleJobs(ids, options = {}) {
    if (this.closed) return Promise.resolve(this.getState());
    if (this.reconcileTask) return this.reconcileTask;
    const limit = Math.min(5, Math.max(0, Number(options.limit ?? 5)));
    if (!limit) return Promise.resolve(this.getState());
    const jobsById = new Map(this.state.jobs.map((job) => [job.id, job]));
    const candidates = [];
    for (const id of new Set(ids || [])) {
      const job = jobsById.get(id);
      if (!job || !jobNeedsReconciliation(job, { workerAlive: job.workerAlive, nowSeconds: Date.now() / 1000 })) continue;
      const fingerprint = JSON.stringify([job.status, job.revision, job.createdAt, job.workerPid || job.pid || null, job.workerAlive]);
      if (this.reconcileAttempts.get(id) === fingerprint) continue;
      this.reconcileAttempts.set(id, fingerprint);
      candidates.push(id);
      if (candidates.length >= limit) break;
    }
    if (!candidates.length) return Promise.resolve(this.getState());
    const task = (async () => {
      await this.yieldTurn();
      if (this.closed) return this.getState();
      for (const id of candidates) {
        try {
          const before = this.state.jobs.find((job) => job.id === id);
          const reconciled = reconcileJob(id);
          if (before && !TERMINAL.has(before.status) && TERMINAL.has(reconciled?.status)) {
            this.reconciledByTui.set(id, before.status);
          }
          this.metrics.reconciliations += 1;
        } catch (error) {
          this.emit('warning', error);
        }
      }
      if (!this.closed) this.refreshRecords({ force: true });
      return this.getState();
    })().finally(() => {
      if (this.reconcileTask === task) this.reconcileTask = null;
    });
    this.reconcileTask = task;
    return task;
  }

  hydrateJob(id) {
    if (this.closed) return Promise.resolve(this.getState());
    if (this.hydrations.has(id)) return this.hydrations.get(id);
    const firstLoad = !this.hydratedJobs.has(id);
    if (firstLoad) {
      this.hydratedJobs.add(id);
      this.journalCursors.set(id, 0);
      this.events.set(id, []);
      this.diffs.delete(id);
    }
    const wasLoaded = this.state.hydrationByJob[id]?.loaded === true;
    this.publishJournal(id, { loading: true, loaded: wasLoaded, error: null });
    const task = (async () => {
      await this.yieldTurn();
      let cursor = this.journalCursors.get(id) || 0;
      let complete = false;
      try {
        while (!this.closed && this.followJobId === id) {
          const page = readJobEventPage(id, { afterSeq: cursor, limit: 1000 });
          this.metrics.journalPages += 1;
          if (page.events.length) {
            const collected = this.events.get(id) || [];
            collected.push(...page.events);
            if (collected.length > this.maxEvents) collected.splice(0, collected.length - this.maxEvents);
            this.events.set(id, collected);
            this.metrics.journalEvents += page.events.length;
            for (const event of page.events) if (event.type === 'diff.updated') this.diffs.set(id, readDiffArtifact(event));
          }
          const next = Math.max(cursor, page.nextSeq);
          this.journalCursors.set(id, next);
          complete = !page.hasMore || next <= cursor;
          this.publishJournal(id, { loading: !complete, loaded: complete || wasLoaded, error: null });
          if (complete) break;
          cursor = next;
          await this.yieldTurn();
        }
        if (!this.closed) this.publishJournal(id, { loading: false, loaded: complete || wasLoaded, error: null });
      } catch (error) {
        if (!this.closed) {
          this.publishJournal(id, { loading: false, loaded: wasLoaded, error: error.message });
          this.emit('warning', error);
        }
      } finally {
        this.hydrations.delete(id);
      }
      return this.getState();
    })();
    this.hydrations.set(id, task);
    return task;
  }

  refresh(options = {}) {
    const state = this.refreshRecords(options);
    if (options.metadata === true) this.hydrateMetadata({ force: options.force });
    return state;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch {}
    }
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.pendingKinds.clear();
    this.reconcileAttempts.clear();
    this.reconciledByTui.clear();
    for (const [handle, resolve] of this.immediates) {
      clearImmediate(handle);
      resolve();
    }
    this.immediates.clear();
    this.reconcileTask = null;
    this.hydrations.clear();
  }
}

export function tailAllJobs(options = {}) {
  return new DelegateDataSource(options).start();
}

export function isActiveJob(job) {
  return Boolean(job && !TERMINAL.has(job.status));
}
