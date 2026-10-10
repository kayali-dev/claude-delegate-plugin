// Shared with the Node boundary. Only public text blocks are selected; tool
// payloads, opaque handles, reasoning and credentials never enter a packet.
export function cleanContextText(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, '[REDACTED]')
    .replace(/((?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH_?TOKEN|REFRESH_?TOKEN)[A-Z0-9_]*)["']?\s*[:=]\s*)["']?[^"'\s,;]+/gi, '[REDACTED credential]')
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/g, '://[REDACTED]@')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function contextCandidates(messages) {
  const rows = Array.isArray(messages) ? messages.slice(-24) : [];
  return rows.map((row, index) => {
    if (!['user', 'assistant'].includes(row?.role) || typeof row.text !== 'string') return null;
    const source = row.text.slice(0, 65536);
    const safe = cleanContextText(source);
    return { id: `excerpt-${index}`, role: row.role, text: safe.slice(0, 2000),
      truncated: safe.length > 2000 || source.length !== row.text.length, redacted: safe !== source };
  }).filter((row) => row?.text.trim());
}

export function agentMetadata(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.slice(0, 128).map((agent) => ({ id: agent.id, status: agent.status,
    type: cleanContextText(agent.type).slice(0, 128),
    description: cleanContextText(agent.description).slice(0, 128),
    ...(agent.parentId ? { parentId: agent.parentId } : {}) }));
}

export function attentionRows(snapshot) {
  return (snapshot?.jobs || []).filter((job) => job.pendingInput || job.acceptance === 'ready-for-review'
    || job.acceptance === 'blocked' || job.status === 'failed' || job.scopeViolationCount > 0).slice(0, 8);
}

export function managedResultId(result, depth = 0) {
  if (depth > 3 || !result || typeof result !== 'object') return null;
  const candidate = result.jobId || result.id;
  if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(candidate)) return candidate;
  for (const value of [result.result, result.structuredContent]) {
    const found = managedResultId(value, depth + 1); if (found) return found;
  }
  for (const content of (Array.isArray(result.content) ? result.content.slice(0, 8) : [])) {
    if (typeof content.text !== 'string' || content.text.length > 160000) continue;
    try { const found = managedResultId(JSON.parse(content.text), depth + 1); if (found) return found; } catch {}
  }
  return null;
}
