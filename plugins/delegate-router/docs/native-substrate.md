# Native substrate program

Status: complete in source as of 2026-07-27, with the explicit deferrals and
remaining non-parities recorded below. Owner-approved 2026-07-26 as a single
program.
Supersedes the direction in `ROADMAP.md` (whose waves shipped through v0.26.x).

Source audit: 2026-10-09. The phases below retain their original design and
completion record. Later model/catalog, planning-budget, and subagent
observability, native JSON contracts, optional work budgets, and captured-candidate
continuation updates are described in the [changelog](../CHANGELOG.md) and
current [operator references](../skills/delegate/references/control.md).

## Progress

- Native Mods UX now includes human-approved task composition and pending
  dispatch, opt-in public context, paginated review/search/file selection,
  broker check output, candidate comparison, inline inspection/attention,
  unified agent metadata and same-workspace supervision claims. Quiet output
  no longer fabricates failure; host lifecycle status and wall-clock budgets
  are independent. The [native reference](../skills/delegate/references/native.md)
  records bounds, explicit approval, drift checks and remaining fallbacks.
- P9 provider attempt-driver contract is implemented. Codex app-server, Cursor
  ACP, and Cursor headless now resolve through one formal lane registry with
  `start`, `resume`, `prompt`, `steer`, `cancel`, and `close` lifecycle
  methods. Capability negotiation keeps same-turn steering, live shell stdout,
  mid-turn token totals, context occupancy, plan mode, MCP injection,
  broker-worktree support, and pre-prompt pause separate rather than flattening
  them. The old compact job `capabilities` record remains byte-compatible.
  Plan-first, contained-worktree, pre-prompt-pause, and same-turn-steering
  admission use the negotiated contract; an unsupported workflow is refused
  with the missing capability and lane named. The existing transport loops,
  events, records, errors, ordering, ACP fallback, and headless fallback are
  unchanged.
- `delegate-health --capabilities` prints the resolved three-lane matrix.
  Codex app-server initialization, Cursor ACP initialize/session creation, and
  Cursor headless help inspection are no-turn probes. A probed field says
  `probed`; properties that cannot be established without a paid/provider turn
  remain `declared-from-documentation`. The command honors
  `DELEGATE_ENABLED_PROVIDERS` for temporary inspection and never edits
  `providers.json`.
- P7 work-item cockpit is implemented as an additive TUI surface over the
  existing total P1 projection. Compose shows P5 provenance/confidence and
  unresolved dispatch blockers; Review combines changed files, immutable base,
  verification, scope/drift, and findings; Approve records the existing P3
  evidence-bound decisions and offers only P6 integration-worktree
  composition; Compare aligns two candidates under common criteria; and
  Converge shows open/resolved/regressed findings plus the bounded policy
  before the existing next-round action. Fleet, Detail, Groups, Sessions,
  Stats, and their bindings are unchanged. Replay is visibly disabled because
  the normalized journal has neither persisted projection checkpoints nor a
  reversible reducer: accurate arbitrary rewind would require a full-prefix
  load and the endpoint would require the entire journal, violating
  O(viewport). Direct owner-tree application remains absent.
- P8 outcome ledger is implemented additively. New attempts and terminal or
  owner-decision audit snapshots retain broker/adapter/provider CLI, policy,
  and event-schema versions; task shape; canonical packet-section presence;
  verification, findings, acceptance, usage, and redacted rejection evidence.
  Historical rows project with explicit gaps and are never rewritten.
  Provider-completion, broker real-tree verification-pass, and explicit
  owner-acceptance rates are independent measurements with numerator, sample,
  and a minimum-10 display gate. Broker-version and UTC-day cohorts plus
  first-class duration/date/version selection isolate old ORPHANED eras.
  Outcome-aware provider advice requires 20 owner labels per provider and
  separated fixed-95% Wilson intervals; sparse/overlapping data returns
  `insufficient-data`, and the static router remains unchanged.
- P6 transactional workspaces have shipped as a deliberately narrow,
  additive first cut. An explicit `isolation: "worktree"` write launch now
  requires separate `allowedPaths` and scheduling `pathClaims`, allocates a
  detached broker-owned Git worktree at an immutable commit, captures a
  private portable binary change set, and discards the attempt workspace on
  every observed terminal path. Exact resource claims and overlapping path
  claims schedule isolated writers; shared writers retain their conservative
  whole-tree ownership. Strict content-and-mode CAS preflight and
  conflict-stopping composition run only in broker-owned integration
  worktrees. Direct multi-file landing into the owner's working tree is
  intentionally deferred: ordinary filesystem writes cannot atomically
  compare and replace several paths against unmanaged editors, so
  `delegate_decide accepted` refuses after a clean preflight rather than
  claiming a guarantee it cannot provide.
- P5 intent-to-spec compilation is implemented additively. A deterministic,
  network-free compiler accepts sentences, changed-path inventories,
  failing-check output, TODOs, JSON task records, and repository conventions.
  Every WorkSpec field retains provenance plus high/medium/low confidence in
  one CLI/TUI confirmation card; low-confidence and missing values remain
  unresolved and block write dispatch. The P3 repository verification profile
  supplies the check recipe, while Git supplies a metadata-only immutable-base
  fingerprint. `allowedPaths`, network, sandbox disablement, privileges, scope
  widening, and budget increases are never inferred. Confirmed specs feed the
  unchanged managed start, P4.6 plan-first packet, and P1 projection. Existing
  hand-written packets and MCP schemas are unchanged.
