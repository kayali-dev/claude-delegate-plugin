# Delegate Skill

A portable Claude Code marketplace containing `delegate-router`. The plugin keeps Claude in charge while it deterministically routes bounded work to:

- Codex through app-server v2 for managed jobs. Older CLIs that still advertise `codex mcp-server` retain a legacy foreground fallback; current Codex removed it. Current aliases select GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna, and the cost-balanced GPT-5.6 Terra. OpenAI's official Claude Code plugin is optional and has its own job lifecycle.
- Cursor through ACP v1 with a headless fallback, using the installed catalog's newest eligible Composer and Grok models (currently Composer 2.5 and Grok 4.7).
- Claude subagents or the current Claude session when handoff cost or task fit makes Claude the better route.

The router records delegation history and provider headroom without pretending local token estimates are provider quota. Codex limits can be refreshed from its app server, Claude limits are captured through official native Mods data or optional status-line input, and Cursor usage can be entered from the Cursor dashboard. Hard quota gates block new Codex and Cursor work above the configured threshold.

Managed Codex and Cursor jobs support durable event journals, live inspection, user-visible transcripts, tool activity, changed-file and diff views, observed usage, provider-aware cancellation, resumable sessions, and corrections. Codex uses app-server for true same-turn steering. Cursor uses ACP v1 and reports corrections honestly as cancel-and-resume restarts.

## Requirements

- Claude Code 2.1.294 or later (the tested native Mods baseline)
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

Start a new Claude Code session, or run `/reload-plugins`. On session start the plugin links the `delegate-*` commands into `${DELEGATE_USER_BIN:-~/.local/bin}` automatically (links self-heal after every update — keep that directory on `PATH`). Both providers are enabled when no provider configuration exists; an existing selection is preserved. To restrict:

```bash
delegate-config providers codex     # or: cursor, both
```

Invoke explicitly with:

```text
/delegate-router:delegate mode=review scope=src task="Review the authentication changes"
```

Claude may also select the skill automatically when a task matches its description.

Codex users can optionally add OpenAI's official Claude Code plugin for its background review/rescue commands; managed Codex app-server supervision works without it:

```bash
claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex
```

