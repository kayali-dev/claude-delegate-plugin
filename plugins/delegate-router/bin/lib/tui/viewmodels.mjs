import { jobNeedsReconciliation } from '../control.mjs';
import { uiPalette as palette } from './palette.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const READ_MODES = new Set(['consult', 'plan', 'review']);

export const DETAIL_TABS = Object.freeze(['Transcript', 'Diff', 'Record', 'Usage', 'Events', 'Chain']);

export const HELP_ITEMS = Object.freeze([
  { key: '↑/↓, j/k, wheel', description: 'Move one line; mouse wheel moves three lines' },
  { key: 'PgUp/PgDn', description: 'Move the focused pane by one viewport' },
  { key: 'Home/End, g', description: 'Jump to the start or end of the focused pane' },
  { key: 'Enter / Esc', description: 'Open or edit / go back or close an overlay' },
  { key: 'a / /', description: 'Toggle active jobs / filter or search the focused pane' },
  { key: 'G / p / t / N', description: 'Groups / providers / seven-day stats / launcher' },
  { key: '[/], 1…6', description: 'Cycle detail tabs / open a specific tab' },
  { key: 'f', description: 'Toggle follow mode in Transcript or Events' },
  { key: 's / r / R', description: 'Steer / resume / release a paused start' },
  { key: 'n/N / c / v / w', description: 'Search next/previous, nudge / cancel / revert / review round' },
  { key: '←/→', description: 'Cycle launcher choices or page a file diff' },
  { key: 'd / y', description: 'Build dry-run preview / launch that exact packet' },
  { key: '? / q / Ctrl-C', description: 'Toggle help / quit immediately' }
]);

function viewportOf(viewport = {}) {
  return { width: Math.max(20, Number(viewport.width || 80)), height: Math.max(8, Number(viewport.height || 24)) };
}

function nowOf(ui) {
  return Number(ui.now || Date.now());
}

function active(job) {
  return !TERMINAL.has(job.status);
}

export function effectiveJobRecord(job, nowMs = Date.now()) {
  if (!job) return job;
  if (job.tuiReconciledFrom) {
    return { ...job, displayReconciled: true, reconciliationPending: false, reconciledFrom: job.tuiReconciledFrom };
  }
  const pid = job.workerPid || job.pid;
  const workerAlive = typeof job.workerAlive === 'boolean' ? job.workerAlive : Boolean(pid);
  if (!jobNeedsReconciliation(job, { nowSeconds: Number(nowMs) / 1000, workerAlive })) return job;
  return {
    ...job,
    status: 'failed',
    phase: 'failed',
    stalled: false,
    displayReconciled: true,
    reconciliationPending: true,
    reconciledFrom: job.status,
    error: job.error || 'ORPHANED: worker exited without recording a terminal result',
    errorCode: job.errorCode || 'ORPHANED',
    errorRetryable: job.errorRetryable ?? true
  };
}

function shortId(job) {
  const prefix = job.provider ? job.provider[0].toUpperCase() : 'J';
  return `${prefix}:${String(job.id || '').slice(-7)}`;
}