- P4.6 plan-first dispatch and structural ambiguity detection and P4.7
  read-only worker interrogation are implemented additively. Write launches
  now begin with a bounded plan turn and revisioned confirmation before the
  same provider session enters write mode; the trivial-change escape hatch is
  explicit. Independent plan evidence is compared structurally and can report
  divergent, convergent, or inconclusive without guessing. Interrogation
  reuses the P4.5 inbox in reverse, records answers as findings evidence, and
  attributes provider tokens to the original work-item budget.
- P4 native session integration is implemented additively. The existing
  status-line wrapper now composes a five-second-refresh work chip before the
  user's original command; SessionStart (including source=compact) supplies one bounded,
  redacted work-state projection; P2.5 remains the sole overlap invalidator;
  the control MCP advertises read-only resources/templates and two common-flow
  prompts without changing its tool array; and opt-in footer regexes turn
  conversation job IDs into editor-deep-link badges. The injected context is
  capped at 2,048 UTF-8 bytes and contains only safe IDs and closed metadata.
  Unsupported/disabled ambient surfaces never gate the existing pull paths.
- P2.5 live collision detection is implemented additively. SessionStart arms a
  bounded dynamic watch set for live write attempts and a private refresh
  signal; FileChanged plus coordinator Edit/Write and batch hooks record one
  collision edge per attempt/path. The ordinary P2a monitor supplies scope,
  priority, deduplication, cooldown, snooze behavior, and rate limiting.
  Applicable verification becomes `stale` with `inputChanged`, while
  `baseDrift` blocks undecided acceptance. The 256-path cap includes the
  refresh signal; omitted roots and watcher failures record an explicit
  degraded reason and retain coordinator-hook plus post-hoc detection.
- P2.5 is early detection, not containment. It does not prevent or isolate
  writes; P6 transactional workspaces remain the containment boundary.
- P2.4 notification identity is implemented additively. New launch origins add
  the coordinator `sessionId` and realpath-normalized `workspaceId`, with exact
  inheritance across every continuation. Session push is the stricter default;
  `workspace` and `all` are documented widening paths. A private SessionStart
  marker now persists for 72 hours and records the coordinator plus a bounded
  ancestor chain as PID/start-time pairs. The monitor resolves it directly
  against its own parent chain; missing start times, dead coordinators, absent
  matches, and equally specific sessions record and emit workspace fallback
  instead of guessing. The former responder/request handshake is removed. Push
  scope never gates pull or control.
- The required P2.4 experiment on Claude Code 2.1.220 found that both a manual
  Git worktree and `claude --worktree` set SessionStart `cwd` and
  `CLAUDE_PROJECT_DIR` to the actual worktree path. The inferred
  parent-directory collision for Claude-created worktrees is false on that
  build, so P2.4 adds no workaround for it.
- P3 acceptance-by-default is implemented additively. Write attempts derive and
  cache repository-sourced verification profiles, run broker verification on a
  stable real-tree observation after nonzero changes, and retain every
  no-recipe, explicit-exception, global-disable, timeout, failure, and stale
  path. Existing `status` values are unchanged; `acceptance` records
  ready/blocked evidence beside them, while CLI/MCP decisions alone can mark an
  attempt accepted or rejected. Automatic deterministic fix continuations are
  opt-in, progress-checked, budget-checked, and hard-capped at three.
- P2b resident ownership is implemented additively. `delegate-supervisor` is a
  lazily started, single-instance user process reached through a private
  `0600` Unix-domain socket. It owns worker process groups, persists attempt
  leases and heartbeats, adopts only positively identified leased workers,
  drains on termination, survives coordinator-session teardown, and exits
  after a configurable idle window. Process exit/signal and lease attribution
  are written to the ordinary job and terminal audit records. Any start,
  protocol-skew, or submission failure retains the pre-existing
  inline-detached launch path.
- Invariant 4 is explicit in the implementation: supervisor reconciliation
  enumerates only lease files the supervisor created. Existing inline jobs have
  no lease and are never scanned, adopted, reclassified, or orphaned by a
  supervisor boot. An older incompatible resident drains only with zero live
  leases; otherwise the newer broker leaves it alone and falls back inline.
- P2a push bridge is implemented additively: the experimental Claude Code
  plugin monitor watches bounded tails of the existing `jobs/` store and emits
  only redacted actionable edge transitions. P2.4 subsequently narrowed the
  default from launch-time `origin.projectDir` to session identity, with
  workspace and fleet widening paths; origin-less historical records are
  silent unless a fleet session explicitly selects scope `all`. It is
  read-only with respect to jobs and control, never replays individual
  historical outcomes at startup, and leaves `delegate_inspect`,
  `finishedPath`, and the TUI as the universal pull fallback.
