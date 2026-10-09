# Delegate Router Runtime Guide

Read `../../AGENTS.md` first. It is the canonical contributor guide for architecture, security invariants, testing, releases, and installation. This file adds instructions scoped to `plugins/delegate-router`.

## Runtime Boundaries

- Keep this package dependency-free and compatible with Node.js 18 or later.
- Use ESM and Node built-ins. Executable files under `bin/` must retain their Node shebang and executable mode.
- Keep MCP messages on stdout as newline-delimited JSON. Send diagnostics to stderr so provider or MCP framing is never corrupted.
- Treat provider messages, tool data, paths, and diffs as untrusted. Redact and bound data before persisting or returning it.
- Preserve private file modes, atomic state replacement, optimistic revisions, idempotent controls, and bounded process/RPC deadlines.
- Keep transport semantics honest: Codex supports same-turn steering; Cursor correction is cancel-and-resume.
- Never expose a provider that `enabledProviders()` reports as disabled.

## Change Map

- Job schema, journals, locks, artifacts, redaction, or derived views: `bin/lib/control.mjs` plus `test/control.test.mjs`.
- Codex app-server or Cursor ACP/headless lifecycle: `bin/lib/providers.mjs` plus `test/providers.test.mjs` and fake servers.
- JSON-RPC framing and timeouts: `bin/lib/jsonrpc.mjs` plus `test/jsonrpc.test.mjs`.
- Routing and model fit: `bin/lib/router.mjs`, `bin/lib/models.mjs`, `bin/lib/cursor.mjs`, their focused tests, and `skills/delegate/references/models.md`. Preserve explicit pins, provider gates, lane admission, and per-task Fable authorization when refreshing aliases.
- Provider configuration or allowance state: `bin/lib/state.mjs`, `test/config.test.mjs`, and `test/state-hook.test.mjs`.
- Public MCP tools: `bin/delegate-control-mcp`, `.mcp.json`, `test/control-mcp.test.mjs`, and `skills/delegate/SKILL.md`.
- CLI behavior: update the executable, its help text, README examples, and focused tests together.
- Native Mods: `hooks/native.tsx`, `hooks/native-view.mjs`, `hooks/native-data.mjs`, `bin/lib/native-bridge.mjs`, `test/native-bridge.test.mjs`, `test/native-workflows.test.mjs`, `native-tests/dashboard.test.ts`, and `skills/delegate/references/native.md`. Keep fixed-action subprocess calls, human confirmation, controller-session controls, immutable launch attribution, and CLI/MCP fallbacks. Read the current primary Mods documentation before changing host API calls; do not import Node built-ins into a Mod.

## Verification

Run `npm test` after every runtime change and `npm run test:native` for native Mods on Claude Code 2.1.294+. Run `../../install.sh --check` before declaring the marketplace ready; it runs both suites and validates the manifests. Use fake providers for regression coverage; native tests stub all host processes/questions and spend no model allowance. Use live providers only when explicitly requested and report the allowance and user-state impact.

For installable changes, follow the version and reinstall checklist in `../../AGENTS.md`. Do not patch `~/.claude/plugins/cache` to make a test pass.
