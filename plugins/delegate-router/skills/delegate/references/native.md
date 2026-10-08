# Native Claude Code integration

Source release 0.71.0 targets Claude Code 2.1.294 or later. Mods add host-native
commands, a panel and lifecycle handling; the dependency-free Node broker remains
the source of job truth. They do not replace provider transports, sandbox policy,
revisioned controls, the external TUI or the coordinator's final review.

## Commands and surfaces

| Immediate command | Behavior |
| --- | --- |
| `/delegate-dashboard` | Open the job panel on terminal/Desktop, or return text elsewhere |
| `/delegate-status` | Read session-scoped job and allowance metadata |
| `/delegate-inspect <job-id>` | Read bounded evidence, scope, policy and verification |
| `/delegate-diff <job-id>` | Read up to 32,000 diff characters; full/windowed views remain in CLI/MCP |
| `/delegate-answer <job-id>` | Ask a person for an ordinary answer or explicit boolean plan decision |
| `/delegate-cancel <job-id>` | Ask a person before queueing provider-aware cancellation |
| `/delegate-steer <job-id>` | Ask a person for a bounded in-scope correction |

Commands are dynamically registered at native session start and return local
text, not model context. No native command starts a provider or requests a model
completion. Controls may cause an existing provider job to continue or restart;
those provider turns consume normal allowance. Cursor steering is cancel/resume,
not same-turn steering. Plugin-origin control invocations are refused.

The panel is explicitly opened and focused by the user, never automatically.
It shows at most 40 jobs, prioritizing pending input, review readiness and active
work, and labels omitted records. Polling reads closed broker metadata only, not
prompts or transcript contents. Evidence and diffs are pulled on explicit
inspection. Shared-tree file attribution is a lower bound. Completion,
verification and owner acceptance are separate facts.

Session scope is the default. Workspace and all-job scope are explicit read
choices. A job from another Claude session, an unmanaged job or a disabled
provider has no native controls. Jobs with missing legacy origin remain available
in the all-job view; use explicit CLI/MCP coordination for cross-session work.

## Human decisions and safety

Every native mutation pulls the current revision before asking a person, carries
`expectedRevision`, and uses a stable command/correction ID for matching retries.
Unconfirmed intake retains that ID across revision changes and compaction. A
bounded retry cache refuses new controls rather than evicting uncertain intents.
The bridge permits only existing `cancel`, `steer` and `respond` controls. It
cannot launch work, integrate a candidate, accept an owner outcome, change scope,
raise budgets, select force, disable the sandbox or pass arbitrary process flags.
The dialog itself is not an authority-expansion mechanism.

Plans display recorded scope, policy, budget and bounded plan evidence before a
decision. Acceptance is unavailable when evidence is missing or truncated;
inspect the full plan through CLI/MCP. Declining remains available. Leaving a
gate pending does not extend its expiry. Ordinary answers remain strings, never
plan-approval booleans. Controls refuse after the session or view scope changes
while a dialog is open. Expired input and stale revisions remain broker errors:
reinspect, never force an overwrite. Queued intake is not provider acknowledgement
or terminal cancellation.

Mods process calls are trusted host operations rather than Bash permission
prompts. This module runs only `node <loaded-plugin-root>/bin/delegate-native`
with a fixed action and bounded JSON stdin, a five-second deadline and a closed
response. It never uses a shell, invokes providers directly, or relies on a
native MCP call as an implicit mutation grant. Credential-shaped evidence is
redacted by the existing broker boundary; hidden reasoning is never surfaced.

## Configuration and allowance

Options appear in Claude Code's `/config` plugin rows:

| Option | Default | Effect |
| --- | --- | --- |
| `native_enabled` | `true` | Commands/panel/native observation; classic hooks and CLI/MCP remain independent |
| `usage_capture` | `true` | Capture official subscription windows locally |
| `compact_status` | `true` | Show a compact chip only for running, blocked or review-ready work |
| `reviewer_guard` | `true` | Refuse this plugin's reviewer at the Claude avoid threshold |
| `refresh_seconds` | `5` | Broker metadata refresh, bounded to 3–30 seconds |

Provider selection remains `delegate-config providers codex|cursor|both`, not a
second native preference. Reload plugins after changing native options.

`$.session.usage()` without breakdown and `session.measure` supply reported
`five_hour`/`seven_day` windows. The adapter copies only kind, percentage and reset
boundary into a private atomic usage record. Cost/context are not quota. Empty
or invalid readings never become zero. Unchanged readings are deduplicated for
one minute; capture failure produces one fallback notice per session. Optional
status-line/manual capture remains available, with no credential/API scraping.

`delegate-router:reviewer` is a bounded read-only Agent using Read/Grep/Glob,
model inheritance and `maxTurns: 12`. Parent Claude remains final reviewer.
The quota guard applies only to this agent and never silently switches its
requested model. Disable the reviewer guard explicitly if you intend to handle
its allowance yourself. Fable/ultra routing authorization rules remain intact.

## Recovery and verification

Native end cancels metadata polling. `classic.SessionStart` rehydrates after
clear, resume and compaction; stale in-flight reads cannot replace a newer view.
Managed MCP start calls stamp current host session/workspace identity without
rewriting task or permission arguments. This avoids attributing a post-clear
launch to the persistent MCP process's startup session. Other tools are untouched.
The existing command-hook `SessionStart(source=compact)` remains responsible for
bounded coordinator context. No `PostCompact` context-injection claim is made.
Failed refresh retains the last evidence with a stale warning. Unsupported
surfaces and disabled native integration retain documented CLI/MCP pull paths.

Run `npm test` for broker tests and `npm run test:native` for Claude's model-free
Mods harness. `../../install.sh --check` validates both manifests and runs both
suites. CI pins the tested host version. Tests press panel controls on terminal
and Desktop, exercise confirmations/conflicts/foreign-session restrictions,
quota and capture behavior, and cover clear/timer recovery without real model
calls. Actual application paint and authenticated provider behavior require
separate explicitly authorized smoke checks.

Primary host references: [Mods](https://code.claude.com/docs/en/plugins/mods/overview),
[API](https://code.claude.com/docs/en/plugins/mods/api),
[testing](https://code.claude.com/docs/en/plugins/mods/test), and
[manifest/userConfig](https://code.claude.com/docs/en/plugins-reference).
