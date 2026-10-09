import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeWriterLocks,
  agentStubActivity,
  diffStat,
  eventPath,
  jobNeedsReconciliation,
  readJobEventPage,
  readLastCompleteEvent,
  reconcileJob,
  cancelTransientControl,
  submitTransientControl,
  updateManagedJob
} from '../control.mjs';
import {
  resolveStoredAgentTranscriptPath,
  transcriptAgentIdForJob,
  transcriptPathMatchesAgentId
} from '../agent-stubs.mjs';
import { isProcessAlive } from '../process.mjs';
import { outputQuiet } from '../job-health.mjs';
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
import { aggregateVisibilityStats, readAuditLog } from '../stats.mjs';
import {
  brokerOwnedCodexThreadIds,
  externalThreadStats,
  findCodexThreadRollout,
  readCodexThreadTail,
  scanExternalCodexThreads
} from '../codex-sessions.mjs';
import {
  CHILD_TRANSCRIPT_MAX_CHARS,
  CHILD_TRANSCRIPT_MAX_EVENTS,
  CodexSubagentClient,
  isCodexSubagentDiscoveryUnsupported,
  supportsCodexSubagentDiscovery
} from '../codex-subagents.mjs';
import { ChildTranscriptConsumer } from '../child-transcript-broker.mjs';
import { claudeProjectsDirectory, readClaudeTranscriptTail, scanClaudeSessions } from './sessions.mjs';
import { readJournalTail } from '../store-maintenance.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_CHILD_STATUSES = new Set(['active', 'running', 'in_progress', 'started', 'pending', 'waiting', 'interacted', 'resumed']);
const DEFAULT_MAX_EVENTS = 5000;
// Activity hydration is deferred until after first paint. A moderately deep
// tail retains the start of long-running tool calls without ever scanning a
// full, output-heavy journal on the fleet path.
const ACTIVITY_TAIL_BYTES = 512 * 1024;
const ACTIVITY_TAIL_EVENTS = 5000;

function appendBoundedChildEvents(existing = [], incoming = []) {
  const events = [...existing, ...incoming].map((event) => ({ ...event, data: { ...(event.data || {}) } }));
  let chars = events.reduce((total, event) => total + JSON.stringify(event).length, 0);
  let truncated = false;
  while (events.length > CHILD_TRANSCRIPT_MAX_EVENTS || chars > CHILD_TRANSCRIPT_MAX_CHARS) {
    const removed = events.shift();
    chars -= JSON.stringify(removed).length;
    truncated = true;
  }
  return {
    events: events.map((event, index) => ({ ...event, seq: index + 1 })),
    truncated
  };
}

function hasIngestedClaudeJournal(job) {
  return job?.transport === 'claude-agent'
    && Number(job?.agentTranscriptIngestion?.journalEvents || 0) > 0;
}

export function readRecentJobEvents(id, options = {}) {
  const file = eventPath(id);
  const maxBytes = Math.max(1024, Number(options.maxBytes || ACTIVITY_TAIL_BYTES));
  const limit = Math.max(1, Number(options.limit || ACTIVITY_TAIL_EVENTS));
  try { return readJournalTail(file, maxBytes, limit); }
  catch { return []; }
}

export function aggregateJobGroups(jobs = []) {
  const groups = new Map();
  for (const job of jobs) {
    if (!job?.groupId) continue;
    if (!groups.has(job.groupId)) groups.set(job.groupId, {
      groupId: job.groupId, total: 0, running: 0, terminal: 0, stalled: 0,
      allTerminal: true, newestActivityAt: null, memberIds: []
    });
    const group = groups.get(job.groupId);
    const terminal = TERMINAL.has(job.status);
    group.total += 1;
    group.memberIds.push(job.id);
    if (terminal) group.terminal += 1;
    else if (job.stalled) group.stalled += 1;
    else group.running += 1;
    group.allTerminal &&= terminal;
    const activity = Number(job.lastActivityAt || (job.updatedAt || job.createdAt || 0) * 1000 || 0);
    group.newestActivityAt = Math.max(Number(group.newestActivityAt || 0), activity) || null;
  }
  return [...groups.values()].sort((left, right) => Number(right.newestActivityAt || 0) - Number(left.newestActivityAt || 0)
    || String(left.groupId).localeCompare(String(right.groupId)));
}

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

