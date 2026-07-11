# Delegate Skill

A portable Claude Code marketplace containing `delegate-router`. The plugin keeps Claude in charge while it deterministically routes bounded work to:

- Codex through the official `codex mcp-server`, with thread continuation and Auto-review. OpenAI's official Claude Code plugin is installed by default for background review, rescue, status, result, and cancellation.
- Cursor through either `agent` or `cursor-agent`, using Composer 2.5+ and Grok 4.5.
- Claude subagents or the current Claude session when handoff cost or task fit makes Claude the better route.

The router records delegation history and provider headroom without pretending local token estimates are provider quota. Codex limits can be refreshed from its app server, Claude limits can be captured from status-line input, and Cursor usage can be entered from the Cursor dashboard. Hard quota gates block new Codex and Cursor work above the configured threshold.

Managed Codex and Cursor jobs support durable event journals, live inspection, user-visible transcripts, tool activity, changed-file and diff views, observed usage, provider-aware cancellation, resumable sessions, and corrections. Codex uses app-server for true same-turn steering. Cursor uses ACP v1 and reports corrections honestly as cancel-and-resume restarts.

## Requirements

- Claude Code 2.1.143 or later
- Node.js 18 or later
- Codex mode: `codex` authenticated and on `PATH`
- Cursor mode: `agent` or `cursor-agent` authenticated and on `PATH`

## Install

One step, no clone required:

```bash
claude plugin marketplace add kayali-dev/claude-delegate-plugin && claude plugin install delegate-router@delegate-skill
```

Or from inside Claude Code:

```text
/plugin marketplace add kayali-dev/claude-delegate-plugin
/plugin install delegate-router@delegate-skill
```

Start a new Claude Code session, or run `/reload-plugins`. That is all: on session start the plugin links the `delegate-*` commands into `${DELEGATE_USER_BIN:-~/.local/bin}` automatically (links self-heal after every update — keep that directory on `PATH`). Both providers are enabled by default; to restrict:

```bash
delegate-config providers codex     # or: cursor, both
```

Invoke explicitly with:

```text
/delegate-router:delegate mode=review scope=src task="Review the authentication changes"
```

Claude may also select the skill automatically when a task matches its description.

Codex users can optionally add OpenAI's official Claude Code plugin for its background review/rescue commands; managed Codex app-server supervision and the native Codex MCP work without it:

```bash
claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex
```

### Advanced: scripted install from a checkout

`./install.sh` wraps the same steps for a cloned checkout and adds provider-mode presets (`--both`, `--codex-only`, `--cursor-only`), prerequisite checks, and the optional official Codex plugin (skip it with `--lean`). For local development without installation:

```bash
claude --plugin-dir "$HOME/delegate-skill/plugins/delegate-router"
```

## Usage Headroom

```bash
delegate-usage refresh codex
delegate-usage set cursor 84 --source dashboard
delegate-usage set claude 72 --window seven_day --source usage-command
delegate-usage show
```

Inspect provider health and calculate a route without spending model allowance:

```bash
delegate-health
delegate-route --mode review --task "Review the authentication changes"
```

Preview a Cursor delegation without spending allowance:

```bash
delegate-cursor --dry-run --model grok --mode review --cwd "$PWD" --prompt "Review the current diff"
```

Start and supervise a managed task directly from a normal terminal:

```bash
delegate-jobs start --provider codex --model sol --mode review --cwd "$PWD" --prompt "Review the current diff" --timeout-seconds 7200
delegate-jobs start --provider cursor --model composer --mode implement --cwd "$PWD" --prompt-file ./plan.md
delegate-jobs status
delegate-jobs inspect <job-id>
delegate-jobs events <job-id> --after 0 --follow
delegate-jobs transcript <job-id> --limit 200
delegate-jobs wait <job-id> --timeout-seconds 3600
delegate-jobs diff <job-id>
delegate-jobs files <job-id>
delegate-jobs steer <job-id> --expected-revision <n> --strategy auto --prompt "Correction"
delegate-jobs usage <job-id>
delegate-jobs result <job-id>
delegate-jobs cancel <job-id> --expected-revision <n>
delegate-jobs prune --max-age-days 14
```

Within Claude Code, the skill uses the `delegate_control` MCP server. `delegate_start` returns immediately; Claude advances the `afterSeq` cursor only when monitoring is useful and uses the latest revision for steering or cancellation. Workers are detached from the MCP process, so plugin reloads do not erase their job state.

