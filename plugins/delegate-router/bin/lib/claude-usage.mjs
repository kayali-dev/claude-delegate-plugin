import { mutateState, setWindow } from './state.mjs';

// Both inputs come from Claude Code, never from credentials or a usage endpoint.
// Accept only the named subscription windows; context/cost are not allowance.
export function claudeUsageWindows(payload, source = 'claude-mod') {
  const readings = source === 'claude-statusline'
    ? ['five_hour', 'seven_day'].map((kind) => ({
      kind,
      percentUsed: payload?.rate_limits?.[kind]?.used_percentage,
      resetsAt: payload?.rate_limits?.[kind]?.resets_at
    }))
    : (Array.isArray(payload?.rateLimits) ? payload.rateLimits : []).slice(0, 16);
  const windows = new Map();
  for (const reading of readings) {
    if (!['five_hour', 'seven_day'].includes(reading?.kind)) continue;
    const usedPercent = reading.percentUsed;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    let resetsAt = null;
    if (typeof reading.resetsAt === 'string') {
      const parsed = Date.parse(reading.resetsAt);
      if (Number.isFinite(parsed)) resetsAt = Math.floor(parsed / 1000);
    } else if (Number.isSafeInteger(reading.resetsAt) && reading.resetsAt > 0) {
      resetsAt = reading.resetsAt;
    }
    // An invalid declared reset is not silently converted into a fresh window.
    if (reading.resetsAt != null && resetsAt == null) continue;
    windows.set(reading.kind, { name: reading.kind, usedPercent, resetsAt, source });
  }
  return [...windows.values()];
}

export function captureClaudeUsage(payload, source = 'claude-mod') {
  const windows = claudeUsageWindows(payload, source);
  if (!windows.length) return { captured: 0 }; // Missing data is not zero.
  mutateState((state) => {
    for (const window of windows) setWindow(state, 'claude', window.name, window.usedPercent, window);
  });
  return { captured: windows.length };
}
