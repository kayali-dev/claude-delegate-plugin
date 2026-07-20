import { listJobs, recordEvent } from './state.mjs';
import { computeUnattributedBurnMarkers, readAuditLog } from './stats.mjs';

function normalizedWindows(rateLimits = {}) {
  return Object.entries(rateLimits).flatMap(([name, value]) => {
    const usedPercent = Number(value?.usedPercent);
    if (!Number.isFinite(usedPercent)) return [];
    return [{ name, usedPercent, resetsAt: value?.resetsAt == null ? null : Number(value.resetsAt) }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function captureCodexAllowanceSnapshot(state, rateLimits, options = {}) {
  const windows = normalizedWindows(rateLimits);
  if (!windows.length) return { snapshot: null, markers: [] };
  const snapshot = {
    kind: 'allowance-snapshot',
    provider: 'codex',
    at: Number(options.now ?? Date.now()),
    source: String(options.source || 'codex-app-server').slice(0, 80),
    windows
  };
  const previous = [...(state.history || [])].reverse().find((entry) => entry?.kind === 'allowance-snapshot' && entry.provider === 'codex');
  const markers = previous ? computeUnattributedBurnMarkers([previous, snapshot], options.auditRecords || readAuditLog(), {
    jobs: options.jobs || listJobs(),
    minimumDelta: options.minimumDelta
  }) : [];
  recordEvent(state, snapshot);
  for (const marker of markers) recordEvent(state, marker);
  return { snapshot, markers };
}
