# Delegate Router Contributor Guide

## Scope

This directory is a portable Claude Code marketplace. The implementation lives in `plugins/delegate-router`; the top-level `install.sh` registers and installs it.

Treat this checkout as the source of truth. Never edit generated copies under `~/.claude/plugins/cache`, marketplace clones under `~/.claude/plugins/marketplaces`, or runtime state under `${XDG_STATE_HOME:-~/.local/state}/delegate-router` to implement a source change.

## Product Contract

Delegate Router keeps Claude as coordinator and final reviewer while routing bounded work to enabled providers:

- Codex through app-server v2 for managed jobs and `codex mcp-server` as a foreground fallback.
- Cursor through ACP v1, with a headless compatibility fallback.
- Claude in the current session or a built-in subagent when handoff is not worthwhile.

Provider configuration is authoritative. Installations may enable Codex only, Cursor only, or both. OpenAI's official `codex@openai-codex` Claude plugin is optional and has a separate lifecycle from managed Delegate Router jobs.

## Layout

- `install.sh`: validates prerequisites, persists provider selection, registers marketplaces, installs plugins, and links user-facing commands.
- `plugins/delegate-router/.claude-plugin/plugin.json`: Claude plugin manifest and release version.
- `plugins/delegate-router/.mcp.json`: managed control and conditional native Codex MCP registrations.
- `plugins/delegate-router/hooks/hooks.json`: quota guard hooks.
- `plugins/delegate-router/skills/delegate/`: routing instructions and protocol, model, control, and usage references.
- `plugins/delegate-router/bin/delegate-control-mcp`: MCP tool surface for supervised jobs.
- `plugins/delegate-router/bin/delegate-worker`: detached provider worker entrypoint.
- `plugins/delegate-router/bin/lib/control.mjs`: durable jobs, events, artifacts, redaction, revisions, and control inbox.
- `plugins/delegate-router/bin/lib/providers.mjs`: Codex app-server and Cursor ACP/headless supervision.
- `plugins/delegate-router/bin/lib/jsonrpc.mjs`: newline-delimited JSON-RPC process client and deadlines.
- `plugins/delegate-router/bin/lib/router.mjs`: deterministic task/model/provider routing.
- `plugins/delegate-router/bin/lib/state.mjs`: provider configuration, allowance snapshots, and invocation history.
- `plugins/delegate-router/bin/lib/cursor.mjs`: Cursor executable/model discovery and headless command construction.
- `plugins/delegate-router/test/`: dependency-free Node test suite with fake Codex and Cursor servers.

## Non-Negotiable Invariants

### Security And Privacy

- Never persist hidden model reasoning or raw provider payloads.
- Redact credentials in structured fields and embedded text before journaling. Keep numeric usage fields useful without exposing numeric or boolean secrets.
- Create state, prompts, logs, command files, and spilled diff artifacts with user-only permissions.
- Bound persisted strings. Spill large diffs into private, content-addressed or sequence-addressed artifacts rather than bloating event journals.
- Do not collect sensitive files, internal delegation state, binary data, oversized untracked content, or pre-existing untracked contents in Git inventory.
- Do not replace Auto-review with sandbox bypasses. Codex uses `approval_policy=on-request` plus `approvals_reviewer=auto_review`; Cursor uses Smart Auto unless the user explicitly selects force.

### Protocol And Concurrency

- `lastSeq` advances for every event; `revision` advances only for lifecycle and control transitions.
- Steering and cancellation require `expectedRevision`. A stale revision is a conflict to reinspect, never an invitation to overwrite.
- Correction IDs and command IDs must remain idempotent across retries.
- Codex app-server supports genuine same-turn `turn/steer`. Cursor ACP does not: its correction is cancel-and-resume and must be reported as a restart.
- Cursor may fall back to headless only when ACP fails before a session has started. Do not silently downgrade an active ACP session.
- A parent provider session cannot be resumed concurrently while its job remains active.
- Cancellation becomes terminal only after provider acknowledgement or confirmed process exit.
- Allow one writer per shared worktree. Shared-worktree changed-file attribution is best-effort and must be described honestly.

