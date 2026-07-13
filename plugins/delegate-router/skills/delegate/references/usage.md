# Usage Tracking

`delegate-usage` maintains a small JSON state file and append-only invocation history. It does not store prompts or source code. Managed supervision is separate: it stores local user-visible transcripts, tool activity, and diffs in user-only job artifacts so Claude can inspect delegated work.

Default path:

```text
${DELEGATE_STATE_FILE}
or ${XDG_STATE_HOME}/delegate-router/usage.json
or ~/.local/state/delegate-router/usage.json
```

## Provider Truth

- Codex: `delegate-usage refresh codex` queries the official app-server `account/rateLimits/read` method and stores primary (five-hour) and secondary (weekly) windows. Managed Codex jobs also capture pushed `account/rateLimits/updated` notifications, so the snapshot stays fresh during every job.
- Claude: `delegate-config statusline enable` wraps (or installs) the Claude Code status line so the official `rate_limits.five_hour` and `rate_limits.seven_day` payload flows into usage state on every render; `delegate-config statusline disable` restores the previous configuration. Manual values are also accepted. Anthropic's Consumer Terms prohibit using Claude OAuth tokens in any third-party tool, so this plugin deliberately does not query any usage endpoint directly — the status line is the sanctioned channel.
- Cursor: no stable public quota CLI/API is assumed. Cursor meters two monthly pools; the one Delegate Router consumes is the first-party pool (Auto, Composer, Grok). Enter its dashboard percentage with `delegate-usage set cursor <percent> --window first-party --source dashboard --reset <cycle-end-epoch>`; the `--reset` epoch makes the entry expire at the monthly cycle boundary instead of going stale. Invocation history is an estimate and never converted into a fake quota percentage. Local token-counting tools (ccusage, tokscale, TokenTracker) estimate from transcripts and must not be treated as quota truth.

## Commands

```bash
delegate-usage show [--json]
delegate-usage refresh codex
delegate-usage set <claude|codex|cursor> <0-100> [--window name] [--reset epoch] [--source label]
delegate-usage clear <provider>
delegate-usage guard <provider> [threshold]
delegate-usage record <provider> <model> <started|ok|failed> [--mode mode] [--thread id]
delegate-usage history [count]
delegate-route --json --mode <mode> --task <summary>
delegate-health [--quick] [--json]
delegate-config show
delegate-config providers <codex|cursor|both>
delegate-config statusline <enable|disable|show>
delegate-jobs start|status|inspect|events|transcript|wait|diff|files|steer|cancel|resume|usage|result|logs|prune <job-id>
```

The default avoid threshold is 90% for Claude and Codex and 80% for Cursor (stricter because Cursor overage bills on-demand instead of throttling), configurable globally with `DELEGATE_AVOID_PERCENT` or per provider with `DELEGATE_<PROVIDER>_AVOID_PERCENT`. Thresholds act only on reliable data: manual entries without a `--reset` boundary expire after `DELEGATE_MANUAL_USAGE_TTL_DAYS` (default 7) and revert to unknown. `guard` exits 75 when the provider is at or above the threshold so the router can choose a fallback.

The plugin's `PreToolUse` hook hard-blocks new native or official-plugin Codex work at that threshold. Set `DELEGATE_ALLOW_OVER_LIMIT=codex` only for a deliberate user override. Cursor enforces the threshold inside its adapter and accepts `--override-limit` for the same explicit case.

Per-job observed tokens or context usage are evidence about that execution, not a subscription allowance percentage. `delegate_usage` reports those values separately. Routing continues to use the provider windows in `usage.json`.

Sources: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md, https://code.claude.com/docs/en/statusline, and https://docs.cursor.com/account/pricing

Cursor exposes no allowance API: `usage: unknown` for Cursor in `delegate-health` is the expected steady state, not an error. The only reliable source is the dashboard percentage, recorded manually with `delegate-usage set cursor <percent> --window first-party --source dashboard --reset <cycle-end-epoch>` (stale entries expire per `DELEGATE_MANUAL_USAGE_TTL_DAYS`).
