const DETAIL_MUTATIONS = new Set(['s', 'r', 'R', 'n', 'c', 'v', 'w']);
const LAUNCHER_MUTATIONS = new Set(['enter', 'left', 'right', 'd', 'y', 'e']);

export function remoteActionMessage(ui = {}, key, job = null) {
  if (!ui.remote?.enabled && !job?.readOnly) return null;
  const remoteOnly = ui.remote?.enabled && !ui.remote?.includeLocal;
  const remoteRow = job?.remote === true;
  if ((key === 'N' && remoteOnly)
    || (ui.screen === 'detail' && DETAIL_MUTATIONS.has(key) && (remoteRow || remoteOnly))
    || (ui.screen === 'launcher' && LAUNCHER_MUTATIONS.has(key) && remoteOnly)) {
    return 'read-only remote: control actions are disabled';
  }
  return null;
}

export function directTransportActionMessage(ui = {}, key, job = null) {
  if (ui.screen !== 'detail' || !DETAIL_MUTATIONS.has(key)) return null;
  if (!['direct-mcp', 'direct-cli', 'direct-acp', 'external', 'claude-agent'].includes(job?.transport)) return null;
  return job?.transport === 'external' ? 'read-only: external Codex thread'
    : job?.transport === 'claude-agent' ? 'read-only: Claude Agent stub'
      : 'read-only: direct-transport job';
}