### Reliability And Portability

- Preserve JSON-RPC deadlines, provider timeouts, early crash detection, bounded long polling, and truncated JSONL tail recovery.
- Provider-disabled installations must not expose or invoke that provider through the router or managed MCP tools.
- Keep the runtime dependency-free and compatible with Node.js 18 or later unless a deliberate release changes that contract.
- Resolve installation paths through `${CLAUDE_PLUGIN_ROOT}` or script-relative paths. Never embed this machine's home directory.
- Support both Cursor executable names, `agent` first and `cursor-agent` second, plus `DELEGATE_CURSOR_BIN`.
- On macOS, preserve the login-shell Cursor launch path needed for keychain-backed authentication.

## Development Workflow

1. Read `README.md`, the relevant file under `skills/delegate/references`, and the surrounding tests before changing behavior.
2. Inspect the worktree and preserve unrelated user changes. Do not edit the installed cache to test a source fix.
3. Add or update focused tests. Use the fake provider servers for protocol behavior; do not spend live model allowance unless the user explicitly requests an integration test.
4. Run the full dependency-free suite:

   ```bash
   cd plugins/delegate-router
   npm test
   ```

5. Validate the marketplace and plugin from the marketplace root:

   ```bash
   ./install.sh --check
   ```

6. For install or health changes, exercise every affected provider mode and run `delegate-health --quick --json`. Installation mutates user-level Claude configuration, so do it only when requested or approved.

Test ownership follows the implementation boundaries:

- Routing and model selection: `router.test.mjs`.
- Usage, quota hooks, and persisted state: `state-hook.test.mjs` and `config.test.mjs`.
- Journals, revisions, redaction, artifacts, and derived views: `control.test.mjs`.
- MCP schemas and dispatch: `control-mcp.test.mjs`.
- JSON-RPC framing, deadlines, and process failure: `jsonrpc.test.mjs`.
- Provider event mapping, steering, cancellation, and fallback: `providers.test.mjs`.
- Cursor discovery and command behavior: `cursor.test.mjs`.
- Manifest portability and release alignment: `package.test.mjs`.

## Release And Installation

Claude caches plugins by marketplace, plugin name, and version. Bump the plugin version for every installable behavior change; otherwise `plugin update` may keep an older cached implementation.

Keep these version locations aligned:

- `plugins/delegate-router/package.json`
- `plugins/delegate-router/.claude-plugin/plugin.json`
- `plugins/delegate-router/test/package.test.mjs`
- MCP `serverInfo` values in `bin/delegate-control-mcp` and `bin/delegate-codex-mcp`
- Provider client metadata in `bin/lib/providers.mjs`

Search for the old version before finishing so no runtime metadata is missed. Do not change the independent `delegate-usage` client version unless its protocol identity actually changes.

After tests and validation pass, reinstall from the marketplace root with the user's intended mode:

```bash
./install.sh --both
./install.sh --codex-only
./install.sh --cursor-only
```

Add `--lean` only when the optional official OpenAI Codex Claude plugin should be skipped. Preserve the user's provider choice rather than assuming `--both`. Reload Claude plugins or start a new Claude session, then verify the installed version, enabled providers, MCP tool exposure, and health. Never delete `~/delegate-skill` after installation while the marketplace and `~/.local/bin/delegate-*` symlinks still point to it.

## Documentation And Research

Keep `README.md`, skill instructions, CLI help, MCP schemas, and tests synchronized with behavior. Model names, CLI flags, provider protocols, quotas, and marketplace behavior are time-sensitive; verify them against current primary documentation before changing those claims.

When work is complete, report source files changed, tests and validation run, installation/reload actions, current provider mode, and any live integration checks that were intentionally skipped.
