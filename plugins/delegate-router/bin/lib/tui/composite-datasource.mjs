import { EventEmitter } from 'node:events';
import os from 'node:os';
import { aggregateJobGroups } from './datasource.mjs';
import { redactedRemoteLabel } from './remote-config.mjs';

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function safeKey(value, fallback) {
  const key = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return key || fallback;
}

function localHostLabel() {
  return String(os.hostname() || 'local').split('.')[0].slice(0, 80) || 'local';
}

function emptyState(includeLocal) {
  return {
    jobs: [], eventsByJob: {}, activityEventsByJob: {}, diffsByJob: {}, diffStatsByJob: {}, hydrationByJob: {},
    usage: null, providers: [], writerLocks: [], profiles: [], groups: [], audit: [], metadataReady: false,
    sessions: [], sessionScan: { status: 'loading', available: null, scanned: 0, totalFiles: 0, capped: false, error: null },
    externalScan: { status: 'loading', available: null, scanned: 0, totalFiles: 0, capped: false, error: null },
    stats: { since: '7d', jobs: 0, groups: [] },
    remote: {
      enabled: true,
      federation: true,
      includeLocal,
      host: 'fleet',
      hosts: [],
      connection: { status: 'connecting', attempt: 0, error: null, retryAt: null }
    },
    updatedAt: null,
    error: null
  };
}

export class CompositeDatasource extends EventEmitter {
  constructor(entries = [], options = {}) {
    super();
    this.entries = entries.map((entry, index) => ({
      source: entry.source,
      local: entry.local === true,
      label: redactedRemoteLabel(entry.label, entry.local ? localHostLabel() : entry.source?.host || `host-${index + 1}`),
      key: safeKey(entry.key || entry.label, `host-${index + 1}`),
      index
    }));
    if (!this.entries.length) throw new Error('composite datasource requires at least one source');
    this.includeLocal = this.entries.some((entry) => entry.local);
    this.readOnly = !this.includeLocal;
    this.kind = 'composite';
    this.closed = false;
    this.routes = new Map();
    this.listeners = [];
    this.state = emptyState(this.includeLocal);
    for (const entry of this.entries) {
      const change = () => this.publish();
      const warning = (error) => this.emit('warning', Object.assign(new Error(`${entry.label}: ${error.message}`), { cause: error }));
      entry.source.on?.('change', change);
      entry.source.on?.('warning', warning);
      this.listeners.push({ entry, change, warning });
    }
    this.publish(false);
  }

  compositeId(entry, id) {
    return entry.local ? id : `remote-${entry.index + 1}-${id}`;
  }

  compositeGroup(entry, groupId) {
    return groupId && !entry.local ? `${entry.key}-${groupId}`.slice(0, 128) : groupId;
  }

