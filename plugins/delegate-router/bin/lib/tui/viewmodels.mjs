import path from 'node:path';
import { jobNeedsReconciliation } from '../control.mjs';
import { deriveJobActivity } from './activity.mjs';
import { displayOr, formatDisplayValue, formatMultilineDisplayValue, formatTimestamp, joinDisplayParts } from './display.mjs';
import { eventBlocks, formatEventBlock, wrapEventBlock } from './events.mjs';
import { CHROME_GLYPHS, CHROME_SEPARATOR, spinnerGlyph } from './glyphs.mjs';
import { uiPalette as palette } from './palette.mjs';
import { classifySession, correlateSessions } from './sessions.mjs';
import { formatTranscriptBlock, TranscriptProjector, wrapTranscriptBlock } from './transcript.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const READ_MODES = new Set(['consult', 'plan', 'review']);

export const DETAIL_TABS = Object.freeze(['Transcript', 'Diff', 'Record', 'Usage', 'Events', 'Chain']);

export const HELP_ITEMS = Object.freeze([
  { key: 'Dashboard', description: 'Attention first: jobs needing you, today metrics, providers, and recent activity' },
  { key: 'F / Esc', description: 'Open the complete Fleet / walk back toward Dashboard' },
  { key: 'Up/Dn, j/k, wheel', description: 'Move one line; mouse wheel moves three lines' },
  { key: 'PgUp/PgDn', description: 'Move the focused pane by one viewport' },
  { key: 'Home/End, g', description: 'Jump to the start or end of the focused pane' },
  { key: 'Enter / Esc', description: 'Open or edit / go back or close an overlay' },
  { key: 'a / /', description: 'Toggle active jobs / filter or search the focused pane' },
  { key: 'G / S / p / t / N', description: 'Groups / coordinator sessions / providers / seven-day stats / launcher' },
  { key: '[/], 1-6', description: 'Cycle detail tabs / open a specific tab' },
  { key: 'f', description: 'Toggle follow mode in Transcript or Events' },
  { key: 'Enter / d / E', description: 'Expand a Transcript tool / open its Diff / jump to raw Events' },
  { key: 's / r / R', description: 'Steer / resume / release a paused start' },
  { key: 'n/N / c / v / w', description: 'Search next/previous, nudge / cancel / revert / review round' },
  { key: 'Left/Right', description: 'Cycle launcher choices or page a file diff' },
  { key: 'd / y', description: 'Build dry-run preview / launch that exact packet' },
  { key: 'y / T', description: 'Copy focused value / toggle absolute-relative timestamps' },
  { key: 'o / z / M', description: 'Cycle Fleet sort / density / status-message history' },
  { key: 'Ctrl-G', description: 'Mark the current DELEGATE_TUI_DIAG frame' },
  { key: '? / q / Ctrl-C', description: 'Toggle help / quit immediately' }
]);

function viewportOf(viewport = {}) {
  return { width: Math.max(20, Number(viewport.width || 80)), height: Math.max(8, Number(viewport.height || 24)) };
}

function nowOf(ui, store = null) {
  const local = Number(ui.now ?? Date.now());
  const offset = Number(ui.remote?.clockOffsetMs ?? store?.remote?.clockOffsetMs ?? 0);
  return local + (Number.isFinite(offset) ? offset : 0);
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
  const provider = formatDisplayValue(job.provider);
  const prefix = provider ? provider[0].toUpperCase() : 'J';
  return `${prefix}:${formatDisplayValue(job.id).slice(-7)}`;
}

function duration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  let seconds = Math.max(0, Math.floor(Number(value) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 100_000_000_000 ? number * 1000 : number;
}

function number(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '-';
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}m`;
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(amount));
}

function usageSource(value) {
  return value?.total && typeof value.total === 'object' ? value.total : value;
}

function tokenValue(usage, names) {
  const sources = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    sources.push(value);
    for (const key of ['total', 'usage', 'totals', 'inputTokenDetails', 'input_tokens_details', 'promptTokensDetails', 'prompt_tokens_details']) visit(value[key]);
  };
  visit(usage);
  for (const source of sources) {
    for (const name of names) {
      if (source?.[name] == null || source[name] === '') continue;
      const value = Number(source[name]);
      if (Number.isFinite(value)) return value;
    }
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
  return values.join(',') || '-';
}

function fleetColumns(width, remote = null, density = 'wide') {
  const columns = width >= 90 && density !== 'compact' ? [
    { key: 'id', title: 'Job', width: 10, selectedStyle: palette.selectedId }, { key: 'provider', title: 'Provider', width: 8 },
    ...(remote?.enabled ? [{ key: 'host', title: 'Host', width: 16 }] : []),
    { key: 'model', title: 'Model', width: 10, flexible: true }, { key: 'mode', title: 'Mode', width: 8 },
    { key: 'activity', title: 'Activity', width: 20 },
    { key: 'elapsed', title: 'Elapsed', width: 8, align: 'right' }, { key: 'tokens', title: 'Out/budget', width: 14, align: 'right' },
    { key: 'chain', title: 'Chain', width: 9 }, { key: 'badges', title: 'Badges', width: 10 }
  ] : [
    { key: 'id', title: 'Job', width: 10, selectedStyle: palette.selectedId }, { key: 'provider', title: 'Provider', width: 8 },
    { key: 'model', title: 'Model', width: 8, flexible: true }, { key: 'activity', title: 'Activity', width: 14 },
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
  const used = Number(provider.allowance.usedPercent);
  if (!Number.isFinite(used)) return { label: '?', style: palette.dim };
  if (used >= provider.avoidPercent) return { label: `${Math.round(used)}%`, style: palette.failed };
  if (used >= provider.warningPercent) return { label: `${Math.round(used)}%`, style: palette.badgeWarn };
  return { label: `${Math.round(used)}%`, style: palette.running };
}

function footerHints(screen, remote = false) {
  const navigation = [{ key: 'Esc', label: 'back' }, { key: '?', label: 'help' }, { key: 'q', label: 'quit' }];
  const rows = {
    dashboard: [[{ key: 'F', label: 'fleet' }, { key: 'N', label: 'new job' }], [{ key: 'Up/Dn', label: 'select' }, { key: 'Tab', label: 'focus' }, { key: 'Enter', label: 'open' }], navigation],
    fleet: [[{ key: 'Up/Dn', label: 'select' }, { key: 'Enter', label: 'detail' }, { key: '/', label: 'filter' }], [{ key: 'a', label: 'active' }, { key: 'o', label: 'sort' }, { key: 'z', label: 'density' }], [{ key: 'N', label: 'new' }, { key: 'G', label: 'groups' }, { key: 'p', label: 'providers' }], navigation],
    'group-members': [[{ key: 'Up/Dn', label: 'select' }, { key: 'Enter', label: 'detail' }, { key: '/', label: 'filter' }], navigation],
    groups: [[{ key: 'Up/Dn', label: 'select' }, { key: 'Enter', label: 'members' }], navigation],
    sessions: [[{ key: 'Up/Dn', label: 'select' }, { key: 'Enter', label: 'fleet by cwd' }], navigation],
    providers: [[{ key: 'Up/Dn', label: 'scroll' }, { key: 'Tab', label: 'focus' }], navigation],
    stats: [[{ key: 'Up/Dn', label: 'select' }, { key: '/', label: 'filter' }], navigation],
    launcher: [[{ key: 'Up/Dn', label: 'field' }, { key: 'Left/Right', label: 'choice' }, { key: 'Enter', label: 'edit' }], [{ key: 'd', label: 'dry run' }, { key: 'y', label: 'launch' }], navigation],
    detail: [[{ key: '[/]', label: 'tabs' }, { key: 'Up/Dn', label: 'select' }, { key: '/', label: 'search' }], [{ key: 'Enter', label: 'expand' }, { key: 'd', label: 'diff' }, { key: 'E', label: 'events' }], navigation]
  };
  const groups = rows[screen] || [navigation];
  if (!remote) return groups;
  return groups.map((group) => group.filter((hint) => !['N', 's', 'r', 'R', 'c', 'v', 'w'].includes(hint.key))).filter((group) => group.length);
}

function breadcrumbs(frame, ui) {
  if (frame.screen === 'detail') return [ui.detailReturn === 'dashboard' ? 'home' : 'fleet', formatDisplayValue(frame.meta?.jobId).slice(-12)];
  if (frame.screen === 'group-members') return ['groups', formatDisplayValue(ui.groupId).slice(-12)];
  return [frame.screen === 'dashboard' ? 'home' : frame.screen];
}

function commonOverlay(frame, ui, store = null) {
  const remote = ui.remote;
  if (remote?.enabled) {
    const connection = remote.connection || { status: 'connecting', attempt: 0 };
    frame.title.text = `[remote] ${frame.title.text}`;
    frame.title.right = joinDisplayParts([remote.host || 'unknown host', frame.title.right]);
    const retry = connection.status === 'connected' ? '' : connection.attempt ? `#${connection.attempt}` : '';
    const connectionText = `remote:${connection.status}${retry}`;
    if (frame.status?.segments) {
      frame.status.segments.unshift({ text: `${connectionText} `, style: connection.status === 'connected' ? palette.positive : palette.failed });
    } else if (frame.status) {
      frame.status.text = `${connectionText}${CHROME_SEPARATOR}${frame.status.text || ''}`;
    }
  }
  const notify = ui.notifyEnabled === false ? 'notify:off' : 'notify:on';
  if (frame.status) frame.status.right = [remote?.enabled ? 'read-only remote' : '', notify, frame.status.right || '']
    .filter(Boolean).join(CHROME_SEPARATOR);
  const hostCenter = `${ui.remote?.host || ui.hostLabel || 'local'}${CHROME_SEPARATOR}${ui.version || 'v0.22.0'}`;
  frame.appBar = {
    product: 'delegate',
    breadcrumb: breadcrumbs(frame, ui),
    center: frame.headerActivity?.text || hostCenter,
    centerSegments: frame.headerActivity?.segments || null,
    centerStyle: frame.headerActivity?.style || palette.dim,
    chips: (store?.providers || []).filter((provider) => provider.name !== 'claude' || provider.allowance?.known).map((provider) => {
      const band = providerBand(provider);
      return { text: `${formatDisplayValue(provider.name)} ${band.label}`, style: band.style };
    })
  };
  // Row zero is the app bar; row one is its composition-owned breathing
  // space. Shift every content rect once here so hit testing and painting see
  // the same geometry on every screen.
  if (!frame.meta?.appBarSpaced) {
    const contentBottom = frame.status ? frame.height - 1 : frame.height;
    const shifted = (frame.panes || []).map((pane) => {
      const y = Number(pane.rect?.y || 0) + 1;
      const requestedHeight = Number(pane.rect?.height || 0);
      return { ...pane, rect: { ...pane.rect, y, height: Math.max(0, Math.min(requestedHeight, contentBottom - y)) }, requestedHeight };
    });
    // Preserve a usable three-row pane (two borders plus one content row) by
    // borrowing the spacer row from an earlier flexible pane when necessary.
    // This matters on compact split layouts such as Sessions.
    for (let index = 0; index < shifted.length; index += 1) {
      const pane = shifted[index];
      const minimum = Math.min(3, pane.requestedHeight);
      const deficit = Math.max(0, minimum - pane.rect.height);
      if (!deficit) continue;
      const donor = shifted.slice(0, index).reverse().find((candidate) => candidate.rect.height - deficit >= 3);
      if (!donor) continue;
      donor.rect.height -= deficit;
      for (let following = index; following < shifted.length; following += 1) shifted[following].rect.y -= deficit;
      pane.rect.height = Math.min(pane.requestedHeight, contentBottom - pane.rect.y);
    }
    frame.panes = shifted.map(({ requestedHeight: _requestedHeight, ...pane }) => pane);
    if (frame.tabs) frame.tabs = { ...frame.tabs, rect: { ...frame.tabs.rect, y: Number(frame.tabs.rect?.y || 0) + 1 } };
    frame.meta = { ...(frame.meta || {}), appBarSpaced: true };
  }
  if (frame.status && !frame.status.segments && !ui.status) frame.status.hints = frame.status.hints || footerHints(frame.screen, ui.remote?.enabled);
  frame.focusedPane = Number(ui.focusedPane || 0);
  if (ui.help) frame.overlay = { kind: 'help', title: 'delegate-tui keys', items: HELP_ITEMS };
  else if (ui.statusHistoryOpen) frame.overlay = {
    kind: 'help', title: 'Status history | newest last', width: 90, keyWidth: 13,
    items: (ui.statusHistory || []).slice(-20).flatMap((entry) => formatMultilineDisplayValue(entry.message).split('\n').map((line, index) => ({
      key: index === 0 ? formatTimestamp(entry.at, { mode: ui.timestampMode, now: ui.now }) : '',
      description: `${index === 0 && entry.stream ? `[${entry.stream}] ` : ''}${line}`
    })))
  };
  else if (ui.confirm) frame.overlay = { kind: 'confirm', ...ui.confirm };
  else if (ui.input) frame.overlay = { kind: 'input', ...ui.input };
  return frame;
}