- Claude Agent lifecycle honesty is implemented as part of P2b:
  `SubagentStart`/`SubagentStop` correlate the hook-created record by
  `agent_id`, while a required transcript-quiet backstop terminalizes missing
  stop signals as failed `ended-unknown`. Reconciliation runs during reads, so
  old `spawn-returned` records heal without migration, and retention remains
  bounded.
- P1 schema/projection groundwork is implemented additively: versioned
  WorkSpec, WorkItem, Attempt, Finding, ChangeSet, and Decision models; total
  compatibility projections over historical jobs; read-only CLI/MCP views; and
  unused, test-only persistence helpers for the future `work/` store.
- Existing `jobs/` records are neither migrated nor extended. Resume branches
  sharing an observed root project as one WorkItem with ordered Runs, while job
  IDs remain the Attempt identifiers accepted by all existing surfaces.
- Production paths do not write WorkItems in P1. Unknown fields and future
  schema versions are preserved by the persistence helpers for later phases.

## Why

delegate-router is a strong supervised-run broker. It is not yet a native part of
agentic development: every fact reaches the coordinator only because the
coordinator asked, and every capability that matters is gated behind an optional
field that nobody remembers to set.

Evidence from the live store (255 job records, 257k journal events, 2026-07-26):

| Observed | Meaning |
|---|---|
| 0 jobs with `verify` / recorded `verification` | The mandated trust mechanism has never run |
| 0 worktree-isolated jobs (252 shared) | Safe-parallelism exists only in documentation |
| 113 write jobs, 70 with `allowedPaths` | Scope fencing is a habit, not an invariant |
| 0 output-token caps set | Budget enforcement is optional, therefore absent |
| 32/252 prompts with an Objective heading, 18 with acceptance criteria | The packet is an untyped string; lint only warns |
| 249 Codex vs 3 Cursor jobs | Outcome-learned routing would be statistical theater |
| 43 child jobs, chains 5 deep | Real multi-round work whose meaning lives only in prompts |
| 1 architecture-brief job lost to a session restart | Detached execution is not durable execution |

Two independent research streams (external landscape; internal architecture
audit) converged on one conclusion: **acceptance does not exist as a concept
here.** `completed` means the provider stopped talking. Everything else is
manual. Cheaper initiation without cheaper acceptance is the documented way to
make things worse (2026 field data: PRs merged unread +31.3%, review duration
+441%; underspecified agents do not fail, they guess plausibly).

## Governing constraint

**Nothing breaks.** This is a rewrite of the centre performed as a sequence of
additive, independently shippable releases. Concretely, every phase must hold:

1. `node --test test/*.test.mjs` green, never fewer tests than the phase started with.
2. No breaking change to: MCP tool names/schemas, CLI flags, job-id format, the
   on-disk store layout, or event types already consumed. New fields are
   additive; new events are additive; readers tolerate their absence.
3. Existing job records remain readable and renderable forever. Migration is by
   **compatibility projection**, never by rewriting history.
4. In-flight jobs survive a plugin upgrade. A new broker adopts, or leaves
   alone, work started by the previous version — it never orphans it.
5. Every phase is independently releasable and independently revertible.
6. Defaults may become stricter only where a documented escape hatch exists and
   the stricter default is announced in CHANGELOG.
7. The pull path (`delegate_inspect`, `finishedPath`, the TUI) keeps working
   when any ambient/push path is unavailable — experimental surfaces degrade,
   they do not gate.

## Target model

The durable unit becomes the objective, not the provider invocation.

```
WorkItem
├── WorkSpec      objective, scope claim, acceptance criteria, verify recipe,
│                 budget (wall time, rounds, output tokens), immutable base
├── Step DAG      implement → verify → review → fix, or fan-out/candidates
│   └── Run
│       └── Attempt   one provider process/session  (today's "job")
├── Findings      {id, severity, criterion, status, introducedBy, resolvedBy}
├── ChangeSet     produced outside the owner's tree; verification evidence
└── Decision      ready-for-review | accepted | rejected | superseded
```

Today's jobs become attempts. Job IDs remain valid identifiers and remain
addressable by every existing tool.

## Phases

Each phase ships. Each phase is useful alone.

### P1 — Schema and projections (no user-visible change)
WorkSpec/WorkItem/Finding/ChangeSet/Decision types, versioned event schema, and
compatibility projections that present every existing job as a single-attempt
WorkItem. Nothing else changes. Unblocks everything after it.

### P2 — Resident supervisor + push bridge
Move worker ownership out of the session-scoped MCP process into a user-level
supervisor with attempt leases, heartbeats, process/signal telemetry, and crash
adoption. Ship a plugin monitor (`monitors/monitors.json`) that pushes only
edge transitions into Claude: needs-input, permission-blocked, verification
failed, scope violation, stalled-past-policy, ready-for-review, terminal
failure. `finishedPath` stays as the external sentinel.

Fixes: work no longer dies with the session; babysitting loops disappear.

### P2.4 — Notification scope: session and worktree identity

v0.30.0 scoped push notifications by `origin.projectDir`. That fixed cross-repo
noise but leaves two cases where a session is still told about work that is not
its own — both owner-reported from live use:

1. **Two sessions in the same project.** A monitor is given a project directory
   and no session identity, so sibling sessions in one repo cross-notify. The
   scoping key cannot separate them.
