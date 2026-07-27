import { spawnSync } from 'node:child_process';

const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_PS_TIMEOUT_MS = 75;
const MAX_PS_BYTES = 4 * 1024 * 1024;

function positivePid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function startTime(value) {
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return null;
  const processes = new Map();
  for (const row of rows) {
    const pid = positivePid(row?.pid);
    const ppidValue = Number(row?.ppid);
    const ppid = Number.isSafeInteger(ppidValue) && ppidValue >= 0 ? ppidValue : null;
    const startTimeMs = startTime(row?.startTimeMs);
    if (!pid || ppid == null || !startTimeMs) continue;
    processes.set(pid, { pid, ppid, startTimeMs });
  }
  return processes;
}

function parseProcessRows(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const parsedStart = Date.parse(match[3]);
    if (!Number.isFinite(parsedStart)) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startTimeMs: Math.floor(parsedStart / 1000) * 1000
    });
  }
  return rows;
}

export function readProcessIdentityTable(options = {}) {
  const injected = normalizeRows(options.processTable);
  if (injected) {
    return {
      ok: injected.size > 0,
      reason: injected.size > 0 ? null : 'process-start-time-unavailable',
      processes: injected
    };
  }
  try {
    const result = spawnSync(options.psPath || '/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
      encoding: 'utf8',
      timeout: Number(options.timeoutMs ?? DEFAULT_PS_TIMEOUT_MS),
      maxBuffer: MAX_PS_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    });
    if (result.status !== 0 || result.error || !result.stdout?.trim()) {
      return { ok: false, reason: 'process-start-time-unavailable', processes: new Map() };
    }
    const processes = normalizeRows(parseProcessRows(result.stdout));
    if (!processes?.size) {
      return { ok: false, reason: 'process-start-time-unavailable', processes: new Map() };
    }
    return { ok: true, reason: null, processes };
  } catch {
    return { ok: false, reason: 'process-start-time-unavailable', processes: new Map() };
  }
}

export function walkProcessIdentityChain(startPid, options = {}) {
  const pid = positivePid(startPid);
  if (!pid) return { ok: false, reason: 'missing-coordinator-pid', chain: [], processes: new Map() };
  const table = options.processes instanceof Map
    ? { ok: options.processes.size > 0, reason: options.processes.size ? null : 'process-start-time-unavailable', processes: options.processes }
    : readProcessIdentityTable(options);
  if (!table.ok) return { ok: false, reason: table.reason, chain: [], processes: table.processes };

  const maximum = Number(options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxDepth = Number.isSafeInteger(maximum) && maximum > 0
    ? Math.min(maximum, DEFAULT_MAX_DEPTH)
    : DEFAULT_MAX_DEPTH;
  const chain = [];
  const visited = new Set();
  let current = pid;
  let truncated = false;
  while (current > 1 && chain.length < maxDepth) {
    if (visited.has(current)) {
      return { ok: false, reason: 'process-chain-cycle', chain: [], processes: table.processes };
    }
    visited.add(current);
    const processInfo = table.processes.get(current);
    if (!processInfo) {
      return {
        ok: false,
        reason: chain.length ? 'process-chain-incomplete' : 'process-start-time-unavailable',
        chain: [],
        processes: table.processes
      };
    }
    chain.push({ pid: processInfo.pid, startTimeMs: processInfo.startTimeMs });
    current = processInfo.ppid;
  }
  if (current > 1) truncated = true;
  if (!chain.length) {
    return { ok: false, reason: 'process-start-time-unavailable', chain: [], processes: table.processes };
  }
  return { ok: true, reason: null, chain, truncated, processes: table.processes };
}

export function processIdentityIsAlive(identity, processes) {
  const pid = positivePid(identity?.pid);
  const startTimeMs = startTime(identity?.startTimeMs);
  if (!pid || !startTimeMs || !(processes instanceof Map)) return false;
  const current = processes.get(pid);
  return current?.startTimeMs === startTimeMs;
}