  publish(emit = true) {
    if (this.closed) return;
    const routes = new Map();
    const jobs = [];
    const eventsByJob = {};
    const activityEventsByJob = {};
    const diffsByJob = {};
    const diffStatsByJob = {};
    const hydrationByJob = {};
    const providers = [];
    const writerLocks = [];
    const sessions = [];
    const audit = [];
    const statsGroups = [];
    const profiles = new Set();
    const hosts = [];
    let statsJobs = 0;
    let metadataReady = true;
    let totalSessionFiles = 0;
    let scannedSessions = 0;
    let totalExternalFiles = 0;
    let scannedExternal = 0;
    let externalThreads = 0;
    let externalUsageThreads = 0;
    const externalTokenTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const unattributed = { markerCount: 0, byWindow: {}, latest: null, approximate: true };
    const errors = [];

    for (const entry of this.entries) {
      const child = entry.source.getState();
      const connection = entry.local
        ? { status: 'connected', attempt: 0, error: null, retryAt: null }
        : child.remote?.connection || { status: 'connecting', attempt: 0, error: null, retryAt: null };
      hosts.push({ label: entry.label, key: entry.key, local: entry.local, connection });
      if (child.error) errors.push(`${entry.label}: ${child.error}`);
      metadataReady &&= child.metadataReady !== false;
      for (const job of child.jobs || []) {
        const id = this.compositeId(entry, job.id);
        routes.set(id, { entry, id: job.id });
        jobs.push({
          ...job,
          id,
          sourceJobId: job.id,
          sourceKey: entry.key,
          host: entry.label,
          remote: !entry.local,
          readOnly: entry.local ? job.readOnly === true : true,
          groupId: this.compositeGroup(entry, job.groupId),
          parentJobId: job.parentJobId ? this.compositeId(entry, job.parentJobId) : null,
          rootJobId: job.rootJobId ? this.compositeId(entry, job.rootJobId) : null
        });
        if (child.eventsByJob?.[job.id]) eventsByJob[id] = child.eventsByJob[job.id];
        if (child.activityEventsByJob?.[job.id]) activityEventsByJob[id] = child.activityEventsByJob[job.id];
        if (Object.hasOwn(child.diffsByJob || {}, job.id)) diffsByJob[id] = child.diffsByJob[job.id];
        if (child.diffStatsByJob?.[job.id]) diffStatsByJob[id] = child.diffStatsByJob[job.id];
        if (child.hydrationByJob?.[job.id]) hydrationByJob[id] = child.hydrationByJob[job.id];
      }
      for (const provider of child.providers || []) providers.push(entry.local
        ? { ...provider, host: entry.label }
        : { ...provider, name: `${provider.name}@${entry.label}`, provider: provider.name, host: entry.label });
      for (const lock of child.writerLocks || []) writerLocks.push({ ...lock, jobId: this.compositeId(entry, lock.jobId), host: entry.label });
      for (const session of child.sessions || []) sessions.push({ ...session, id: this.compositeId(entry, session.id), sourceSessionId: session.id, host: entry.label });
      for (const record of child.audit || []) audit.push({ ...record, jobId: this.compositeId(entry, record.jobId), host: entry.label });
      for (const group of child.stats?.groups || []) statsGroups.push({ ...group, host: entry.label });
      statsJobs += Number(child.stats?.jobs || 0);
      for (const profile of child.profiles || []) profiles.add(profile);
      totalSessionFiles += Number(child.sessionScan?.totalFiles || 0);
      scannedSessions += Number(child.sessionScan?.scanned || 0);
      totalExternalFiles += Number(child.externalScan?.totalFiles || 0);
      scannedExternal += Number(child.externalScan?.scanned || 0);
      externalThreads += Number(child.stats?.external?.threadCount || 0);
      externalUsageThreads += Number(child.stats?.external?.usageThreadCount || 0);
      for (const key of Object.keys(externalTokenTotals)) externalTokenTotals[key] += Number(child.stats?.external?.tokenTotals?.[key] || 0);
      unattributed.markerCount += Number(child.stats?.unattributed?.markerCount || 0);
      for (const [name, window] of Object.entries(child.stats?.unattributed?.byWindow || {})) {
        unattributed.byWindow[name] ||= { markers: 0, amountPercent: 0, latestAt: null };
        unattributed.byWindow[name].markers += Number(window.markers || 0);
        unattributed.byWindow[name].amountPercent += Number(window.amountPercent || 0);
        unattributed.byWindow[name].latestAt = Math.max(Number(unattributed.byWindow[name].latestAt || 0), Number(window.latestAt || 0)) || null;
      }
      if (Number(child.stats?.unattributed?.latest?.at || 0) > Number(unattributed.latest?.at || 0)) unattributed.latest = child.stats.unattributed.latest;
    }
    this.routes = routes;
    const connected = hosts.filter((host) => host.connection.status === 'connected').length;
    const status = connected === hosts.length ? 'connected' : connected > 0 ? 'degraded' : 'retrying';
    const attempts = hosts.map((host) => Number(host.connection.attempt || 0));
    const retryTimes = hosts.map((host) => Number(host.connection.retryAt || 0)).filter(Boolean);
    this.state = {
      ...this.state,
      jobs,
      eventsByJob,
      activityEventsByJob,
      diffsByJob,
      diffStatsByJob,
      hydrationByJob,
      providers,
      writerLocks,
      profiles: [...profiles].sort(),
      groups: aggregateJobGroups(jobs),
      audit,
      metadataReady,
      sessions,
      sessionScan: { status: 'ready', available: true, scanned: scannedSessions, totalFiles: totalSessionFiles, capped: false, error: null },
      externalScan: { status: 'ready', available: true, scanned: scannedExternal, totalFiles: totalExternalFiles, capped: false, error: null },
      stats: {
        since: '7d',
        jobs: statsJobs,
        groups: statsGroups,
        external: { threadCount: externalThreads, usageThreadCount: externalUsageThreads, tokenTotals: externalUsageThreads ? externalTokenTotals : null },
        unattributed
      },
      remote: {
        enabled: true,
        federation: true,
        includeLocal: this.includeLocal,
        host: 'fleet',
        hosts,
        connection: {
          status,
          attempt: Math.max(0, ...attempts),
          error: errors.join('; ').slice(0, 500) || null,
          retryAt: retryTimes.length ? Math.min(...retryTimes) : null
        }
      },
      updatedAt: Date.now(),
      error: errors.join('; ').slice(0, 500) || null
    };
    if (emit) this.emit('change', this.getState());
  }

  getState() {
    return clone(this.state);
  }

  start() {
    for (const entry of this.entries) entry.source.start?.();
    this.publish();
    return this;
  }

  refresh() {
    for (const entry of this.entries) {
      try {
        const result = entry.source.refresh?.();
        if (result?.then) void result.catch((error) => this.emit('warning', error));
      } catch (error) { this.emit('warning', error); }
    }
    this.publish();
    return this.getState();
  }

  async selectJob(id) {
    const route = id ? this.routes.get(id) : null;
    const tasks = [];
    for (const entry of this.entries) {
      const selected = route?.entry === entry ? route.id : null;
      try { tasks.push(Promise.resolve(entry.source.selectJob?.(selected))); }
      catch (error) { this.emit('warning', error); }
    }
    await Promise.allSettled(tasks);
    this.publish();
    return this.getState();
  }

  reconcileVisibleJobs(ids, options = {}) {
    const local = this.entries.find((entry) => entry.local);
    if (!local?.source.reconcileVisibleJobs) return Promise.resolve(this.getState());
    const localIds = (ids || []).flatMap((id) => {
      const route = this.routes.get(id);
      return route?.entry === local ? [route.id] : [];
    });
    return Promise.resolve(local.source.reconcileVisibleJobs(localIds, options)).then(() => {
      this.publish();
      return this.getState();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { entry, change, warning } of this.listeners) {
      entry.source.off?.('change', change);
      entry.source.off?.('warning', warning);
    }
    this.listeners = [];
    for (const entry of this.entries) entry.source.close?.();
  }
}

export function composeDatasources(entries, options = {}) {
  return new CompositeDatasource(entries, options).start();
}