function errorStatus(ui) {
  if (!ui.status) return null;
  return {
    segments: [{ text: formatDisplayValue(ui.status), style: ui.statusKind === 'error' ? palette.failed : palette.accent }],
    style: palette.bar
  };
}

function activityStyle(activity) {
  return activity.tone === 'failed' ? palette.failed
    : activity.tone === 'warning' ? palette.badgeWarn
      : activity.tone === 'accent' ? palette.accent
        : activity.tone === 'paused' ? palette.paused
          : activity.tone === 'dim' ? palette.dim : palette.body;
}

export const ANIMATED_ACTIVITY_KINDS = Object.freeze(new Set(['working', 'tool', 'thinking', 'streaming', 'verifying', 'retrying', 'starting']));

export function activityIndicator(activity, now, options = {}) {
  const animated = ANIMATED_ACTIVITY_KINDS.has(activity?.kind);
  const glyph = animated ? spinnerGlyph(now) : formatDisplayValue(activity?.glyph || '-');
  const suffix = !TERMINAL.has(activity?.kind) && activity?.since && options.includeAge !== false ? `${CHROME_SEPARATOR}${activity.age}` : '';
  const rest = ` ${formatDisplayValue(activity?.label || 'unknown')}${suffix}`;
  const style = activityStyle(activity || {});
  return {
    text: `${glyph}${rest}`,
    style,
    animated,
    segments: [{ text: glyph, style, ...(animated ? { spinner: true } : {}) }, { text: rest, style }]
  };
}

function badgeCell(job) {
  const values = badges(job).split(',').filter((value) => value && value !== '-');
  if (!values.length) return { text: '-', style: palette.dim };
  return {
    text: values.join(','),
    segments: [{ text: ` ${values.join(' ')} `, style: { ...palette.pill, ...palette.badgeWarn } }]
  };
}

function activityEvents(store, job) {
  const selected = store.eventsByJob?.[job.id];
  return selected?.length ? selected : store.activityEventsByJob?.[job.id] || [];
}

function meterCell(percent, width, style) {
  const columns = Math.max(1, Math.floor(Number(width) || 1));
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const eighths = Math.round((value / 100) * columns * 8);
  const full = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const segments = [];
  if (full) segments.push({ text: CHROME_GLYPHS.meter[7].repeat(Math.min(columns, full)), style });
  if (partial && full < columns) segments.push({ text: CHROME_GLYPHS.meter[partial - 1], style });
  const remaining = Math.max(0, columns - full - (partial ? 1 : 0));
  if (remaining) segments.push({ text: CHROME_GLYPHS.horizontal.repeat(remaining), style: palette.meterTrack });
  return { segments };
}

