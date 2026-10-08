#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$ROOT/plugins/delegate-router"
LEAN=false
CHECK=false
PROVIDER_MODE=both
PROVIDER_MODE_SET=false

usage() {
  cat <<'EOF'
Usage: ./install.sh [provider mode] [--lean]

Provider modes (choose at most one):
  --both          Enable Codex and Cursor (default only on a new installation)
  --codex-only    Enable Codex only
  --cursor-only   Enable Cursor only

Other options:
  --lean          Skip the optional official OpenAI Codex Claude plugin
  --check         Validate the marketplace/plugin and run tests without installing
  -h, --help      Show this help
EOF
}

set_provider_mode() {
  local requested="$1"
  if [[ "$PROVIDER_MODE_SET" == true && "$PROVIDER_MODE" != "$requested" ]]; then
    printf 'Choose only one provider mode.\n' >&2
    exit 2
  fi
  PROVIDER_MODE="$requested"
  PROVIDER_MODE_SET=true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --both) set_provider_mode both ;;
    --codex-only) set_provider_mode codex ;;
    --cursor-only) set_provider_mode cursor ;;
    --lean) LEAN=true ;;
    --check) CHECK=true ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for command_name in claude node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' || {
  printf 'Node.js 18 or later is required.\n' >&2
  exit 1
}

CLAUDE_VERSION="$(claude --version)"
node -e 'const m = process.argv[1].match(/\b(\d+)\.(\d+)\.(\d+)\b/); const v = m?.slice(1).map(Number); if (!v || v[0] < 2 || (v[0] === 2 && (v[1] < 1 || (v[1] === 1 && v[2] < 294)))) process.exit(1)' "$CLAUDE_VERSION" || {
  printf 'Claude Code 2.1.294 or later is required for native Mods. Found: %s\n' "$CLAUDE_VERSION" >&2
  exit 1
}

if [[ "$CHECK" == true ]]; then
  claude plugin validate "$ROOT"
  claude plugin validate "$PLUGIN"
  (cd "$PLUGIN" && npm test && npm run test:native)
  exit 0
fi

if [[ "$PROVIDER_MODE_SET" == false ]]; then
  PROVIDER_MODE="$(node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { enabledProviders } = await import(pathToFileURL(process.argv[1])); const enabled = enabledProviders(); console.log(enabled.length === 2 ? "both" : enabled[0])' "$PLUGIN/bin/lib/state.mjs" 2>/dev/null)" || {
    printf 'Cannot read provider selection. Inspect delegate-config show or select an explicit provider mode.\n' >&2
    exit 1
  }
fi

if [[ "$PROVIDER_MODE" == codex || "$PROVIDER_MODE" == both ]]; then
  if ! command -v codex >/dev/null 2>&1; then
    printf 'Missing required command for Codex mode: codex\n' >&2
    exit 1
  fi
fi

if [[ "$PROVIDER_MODE" == cursor || "$PROVIDER_MODE" == both ]]; then
  if ! command -v agent >/dev/null 2>&1 && ! command -v cursor-agent >/dev/null 2>&1; then
    printf 'Missing Cursor CLI: install either agent or cursor-agent.\n' >&2
    exit 1
  fi
fi

node "$PLUGIN/bin/delegate-config" providers "$PROVIDER_MODE" >/dev/null
claude plugin marketplace add kayali-dev/claude-delegate-plugin || claude plugin marketplace add "$ROOT" || true

if [[ "$PROVIDER_MODE" != cursor && "$LEAN" == false ]]; then
  claude plugin marketplace add openai/codex-plugin-cc || true
  if ! claude plugin install codex@openai-codex; then
    printf 'Warning: optional OpenAI Codex plugin installation failed; managed app-server and native Codex MCP remain available.\n' >&2
  fi
fi

claude plugin install delegate-router@delegate-skill
claude plugin update delegate-router@delegate-skill --scope user || true

USER_BIN="${DELEGATE_USER_BIN:-$HOME/.local/bin}"
node "$PLUGIN/bin/delegate-bootstrap"

printf '\nInstalled delegate-router with providers: %s.\n' "$PROVIDER_MODE"
if [[ "$PROVIDER_MODE" != cursor ]]; then
  if [[ "$LEAN" == true ]]; then
    printf 'Lean mode: skipped the optional official OpenAI Codex Claude plugin.\n'
  else
    printf 'Full Codex integration: requested the optional official OpenAI Codex Claude plugin.\n'
  fi
  printf 'Run delegate-usage refresh codex after the plugin is loaded.\n'
fi
printf 'Restart Claude Code or run /reload-plugins.\n'
if [[ ":$PATH:" != *":$USER_BIN:"* ]]; then
  printf 'Add %s to PATH to use delegate-* commands outside Claude Code.\n' "$USER_BIN"
fi
