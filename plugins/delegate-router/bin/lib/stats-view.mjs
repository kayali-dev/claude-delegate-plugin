// Output projection only: all rates and recommendations are computed from the
// complete selected population before any display limits are applied.
import { brokerError } from './errors.mjs';
export function boundedStatsView(stats, options = {}) {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const maxChars = options.maxChars ?? 32_000;
  const view = options.view || 'full';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(maxChars) || maxChars < 4000 || maxChars > 64_000
    || !['summary', 'full'].includes(view)) throw brokerError('INVALID_REQUEST', 'Invalid statistics display limits');
  const groups = stats.groups || [];
  let rows = groups.slice(offset, offset + limit);
  let detailLimit = limit;
  let stringLimit = 1024;
  let output;
  for (;;) {
    let omitted = 0;
    const bound = (value, depth = 0) => {
      if (typeof value === 'string') { if (value.length > stringLimit) omitted++; return value.slice(0, stringLimit); }
      if (!value || typeof value !== 'object') return value;
      if (depth > 12) { omitted++; return null; }
      if (Array.isArray(value)) {
        omitted += Math.max(0, value.length - detailLimit);
        return value.slice(0, detailLimit).map((entry) => bound(entry, depth + 1));
      }
      const entries = Object.entries(value);
      omitted += Math.max(0, entries.length - 40);
      return Object.fromEntries(entries.slice(0, 40).map(([key, entry]) => [key.slice(0, 256), bound(entry, depth + 1)]));
    };
    const { groups: unused, cohorts, ...totals } = stats;
    output = { ...bound(totals), ...(view === 'full' ? { groups: rows.map((row) => bound(row)), cohorts: bound(cohorts) } : {}),
      display: { view, maxChars, totalGroups: groups.length, offset, returnedGroups: view === 'full' ? rows.length : 0,
        nextOffset: view === 'full' && offset + rows.length < groups.length ? offset + rows.length : null,
        omittedDetailEntries: omitted, truncated: omitted > 0 || (view === 'full' ? rows.length < groups.length : groups.length > 0) } };
    if (JSON.stringify(output, null, 2).length <= maxChars) return output;
    if (rows.length > 1) { rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2))); continue; }
    if (detailLimit > 1) { detailLimit = Math.floor(detailLimit / 2); continue; }
    if (stringLimit > 128) { stringLimit = Math.floor(stringLimit / 2); continue; }
    // A pathological detail map cannot displace the useful aggregate facts.
    const compact = { jobs: stats.jobs, orphanedJobs: stats.orphanedJobs, rates: bound(stats.rates), totals: bound(stats.totals),
      display: { ...output.display, returnedGroups: 0, truncated: true, nextOffset: null,
        reason: 'detail-budget-exceeded; narrow the date/model selection or use CLI stats' } };
    if (JSON.stringify(compact, null, 2).length <= maxChars) return compact;
    return { display: compact.display };
  }
}