export function dashboardTrendModel(values, options = {}) {
  const finite = (values || []).map((value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const dataDays = Math.max(0, Math.min(finite.length, Math.floor(Number(options.dataDays) || 0)));
  const label = formatDisplayValue(options.label || 'trend/14d');
  if (dataDays < 3) {
    return Object.freeze({
      kind: 'placeholder', label, dataDays,
      placeholder: `collecting data (${dataDays}d)`
    });
  }
  const minimum = finite.length ? Math.min(...finite) : 0;
  const maximum = finite.length ? Math.max(...finite) : 0;
  const span = maximum - minimum;
  const levels = finite.map((value) => span === 0
    ? 0
    : Math.max(0, Math.min(7, Math.round(((value - minimum) / span) * 7))));
  const maxText = typeof options.formatMax === 'function' ? options.formatMax(maximum) : number(maximum);
  return Object.freeze({
    kind: 'sparkline', label, dataDays, minimum, maximum,
    maxLabel: `max ${formatDisplayValue(maxText)}`,
    levels: Object.freeze(levels)
  });
}

function auditTokens(record) {
  const usage = record?.usage;
  return {
    input: tokenValue(usage, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) || 0,
    output: tokenValue(usage, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']) || 0,
    cached: tokenValue(usage, ['cachedInputTokens', 'cached_input_tokens', 'cachedTokens', 'cached_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens']) || 0
  };
}

function auditContext(record, jobsById) {
  const job = jobsById.get(record?.jobId) || {};
  return {
    record,
    jobId: formatDisplayValue(record?.jobId || job.id),
    at: Number(record?.at || 0),
    provider: formatDisplayValue(record?.provider || job.provider),
    parentJobId: formatDisplayValue(record?.parentJobId || job.parentJobId) || null,
    rootJobId: formatDisplayValue(record?.rootJobId || job.rootJobId || record?.parentJobId || job.parentJobId || record?.jobId || job.id),
    providerSessionId: formatDisplayValue(record?.providerSessionId || record?.session || job.providerSessionId || job.session) || null,
    totals: auditTokens(record)
  };
}

export function attributeAuditUsage(records = [], jobs = []) {
  const jobsById = new Map((jobs || []).map((job) => [job.id, job]));
  const contexts = finalAuditRows(records).map((record) => auditContext(record, jobsById));
  const byId = new Map(contexts.filter((entry) => entry.jobId).map((entry) => [entry.jobId, entry]));
  const previousBySession = new Map();
  return contexts.sort((left, right) => left.at - right.at || left.jobId.localeCompare(right.jobId)).map((entry) => {
    let predecessor = null;
    if (entry.provider === 'codex' && entry.parentJobId && entry.providerSessionId) {
      const direct = byId.get(entry.parentJobId);
      if (direct && direct.providerSessionId === entry.providerSessionId && direct.at <= entry.at) {
        predecessor = direct;
        // Review rounds may all name the chain root as parent. Once that root
        // has proved session continuity, the newest earlier final on the same
        // root/session is the effective cumulative-total predecessor.
        const previous = previousBySession.get(entry.providerSessionId);
        if (previous && previous.at >= direct.at && previous.at <= entry.at
          && previous.rootJobId === entry.rootJobId) predecessor = previous;
      }
    }
    const own = Object.fromEntries(['input', 'output', 'cached'].map((key) => [
      key, Math.max(0, entry.totals[key] - (predecessor?.totals[key] || 0))
    ]));
    if (entry.provider === 'codex' && entry.providerSessionId) previousBySession.set(entry.providerSessionId, entry);
    return Object.freeze({ ...entry, own: Object.freeze(own), predecessorJobId: predecessor?.jobId || null });
  });
}

export function finalAuditRows(records = []) {
  const byJob = new Map();
  const anonymous = [];
  for (const record of records) {
    const id = formatDisplayValue(record?.jobId);
    if (!id) { anonymous.push(record); continue; }
    const previous = byJob.get(id);
    if (!previous || Number(record?.at || 0) >= Number(previous?.at || 0)) byJob.set(id, record);
  }
  return [...anonymous, ...byJob.values()];
}

function successfulAudit(record) {
  return record?.outcome?.status === 'completed'
    && Number(record.scopeViolationsCount || 0) === 0
    && (record.verification == null || Number(record.verification?.exitCode) === 0);
}

function dashboardAttention(store, ui, now) {
  const rank = { approval: 7, 'needs-input': 6, stalled: 5, violation: 4, suspect: 3, budget: 2 };
  return (store.jobs || []).flatMap((raw) => {
    const job = effectiveJobRecord(raw, now);
    const activity = deriveJobActivity(job, activityEvents(store, job), { now });
    const violations = Array.isArray(job.scopeViolations) ? job.scopeViolations.length : Number(job.scopeViolations || 0);
    let kind = null;
    let need = '';
    if (activity.kind === 'approval') { kind = 'approval'; need = 'approval required'; }
    else if (activity.kind === 'needs-input') { kind = 'needs-input'; need = 'needs input'; }
    else if (activity.kind === 'stalled') { kind = 'stalled'; need = `stalled ${activity.age}`; }
    else if (violations) { kind = 'violation'; need = `${violations} scope violation${violations === 1 ? '' : 's'}`; }
    else if (job.resultSuspect) { kind = 'suspect'; need = 'result needs review'; }
    else if (job.errorCode === 'BUDGET_EXCEEDED' || job.stoppedReason === 'budget') { kind = 'budget'; need = 'budget stopped'; }
    if (!kind) return [];
    const style = kind === 'stalled' ? palette.failed : palette.badgeWarn;
    return [{ job, activity, kind, rank: rank[kind], need: { text: need, style } }];
  }).sort((left, right) => right.rank - left.rank || Number(right.job.lastActivityAt || right.job.updatedAt * 1000 || 0) - Number(left.job.lastActivityAt || left.job.updatedAt * 1000 || 0));
}

const NOTABLE_EVENTS = new Set(['scope.violation', 'budget.exceeded', 'job.nudged', 'correction.restarted', 'retry.started']);

function dashboardFeed(store, now) {
  const rows = [];
  for (const record of store.audit || []) {
    const status = formatDisplayValue(record.outcome?.status || 'completed');
    let label = status;
    let style = status === 'failed' ? palette.failed : status === 'cancelled' ? palette.dim : palette.positive;
    if (Number(record.scopeViolationsCount || 0)) { label = `scope violation (${record.scopeViolationsCount})`; style = palette.failed; }
    else if (record.outcome?.errorCode === 'BUDGET_EXCEEDED' || record.outcome?.stoppedReason === 'budget') { label = 'budget stopped'; style = palette.badgeWarn; }
    else if (Number(record.nudgeCount || 0)) { label = `nudged x${Number(record.nudgeCount)}`; style = palette.accent; }
    rows.push({ jobId: record.jobId, at: Number(record.at || 0), label, style, provider: record.provider || '-' });
  }
  const seenEvents = new Set();
  for (const events of Object.values(store.activityEventsByJob || {})) {
    for (const event of events || []) {
      if (!NOTABLE_EVENTS.has(event.type) && !/retry|budget|nudge/.test(formatDisplayValue(event.type))) continue;
      const key = `${event.jobId}:${event.seq}:${event.type}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      rows.push({ jobId: event.jobId, at: Number(event.at || 0), label: formatDisplayValue(event.type).replaceAll('.', ' '), style: /violation|budget/.test(event.type) ? palette.badgeWarn : palette.accent, provider: '' });
    }
  }
  return rows.filter((row) => row.jobId).sort((left, right) => right.at - left.at).slice(0, 15).map((row) => ({
    ...row,
    time: { text: formatTimestamp(row.at, { mode: uiTimestampModePlaceholder, now }) || '-', style: palette.dim }
  }));
}

// Kept as a tiny indirection so dashboardFeed remains easy to cache later;
// dashboardViewModel overwrites the timestamp cell with the requested mode.
const uiTimestampModePlaceholder = 'relative';

export function dashboardViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const now = nowOf(ui, store);
  const attention = dashboardAttention(store, ui, now);
  const attentionSelection = Math.max(0, Math.min(attention.length - 1, Number(ui.dashboardAttentionSelection || 0)));
  const feed = dashboardFeed(store, now).map((row) => ({ ...row, time: { text: formatTimestamp(row.at, { mode: ui.timestampMode || 'relative', now }) || '-', style: palette.dim } }));
  const feedSelection = Math.max(0, Math.min(feed.length - 1, Number(ui.dashboardFeedSelection || 0)));
  const jobs = (store.jobs || []).map((job) => effectiveJobRecord(job, now));
  const running = jobs.filter((job) => job.status === 'running' && job.phase !== 'paused').length;
  const paused = jobs.filter((job) => job.status === 'paused' || job.phase === 'paused').length;
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const finalAudit = finalAuditRows(store.audit || []);
  const today = finalAudit.filter((record) => Number(record.at || 0) >= dayStart.getTime() && Number(record.at || 0) <= now);
  const successes = today.filter(successfulAudit).length;
  const todayTokenRows = attributeAuditUsage(finalAudit, store.jobs || [])
    .filter((entry) => entry.at >= dayStart.getTime() && entry.at <= now)
    .map((entry) => entry.own);
  const todayUsage = todayTokenRows.reduce((sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output, cached: sum.cached + value.cached }), { input: 0, output: 0, cached: 0 });
  const meanCacheHit = todayUsage.input > 0 ? Math.max(0, Math.min(1, todayUsage.cached / todayUsage.input)) : 0;
  const days = Array.from({ length: 14 }, (_, index) => {
    const start = dayStart.getTime() - (13 - index) * 86_400_000;
    const records = finalAudit.filter((record) => Number(record.at || 0) >= start && Number(record.at || 0) < start + 86_400_000);
    const durations = records.map((record) => Number(record.durationMs)).filter(Number.isFinite);
    return {
      count: records.length,
      duration: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
      durationSamples: durations.length
    };
  });
  const jobsTrend = dashboardTrendModel(days.map((day) => day.count), {
    label: 'jobs/14d', dataDays: days.filter((day) => day.count > 0).length, formatMax: number
  });
  const durationTrend = dashboardTrendModel(days.map((day) => day.duration), {
    label: 'time/14d', dataDays: days.filter((day) => day.durationSamples > 0).length, formatMax: duration
  });
  const tiles = [
    { value: running > 0 ? { text: `${running} / ${paused}`, segments: [
      { text: spinnerGlyph(now), style: palette.running, spinner: true },
      { text: ` ${running} / ${paused}`, style: palette.tileValue }
    ] } : `${running} / ${paused}`, label: 'running / paused' },
    { value: `${today.length}  ${today.length ? Math.round((successes / today.length) * 100) : 0}%`, label: 'jobs today / success', trend: jobsTrend },
    {
      value: number(todayUsage.input + todayUsage.output), label: 'tokens today',
      detail: `in ${number(todayUsage.input)}${CHROME_SEPARATOR}out ${number(todayUsage.output)}`
    },
    { value: `${Math.round(meanCacheHit * 100)}%`, label: 'mean cache hit', trend: durationTrend }
  ];
  const attentionRows = attention.map(({ job, need, activity }) => ({
    marker: { text: '!', style: palette.badgeWarn },
    job: shortId(job), need,
    context: displayOr(job.resolvedModel || job.model || path.basename(job.cwd || ''), '-'),
    age: { text: activity.age || duration(now - Number(job.lastActivityAt || job.updatedAt * 1000 || now)), style: palette.dim }
  }));
  const feedRows = feed.map((row) => ({
    time: row.time, job: formatDisplayValue(row.jobId).slice(-10), event: { text: row.label, style: row.style }, provider: displayOr(row.provider, '-')
  }));
  const providerRows = (store.providers || []).filter((provider) => provider.name !== 'claude' || provider.allowance?.known).map((provider) => {
    const band = providerBand(provider);
    return {
      provider: displayOr(provider.name, '-'), meter: meterCell(provider.allowance?.usedPercent, Math.max(8, Math.min(24, Math.floor(width / 4))), band.style),
      used: { text: band.label, style: band.style },
      verified: { text: timestampMs(provider.lastVerified?.at) ? `${duration(now - timestampMs(provider.lastVerified.at))} ago` : 'not verified', style: palette.dim }
    };
  });

  const bodyBottom = Math.max(2, height - 1);
  const attentionHeight = Math.max(4, Math.min(7, Math.floor((height - 2) * 0.25)));
  const tilesHeight = height >= 22 ? 5 : 0;
  const providerHeight = height >= 22 ? Math.max(4, Math.min(6, providerRows.length + 3)) : 0;
  const attentionY = 1;
  const tilesY = attentionY + attentionHeight + 1;
  const providerY = tilesY + tilesHeight + (tilesHeight ? 1 : 0);
  const feedY = providerY + providerHeight + (providerHeight ? 1 : 0);
  const feedHeight = Math.max(3, bodyBottom - feedY);
  const panes = [{
    rect: { x: 0, y: attentionY, width, height: attentionHeight }, title: 'Needs you', focused: Number(ui.dashboardFocus || 0) === 0,
    content: { kind: 'table', columns: [{ key: 'marker', title: '', width: 3 }, { key: 'job', title: 'Job', width: 12 }, { key: 'need', title: 'Attention', width: Math.max(18, Math.floor(width * 0.36)) }, { key: 'context', title: 'Context', width: Math.max(12, width - Math.max(18, Math.floor(width * 0.36)) - 25) }, { key: 'age', title: 'Age', width: 8, align: 'right' }], rows: attentionRows, selected: attentionSelection, empty: { message: 'nothing needs you', action: 'N to launch a job' } }
  }];
  if (tilesHeight) {
    const gap = 1;
    const available = width - gap * 3;
    let x = 0;
    for (let index = 0; index < tiles.length; index += 1) {
      const tileWidth = index === tiles.length - 1 ? width - x : Math.floor(available / 4);
      panes.push({ rect: { x, y: tilesY, width: tileWidth, height: tilesHeight }, title: '', border: true, focusable: false, content: { kind: 'tile', ...tiles[index] } });
      x += tileWidth + gap;
    }
  }
  if (providerHeight) panes.push({
    rect: { x: 0, y: providerY, width, height: providerHeight }, title: 'Provider allowance', focusable: false,
    content: { kind: 'table', selection: false, columns: [{ key: 'provider', title: 'Provider', width: 12 }, { key: 'meter', title: 'Allowance', width: Math.max(10, Math.min(26, Math.floor(width / 3))) }, { key: 'used', title: 'Used', width: 9 }, { key: 'verified', title: 'Verified', width: Math.max(12, width - 49) }], rows: providerRows, empty: { message: 'no providers enabled', action: 'Configure a provider to see allowance' } }
  });
  panes.push({
    rect: { x: 0, y: feedY, width, height: feedHeight }, title: 'Recent notable activity', focused: Number(ui.dashboardFocus || 0) === 1,
    content: { kind: 'table', columns: [{ key: 'time', title: 'When', width: 11 }, { key: 'job', title: 'Job', width: 12 }, { key: 'event', title: 'Event', width: Math.max(18, width - 36) }, { key: 'provider', title: 'Provider', width: 10 }], rows: feedRows, selected: feedSelection, empty: { message: 'no recent activity', action: 'N to launch a job or F to open Fleet' } }
  });
  const frame = {
    width, height, screen: 'dashboard', title: { text: 'Delegate dashboard', right: `${jobs.length} jobs` }, panes,
    status: errorStatus(ui) || { text: '' },
    meta: {
      attentionJobIds: attention.map((entry) => entry.job.id), feedJobIds: feed.map((entry) => entry.jobId),
      selectedJobId: Number(ui.dashboardFocus || 0) === 1 ? feed[feedSelection]?.jobId || null : attention[attentionSelection]?.job.id || null,
      attentionSelection, feedSelection, dashboardFocus: Number(ui.dashboardFocus || 0) === 1 ? 1 : 0,
      trends: { jobs: days.map((day) => day.count), duration: days.map((day) => day.duration) },
      todayUsage, meanCacheHit, todayJobs: today.length, todaySuccesses: successes
    }
  };
  return commonOverlay(frame, ui, store);
}

export function fleetViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const now = nowOf(ui, store);
  const query = formatDisplayValue(ui.filter).toLowerCase();
  const sort = ['activity', 'recency', 'provider', 'tokens'].includes(ui.fleetSort) ? ui.fleetSort : 'recency';
  const activityRank = { approval: 9, 'needs-input': 8, stalled: 7, tool: 6, thinking: 5, streaming: 4, retrying: 3, verifying: 2, quiet: 1 };
  const entries = (store.jobs || []).map((raw) => {
    const job = effectiveJobRecord(raw, now);
    const usage = jobUsage(job, store.eventsByJob?.[job.id]);
    const activity = deriveJobActivity(job, activityEvents(store, job), { now });
    return { raw, job, usage, activity };
  })
    .filter(({ job }) => (!ui.groupId || job.groupId === ui.groupId)
      && (!ui.activeOnly || active(job))
      && (!query || [job.id, job.resolvedModel || job.model, job.cwd].some((value) => formatDisplayValue(value).toLowerCase().includes(query))))
    .sort((left, right) => Number(active(right.job)) - Number(active(left.job)) || (() => {
      if (sort === 'provider') return formatDisplayValue(left.job.provider).localeCompare(formatDisplayValue(right.job.provider));
      if (sort === 'tokens') return right.usage.output - left.usage.output;
      if (sort === 'activity') return Number(activityRank[right.activity.kind] || 0) - Number(activityRank[left.activity.kind] || 0)
        || Number(right.activity.since || 0) - Number(left.activity.since || 0);
      return Number(right.job.lastActivityAt || right.job.updatedAt * 1000 || 0) - Number(left.job.lastActivityAt || left.job.updatedAt * 1000 || 0);
    })() || formatDisplayValue(left.job.id).localeCompare(formatDisplayValue(right.job.id)));
  const selected = Math.max(0, Math.min(entries.length - 1, Number(ui.selectedIndex || 0)));
  // Scrollbars replace the right pane border, leaving the full inner table
  // width available while keeping a single owner for the edge column.
  const innerWidth = Math.max(1, width - 4);
  const columns = fleetColumns(innerWidth, ui.remote, ui.fleetDensity);
  const rows = entries.map(({ job, usage, activity }) => {
    const max = Number(job.maxOutputTokens);
    const tokens = max > 0 ? `${number(usage.output)}/${number(max)} ${Math.round((usage.output / max) * 100)}%` : number(usage.output);
    const values = {
      id: shortId(job),
      provider: displayOr(job.provider, '-'),
      host: displayOr(ui.remote?.host, '-'),
      model: displayOr(job.resolvedModel || job.model || job.requestedModel, 'auto'),
      mode: displayOr(job.mode, '-'),
      activity: activityIndicator(activity, now),
      elapsed: duration(((job.completedAt ? job.completedAt * 1000 : now) - (job.createdAt || 0) * 1000)),
      tokens,
      chain: job.rootJobId ? `>${formatDisplayValue(job.rootJobId).slice(-6)}` : job.groupId ? `G:${formatDisplayValue(job.groupId).slice(0, 7)}` : '-',
      badges: badgeCell(job)
    };
    return { id: job.id, reconciliationPending: job.reconciliationPending === true, cells: columns.map((column) => values[column.key]) };
  });
  const visibleRows = Math.max(0, height - 5);
  const requestedScroll = Math.max(0, Number(ui.scroll || 0));
  const scroll = Math.max(0, Math.min(
    Math.max(requestedScroll, selected >= requestedScroll + visibleRows ? selected - visibleRows + 1 : requestedScroll),
    Math.max(0, entries.length - visibleRows)
  ));
  const reconcileJobIds = ui.remote?.enabled ? [] : rows.slice(scroll, scroll + visibleRows).filter((row) => row.reconciliationPending).map((row) => row.id);
  const locks = store.writerLocks?.length ? `writers:${store.writerLocks.length}` : 'writers:0';
  const statusOverride = errorStatus(ui);
  const frame = {
    width, height, screen: ui.groupId ? 'group-members' : 'fleet',
    title: { text: `${ui.groupId ? `Group ${formatDisplayValue(ui.groupId)}` : 'Delegate fleet'}${ui.activeOnly ? `${CHROME_SEPARATOR}active` : ''}${ui.filter ? `${CHROME_SEPARATOR}/${formatDisplayValue(ui.filter)}` : ''}`, right: `${entries.length} jobs` },
    panes: [{
      rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) },
      title: store.error ? `Store warning: ${formatDisplayValue(store.error)}` : 'Managed jobs',
      content: { kind: 'table', columns, rows, selected, scroll: ui.scroll || 0, empty: { message: 'no jobs match the filter', action: 'N to launch a job' } }
    }],
    status: statusOverride || {
      style: palette.bar,
      text: '',
      right: locks
    },
    meta: {
      visibleJobIds: entries.map(({ job }) => job.id),
      selectedJobId: entries[selected]?.job.id || null,
      reconcileJobIds,
      selected,
      fleetSort: sort,
      fleetDensity: ui.fleetDensity === 'compact' ? 'compact' : 'wide'
    }
  };
  frame.title.text = `${frame.title.text}${CHROME_SEPARATOR}sort:${sort}${CHROME_SEPARATOR}${frame.meta.fleetDensity}`;
  return commonOverlay(frame, ui, store);
}

export function groupsViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const now = nowOf(ui, store);
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
    title: { text: 'Delegate groups | barrier progress', right: `${groups.length} groups` },
    panes: [{
      rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) }, title: 'Group members and all-terminal barrier',
      content: { kind: 'table', columns, rows, selected, scroll: ui.groupScroll || 0, empty: { message: 'no job groups yet', action: 'N to launch a grouped job' } }
    }],
    status: errorStatus(ui) || { text: 'Esc fleet  Up/Dn select  Enter members  G close  ? help  q quit' },
    meta: { groupIds: groups.map((group) => group.groupId), selectedGroupId: groups[selected]?.groupId || null, selected }
  };
  return commonOverlay(frame, ui, store);
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
  const rendered = formatDisplayValue(body);
  return `${formatDisplayValue(event.seq).padStart(5)} ${displayOr(event.type, 'event')}${rendered ? `  ${rendered}` : ''}`;
}

function lineStyleForEvent(event) {
  if (event.type === 'error' || event.type === 'scope.violation') return palette.failed;
  if (event.type?.startsWith('message.')) return palette.body;
  if (event.type?.startsWith('tool.')) return palette.accent;
  if (event.type === 'usage.updated') return palette.positive;
  return palette.dim;
}

export function diffLineStyle(value) {
  const line = formatDisplayValue(value);
  if (line.startsWith('@@')) return palette.hunk;
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) return palette.accent;
  if (line.startsWith('+')) return palette.positive;
  if (line.startsWith('-')) return palette.negative;
  return palette.body;
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

function rawEventEntry(event) {
  return formatDisplayValue(event, { maxLength: 16_384 });
}

const transcriptProjectors = new Map();

function transcriptProjector(jobId) {
  if (!transcriptProjectors.has(jobId)) transcriptProjectors.set(jobId, new TranscriptProjector());
  if (transcriptProjectors.size > 128) transcriptProjectors.delete(transcriptProjectors.keys().next().value);
  return transcriptProjectors.get(jobId);
}

function transcriptLineStyle(block, fragment) {
  const kind = fragment?.lineKind || '';
  if (kind === 'body' || kind === 'gap') return palette.body;
  if (kind === 'message-header') return block.role === 'user' ? palette.header : palette.accent;
  if (kind === 'tool-failed' || kind === 'notice-error' || kind === 'plan-failed') return palette.failed;
  if (kind === 'tool-running' || kind === 'notice-warning') return palette.badgeWarn;
  if (kind === 'plan-complete') return palette.planCompleted;
  if (kind === 'plan-active') return palette.planActive;
  if (kind === 'plan-pending') return palette.planPending;
  if (kind === 'meta' || kind === 'notice') return palette.dim;
  return palette.accent;
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
    checkpoint: job.checkpoint || '',
    verification: job.verification || '',
    driftReport: derivedDrift(job),
    resumable: derivedResumable(job),
    objectiveMet: job.objectiveMet ?? '',
    scopeViolations: job.scopeViolations || [],
    error: job.error || '',
    errorCode: job.errorCode || ''
  };
  return formatDisplayValue(curated, { space: 2, maxLength: 64_000 }).split('\n');
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
  const eighths = Math.round(fraction * barWidth * 8);
  const filled = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const budgetBar = `${CHROME_GLYPHS.meter[7].repeat(filled)}${partial && filled < barWidth ? CHROME_GLYPHS.meter[partial - 1] : ''}${CHROME_GLYPHS.horizontal.repeat(Math.max(0, barWidth - filled - (partial ? 1 : 0)))}`;
  return [
    `Input tokens       ${number(current.input)}`,
    `Cached input       ${number(current.cached)} (${cachedPercent}%)`,
    `Output tokens      ${number(current.output)}`,
    `Total tokens       ${number(current.total)}`,
    `Output budget      ${max > 0 ? `${number(current.output)} / ${number(max)}  [${budgetBar}]` : 'not set'}`,
    '',
    `Chain root         ${formatDisplayValue(chain[0]?.id || job.id)}`,
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
  return `${CHROME_SEPARATOR}${total ? Math.min(total, Number(search.current || 0) + 1) : 0}/${total}`;
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
    if (round.objectiveMet != null) markers.push(`objective:${formatDisplayValue(round.objectiveMet)}`);
    if (round.resultSuspect) markers.push(`suspect:${formatDisplayValue(round.resultSuspect)}`);
    const outcome = displayOr(round.resultText || round.result?.text || round.result || round.error, '-').split(/\r?\n/, 1)[0];
    return {
      id: shortId(round), mode: round.mode || '-', files: Number(round.changedFiles?.count ?? round.changedFiles?.files?.length ?? round.changedFiles?.entries?.length ?? 0),
      verify: round.verification?.exitCode == null ? '-' : formatDisplayValue(round.verification.exitCode),
      marker: { text: markers.join(', ') || '-', style: round.resultSuspect || round.objectiveMet === false ? palette.badgeWarn : palette.dim },
      outcome
    };
  };
  return {
    title: `Chain${CHROME_SEPARATOR}${chain.jobs.length} rounds`,
    content: { kind: 'table', columns, rows: [], rowCount: chain.jobs.length, rowAt, selected: ui.chainSelection || 0, scroll: ui.detailScroll || 0 },
    scrollItemCount: chain.jobs.length,
    chainJobIds: chain.ids
  };
}

function detailContent(job, store, ui, tab, activity) {
  const events = store.eventsByJob?.[job.id] || [];
  const hydration = store.hydrationByJob?.[job.id];
  const historyState = hydration?.error
    ? `${CHROME_SEPARATOR}history error: ${formatDisplayValue(hydration.error)}`
    : '';
  const emptyHistory = hydration?.loading
    ? { kind: 'log', lines: [], follow: false }
    : hydration?.error ? { kind: 'empty', message: 'journal history unavailable', action: formatDisplayValue(hydration.error), messageStyle: palette.failed }
      : { kind: 'empty', message: 'no transcript entries', action: 'Live output will appear here when the worker writes it' };
  if (tab === 0) {
    const entries = transcriptProjector(job.id).project(events, {
      expandedTools: ui.expandedTools,
      jobCwd: job.cwd,
      now: nowOf(ui, store),
      timestampMode: ui.timestampMode,
      thinking: activity.kind === 'thinking',
      thinkingSince: activity.since,
      thinkingSeq: activity.sourceSeq
    });
    return {
      title: `Transcript${CHROME_SEPARATOR}follow ${ui.follow === false ? 'off' : 'on'}${CHROME_SEPARATOR}time:${ui.timestampMode === 'relative' ? 'relative' : 'absolute'}${historyState}${searchSuffix(ui, 'transcript')}`,
      loading: hydration?.loading === true,
      loadingGlyph: spinnerGlyph(nowOf(ui, store)),
      content: entries.length ? {
        kind: 'log', virtual: true, entries, formatEntry: formatTranscriptBlock, wrapEntry: wrapTranscriptBlock, styleLine: transcriptLineStyle,
        measureKey: `transcript:${job.id}`,
        follow: ui.follow !== false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'transcript'),
        selectedEntry: ui.follow !== false
          ? entries.length - 1
          : Math.max(0, Math.min(entries.length - 1, Number(ui.transcriptSelection ?? ui.detailScroll?.entry ?? ui.detailScroll ?? 0)))
      } : emptyHistory,
      scrollItemCount: entries.length
    };
  }
  if (tab === 1) {
    if (ui.diffFile) {
      const window = ui.diffWindow || { diff: '', offset: 0, totalChars: 0, nextOffset: null };
      const diffText = formatDisplayValue(window.diff);
      const lines = diffText.split('\n');
      return {
        title: `Diff${CHROME_SEPARATOR}${formatDisplayValue(ui.diffFile)}${CHROME_SEPARATOR}${window.offset}-${window.offset + diffText.length}/${window.totalChars}${searchSuffix(ui, 'diff')}`,
        content: { kind: 'log', virtual: true, entries: lines, formatEntry: formatDisplayValue, styleEntry: diffLineStyle, measureKey: `diff:${job.id}:${formatDisplayValue(ui.diffFile)}`, follow: false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'diff') },
        scrollItemCount: lines.length
      };
    }
    const stat = store.diffStatsByJob?.[job.id] || { files: [], totalAdditions: 0, totalDeletions: 0 };
    const files = stat.files || [];
    return {
      title: `Diff${CHROME_SEPARATOR}+${stat.totalAdditions || 0} -${stat.totalDeletions || 0}`,
      content: {
        kind: 'table', selected: ui.diffSelection || 0, scroll: ui.detailScroll || 0,
        columns: [{ key: 'path', title: 'File', width: 60 }, { key: 'additions', title: '+', width: 8, align: 'right' }, { key: 'deletions', title: '-', width: 8, align: 'right' }],
        rows: files.map((file) => ({ ...file, path: formatDisplayValue(file.path), additions: { text: formatDisplayValue(file.additions), style: palette.positive }, deletions: { text: formatDisplayValue(file.deletions), style: palette.negative } })),
        empty: { message: 'no changed files', action: 'Esc returns to job detail' }
      },
      scrollItemCount: files.length
    };
  }
  if (tab === 2) {
    const lines = [
      ...(job.displayReconciled ? [{
        text: job.reconciliationPending
          ? `(reconciled) displaying ${formatDisplayValue(job.reconciledFrom)} as failed; durable record update pending`
          : `(reconciled) stale ${formatDisplayValue(job.reconciledFrom)} record persisted as failed by this TUI`,
        style: palette.dim
      }] : []),
      ...recordLines(job)
    ];
    return {
    title: 'Record | curated fields',
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
    return { title: 'Usage | current and continuation chain', content: { kind: 'log', lines, follow: false, scroll: ui.detailScroll || 0 }, scrollItemCount: lines.length };
  }
  if (tab === 5) return chainContent(store, job, ui, Math.max(1, Number(ui.viewportWidth || 80) - 2));
  const typeFilter = formatDisplayValue(ui.eventFilter).toLowerCase();
  const filtered = eventBlocks(events, typeFilter);
  const eventNow = nowOf(ui, store);
  const wrapEntry = (block, width, formatted) => wrapEventBlock(block, width, formatted, {
    now: eventNow,
    timestampMode: ui.timestampMode,
    expandedEvents: ui.expandedEvents
  });
  return {
    title: `Events${CHROME_SEPARATOR}${typeFilter ? `type /${typeFilter}` : 'all'}${CHROME_SEPARATOR}follow ${ui.follow === false ? 'off' : 'on'}${historyState}${searchSuffix(ui, 'events')}`,
    loading: hydration?.loading === true,
    loadingGlyph: spinnerGlyph(eventNow),
    content: filtered.length ? {
      kind: 'log', virtual: true, entries: filtered, formatEntry: formatEventBlock, wrapEntry,
      measureKey: `events:${job.id}:${typeFilter}`,
      follow: ui.follow !== false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'events'),
      selectedEntry: ui.follow !== false
        ? filtered.length - 1
        : Math.max(0, Math.min(filtered.length - 1, Number(ui.eventSelection ?? ui.detailScroll?.entry ?? ui.detailScroll ?? 0)))
    } : emptyHistory,
    scrollItemCount: filtered.length,
    eventKeys: filtered.map((block) => block.key)
  };
}

export function detailViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const rawJob = (store.jobs || []).find((entry) => entry.id === ui.jobId) || (store.jobs || [])[0];
  if (!rawJob) return fleetViewModel(store, { ...ui, status: 'Job disappeared from the store', statusKind: 'error' }, viewport);
  const now = nowOf(ui, store);
  const job = effectiveJobRecord(rawJob, now);
  const activity = deriveJobActivity(job, activityEvents(store, job), { now });
  const tabs = detailTabs(store, job);
  const tab = Math.max(0, Math.min(tabs.length - 1, Number(ui.detailTab || 0)));
  const body = detailContent(job, store, { ...ui, viewportWidth: width }, tab, activity);
  const headerActivity = activityIndicator(activity, now);
  const visibility = activity.visibilityNote ? `${CHROME_SEPARATOR}${formatDisplayValue(activity.visibilityNote)}` : '';
  if (visibility) {
    headerActivity.text += visibility;
    headerActivity.segments.push({ text: visibility, style: palette.dim });
  }
  const frame = {
    width, height, screen: 'detail',
    title: { text: joinDisplayParts([job.id, job.provider, job.resolvedModel || job.model || 'auto']), right: headerActivity.text, rightStyle: activityStyle(activity) },
    headerActivity,
    tabs: { rect: { x: 0, y: 1, width, height: 1 }, items: tabs, active: tab },
    panes: [{ rect: { x: 0, y: 3, width, height: Math.max(3, height - 4) }, title: body.title, loading: body.loading, loadingGlyph: body.loadingGlyph, content: body.content }],
    status: errorStatus(ui) || { text: ui.remote?.enabled
      ? 'Esc fleet  [/] tabs  / search  f follow  read-only remote'
      : 'Esc fleet  [/] tabs  / search  f follow  Enter expand  d diff  E events  s/r/R  n/w/c/v' },
    meta: {
      jobId: job.id,
      tab,
      tabs,
      diffFiles: store.diffStatsByJob?.[job.id]?.files?.map((file) => file.path) || [],
      chainJobIds: body.chainJobIds || [],
      eventKeys: body.eventKeys || [],
      scrollItemCount: body.scrollItemCount || 0,
      activity
    }
  };
  return commonOverlay(frame, ui, store);
}

function barCell(provider, width = 24) {
  if (!provider.allowance?.known) return { segments: [{ text: 'unknown'.padEnd(width), style: palette.dim }] };
  return meterCell(provider.allowance.usedPercent, width, providerBand(provider).style);
}

export function providersViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const columns = [
    { key: 'provider', title: 'Provider', width: 10 },
    { key: 'enabled', title: 'State', width: 10 },
    { key: 'allowance', title: 'Used', width: 8, align: 'right' },
    { key: 'bar', title: 'Allowance | warning | avoid', width: 24 },
    { key: 'windows', title: 'Windows', width: Math.max(12, width - 70) },
    { key: 'verified', title: 'Last verified', width: 18 }
  ];
  const rows = (store.providers || []).map((provider) => {
    const band = providerBand(provider);
    const verified = formatTimestamp(provider.lastVerified?.at, { mode: ui.timestampMode, now: nowOf(ui, store) }) || '-';
    return {
      provider: displayOr(provider.name, '-'),
      enabled: { text: provider.enabled ? 'enabled' : 'disabled', style: provider.enabled ? palette.running : palette.dim },
      allowance: { text: band.label, style: band.style },
      bar: barCell(provider),
      windows: (provider.allowance?.windows || []).map((window) => {
        const used = Number(window.usedPercent);
        return joinDisplayParts([window.name, Number.isFinite(used) ? `${Math.round(used)}%` : ''], ':');
      }).filter(Boolean).join(' ') || '-',
      verified: { text: verified, style: provider.lastVerified?.ok === false ? palette.failed : palette.dim }
    };
  });
  const lockLines = store.writerLocks?.length
    ? store.writerLocks.map((lock) => `${formatDisplayValue(lock.jobId)}  ${formatDisplayValue(lock.mode)}/${formatDisplayValue(lock.status)}${lock.phase ? `/${formatDisplayValue(lock.phase)}` : ''}  ${formatDisplayValue(lock.cwd)}`)
    : [];
  const providerHeight = Math.max(6, Math.min(10, Math.floor((height - 3) / 2)));
  const frame = {
    width, height, screen: 'providers',
    title: { text: 'Providers and allowance guard bands', right: 'green < warning < amber < avoid < red' },
    panes: [
      { rect: { x: 0, y: 1, width, height: providerHeight }, title: 'Allowance windows', content: { kind: 'table', columns, rows, selection: false, empty: { message: 'no providers enabled', action: 'Configure a provider to see allowance' } } },
      { rect: { x: 0, y: 2 + providerHeight, width, height: Math.max(3, height - providerHeight - 3) }, title: 'Active writer ownership by cwd', content: { kind: 'log', lines: lockLines, follow: false, scroll: ui.providerScroll || 0, empty: { message: 'no active writer locks', action: 'Implement and verify jobs appear here' } } }
    ],
    status: errorStatus(ui) || { text: 'Esc fleet  Up/Dn scroll  p close  ? help  q quit' }
  };
  return commonOverlay(frame, ui, store);
}

function sessionColumns(width) {
  const columns = width >= 90 ? [
    { key: 'id', title: 'Session', width: 10, selectedStyle: palette.selectedId },
    { key: 'project', title: 'Project', width: 18 },
    { key: 'state', title: 'State', width: 8 },
    { key: 'age', title: 'Age', width: 8, align: 'right' },
    { key: 'jobs', title: 'Jobs', width: 6, align: 'right' },
    { key: 'writer', title: 'Writer', width: 11 },
    { key: 'activity', title: 'Last activity', width: Math.max(14, width - 61) }
  ] : [
    { key: 'id', title: 'Session', width: 10, selectedStyle: palette.selectedId },
    { key: 'project', title: 'Project', width: Math.max(9, width - 43) },
    { key: 'state', title: 'State', width: 8 },
    { key: 'jobs', title: 'Jobs', width: 6, align: 'right' },
    { key: 'writer', title: 'Writer', width: 10 }
  ];
  return columns;
}

export function sessionsViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const scan = store.sessionScan || { status: 'loading', available: null, scanned: 0, totalFiles: 0, capped: false };
  const now = nowOf(ui, store);
  const correlated = correlateSessions(store.sessions || [], store.jobs || [], store.writerLocks || [])
    .map((session) => ({ ...session, ...classifySession(session.mtimeMs, { now, activeSeconds: session.activeSeconds }) }))
    .sort((left, right) => Number(right.active) - Number(left.active)
      || Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0) || String(left.id).localeCompare(String(right.id)));
  const selected = Math.max(0, Math.min(correlated.length - 1, Number(ui.sessionSelection || 0)));
  const status = errorStatus(ui) || { text: 'Enter filter Fleet to cwd  Esc fleet/clear filter  S close  Up/Dn select  ? help  q quit' };
  if (scan.status === 'loading') {
    return commonOverlay({
      width, height, screen: 'sessions',
      title: { text: 'Claude coordinator sessions | best-effort overview', right: 'scanning' },
      panes: [{ rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) }, title: 'Sessions', content: { kind: 'empty', message: 'loading coordinator sessions', action: 'Scanning the Claude Code projects directory' } }],
      status,
      meta: { sessionIds: [], selectedSessionCwd: null, selected: 0 }
    }, ui, store);
  }
  if (!scan.available) {
    return commonOverlay({
      width, height, screen: 'sessions',
      title: { text: 'Claude coordinator sessions | best-effort overview', right: 'unavailable' },
      panes: [{ rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) }, title: 'Sessions unavailable; managed-job views remain fully available', content: { kind: 'empty', message: 'coordinator sessions unavailable', action: scan.error || 'Claude projects directory is missing or unreadable' } }],
      status,
      meta: { sessionIds: [], selectedSessionCwd: null, selected: 0 }
    }, ui, store);
  }
  if (!correlated.length) {
    return commonOverlay({
      width, height, screen: 'sessions',
      title: { text: 'Claude coordinator sessions | best-effort overview', right: '0 sessions' },
      panes: [{ rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) }, title: 'Sessions', content: { kind: 'empty', message: 'no coordinator sessions found', action: 'Start a Claude Code session to populate this view' } }],
      status,
      meta: { sessionIds: [], selectedSessionCwd: null, selected: 0 }
    }, ui, store);
  }
  const innerWidth = Math.max(1, width - 4);
  const columns = sessionColumns(innerWidth);
  const rowAt = (index) => {
    const session = correlated[index];
    if (!session) return null;
    const writer = session.writerJobId ? `W:${formatDisplayValue(session.writerJobId).slice(-6)}` : '-';
    const values = {
      id: formatDisplayValue(session.id).slice(0, 8),
      project: path.basename(formatDisplayValue(session.cwd)) || formatDisplayValue(session.cwd) || '-',
      state: { text: session.active ? 'active' : 'idle', style: session.active ? palette.running : palette.dim },
      age: duration(session.ageMs),
      jobs: { text: formatDisplayValue(session.activeDelegateJobs || 0), style: session.activeDelegateJobs ? palette.accent : palette.dim },
      writer: { text: writer, style: session.writerJobId ? palette.badgeWarn : palette.dim },
      activity: displayOr(session.lastActivity, '(unreadable)')
    };
    return { id: session.id, cells: columns.map((column) => values[column.key]) };
  };
  const selectedSession = correlated[selected];
  const tableHeight = Math.max(3, height - 6);
  const detailHeight = Math.max(3, height - tableHeight - 3);
  const cap = scan.capped ? `${CHROME_SEPARATOR}newest ${scan.scanned}/${scan.totalFiles}` : '';
  const frame = {
    width, height, screen: 'sessions',
    title: { text: 'Claude coordinator sessions | best-effort overview', right: `${correlated.length} sessions${cap}` },
    panes: [
      {
        rect: { x: 0, y: 1, width, height: tableHeight },
        title: 'Metadata and redacted tail labels only | no transcript viewing',
        content: { kind: 'table', columns, rows: [], rowCount: correlated.length, rowAt, selected, scroll: ui.sessionScroll || 0 }
      },
      {
        rect: { x: 0, y: 2 + tableHeight, width, height: Math.max(3, detailHeight - 1) },
        title: 'Selected project path',
        content: { kind: 'log', lines: [`${formatDisplayValue(selectedSession.cwd)}${CHROME_SEPARATOR}approx ${number(selectedSession.size)} bytes`], follow: false, scroll: 0 }
      }
    ],
    status,
    meta: {
      sessionIds: correlated.map((session) => session.id),
      sessionCwds: correlated.map((session) => session.cwd),
      selectedSessionCwd: selectedSession.cwd,
      selected
    }
  };
  return commonOverlay(frame, ui, store);
}

function statsModelName(model) {
  const value = formatDisplayValue(model || 'unknown');
  const codex = value.match(/^gpt-[\d.]+-(sol|terra|luna)$/i);
  if (codex) return codex[1].toLowerCase();
  if (/^composer(?:-|$)/i.test(value)) return 'composer';
  if (/^grok(?:-|$)/i.test(value)) return 'grok';
  return value;
}

function statsWindowMs(value) {
  const match = formatDisplayValue(value).trim().match(/^(\d+(?:\.\d+)?)([smhdw])$/i);
  if (!match) return null;
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2].toLowerCase()];
}

function attributedOutputMeans(store, now, since) {
  const window = statsWindowMs(since);
  const cutoff = window == null ? Number.NEGATIVE_INFINITY : now - window;
  const values = new Map();
  for (const entry of attributeAuditUsage(store.audit || [], store.jobs || [])) {
    if (entry.at < cutoff || entry.at > now) continue;
    const record = entry.record || {};
    const key = JSON.stringify([entry.provider || 'unknown', statsModelName(record.model), record.mode || 'unknown']);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(entry.own.output);
  }
  return new Map([...values].map(([key, outputs]) => [key, outputs.reduce((sum, value) => sum + value, 0) / outputs.length]));
}

export function statsViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const stats = store.stats || { since: '7d', jobs: 0, groups: [] };
  const outputMeans = attributedOutputMeans(store, nowOf(ui, store), stats.since || '7d');
  const columns = [
    { key: 'provider', title: 'Provider', width: 9 }, { key: 'model', title: 'Model', width: 14 },
    { key: 'mode', title: 'Mode', width: 10 }, { key: 'jobs', title: 'Jobs', width: 6, align: 'right' },
    { key: 'success', title: 'Success', width: 9, align: 'right' }, { key: 'resumedJobs', title: 'Resume', width: 7, align: 'right' },
    { key: 'nudgeCount', title: 'Nudge', width: 7, align: 'right' }, { key: 'duration', title: 'Mean ms', width: 10, align: 'right' },
    { key: 'tokens', title: 'Out tok', width: 9, align: 'right' }, { key: 'failures', title: 'B/T/V', width: Math.max(7, width - 83) }
  ];
  const query = formatDisplayValue(ui.statsFilter).toLocaleLowerCase();
  const filtered = (stats.groups || []).filter((row) => !query || formatDisplayValue(row).toLocaleLowerCase().includes(query));
  const rows = filtered.map((row) => ({
    ...row,
    success: `${Math.round((Number(row.successRate) || 0) * 100)}%`,
    duration: Math.round(Number(row.meanDurationMs) || 0),
    tokens: Math.round(Number(outputMeans.get(JSON.stringify([row.provider || 'unknown', row.model || 'unknown', row.mode || 'unknown']))
      ?? row.meanOutputTokens) || 0),
    failures: `${Math.round(Number(row.budgetCount) || 0)}/${Math.round(Number(row.timeoutCount) || 0)}/${Math.round(Number(row.violationCount) || 0)}`
  }));
  const frame = {
    width, height, screen: 'stats',
    title: { text: `Delegation stats | last ${displayOr(stats.since, '7d')}${query ? `${CHROME_SEPARATOR}/${formatDisplayValue(ui.statsFilter)}` : ''}`, right: `${rows.length}/${stats.groups?.length || 0} audit rows` },
    panes: [{ rect: { x: 0, y: 1, width, height: height - 2 }, title: 'Provider / normalized model / mode', content: { kind: 'table', columns, rows, selected: ui.statsSelection || 0, scroll: ui.statsScroll || 0, empty: { message: 'no audit rows in this window', action: 'N to launch a job' } } }],
    status: errorStatus(ui) || { text: 'Esc fleet  Up/Dn select  / filter loaded audit rows  default window: 7d  ? help  q quit' },
    meta: { visibleStatsCount: rows.length }
  };
  return commonOverlay(frame, ui, store);
}

const LAUNCH_FIELDS = Object.freeze([
  ['profile', 'Profile'], ['provider', 'Provider'], ['model', 'Model'], ['mode', 'Mode'],
  ['effort', 'Effort'], ['prompt', 'Packet body'], ['allowedPaths', 'Allowed paths'],
  ['verifyCommand', 'Verify command'], ['ingestFiles', 'Ingest files']
]);

export function routeAdvisorLines(route) {
  if (!route) return ['Calculating route advice...'];
  const candidate = (label, value) => {
    if (!value) return `${label}: none`;
    const band = value.usageBand;
    const exact = (input) => Number.isFinite(Number(input)) ? String(Math.round(Number(input))) : '-';
    const usage = band ? `${CHROME_SEPARATOR}p50 ${exact(band.p50OutputTokens)} / p90 ${exact(band.p90OutputTokens)} out (${exact(band.samples)})` : '';
    return `${label}: ${displayOr(value.provider, '-')}/${displayOr(value.model, '-')}${CHROME_SEPARATOR}score ${number(value.score)}${usage}`;
  };
  return [
    `${displayOr(route.kind, 'general')}${CHROME_SEPARATOR}${displayOr(route.mode, 'implement')}${CHROME_SEPARATOR}effort ${displayOr(route.effort, 'medium')}`,
    candidate('Primary', route.primary),
    candidate('Fallback', route.fallbacks?.[0]),
    displayOr(route.primary?.reason, 'Advisory only; dry-run admission remains authoritative.')
  ];
}

export function launcherViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const launcher = ui.launcher || {};
  const rows = LAUNCH_FIELDS.map(([key, label]) => ({ field: label, value: formatDisplayValue(launcher[key] ?? (key === 'profile' ? '<none>' : '')) }));
  const preview = launcher.preview;
  const warnings = preview?.packetWarnings || [];
  const previewLines = preview ? [
    `DRY RUN${CHROME_SEPARATOR}${displayOr(preview.provider, '-')}/${displayOr(preview.model, '-')}${CHROME_SEPARATOR}${displayOr(preview.mode, '-')}${CHROME_SEPARATOR}${displayOr(preview.effort, 'default')}${CHROME_SEPARATOR}${formatDisplayValue(preview.cwd)}`,
    ...(warnings.length ? warnings.map((warning) => `WARNING: ${formatDisplayValue(warning)}`) : ['Packet lint: clean']),
    '',
    ...formatDisplayValue(preview.packet).split('\n')
  ] : ['No preview yet.', '', 'Edit fields, then press d. Launch is disabled until the exact current form has a successful dry run.'];
  const wide = width >= 70;
  const topHeight = wide ? Math.min(13, Math.max(10, Math.floor(height * 0.48))) : Math.min(10, Math.max(7, Math.floor(height * 0.4)));
  const formWidth = wide ? Math.max(42, Math.floor((width - 1) * 0.58)) : width;
  const advisorRect = wide
    ? { x: formWidth + 1, y: 1, width: Math.max(3, width - formWidth - 1), height: topHeight }
    : { x: 0, y: 2 + topHeight, width, height: Math.min(5, Math.max(3, height - topHeight - 6)) };
  const previewY = wide ? 2 + topHeight : advisorRect.y + advisorRect.height + 1;
  const frame = {
    width, height, screen: 'launcher',
    title: { text: 'New managed job', right: preview ? 'preview ready | y launches' : 'dry run required' },
    panes: [
      { rect: { x: 0, y: 1, width: formWidth, height: topHeight }, title: `Launcher form${CHROME_SEPARATOR}profiles: ${(store.profiles || []).map(formatDisplayValue).filter(Boolean).join(', ') || 'none'}`, content: { kind: 'table', columns: [{ key: 'field', title: 'Field', width: 16 }, { key: 'value', title: 'Value', width: Math.max(10, formWidth - 18) }], rows, selected: launcher.fieldIndex || 0 } },
      { rect: { x: 0, y: previewY, width, height: Math.max(3, height - previewY - 1) }, title: 'Mandatory dry-run preview | exact provider packet', content: { kind: 'log', lines: previewLines, follow: false, scroll: launcher.previewScroll || 0 } },
      { rect: advisorRect, title: 'Route advisor | advisory only', content: { kind: 'log', lines: routeAdvisorLines(launcher.routeAdvice), follow: false, scroll: 0 } }
    ],
    status: errorStatus(ui) || { text: 'Esc fleet  Up/Dn field  Left/Right cycle  Enter edit  e $EDITOR body  d dry run  y launch preview  ? help  q quit' },
    meta: { fields: LAUNCH_FIELDS.map(([key]) => key), previewReady: Boolean(preview) }
  };
  return commonOverlay(frame, ui, store);
}

export function createViewModel(store, ui = {}, viewport = {}) {
  const effectiveUi = ui.remote || !store.remote ? ui : { ...ui, remote: store.remote };
  if (effectiveUi.screen === 'dashboard') return dashboardViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'detail') return detailViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'groups') return groupsViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'group-members') return groupMembersViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'providers') return providersViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'sessions') return sessionsViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'stats') return statsViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'launcher') return launcherViewModel(store, effectiveUi, viewport);
  return fleetViewModel(store, effectiveUi, viewport);
}

export function selectedFleetJobId(store, ui = {}, viewport = {}) {
  return fleetViewModel(store, ui, viewport).meta.selectedJobId;
}

export function nudgeEligible(job) {
  return Boolean(job && TERMINAL.has(job.status) && READ_MODES.has(job.mode) && job.resultSuspect);
}