2. **`--worktree` sessions.** `workspace.project_dir` is documented as *the
   directory where Claude Code was launched*, so manually-created worktrees
   (`git worktree add`, then launch there) are correctly isolated — their launch
   directories differ. But when Claude Code creates the worktree itself, both
   sessions launch from the same parent, so they likely share a project dir and
   cross-notify. This is inferred from the documented semantics of
   `worktree.original_cwd` and **must be verified empirically before shipping a
   fix based on it**.

Both are the same defect at different granularity: the scope key is coarser
than the thing a user thinks of as "my work".

- Record `origin.sessionId` (the MCP server knows its own session) and a
  resolved `origin.workspaceId` that prefers the most specific workspace
  identity available — worktree path when inside one, project dir otherwise.
  `origin.cwd` is already captured and differs for worktree sessions even when
  the project dir does not.
- A monitor has no session id of its own, so `SessionStart` writes a durable
  correlation marker containing the coordinator's bounded ancestor chain. The
  monitor matches `(pid, process start time)` identities against its own parent
  chain, prefers the nearest common ancestor, and uses recency only among
  duplicate markers for that session. Equally specific distinct sessions are
  ambiguous. If process start time is unavailable or correlation otherwise
  fails, fall back to workspace scope rather than guessing, and say so in the
  status line.
- Default scope becomes **this session's own work**, with `workspace` and `all`
  as explicit opt-ins. Three honest levels instead of one approximate one.
- Origin-less legacy records stay silent at every level except `all`.

Anti-goal: do not gate control operations on scope. Cross-session management is
legitimate; this is about not being told about work that is not yours, never
about restricting what you may touch.

### P2.5 — Live collision alerts

Scope violations are found *after* files change, and the writer guard is blind
to the coordinator's own edits (documented in CLAUDE.md). Turn a running work
item's owned paths into watched paths via `SessionStart.watchPaths` +
`FileChanged` (both verified available, both unused today), plus
`PostToolUse(Edit|Write)` / `PostToolBatch` for in-session edits. When the
coordinator or another session touches a path a live attempt owns, alert at the
moment of collision instead of at acceptance, and mark any verification
evidence covering that path stale.

Containment stays post-hoc until P6 gives writers isolated workspaces; this is
early *detection*, and must not be described as enforcement. Alerts obey the
P2a nagware policy (edge-triggered, deduplicated per path+item).

Implemented behavior:

- SessionStart returns absolute `watchPaths` for a private state-directory
  refresh signal plus live scoped attempts' `allowedPaths` roots and
  already-observed changed files. Starting an attempt or observing another
  attempt-owned file touches the private signal, causing FileChanged to refresh
  the dynamic set without polling.
- The set is deterministic and capped at 256 paths including the signal, so at
  most 255 owned roots are armed at once. Roots past the cap are not silently
  dropped: affected attempts record `collision.watch.degraded` and
  `collisionWatch.reason: "watch-path-cap-exceeded"`. Edit/Write hooks and the
  existing post-hoc completion inventory remain active for every root.
- FileChanged is asynchronous and never blocks a file change.
  PostToolUse(Edit|Write) and PostToolBatch observe successful coordinator
  writes and always exit zero. Malformed payloads and watcher failures also
  exit zero; a known watch failure records its reason and degrades to the
  coordinator hooks plus the prior post-hoc checks.
- Provider file-change observations retain only bounded path/metadata
  fingerprints, never file contents. A matching attempt fingerprint suppresses
  watcher self-alerts. A watcher event with no prior provider attribution does
  not guess: Claude-session writes still flow through the Edit/Write hooks and
  the existing post-hoc checks remain the fallback. Once an attempt fingerprint
  exists, a later different touch records one `collision.detected` event per
  attempt/path.
- The P2a monitor detects that additive record as a priority collision edge.
  Its existing session/workspace/all filtering determines which session sees
  the alert, and its existing dedupe, cooldown, snooze priority, and rate
  ceiling determine when it emits.
- Verification evidence covering the collided repository path changes to
  `state: "stale"` with `inputChanged: true` and
  `staleReason: "base-drift"`. The path is also added to `baseDriftPaths`, so
  undecided acceptance cannot rely on evidence from before the touch.

Honesty boundary: this phase detects a collision earlier. It does not prevent,
contain, roll back, or isolate the write. Those properties require P6
transactional workspaces.

### P3 — Acceptance by default
Write dispatch requires scope, acceptance criteria, a real verify recipe (or a
recorded "no reliable check exists" exception), and a budget. Provider
completion moves a WorkItem to `ready-for-review` — never `accepted`.
Verification runs on the real tree by default, derived from repo conventions
rather than declared per job. Bounded automatic fix rounds only when the failed
criterion is deterministic, scope and privileges are unchanged, budget remains,
and progress is measurable.

Fixes: 0/255 verification becomes the default path; `success` stops meaning
"the provider stopped talking".

### P4 — Native session integration
Status-line work-state chip, `SessionStart` context + `watchPaths`,
`SessionStart(source=compact)` rehydration, `PostToolUse(Edit|Write)`/`PostToolBatch` overlap
invalidation, `SubagentStart/Stop` correlation, `WorktreeCreate` ownership for
approved workflows only, MCP resources and prompts, `footerLinksRegexes`.