function providerSnapshots(usageState, visibility = null) {
  const configured = new Set(enabledProviders());
  return providerNames().map((name) => ({
    name,
    enabled: name === 'claude' || configured.has(name),
    allowance: effectiveUsage(usageState, name),
    warningPercent: warningPercentFor(name),
    avoidPercent: avoidPercentFor(name),
    lastVerified: usageState.lastVerified?.[name] || null,
    ...(name === 'codex' && visibility?.unattributed ? { unattributedBurn: visibility.unattributed } : {})
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

function fileSnapshot(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { exists: false, stamp: '-', mtimeMs: null, size: 0 };
  try {
    const stat = fs.statSync(file);
    return { exists: stat.isFile(), stamp: `${file}:${stat.size}:${stat.mtimeMs}`, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return { exists: false, stamp: `${file}:-`, mtimeMs: null, size: 0 }; }
}

function cloneState(state) {
  return {
    ...state,
    jobs: state.jobs.map((job) => ({ ...job })),
    eventsByJob: Object.fromEntries(Object.entries(state.eventsByJob).map(([id, events]) => [id, [...events]])),
    activityEventsByJob: Object.fromEntries(Object.entries(state.activityEventsByJob).map(([id, events]) => [id, [...events]])),
    diffsByJob: { ...state.diffsByJob },
    diffStatsByJob: Object.fromEntries(Object.entries(state.diffStatsByJob).map(([id, stat]) => [id, { ...stat, files: [...stat.files] }])),
    hydrationByJob: Object.fromEntries(Object.entries(state.hydrationByJob).map(([id, hydration]) => [id, { ...hydration }])),
    subagentsByJob: Object.fromEntries(Object.entries(state.subagentsByJob || {}).map(([id, value]) => [id, {
      ...value,
      threads: (value.threads || []).map((thread) => ({ ...thread })),
      ...(value.snapshot ? { snapshot: { ...value.snapshot, events: (value.snapshot.events || []).map((event) => ({ ...event, data: { ...(event.data || {}) } })) } } : {})
    }])),
    providers: state.providers.map((provider) => ({
      ...provider,
      allowance: { ...provider.allowance, windows: [...provider.allowance.windows] },
      ...(provider.unattributedBurn ? { unattributedBurn: { ...provider.unattributedBurn, byWindow: { ...provider.unattributedBurn.byWindow } } } : {})
    })),
    writerLocks: state.writerLocks.map((lock) => ({ ...lock })),
    sessions: state.sessions.map((session) => ({ ...session })),
    sessionScan: { ...state.sessionScan },
    externalScan: { ...state.externalScan },
    profiles: [...state.profiles],
    groups: state.groups.map((group) => ({ ...group, memberIds: [...group.memberIds] })),
    stats: { ...state.stats, groups: [...state.stats.groups] }
  };
}

export class DelegateDataSource extends EventEmitter {
  constructor(options = {}) {
    super();
    this.diagnostics = options.diagnostics || null;
    this.pollMs = Math.max(100, Number(options.pollMs || 2000));
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? 80));
    this.maxEvents = Math.max(100, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
    this.watchEnabled = options.watch !== false;
    this.sessionPollMs = Math.max(100, Number(options.sessionPollMs || 10000));
    this.sessionProjectsDir = path.resolve(String(options.projectsDir || claudeProjectsDirectory(options.env || process.env)));
    this.sessionScanOptions = {
      env: options.env || process.env,
      projectsDir: this.sessionProjectsDir,
      ...(options.activeSeconds == null ? {} : { activeSeconds: options.activeSeconds }),
      ...(options.maxSessions == null ? {} : { maxSessions: options.maxSessions }),
      ...(options.sessionTailBytes == null ? {} : { tailBytes: options.sessionTailBytes }),
      ...(options.sessionSnippetWidth == null ? {} : { snippetWidth: options.sessionSnippetWidth })
    };
    this.externalScanOptions = {
      env: options.env || process.env,
      ...(options.codexSessionsDir == null ? {} : { sessionsDir: options.codexSessionsDir }),
      ...(options.maxExternalThreads == null ? {} : { maxThreads: options.maxExternalThreads }),
      ...(options.externalTailBytes == null ? {} : { tailBytes: options.externalTailBytes }),
      ...(options.externalSnippetWidth == null ? {} : { snippetWidth: options.externalSnippetWidth })
    };
    this.agentTranscriptOptions = {
      projectsDir: this.sessionProjectsDir,
      ...(options.agentTranscriptMaxSessionDirs == null ? {} : { maxSessionDirs: options.agentTranscriptMaxSessionDirs }),
      ...(options.agentTranscriptMaxProjectEntries == null ? {} : { maxProjectEntries: options.agentTranscriptMaxProjectEntries }),
      ...(options.agentTranscriptMaxEntries == null ? {} : { maxEntries: options.agentTranscriptMaxEntries })
    };
    this.codexSubagentOptions = {
      ...(options.codexSubagentRpcFactory ? { rpcFactory: options.codexSubagentRpcFactory } : {}),
      ...(options.codexSubagentRequestTimeoutMs == null ? {} : { requestTimeoutMs: options.codexSubagentRequestTimeoutMs })
    };
    this.codexSubagentClientFactory = options.codexSubagentClientFactory
      || ((job) => new CodexSubagentClient(job, this.codexSubagentOptions));
    this.childTranscriptConsumerFactory = options.childTranscriptConsumerFactory
      || ((consumerOptions) => new ChildTranscriptConsumer(consumerOptions));
    this.submitTransientControl = options.submitTransientControl || submitTransientControl;
    this.cancelTransientControl = options.cancelTransientControl || cancelTransientControl;
    this.childTranscriptSubscribeTimeoutMs = Math.min(10000, Math.max(100, Number(options.childTranscriptSubscribeTimeoutMs) || 3000));
    this.externalJobs = new Map();
    this.externalSources = new Map();
    this.journalCursors = new Map();
    this.hydratedJobs = new Set();
    this.hydrations = new Map();
    this.journalStamps = new Map();
    this.events = new Map();
    this.activityEvents = new Map();
    this.activityTailStamps = new Map();
    this.readOnlyTranscriptStamps = new Map();
    this.subagentClients = new Map();
    this.followSubagentJobId = null;
    this.followSubagentThreadId = null;
    this.subagentEpoch = 0;
    this.subagentReadTask = null;
    this.liveSubagent = null;
    this.lastSubagentReadAt = 0;
    this.diffs = new Map();
    this.followJobId = null;
    this.watchers = [];
    this.pollTimer = null;
    this.sessionPollTimer = null;
    this.sessionWatcherInstalled = false;
    this.debounceTimer = null;
    this.pendingKinds = new Set();
    this.immediates = new Map();
    this.reconcileAttempts = new Map();
    this.reconciledByTui = new Map();
    this.reconcileTask = null;
    this.closed = false;
    this.recordsDigest = null;
    this.metadataStamp = null;
    this.metrics = { refreshes: 0, sessionScans: 0, activityTailReads: 0, readOnlyTranscriptReads: 0, subagentDiscoveries: 0, subagentSnapshotReads: 0, subagentDiskFallbackReads: 0, journalPages: 0, journalEvents: 0, reconciliations: 0, startupMs: null };
    this.state = {
      jobs: [], eventsByJob: {}, activityEventsByJob: {}, diffsByJob: {}, diffStatsByJob: {}, hydrationByJob: {}, subagentsByJob: {},
      usage: null, providers: [], writerLocks: [], profiles: [], groups: [], audit: [], metadataReady: false,
      sessions: [], sessionScan: { status: 'loading', available: null, projectsDir: this.sessionProjectsDir, scanned: 0, totalFiles: 0, capped: false, error: null },
      externalScan: { status: 'loading', available: null, scanned: 0, totalFiles: 0, capped: false, ownedExcluded: 0, personalExcluded: 0, duplicatesExcluded: 0, error: null },
      stats: { since: '7d', jobs: 0, groups: [] }, updatedAt: null, error: null
    };
  }

  trace(kind, details = {}) {
    this.diagnostics?.recordTimeline?.(`datasource.${kind}`, details);
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
    this.pollTimer = setInterval(() => this.scheduleRefresh('all', 'poll'), this.pollMs);
    this.pollTimer.unref?.();
    this.sessionPollTimer = setInterval(() => this.scheduleRefresh('sessions', 'poll'), this.sessionPollMs);
    this.sessionPollTimer.unref?.();
    void this.yieldTurn().then(() => {
      if (this.closed) return;
      this.hydrateMetadata({ force: true });
      this.refreshSessions({ force: true });
      this.refreshExternalThreads({ force: true });
      this.refreshActivityTails({ force: true });
    });
    return this;
  }

  installWatchers() {
    const add = (target, kind, accept = null, watchOptions = {}) => {
      try {
        const watcher = fs.watch(target, { persistent: false, ...watchOptions }, (_event, filename) => {
          if (accept && !accept(String(filename || ''))) return;
          this.trace('watch', { kind });
          this.scheduleRefresh(kind, 'watch');
        });
        watcher.on('error', () => this.scheduleRefresh(kind, 'watch-error'));
        this.watchers.push(watcher);
        return true;
      } catch { return false; }
    };
    const jobChange = (name) => !name || name.endsWith('.json') || name.endsWith('.events.jsonl')
      || name.endsWith('.events.jsonl.gz') || name.endsWith('.finished');
    if (!add(jobsDir(), 'jobs', jobChange)) add(dataDir(), 'jobs', (name) => !name || name === 'jobs');
    add(statePath(), 'metadata');
    add(auditLogPath(), 'metadata');
    this.installSessionWatcher(add);
  }

  installSessionWatcher(addWatcher = null) {
    if (!this.watchEnabled || this.sessionWatcherInstalled || this.closed) return false;
    const add = addWatcher || ((target, kind, accept = null, watchOptions = {}) => {
      try {
        const watcher = fs.watch(target, { persistent: false, ...watchOptions }, (_event, filename) => {
          if (accept && !accept(String(filename || ''))) return;
          this.trace('watch', { kind });
          this.scheduleRefresh(kind, 'watch');
        });
        watcher.on('error', () => this.scheduleRefresh(kind, 'watch-error'));
        this.watchers.push(watcher);
        return true;
      } catch { return false; }
    });
    this.sessionWatcherInstalled = add(this.sessionProjectsDir, 'sessions', null, { recursive: true })
      || add(this.sessionProjectsDir, 'sessions');
    return this.sessionWatcherInstalled;
  }

  scheduleRefresh(kind = 'all', trigger = 'internal') {
    if (this.closed) return;
    this.trace('schedule', { kind, trigger, coalesced: Boolean(this.debounceTimer) });
    this.pendingKinds.add(kind);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const kinds = new Set(this.pendingKinds);
      this.pendingKinds.clear();
      if (kinds.has('all') || kinds.has('jobs')) {
        this.refreshRecords();
        this.refreshActivityTails();
      }
      if (kinds.has('all') || kinds.has('metadata')) this.hydrateMetadata();
      if (kinds.has('sessions')) {
        this.refreshSessions();
        this.refreshExternalThreads();
      }
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  activityFields(job, cached = null) {
    if (job.transport === 'claude-agent') {
      const activity = agentStubActivity({
        ...job,
        transcriptMtimeMs: cached?.transcriptMtimeMs || job.transcriptMtimeMs
      });
      const lastActivityAt = Number(activity?.lastGrowthAt || job.spawnReturnedAtMs || job.createdAtMs || job.createdAt * 1000 || 0) || null;
      return { lastActivityAt, stalled: false, agentActivityState: activity?.state || 'unknown',
        activitySource: job.hostAgent?.observedAt > Date.now() - 90_000 ? 'claude-host' : 'transcript-observation' };
    }
    const recordActivityAt = job.updatedAt || job.createdAt ? (job.updatedAt || job.createdAt) * 1000 : null;
    const lastActivityAt = cached?.lastActivityAt == null
      ? recordActivityAt
      : recordActivityAt == null ? cached.lastActivityAt : Math.max(cached.lastActivityAt, recordActivityAt);
    const configured = Number(process.env.DELEGATE_STALL_SECONDS ?? 300);
    const stallSeconds = Number.isFinite(configured) && configured >= 0 ? configured : 300;
    return {
      lastActivityAt,
      outputQuiet: outputQuiet(job, lastActivityAt, Date.now(), stallSeconds),
      stalled: job.status === 'running' && !job.pendingInput && !['paused', 'user-input-required'].includes(job.phase)
        && job.transportHealth?.state === 'stalled'
    };
  }

  refreshRecords(options = {}) {
    if (this.closed) return this.getState();
    const started = performance.now();
    this.metrics.refreshes += 1;
    let changed = false;
    try {
      const rawJobs = listJobs().map((job) => {
        if (job.managedBy !== 'delegate-agent-hook' || TERMINAL.has(job.status) || !jobNeedsReconciliation(job)) return job;
        try { return reconcileJob(job.id) || job; } catch { return job; }
      });
      const allRecords = [...rawJobs, ...this.externalJobs.values()];
      const ids = new Set(allRecords.map((job) => job.id));
      const jobsById = new Map(allRecords.map((job) => [job.id, job]));
      const cachedById = new Map(this.state.jobs.map((job) => [job.id, job]));
      const jobs = allRecords.map((job) => {
        const cached = cachedById.get(job.id);
        return {
          ...job,
          ...(cached?.transcriptMtimeMs == null ? {} : { transcriptMtimeMs: cached.transcriptMtimeMs }),
          ...(cached?.transcriptSize == null ? {} : { transcriptSize: cached.transcriptSize }),
          ...(cached?.transcriptAvailable == null ? {} : { transcriptAvailable: cached.transcriptAvailable }),
          ...this.activityFields(job, cached),
          workerAlive: job.external || job.transport === 'claude-agent' || TERMINAL.has(job.status) ? undefined : isProcessAlive(job.workerPid || job.pid),
          tuiReconciledFrom: this.reconciledByTui.get(job.id) || null,
          rootJobId: rootJobId(job, jobsById)
        };
      });
      for (const id of [...this.journalCursors.keys()]) {
        if (ids.has(id)) continue;
        this.journalCursors.delete(id);
        this.hydratedJobs.delete(id);
        this.journalStamps.delete(id);
        this.events.delete(id);
        this.activityEvents.delete(id);
        this.activityTailStamps.delete(id);
        this.readOnlyTranscriptStamps.delete(id);
        this.diffs.delete(id);
        this.reconcileAttempts.delete(id);
        this.reconciledByTui.delete(id);
      }
      const subagentsByJob = Object.fromEntries(Object.entries(this.state.subagentsByJob || {}).filter(([id]) => ids.has(id)));
      for (const [id, client] of this.subagentClients) {
        if (ids.has(id)) continue;
        this.subagentClients.delete(id);
        void client.close();
      }
      const digest = JSON.stringify(jobs.map((job) => [
        job.id, job.revision, job.status, job.phase, job.updatedAt, job.lastActivityAt, job.stalled, job.workerAlive,
        job.groupId || null, Array.isArray(job.scopeViolations) ? job.scopeViolations.length : Number(job.scopeViolations || 0),
        job.errorCode || null, job.stoppedReason || null,
        job.external === true, job.approximateSize || null, job.activityLabel || null,
        job.agentId || null, job.transcriptAgentId || null, job.agentLifecycle || null,
        job.coordinatorSidecarDir || null, job.transcriptPath || null,
        job.transcriptMtimeMs || null, job.transcriptSize || null,
        Number(job.agentTranscriptIngestion?.journalEvents || 0)
      ]));
      changed = options.force || digest !== this.recordsDigest;
      this.recordsDigest = digest;
      this.state = {
        ...this.state,
        jobs,
        subagentsByJob,
        groups: aggregateJobGroups(jobs),
        writerLocks: activeWriterLocks(rawJobs),
        updatedAt: Date.now(),
        error: null
      };
      if (changed) this.emit('change', this.getState());
      const followed = this.followJobId ? jobsById.get(this.followJobId) : null;
      const liveParent = this.liveSubagent ? jobsById.get(this.liveSubagent.jobId) : null;
      if (this.liveSubagent && (!liveParent || TERMINAL.has(liveParent.status))) {
        void this.stopLiveSubagent('parent-terminal');
      }
      if (followed?.external) {
        void this.hydrateReadOnlyTranscript(this.followJobId, 'external');
      } else if (followed?.transport === 'claude-agent') {
        if (hasIngestedClaudeJournal(followed)) void this.hydrateJob(this.followJobId);
        else void this.hydrateReadOnlyTranscript(this.followJobId, 'claude-agent');
      } else if (followed && this.journalStamps.get(this.followJobId) !== fileStamp(eventPath(this.followJobId))) {
        void this.hydrateJob(this.followJobId);
      }
      void this.refreshSelectedSubagentSnapshot();
    } catch (error) {
      this.state = { ...this.state, error: error.message, updatedAt: Date.now() };
      this.emit('warning', error);
      if (options.force) this.emit('change', this.getState());
    }
    this.trace('refresh-records', {
      durationMs: performance.now() - started,
      changed,
      force: options.force === true,
      jobs: this.state.jobs.length
    });
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
      const external = externalThreadStats({ threads: [...this.externalJobs.values()] });
      const visibility = aggregateVisibilityStats(audit, {
        since: '7d',
        jobs: listJobs(),
        external,
        history: usage.history || []
      });
      this.metadataStamp = stamp;
      this.state = {
        ...this.state,
        usage,
        providers: providerSnapshots(usage, visibility),
        profiles: profileNames(),
        audit,
        stats: visibility,
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

  refreshActivityTails(options = {}) {
    if (this.closed) return this.getState();
    let changed = false;
    const active = new Set();
    for (const job of this.state.jobs) {
      if (job.external || TERMINAL.has(job.status)) continue;
      active.add(job.id);
      const stamp = fileStamp(eventPath(job.id));
      if (!options.force && this.activityTailStamps.get(job.id) === stamp) continue;
      this.activityTailStamps.set(job.id, stamp);
      this.activityEvents.set(job.id, readRecentJobEvents(job.id));
      this.metrics.activityTailReads += 1;
      changed = true;
    }
    for (const id of [...this.activityEvents.keys()]) {
      if (active.has(id)) continue;
      this.activityEvents.delete(id);
      this.activityTailStamps.delete(id);
      changed = true;
    }
    if (changed) {
      this.state = { ...this.state, activityEventsByJob: Object.fromEntries(this.activityEvents), updatedAt: Date.now() };
      this.emit('change', this.getState());
    }
    return this.getState();
  }

  refreshSessions(options = {}) {
    if (this.closed) return this.getState();
    this.metrics.sessionScans += 1;
    const scan = scanClaudeSessions(this.sessionScanOptions);
    const { sessions, ...summary } = scan;
    const sessionScan = { status: scan.available ? 'ready' : 'unavailable', ...summary };
    const previous = this.state.sessionScan;
    const changed = options.force || JSON.stringify([
      sessionScan.status, sessionScan.available, sessionScan.scanned, sessionScan.totalFiles, sessionScan.capped, sessionScan.error,
      ...sessions.map((session) => [session.id, session.cwd, session.mtimeMs, session.size, session.lastActivity, session.active])
    ]) !== JSON.stringify([
      previous.status, previous.available, previous.scanned, previous.totalFiles, previous.capped, previous.error,
      ...this.state.sessions.map((session) => [session.id, session.cwd, session.mtimeMs, session.size, session.lastActivity, session.active])
    ]);
    this.state = { ...this.state, sessions, sessionScan, updatedAt: Date.now() };
    if (scan.available) this.installSessionWatcher();
    if (changed) this.emit('change', this.getState());
    return this.getState();
  }

  refreshExternalThreads(options = {}) {
    if (this.closed) return this.getState();
    // This runs on a refresh timer: an uncaught throw here kills the whole TUI
    // (field crash: an in-flight ~/.codex rollout with an unwritten meta line).
    let scan;
    try {
      const managed = listJobs();
      scan = scanExternalCodexThreads({
        ...this.externalScanOptions,
        jobs: managed,
        ownedIds: brokerOwnedCodexThreadIds(managed)
      });
    } catch (error) {
      scan = {
        available: false, threads: [], sources: new Map(), scanned: 0, totalFiles: 0,
        capped: false, ownedExcluded: 0, personalExcluded: 0, duplicatesExcluded: 0,
        unreadableExcluded: 0, error: String(error?.message || error).slice(0, 1024)
      };
    }
    const { threads, sources, ...summary } = scan;
    const externalScan = { status: scan.available ? 'ready' : 'unavailable', ...summary };
    const previous = this.state.externalScan;
    const changed = options.force || JSON.stringify([
      externalScan.status, externalScan.available, externalScan.scanned, externalScan.totalFiles,
      externalScan.capped, externalScan.ownedExcluded, externalScan.personalExcluded, externalScan.duplicatesExcluded, externalScan.error,
      ...threads.map((thread) => [thread.id, thread.updatedAt, thread.approximateSize, thread.activityLabel])
    ]) !== JSON.stringify([
      previous.status, previous.available, previous.scanned, previous.totalFiles,
      previous.capped, previous.ownedExcluded, previous.personalExcluded, previous.duplicatesExcluded, previous.error,
      ...this.externalJobs.values().map((thread) => [thread.id, thread.updatedAt, thread.approximateSize, thread.activityLabel])
    ]);
    this.externalJobs = new Map(threads.map((thread) => [thread.id, thread]));
    this.externalSources = sources;
    this.state = { ...this.state, externalScan, updatedAt: Date.now() };
    if (changed) {
      this.refreshRecords({ force: true });
      this.hydrateMetadata({ force: true });
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

  publishSubagents(id, value) {
    if (this.closed || !id) return this.getState();
    this.state = {
      ...this.state,
      subagentsByJob: { ...this.state.subagentsByJob, [id]: value },
      updatedAt: Date.now()
    };
    this.emit('change', this.getState());
    return this.getState();
  }

  subagentClient(job) {
    let client = this.subagentClients.get(job.id);
    if (!client) {
      client = this.codexSubagentClientFactory(job);
      this.subagentClients.set(job.id, client);
    }
    return client;
  }

  selectedChildIsRunning(job, threadId, state = {}) {
    const lifecycle = Object.values(job?.subagentLifecycle || {}).find((entry) => String(entry?.id || '') === String(threadId));
    if (lifecycle?.status) return ACTIVE_CHILD_STATUSES.has(String(lifecycle.status).replace(/[-\s]+/g, '_').toLowerCase());
    const thread = (state.threads || []).find((entry) => entry.id === threadId);
    return ACTIVE_CHILD_STATUSES.has(String(thread?.status || '').replace(/[-\s]+/g, '_').toLowerCase());
  }

  async closeSubagentClients(exceptId = null) {
    const closing = [];
    for (const [id, client] of this.subagentClients) {
      if (id === exceptId) continue;
      this.subagentClients.delete(id);
      closing.push(client.close());
    }
    await Promise.allSettled(closing);
  }

  publishLiveSubagent(live, patch = {}) {
    if (!live || this.liveSubagent !== live) return this.getState();
    const current = this.state.subagentsByJob[live.jobId] || { status: 'ready', provider: 'codex', threads: [] };
    const snapshot = current.snapshot?.threadId === live.threadId
      ? current.snapshot
      : { threadId: live.threadId, mode: 'stored', status: 'loading', events: [], capturedAtMs: null };
    return this.publishSubagents(live.jobId, {
      ...current,
      snapshot: { ...snapshot, ...patch, threadId: live.threadId }
    });
  }

  handleLiveSubagentMessage(live, message) {
    if (!live || this.liveSubagent !== live || message?.subscriptionId !== live.subscriptionId) return;
    if (message.type === 'established') {
      live.established = true;
      live.resolve?.('established');
      this.publishLiveSubagent(live, {
        mode: 'live', status: 'ready', subscriptionState: 'established', pointInTime: true,
        capturedAtMs: Date.now()
      });
      return;
    }
    if (message.type === 'rejected') {
      live.rejection = String(message.error || 'subscription rejected').slice(0, 1024);
      live.resolve?.('rejected');
      return;
    }
    if (message.type === 'snapshot') {
      live.snapshotReceived = true;
      const projected = message.snapshot || {};
      const bounded = appendBoundedChildEvents(projected.events || [], live.pendingEvents);
      live.pendingEvents = [];
      this.publishLiveSubagent(live, {
        ...projected,
        events: bounded.events,
        truncated: projected.truncated === true || bounded.truncated,
        mode: live.established ? 'live' : 'stored',
        status: 'ready',
        subscriptionState: live.established ? 'established' : 'pending',
        pointInTime: true,
        capturedAtMs: projected.capturedAtMs || Date.now()
      });
      return;
    }
    if (message.type === 'events') {
      if (!live.snapshotReceived) {
        live.pendingEvents.push(...(message.events || []));
        return;
      }
      const current = this.state.subagentsByJob[live.jobId]?.snapshot || {};
      const bounded = appendBoundedChildEvents(current.events || [], message.events || []);
      this.publishLiveSubagent(live, {
        events: bounded.events,
        truncated: current.truncated === true || bounded.truncated,
        droppedReasoningCount: Number(current.droppedReasoningCount || 0) + Number(message.droppedReasoningCount || 0),
        capturedAtMs: message.capturedAtMs || Date.now()
      });
      return;
    }
    if (message.type === 'status' && message.pointInTime === false) {
      this.publishLiveSubagent(live, {
        mode: 'stored', subscriptionState: 'closed', pointInTime: false,
        status: 'ready', capturedAtMs: Date.now()
      });
      return;
    }
    if (message.type === 'closed') {
      live.closedResolve?.(message.reason || 'closed');
      if (live.established) {
        live.established = false;
        this.publishLiveSubagent(live, {
          mode: 'stored', subscriptionState: 'closed', status: 'ready', capturedAtMs: Date.now()
        });
      }
    }
  }

  async startLiveSubagent(job, threadId, epoch) {
    const live = {
      jobId: job.id,
      threadId,
      subscriptionId: crypto.randomUUID(),
      consumer: null,
      intake: null,
      established: false,
      snapshotReceived: false,
      pendingEvents: [],
      resolve: null,
      closedResolve: null
    };
    const outcome = new Promise((resolve) => { live.resolve = resolve; });
    live.closed = new Promise((resolve) => { live.closedResolve = resolve; });
    this.liveSubagent = live;
    let subscribeTimer;
    try {
      const consumer = this.childTranscriptConsumerFactory({ subscriptionId: live.subscriptionId });
      live.consumer = consumer;
      consumer.on('message', (message) => this.handleLiveSubagentMessage(live, message));
      consumer.on('disconnect', () => {
        live.closedResolve?.('disconnect');
        if (live.established && this.liveSubagent === live) {
          live.established = false;
          this.publishLiveSubagent(live, {
            mode: 'stored', subscriptionState: 'disconnected', status: 'ready', capturedAtMs: Date.now()
          });
        } else live.resolve?.('disconnected');
        if (this.liveSubagent === live) this.liveSubagent = null;
      });
      consumer.on('rejected', () => live.resolve?.('rejected'));
      consumer.on('warning', () => {});
      const descriptor = await consumer.start();
      if (this.closed || epoch !== this.subagentEpoch || this.liveSubagent !== live) throw new Error('selection changed before child subscription request');
      live.intake = this.submitTransientControl(job.id, {
        type: 'child-transcript.subscribe', commandId: crypto.randomUUID(), threadId,
        subscriptionId: live.subscriptionId, endpoint: descriptor.endpoint, token: descriptor.token
      });
      const result = await Promise.race([
        outcome,
        new Promise((resolve) => {
          subscribeTimer = setTimeout(() => resolve('timeout'), this.childTranscriptSubscribeTimeoutMs);
        })
      ]);
      if (result === 'established' && !this.closed && epoch === this.subagentEpoch && this.liveSubagent === live) return true;
    } catch (error) {
      live.rejection = String(error?.message || error).slice(0, 1024);
    } finally {
      clearTimeout(subscribeTimer);
    }
    if (live.intake) this.cancelTransientControl(job.id, live.intake.commandId);
    live.consumer?.close();
    if (this.liveSubagent === live) this.liveSubagent = null;
    return false;
  }

  async stopLiveSubagent(reason = 'unsubscribe', options = {}) {
    const live = this.liveSubagent;
    if (!live) return false;
    this.liveSubagent = null;
    let intake = null;
    if (live.established) {
      try {
        intake = this.submitTransientControl(live.jobId, {
          type: 'child-transcript.unsubscribe', commandId: crypto.randomUUID(), threadId: live.threadId,
          subscriptionId: live.subscriptionId
        });
      } catch {}
      let unsubscribeTimer;
      try {
        await Promise.race([
          live.closed,
          new Promise((resolve) => { unsubscribeTimer = setTimeout(resolve, 500); })
        ]);
      } finally { clearTimeout(unsubscribeTimer); }
    }
    if (intake) this.cancelTransientControl(live.jobId, intake.commandId);
    if (live.intake) this.cancelTransientControl(live.jobId, live.intake.commandId);
    live.consumer?.close();
    if (options.publish !== false) {
      const current = this.state.subagentsByJob[live.jobId];
      if (current?.snapshot?.threadId === live.threadId && current.snapshot.mode === 'live') {
        this.publishSubagents(live.jobId, {
          ...current,
          snapshot: {
            ...current.snapshot, mode: 'stored', subscriptionState: 'closed', status: 'ready', capturedAtMs: Date.now()
          }
        });
      }
    }
    return true;
  }

  async selectSubagent(jobId, threadId = null, options = {}) {
    const selectedJobId = jobId || null;
    const selectedThreadId = threadId || null;
    if (this.liveSubagent && (this.liveSubagent.jobId !== selectedJobId || this.liveSubagent.threadId !== selectedThreadId || !selectedThreadId)) {
      await this.stopLiveSubagent(selectedThreadId ? 'selection-change' : 'transcript-close');
    }
    const epoch = ++this.subagentEpoch;
    this.followSubagentJobId = selectedJobId;
    this.followSubagentThreadId = selectedThreadId;
    if (!selectedJobId) {
      await this.closeSubagentClients();
      if (!this.closed && epoch === this.subagentEpoch) {
        this.state = { ...this.state, subagentsByJob: {}, updatedAt: Date.now() };
        this.emit('change', this.getState());
      }
      return this.getState();
    }
    await this.closeSubagentClients(selectedJobId);
    const job = this.state.jobs.find((entry) => entry.id === selectedJobId);
    if (!job) return this.getState();
    const previous = this.state.subagentsByJob[selectedJobId] || { status: 'idle', threads: [], error: null };
    if (job.provider === 'cursor') {
      return this.publishSubagents(selectedJobId, {
        ...previous,
        status: 'ready',
        provider: 'cursor',
        threads: [],
        error: null,
        snapshot: selectedThreadId ? {
          threadId: selectedThreadId,
          mode: 'unavailable',
          status: 'unavailable',
          events: [],
          message: 'Cursor does not expose child transcript identifiers or transcript retrieval on this transport.'
        } : previous.snapshot || null
      });
    }
    if (job.provider !== 'codex' || job.external || job.remote) {
      return this.publishSubagents(selectedJobId, {
        ...previous,
        status: 'remote-unavailable',
        provider: job.provider,
        threads: [],
        error: 'provider RPC discovery is unreachable from this detail source',
        snapshot: selectedThreadId ? { threadId: selectedThreadId, mode: 'unavailable', status: 'unavailable', events: [] } : null
      });
    }
    const client = this.subagentClient(job);
    if (!selectedThreadId) {
      if (['ready', 'unavailable'].includes(previous.status) && options.force !== true) {
        return this.publishSubagents(selectedJobId, { ...previous, snapshot: previous.snapshot || null });
      }
      if (!job.providerSessionId) {
        return this.publishSubagents(selectedJobId, {
          ...previous,
          status: 'unavailable',
          provider: 'codex',
          version: client.version,
          error: 'parent provider thread id was not recorded',
          unsupported: true
        });
      }
      this.publishSubagents(selectedJobId, { ...previous, status: 'loading', provider: 'codex', error: null });
      try {
        const discovery = await client.discover(job.providerSessionId);
        if (this.closed || epoch !== this.subagentEpoch || this.followSubagentJobId !== selectedJobId) return this.getState();
        this.metrics.subagentDiscoveries += 1;
        return this.publishSubagents(selectedJobId, {
          status: 'ready', provider: 'codex', threads: discovery.threads, capped: discovery.capped,
          version: discovery.version, error: null, snapshot: previous.snapshot || null
        });
      } catch (error) {
        if (this.closed || epoch !== this.subagentEpoch || this.followSubagentJobId !== selectedJobId) return this.getState();
        return this.publishSubagents(selectedJobId, {
          ...previous,
          status: 'unavailable',
          provider: 'codex',
          version: client.version,
          error: String(error?.message || error).slice(0, 1024),
          unsupported: isCodexSubagentDiscoveryUnsupported(error),
          snapshot: previous.snapshot || null
        });
      }
    }
    if (!options.refresh) {
      this.publishSubagents(selectedJobId, {
        ...previous,
        snapshot: { threadId: selectedThreadId, mode: 'stored', status: 'loading', events: [], capturedAtMs: null }
      });
    }
    const runningChild = !TERMINAL.has(job.status)
      && this.selectedChildIsRunning(job, selectedThreadId, previous)
      && job.workerAlive !== false;
    if (runningChild && await this.startLiveSubagent(job, selectedThreadId, epoch)) return this.getState();
    try {
      const snapshot = await client.read(selectedThreadId, { now: Date.now() });
      if (this.closed || epoch !== this.subagentEpoch || this.followSubagentThreadId !== selectedThreadId) return this.getState();
      this.metrics.subagentSnapshotReads += 1;
      this.lastSubagentReadAt = Date.now();
      const current = this.state.subagentsByJob[selectedJobId] || previous;
      return this.publishSubagents(selectedJobId, {
        ...current,
        snapshot: {
          ...snapshot,
          threadId: selectedThreadId,
          mode: 'stored',
          status: 'ready',
          pointInTime: snapshot.pointInTime === true || this.selectedChildIsRunning(job, selectedThreadId, current)
        }
      });
    } catch (error) {
      if (this.closed || epoch !== this.subagentEpoch || this.followSubagentThreadId !== selectedThreadId) return this.getState();
      let fallback = null;
      if (supportsCodexSubagentDiscovery(client.version)) {
        const file = findCodexThreadRollout(selectedThreadId, this.externalScanOptions);
        if (file) fallback = readCodexThreadTail(file, { limit: 500 });
      }
      if (fallback) {
        this.metrics.subagentDiskFallbackReads += 1;
        this.lastSubagentReadAt = Date.now();
        const row = (this.state.subagentsByJob[selectedJobId]?.threads || []).find((entry) => entry.id === selectedThreadId);
        return this.publishSubagents(selectedJobId, {
          ...this.state.subagentsByJob[selectedJobId],
          snapshot: {
            threadId: selectedThreadId, mode: 'disk', status: 'ready', events: fallback.events || [],
            pointInTime: this.selectedChildIsRunning(job, selectedThreadId, this.state.subagentsByJob[selectedJobId]) || row?.status === 'active', truncated: fallback.truncated === true,
            capturedAtMs: Date.now(), error: String(error?.message || error).slice(0, 1024)
          }
        });
      }
      return this.publishSubagents(selectedJobId, {
        ...this.state.subagentsByJob[selectedJobId],
        snapshot: {
          threadId: selectedThreadId, mode: 'unavailable', status: 'unavailable', events: [],
          message: 'The stored child transcript could not be read from this thread store.',
          error: String(error?.message || error).slice(0, 1024)
        }
      });
    }
  }

  refreshSelectedSubagentSnapshot() {
    if (this.closed || !this.followSubagentJobId || !this.followSubagentThreadId || this.subagentReadTask) return Promise.resolve(this.getState());
    const state = this.state.subagentsByJob[this.followSubagentJobId];
    if (state?.snapshot?.mode === 'live' && state.snapshot.subscriptionState === 'established') return Promise.resolve(this.getState());
    if (state?.snapshot?.status !== 'ready' || state.snapshot.pointInTime !== true) return Promise.resolve(this.getState());
    if (Date.now() - this.lastSubagentReadAt < this.pollMs) return Promise.resolve(this.getState());
    const task = this.selectSubagent(this.followSubagentJobId, this.followSubagentThreadId, { refresh: true })
      .finally(() => { if (this.subagentReadTask === task) this.subagentReadTask = null; });
    this.subagentReadTask = task;
    return task;
  }

  selectJob(id) {
    if (this.followJobId && this.followJobId !== id) void this.selectSubagent(null);
    this.followJobId = id || null;
    if (!id) return Promise.resolve(this.getState());
    const selected = this.state.jobs.find((job) => job.id === id);
    if (selected?.external) return this.hydrateReadOnlyTranscript(id, 'external');
    if (selected?.transport === 'claude-agent') {
      return hasIngestedClaudeJournal(selected)
        ? this.hydrateJob(id)
        : this.hydrateReadOnlyTranscript(id, 'claude-agent');
    }
    const loaded = this.state.hydrationByJob[id]?.loaded === true;
    if (loaded && this.journalStamps.get(id) === fileStamp(eventPath(id))) return Promise.resolve(this.getState());
    return this.hydrateJob(id);
  }

  resolveClaudeAgentTranscript(job) {
    if (!job || job.transport !== 'claude-agent') return null;
    const transcriptAgentId = transcriptAgentIdForJob(job);
    if (!transcriptAgentId) return null;
    const direct = transcriptPathMatchesAgentId(job.transcriptPath, transcriptAgentId)
      ? path.normalize(job.transcriptPath) : null;
    try { if (direct && fs.statSync(direct).isFile()) return direct; } catch {}
    const resolved = resolveStoredAgentTranscriptPath({
      transcriptAgentId,
      coordinatorSidecarDir: job.coordinatorSidecarDir,
      cwd: job.cwd,
      ...this.agentTranscriptOptions
    });
    if (!resolved && !direct) return null;
    const selected = resolved || direct;
    let persisted = null;
    try {
      persisted = updateManagedJob(job.id, (record) => {
        if (!transcriptPathMatchesAgentId(record.transcriptPath, transcriptAgentId)) record.transcriptPath = selected;
      }, { incrementRevision: false });
    } catch {}
    const transcriptPath = persisted?.transcriptPath || selected;
    this.state = {
      ...this.state,
      jobs: this.state.jobs.map((entry) => entry.id === job.id ? { ...entry, transcriptPath } : entry)
    };
    return transcriptPath;
  }

  hydrateReadOnlyTranscript(id, kind) {
    if (this.closed || this.followJobId !== id) return Promise.resolve(this.getState());
    let job = this.state.jobs.find((entry) => entry.id === id);
    if (kind === 'claude-agent' && hasIngestedClaudeJournal(job)) return this.hydrateJob(id);
    const file = kind === 'external' ? this.externalSources.get(id) : this.resolveClaudeAgentTranscript(job);
    job = this.state.jobs.find((entry) => entry.id === id) || job;
    const snapshot = fileSnapshot(file);
    const previousStamp = this.readOnlyTranscriptStamps.get(id);
    const hydration = this.state.hydrationByJob[id];
    if (hydration?.loaded === true && previousStamp === snapshot.stamp) return Promise.resolve(this.getState());
    this.readOnlyTranscriptStamps.set(id, snapshot.stamp);
    const result = snapshot.exists
      ? kind === 'external' ? readCodexThreadTail(file) : readClaudeTranscriptTail(file)
      : { events: [] };
    if (snapshot.exists) this.metrics.readOnlyTranscriptReads += 1;
    this.events.set(id, result.events || []);
    this.diffs.set(id, '');
    const jobs = this.state.jobs.map((entry) => entry.id === id ? {
      ...entry,
      ...(kind === 'claude-agent' && file ? { transcriptPath: file } : {}),
      transcriptMtimeMs: snapshot.mtimeMs,
      transcriptSize: snapshot.size,
      transcriptAvailable: snapshot.exists,
      ...this.activityFields(entry, { ...entry, transcriptMtimeMs: snapshot.mtimeMs })
    } : entry);
    this.state = {
      ...this.state,
      jobs,
      eventsByJob: { ...this.state.eventsByJob, [id]: result.events || [] },
      diffsByJob: { ...this.state.diffsByJob, [id]: '' },
      diffStatsByJob: { ...this.state.diffStatsByJob, [id]: { files: [], totalAdditions: 0, totalDeletions: 0 } },
      hydrationByJob: {
        ...this.state.hydrationByJob,
        [id]: { loading: false, loaded: true, error: null, bounded: true, transcriptMissing: !snapshot.exists, sourceStamp: snapshot.stamp }
      },
      updatedAt: Date.now()
    };
    this.emit('change', this.getState());
    return Promise.resolve(this.getState());
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
    const initialHistoryLoad = !wasLoaded;
    if (initialHistoryLoad) this.publishJournal(id, { loading: true, loaded: false, error: null });
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
          this.publishJournal(id, { loading: initialHistoryLoad && !complete, loaded: complete || wasLoaded, error: null });
          if (complete) break;
          cursor = next;
          await this.yieldTurn();
        }
        if (!this.closed) {
          this.journalStamps.set(id, fileStamp(eventPath(id)));
          this.publishJournal(id, { loading: false, loaded: complete || wasLoaded, error: null });
        }
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
    this.refreshRecords(options);
    this.refreshActivityTails(options);
    if (options.metadata === true) this.hydrateMetadata({ force: options.force });
    return this.getState();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const liveStop = this.stopLiveSubagent('datasource-close', { publish: false });
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch {}
    }
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sessionPollTimer) clearInterval(this.sessionPollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.sessionPollTimer = null;
    this.sessionWatcherInstalled = false;
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
    this.subagentReadTask = null;
    this.followSubagentJobId = null;
    this.followSubagentThreadId = null;
    this.subagentEpoch += 1;
    for (const client of this.subagentClients.values()) void client.close();
    this.subagentClients.clear();
    this.hydrations.clear();
    this.journalStamps.clear();
    await liveStop;
  }
}

export function tailAllJobs(options = {}) {
  return new DelegateDataSource(options).start();
}

export function isActiveJob(job) {
  return Boolean(job && !TERMINAL.has(job.status));
}
