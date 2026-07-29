# Usage Tracking

`delegate-usage` maintains a small JSON state file and append-only invocation history. It does not store prompts or source code. Job supervision is separate: managed runs and direct-transport shadows store local user-visible transcripts, tool activity, and diffs in user-only job artifacts so Claude can inspect delegated work.

Default path:

```text
${DELEGATE_STATE_FILE}
or ${XDG_STATE_HOME}/delegate-router/usage.json
or ~/.local/state/delegate-router/usage.json
```

## Provider Truth

- Codex: `delegate-usage refresh codex` queries the official app-server `account/rateLimits/read` method and stores primary (five-hour) and secondary (weekly) windows. Managed Codex jobs also capture pushed `account/rateLimits/updated` notifications, so the snapshot stays fresh during every job. Both paths append bounded allowance snapshots to history for capture-window comparison.
- Claude: `delegate-config statusline enable` wraps (or installs) the Claude Code status line so the official `rate_limits.five_hour` and `rate_limits.seven_day` payload flows into usage state on every render. The wrapper prefixes the session-scoped Delegate work chip, then runs the user's original command unchanged; a five-second `refreshInterval` keeps background state current while Claude Code's 300 ms debounce handles bursts. `delegate-config statusline disable` restores the exact previous configuration. Manual values are also accepted. Anthropic's Consumer Terms prohibit using Claude OAuth tokens in any third-party tool, so this plugin deliberately does not query any usage endpoint directly — the status line is the sanctioned channel.
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
delegate-route --json --mode <mode> --effort <level> --task <summary>
delegate-health [--quick] [--deep] [--json]
delegate-config show
delegate-config providers <codex|cursor|both>
delegate-config statusline <enable|disable|show>
delegate-config footer-links <enable|disable|show>
delegate-jobs start|status|stats|group|inspect|events|transcript|wait|diff|files|steer|cancel|release|respond|accept|reject|resume|usage|result|logs|prune <job-id>
```

The default avoid threshold is 90% for Claude and Codex and 80% for Cursor (stricter because Cursor overage bills on-demand instead of throttling), configurable globally with `DELEGATE_AVOID_PERCENT` or per provider with `DELEGATE_<PROVIDER>_AVOID_PERCENT`. Thresholds act only on reliable data: manual entries without a `--reset` boundary expire after `DELEGATE_MANUAL_USAGE_TTL_DAYS` (default 7) and revert to unknown. `guard` exits 75 when the provider is at or above the threshold so the router can choose a fallback.

The plugin's `PreToolUse` hook hard-blocks new native or official-plugin Codex work at that threshold. Set `DELEGATE_ALLOW_OVER_LIMIT=codex` only for a deliberate user override. Cursor enforces the threshold inside its adapter and accepts `--override-limit` for the same explicit case.

Per-job observed tokens and context occupancy are separate dimensions, neither of which is a subscription allowance percentage. `delegate_usage.tokenUsage` / `observed` contains input/output/total tokens and feeds the `maxOutputTokens` check; `chainCumulative` sums those token counters from the root job through the inspected continuation. Cursor ACP `usage_update {used,size}` is stored only as `contextOccupancy: { contextUsed, contextSize }`, never interpreted as output tokens and never compared with `maxOutputTokens`. Headless Cursor records tokens only from its final `result.usage` envelope. Routing continues to use the provider windows in `usage.json`.

Plan-first uses a separate 4,096-token structured output default that does not
scale with packet bytes or directive markers; the prompt itself requires one
compact structural answer. The configurable ceiling remains 16,384 tokens;
`DELEGATE_PLAN_OUTPUT_TOKENS` overrides it without changing provider allowance.
Parseable overruns through 20% are recorded and reused as `recovered`; anything
above that hard limit, including the observed 66k/78k runaways, still fails.
The sub-budget is still provider-reported output tokens, not quota percentage.
Ambient monitoring names its terminal edge `budget-breach` for this per-job
cap and `allowance-breach` for provider quota/rate exhaustion. A same-cause
generic failure is redundant and suppressed; a different terminal cause
remains visible.

`delegate-jobs stats` reads the never-pruned audit log as an outcome ledger across managed jobs, direct Codex/Cursor shadows, and completed `claude-agent` stubs. Every new attempt and terminal/decision audit snapshot records broker, adapter, provider-CLI, policy, and event-schema versions; a stable task shape; the canonical packet sections that were present; real-tree verification outcome; bounded findings; the explicit owner decision; usage; and a redacted rejection reason when one exists. Provider CLI provenance reuses the managed adapter's existing local version check, direct Cursor's local `--version`, or Codex MCP `serverInfo`; it adds no provider/API round trip and spends no allowance. Historical rows remain readable with these fields absent.

The ledger reports provider-completion, verification-pass, and owner-acceptance as three independent measurements. Each carries `{ numerator, sampleSize, minimumSample, status, rate }`; the minimum is 10, and `rate` is `null` with `status: "insufficient-data"` below it. Verification counts only broker-originated real-tree pass/fail/timeout labels. Owner acceptance counts only explicit `accepted`/`rejected` decisions. It never treats missing labels, `ready-for-review`, scope cleanliness, or provider silence as a positive label.

The same response has an operational `planFirst` signal with exact
`requested`, `completed`, `degraded`, `recovered`, `pending`, and historical
`unknown` counts plus completion/degradation rates. This signal has no
minimum-sample suppression: a 14/14 degradation era must display as
`degradationRate: 1`, not disappear behind an insufficient-data label.

`--since` / MCP `since` accepts a duration (`24h`, `7d`), ISO date (`2026-07-17`), or broker version (`0.42.0`); `--until` / MCP `until` supplies an exclusive ISO-date upper bound. Responses include broker-version and UTC-day cohorts with explicit ORPHANED counts, so a historical failure era remains visible without contaminating a selected current view. `--recommend-for <mode>` (optional `--recommend-access read|write`) or MCP `recommendFor` requests advisory outcome evidence. It uses only explicit owner-acceptance labels, requires at least 20 labels per provider, attaches a fixed 95% Wilson interval, and recommends only when the leading lower bound exceeds the runner-up upper bound. Otherwise it returns `insufficient-data`; it never changes the static router.

The response also retains `totals`, transport/model groups, `external`, and `unattributed`. `external` counts only proven tool-originated, non-broker Codex threads and sums token fields only when the bounded thread tail actually carries provider counters; absence remains `null`, never an estimate. `unattributed` remains explicitly approximate allowance movement and is unavailable for broker-version selections because allowance markers have no broker-version attribution. `delegate-health --deep` intentionally spends real allowance on one bounded managed probe per enabled provider and writes its `{ provider, ok, durationMs, cliVersion, at }` result under `lastVerified`. Ordinary Cursor health uses `agent status --format json` with a text fallback and a no-turn ACP initialize/session-new capability probe; neither spends model allowance.

`DELEGATE_MONITOR_SCOPE=session|workspace|all` filters ambient push only; `off`
disables push. It never filters usage, stats, `delegate_list`,
`delegate_inspect`, or TUI data and never gates control operations. The
durable SessionStart ancestor marker and each explicit correlation/fallback
record live as private `0600` metadata under
`<state-dir>/monitor-correlation/`; they contain PID/start-time identity and
scope state, not prompts, results, diffs, credentials, or usage. Markers expire
after 72 hours and are pruned earlier when the recorded coordinator identity is
gone. The monitor never waits for or spawns a correlation responder.

SessionStart also returns a live collision `watchPaths` set for active scoped
write attempts. It is capped at 256 absolute paths including a private
state-directory refresh signal, leaving up to 255 deterministic owned roots.
Paths beyond the cap and known watcher failures record
`collisionWatch.status: "degraded"` with a reason and
`fallback: "post-hoc-detection"`; they are never silently omitted. The
Edit/Write and batch hooks remain active, and none of these hooks can block a
tool or filesystem change. Collision alerts follow the same ambient monitor
scope as every other edge.

## Store Budget And Retention

The complete state directory has a 1.5 GiB default budget, configurable with
`DELEGATE_STATE_BUDGET_BYTES`. `delegate-health` reports its current logical
bytes, regular-file count, budget, 85% high-water threshold, signed headroom,
and whether the bounded scan completed. High-water is warned before a sweep
deletes anything. The private, bounded `maintenance.jsonl` records every
compression and deletion with its reason (`age` or `budget`) plus any protected
overage.

Age retention still uses `DELEGATE_JOB_RETENTION_DAYS` (default 14), then a
budget sweep reclaims oldest eligible terminal jobs until under budget. Neither
path deletes non-terminal work, `acceptance.state: "ready-for-review"` or
`"blocked"`, or a job referenced by a live supervisor lease. Budget reclaim
also keeps the newest 20 terminal jobs; change that history floor with
`DELEGATE_RECENT_TERMINAL_KEEP`. If protected records prevent the target, the
sweep stops over budget and warns rather than deleting them.

Terminal journals use built-in gzip. Readers permanently accept both
`.events.jsonl` and `.events.jsonl.gz`; there is no migration rewrite of job
records. A live journal is capped at 32 MiB of uncompressed JSONL by default
(`DELEGATE_JOB_JOURNAL_CAP_BYTES`). On overflow it keeps the initial head and
newest tail, replaces only the middle with a visible `journal.truncated` event,
and adds cumulative `journalTruncation` metadata to the record. It never
compresses a non-terminal journal or silently drops events.

The MCP server, `delegate-jobs`, local TUI, managed-launch path, and
lease-free supervisor idle tick all call the same six-hour stamped sweep.
Concurrent entry points share a lock and cannot multiply the work. Each run
examines at most 500 records, removes at most 25, and compresses at most 25
legacy terminal journals; remaining work continues on a later sweep instead of
stalling a launch or session start.

SessionStart also returns native work `additionalContext`, including when
Claude Code invokes it with `source=compact` after compaction. The payload is
hard-capped at 2,048 UTF-8 bytes and limited to safe IDs, closed
lifecycle/blocker labels, counts, and allowance state. Prompts, results, diffs,
repository paths, pending questions, secrets, and free-form errors are never
read into that context. Overflow keeps higher-priority/newer items and reports
the omitted count. `DELEGATE_NATIVE_CONTEXT=0` disables only context;
`DELEGATE_NATIVE_STATUSLINE=0` hides only the `D` chip;
`DELEGATE_NATIVE_MCP=0` hides only MCP resources/prompts; and
`DELEGATE_NATIVE_FOOTER_LINKS=0` skips badge installation. The footer rule can
also be removed independently with `delegate-config footer-links disable`.
None of these switches changes pull/control behavior.

`unattributed-burn` is deliberately aggregate-only. Between consecutive snapshots of the same named Codex allowance window, an increase in `usedPercent` is marked only when no managed or shadow Codex audit usage and no overlapping active tracked Codex job can account for the interval. The amount is allowance percentage-point movement, labelled approximate; token counts and allowance percentages are never converted into one another. The marker never names, links, or enumerates a thread because the movement may be the owner's personal use. It is best-effort and capture-cadence limited: work that starts and finishes between snapshots, reset-boundary changes, mixed window identities, history pruning, or missing provider pushes can hide a window, and a running tracked job suppresses rather than guesses.

Stats attribute Codex resume-chain output as chronological deltas because each continuation can carry a thread-cumulative total. This includes `codex-reply` shadow children linked to the originating direct call; standalone jobs and Cursor samples remain unchanged, and a lower Codex counter is treated as a fresh thread and counted in full.

Sources: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md, https://code.claude.com/docs/en/statusline, and https://docs.cursor.com/account/pricing

Cursor exposes no allowance API: `usage: unknown` for Cursor in `delegate-health` is the expected steady state, not an error. The only reliable source is the dashboard percentage, recorded manually with `delegate-usage set cursor <percent> --window first-party --source dashboard --reset <cycle-end-epoch>` (stale entries expire per `DELEGATE_MANUAL_USAGE_TTL_DAYS`).