[Current Codex no longer hosts an MCP server](https://learn.chatgpt.com/docs/mcp-server).
The optional `delegate_codex` registration checks bounded local CLI help before
launching anything: older supported CLIs expose `codex`/`codex-reply`; current or
unverified CLIs return an empty tool catalog and direct callers to the managed
`delegate_control` tools. `delegate-health --quick --json` reports this separately
as `codex.legacyMcp`; absence of the optional fallback does not disable managed
Codex. No unsupported command is ever forwarded as an interactive model prompt.

### Update

```bash
claude plugin marketplace update delegate-skill && claude plugin update delegate-router@delegate-skill
```

Then start a new Claude Code session or run `/reload-plugins`. Running sessions keep the version they loaded; command symlinks re-resolve to the updated install automatically.

### Advanced: scripted install from a checkout

`./install.sh` wraps the same steps for a cloned checkout and adds provider-mode presets (`--both`, `--codex-only`, `--cursor-only`), prerequisite checks, and the optional official Codex plugin (skip it with `--lean`). Without a preset it preserves the configured providers, defaulting to both only on a new installation. For local development without installation, from the marketplace root:

```bash
claude --plugin-dir ./plugins/delegate-router
```

## Native Claude Code UX

The plugin uses [Claude Code Mods](https://code.claude.com/docs/en/plugins/mods/overview) for immediate commands, an on-demand job panel, official allowance capture and a compact active-work status. These commands do not request a model turn:

```text
/delegate-dashboard
/delegate-status
/delegate-inspect <job-id>
/delegate-diff <job-id>
/delegate-answer <job-id>
/delegate-cancel <job-id>
/delegate-steer <job-id>
```

The panel defaults to this session's jobs, with explicit workspace/all-job views.
It shows input gates, review readiness, verification, scope, policy and bounded
diffs. Foreign-session jobs are inspectable but cannot be controlled here.
Every mutation re-inspects the job and asks a person; cancellation is queued,
not declared complete before provider acknowledgement. Truncated plan evidence
cannot be accepted through the panel. Cursor corrections are labeled restarts.

The panel renders on terminal and Desktop; other surfaces get text status and
retain CLI/MCP. It never auto-opens or steals focus. `/config` exposes native
enablement, allowance capture, compact status, reviewer guard and a 3–30-second
local refresh interval. Disabling native integration leaves the existing broker,
classic hooks and CLI intact; it does not change provider configuration.

For a bounded local independent review, Claude can select the read-only
`delegate-router:reviewer` Agent. It inherits the chosen model, has a 12-turn
ceiling, and leaves final acceptance with the coordinator. Its native allowance
guard refuses at the configured Claude avoid threshold without substituting a
model; it does not intercept other agents. Unknown allowance stays unknown.
See [native integration](plugins/delegate-router/skills/delegate/references/native.md).

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

Write starts run a read-only plan and pause for confirmation. Inspect the pending request, then use `delegate-jobs respond <job-id> --expected-revision <n> --request-id <request-id> --accept` or `--reject`. The broker derives real-tree verification from repository conventions; explicit `--verify-command` overrides it. `--no-plan-first` is the explicit trivial-write escape hatch.

Current full model IDs also work: for example, `delegate-route --model gpt-6.1-sol --mode review --task "Review the authentication changes"` infers Codex, while `--model claude-opus-5-5` infers Claude. Managed starts still require `--provider codex|cursor`. Account availability remains authoritative; older explicit IDs are preserved. See [model notes](plugins/delegate-router/skills/delegate/references/models.md).

Run `delegate-tui` for the dashboard, fleet, work-item review, plan confirmations, and selected child transcripts. Managed jobs normally belong to a resident supervisor and survive the launching CLI or MCP session. In Claude Code, the plugin monitor supplies actionable notifications; `finishedPath` is the durable fallback. Use `delegate-jobs wait` from a normal terminal.

Within Claude Code, the skill uses the `delegate_control` MCP server. Read-only `delegate_start` calls return promptly; write starts wait through a bounded plan checkpoint and return a `launchNotice`. Claude advances the `afterSeq` cursor only when monitoring is useful and uses the latest revision for steering or cancellation. Workers are detached from the MCP process, so plugin reloads do not erase their job state.

The original `delegate-cursor` headless adapter remains available for compatibility, foreground scripts, and machines where Cursor ACP is unavailable. Its detached `--background` mode uses the same job directory but has less semantic event fidelity.

The default Cursor write policy is Smart Auto review inside Cursor's sandbox. Unrestricted `--force` requires `--approval force`. Sensitive files are denied by the task contract unless `--allow-sensitive` is explicitly supplied.

## Execution Contracts

Managed Codex jobs preflight the installed client's paginated model catalog and
reject known unsupported models or reasoning efforts before starting a turn.
Catalog discovery is not proof of account entitlement. Older clients without
discovery retain provider-side validation; explicit model pins never change.

Compatible plan/report schemas use Codex's native JSON output contract, then
the broker validates the result independently. Other lanes retain the text/JSON
contract. A malformed last JSON fence never resurrects an earlier report or plan.

For a bounded work item, optionally set `maxTotalOutputTokens` /
`--max-total-output-tokens` to share a reported-output cap across continuations,
auto-fix rounds, and independent planners. Codex `maxSubagents` /
`--max-subagents 0..16` limits concurrent native children; zero disables them.
These are opt-in controls, not a promise about dollars or unreported child usage.

Isolated continuations restore the captured candidate on its original committed
base in a fresh broker worktree and provider session, preserving the write fence
and inherited verification recipe. Opt-in deterministic auto-fix works there too.
The owner checkout remains untouched; integration still requires CAS preflight.

`delegate-jobs stats --model <exact-id> --json` filters actual recorded IDs.
`modelCohorts` separates generation, effort, transport, CLI, and policy versions;
historical aliases remain generation-unknown rather than being backfilled.

## Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `DELEGATE_WARNING_PERCENT` | `80` (Cursor `70`) | Prefer an equivalent fallback above this usage level |
| `DELEGATE_AVOID_PERCENT` | `90` (Cursor `80`) | Block new work on a provider at or above this level. Cursor defaults are stricter because its overage bills on-demand instead of throttling |
| `DELEGATE_<PROVIDER>_AVOID_PERCENT` | unset | Per-provider avoid override (e.g. `DELEGATE_CURSOR_AVOID_PERCENT=75`); wins over the global value |
| `DELEGATE_<PROVIDER>_WARNING_PERCENT` | unset | Per-provider warning override; wins over the global value |
| `DELEGATE_MANUAL_USAGE_TTL_DAYS` | `7` | Manual/dashboard usage entries without a reset boundary go stale (back to unknown) after this many days; `0` disables |
| `DELEGATE_ALLOW_OVER_LIMIT` | empty | Comma-separated explicit overrides such as `codex,cursor` |
| `DELEGATE_ENABLED_PROVIDERS` | installed config | Temporary comma-separated override such as `codex` or `cursor` |
| `DELEGATE_PROVIDER_CONFIG` | state directory | Override the persistent provider configuration file |
| `DELEGATE_CURSOR_TIMEOUT_SECONDS` | `3600` | Cursor timeout when unset: managed jobs use 60-86400 seconds; direct CLI uses 10-86400 |
| `DELEGATE_CODEX_TIMEOUT_SECONDS` | `3600` | Managed Codex job timeout when unset, bounded to 60-86400 seconds |
| `DELEGATE_JOB_RETENTION_DAYS` | `14` | Prune terminal job records older than this many days |
| `DELEGATE_RPC_TIMEOUT_MS` | `30000` | Startup and control JSON-RPC request deadline |
| `DELEGATE_ACP_GRACE_MS` | `250` | Bounded 0-2000ms grace period for late Cursor ACP events |
| `DELEGATE_CURSOR_BIN` | auto | Override `agent` / `cursor-agent` discovery |
| `DELEGATE_CURSOR_LOGIN_SHELL` | `1` on macOS | Set `0` to launch Cursor ACP directly instead of through the login shell |
| `DELEGATE_CURSOR_COMPOSER_MODEL` | live newest | Pin a Composer model ID |
| `DELEGATE_CURSOR_GROK_MODEL` | live newest | Pin a Grok model ID |
| `DELEGATE_CURSOR_GROK_XHIGH_MODEL` | live newest | Pin a Grok xhigh model ID |
| `DELEGATE_PLAN_OUTPUT_TOKENS` | `8192` (Cursor independent planner `12288`) | Override the nominal plan budget, bounded to 128-16384 tokens |
| `DELEGATE_PLAN_TIMEOUT_SECONDS` | token-derived | Override plan wall time; defaults have 300s / 600s floors and a 900s ceiling, clamped to the parent deadline |
| `DELEGATE_EVENT_MAX_STRING` | `65536` | Maximum persisted length of any event string before truncation |
| `DELEGATE_STATE_FILE` | XDG state path | Override usage and job state location |

Native Mods capture Claude's reported five-hour/weekly windows automatically
without editing your status line. For the optional status-line capture path, run:

```bash
delegate-config statusline enable
```

This uses Claude Code's official status-line channel: if a status line is already configured it is wrapped — the payload is forwarded to `delegate-claude-usage --quiet` and the original renders unchanged; if none is configured, a minimal usage status line is installed. `delegate-config statusline disable` restores the previous configuration exactly. Manual `delegate-usage set claude ...` remains valid.

The plugin never reads Claude credentials or queries usage endpoints directly.
It consumes only official host-provided allowance windows, not context occupancy,
cost estimates or hidden reasoning. Local token-estimation tools are useful
dashboards but are never treated as provider quota.

## Portability

On any machine, run the one-step install above — no clone needed. The session-start bootstrap creates and refreshes the command symlinks under `${DELEGATE_USER_BIN:-~/.local/bin}`; the shim they point at resolves the currently installed plugin version at run time. Provider selection and runtime state live under `${XDG_STATE_HOME:-~/.local/state}/delegate-router` unless overridden. No source file embeds the installation directory.

Managed transcript and diff artifacts remain local and use user-only permissions. Credential assignments and values are redacted, strings are bounded, and hidden reasoning is never journaled. Cursor Git inventory is baseline-aware: sensitive paths, pre-existing untracked files, internal delegation state, binary payloads, and oversized untracked contents are never copied into diff events. Shared dirty worktrees still have best-effort attribution; the coordinator must inspect the actual diff before integration.

Documentation map: [model notes](plugins/delegate-router/skills/delegate/references/models.md), [routing](plugins/delegate-router/skills/delegate/references/routing.md), [controls](plugins/delegate-router/skills/delegate/references/control.md), [protocol](plugins/delegate-router/skills/delegate/references/protocol.md), [usage](plugins/delegate-router/skills/delegate/references/usage.md), [native UX](plugins/delegate-router/skills/delegate/references/native.md), [advanced workflows](plugins/delegate-router/skills/delegate/references/workflows.md), and [TUI](plugins/delegate-router/skills/delegate/references/tui.md). The [changelog](plugins/delegate-router/CHANGELOG.md) records releases; the [roadmap](plugins/delegate-router/ROADMAP.md) archives shipped waves, while [native-substrate](plugins/delegate-router/docs/native-substrate.md) records implemented boundaries and explicit deferrals.

## Development

```bash
cd plugins/delegate-router
npm test
npm run test:native
cd ../..
./install.sh --check
```

The runtime has no npm dependencies. CI tests both the minimum supported Node 18
and the latest Node LTS, plus native Mods on pinned Claude Code 2.1.294. Native
tests stub processes, user answers and provider state: no sign-in, model calls or
installation. `./install.sh --check` runs validation and both test suites without
installing. A real-session visual smoke check remains useful after installation;
the native harness checks event behavior and valid UI trees, not terminal paint.

To ship a change: commit, then run `./release.sh` — it tests, validates, pushes `main`, and updates the installed plugin from the marketplace in one step. Running Claude Code sessions keep the old version; new sessions pick up the release.