Nagware boundary is a hard requirement, not a preference: edge-triggered only,
per-item deduplication, cooldowns, snooze; priority order policy breach → human
input → acceptance ready → failure; everything else stays in the status line.

Implemented behavior:

- Release 0.71.0 adds [native Mods](../skills/delegate/references/native.md):
  immediate scoped commands, an explicitly opened terminal/Desktop job panel,
  official host-reported Claude allowance capture, per-plugin `/config` options,
  and a quota-aware read-only reviewer. The Node broker owns durable state and
  every mutation; UI controls ask a person and preserve revision/idempotency
  contracts. Model-free host tests supplement the existing fake-provider suite.
- `delegate-config statusline enable` retains the user's complete original
  `statusLine` object for exact restoration, runs its command with the original
  stdin/shell semantics, and prefixes `D <running> · <needs review> ·
  <provider allowance>`. A five-second `refreshInterval` keeps background work
  visible during coordinator idle while Claude Code's native 300 ms debounce
  still coalesces busy updates. `DELEGATE_NATIVE_STATUSLINE=0` suppresses only
  the Delegate chip.
- SessionStart returns the P2.5 `watchPaths` plus `additionalContext`;
  its source=compact invocation returns the same context projection. It includes current
  session-owned active attempt IDs, policy/human/acceptance blockers,
  ready-for-review attempts, and resumable chain leaves. It never reads or
  emits prompts, result text, diffs, repository paths, secrets, or free-form
  errors. The hard 2,048-byte cap keeps higher-priority and newer state,
  records the number omitted, and points overflow/new-session recovery to
  `delegate_list`. `DELEGATE_NATIVE_CONTEXT=0` leaves watch arming intact.
- PostToolUse(Edit|Write) and PostToolBatch continue through the single P2.5
  collision hook. A touched owned path produces one deduplicated collision,
  stales applicable verification with `inputChanged`, and blocks undecided
  acceptance; P4 adds no duplicate watcher, event, or notification.
- The control server advertises fixed `delegate://work/active` and
  `delegate://repo/profile` resources, a
  `delegate://job/{id}/diff` resource template, and
  `delegate_start_scoped_review` / `delegate_resume_with_findings` prompts.
  The diff is the already-redacted journal artifact and is capped at 60,000
  characters. Clients without resource/prompt support continue using the
  unchanged tools; `DELEGATE_NATIVE_MCP=0` removes only these additive
  capabilities.
- `delegate-config statusline enable` also appends a linear
  `footerLinksRegexes` job-ID rule without changing existing rules. It defaults
  to a `vscode://file` link to the private job record; set
  `DELEGATE_NATIVE_FOOTER_SCHEME=cursor` before enabling for Cursor. Run
  `delegate-config footer-links disable` to remove only Delegate Router's rule,
  or set `DELEGATE_NATIVE_FOOTER_LINKS=0` before status-line enable to skip it.
- The P2a nagware contract is unchanged: edge-triggered only; per-item/path
  deduplication; cooldowns; snooze; and priority policy breach → human input →
  acceptance ready → failure. Successful intermediate activity, every edit or
  command, provider completion by itself (including historical records without
  explicit acceptance evidence), and facts already visible in the status line
  remain silent.

### P4.5 — Conversational delegation (bidirectional real-time)

Delegation today is a one-shot handoff: the worker guesses when under-specified
(the documented failure mode — underspecified agents guess plausibly rather than
fail) and the coordinator discovers it only at the end. Make the channel run
both ways, live, for **both providers**.

Already in place: Cursor `cursor/ask_question` / `cursor/create_plan` block as
real JSON-RPC requests and resolve through the durable control inbox
(`input.requested` → `delegate_respond` with `expectedRevision` + idempotent
`commandId`); Codex approval requests use the same inbox; `delegate_steer
strategy=same-turn` injects into a live Codex turn; and P2a pushes the
`needs-input` edge the moment it happens.

What this phase adds:

- **A broker-owned back-channel MCP server injected into every delegated
  session**, exposing `ask_coordinator(question, options?, urgency)` (blocking)
  and `report_progress(milestone)` (non-blocking). Injection points already
  exist and are currently unused: Cursor ACP `session/new { mcpServers: [] }`,
  Cursor headless `--approve-mcps`, and Codex `thread/start { config }`.
  This gives Codex the free-form ask primitive it lacks, and gives Cursor
  headless the ability its ACP path already has — one normalized question
  shape across providers and transports.
- **Cursor parity in both directions.** Cursor ACP v1 has no same-turn
  correction, so coordinator→worker stays honest restart-only there; the
  back-channel closes the gap from the other side by letting the worker ask
  *before* it guesses. `cursor/update_todos` and `cursor/task` feed progress
  without a round trip. Never describe Cursor restarts as same-turn steering.
- **Reach the human, not just the coordinator session**: PushNotification on
  `needs-input`, inline answering in the TUI, and an actionable monitor line —
  so a blocked worker never waits on the coordinator being at the keyboard.
- **Context with the question**: what it is stuck on, the diff so far, the
  options considered. An answer may carry a steer.
