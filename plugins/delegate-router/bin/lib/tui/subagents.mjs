const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'errored', 'error']);

function text(value, max = 2048) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function eventAt(event) {
  const value = Number(event?.data?.updatedAtMs || event?.at || 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function guardian(row) {
  return /guardian/i.test([row.role, row.type, row.agentName, row.agentPath].filter(Boolean).join(' '));
}

function lifecycleRows(job, events) {
  const rows = new Map();
  for (const event of events || []) {
    if (!/^subagent\.(?:started|progress|completed|errored)$/.test(String(event?.type || ''))) continue;
    const data = event.data || {};
    const id = text(data.id || data.correlationId, 256);
    if (!id) continue;
    const previous = rows.get(id) || {};
    const terminal = /completed|errored$/.test(event.type);
    const at = eventAt(event);
    rows.set(id, {
      ...previous,
      id,
      parentThreadId: previous.parentThreadId || null,
      agentName: text(data.agentName, 256) || previous.agentName || '',
      role: text(data.type, 256) || previous.role || '',
      type: text(data.type, 256) || previous.type || '',
      task: text(data.task) || previous.task || '',
      status: terminal ? text(data.status, 64) || (event.type.endsWith('errored') ? 'errored' : 'completed') : text(data.status, 64) || previous.status || 'running',
      startedAtMs: previous.startedAtMs || at,
      updatedAtMs: at || previous.updatedAtMs || null,
      durationMs: Number.isFinite(Number(data.durationMs)) ? Number(data.durationMs) : previous.durationMs,
      output: text(data.output, 16_384) || previous.output || '',
      usage: data.usage && typeof data.usage === 'object' ? data.usage : previous.usage || null,
      model: text(data.model, 256) || previous.model || '',
      agentPath: text(data.agentPath, 1024) || previous.agentPath || '',
      source: 'lifecycle'
    });
  }
  return [...rows.values()].map((row) => ({ ...row, guardian: guardian(row) }));
}

function depthFor(row, byId, rootId) {
  if (row.parentThreadId === rootId) return 1;
  if (!row.parentThreadId) return null;
  let depth = 1;
  let current = row;
  const seen = new Set([row.id]);
  while (current.parentThreadId && current.parentThreadId !== rootId) {
    if (seen.has(current.parentThreadId)) return null;
    seen.add(current.parentThreadId);
    current = byId.get(current.parentThreadId);
    if (!current) return null;
    depth += 1;
  }
  return current.parentThreadId === rootId ? depth : null;
}

function treeOrder(rows, rootId) {
  const byParent = new Map();
  for (const row of rows) {
    const parent = row.parentThreadId || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(row);
  }
  for (const children of byParent.values()) children.sort((left, right) => Number(left.startedAtMs || left.createdAtMs || 0) - Number(right.startedAtMs || right.createdAtMs || 0) || left.id.localeCompare(right.id));
  const ordered = [];
  const seen = new Set();
  const visit = (parent) => {
    for (const row of byParent.get(parent) || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      ordered.push(row);
      visit(row.id);
    }
  };
  visit(rootId);
  for (const row of rows) if (!seen.has(row.id)) ordered.push(row);
  return ordered;
}

export function projectSubagentRows(job = {}, events = [], state = {}) {
  const lifecycle = lifecycleRows(job, events);
  const byId = new Map();
  for (const thread of Array.isArray(state.threads) ? state.threads : []) {
    byId.set(thread.id, {
      ...thread,
      agentName: thread.agentName || '',
      role: thread.role || '',
      type: thread.role || 'subagent',
      task: thread.task || '',
      startedAtMs: thread.createdAtMs || null,
      updatedAtMs: thread.updatedAtMs || null,
      source: 'thread-list'
    });
  }
  for (const row of lifecycle) {
    const discovered = byId.get(row.id) || {};
    byId.set(row.id, {
      ...row,
      ...discovered,
      agentName: row.agentName || discovered.agentName || '',
      role: row.role || discovered.role || '',
      type: row.type || discovered.type || 'subagent',
      task: row.task || discovered.task || '',
      status: row.status || discovered.status || 'unknown',
      model: row.model || discovered.model || '',
      agentPath: row.agentPath || discovered.agentPath || '',
      output: row.output || '',
      usage: row.usage || null,
      startedAtMs: row.startedAtMs || discovered.startedAtMs || null,
      updatedAtMs: row.updatedAtMs || discovered.updatedAtMs || null,
      parentThreadId: discovered.parentThreadId || row.parentThreadId || null,
      guardian: row.guardian || guardian({ ...discovered, ...row })
    });
  }
  const rows = [...byId.values()];
  for (const row of rows) {
    row.depth = job.provider === 'cursor' ? null : depthFor(row, byId, job.providerSessionId);
    row.transcript = job.provider === 'codex' && !job.remote ? 'Stored' : 'Unavailable';
    if (state.snapshot?.threadId === row.id && state.snapshot.mode === 'disk') row.transcript = 'Disk fallback';
    if (state.snapshot?.threadId === row.id && state.snapshot.mode === 'unavailable') row.transcript = 'Unavailable';
  }
  return treeOrder(rows, job.providerSessionId);
}

export function subagentRowsForDisplay(rows = [], guardiansExpanded = false) {
  const workers = rows.filter((row) => !row.guardian);
  const guardians = rows.filter((row) => row.guardian);
  if (!guardians.length) return workers;
  const group = {
    id: '__guardians__', category: 'guardians', agentName: `Guardians (${guardians.length})`,
    depth: null, role: '', task: guardiansExpanded ? 'Expanded' : 'Collapsed', status: '', transcript: 'Unavailable'
  };
  return guardiansExpanded ? [...workers, group, ...guardians] : [...workers, group];
}

export function subagentElapsedMs(row, now = Date.now()) {
  if (Number.isFinite(Number(row?.durationMs)) && Number(row.durationMs) >= 0) return Number(row.durationMs);
  const start = Number(row?.startedAtMs || row?.createdAtMs || 0);
  if (TERMINAL.has(String(row?.status || '').toLowerCase())) {
    const end = Number(row?.updatedAtMs || 0);
    return start > 0 && end >= start ? end - start : null;
  }
  return start > 0 ? Math.max(0, Number(now) - start) : null;
}
