import path from 'node:path';
import { jobNeedsReconciliation } from '../control.mjs';
import { coalesceAuditRecords, outcomeRates } from '../stats.mjs';
import { projectJobsAsWorkItems } from '../work-projection.mjs';
import { deriveJobActivity } from './activity.mjs';
import { displayOr, formatDisplayValue, formatMultilineDisplayValue, formatTimestamp, joinDisplayParts } from './display.mjs';
import { prepareDiffWindow, formatDiffRow, wrapDiffRow } from './diff.mjs';
import { eventBlocks, eventCategory, formatEventBlock, wrapEventBlock } from './events.mjs';
import { CHROME_GLYPHS, CHROME_SEPARATOR, spinnerGlyph } from './glyphs.mjs';
import { actionMenuForContext, footerForContext, formatKeyNotation, helpPagesForContext, keymapContext, keyNotationSegments, KEYMAP } from './keymap.mjs';
import { uiPalette as palette } from './palette.mjs';
import { sectionGapForHeight, SPACE } from './rhythm.mjs';
import { classifySession, correlateSessions } from './sessions.mjs';
import { formatTranscriptBlock, transcriptAnomalyEntries, TranscriptProjector, wrapTranscriptBlock } from './transcript.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const READ_MODES = new Set(['consult', 'plan', 'review']);

export const DETAIL_TABS = Object.freeze(['Transcript', 'Diff', 'Record', 'Usage', 'Events', 'Chain']);
export const WORK_TABS = Object.freeze(['Compose', 'Review', 'Approve', 'Compare', 'Replay', 'Converge']);

export const HELP_ITEMS = Object.freeze(KEYMAP.map((item) => Object.freeze({
  key: formatKeyNotation(item),
  description: item.label
})));

function viewportOf(viewport = {}) {
  return { width: Math.max(20, Number(viewport.width || 80)), height: Math.max(8, Number(viewport.height || 24)) };
}

function nowOf(ui, store = null) {
  const local = Number(ui.now ?? store?.updatedAt ?? 0);
  const offset = Number(ui.remote?.clockOffsetMs ?? store?.remote?.clockOffsetMs ?? 0);
  return local + (Number.isFinite(offset) ? offset : 0);
}

function active(job) {
  return job.external !== true && job.transport !== 'external' && !TERMINAL.has(job.status);
}

export function effectiveJobRecord(job, nowMs = 0) {
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
  if (job.direct === true || ['direct-mcp', 'direct-cli', 'direct-acp'].includes(job.transport)) values.push('direct');
  if (job.external === true || job.transport === 'external') values.push('external');
  if (job.transport === 'claude-agent') values.push('agent');
  if (job.overlapsManagedWriter === true) values.push('writer!');
  if (job.resultSuspect) values.push('?');
  const violations = Array.isArray(job.scopeViolations) ? job.scopeViolations.length : Number(job.scopeViolations || 0);
  if (violations) values.push(`S${violations}`);
  if (job.largeWrite) values.push('L');
  if (job.reviewFlowEngaged) values.push('RF');
  return values.join(',') || '-';
}

function jobDirectory(job) {
  if (typeof job?.cwd !== 'string' || !job.cwd.trim()) return '-';
  return path.basename(job.cwd) || '-';
}

function jobEffort(job) {
  return typeof job?.effort === 'string' && job.effort.trim() ? job.effort.trim() : '-';
}