- **Timeouts and defaults**: per-question timeout, declared default action on
  expiry, blocked time excluded from stall detection and attributed against the
  work item's wall-clock budget (uses P2b leases).

Security boundary, non-negotiable: the back-channel carries **questions only,
never authority**. No scope widening, no permission grants, no budget raises,
no self-approval, no control-plane access. `request_scope_expansion`, if it
ever exists, is an owner-gated question — not a capability. Redaction applies
in both directions.

Implementation progress (2026-07-27): complete in source. A separate
`delegate-backchannel-mcp` exposes exactly the two tools above and is injected
through Codex `thread/start.config.mcp_servers`, ACP
`session/new|load.mcpServers`, and a private Cursor headless plugin approved
only for that launch. The installed Codex app-server accepted the per-thread
config in a read-only ephemeral handshake. Session-establishment injection
errors retry without the server; headless plugin rejection retries without the
plugin, so an unreachable channel preserves the previous job behavior.

All transports project the same bounded/redacted pending-question shape:
question, options, urgency, stuck context, diff so far, options considered,
expiry, and `defaultAction: reject`. The existing revisioned
`delegate_respond` inbox supplies the answer; structured answers may contain
only `answer` and optional `steer`, both guidance within the original
constraints. Wait time is stored on the attempt lease and counts against the
unchanged job wall-clock deadline while `user-input-required` is excluded from
stall detection. The TUI answers with `a`, and monitor output names both that
key and the revisioned CLI command. Cursor corrections remain restart-only.

### P4.6 — Plan-first dispatch and ambiguity detection

Two cheap passes that attack the documented failure mode — underspecified
agents guess plausibly rather than fail — before any code is written.

**Plan-first dispatch.** `dryRun` today previews the resolved *packet*, not the
*work*. Both providers have a plan mode currently used only for read-only jobs.
Run a plan pass first, present the approach with its predicted blast radius
(files, components, estimated tokens/duration from the P8 ledger bands), and on
confirmation continue **the same provider session** into implement — no context
re-establishment, no second spend. Declining costs one cheap pass instead of a
full implementation. For write work this becomes the default path, with an
explicit opt-out for trivial changes.

**Ambiguity detection by plan divergence.** Ambiguity is invisible when
watching a single agent, because a single agent simply picks one reading. Run
the same WorkSpec through two independent cheap plan passes (different provider
or model) and compare structurally — target files/components, approach shape,
declared assumptions. Convergent plans mean the spec is understood; materially
divergent plans mean the spec is ambiguous, and that is the moment to ask the
owner, before implementation. Report the divergence itself as the question.
This turns provider diversity into a specification test rather than redundant
cost. Comparison must be structural, not prose similarity; when the comparison
is inconclusive, say so rather than inventing a verdict — never gate work on a
confident-sounding guess about ambiguity.

Both are budget-bounded and skippable; neither may auto-launch write work.

Implementation progress (2026-07-27): complete. Managed write launches default
to a read-only plan turn with an explicit coordinator confirmation; confirmed
Codex, Cursor ACP, and supported Cursor headless paths continue the same
provider session into write mode. The independent pass uses a different
provider or model and a strict structural schema. P9 now refuses a lane whose
negotiated `planMode` capability is absent; an operational plan-turn failure
after a capable lane starts retains the recorded fallback. Invalid comparison
evidence is reported as inconclusive.
`delegate_start_trivial` and `delegate-jobs start --no-plan-first` are the
announced escape hatches.

### P4.7 — Worker interrogation (read-only, mid-flight)

Ask a *running* worker a question without steering it: "why this approach?",
"what does this hunk do?", "what did the failing check actually say?" — answers
come from the worker's live context, which is far richer than the journal, and
the turn's objective is unchanged.

Distinct from `delegate_steer`, which alters the task. Interrogation is
read-only by contract: it may not modify the objective, scope, privileges or
budget, and a worker's answer is evidence, never authorization. Implemented on
the P4.5 back-channel in reverse — coordinator→worker query, worker→coordinator
answer — using Codex `turn/steer` framing for a question that requests no
action, and for Cursor a queued question honoring its restart-only limitation
(never described as same-turn). Most valuable during review, while the
implementation is still in the worker's context; answers attach to the work
item as findings evidence.

Cost note: an interrogation consumes provider turn tokens. It is bounded by the
work item's budget and counted against it like any other turn.

Implementation progress (2026-07-27): complete. `delegate_interrogate` and
`delegate-jobs interrogate` add a strict question-only control record to the
existing revisioned inbox. Codex answers from its active turn through a
no-action `turn/steer` frame. Cursor queues a separate read-only turn on the
same session and is not described as same-turn steering. Answers become
findings evidence with observed usage attribution; they can never mutate or
widen the stored contract.

### P5 — Intent→spec compiler
Accept a sentence, a diff, a failing test, a TODO, or a task record; derive a
structured WorkSpec draft from repo profile and current evidence; surface every
inferred field with provenance and confidence in one confirmation card; block
write dispatch until unresolved fields are resolved. Infer-then-confirm, never
omit.

