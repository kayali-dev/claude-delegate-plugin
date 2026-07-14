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

