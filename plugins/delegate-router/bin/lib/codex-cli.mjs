import { spawnSync } from 'node:child_process';

export const LEGACY_CODEX_MCP_NOTE = 'The installed Codex CLI does not advertise the legacy mcp-server command. Use delegate_control managed app-server tools instead; no model turn was started.';

// Never try an unknown subcommand: current Codex treats it as a TUI prompt.
// Inspect top-level help only, with closed stdin and bounded time/output.
export function probeLegacyCodexMcp(binary, { run = spawnSync } = {}) {
  let result;
  try {
    result = run(binary, ['--help'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      windowsHide: true
    });
  } catch {
    return { available: false, reason: 'help-probe-failed', note: LEGACY_CODEX_MCP_NOTE };
  }
  if (result.error || result.status !== 0) {
    return { available: false, reason: 'help-probe-failed', note: LEGACY_CODEX_MCP_NOTE };
  }
  const commands = String(result.stdout || '').split(/^Commands:\s*$/m)[1]?.split(/^\S/m)[0] || '';
  const available = /^\s+mcp-server(?:\s|$)/m.test(commands);
  return {
    available,
    reason: available ? 'command-advertised' : 'command-not-advertised',
    ...(!available ? { note: LEGACY_CODEX_MCP_NOTE } : {})
  };
}