Implementation progress (2026-07-27): complete in source. `delegate-jobs spec`
compiles without creating broker state. `delegate-jobs start` selects the
compiler only when an intent-source flag is present, renders the same card, and
requires interactive confirmation or the documented `--accept-spec`
automation flag; that flag confirms only a complete displayed draft. The TUI
launcher adds the same source choices, structured resolution fields, and card
to its existing dry-run confirmation pane.

Sentence, Git changed-path, failure-output, TODO, task-record, and conventions
evidence are bounded and local. Sensitive TODO/task-record paths are refused,
diff inference reads path/status metadata rather than file bodies, and no model
or network call is made. The P3 verification profile is derived read-only
without writing its cache during compilation. Stored compilation metadata
retains the source, confidence, provenance, confirmation method, and digest;
the confirmed WorkSpec is projected by P1 and its structured packet is the
input to P4.6.

Authority stays separate from inference. A scope candidate never becomes
`allowedPaths`; write dispatch requires that fence as an explicit owner input.
Network, sandbox-off, approval/override/sensitive access, add-dir/MCP/worktree
privileges, scope widening, and budget increases are likewise copied only from
explicit launch options and shown on the card. Low-confidence fields remain
unresolved rather than being promoted by a blanket confirmation.

### P6 — Transactional workspaces
Broker-owned worktrees/overlays from an immutable base, path/resource claims for
scheduling, change sets produced outside the owner's tree, integration worktree
for composition, CAS apply at acceptance, rollback by discarding the workspace.
Legacy shared-tree jobs keep today's conservative revert policy.

Implementation progress (2026-07-27): the contained workspace/change-set half
and integration boundary are complete. `delegate_start` /
`delegate_start_trivial` accept the additive `isolation`, `pathClaims`, and
`resourceClaims` fields; CLI uses `--isolation worktree --path-claims ...`
and optional `--resource-claims ...`. The option is never inferred or
defaulted. The broker refuses non-Git and bare repositories, subdirectory
launches, repositories whose immutable tree contains submodules, state storage
inside the owner repository, missing `HEAD`, incompatible external-write
grants, occupied workspace paths, and any bounded Git inspection or creation
failure. Detached owners and existing linked worktrees are supported. Dirty
owner trees are supported because the attempt starts from committed `HEAD`;
the owner dirty-path inventory is evidence only, and changed targets must
still pass content-and-mode CAS.

Claims schedule; isolation contains. `pathClaims` are concrete prefixes and
must cover the `allowedPaths` write fence, but they do not enforce or contain
writes. The broker schedules overlapping isolated claims and exact resource
claims, while the detached worktree plus sandbox boundary keeps provider
source writes outside the owner's tree. Shared-tree attempts remain
`detection-only`; P2.5 has not been relabeled as containment.

Terminal isolated attempts stage their workspace index only inside the broker
worktree, emit a private full-index binary Git patch plus base/result object
manifest, and then remove only the validated state-directory worktree. The
legacy `delegate-jobs revert` implementation explicitly refuses these jobs and
is otherwise unchanged. `delegate_integrate` / `delegate-jobs integrate`
compare every target's current bytes and executable/symlink mode with its
immutable-base object, report all conflicting paths, create an integration
worktree from current `HEAD`, and apply change sets without `--3way` or any
merge-resolution path. Same-path composition and any apply failure discard the
integration worktree.

Deferred deliberately: direct owner-tree application, workspace continuation
rounds, subdirectory roots, submodules, `ingestFiles`, `addDirs`, sandbox-off,
repository-local clean/smudge filters, and auto-fix rounds. Broker Git commands
disable hooks, fsmonitor hooks, and global/system Git configuration. A clean
owner CAS preflight currently returns
`WORKSPACE_APPLY_DEFERRED`; moved targets return `CAS_CONFLICT`. This is the
governing stop condition in action, not a claim that integration is complete.
No `WorktreeCreate` hook is globally registered: explicit broker launch
options are the owner-approval boundary, so ordinary Claude/Git worktree
creation is never intercepted.

### P7 — Work-item cockpit
TUI's primary object becomes the WorkItem: compose (structured spec card with
provenance), review (diff + verification + drift + findings together), approve
(CAS apply into integration workspace), compare (candidates side by side),
replay (scrub by event sequence), converge (findings open/resolved/regressed
with the bounded next-round policy shown before launch).

Implementation progress (2026-07-27): the additive cockpit ships Compose,
Review, Approve, Compare, and Converge on the existing P1 projection and P3/P6
broker seams. Existing job-centric screens and controls are unchanged. Approve
can record evidence-bound accept/reject and can prepare a broker-owned
integration worktree, but never presents direct owner-tree application.
Replay is deliberately disabled with its reason rendered: the current
normalized journal cannot rebuild an arbitrary historical projection without
loading the full prefix, and its endpoint requires the entire journal. A later
cut needs persisted projection checkpoints or a reversible reducer before a
scrubber can satisfy O(viewport).

### P8 — Outcome ledger
Broker/adapter/provider versions, packet features, task shape, verification,
findings, acceptance, usage, and rejection reasons on every attempt. Separate
provider-completion, verification-pass, and owner-acceptance rates. Cohort views
so a fixed-in-July failure mode stops poisoning lifetime numbers. Outcome-aware
routing only once labels exist and only as confidence-bounded recommendation.

