# Delegate Router Runtime

This directory is the dependency-free runtime for the Delegate Router Claude Code plugin. Marketplace-level installation and general usage live in the repository README.

Inside Claude Code, install directly from the marketplace:

```text
/plugin install delegate-router --marketplace kayali-dev/claude-delegate-plugin
```

Install from the marketplace root with `./install.sh --codex-only`,
`--cursor-only`, or `--both`; preserve your provider choice. See the
[installation guide](../../README.md#installation) for prerequisites and reloads.

## Live terminal dashboard

Run `delegate-tui` in an interactive macOS or Linux terminal for an attention-first home dashboard, the complete live fleet, job details, provider allowances and writer ownership, seven-day stats, safe job controls, and a dry-run-gated launcher. The command reads the same state selected by `DELEGATE_STATE_FILE`; press `F` for Fleet and use `Esc` to walk back toward Dashboard. `--help` is safe in scripts, while a non-TTY launch exits 2.

The dashboard is deliberately read-mostly. Mutations use the broker's revisioned control/resume/launch/revert functions; cancel and revert require the job-id suffix, revert always displays its dry-run plan, and dangerous sandbox/approval/writer overrides are not exposed.

See [the full screen and key reference](skills/delegate/references/tui.md).