function fleetColumns(width, remote = null, density = 'wide') {
  const hostWidth = remote?.enabled ? 14 : 0;
  const changedWidth = 10;
  // Widths include the model column at its eight-cell minimum. Optional
  // columns are admitted only when their complete width fits, leaving the
  // single flexible model column to absorb positive slack.
  const wideBaseWidth = 102 + hostWidth;
  const compactBaseWidth = 50;
  const wide = density !== 'compact' && width >= 96 + hostWidth;
  const showHost = remote?.enabled && (wide || width >= compactBaseWidth + hostWidth);
  const showEffort = wide || width >= compactBaseWidth + (showHost ? hostWidth : 0) + 7;
  const showDirectory = wide || width >= compactBaseWidth + (showHost ? hostWidth : 0)
    + (showEffort ? 7 : 0) + 12;
  const showChanged = width >= (wide ? wideBaseWidth : compactBaseWidth
    + (showHost ? hostWidth : 0) + (showEffort ? 7 : 0) + (showDirectory ? 12 : 0)) + changedWidth;
  const columns = wide ? [
    { key: 'id', title: 'Job', width: 10, selectedStyle: palette.selectedId }, { key: 'provider', title: 'Provider', width: 8 },
    ...(remote?.enabled ? [{ key: 'host', title: 'Host', width: hostWidth }] : []),
    { key: 'dir', title: 'Directory', width: 12 }, { key: 'model', title: 'Model', width: 8, flexible: true },
    { key: 'effort', title: 'Effort', width: 7 }, { key: 'mode', title: 'Mode', width: 7 },
    { key: 'activity', title: 'Activity', width: 10 },
    ...(showChanged ? [{ key: 'changed', title: 'Changed', width: changedWidth }] : []),
    { key: 'elapsed', title: 'Elapsed', width: 7, align: 'right' }, { key: 'tokens', title: 'Out/budget', width: 10, align: 'right' },
    { key: 'chain', title: 'Chain', width: 8 }, { key: 'badges', title: 'Badges', width: 15 }
  ] : [
    { key: 'id', title: 'Job', width: 9, selectedStyle: palette.selectedId }, { key: 'provider', title: 'Provider', width: 8 },
    ...(showHost ? [{ key: 'host', title: 'Host', width: hostWidth }] : []),
    ...(showDirectory ? [{ key: 'dir', title: 'Directory', width: 12 }] : []),
    { key: 'model', title: 'Model', width: 8, flexible: true },
    ...(showEffort ? [{ key: 'effort', title: 'Effort', width: 7 }] : []),
    { key: 'activity', title: 'Activity', width: 13 },
    ...(showChanged ? [{ key: 'changed', title: 'Changed', width: changedWidth }] : []),
    { key: 'badges', title: 'Badges', width: 12 }
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

function breadcrumbs(frame, ui) {
  if (frame.screen === 'detail') return [ui.detailReturn === 'dashboard' ? 'home' : 'fleet', formatDisplayValue(frame.meta?.jobId).slice(-12)];
  if (frame.screen === 'group-members') return ['groups', formatDisplayValue(ui.groupId).slice(-12)];
  if (frame.screen === 'work') return ['work', formatDisplayValue(frame.meta?.workId).slice(-12)];
  return [frame.screen === 'dashboard' ? 'home' : frame.screen];
}

function paneItemCount(content = {}) {
  if (content.kind === 'table') return Math.max(0, Number(content.rowCount ?? content.rows?.length ?? 0));
  if (content.kind === 'key-value') return (content.sections || []).reduce((total, section) => total + (section.rows?.length || 0), 0);
  if (content.virtual || content.kind === 'rail' || content.kind === 'diff') return content.entries?.length || 0;
  if (content.kind === 'log' || content.kind === 'text') return content.lines?.length || 0;
  return 0;
}

function defaultPaneSummary(pane = {}) {
  const content = pane.content || {};
  const count = paneItemCount(content);
  const noun = content.kind === 'table' ? 'rows'
    : content.kind === 'key-value' ? 'fields'
      : content.kind === 'rail' ? 'blocks'
        : content.kind === 'diff' ? 'diff rows'
          : 'lines';
  const badges = content.kind === 'key-value'
    ? (content.sections || []).filter((section) => section.badge).length
    : 0;
  return { text: joinDisplayParts([`${count} ${noun}`, badges ? `${badges} unusual` : '']) };
}

export function applyHeightPressure(panes = [], rows = 0, contentBottom = Number.MAX_SAFE_INTEGER) {
  const desiredGap = sectionGapForHeight(rows);
  if (desiredGap === SPACE.section || panes.length < 2) return panes.map((pane) => ({ ...pane, rect: { ...pane.rect } }));
  const bands = new Map();
  for (let index = 0; index < panes.length; index += 1) {
    const pane = panes[index];
    const y = Number(pane.rect?.y || 0);
    if (!bands.has(y)) bands.set(y, []);
    bands.get(y).push({ pane, index });
  }
  const ordered = [...bands.entries()].sort(([left], [right]) => left - right);
  let removed = SPACE.none;
  let previousBottom = null;
  const adjusted = [];
  for (const [originalY, band] of ordered) {
    let y = originalY - removed;
    if (previousBottom != null) {
      const gap = Math.max(SPACE.none, y - previousBottom);
      const reclaim = Math.min(SPACE.section - desiredGap, Math.max(SPACE.none, gap - desiredGap));
      removed += reclaim;
      y -= reclaim;
    }
    for (const { pane, index } of band) adjusted.push({ pane: { ...pane, rect: { ...pane.rect, y } }, index });
    previousBottom = Math.max(...band.map(({ pane }) => y + Number(pane.rect?.height || 0)));
  }
  if (removed > SPACE.none) {
    const lastY = Math.max(...adjusted.map(({ pane }) => pane.rect.y));
    for (const { pane } of adjusted) {
      if (pane.rect.y !== lastY) continue;
      pane.rect.height = Math.max(SPACE.none, Math.min(
        Number(pane.rect.height || 0) + removed,
        Number(contentBottom) - pane.rect.y
      ));
    }
  }
  return adjusted.sort((left, right) => left.index - right.index).map(({ pane }) => pane);
}

function commonOverlay(frame, ui, store = null) {
  if (frame.screen !== 'dashboard') {
    frame.panes = (frame.panes || []).map((pane) => ({
      ...pane,
      summary: pane.summary || defaultPaneSummary(pane)
    }));
  }
  const remote = ui.remote;
  if (remote?.enabled) {
    const connection = remote.connection || { status: 'connecting', attempt: 0 };
    frame.title.text = `[${remote.federation ? 'fleet' : 'remote'}] ${frame.title.text}`;
    frame.title.right = joinDisplayParts([remote.federation ? `${remote.hosts?.length || 0} hosts` : remote.host || 'unknown host', frame.title.right]);
    const retry = connection.status === 'connected' ? '' : connection.attempt ? `#${connection.attempt}` : '';
    const connectionText = `remote:${connection.status}${retry}`;
    if (frame.status?.segments) {
      frame.status.segments.unshift({ text: `${connectionText} `, style: connection.status === 'connected' ? palette.positive : palette.failed });
    } else if (frame.status) {
      frame.status.text = `${connectionText}${CHROME_SEPARATOR}${frame.status.text || ''}`;
    }
  }
  const notify = ui.notifyEnabled === false ? 'notify:off' : 'notify:on';
  if (frame.status) frame.status.right = [remote?.enabled && !remote?.includeLocal ? 'read-only remote' : '', notify, frame.status.right || '']
    .filter(Boolean).join(CHROME_SEPARATOR);
  const suppliedVersion = formatDisplayValue(ui.version).trim().replace(/^v/i, '');
  const version = suppliedVersion ? `v${suppliedVersion}` : 'v?';
  const hostCenter = `${ui.remote?.federation ? `${ui.remote.hosts?.length || 0} hosts` : ui.remote?.host || ui.hostLabel || 'local'}${CHROME_SEPARATOR}${version}`;
  const hostChips = (store?.remote?.hosts || []).map((host) => ({
    text: `${formatDisplayValue(host.label)} ${host.connection?.status || 'connecting'}`,
    style: host.connection?.status === 'connected' ? palette.positive
      : host.connection?.status === 'connecting' ? palette.badgeWarn : palette.failed
  }));
  frame.appBar = {
    product: 'delegate',
    breadcrumb: breadcrumbs(frame, ui),
    center: frame.headerActivity?.text || hostCenter,
    centerSegments: frame.headerActivity?.segments || null,
    centerStyle: frame.headerActivity?.style || palette.dim,
    chips: [...(store?.providers || []).filter((provider) => provider.name !== 'claude' || provider.allowance?.known).map((provider) => {
      const band = providerBand(provider);
      const burn = Number(provider.unattributedBurn?.latest?.amountPercent || 0);
      return { text: `${formatDisplayValue(provider.name)} ${band.label}${burn > 0 ? ` ~${burn.toFixed(1)}pp outside tracked` : ''}`, style: band.style };
    }), ...hostChips]
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
    // Preserve a usable three-row pane (title, content, and bottom padding) by
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
    frame.panes = applyHeightPressure(
      shifted.map(({ requestedHeight: _requestedHeight, ...pane }) => pane),
      frame.height,
      contentBottom
    );
    if (frame.tabs) frame.tabs = { ...frame.tabs, rect: { ...frame.tabs.rect, y: Number(frame.tabs.rect?.y || 0) + 1 } };
    frame.meta = { ...(frame.meta || {}), appBarSpaced: true };
  }
  const context = keymapContext(frame, ui, store);
  if (frame.status) {
    const footer = footerForContext(context, frame.width);
    frame.status.rightHints = footer.right;
    if (!frame.status.segments && !ui.status) {
      frame.status.text = '';
      frame.status.hints = footer.groups;
    }
  }
  frame.focusedPane = Number(ui.focusedPane || 0);
  if (ui.help) {
    const pages = helpPagesForContext(context);
    frame.overlay = {
      kind: 'help',
      title: 'DELEGATE KEYS',
      pages,
      page: Math.max(0, Math.min(pages.length - 1, Number(ui.helpPage || 0)))
    };
  } else if (ui.actionMenu) {
    const items = actionMenuForContext(context, ui.actionMenu.query);
    frame.overlay = {
      kind: 'actions',
      title: 'Actions',
      items,
      query: ui.actionMenu.query || '',
      filtering: ui.actionMenu.filtering === true,
      selected: Math.max(0, Math.min(items.length - 1, Number(ui.actionMenu.selection || 0))),
      hint: ui.actionMenu.hint || ''
    };
  } else if (ui.gPrefixHelp) {
    frame.overlay = {
      kind: 'prefix',
      title: 'g: go to',
      items: KEYMAP.filter((item) => item.relation === 'sequence' && item.keys[0] === 'g')
        .map((item) => ({ keys: keyNotationSegments(item), label: item.label }))
    };
  }
  else if (ui.statusHistoryOpen) {
    const rows = (ui.statusHistory || []).slice(-20).flatMap((entry) => formatMultilineDisplayValue(entry.message).split('\n').map((line, index) => {
      const notation = index === 0 ? formatTimestamp(entry.at, { mode: ui.timestampMode, now: ui.now }) : '';
      return {
        action: 'diagnostic.status-history',
        class: 'diagnostic',
        scope: ['global'],
        keys: notation ? [{ text: notation, kind: 'key' }] : [],
        notation,
        relation: 'single',
        label: `${index === 0 && entry.stream ? `[${entry.stream}] ` : ''}${line}`
      };
    }));
    const pages = [];
    for (let offset = 0; offset < rows.length || (!offset && !rows.length); offset += 14) {
      pages.push({
        label: rows.length > 14 ? `messages ${Math.floor(offset / 14) + 1}/${Math.ceil(rows.length / 14)}` : 'messages',
        scope: 'NEWEST LAST',
        rows: rows.slice(offset, offset + 14)
      });
      if (!rows.length) break;
    }
    frame.overlay = {
      kind: 'help',
      title: 'STATUS HISTORY',
      width: 90,
      keyWidth: 13,
      pages,
      page: Math.max(0, Math.min(pages.length - 1, Number(ui.statusHistoryPage || 0)))
    };
  }
  else if (ui.confirm) frame.overlay = { kind: 'confirm', ...ui.confirm };
  else if (ui.input) frame.overlay = { kind: 'input', ...ui.input };
  return frame;
}

function errorStatus(ui) {
  if (!ui.status) return null;
  return {
    segments: [{ text: formatDisplayValue(ui.status), style: ui.statusKind === 'error' ? palette.failed : palette.info }],
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

export const ANIMATED_ACTIVITY_KINDS = Object.freeze(new Set(['working', 'tool', 'subagent', 'thinking', 'streaming', 'compacting', 'verifying', 'retrying', 'starting']));

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
  return coalesceAuditRecords(records);
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
    else if (Number(record.nudgeCount || 0)) { label = `nudged x${Number(record.nudgeCount)}`; style = palette.info; }
    rows.push({ jobId: record.jobId, at: Number(record.at || 0), label, style, provider: record.provider || '-' });
  }
  const seenEvents = new Set();
  for (const events of Object.values(store.activityEventsByJob || {})) {
    for (const event of events || []) {
      if (!NOTABLE_EVENTS.has(event.type) && !/retry|budget|nudge/.test(formatDisplayValue(event.type))) continue;
      const key = `${event.jobId}:${event.seq}:${event.type}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      rows.push({ jobId: event.jobId, at: Number(event.at || 0), label: formatDisplayValue(event.type).replaceAll('.', ' '), style: /violation|budget/.test(event.type) ? palette.badgeWarn : palette.metadata, provider: '' });
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
  const todayRates = outcomeRates(today);
  const providerCompletion = todayRates.providerCompletion;
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
    {
      value: `${today.length}  ${providerCompletion.status === 'measured' ? `${Math.round(providerCompletion.rate * 100)}%` : `insuf n=${providerCompletion.sampleSize}`}`,
      label: 'jobs / provider done',
      trend: jobsTrend
    },
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
    content: { kind: 'table', columns: [{ key: 'marker', title: '', width: 3 }, { key: 'job', title: 'Job', width: 12 }, { key: 'need', title: 'Attention', width: Math.max(18, Math.floor(width * 0.36)) }, { key: 'context', title: 'Context', width: Math.max(12, width - Math.max(18, Math.floor(width * 0.36)) - 25) }, { key: 'age', title: 'Age', width: 8, align: 'right' }], rows: attentionRows, selected: attentionSelection, empty: { message: 'nothing needs you', action: 'g l to launch a job' } }
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
    content: { kind: 'table', columns: [{ key: 'time', title: 'When', width: 11 }, { key: 'job', title: 'Job', width: 12 }, { key: 'event', title: 'Event', width: Math.max(18, width - 36) }, { key: 'provider', title: 'Provider', width: 10 }], rows: feedRows, selected: feedSelection, empty: { message: 'no recent activity', action: 'g l to launch a job or F to open Fleet' } }
  });
  const frame = {
    width, height, screen: 'dashboard', title: { text: 'Delegate dashboard', right: `${jobs.length} jobs` }, panes,
    status: errorStatus(ui) || { text: '' },
    meta: {
      attentionJobIds: attention.map((entry) => entry.job.id), feedJobIds: feed.map((entry) => entry.jobId),
      selectedJobId: Number(ui.dashboardFocus || 0) === 1 ? feed[feedSelection]?.jobId || null : attention[attentionSelection]?.job.id || null,
      attentionSelection, feedSelection, dashboardFocus: Number(ui.dashboardFocus || 0) === 1 ? 1 : 0,
      trends: { jobs: days.map((day) => day.count), duration: days.map((day) => day.duration) },
      todayUsage,
      meanCacheHit,
      todayJobs: today.length,
      todayProviderCompletion: providerCompletion
    }
  };
  return commonOverlay(frame, ui, store);
}

export function fleetViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const now = nowOf(ui, store);
  const query = formatDisplayValue(ui.filter).toLowerCase();
  const sessionCwd = ui.sessionCwdFilter ? path.resolve(formatDisplayValue(ui.sessionCwdFilter)) : null;
  const sessionJobIds = Array.isArray(ui.sessionJobIds) ? new Set(ui.sessionJobIds) : null;
  const sort = ['activity', 'recency', 'provider', 'tokens'].includes(ui.fleetSort) ? ui.fleetSort : 'recency';
  const activityRank = { approval: 10, 'needs-input': 9, stalled: 8, compacting: 7, tool: 6, thinking: 5, streaming: 4, retrying: 3, verifying: 2, quiet: 1 };
  const entries = (store.jobs || []).map((raw) => {
    const job = effectiveJobRecord(raw, now);
    const usage = jobUsage(job, store.eventsByJob?.[job.id]);
    const activity = deriveJobActivity(job, activityEvents(store, job), { now });
    return { raw, job, usage, activity };
  })
    .filter(({ job }) => (!sessionJobIds || sessionJobIds.has(job.id))
      && (!sessionCwd || (job.cwd && path.resolve(formatDisplayValue(job.cwd)) === sessionCwd))
      && (!ui.groupId || job.groupId === ui.groupId)
      && (ui.showExternals !== false || !job.external)
      && (!ui.activeOnly || active(job))
      && (!query || [job.id, job.resolvedModel || job.model, job.cwd, job.host, job.activityLabel].some((value) => formatDisplayValue(value).toLowerCase().includes(query))))
    .sort((left, right) => Number(active(right.job)) - Number(active(left.job)) || (() => {
      if (sort === 'provider') return formatDisplayValue(left.job.provider).localeCompare(formatDisplayValue(right.job.provider));
      if (sort === 'tokens') return right.usage.output - left.usage.output;
      if (sort === 'activity') return Number(activityRank[right.activity.kind] || 0) - Number(activityRank[left.activity.kind] || 0)
        || Number(right.activity.since || 0) - Number(left.activity.since || 0);
      return Number(right.job.lastActivityAt || right.job.updatedAt * 1000 || 0) - Number(left.job.lastActivityAt || left.job.updatedAt * 1000 || 0);
    })() || formatDisplayValue(left.job.id).localeCompare(formatDisplayValue(right.job.id)));
  const selected = Math.max(0, Math.min(entries.length - 1, Number(ui.selectedIndex || 0)));
  // Pane padding permanently reserves one margin cell before the scrollbar,
  // leaving a single owner for the edge column.
  const innerWidth = Math.max(1, width - 4);
  const columns = fleetColumns(innerWidth, ui.remote, ui.fleetDensity);
  const rows = entries.map(({ job, usage, activity }) => {
    const max = Number(job.maxOutputTokens);
    const tokens = max > 0 ? `${number(usage.output)}/${number(max)} ${Math.round((usage.output / max) * 100)}%` : number(usage.output);
    const values = {
      id: shortId(job),
      provider: displayOr(job.provider, '-'),
      host: displayOr(job.host || ui.remote?.host, '-'),
      dir: jobDirectory(job),
      model: displayOr(job.resolvedModel || job.model || job.requestedModel, 'auto'),
      effort: jobEffort(job),
      mode: displayOr(job.mode, '-'),
      activity: activityIndicator(activity, now),
      changed: formatTimestamp(job.lastActivityAt || job.updatedAt * 1000, { mode: ui.timestampMode, now }) || '-',
      elapsed: duration(((job.completedAt ? job.completedAt * 1000 : now) - (job.createdAt || 0) * 1000)),
      tokens,
      chain: job.rootJobId ? `>${formatDisplayValue(job.rootJobId).slice(-6)}` : job.groupId ? `G:${formatDisplayValue(job.groupId).slice(0, 7)}` : '-',
      badges: badgeCell(job)
    };
    return {
      id: job.id,
      reconciliationPending: job.reconciliationPending === true,
      ...(job.external ? { style: palette.dim } : {}),
      cells: columns.map((column) => values[column.key])
    };
  });
  const visibleRows = Math.max(0, height - 5);
  const requestedScroll = Math.max(0, Number(ui.scroll || 0));
  const scroll = Math.max(0, Math.min(
    Math.max(requestedScroll, selected >= requestedScroll + visibleRows ? selected - visibleRows + 1 : requestedScroll),
    Math.max(0, entries.length - visibleRows)
  ));
  const jobsById = new Map(entries.map(({ job }) => [job.id, job]));
  const reconcileJobIds = rows.slice(scroll, scroll + visibleRows)
    .filter((row) => row.reconciliationPending && !jobsById.get(row.id)?.readOnly)
    .map((row) => row.id);
  const locks = store.writerLocks?.length ? `writers:${store.writerLocks.length}` : 'writers:0';
  const statusOverride = errorStatus(ui);
  const frame = {
    width, height, screen: ui.groupId ? 'group-members' : 'fleet',
    title: { text: `${ui.groupId ? `Group ${formatDisplayValue(ui.groupId)}` : 'Delegate fleet'}${sessionCwd ? `${CHROME_SEPARATOR}session:${path.basename(sessionCwd)} active` : ''}${ui.activeOnly ? `${CHROME_SEPARATOR}active` : ''}${ui.showExternals === false ? `${CHROME_SEPARATOR}externals:off` : ''}${ui.filter ? `${CHROME_SEPARATOR}/${formatDisplayValue(ui.filter)}` : ''}`, right: `${entries.length} jobs` },
    panes: [{
      rect: { x: 0, y: 1, width, height: Math.max(3, height - 2) },
      title: store.error ? `Store warning: ${formatDisplayValue(store.error)}` : 'Delegation jobs',
      content: { kind: 'table', columns, rows, selected, scroll: ui.scroll || 0, empty: { message: 'no jobs match the filter', action: 'g l to launch a job' } }
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
      content: { kind: 'table', columns, rows, selected, scroll: ui.groupScroll || 0, empty: { message: 'no job groups yet', action: 'g l to launch a grouped job' } }
    }],
    status: errorStatus(ui) || { text: '' },
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

export function lineStyleForEvent(event) {
  if (event.type === 'error' || event.type === 'scope.violation') return palette.failed;
  if (event.type?.startsWith('message.')) return palette.body;
  if (event.type?.startsWith('tool.')) {
    if (/(?:failed|error|denied)$/.test(event.type)) return palette.failed;
    return palette.body;
  }
  return palette.dim;
}

export function diffLineStyle(value) {
  const line = formatDisplayValue(value);
  if (line.startsWith('@@')) return palette.hunk;
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) return palette.diffHeader;
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

export function transcriptLineStyle(block, fragment) {
  const kind = fragment?.lineKind || '';
  if (kind === 'body' || kind === 'gap') return palette.body;
  if (kind === 'file-change') return palette.body;
  if (kind === 'message-header') return block.role === 'user' ? palette.header : palette.metadata;
  if (kind === 'tool-failed' || kind === 'notice-error' || kind === 'plan-failed') return palette.failed;
  if (kind === 'notice-warning') return palette.badgeWarn;
  if (kind === 'tool-running' || kind === 'compaction-active') return palette.body;
  if (kind === 'compaction-complete') return palette.dim;
  if (kind === 'plan-complete') return palette.dim;
  if (kind === 'plan-active') return palette.body;
  if (kind === 'plan-pending') return palette.planPending;
  if (kind === 'meta' || kind === 'notice') return palette.dim;
  return palette.body;
}

function derivedResumable(job) {
  if (job.resumable) return job.resumable;
  if (job.readOnly || ['external', 'claude-agent'].includes(job.transport)) return { ok: false, reason: 'read-only observed job' };
  if (['direct-mcp', 'direct-cli', 'direct-acp'].includes(job.transport)) return { ok: false, reason: 'direct-transport job' };
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

function changedFileCount(job) {
  const value = Number(job?.changedFiles?.count
    ?? job?.changedFiles?.files?.length
    ?? job?.changedFiles?.entries?.length
    ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function changedFileCountLabel(job) {
  const count = changedFileCount(job);
  return `${job?.changedFiles?.countIsLowerBound === true ? 'at least ' : ''}${count}`;
}

function compactFieldValue(value) {
  if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.every((entry) => entry == null || ['string', 'number', 'boolean'].includes(typeof entry))) {
      return value.map((entry) => formatDisplayValue(entry)).filter(Boolean).join(', ') || null;
    }
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return null;
  }
  return typeof value === 'object'
    ? formatDisplayValue(value, { maxLength: 16_384 })
    : value;
}

function objectRows(prefix, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ key: prefix, value: compactFieldValue(value) }];
  const entries = Object.entries(value);
  if (!entries.length) return [{ key: prefix, value: null }];
  return entries.map(([key, entry]) => ({
    key: `${prefix} ${key}`,
    value: compactFieldValue(entry)
  }));
}

function verificationEvidenceRows(job) {
  const chain = Array.isArray(job?.verificationEvidence) && job.verificationEvidence.length
    ? job.verificationEvidence
    : job?.verification ? [job.verification] : [];
  return chain.map((entry, index) => {
    const input = entry?.completedInput || entry?.input || {};
    return {
      key: `verification evidence ${index + 1}`,
      value: compactFieldValue({
        state: entry?.state,
        kind: entry?.evidenceKind || (index === 0 ? 'original' : 'recorded'),
        exitCode: entry?.exitCode,
        revision: input.revision,
        digest: input.digest,
        treeMovedSinceOriginal: entry?.treeMovedSinceOriginal,
        treeMovedSincePrevious: entry?.treeMovedSincePrevious
      })
    };
  });
}

function scopeViolationCount(job) {
  return Array.isArray(job.scopeViolations) ? job.scopeViolations.length : Math.max(0, Number(job.scopeViolations || 0));
}

function verificationFailed(job) {
  const verification = job.verification || {};
  const exitCode = Number(verification.exitCode ?? verification.exit_code);
  return verification.passed === false
    || verification.ok === false
    || (Number.isFinite(exitCode) && exitCode !== 0)
    || /fail|error|blocked/i.test(formatDisplayValue(verification.status));
}

function acceptanceBlocked(job) {
  const acceptance = job.acceptance;
  return acceptance?.blocked === true
    || acceptance?.accepted === false
    || /blocked|failed|rejected|missing/i.test(formatDisplayValue(acceptance));
}

function driftCount(job) {
  const drift = derivedDrift(job);
  return [...(drift.modified || []), ...(drift.newFiles || []), ...(drift.outsideScope || [])].length;
}

export function recordSections(job) {
  const drift = derivedDrift(job);
  const resumable = derivedResumable(job);
  const violations = scopeViolationCount(job);
  const verifyFailed = verificationFailed(job);
  const blocked = acceptanceBlocked(job) || job.objectiveMet === false;
  const drifted = driftCount(job);
  return [
    {
      label: 'State',
      ...(job.status === 'failed' || job.error ? { badge: { text: 'FAILED', style: palette.failed } }
        : blocked ? { badge: { text: 'ACCEPTANCE BLOCKED', style: palette.badgeWarn } } : {}),
      rows: [
        { key: 'status', value: job.status },
        { key: 'phase', value: job.phase },
        { key: 'checkpoint', value: job.checkpoint, copy: true },
        { key: 'objectiveMet', value: job.objectiveMet },
        { key: 'error', value: job.error },
        { key: 'errorCode', value: job.errorCode },
        ...(job.displayReconciled ? [{
          key: 'reconciled',
          value: job.reconciliationPending
            ? `displaying ${formatDisplayValue(job.reconciledFrom)} as failed; durable record update pending`
            : `stale ${formatDisplayValue(job.reconciledFrom)} record persisted as failed by this TUI`,
          style: palette.dim
        }] : [])
      ]
    },
    ...(job.planPass || job.planning ? [{
      label: 'Planning',
      ...(job.planPass?.state === 'degraded'
        ? { badge: { text: 'PLAN DEGRADED', style: palette.badgeWarn } }
        : {}),
      rows: [
        ...objectRows('planPass', job.planPass),
        ...objectRows('planning', job.planning)
      ]
    }] : []),
    {
      label: 'Verification',
      ...(verifyFailed ? { badge: { text: 'VERIFY FAILED', style: palette.failed } }
        : acceptanceBlocked(job) ? { badge: { text: 'ACCEPTANCE BLOCKED', style: palette.badgeWarn } } : {}),
      rows: [
        { key: 'verificationProfile', value: job.verificationProfile },
        { key: 'verificationOrigin', value: job.verificationOrigin },
        ...objectRows('verification', job.verification),
        ...verificationEvidenceRows(job),
        ...objectRows('acceptance', job.acceptance)
      ]
    },
    {
      label: 'Scope and drift',
      ...(violations ? { badge: { text: `SCOPE ${violations}`, style: palette.failed } }
        : drifted ? { badge: { text: `DRIFT ${drifted}`, style: palette.badgeWarn } } : {}),
      rows: [
        ...objectRows('driftReport', drift),
        { key: 'scopeViolations', value: compactFieldValue(job.scopeViolations) }
      ]
    },
    {
      label: 'Continuation',
      rows: [
        ...objectRows('resumable', resumable),
        { key: 'transport', value: job.transport },
        { key: 'coordinatorSessionId', value: job.coordinatorSessionId, copy: true },
        { key: 'agentType', value: job.agentType }
      ]
    },
    {
      label: 'Origin',
      rows: [
        ...objectRows('origin', job.origin),
        { key: 'cwd', value: job.cwd, copy: true },
        { key: 'promptSummary', value: job.promptSummary },
        { key: 'approximateSize', value: job.approximateSizeLabel || job.approximateSize },
        { key: 'activityLabel', value: job.activityLabel }
      ]
    }
  ];
}

function usageContent(job, store) {
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
  const budgetExceeded = max > 0 && current.output >= max;
  return {
    summary: {
      text: joinDisplayParts([
        `${number(current.total)} current tokens`,
        `${chain.length} chain job${chain.length === 1 ? '' : 's'}`,
        max > 0 ? `${number(current.output)}/${number(max)} output` : 'no output budget'
      ]),
      ...(budgetExceeded ? { badge: { text: 'BUDGET EXCEEDED', style: palette.failed } } : {})
    },
    sections: [
      {
        label: 'Current',
        ...(budgetExceeded ? { badge: { text: 'BUDGET EXCEEDED', style: palette.failed } } : {}),
        rows: [
          { key: 'inputTokens', value: number(current.input) },
          { key: 'cachedInput', value: `${number(current.cached)} (${cachedPercent}%)` },
          { key: 'outputTokens', value: number(current.output) },
          { key: 'totalTokens', value: number(current.total) },
          {
            key: 'outputBudget',
            value: max > 0 ? `${number(current.output)} / ${number(max)}  [${budgetBar}]` : null
          }
        ]
      },
      {
        label: 'Continuation chain',
        rows: [
          { key: 'chainRoot', value: formatDisplayValue(chain[0]?.id || job.id), copy: true },
          { key: 'observedJobs', value: chain.length },
          { key: 'chainInput', value: number(cumulative.input) },
          { key: 'chainOutput', value: number(cumulative.output) },
          { key: 'chainTotal', value: number(cumulative.total) }
        ]
      }
    ]
  };
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
  const sections = chain.jobs.map((round, index) => {
    const markers = [];
    if (round.objectiveMet != null) markers.push(`objective:${formatDisplayValue(round.objectiveMet)}`);
    if (round.resultSuspect) markers.push(`suspect:${formatDisplayValue(round.resultSuspect)}`);
    const outcome = displayOr(round.resultText || round.result?.text || round.result || round.error, '-').split(/\r?\n/, 1)[0];
    const verifyExit = round.verification?.exitCode;
    const failed = round.status === 'failed' || (verifyExit != null && Number(verifyExit) !== 0);
    const blocked = round.resultSuspect || round.objectiveMet === false;
    return {
      label: `Round ${index + 1} ${shortId(round)}`,
      ...(failed ? { badge: { text: 'FAILED', style: palette.failed } }
        : blocked ? { badge: { text: 'BLOCKED', style: palette.badgeWarn } } : {}),
      rows: [
        { key: 'mode', value: round.mode },
        { key: 'status', value: round.status },
        { key: 'files', value: changedFileCountLabel(round) },
        { key: 'verifyExit', value: verifyExit },
        { key: 'objectiveMet', value: round.objectiveMet },
        { key: 'resultMarker', value: markers.join(', ') || null, style: blocked ? palette.badgeWarn : palette.dim },
        { key: 'outcome', value: outcome }
      ]
    };
  });
  const unusual = sections.filter((section) => section.badge).length;
  return {
    title: `Chain${CHROME_SEPARATOR}${chain.jobs.length} rounds`,
    summary: {
      text: joinDisplayParts([
        `${chain.jobs.length} rounds`,
        `${chain.jobs.some((round) => round.changedFiles?.countIsLowerBound === true) ? 'at least ' : ''}${chain.jobs.reduce((total, round) => total + changedFileCount(round), 0)} files`,
        unusual ? `${unusual} unusual` : ''
      ])
    },
    content: {
      kind: 'key-value',
      sections,
      selectedSection: ui.chainSelection || 0,
      scroll: ui.detailScroll || 0,
      sectionGap: sectionGapForHeight(ui.viewportHeight)
    },
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
      : job.transport === 'claude-agent' && hydration?.transcriptMissing
        ? { kind: 'empty', message: 'subagent transcript not found (yet) \u2014 background agents link once the file appears; reopen to retry' }
      : { kind: 'empty', message: 'no transcript entries', action: 'Live output will appear here when the worker writes it' };
  if (tab === 0) {
    const projector = transcriptProjector(job.id);
    const entries = projector.project(events, {
      expandedTools: ui.expandedTools,
      jobCwd: job.cwd,
      now: nowOf(ui, store),
      jobTerminal: TERMINAL.has(job.status),
      timestampMode: ui.timestampMode,
      thinking: activity.kind === 'thinking',
      thinkingSince: activity.since,
      thinkingSeq: activity.sourceSeq
    });
    const anomalyEntries = transcriptAnomalyEntries(entries);
    const tools = entries.filter((entry) => entry.kind === 'tool');
    const agents = tools.filter((entry) => entry.tool?.category === 'subagent');
    const displayedEntries = ui.transcriptAnomaliesOnly
      ? anomalyEntries
      : ui.transcriptKindFilter === 'tools'
        ? tools
        : ui.transcriptKindFilter === 'subagents' ? agents : entries;
    const transcriptFilterLabel = ui.transcriptAnomaliesOnly
      ? 'anomalies only'
      : ui.transcriptKindFilter === 'tools'
        ? 'tools only'
        : ui.transcriptKindFilter === 'subagents' ? 'subagents only' : '';
    const anomalies = anomalyEntries.length;
    return {
      title: `Transcript${transcriptFilterLabel ? `${CHROME_SEPARATOR}${transcriptFilterLabel}` : ''}${CHROME_SEPARATOR}follow ${ui.follow === false ? 'off' : 'on'}${CHROME_SEPARATOR}time:${ui.timestampMode === 'relative' ? 'relative' : 'absolute'}${historyState}${searchSuffix(ui, 'transcript')}`,
      summary: {
        text: joinDisplayParts([
          `${entries.length} blocks`,
          `${tools.length} tools`,
          `${agents.length} subagents`,
          anomalies ? `${anomalies} anomalies` : ''
        ]),
        ...(anomalies ? { badge: { text: `${anomalies} ANOMALIES`, style: palette.failed } } : {})
      },
      loading: hydration?.loading === true,
      loadingGlyph: spinnerGlyph(nowOf(ui, store)),
      content: displayedEntries.length ? {
        kind: 'rail', virtual: true, entries: displayedEntries, formatEntry: formatTranscriptBlock, wrapEntry: wrapTranscriptBlock, styleLine: transcriptLineStyle,
        measureKey: `transcript:${job.id}:${ui.transcriptAnomaliesOnly ? 'anomalies' : ui.transcriptKindFilter || 'all'}`,
        follow: ui.follow !== false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'transcript'),
        selectedEntry: ui.follow !== false
          ? displayedEntries.length - 1
          : Math.max(0, Math.min(displayedEntries.length - 1, Number(ui.transcriptSelection ?? ui.detailScroll?.entry ?? ui.detailScroll ?? 0)))
      } : emptyHistory,
      scrollItemCount: displayedEntries.length,
      projectionMetrics: projector.lastMetrics,
      anomalyCount: anomalies,
      anomalyEntryKeys: anomalyEntries.map((entry) => entry.key),
      toolCount: tools.length,
      toolEntryKeys: tools.map((entry) => entry.key),
      subagentCount: agents.length,
      subagentEntryKeys: agents.map((entry) => entry.key)
    };
  }
  if (tab === 1) {
    const stat = store.diffStatsByJob?.[job.id] || { files: [], totalAdditions: 0, totalDeletions: 0 };
    const outsideScope = scopeViolationCount(job);
    if (ui.diffFile) {
      const window = ui.diffWindow || { diff: '', offset: 0, totalChars: 0, nextOffset: null };
      const diffText = formatDisplayValue(window.diff);
      const selectedPaths = ui.diffPaths?.length ? ui.diffPaths : [ui.diffFile];
      const selectedStats = (stat.files || []).filter((file) => selectedPaths.includes(file.path));
      const additions = selectedStats.length
        ? selectedStats.reduce((total, file) => total + Number(file.additions || 0), 0)
        : Number(stat.totalAdditions || 0);
      const deletions = selectedStats.length
        ? selectedStats.reduce((total, file) => total + Number(file.deletions || 0), 0)
        : Number(stat.totalDeletions || 0);
      const prepared = Array.isArray(window.rows) ? window : prepareDiffWindow(window, {
        band: { path: ui.diffFile, additions, deletions }
      });
      const rows = prepared.rows || [];
      return {
        title: `Diff${CHROME_SEPARATOR}${formatDisplayValue(ui.diffFile)}${CHROME_SEPARATOR}${window.offset}-${window.offset + diffText.length}/${window.totalChars}${searchSuffix(ui, 'diff')}`,
        summary: {
          text: joinDisplayParts([
            `${selectedStats.length || 1} file${selectedStats.length === 1 ? '' : 's'}`,
            `+${additions} ${CHROME_GLYPHS.minus}${deletions}`,
            outsideScope ? `${outsideScope} outside scope` : ''
          ]),
          ...(outsideScope ? { badge: { text: `${outsideScope} OUTSIDE SCOPE`, style: palette.failed } } : {})
        },
        content: {
          kind: 'diff',
          virtual: true,
          entries: rows,
          formatEntry: formatDiffRow,
          wrapEntry: wrapDiffRow,
          measureKey: `diff:${job.id}:${formatDisplayValue(ui.diffFile)}:${window.offset}`,
          follow: false,
          scroll: ui.detailScroll || 0,
          searchQuery: searchQuery(ui, 'diff')
        },
        scrollItemCount: rows.length
      };
    }
    const files = stat.files || [];
    return {
      title: `Diff${CHROME_SEPARATOR}+${stat.totalAdditions || 0} -${stat.totalDeletions || 0}`,
      summary: {
        text: joinDisplayParts([
          `${files.length} files`,
          `+${stat.totalAdditions || 0} ${CHROME_GLYPHS.minus}${stat.totalDeletions || 0}`,
          outsideScope ? `${outsideScope} outside scope` : ''
        ]),
        ...(outsideScope ? { badge: { text: `${outsideScope} OUTSIDE SCOPE`, style: palette.failed } } : {})
      },
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
    const sections = recordSections(job);
    const violations = scopeViolationCount(job);
    const blocked = acceptanceBlocked(job) || job.objectiveMet === false;
    const verifyFailed = verificationFailed(job);
    const fieldCount = sections.reduce((total, section) => total + section.rows.length, 0);
    return {
      title: 'Record | curated fields',
      summary: {
        text: joinDisplayParts([
          `${fieldCount} fields`,
          violations ? `${violations} outside scope` : '',
          verifyFailed ? 'verification failed' : '',
          blocked ? 'acceptance blocked' : ''
        ]),
        ...((violations || verifyFailed || blocked) ? {
          badge: {
            text: violations ? `${violations} OUTSIDE SCOPE` : verifyFailed ? 'VERIFY FAILED' : 'ACCEPTANCE BLOCKED',
            style: violations || verifyFailed ? palette.failed : palette.badgeWarn
          }
        } : {})
      },
      content: {
        kind: 'key-value',
        sections,
        follow: false,
        scroll: ui.detailScroll || 0,
        sectionGap: sectionGapForHeight(ui.viewportHeight)
      },
      scrollItemCount: fieldCount + sections.length
    };
  }
  if (tab === 3) {
    const usage = usageContent(job, store);
    const fieldCount = usage.sections.reduce((total, section) => total + section.rows.length, 0);
    return {
      title: 'Usage | current and continuation chain',
      summary: usage.summary,
      content: {
        kind: 'key-value',
        sections: usage.sections,
        follow: false,
        scroll: ui.detailScroll || 0,
        sectionGap: sectionGapForHeight(ui.viewportHeight)
      },
      scrollItemCount: fieldCount + usage.sections.length
    };
  }
  if (tab === 5) return chainContent(store, job, ui, Math.max(1, Number(ui.viewportWidth || 80) - 2));
  const typeFilter = formatDisplayValue(ui.eventFilter).toLowerCase();
  const allBlocks = eventBlocks(events, typeFilter);
  const errors = allBlocks.filter((block) => eventCategory(block.event?.type) === 'error');
  const warnings = allBlocks.filter((block) => eventCategory(block.event?.type) === 'warning');
  const filtered = ui.eventCategoryFilter === 'error'
    ? errors
    : ui.eventCategoryFilter === 'warning' ? warnings : allBlocks;
  const categoryLabel = ui.eventCategoryFilter ? `${ui.eventCategoryFilter}s only` : '';
  const eventNow = nowOf(ui, store);
  const wrapEntry = (block, width, formatted) => wrapEventBlock(block, width, formatted, {
    now: eventNow,
    timestampMode: ui.timestampMode,
    expandedEvents: ui.expandedEvents
  });
  return {
    title: `Events${CHROME_SEPARATOR}${categoryLabel || (typeFilter ? `type /${typeFilter}` : 'all')}${CHROME_SEPARATOR}follow ${ui.follow === false ? 'off' : 'on'}${historyState}${searchSuffix(ui, 'events')}`,
    summary: {
      text: joinDisplayParts([
        `${allBlocks.length} events`,
        `${errors.length} errors`,
        `${warnings.length} warnings`
      ]),
      ...(errors.length ? {
        badge: {
          text: `${errors.length} ERRORS`,
          style: palette.failed
        }
      } : {})
    },
    loading: hydration?.loading === true,
    loadingGlyph: spinnerGlyph(eventNow),
    content: filtered.length ? {
      kind: 'rail', virtual: true, entries: filtered, formatEntry: formatEventBlock, wrapEntry,
      measureKey: `events:${job.id}:${typeFilter}:${ui.eventCategoryFilter || 'all'}`,
      follow: ui.follow !== false, scroll: ui.detailScroll || 0, searchQuery: searchQuery(ui, 'events'),
      selectedEntry: ui.follow !== false
        ? filtered.length - 1
        : Math.max(0, Math.min(filtered.length - 1, Number(ui.eventSelection ?? ui.detailScroll?.entry ?? ui.detailScroll ?? 0)))
    } : emptyHistory,
    scrollItemCount: filtered.length,
    eventKeys: filtered.map((block) => block.key),
    eventCount: allBlocks.length,
    eventEntryKeys: allBlocks.map((block) => block.key),
    errorCount: errors.length,
    errorEntryKeys: errors.map((block) => block.key),
    warningCount: warnings.length,
    warningEntryKeys: warnings.map((block) => block.key)
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
  const body = detailContent(job, store, { ...ui, viewportWidth: width, viewportHeight: height }, tab, activity);
  const headerActivity = activityIndicator(activity, now);
  const visibility = activity.visibilityNote ? `${CHROME_SEPARATOR}${formatDisplayValue(activity.visibilityNote)}` : '';
  const originProject = job.origin?.projectDir
    ? formatDisplayValue(job.origin.projectDir)
    : 'legacy origin unknown';
  const originName = job.origin?.projectDir
    ? formatDisplayValue(path.basename(job.origin.projectDir))
    : 'legacy unknown';
  if (visibility) {
    headerActivity.text += visibility;
    headerActivity.segments.push({ text: visibility, style: palette.dim });
  }
  const frame = {
    width, height, screen: 'detail',
    title: { text: joinDisplayParts([`origin ${originName}`, job.id, job.provider, job.resolvedModel || job.model || 'auto']), right: headerActivity.text, rightStyle: activityStyle(activity) },
    headerActivity,
    tabs: { rect: { x: 0, y: 1, width, height: 1 }, items: tabs, active: tab },
    panes: [{
      rect: { x: 0, y: 3, width, height: Math.max(3, height - 4) },
      title: body.title,
      summary: body.summary,
      loading: body.loading,
      loadingGlyph: body.loadingGlyph,
      content: body.content
    }],
    status: errorStatus(ui) || { text: '' },
    meta: {
      jobId: job.id,
      tab,
      tabs,
      diffFiles: store.diffStatsByJob?.[job.id]?.files?.map((file) => file.path) || [],
      chainJobIds: body.chainJobIds || [],
      eventKeys: body.eventKeys || [],
      scrollItemCount: body.scrollItemCount || 0,
      projectionMetrics: body.projectionMetrics || null,
      anomalyCount: Number(body.anomalyCount || 0),
      anomalyEntryKeys: body.anomalyEntryKeys || [],
      toolCount: Number(body.toolCount || 0),
      toolEntryKeys: body.toolEntryKeys || [],
      subagentCount: Number(body.subagentCount || 0),
      subagentEntryKeys: body.subagentEntryKeys || [],
      eventCount: Number(body.eventCount || 0),
      eventEntryKeys: body.eventEntryKeys || [],
      errorCount: Number(body.errorCount || 0),
      errorEntryKeys: body.errorEntryKeys || [],
      warningCount: Number(body.warningCount || 0),
      warningEntryKeys: body.warningEntryKeys || [],
      scopeViolationCount: scopeViolationCount(job),
      activity,
      originProject
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
      }).filter(Boolean).join(' ') + (provider.unattributedBurn?.latest
        ? ` ~${Number(provider.unattributedBurn.latest.amountPercent || 0).toFixed(1)}pp outside tracked (${formatDisplayValue(provider.unattributedBurn.latest.window)})`
        : '') || '-',
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
    status: errorStatus(ui) || { text: '' }
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
  const status = errorStatus(ui) || { text: '' };
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
      selectedActiveJobIds: selectedSession.activeDelegateJobIds || [],
      selected
    }
  };
  return commonOverlay(frame, ui, store);
}

export function statsViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const stats = store.stats || { since: '7d', jobs: 0, groups: [] };
  const columns = [
    { key: 'provider', title: 'Provider', width: 9 }, { key: 'model', title: 'Model', width: 14 },
    { key: 'mode', title: 'Mode', width: 10 }, { key: 'jobs', title: 'Jobs', width: 6, align: 'right' },
    { key: 'providerRate', title: 'Provider done', width: 15, align: 'right' },
    { key: 'verificationRate', title: 'Verification', width: 15, align: 'right' },
    { key: 'acceptanceRate', title: 'Owner accept', width: Math.max(15, width - 69), align: 'right' }
  ];
  const query = formatDisplayValue(ui.statsFilter).toLocaleLowerCase();
  const filtered = (stats.groups || []).filter((row) => !query || formatDisplayValue(row).toLocaleLowerCase().includes(query));
  const rows = filtered.map((row) => ({
    ...row,
    providerRate: row.rates?.providerCompletion?.status === 'measured'
      ? `${Math.round(row.rates.providerCompletion.rate * 100)}% n=${row.rates.providerCompletion.sampleSize}`
      : `insuf n=${row.rates?.providerCompletion?.sampleSize || 0}`,
    verificationRate: row.rates?.verificationPass?.status === 'measured'
      ? `${Math.round(row.rates.verificationPass.rate * 100)}% n=${row.rates.verificationPass.sampleSize}`
      : `insuf n=${row.rates?.verificationPass?.sampleSize || 0}`,
    acceptanceRate: row.rates?.ownerAcceptance?.status === 'measured'
      ? `${Math.round(row.rates.ownerAcceptance.rate * 100)}% n=${row.rates.ownerAcceptance.sampleSize}`
      : `insuf n=${row.rates?.ownerAcceptance?.sampleSize || 0}`
  }));
  const frame = {
    width, height, screen: 'stats',
    title: { text: `Outcome ledger | ${displayOr(stats.selection?.label || stats.since, '7d')}${query ? `${CHROME_SEPARATOR}/${formatDisplayValue(ui.statsFilter)}` : ''}`, right: `${rows.length}/${stats.groups?.length || 0} audit rows` },
    panes: [{ rect: { x: 0, y: 1, width, height: height - 2 }, title: 'Provider / normalized model / mode', content: { kind: 'table', columns, rows, selected: ui.statsSelection || 0, scroll: ui.statsScroll || 0, empty: { message: 'no audit rows in this window', action: 'g l to launch a job' } } }],
    status: errorStatus(ui) || { text: '' },
    meta: { visibleStatsCount: rows.length }
  };
  return commonOverlay(frame, ui, store);
}

const LAUNCH_FIELDS = Object.freeze([
  ['intentSource', 'Intent source'], ['profile', 'Profile'], ['provider', 'Provider'], ['model', 'Model'], ['mode', 'Mode'],
  ['effort', 'Effort'], ['prompt', 'Packet body'], ['allowedPaths', 'Allowed paths'],
  ['acceptanceCriteria', 'Acceptance'], ['verifyCommand', 'Verify command'],
  ['wallTimeSeconds', 'Wall time'], ['maxRounds', 'Max rounds'], ['maxOutputTokens', 'Max output'],
  ['ingestFiles', 'Ingest files']
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

function routeAdvisorSections(route) {
  if (!route) return [{ label: 'Route review', rows: [{ key: 'status', value: 'Calculating route advice...' }] }];
  const candidateRows = (value) => {
    if (!value) return [{ key: 'route', value: null }];
    const band = value.usageBand;
    const exact = (input) => Number.isFinite(Number(input)) ? String(Math.round(Number(input))) : null;
    return [
      { key: 'provider', value: value.provider },
      { key: 'model', value: value.model },
      { key: 'score', value: number(value.score) },
      { key: 'p50 output', value: band ? exact(band.p50OutputTokens) : null },
      { key: 'p90 output', value: band ? exact(band.p90OutputTokens) : null },
      { key: 'samples', value: band ? exact(band.samples) : null }
    ];
  };
  return [
    {
      label: 'Route review',
      rows: [
        { key: 'kind', value: route.kind },
        { key: 'mode', value: route.mode },
        { key: 'effort', value: route.effort },
        { key: 'reason', value: displayOr(route.primary?.reason, 'Advisory only; dry-run admission remains authoritative.') }
      ]
    },
    { label: 'Primary', rows: candidateRows(route.primary) },
    { label: 'Fallback', rows: candidateRows(route.fallbacks?.[0]) }
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
    ...(preview.confirmationCard ? ['', ...formatDisplayValue(preview.confirmationCard).split('\n')] : []),
    ...(warnings.length ? warnings.map((warning) => `WARNING: ${formatDisplayValue(warning)}`) : ['Packet lint: clean']),
    ...(preview.packet ? ['', 'EXACT PROVIDER PACKET', ...formatDisplayValue(preview.packet).split('\n')] : [])
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
    title: {
      text: 'New managed job',
      right: preview?.unresolved?.length ? `${preview.unresolved.length} unresolved`
        : preview ? 'preview ready | launch confirmation' : 'dry run required'
    },
    panes: [
      { rect: { x: 0, y: 1, width: formWidth, height: topHeight }, title: `Launcher form${CHROME_SEPARATOR}profiles: ${(store.profiles || []).map(formatDisplayValue).filter(Boolean).join(', ') || 'none'}`, content: { kind: 'table', columns: [{ key: 'field', title: 'Field', width: 16 }, { key: 'value', title: 'Value', width: Math.max(10, formWidth - 18) }], rows, selected: launcher.fieldIndex || 0 } },
      {
        rect: { x: 0, y: previewY, width, height: Math.max(3, height - previewY - 1) },
        title: 'WorkSpec confirmation card | exact provider packet',
        summary: {
          text: preview
            ? joinDisplayParts([
                `${formatDisplayValue(preview.provider)}/${formatDisplayValue(preview.model)}`,
                preview.unresolved?.length ? `${preview.unresolved.length} unresolved` : `${warnings.length} warnings`,
                `${previewLines.length} preview lines`
              ])
            : '0 packet lines | dry run required',
          ...(preview?.unresolved?.length
            ? { badge: { text: `${preview.unresolved.length} UNRESOLVED`, style: palette.badgeWarn } }
            : warnings.length ? { badge: { text: `${warnings.length} WARNINGS`, style: palette.badgeWarn } } : {})
        },
        content: { kind: 'log', lines: previewLines, follow: false, scroll: launcher.previewScroll || 0 }
      },
      {
        rect: advisorRect,
        title: 'Route advisor | advisory only',
        summary: {
          text: launcher.routeAdvice
            ? joinDisplayParts([`${launcher.routeAdvice.fallbacks?.length || 0} fallbacks`, 'advisory'])
            : 'route advice pending'
        },
        content: {
          kind: 'key-value',
          sections: routeAdvisorSections(launcher.routeAdvice),
          follow: false,
          scroll: 0,
          sectionGap: sectionGapForHeight(height)
        }
      }
    ],
    status: errorStatus(ui) || { text: '' },
    meta: { fields: LAUNCH_FIELDS.map(([key]) => key), previewReady: Boolean(preview) && !preview?.unresolved?.length }
  };
  return commonOverlay(frame, ui, store);
}

const workItemCache = new WeakMap();

function projectedWorkItems(store) {
  const jobs = Array.isArray(store.jobs) ? store.jobs : [];
  if (!workItemCache.has(jobs)) workItemCache.set(jobs, projectJobsAsWorkItems(jobs));
  return workItemCache.get(jobs);
}

function workAttemptJobs(work, store) {
  const byId = new Map((Array.isArray(store.jobs) ? store.jobs : []).map((job) => [job.id, job]));
  return (work?.runs || []).map((run) => byId.get(run.attempt?.id)).filter(Boolean);
}

function latestWorkJob(work, store) {
  return workAttemptJobs(work, store).at(-1) || null;
}

function workFindingRows(work) {
  const byId = new Map();
  for (const finding of Array.isArray(work?.findings) ? work.findings : []) {
    const safeFinding = finding && typeof finding === 'object' ? finding : {};
    const key = formatDisplayValue(safeFinding.id) || `finding-${byId.size + 1}`;
    byId.set(key, safeFinding);
  }
  return [...byId.entries()].map(([id, finding]) => {
    const declared = ['open', 'resolved', 'regressed'].includes(finding.status) ? finding.status : null;
    const status = declared || 'open*';
    const style = declared === 'resolved' ? palette.positive
      : declared === 'regressed' ? palette.failed : palette.badgeWarn;
    return {
      id,
      status: { text: status, style },
      severity: displayOr(finding.severity, '-'),
      criterion: displayOr(finding.criterion, 'unattributed finding'),
      evidence: compactFieldValue(finding.evidence),
      legacyStatus: !declared
    };
  });
}

function workFindingCounts(rows) {
  return rows.reduce((counts, row) => {
    const status = row.status.text === 'open*' ? 'open' : row.status.text;
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, { open: 0, resolved: 0, regressed: 0 });
}

function compilationField(compilation, key, fallback) {
  const field = compilation?.fields?.[key];
  if (field && typeof field === 'object') return field;
  return {
    value: fallback,
    confidence: null,
    status: fallback == null || Array.isArray(fallback) && !fallback.length ? 'unresolved' : 'projected',
    provenance: [{
      kind: 'compatibility-projection',
      source: 'historical job record',
      detail: 'Field-level P5 provenance was not recorded for this historical attempt.'
    }]
  };
}

function composeSections(work, rootJob) {
  const compilation = rootJob?.specCompilation || null;
  const spec = work?.spec || {};
  const definitions = [
    ['objective', 'Objective', spec.objective],
    ['scopeClaim', 'Scope claim', spec.scopeClaim],
    ['acceptanceCriteria', 'Acceptance criteria', spec.acceptanceCriteria],
    ['verifyRecipe', 'Verification recipe', spec.verifyRecipe],
    ['budget', 'Budget', spec.budget],
    ['base', 'Immutable base', spec.base]
  ];
  const sections = definitions.map(([key, label, fallback]) => {
    const field = compilationField(compilation, key, fallback);
    const unresolved = field.status === 'unresolved' || field.confidence === 'low';
    const confidence = field.confidence ? formatDisplayValue(field.confidence).toUpperCase() : 'UNKNOWN';
    const status = formatDisplayValue(field.status || 'projected').toUpperCase();
    const provenance = Array.isArray(field.provenance) ? field.provenance.slice(0, 3) : [];
    return {
      label: `${label} [${confidence}${CHROME_SEPARATOR}${status}]`,
      ...(unresolved ? { badge: { text: 'UNRESOLVED', style: palette.badgeWarn } } : {}),
      rows: [
        {
          key: 'value',
          value: compactFieldValue(field.status === 'unresolved' || field.confidence === 'low'
            ? field.value
            : field.value ?? fallback)
        },
        ...(provenance.flatMap((source, index) => [
          { key: `source ${index + 1}`, value: joinDisplayParts([source?.kind, source?.source], ': '), style: palette.dim },
          { key: `why ${index + 1}`, value: source?.detail, style: palette.dim }
        ]))
      ]
    };
  });
  const compatibilitySource = {
    kind: 'compatibility-projection',
    source: 'historical job record',
    detail: 'P5 authority provenance was not recorded for this historical attempt.'
  };
  const authority = compilation?.authority && typeof compilation.authority === 'object'
    ? compilation.authority
    : {
        allowedPaths: {
          value: rootJob?.allowedPaths || null,
          confidence: null,
          status: rootJob?.allowedPaths?.length ? 'projected' : 'unknown',
          provenance: [compatibilitySource]
        },
        network: {
          value: rootJob?.network === true ? 'enabled' : 'not recorded',
          status: 'projected',
          provenance: [compatibilitySource]
        },
        sandbox: {
          value: displayOr(rootJob?.sandbox, 'not recorded'),
          status: 'projected',
          provenance: [compatibilitySource]
        }
      };
  for (const [key, field] of Object.entries(authority)) {
    if (!field || typeof field !== 'object') continue;
    const unresolved = field.status === 'unresolved' || field.confidence === 'low';
    const confidence = field.confidence ? `${formatDisplayValue(field.confidence).toUpperCase()}${CHROME_SEPARATOR}` : '';
    const provenance = Array.isArray(field.provenance) ? field.provenance.slice(0, 3) : [];
    sections.push({
      label: `Authority: ${key} [${confidence}${formatDisplayValue(field.status || 'projected').toUpperCase()}]`,
      ...(unresolved ? { badge: { text: 'DISPATCH BLOCKED', style: palette.failed } } : {}),
      rows: [
        { key: 'value', value: compactFieldValue(field.value) },
        ...(provenance.flatMap((source, index) => [
          { key: `source ${index + 1}`, value: joinDisplayParts([source?.kind, source?.source], ': '), style: palette.dim },
          { key: `why ${index + 1}`, value: source?.detail, style: palette.dim }
        ]))
      ]
    });
  }
  return sections;
}

function workChangedFiles(job) {
  if (Array.isArray(job?.changedFiles)) return job.changedFiles;
  if (Array.isArray(job?.changedFiles?.entries)) return job.changedFiles.entries;
  if (Array.isArray(job?.changedFiles?.files)) return job.changedFiles.files;
  return [];
}

function workDiffShape(job, store) {
  const stat = store.diffStatsByJob?.[job?.id] || {};
  const finiteCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  const files = finiteCount(job?.changedFiles?.count ?? stat.files?.length ?? workChangedFiles(job).length);
  const additions = finiteCount(stat.totalAdditions);
  const deletions = finiteCount(stat.totalDeletions);
  return {
    files,
    countIsLowerBound: job?.changedFiles?.countIsLowerBound === true,
    additions,
    deletions,
    label: `${job?.changedFiles?.countIsLowerBound === true ? 'at least ' : ''}${files} files${CHROME_SEPARATOR}+${additions} ${CHROME_GLYPHS.minus}${deletions}`
  };
}

function workEvidenceSections(work, job, store) {
  const drift = derivedDrift(job || {});
  const shape = workDiffShape(job, store);
  const findings = workFindingRows(work);
  const counts = workFindingCounts(findings);
  return [
    {
      label: 'Immutable base and decision',
      rows: [
        { key: 'attempt', value: job?.id, copy: true },
        { key: 'base revision', value: work?.spec?.base?.revision || job?.baseRevision, copy: true },
        { key: 'decision', value: work?.decision?.state || job?.acceptance?.state },
        { key: 'decision evidence', value: compactFieldValue(work?.decision?.evidenceRefs) }
      ]
    },
    {
      label: 'Changed files and scope',
      ...((drift.outsideScope || []).length ? { badge: { text: `${drift.outsideScope.length} OUTSIDE SCOPE`, style: palette.failed } } : {}),
      rows: [
        { key: 'diff shape', value: shape.label },
        { key: 'changed paths', value: compactFieldValue(workChangedFiles(job)) },
        { key: 'outside scope', value: compactFieldValue(drift.outsideScope) },
        { key: 'base drift', value: compactFieldValue(job?.baseDrift || job?.acceptance?.evidence?.baseDrift) }
      ]
    },
    {
      label: 'Verification evidence',
      ...(verificationFailed(job || {}) ? { badge: { text: 'VERIFY FAILED', style: palette.failed } } : {}),
      rows: [
        { key: 'origin', value: job?.verificationOrigin },
        ...objectRows('verification', job?.verification),
        ...verificationEvidenceRows(job),
        { key: 'acceptance state', value: job?.acceptance?.state },
        { key: 'evidence digest', value: job?.acceptance?.evidenceDigest, copy: true }
      ]
    },
    {
      label: 'Findings verdict',
      ...((counts.open || counts.regressed) ? { badge: { text: `${counts.open + counts.regressed} OPEN`, style: palette.badgeWarn } } : {}),
      rows: [
        { key: 'open', value: counts.open },
        { key: 'resolved', value: counts.resolved },
        { key: 'regressed', value: counts.regressed },
        { key: 'scope verdict', value: (drift.outsideScope || []).length ? 'blocked: outside-scope changes' : 'inside declared scope' }
      ]
    }
  ];
}

function candidateSections(job, work, store) {
  const shape = workDiffShape(job, store);
  const usage = jobUsage(job || {}, store.eventsByJob?.[job?.id] || []);
  const findings = [
    ...(Array.isArray(job?.result?.structured?.findings) ? job.result.structured.findings : []),
    ...(Array.isArray(job?.findings) ? job.findings : [])
  ];
  const unresolved = findings.filter((finding) => !['resolved'].includes(finding?.status)).length
    + Number(job?.scopeViolations?.length || 0)
    + Number(verificationFailed(job || {}));
  return [
    {
      label: 'Same criteria',
      ...(unresolved ? { badge: { text: `${unresolved} RISKS`, style: palette.badgeWarn } } : {}),
      rows: [
        { key: 'provider / model', value: joinDisplayParts([job?.provider, job?.resolvedModel || job?.model], '/') },
        { key: 'diff shape', value: shape.label },
        { key: 'checks', value: verificationFailed(job || {}) ? 'failed' : job?.verification ? 'recorded pass / non-failure' : 'missing' },
        { key: 'findings', value: findings.length },
        { key: 'duration', value: duration(job?.durationMs ?? ((timestampMs(job?.completedAt) || timestampMs(job?.updatedAt)) - timestampMs(job?.createdAt))) },
        { key: 'usage', value: `${number(usage.total)} tokens${CHROME_SEPARATOR}${number(usage.output)} out` },
        { key: 'unresolved risks', value: unresolved }
      ]
    },
    {
      label: 'Evidence',
      rows: [
        { key: 'verification', value: compactFieldValue(job?.verification) },
        { key: 'acceptance', value: compactFieldValue(job?.acceptance) },
        { key: 'scope violations', value: compactFieldValue(job?.scopeViolations) },
        { key: 'result marker', value: job?.resultSuspect || job?.objectiveMet === false ? displayOr(job?.resultSuspect, 'objective not met') : 'none recorded' }
      ]
    }
  ];
}

function workActionMeta(work, job, store, findings) {
  const local = job && !job.remote && !job.readOnly
    && !['external', 'claude-agent', 'direct-mcp', 'direct-cli', 'direct-acp'].includes(job.transport);
  const completedWrite = local && job.status === 'completed' && ['implement', 'verify'].includes(job.mode);
  const finalDecision = ['accepted', 'rejected', 'superseded'].includes(job?.acceptance?.state);
  const integrationJobIds = local
    && TERMINAL.has(job?.status)
    && job?.isolation === 'worktree'
    && job?.changeSet
    ? [job.id]
    : [];
  const maxRounds = Number(work?.spec?.budget?.maxRounds);
  const usedRounds = work?.runs?.length || 0;
  const remainingRounds = Number.isSafeInteger(maxRounds) && maxRounds > 0 ? Math.max(0, maxRounds - usedRounds) : null;
  const unresolvedFindings = findings.filter((row) => ['open*', 'open', 'regressed'].includes(row.status.text)).length;
  const resumable = derivedResumable(job || {});
  return {
    acceptJobId: completedWrite && !finalDecision && job.isolation !== 'worktree' && job.acceptance?.state === 'ready-for-review' ? job.id : null,
    acceptUnavailable: job?.isolation === 'worktree'
      ? 'owner-tree apply is deferred; compose an integration worktree instead'
      : !completedWrite ? 'needs a completed local implement/verify attempt'
        : finalDecision ? `already ${job.acceptance.state}`
          : job?.acceptance?.state !== 'ready-for-review' ? `acceptance is ${displayOr(job?.acceptance?.state, 'missing')}` : null,
    rejectJobId: completedWrite && !finalDecision ? job.id : null,
    rejectUnavailable: !completedWrite ? 'needs a completed local implement/verify attempt'
      : finalDecision ? `already ${job.acceptance.state}` : null,
    integrationJobIds,
    integrationUnavailable: integrationJobIds.length ? null : 'needs a terminal isolated attempt with a captured change set',
    nextRoundJobId: local && TERMINAL.has(job?.status) && resumable.ok && remainingRounds > 0 && unresolvedFindings > 0 ? job.id : null,
    nextRoundUnavailable: !local ? 'needs a local managed attempt'
      : !TERMINAL.has(job?.status) ? 'needs a terminal attempt'
        : !resumable.ok ? resumable.reason
          : remainingRounds == null ? 'WorkSpec has no bounded maxRounds policy'
            : remainingRounds <= 0 ? 'WorkSpec round budget is exhausted'
              : unresolvedFindings <= 0 ? 'no open or regressed findings' : null,
    maxRounds: Number.isSafeInteger(maxRounds) && maxRounds > 0 ? maxRounds : null,
    usedRounds,
    remainingRounds,
    unresolvedFindings
  };
}

export function workViewModel(store, ui = {}, viewport = {}) {
  const { width, height } = viewportOf(viewport);
  const items = projectedWorkItems(store);
  if (!items.length) {
    return commonOverlay({
      width, height, screen: 'work',
      title: { text: 'WorkItem cockpit', right: '0 work items' },
      tabs: { rect: { x: 0, y: 1, width, height: 1 }, items: WORK_TABS, active: 0 },
      panes: [{
        rect: { x: 0, y: 3, width, height: Math.max(3, height - 4) },
        title: 'No projected work',
        content: { kind: 'empty', message: 'no WorkItems in the current store', action: 'Existing Fleet and job detail remain available' }
      }],
      status: errorStatus(ui) || { text: '' },
      meta: { workIds: [], workItemCount: 0, workId: null, workTab: 0, tabs: WORK_TABS }
    }, ui, store);
  }
  const index = Math.max(0, Math.min(items.length - 1, Number(ui.workIndex || 0)));
  const work = items[index];
  const jobs = workAttemptJobs(work, store);
  const rootJob = jobs[0] || null;
  const job = jobs.at(-1) || null;
  const tab = Math.max(0, Math.min(WORK_TABS.length - 1, Number(ui.workTab || 0)));
  const findings = workFindingRows(work);
  const findingCounts = workFindingCounts(findings);
  const actions = workActionMeta(work, job, store, findings);
  const bodyHeight = Math.max(3, height - 4);
  const baseFrame = {
    width, height, screen: 'work',
    title: {
      text: joinDisplayParts(['WorkItem cockpit', work.id, `${jobs.length} candidate${jobs.length === 1 ? '' : 's'}`]),
      right: `${index + 1}/${items.length}${CHROME_SEPARATOR}${displayOr(work.decision?.state || job?.acceptance?.state, 'undecided')}`
    },
    tabs: { rect: { x: 0, y: 1, width, height: 1 }, items: WORK_TABS, active: tab },
    panes: [],
    status: errorStatus(ui) || { text: '' },
    meta: {
      workIds: items.map((item) => item.id),
      workItemCount: items.length,
      workId: work.id,
      workIndex: index,
      workTab: tab,
      tabs: WORK_TABS,
      jobId: job?.id || null,
      candidateJobIds: jobs.map((candidate) => candidate.id),
      findingCounts,
      ...actions
    }
  };
  if (tab === 0) {
    const sections = composeSections(work, rootJob);
    const unresolved = Array.isArray(rootJob?.specCompilation?.unresolved)
      ? rootJob.specCompilation.unresolved
      : sections.filter((section) => section.badge).map((section) => section.label.split(' [')[0]);
    baseFrame.panes = [{
      rect: { x: 0, y: 3, width, height: bodyHeight },
      title: 'Structured WorkSpec card | field provenance and confidence',
      summary: {
        text: joinDisplayParts([`${sections.length} fields`, unresolved.length ? `${unresolved.length} unresolved` : 'confirmed']),
        ...(unresolved.length ? { badge: { text: 'WRITE DISPATCH BLOCKED', style: palette.failed } } : {})
      },
      content: {
        kind: 'key-value',
        sections: [
          ...sections,
          {
            label: 'Dispatch',
            ...(unresolved.length ? { badge: { text: 'BLOCKED', style: palette.failed } } : {}),
            rows: [
              { key: 'state', value: unresolved.length ? 'blocked until unresolved fields are confirmed' : 'spec was confirmed before this attempt launched' },
              { key: 'unresolved', value: compactFieldValue(unresolved) },
              { key: 'cockpit action', value: 'read-only card; edit and dispatch through the existing Launcher' }
            ]
          }
        ],
        follow: false,
        scroll: ui.workScroll || 0,
        sectionGap: sectionGapForHeight(height)
      }
    }];
  } else if (tab === 1) {
    const shape = workDiffShape(job, store);
    const rawDiff = formatDisplayValue(store.diffsByJob?.[job?.id] || '', { maxLength: 12_000 });
    const prepared = rawDiff ? prepareDiffWindow({
      diff: rawDiff,
      offset: 0,
      totalChars: rawDiff.length,
      nextOffset: null
    }, { band: { path: `${shape.countIsLowerBound ? 'at least ' : ''}${shape.files} changed files`, additions: shape.additions, deletions: shape.deletions } }) : null;
    const diffContent = prepared?.rows?.length ? {
      kind: 'diff',
      virtual: true,
      entries: prepared.rows,
      formatEntry: formatDiffRow,
      wrapEntry: wrapDiffRow,
      measureKey: `work-review:${work.id}:${job?.id}`,
      follow: false,
      scroll: ui.workScroll || 0
    } : {
      kind: 'table',
      selection: false,
      columns: [{ key: 'path', title: 'Changed file', width: Math.max(16, Math.floor(width * 0.45)) }],
      rows: workChangedFiles(job).map((entry) => ({
        path: formatDisplayValue(entry?.path || entry)
      })),
      empty: { message: 'no diff artifact available', action: 'Changed-file inventory and decision evidence remain visible' }
    };
    const evidence = workEvidenceSections(work, job, store);
    const findingsTable = {
      kind: 'table',
      selection: false,
      scroll: ui.workScroll || 0,
      columns: [
        { key: 'status', title: 'State', width: 10 },
        { key: 'severity', title: 'Severity', width: 9 },
        { key: 'criterion', title: 'Finding / criterion', width: Math.max(18, Math.floor(width * 0.32)) }
      ],
      rows: findings,
      empty: { message: 'no findings recorded', action: 'Verification and scope evidence still gate the decision' }
    };
    if (width >= 90) {
      const leftWidth = Math.max(42, Math.floor(width * 0.56));
      const rightWidth = width - leftWidth - 1;
      const evidenceHeight = Math.max(8, Math.floor(bodyHeight * 0.58));
      baseFrame.panes = [
        {
          rect: { x: 0, y: 3, width: leftWidth, height: bodyHeight },
          title: 'Changed files | bounded diff',
          summary: { text: shape.label },
          content: diffContent
        },
        {
          rect: { x: leftWidth + 1, y: 3, width: rightWidth, height: evidenceHeight },
          title: 'Verification | scope / drift | base revision',
          content: { kind: 'key-value', sections: evidence, follow: false, scroll: ui.workScroll || 0, sectionGap: sectionGapForHeight(height) }
        },
        {
          rect: { x: leftWidth + 1, y: 4 + evidenceHeight, width: rightWidth, height: Math.max(3, bodyHeight - evidenceHeight - 1) },
          title: 'Findings checklist',
          summary: { text: `${findingCounts.open} open${CHROME_SEPARATOR}${findingCounts.resolved} resolved${CHROME_SEPARATOR}${findingCounts.regressed} regressed` },
          content: findingsTable
        }
      ];
    } else {
      const first = Math.max(5, Math.floor(bodyHeight * 0.44));
      const second = Math.max(5, Math.floor((bodyHeight - first - 2) * 0.55));
      baseFrame.panes = [
        { rect: { x: 0, y: 3, width, height: first }, title: 'Changed files | bounded diff', summary: { text: shape.label }, content: diffContent },
        { rect: { x: 0, y: 4 + first, width, height: second }, title: 'Verification | scope / drift | base revision', content: { kind: 'key-value', sections: evidence, follow: false, scroll: ui.workScroll || 0, sectionGap: 0 } },
        { rect: { x: 0, y: 5 + first + second, width, height: Math.max(3, bodyHeight - first - second - 2) }, title: 'Findings checklist', content: findingsTable }
      ];
    }
  } else if (tab === 2) {
    const acceptance = job?.acceptance || {};
    baseFrame.panes = [{
      rect: { x: 0, y: 3, width, height: bodyHeight },
      title: 'Evidence-bound owner decision | no owner-tree apply',
      summary: {
        text: joinDisplayParts([displayOr(acceptance.state, 'evidence missing'), actions.integrationJobIds.length ? `${actions.integrationJobIds.length} isolated change sets` : 'shared / no captured change set']),
        ...(acceptance.state === 'blocked' ? { badge: { text: 'ACCEPTANCE BLOCKED', style: palette.failed } } : {})
      },
      content: {
        kind: 'key-value',
        sections: [
          {
            label: 'P3 decision evidence',
            rows: [
              { key: 'attempt', value: job?.id, copy: true },
              { key: 'state', value: acceptance.state },
              { key: 'blocked by', value: compactFieldValue(acceptance.blockedBy) },
              { key: 'evidence', value: compactFieldValue(acceptance.evidence) },
              ...verificationEvidenceRows(job),
              { key: 'evidence digest', value: acceptance.evidenceDigest, copy: true }
            ]
          },
          {
            label: 'Accept / reject',
            rows: [
              { key: 'accept', value: actions.acceptJobId ? 'available: a (typed confirmation)' : `disabled: ${actions.acceptUnavailable}` },
              { key: 'reject', value: actions.rejectJobId ? 'available: r (typed confirmation)' : `disabled: ${actions.rejectUnavailable}` },
              { key: 'binding', value: 'delegate_decide / decideAcceptance; broker binds the current evidence digest' }
            ]
          },
          {
            label: 'Integration worktree',
            ...(actions.integrationJobIds.length ? { badge: { text: 'COMPOSITION AVAILABLE', style: palette.positive } } : {}),
            rows: [
              { key: 'compose', value: actions.integrationJobIds.length ? 'available: i (typed confirmation)' : `disabled: ${actions.integrationUnavailable}` },
              { key: 'candidate attempts', value: compactFieldValue(actions.integrationJobIds) },
              { key: 'destination', value: 'broker-owned integration worktree only' },
              { key: 'owner tree apply', value: 'DISABLED: direct multi-file application is deliberately deferred', style: palette.failed }
            ]
          }
        ],
        follow: false,
        scroll: ui.workScroll || 0,
        sectionGap: sectionGapForHeight(height)
      }
    }];
  } else if (tab === 3) {
    const candidates = jobs.slice(-2);
    baseFrame.panes = candidates.length < 2 ? [{
      rect: { x: 0, y: 3, width, height: bodyHeight },
      title: 'Candidate comparison',
      content: { kind: 'empty', message: 'comparison needs two candidates under the same WorkItem', action: 'Resume or review-round attempts remain grouped by the existing WorkItem projection' }
    }] : candidates.map((candidate, candidateIndex) => {
      const paneWidth = candidateIndex === 0 ? Math.floor((width - 1) / 2) : width - Math.floor((width - 1) / 2) - 1;
      const x = candidateIndex === 0 ? 0 : Math.floor((width - 1) / 2) + 1;
      return {
        rect: { x, y: 3, width: paneWidth, height: bodyHeight },
        title: `Candidate ${candidateIndex + 1}${CHROME_SEPARATOR}${candidate.id}`,
        summary: { text: workDiffShape(candidate, store).label },
        content: {
          kind: 'key-value',
          sections: candidateSections(candidate, work, store),
          follow: false,
          scroll: ui.workScroll || 0,
          sectionGap: sectionGapForHeight(height)
        }
      };
    });
  } else if (tab === 4) {
    baseFrame.panes = [{
      rect: { x: 0, y: 3, width, height: bodyHeight },
      title: 'Replay | deliberately unavailable in this cut',
      content: {
        kind: 'log',
        lines: [
          'Replay disabled: the normalized journal has no projection checkpoints or reversible reducer.',
          'Accurate arbitrary rewind requires full-prefix loading; the endpoint requires the entire journal.',
          'Deferred to preserve O(viewport). No scrub control is rendered.'
        ],
        follow: false,
        scroll: 0
      }
    }];
  } else {
    const policySections = [{
      label: 'Bounded next-round policy',
      ...(actions.nextRoundJobId ? { badge: { text: 'ROUND AVAILABLE', style: palette.positive } } : { badge: { text: 'ROUND DISABLED', style: palette.badgeWarn } }),
      rows: [
        { key: 'open / regressed findings', value: actions.unresolvedFindings },
        { key: 'rounds used', value: actions.usedRounds },
        { key: 'maximum rounds', value: actions.maxRounds },
        { key: 'remaining rounds', value: actions.remainingRounds },
        { key: 'provider / model', value: joinDisplayParts([job?.provider, job?.resolvedModel || job?.model], '/') },
        { key: 'verify recipe', value: compactFieldValue(work?.spec?.verifyRecipe) },
        { key: 'legacy status', value: 'open* means no historical status was recorded; it is treated as open' },
        { key: 'launch', value: actions.nextRoundJobId ? 'available: w after this policy is visible' : `disabled: ${actions.nextRoundUnavailable}` }
      ]
    }];
    const findingsHeight = Math.max(7, Math.floor(bodyHeight * 0.58));
    baseFrame.panes = [
      {
        rect: { x: 0, y: 3, width, height: findingsHeight },
        title: 'Finding convergence',
        summary: {
          text: `${findingCounts.open} open${CHROME_SEPARATOR}${findingCounts.resolved} resolved${CHROME_SEPARATOR}${findingCounts.regressed} regressed`,
          ...((findingCounts.open || findingCounts.regressed) ? { badge: { text: `${findingCounts.open + findingCounts.regressed} NEED WORK`, style: palette.badgeWarn } } : {})
        },
        content: {
          kind: 'table',
          selection: false,
          scroll: ui.workScroll || 0,
          columns: [
            { key: 'status', title: 'State', width: 11 },
            { key: 'severity', title: 'Severity', width: 10 },
            { key: 'criterion', title: 'Criterion / finding', width: Math.max(20, width - 23) }
          ],
          rows: findings,
          empty: { message: 'no findings recorded', action: 'No next round is offered without an open or regressed finding' }
        }
      },
      {
        rect: { x: 0, y: 4 + findingsHeight, width, height: Math.max(3, bodyHeight - findingsHeight - 1) },
        title: 'Policy shown before launch',
        content: { kind: 'key-value', sections: policySections, follow: false, scroll: ui.workScroll || 0, sectionGap: sectionGapForHeight(height) }
      }
    ];
  }
  baseFrame.meta.scrollItemCount = Math.max(0, ...(baseFrame.panes || []).map((pane) => paneItemCount(pane.content)));
  return commonOverlay(baseFrame, ui, store);
}

export function createViewModel(store, ui = {}, viewport = {}) {
  const effectiveUi = ui.remote || !store.remote ? ui : { ...ui, remote: store.remote };
  if (effectiveUi.screen === 'dashboard') return dashboardViewModel(store, effectiveUi, viewport);
  if (effectiveUi.screen === 'work') return workViewModel(store, effectiveUi, viewport);
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