The original `delegate-cursor` headless adapter remains available for compatibility, foreground scripts, and machines where Cursor ACP is unavailable. Its detached `--background` mode uses the same job directory but has less semantic event fidelity.

The default Cursor write policy is Smart Auto review inside Cursor's sandbox. Unrestricted `--force` requires `--approval force`. Sensitive files are denied by the task contract unless `--allow-sensitive` is explicitly supplied.

## Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `DELEGATE_WARNING_PERCENT` | `80` | Prefer an equivalent fallback above this usage level |
| `DELEGATE_AVOID_PERCENT` | `90` | Block new work on a provider at or above this level |
| `DELEGATE_ALLOW_OVER_LIMIT` | empty | Comma-separated explicit overrides such as `codex,cursor` |
| `DELEGATE_ENABLED_PROVIDERS` | installed config | Temporary comma-separated override such as `codex` or `cursor` |
| `DELEGATE_PROVIDER_CONFIG` | state directory | Override the persistent provider configuration file |
| `DELEGATE_CURSOR_TIMEOUT_SECONDS` | `3600` | Cursor hard timeout when a job sets no `timeoutSeconds`, bounded to 10-86400 seconds |
| `DELEGATE_CODEX_TIMEOUT_SECONDS` | `3600` | Managed Codex job timeout when a job sets no `timeoutSeconds`, bounded to 10-86400 seconds |
| `DELEGATE_JOB_RETENTION_DAYS` | `14` | Prune terminal job records older than this many days |
| `DELEGATE_RPC_TIMEOUT_MS` | `30000` | Startup and control JSON-RPC request deadline |
| `DELEGATE_ACP_GRACE_MS` | `250` | Bounded 0-2000ms grace period for late Cursor ACP events |
| `DELEGATE_CURSOR_BIN` | auto | Override `agent` / `cursor-agent` discovery |
| `DELEGATE_CURSOR_LOGIN_SHELL` | `1` on macOS | Set `0` to launch Cursor ACP directly instead of through the login shell |
| `DELEGATE_CURSOR_COMPOSER_MODEL` | live newest | Pin a Composer model ID |
| `DELEGATE_CURSOR_GROK_MODEL` | live newest | Pin a Grok model ID |
| `DELEGATE_EVENT_MAX_STRING` | `65536` | Maximum persisted length of any event string before truncation |
| `DELEGATE_STATE_FILE` | XDG state path | Override usage and job state location |

To capture Claude subscription windows (five-hour and weekly) automatically, run:

```bash
delegate-config statusline enable
```

This uses Claude Code's official status-line channel: if a status line is already configured it is wrapped — the payload is forwarded to `delegate-claude-usage --quiet` and the original renders unchanged; if none is configured, a minimal usage status line is installed. `delegate-config statusline disable` restores the previous configuration exactly. Manual `delegate-usage set claude ...` remains valid.

Compliance note: Anthropic's Consumer Terms prohibit using Claude OAuth tokens in any third-party product or service, so this plugin never reads Claude credentials or queries usage endpoints directly. The status line is the sanctioned data channel. Similarly, local token-estimation tools (ccusage, tokscale, and similar) are useful dashboards but are never treated as provider quota.

## Portability

On any machine, run the one-step install above — no clone needed. The session-start bootstrap creates and refreshes the command symlinks under `${DELEGATE_USER_BIN:-~/.local/bin}`; the shim they point at resolves the currently installed plugin version at run time. Provider selection and runtime state live under `${XDG_STATE_HOME:-~/.local/state}/delegate-router` unless overridden. No source file embeds the installation directory.

Managed transcript and diff artifacts remain local and use user-only permissions. Credential assignments and values are redacted, strings are bounded, and hidden reasoning is never journaled. Cursor Git inventory is baseline-aware: sensitive paths, pre-existing untracked files, internal delegation state, binary payloads, and oversized untracked contents are never copied into diff events. Shared dirty worktrees still have best-effort attribution; the coordinator must inspect the actual diff before integration.

See the model evidence and tradeoffs in `plugins/delegate-router/skills/delegate/references/models.md`.

## Development

```bash
cd plugins/delegate-router
npm test
```

The runtime has no npm dependencies.

To ship a change: commit, then run `./release.sh` — it tests, validates, pushes `main`, and updates the installed plugin from the marketplace in one step. Running Claude Code sessions keep the old version; new sessions pick up the release.