function duration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  let seconds = Math.max(0, Math.floor(Number(value) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function number(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}m`;
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(amount));
}

function usageSource(value) {
  return value?.total && typeof value.total === 'object' ? value.total : value;
}

function tokenValue(usage, names) {
  const source = usageSource(usage);
  for (const name of names) {
    const value = Number(source?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function jobUsage(job, events = []) {
  const observed = [...events].reverse().find((event) => event.type === 'usage.updated')?.data || job.usage || null;
  const input = tokenValue(observed, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) || 0;
  const output = tokenValue(observed, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) || 0;
  const total = tokenValue(observed, ['totalTokens', 'total_tokens']) ?? (input + output);
  const cached = tokenValue(observed, ['cachedInputTokens', 'cached_input_tokens', 'cachedTokens', 'cached_tokens']) || 0;
  return { observed, input, output, total, cached };
}

function jobState(job) {
  if (job.stalled) return { text: `stalled/${job.phase || job.status}`, style: palette.stalled };
  const phase = job.phase && job.phase !== job.status ? `/${job.phase}` : '';
  if (job.status === 'running' && job.phase === 'paused') return { text: `paused${phase}`, style: palette.paused };
  const style = job.status === 'running' || job.status === 'queued' ? palette.running
    : job.status === 'paused' ? palette.paused
      : job.status === 'failed' ? palette.failed
        : job.status === 'cancelled' ? palette.cancelled : palette.completed;
  return { text: `${job.status || 'unknown'}${phase}`, style };
}

function badges(job) {
  const values = [];
  if (job.resultSuspect) values.push('?');
  const violations = Array.isArray(job.scopeViolations) ? job.scopeViolations.length : Number(job.scopeViolations || 0);
  if (violations) values.push(`S${violations}`);
  if (job.largeWrite) values.push('L');
  if (job.reviewFlowEngaged) values.push('RF');
  return values.join(',') || '—';
}

function fleetColumns(width) {
  const columns = width >= 90 ? [
    { key: 'id', title: 'Job', width: 10, selectedStyle: palette.selectedId }, { key: 'provider', title: 'Provider', width: 8 },
    { key: 'model', title: 'Model', width: 10, flexible: true }, { key: 'mode', title: 'Mode', width: 8 },
    { key: 'state', title: 'Status/phase', width: 14 }, { key: 'heartbeat', title: 'Beat', width: 7, align: 'right' },
    { key: 'elapsed', title: 'Elapsed', width: 8, align: 'right' }, { key: 'tokens', title: 'Out/budget', width: 14, align: 'right' },
    { key: 'chain', title: 'Chain', width: 9 }, { key: 'badges', title: 'Badges', width: 7 }
  ] : [
    { key: 'id', title: 'Job', width: 10, selectedStyle: palette.selectedId }, { key: 'provider', title: 'Provider', width: 8 },
    { key: 'model', title: 'Model', width: 8, flexible: true }, { key: 'state', title: 'Status/phase', width: 14 },
    { key: 'badges', title: 'Badges', width: 7 }
  ];
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  const flexible = columns.find((column) => column.flexible);
  if (flexible) flexible.width = Math.max(8, flexible.width + (width - total));
  return columns;
}

function providerBand(provider) {
  if (!provider.enabled) return { label: 'off', style: palette.dim };
  if (!provider.allowance?.known) return { label: '?', style: palette.dim };
  const used = provider.allowance.usedPercent;
  if (used >= provider.avoidPercent) return { label: `${Math.round(used)}%`, style: palette.failed };
  if (used >= provider.warningPercent) return { label: `${Math.round(used)}%`, style: palette.badgeWarn };
  return { label: `${Math.round(used)}%`, style: palette.running };
}

function commonOverlay(frame, ui) {
  const notify = ui.notifyEnabled === false ? 'notify:off' : 'notify:on';
  if (frame.status) frame.status.right = `${notify}${frame.status.right ? ` · ${frame.status.right}` : ''}`;
  if (ui.help) frame.overlay = { kind: 'help', title: 'delegate-tui keys', items: HELP_ITEMS };
  else if (ui.confirm) frame.overlay = { kind: 'confirm', ...ui.confirm };
  else if (ui.input) frame.overlay = { kind: 'input', ...ui.input };
  return frame;
}

function errorStatus(ui) {
  if (!ui.status) return null;
  return {
    segments: [{ text: ui.status, style: ui.statusKind === 'error' ? palette.failed : palette.accent }],
    style: palette.bar
  };
}

export function fleetViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const now = nowOf(ui);
  const query = String(ui.filter || '').toLowerCase();
  const entries = (store.jobs || []).map((raw) => ({ raw, job: effectiveJobRecord(raw, now) }))
    .filter(({ job }) => (!ui.groupId || job.groupId === ui.groupId)
      && (!ui.activeOnly || active(job))
      && (!query || [job.id, job.resolvedModel || job.model, job.cwd].some((value) => String(value || '').toLowerCase().includes(query))))
    .sort((left, right) => Number(active(right.job)) - Number(active(left.job))
      || Number(right.job.lastActivityAt || right.job.updatedAt * 1000 || 0) - Number(left.job.lastActivityAt || left.job.updatedAt * 1000 || 0));
  const selected = Math.max(0, Math.min(entries.length - 1, Number(ui.selectedIndex || 0)));
  const innerWidth = Math.max(1, width - 2);
  const columns = fleetColumns(innerWidth);
  const rows = entries.map(({ job }) => {
    const usage = jobUsage(job, store.eventsByJob?.[job.id]);
    const max = Number(job.maxOutputTokens);
    const tokens = max > 0 ? `${number(usage.output)}/${number(max)} ${Math.round((usage.output / max) * 100)}%` : number(usage.output);
    const values = {
      id: shortId(job),
      provider: job.provider || '—',
      model: job.resolvedModel || job.model || job.requestedModel || 'auto',
      mode: job.mode || '—',
      state: jobState(job),
      heartbeat: duration(job.lastActivityAt == null ? null : now - job.lastActivityAt),
      elapsed: duration(((job.completedAt ? job.completedAt * 1000 : now) - (job.createdAt || 0) * 1000)),
      tokens,
      chain: job.rootJobId ? `↳${String(job.rootJobId).slice(-6)}` : job.groupId ? `G:${String(job.groupId).slice(0, 7)}` : '—',
      badges: { text: badges(job), style: badges(job) === '—' ? palette.dim : palette.badgeWarn }
    };
    return { id: job.id, reconciliationPending: job.reconciliationPending === true, cells: columns.map((column) => values[column.key]) };
  });
  const visibleRows = Math.max(0, height - 5);
  const requestedScroll = Math.max(0, Number(ui.scroll || 0));
  const scroll = Math.max(0, Math.min(
    Math.max(requestedScroll, selected >= requestedScroll + visibleRows ? selected - visibleRows + 1 : requestedScroll),
    Math.max(0, entries.length - visibleRows)
  ));
  const reconcileJobIds = rows.slice(scroll, scroll + visibleRows).filter((row) => row.reconciliationPending).map((row) => row.id);
  const allowance = (store.providers || []).filter((provider) => provider.name !== 'claude' || provider.allowance?.known).map((provider) => {
    const band = providerBand(provider);
    return { text: `${provider.name.slice(0, 2)}:${band.label} `, style: band.style };
  });
  const locks = store.writerLocks?.length ? `writers:${store.writerLocks.length}` : 'writers:0';
  const statusOverride = errorStatus(ui);
  const frame = {
    width, height, screen: ui.groupId ? 'group-members' : 'fleet',
    title: { text: `${ui.groupId ? `Group ${ui.groupId}` : 'Delegate fleet'}${ui.activeOnly ? ' · active' : ''}${ui.filter ? ` · /${ui.filter}` : ''}`, right: `${entries.length} jobs` },
    panes: [{
      rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) },
      title: store.error ? `Store warning: ${store.error}` : 'Managed jobs',
      content: { kind: 'table', columns, rows, selected, scroll: ui.scroll || 0 }
    }],
    status: statusOverride || {
      style: palette.bar,
      segments: [...allowance, { text: ` ${locks} `, style: store.writerLocks?.length ? palette.badgeWarn : palette.dim }],
      right: ui.groupId ? 'Enter detail  Esc groups  / filter' : 'Enter detail  G groups  a active  / filter  p providers  t stats  N new'
    },
    meta: {
      visibleJobIds: entries.map(({ job }) => job.id),
      selectedJobId: entries[selected]?.job.id || null,
      reconcileJobIds,
      selected
    }
  };
  return commonOverlay(frame, ui);
}

export function groupsViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const now = nowOf(ui);
  const groups = store.groups || [];
  const selected = Math.max(0, Math.min(groups.length - 1, Number(ui.groupSelection || 0)));
  const columns = [
    { key: 'groupId', title: 'Group', width: Math.max(16, width - 63), selectedStyle: palette.selectedId },
    { key: 'total', title: 'Members', width: 9, align: 'right' },
    { key: 'running', title: 'Running', width: 9, align: 'right' },
    { key: 'terminal', title: 'Terminal', width: 10, align: 'right' },
    { key: 'stalled', title: 'Stalled', width: 9, align: 'right' },
    { key: 'barrier', title: 'Barrier', width: 9 },
    { key: 'activity', title: 'Newest', width: 9, align: 'right' }
  ];
  const rows = groups.map((group) => ({
    ...group,
    barrier: { text: group.allTerminal ? 'open' : 'waiting', style: group.allTerminal ? palette.completed : palette.paused },
    activity: duration(group.newestActivityAt == null ? null : now - group.newestActivityAt)
  }));
  const frame = {
    width, height, screen: 'groups',
    title: { text: 'Delegate groups · barrier progress', right: `${groups.length} groups` },
    panes: [{
      rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) }, title: 'Group members and all-terminal barrier',
      content: { kind: 'table', columns, rows, selected, scroll: ui.groupScroll || 0 }
    }],
    status: errorStatus(ui) || { text: 'Esc fleet  ↑/↓ select  Enter members  G close  ? help  q quit' },
    meta: { groupIds: groups.map((group) => group.groupId), selectedGroupId: groups[selected]?.groupId || null, selected }
  };
  return commonOverlay(frame, ui);
}

export function groupMembersViewModel(store, ui = {}, viewport = {}) {
  return fleetViewModel(store, {
    ...ui,
    groupId: ui.groupId,
    selectedIndex: ui.groupMemberSelection || 0,
    scroll: ui.groupMemberScroll || 0
  }, viewport);
}

function eventText(event) {
  const data = event?.data || {};
  const body = data.text ?? data.delta ?? data.message ?? data.output ?? data.error ?? data.plan ?? '';
  const rendered = typeof body === 'string' ? body : JSON.stringify(body);
  return `${String(event.seq || '').padStart(5)} ${event.type || 'event'}${rendered ? `  ${rendered}` : ''}`;
}

function lineStyleForEvent(event) {
  if (event.type === 'error' || event.type === 'scope.violation') return palette.failed;
  if (event.type?.startsWith('message.')) return palette.body;
  if (event.type?.startsWith('tool.')) return palette.accent;
  if (event.type === 'usage.updated') return palette.positive;
  return palette.dim;
}

const eventViewCache = new WeakMap();

function cachedEventView(events, key, predicate) {
  if (!events.length) return events;
  let views = eventViewCache.get(events);
  if (!views) {
    views = new Map();
    eventViewCache.set(events, views);
  }
  if (!views.has(key)) views.set(key, events.filter(predicate));
  return views.get(key);
}

function transcriptEntry(event) {
  return eventText(event);
}

function rawEventEntry(event) {
  return JSON.stringify(event);
}

function derivedResumable(job) {
  if (job.resumable) return job.resumable;
  if (job.managedBy !== 'delegate-control') return { ok: false, reason: 'legacy job' };
  if (!TERMINAL.has(job.status)) return { ok: false, reason: 'job is active' };
  if (!job.providerSessionId && !job.session) return { ok: false, reason: 'no continuation id' };
  if (job.provider === 'codex' && job.reviewFlowEngaged) return { ok: false, reason: 'review-flow thread' };
  return { ok: true, reason: 'provider continuation available' };
}

function derivedDrift(job) {
  if (job.driftReport) return job.driftReport;
  const entries = job.changedFiles?.entries || (job.changedFiles?.files || []).map((path) => ({ path }));
  return {
    modified: entries.filter((entry) => entry.status !== '??').map((entry) => entry.path),
    newFiles: entries.filter((entry) => entry.status === '??').map((entry) => entry.path),
    outsideScope: (job.scopeViolations || []).map((entry) => entry.path || entry).filter(Boolean)
  };
}

function recordLines(job) {
  const curated = {
    status: job.status,
    phase: job.phase,
    checkpoint: job.checkpoint || null,
    verification: job.verification || null,
    driftReport: derivedDrift(job),
    resumable: derivedResumable(job),
    objectiveMet: job.objectiveMet ?? null,
    scopeViolations: job.scopeViolations || [],
    error: job.error || null,
    errorCode: job.errorCode || null
  };
  return JSON.stringify(curated, null, 2).split('\n');
}

function usageLines(job, store) {
  const current = jobUsage(job, store.eventsByJob?.[job.id]);
  const jobsById = new Map((store.jobs || []).map((entry) => [entry.id, entry]));
  const chain = [job];
  const seen = new Set([job.id]);
  let parent = job.parentJobId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const member = jobsById.get(parent);
    if (!member) break;
    chain.unshift(member);
    parent = member.parentJobId;
  }
  const cumulative = chain.map((member) => jobUsage(member, store.eventsByJob?.[member.id]))
    .reduce((sum, usage) => ({ input: sum.input + usage.input, output: sum.output + usage.output, total: sum.total + usage.total }), { input: 0, output: 0, total: 0 });
  const cachedPercent = current.input > 0 ? Math.round((current.cached / current.input) * 100) : 0;
  const max = Number(job.maxOutputTokens || 0);
  const fraction = max > 0 ? Math.min(1, current.output / max) : 0;
  const barWidth = 30;
  const filled = Math.round(fraction * barWidth);
  return [
    `Input tokens       ${number(current.input)}`,
    `Cached input       ${number(current.cached)} (${cachedPercent}%)`,
    `Output tokens      ${number(current.output)}`,
    `Total tokens       ${number(current.total)}`,
    `Output budget      ${max > 0 ? `${number(current.output)} / ${number(max)}  [${'█'.repeat(filled)}${'·'.repeat(barWidth - filled)}]` : 'not set'}`,
    '',
    `Chain root         ${chain[0]?.id || job.id}`,
    `Observed jobs      ${chain.length}`,
    `Chain input        ${number(cumulative.input)}`,
    `Chain output       ${number(cumulative.output)}`,
    `Chain total        ${number(cumulative.total)}`
  ];
}

const chainIndexCache = new WeakMap();

function chainIndex(store) {
  const jobs = store.jobs || [];
  if (chainIndexCache.has(jobs)) return chainIndexCache.get(jobs);
  const byId = new Map(jobs.map((entry) => [entry.id, entry]));
  const groups = new Map();
  const memberRoot = new Map();
  for (const job of jobs) {
    let root = job;
    const seen = new Set([job.id]);
    while (root.parentJobId && !seen.has(root.parentJobId)) {
      seen.add(root.parentJobId);
      const parent = byId.get(root.parentJobId);
      if (!parent) break;
      root = parent;
    }
    const rootId = job.rootJobId || root.id;
    memberRoot.set(job.id, rootId);
    if (!groups.has(rootId)) groups.set(rootId, []);
    groups.get(rootId).push(job);
  }
  for (const chain of groups.values()) chain.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0) || String(left.id).localeCompare(String(right.id)));
  const index = { groups, memberRoot, ids: new Map([...groups].map(([root, chain]) => [root, chain.map((entry) => entry.id)])) };
  chainIndexCache.set(jobs, index);
  return index;
}

function detailChain(store, job) {
  const index = chainIndex(store);
  const root = index.memberRoot.get(job.id) || job.rootJobId || job.id;
  return { jobs: index.groups.get(root) || [job], ids: index.ids.get(root) || [job.id] };
}

function detailTabs(store, job) {
  return job.rootJobId || detailChain(store, job).jobs.length > 1 ? DETAIL_TABS : DETAIL_TABS.slice(0, 5);
}

function searchSuffix(ui, pane) {
  const search = ui.search;
  if (!search || search.pane !== pane || !search.query) return '';
  const total = search.matches?.length || 0;
  return ` · ${total ? Math.min(total, Number(search.current || 0) + 1) : 0}/${total}`;
}

function searchQuery(ui, pane) {
  return ui.search?.pane === pane ? String(ui.search.query || '') : '';
}

function chainContent(store, job, ui, width) {
  const chain = detailChain(store, job);
  const columns = [
    { key: 'id', title: 'Round', width: 11, selectedStyle: palette.selectedId },
    { key: 'mode', title: 'Mode', width: 10 },
    { key: 'files', title: 'Files', width: 7, align: 'right' },
    { key: 'verify', title: 'Verify', width: 8, align: 'right' },
    { key: 'marker', title: 'Result marker', width: 20 },
    { key: 'outcome', title: 'Outcome', width: Math.max(12, width - 58) }
  ];
  const rowAt = (index) => {
    const round = chain.jobs[index];
    if (!round) return null;
    const markers = [];
    if (round.objectiveMet != null) markers.push(`objective:${String(round.objectiveMet)}`);
    if (round.resultSuspect) markers.push(`suspect:${String(round.resultSuspect)}`);
    const outcome = String(round.resultText || round.result?.text || round.result || round.error || '—').split(/\r?\n/, 1)[0];
    return {
      id: shortId(round), mode: round.mode || '—', files: Number(round.changedFiles?.count ?? round.changedFiles?.files?.length ?? round.changedFiles?.entries?.length ?? 0),
      verify: round.verification?.exitCode == null ? '—' : String(round.verification.exitCode),
      marker: { text: markers.join(', ') || '—', style: round.resultSuspect || round.objectiveMet === false ? palette.badgeWarn : palette.dim },
      outcome
    };
  };
  return {
    title: `Chain · ${chain.jobs.length} rounds`,
    content: { kind: 'table', columns, rows: [], rowCount: chain.jobs.length, rowAt, selected: ui.chainSelection || 0, scroll: ui.detailScroll || 0 },
    scrollItemCount: chain.jobs.length,
    chainJobIds: chain.ids
  };
}

function detailContent(job, store, ui, tab) {
  const events = store.eventsByJob?.[job.id] || [];
  const hydration = store.hydrationByJob?.[job.id];
  const historyState = hydration?.error
    ? ` · history error: ${hydration.error}`
    : hydration?.loading ? ' · loading history…' : '';
  const emptyHistory = hydration?.loading
    ? [{ text: 'Loading journal history…', style: palette.dim }]
    : hydration?.error ? [{ text: `Journal history unavailable: ${hydration.error}`, style: palette.failed }] : [];
  if (tab === 0) {
    const transcriptTypes = /^(?:message\.|plan\.updated|tool\.|correction\.|error$)/;
    const entries = cachedEventView(events, 'transcript', (event) => transcriptTypes.test(event.type));
    return {
      title: `Transcript · follow ${ui.follow === false ? 'off' : 'on'}${historyState}${searchSuffix(ui, 'transcript')}`,
      content: entries.length ? {
        kind: 'log', virtual: true, entries, formatEntry: transcriptEntry, styleEntry: lineStyleForEvent,
        follow: ui.follow !== false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'transcript')
      } : { kind: 'log', lines: emptyHistory, follow: true },
      scrollItemCount: entries.length
    };
  }
  if (tab === 1) {
    if (ui.diffFile) {
      const window = ui.diffWindow || { diff: '', offset: 0, totalChars: 0, nextOffset: null };
      const lines = String(window.diff || '').split('\n');
      return {
        title: `Diff · ${ui.diffFile} · ${window.offset}-${window.offset + String(window.diff || '').length}/${window.totalChars}${searchSuffix(ui, 'diff')}`,
        content: { kind: 'log', virtual: true, entries: lines, formatEntry: String, follow: false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'diff') },
        scrollItemCount: lines.length
      };
    }
    const stat = store.diffStatsByJob?.[job.id] || { files: [], totalAdditions: 0, totalDeletions: 0 };
    const files = stat.files || [];
    return {
      title: `Diff · +${stat.totalAdditions || 0} -${stat.totalDeletions || 0}`,
      content: {
        kind: 'table', selected: ui.diffSelection || 0, scroll: ui.detailScroll || 0,
        columns: [{ key: 'path', title: 'File', width: 60 }, { key: 'additions', title: '+', width: 8, align: 'right' }, { key: 'deletions', title: '-', width: 8, align: 'right' }],
        rows: files.map((file) => ({ ...file, additions: { text: String(file.additions), style: palette.positive }, deletions: { text: String(file.deletions), style: palette.negative } }))
      },
      scrollItemCount: files.length
    };
  }
  if (tab === 2) {
    const lines = [
      ...(job.displayReconciled ? [{
        text: job.reconciliationPending
          ? `(reconciled) displaying ${job.reconciledFrom} as failed; durable record update pending`
          : `(reconciled) stale ${job.reconciledFrom} record persisted as failed by this TUI`,
        style: palette.dim
      }] : []),
      ...recordLines(job)
    ];
    return {
    title: 'Record · curated fields',
    content: {
      kind: 'log',
      lines,
      follow: false,
      scroll: ui.detailScroll || 0
    },
    scrollItemCount: lines.length
  };
  }
  if (tab === 3) {
    const lines = usageLines(job, store);
    return { title: 'Usage · current and continuation chain', content: { kind: 'log', lines, follow: false, scroll: ui.detailScroll || 0 }, scrollItemCount: lines.length };
  }
  if (tab === 5) return chainContent(store, job, ui, Math.max(1, Number(ui.viewportWidth || 80) - 2));
  const typeFilter = String(ui.eventFilter || '').toLowerCase();
  const filtered = cachedEventView(events, `events:${typeFilter}`, (event) => !typeFilter || String(event.type).toLowerCase().includes(typeFilter));
  return {
    title: `Events · ${typeFilter ? `type /${typeFilter}` : 'all'} · follow ${ui.follow === false ? 'off' : 'on'}${historyState}${searchSuffix(ui, 'events')}`,
    content: filtered.length ? {
      kind: 'log', virtual: true, entries: filtered, formatEntry: rawEventEntry, styleEntry: lineStyleForEvent,
      follow: ui.follow !== false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'events')
    } : { kind: 'log', lines: emptyHistory, follow: true },
    scrollItemCount: filtered.length
  };
}

export function detailViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const rawJob = (store.jobs || []).find((entry) => entry.id === ui.jobId) || (store.jobs || [])[0];
  if (!rawJob) return fleetViewModel(store, { ...ui, status: 'Job disappeared from the store', statusKind: 'error' }, viewport);
  const job = effectiveJobRecord(rawJob, nowOf(ui));
  const tabs = detailTabs(store, job);
  const tab = Math.max(0, Math.min(tabs.length - 1, Number(ui.detailTab || 0)));
  const body = detailContent(job, store, { ...ui, viewportWidth: width }, tab);
  const frame = {
    width, height, screen: 'detail',
    title: { text: `${job.id} · ${job.provider} · ${job.resolvedModel || job.model || 'auto'}`, right: jobState(job).text },
    tabs: { rect: { x: 0, y: 1, width, height: 1 }, items: tabs, active: tab },
    panes: [{ rect: { x: 0, y: 2, width, height: Math.max(3, height - 3) }, title: body.title, content: body.content }],
    status: errorStatus(ui) || { text: 'Esc fleet  [/] tabs  / search  f follow  s steer  r resume  R release  n nudge  w review  c cancel  v revert' },
    meta: {
      jobId: job.id,
      tab,
      tabs,
      diffFiles: store.diffStatsByJob?.[job.id]?.files?.map((file) => file.path) || [],
      chainJobIds: body.chainJobIds || [],
      scrollItemCount: body.scrollItemCount || 0
    }
  };
  return commonOverlay(frame, ui);
}

function barCell(provider, width = 24) {
  if (!provider.allowance?.known) return { segments: [{ text: 'unknown'.padEnd(width), style: palette.dim }] };
  const usedCells = Math.round((provider.allowance.usedPercent / 100) * width);
  const warningCell = Math.round((provider.warningPercent / 100) * width);
  const avoidCell = Math.round((provider.avoidPercent / 100) * width);
  const cells = [];
  for (let index = 0; index < width; index += 1) {
    const style = index >= avoidCell ? palette.failed : index >= warningCell ? palette.badgeWarn : palette.running;
    const text = index < usedCells ? '█' : '·';
    const last = cells.at(-1);
    if (last && last.style === style) last.text += text;
    else cells.push({ text, style });
  }
  return { segments: cells };
}

export function providersViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const columns = [
    { key: 'provider', title: 'Provider', width: 10 },
    { key: 'enabled', title: 'State', width: 10 },
    { key: 'allowance', title: 'Used', width: 8, align: 'right' },
    { key: 'bar', title: 'Allowance · warning · avoid', width: 24 },
    { key: 'windows', title: 'Windows', width: Math.max(12, width - 70) },
    { key: 'verified', title: 'Last verified', width: 18 }
  ];
  const rows = (store.providers || []).map((provider) => {
    const band = providerBand(provider);
    const verified = provider.lastVerified?.at ? new Date(provider.lastVerified.at).toISOString().replace('T', ' ').slice(0, 16) : '—';
    return {
      provider: provider.name,
      enabled: { text: provider.enabled ? 'enabled' : 'disabled', style: provider.enabled ? palette.running : palette.dim },
      allowance: { text: band.label, style: band.style },
      bar: barCell(provider),
      windows: (provider.allowance?.windows || []).map((window) => `${window.name}:${Math.round(window.usedPercent)}%`).join(' ') || '—',
      verified: { text: verified, style: provider.lastVerified?.ok === false ? palette.failed : palette.dim }
    };
  });
  const lockLines = store.writerLocks?.length
    ? store.writerLocks.map((lock) => `${lock.jobId}  ${lock.mode}/${lock.status}${lock.phase ? `/${lock.phase}` : ''}  ${lock.cwd}`)
    : ['No active shared-worktree writers.'];
  const providerHeight = Math.max(6, Math.min(10, Math.floor((height - 2) / 2)));
  const frame = {
    width, height, screen: 'providers',
    title: { text: 'Providers and allowance guard bands', right: 'green < warning < amber < avoid < red' },
    panes: [
      { rect: { x: 0, y: 1, width, height: providerHeight }, title: 'Allowance windows', content: { kind: 'table', columns, rows, selection: false } },
      { rect: { x: 0, y: 1 + providerHeight, width, height: Math.max(3, height - providerHeight - 2) }, title: 'Active writer ownership by cwd', content: { kind: 'log', lines: lockLines, follow: false, scroll: ui.providerScroll || 0 } }
    ],
    status: errorStatus(ui) || { text: 'Esc fleet  ↑/↓ scroll  p close  ? help  q quit' }
  };
  return commonOverlay(frame, ui);
}

export function statsViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const stats = store.stats || { since: '7d', jobs: 0, groups: [] };
  const columns = [
    { key: 'provider', title: 'Provider', width: 9 }, { key: 'model', title: 'Model', width: 14 },
    { key: 'mode', title: 'Mode', width: 10 }, { key: 'jobs', title: 'Jobs', width: 6, align: 'right' },
    { key: 'success', title: 'Success', width: 9, align: 'right' }, { key: 'resumedJobs', title: 'Resume', width: 7, align: 'right' },
    { key: 'nudgeCount', title: 'Nudge', width: 7, align: 'right' }, { key: 'duration', title: 'Mean ms', width: 10, align: 'right' },
    { key: 'tokens', title: 'Out tok', width: 9, align: 'right' }, { key: 'failures', title: 'B/T/V', width: Math.max(7, width - 83) }
  ];
  const query = String(ui.statsFilter || '').toLocaleLowerCase();
  const filtered = (stats.groups || []).filter((row) => !query || JSON.stringify(row).toLocaleLowerCase().includes(query));
  const rows = filtered.map((row) => ({
    ...row,
    success: `${Math.round((row.successRate || 0) * 100)}%`,
    duration: Math.round(row.meanDurationMs || 0),
    tokens: Math.round(row.meanOutputTokens || 0),
    failures: `${row.budgetCount || 0}/${row.timeoutCount || 0}/${row.violationCount || 0}`
  }));
  const frame = {
    width, height, screen: 'stats',
    title: { text: `Delegation stats · last ${stats.since || '7d'}${query ? ` · /${ui.statsFilter}` : ''}`, right: `${rows.length}/${stats.groups?.length || 0} audit rows` },
    panes: [{ rect: { x: 0, y: 1, width, height: height - 2 }, title: 'Provider / normalized model / mode', content: { kind: 'table', columns, rows, selected: ui.statsSelection || 0, scroll: ui.statsScroll || 0 } }],
    status: errorStatus(ui) || { text: 'Esc fleet  ↑/↓ select  / filter loaded audit rows  default window: 7d  ? help  q quit' },
    meta: { visibleStatsCount: rows.length }
  };
  return commonOverlay(frame, ui);
}

const LAUNCH_FIELDS = Object.freeze([
  ['profile', 'Profile'], ['provider', 'Provider'], ['model', 'Model'], ['mode', 'Mode'],
  ['effort', 'Effort'], ['prompt', 'Packet body'], ['allowedPaths', 'Allowed paths'],
  ['verifyCommand', 'Verify command'], ['ingestFiles', 'Ingest files']
]);

export function routeAdvisorLines(route) {
  if (!route) return ['Calculating route advice…'];
  const candidate = (label, value) => {
    if (!value) return `${label}: none`;
    const band = value.usageBand;
    const usage = band ? ` · p50 ${Math.round(band.p50OutputTokens || 0)} / p90 ${Math.round(band.p90OutputTokens || 0)} out (${band.samples || 0})` : '';
    return `${label}: ${value.provider}/${value.model} · score ${value.score}${usage}`;
  };
  return [
    `${route.kind || 'general'} · ${route.mode || 'implement'} · effort ${route.effort || 'medium'}`,
    candidate('Primary', route.primary),
    candidate('Fallback', route.fallbacks?.[0]),
    route.primary?.reason || 'Advisory only; dry-run admission remains authoritative.'
  ];
}

export function launcherViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const launcher = ui.launcher || {};
  const rows = LAUNCH_FIELDS.map(([key, label]) => ({ field: label, value: Array.isArray(launcher[key]) ? launcher[key].join(',') : String(launcher[key] ?? (key === 'profile' ? '<none>' : '')) }));
  const preview = launcher.preview;
  const warnings = preview?.packetWarnings || [];
  const previewLines = preview ? [
    `DRY RUN · ${preview.provider}/${preview.model} · ${preview.mode} · ${preview.effort || 'default'} · ${preview.cwd}`,
    ...(warnings.length ? warnings.map((warning) => `WARNING: ${warning}`) : ['Packet lint: clean']),
    '',
    ...String(preview.packet || '').split('\n')
  ] : ['No preview yet.', '', 'Edit fields, then press d. Launch is disabled until the exact current form has a successful dry run.'];
  const wide = width >= 70;
  const topHeight = wide ? Math.min(13, Math.max(10, Math.floor(height * 0.48))) : Math.min(10, Math.max(7, Math.floor(height * 0.4)));
  const formWidth = wide ? Math.max(42, Math.floor(width * 0.58)) : width;
  const advisorRect = wide
    ? { x: formWidth, y: 1, width: width - formWidth, height: topHeight }
    : { x: 0, y: 1 + topHeight, width, height: Math.min(5, Math.max(3, height - topHeight - 5)) };
  const previewY = wide ? 1 + topHeight : advisorRect.y + advisorRect.height;
  const frame = {
    width, height, screen: 'launcher',
    title: { text: 'New managed job', right: preview ? 'preview ready · y launches' : 'dry run required' },
    panes: [
      { rect: { x: 0, y: 1, width: formWidth, height: topHeight }, title: `Launcher form · profiles: ${(store.profiles || []).join(', ') || 'none'}`, content: { kind: 'table', columns: [{ key: 'field', title: 'Field', width: 16 }, { key: 'value', title: 'Value', width: Math.max(10, formWidth - 18) }], rows, selected: launcher.fieldIndex || 0 } },
      { rect: { x: 0, y: previewY, width, height: Math.max(3, height - previewY - 1) }, title: 'Mandatory dry-run preview · exact provider packet', content: { kind: 'log', lines: previewLines, follow: false, scroll: launcher.previewScroll || 0 } },
      { rect: advisorRect, title: 'Route advisor · advisory only', content: { kind: 'log', lines: routeAdvisorLines(launcher.routeAdvice), follow: false, scroll: 0 } }
    ],
    status: errorStatus(ui) || { text: 'Esc fleet  ↑/↓ field  ←/→ cycle  Enter edit  e $EDITOR body  d dry run  y launch preview  ? help  q quit' },
    meta: { fields: LAUNCH_FIELDS.map(([key]) => key), previewReady: Boolean(preview) }
  };
  return commonOverlay(frame, ui);
}

export function createViewModel(store, ui = {}, viewport = {}) {
  if (ui.screen === 'detail') return detailViewModel(store, ui, viewport);
  if (ui.screen === 'groups') return groupsViewModel(store, ui, viewport);
  if (ui.screen === 'group-members') return groupMembersViewModel(store, ui, viewport);
  if (ui.screen === 'providers') return providersViewModel(store, ui, viewport);
  if (ui.screen === 'stats') return statsViewModel(store, ui, viewport);
  if (ui.screen === 'launcher') return launcherViewModel(store, ui, viewport);
  return fleetViewModel(store, ui, viewport);
}

export function selectedFleetJobId(store, ui = {}, viewport = {}) {
  return fleetViewModel(store, ui, viewport).meta.selectedJobId;
}

export function nudgeEligible(job) {
  return Boolean(job && TERMINAL.has(job.status) && READ_MODES.has(job.mode) && job.resultSuspect);
}
