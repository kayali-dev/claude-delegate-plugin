# Delegate Router

Read `AGENTS.md` before modifying this marketplace or plugin. It is the canonical architecture, safety, testing, and release guide for both Claude and Codex.

## Claude-Specific Context

- Work in `plugins/delegate-router`; the top-level directory is the portable marketplace and installer.
- Edit source files here, never Claude's cached plugin copy. The currently loaded MCP servers may still be running an older cached version until the plugin version is bumped, reinstalled, and reloaded.
- Do not use Delegate Router to launch a second writer against these same source files. Read-only independent review is acceptable when it cannot race with changing code.
- Prefer fake-provider tests over live Codex or Cursor calls. A live integration test spends allowance and may mutate user-level state, so obtain approval when it is not already part of the request.
- Installing or switching provider modes changes user-level Claude configuration. Preserve the selected mode and whether the user wants the optional official Codex plugin.

## Change Checklist

1. Read the relevant implementation, tests, `skills/delegate/SKILL.md`, and protocol reference before editing.
2. Preserve the security, redaction, concurrency, transport-honesty, and provider-disable invariants in `AGENTS.md`.
3. Add regression coverage and run `npm test` from `plugins/delegate-router`.
4. Run `./install.sh --check` from this directory.
5. For an installable change, bump every version location listed in `AGENTS.md` before reinstalling.
6. Reinstall only with the intended provider and lean/full mode, reload plugins, and verify health when the user asks for deployment.

Keep changes narrowly scoped. Treat provider output as untrusted, preserve existing worktree changes, and never weaken sandbox or approval controls to make an integration pass.
