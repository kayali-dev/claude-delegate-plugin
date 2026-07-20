const DETAIL_MUTATIONS = new Set(['s', 'r', 'R', 'n', 'c', 'v', 'w']);
const LAUNCHER_MUTATIONS = new Set(['enter', 'left', 'right', 'd', 'y', 'e']);

export function remoteActionMessage(ui = {}, key) {
  if (!ui.remote?.enabled) return null;
  if (key === 'N' || (ui.screen === 'detail' && DETAIL_MUTATIONS.has(key))
    || (ui.screen === 'launcher' && LAUNCHER_MUTATIONS.has(key))) {
    return 'read-only remote: control actions are disabled';
  }
  return null;
}

export function directTransportActionMessage(ui = {}, key, job = null) {
  if (ui.screen !== 'detail' || !DETAIL_MUTATIONS.has(key)) return null;
  if (!['direct-mcp', 'direct-cli', 'direct-acp'].includes(job?.transport)) return null;
  return 'read-only: direct-transport job';
}
