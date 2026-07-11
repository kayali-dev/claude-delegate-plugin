# Delegate Router Runtime

Read `../../CLAUDE.md`, `../../AGENTS.md`, and this directory's `AGENTS.md` before editing the runtime.

- The source in this directory may differ from the version currently loaded by Claude's plugin cache.
- Do not launch a delegated writer against these same files through the installed router. Read-only review is acceptable when it cannot race with edits.
- Read the relevant protocol reference and regression tests before changing provider or control behavior.
- Preserve redaction, private persistence, provider gating, optimistic concurrency, timeout, cancellation, and transport-honesty guarantees.
- Keep MCP stdout machine-readable and place diagnostics on stderr.
- Run `npm test`, then `../../install.sh --check`.
- Bump all version locations before shipping an installable behavior change, then commit and run `../../release.sh` to push and update the installed plugin. Switch provider modes only when requested, then reload plugins and verify health.
