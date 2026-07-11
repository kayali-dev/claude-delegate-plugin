#!/usr/bin/env bash
# One-command rollout: test, validate, push, and update the installed plugin.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$ROOT/plugins/delegate-router"

cd "$ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Working tree is dirty; commit (or stash) before releasing.\n' >&2
  exit 1
fi

(cd "$PLUGIN" && node --test test/*.test.mjs)
claude plugin validate "$ROOT"
claude plugin validate "$PLUGIN"

git push origin main
claude plugin marketplace update delegate-skill
claude plugin update delegate-router@delegate-skill --scope user \
  || claude plugin install delegate-router@delegate-skill

claude plugin list 2>/dev/null | grep -A2 'delegate-router@delegate-skill' || true
DELEGATE_SHIM_DEBUG=1 "$HOME/.local/bin/delegate-health" --quick 2>&1 | head -2
printf '\nReleased. Running Claude Code sessions keep the old version; new sessions (or /reload-plugins) pick this one up.\n'
