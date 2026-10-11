export const MCP_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

// The 2026 revision changes the wire protocol. Do not advertise it merely
// because a new Claude Code client asks: it can negotiate this JSON-RPC lane.
export function negotiateMcpVersion(requested) {
  return MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0];
}

const READ_TOOLS = new Set([
  'delegate_inspect', 'delegate_list', 'delegate_stats', 'delegate_events',
  'delegate_transcript', 'delegate_diff', 'delegate_files', 'delegate_usage', 'delegate_work', 'delegate_notification_health'
]);

export function toolAnnotations(name) {
  const readOnly = READ_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    idempotentHint: readOnly,
    openWorldHint: !readOnly
  };
}

export const MCP_INSTRUCTIONS = 'Delegate Router supervises bounded Codex and Cursor work while Claude remains coordinator and final reviewer. Search these tools to start, inspect, correct or cancel a managed job, answer its pending input, or review its diff and verification. Enabled provider configuration is authoritative. Writes are plan-first and require human confirmation. Inspect the current revision before any control; retain command IDs across retries. Completion is not acceptance. Native commands /delegate-dashboard and /delegate-status show local work without a model turn. Native notifications are the default; no startup or standby monitor. Check delegate_notification_health while supervising live jobs or if native delivery fails. If needsFallback is true, invoke delegate-router:monitor-fallback yourself; do not require the user to remember it or override explicit opt-outs. In explicitly configured legacy-persistent mode invoke delegate-router:legacy-monitor once if not already armed. Never change sandbox, scope or budget to work around a refusal.';
