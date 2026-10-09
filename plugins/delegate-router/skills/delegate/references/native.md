# Native Claude Code integration

Source release 0.72.0 targets Claude Code 2.1.294 or later. Mods add host-native
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
| `/delegate-new` | Compose a task, preview its exact packet and explicitly approve paid launch or pending dispatch |
| `/delegate-review <job-id>` | Paginated diff/plan/report evidence, file selection, literal search and broker check output |
| `/delegate-queue` | Approved pending tasks, admission reasons and revisioned cancel/priority controls |
| `/delegate-context` | Explicitly select redacted public conversation excerpts for a new task |
| `/delegate-agents` | Claude host agents, managed jobs and provider-reported children; unknown usage stays unknown |
| `/delegate-claim <job-id>` | Human-confirm same-workspace native supervision transfer, preserving launch attribution |

Commands are dynamically registered at native session start and return local
text, not model context. No command requests a Claude model completion. Only the
human-approved composer starts new paid external work through normal broker
admission. Controls may cause an existing provider job to continue or restart;
those provider turns consume normal allowance. Cursor steering is cancel/resume,
not same-turn steering. Plugin-origin control invocations are refused.

The panel is explicitly opened and focused by the user, never automatically.
It shows at most 40 jobs, prioritizing pending input, review readiness and active
work, and labels omitted records. Polling reads closed broker metadata only, not
prompts or transcript contents. Evidence and diffs are pulled on explicit
inspection. Shared-tree file attribution is a lower bound. Completion,
verification and owner acceptance are separate facts.

Session scope is the default. Workspace and all-job scope are explicit read
choices. A job supervised by another Claude session, an unmanaged job or a
disabled provider has no answer/cancel/steer controls. A person can explicitly
claim an enabled managed job in the same recorded workspace; this changes its
controller, not immutable origin, permissions or scope. Native and monitor
session views follow that controller. Jobs with missing legacy origin remain
available in the all-job view but cannot be claimed; use explicit CLI/MCP
coordination for those jobs.

## Human decisions and safety

Every existing-job native control pulls the current revision before asking a person, carries
`expectedRevision`, and uses a stable command/correction ID for matching retries.
Unconfirmed intake retains that ID across revision changes and compaction. A
bounded retry cache refuses new controls rather than evicting uncertain intents.
The bridge permits closed preview/approved-launch/queue/claim actions and existing
`cancel`, `steer` and `respond` controls. It cannot integrate a candidate,
accept an owner outcome, change an existing scope,
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
with a fixed action and bounded JSON stdin, a five-second deadline (20 seconds
for human-approved launch/enqueue startup) and a closed response. It never uses
a shell, invokes providers directly, or relies on a
native MCP call as an implicit mutation grant. Credential-shaped evidence is
redacted by the existing broker boundary; hidden reasoning is never surfaced.

## Compose, queue and review

The composer requires objective and acceptance criteria, explicit paths for
writes, an enabled provider/model, isolation and bounded budgets. Auto routing
is deterministic; an explicit model is never replaced. The exact packet, route,
known allowance, scope, derived checks, plan-first policy and context size are
shown before a human launch dialog. Writes still require their later human plan
decision. No network/sandbox/force/secret override is offered. Credit models need
additional per-task authorization. Private preview IDs expire after 15 minutes
and provide launch idempotency even after a lost acknowledgement.

Native approvals require a Git workspace. Revalidation compares HEAD, bounded
Git status and changed-path size/mtime/mode metadata without reading untracked
contents. Workspace or derived-check/packet drift requires a fresh preview and
approval, not an inferred new task. This is best-effort drift detection, not a
filesystem snapshot or a fence against edits racing immediately after dispatch.
The existing isolated-worktree and writer policies remain authoritative.

Approved pending jobs live in a private, atomic queue (128-entry bound), separate
from running jobs. They expire after eight hours, do not consume their run-time
budget while pending, and keep the approved provider/model/scope. The resident
checks at most four new admissions per pass. Quota, provider-capacity and writer/
claim conflicts remain pending with named reasons; drift needs reapproval.
Reserved jobs survive a crash with the same idempotency key. No task-level paid
retry, automatic model substitution, or suspension of a Claude turn is added.

Pending admission defaults to two active managed jobs per provider. Optional
`DELEGATE_CODEX_MAX_CONCURRENT` and `DELEGATE_CURSOR_MAX_CONCURRENT` (1–32, or 0
for unlimited) apply to all managed launches when configured. Without those
settings, ordinary CLI/MCP launches retain prior unlimited read-job admission,
so the queue default is an admission check, not a fleet-wide hard limit.
Provider configuration remains authoritative at dispatch.

Context capture happens only on explicit inspector opening. Choose up to eight
of the last 24 public user/assistant text messages, each redacted before its
2,000-character cap. No tool arguments/results, opaque handles or hidden
reasoning are exported. Nothing is selected by default; the exact selected
text appears in the packet. Clear/resume/compaction discard captured excerpts.

Review pages contain up to 32,000 diff or 24,000 report/plan characters, pinned
to a content digest. File selection uses only recorded changed paths; search is
literal and case-sensitive. A changed digest refuses mixed-revision paging;
restart inspection. Candidate comparison shows acceptance, checks and recorded
bases, never declares an automatic winner or merges changes. Truncated plan
summaries still cannot be approved through the existing answer dialog: use full
CLI/MCP inspection. Inline cards preserve the original tool result.

The AbovePrompt band offers bounded inspection links for input, review, scope
breach and failure, yields to host surveys and never opens a pane or starts a
turn on its own. Observations use exact agent IDs and spawn tool IDs, with
parent links when supplied. Fresh host status is preferred; absence from a
catalog is not completion. Classic hooks/transcript observation remain
independent fallbacks. Quiet transcripts may mean investigation, not death:
after the quiet window they show unknown unless a recorded coordinator
PID/start-time identity is positively confirmed gone. Claude agents have no
plugin-controlled wall-clock timeout or new native control authority.

Managed timeout is elapsed wall-clock from job creation, including provider
startup, planning and approval waits, with millisecond precision. Its default
is captured at creation for new jobs. Output quietness is informational and
cannot alone produce a stall warning or failure. Actual provider timeout/exit/
RPC deadline failures remain actionable.

## Configuration and allowance

Options appear in Claude Code's `/config` plugin rows:

| Option | Default | Effect |
| --- | --- | --- |
| `native_enabled` | `true` | Commands/panel/native observation; classic hooks and CLI/MCP remain independent |
| `usage_capture` | `true` | Capture official subscription windows locally |
| `compact_status` | `true` | Show a compact chip only for running, blocked or review-ready work |
| `reviewer_guard` | `true` | Refuse this plugin's reviewer at the Claude avoid threshold |
| `attention_band` | `true` | Bounded AbovePrompt links, no automatic focus/turn |
| `inline_cards` | `true` | Managed start-result cards preserving original output |
| `agent_capture` | `true` | Closed native Claude lifecycle metadata, no prompts or agent controls |
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