Implementation progress (2026-07-27): complete in source. Attempt records and
append-only terminal/decision audit snapshots carry a versioned provenance
envelope plus task/packet/outcome evidence. Later owner decisions append a
full redacted revision; readers coalesce by job ID and audit revision, so
acceptance survives pruning without duplicating attempts or usage. Historical
records remain total with missing fields and are never migrated.

The three rates have distinct labeled denominators and a minimum sample of 10.
Only broker-originated real-tree checks label verification, and only explicit
accepted/rejected decisions label owner acceptance. `since` accepts a
duration, ISO date, or broker version; `until` adds an exclusive date boundary;
broker and UTC-day cohorts expose ORPHANED counts. Recommendation requests use
owner labels for a matching task shape, require 20 samples per provider and
non-overlapping fixed-95% Wilson intervals, otherwise say
`insufficient-data`. They are returned as read-only evidence and are not wired
into static route selection.

### P9 — Provider attempt-driver contract
Extract Codex app-server, Cursor ACP, and Cursor headless behind capability
negotiation and lifecycle methods. Honest non-parity stays explicit: no
lowest-common-denominator design.

Implementation progress (2026-07-27): complete in source. The formal driver
surface has `start`, `resume`, `prompt`, `steer`, `cancel`, and `close`, plus a
negotiated scheduling profile for workflows, output/context budgets,
checkpoints, and containment. The broker selects a lane once and calls the
contract; provider-name branching no longer selects the managed attempt loop.
Existing Codex and Cursor loop bodies remain the behavioral implementation, so
their journal types, result shapes, errors, ordering, retries, and fallback
boundaries do not change.

Capability refusal is a scheduling decision, not a late provider downgrade.
For example, Cursor ACP refuses the `mid-turn-output-budget` workflow because
it lacks `midTurnTokenUsage`; its `usage_update` is context occupancy, not
billable token totals. Completion-only output accounting remains available
where it already existed, but is not relabeled as a mid-turn guarantee.
Existing public MCP schemas and CLI flags are unchanged.

## Program completion record

Shipped phases: P1; P2a, P2b, P2.4, and P2.5; P3; P4, P4.5, P4.6, and P4.7;
P5; the contained-workspace and integration-worktree boundary of P6; the
Compose/Review/Approve/Compare/Converge cockpit of P7; P8; and P9. Historical
jobs remain compatibility-projected and no phase rewrites the store.

Deliberately deferred:

- P6 direct owner-tree application. Strict CAS preflight and composition stop
  at a broker-owned integration worktree because multi-file replacement cannot
  be made atomic against unmanaged editors with the available primitives.
- P6 workspace continuation/auto-fix rounds, subdirectory roots, submodules,
  `ingestFiles`, `addDirs`, sandbox-off, repository-local clean/smudge filters,
  and native Cursor worktree combinations.
- P7 replay. The journal still lacks persisted projection checkpoints or a
  reversible reducer, so arbitrary rewind cannot meet the O(viewport) cockpit
  requirement.
- P8 learned routing. Outcome advice remains read-only and confidence-gated
  until sufficient explicit owner labels exist; it does not replace the static
  router.

Remaining lane non-parities:

| Capability | Codex app-server | Cursor ACP | Cursor headless |
| --- | --- | --- | --- |
| Same-turn steering | yes, `turn/steer` | no, cancel-and-resume restart | no, process termination plus resume |
| Live shell stdout | yes, output deltas | no, completed tool output | no, completed tool records |
| Mid-turn token totals | yes | no | no; terminal result only |
| Context occupancy | no distinct occupancy measure | yes, `usage_update` | no |
| Plan mode | broker read-only turn | ACP session mode | CLI `--mode plan` |
| MCP injection | thread config | session MCP servers | launch-scoped plugin |
| Worktree containment | broker-owned worktree | broker-owned worktree | broker-owned worktree |
| Pre-prompt pause | yes | yes | no |

These are not a backlog promise. A future provider build may change a row only
after a read-only probe or updated primary documentation supports the claim.
Operational MCP-injection failure keeps the documented non-fatal fallback, but
the unavailable back-channel is never described as present for that attempt.

## Anti-goals

- Not an autonomous TODO miner. It may prepare a proposal; it never turns
  repository text into paid, write-capable work without confirmation.
- Not a replacement for judgment. Checks and reviewers produce evidence;
  architecture, intent, risk acceptance and integration stay human.
- Not an infinite review loop. Every workflow carries round, time, output and
  allowance limits, and a no-progress stop.
- Not a shared-dirty-tree auto-merger or auto-rollback engine.
- Not a learned router before acceptance labels exist.
- Not a multi-tenant orchestration service. Local, single-owner, loopback/SSH.
- Not a permanent source-code surveillance archive. Compact redacted decision
  evidence is retained; raw prompts, transcripts and diffs expire by policy.
- Not a second dashboard competing with the native agent view.
- Not peer-negotiating agents. Hierarchical supervision stays.

## Design rule

**Ambient preparation, automatic evidence, explicit authority.**
The substrate may prepare, monitor, verify, recover and recommend on its own. It
must never spend allowance, widen scope, grant privileges, integrate changes, or
declare semantic acceptance without the owner.
