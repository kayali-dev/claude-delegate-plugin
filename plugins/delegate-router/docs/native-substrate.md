# Native substrate program

Status: active. Owner-approved 2026-07-26 as a single program.
Supersedes the direction in `ROADMAP.md` (whose waves shipped through v0.26.x).

## Progress

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
  only redacted actionable edge transitions. Push is scoped by the immutable
  launch-time `origin.projectDir` by default, so unrelated projects and
  worktrees do not cross-notify; origin-less historical records are silent
  unless a fleet session explicitly selects scope `all`. It is read-only,
  never replays individual historical outcomes at startup, and leaves
  `delegate_inspect`, `finishedPath`, and the TUI as the universal pull
  fallback.
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
- A monitor has no session id of its own, so `SessionStart` writes a correlation
  marker the monitor resolves at boot; if correlation fails, fall back to
  workspace scope rather than guessing, and say so in the status line.
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
`PostCompact` rehydration, `PostToolUse(Edit|Write)`/`PostToolBatch` overlap
invalidation, `SubagentStart/Stop` correlation, `WorktreeCreate` ownership for
approved workflows only, MCP resources and prompts, `footerLinksRegexes`.

Nagware boundary is a hard requirement, not a preference: edge-triggered only,
per-item deduplication, cooldowns, snooze; priority order policy breach → human
input → acceptance ready → failure; everything else stays in the status line.

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

### P5 — Intent→spec compiler
Accept a sentence, a diff, a failing test, a TODO, or a task record; derive a
structured WorkSpec draft from repo profile and current evidence; surface every
inferred field with provenance and confidence in one confirmation card; block
write dispatch until unresolved fields are resolved. Infer-then-confirm, never
omit.

### P6 — Transactional workspaces
Broker-owned worktrees/overlays from an immutable base, path/resource claims for
scheduling, change sets produced outside the owner's tree, integration worktree
for composition, CAS apply at acceptance, rollback by discarding the workspace.
Legacy shared-tree jobs keep today's conservative revert policy.

### P7 — Work-item cockpit
TUI's primary object becomes the WorkItem: compose (structured spec card with
provenance), review (diff + verification + drift + findings together), approve
(CAS apply into integration workspace), compare (candidates side by side),
replay (scrub by event sequence), converge (findings open/resolved/regressed
with the bounded next-round policy shown before launch).

### P8 — Outcome ledger
Broker/adapter/provider versions, packet features, task shape, verification,
findings, acceptance, usage, and rejection reasons on every attempt. Separate
provider-completion, verification-pass, and owner-acceptance rates. Cohort views
so a fixed-in-July failure mode stops poisoning lifetime numbers. Outcome-aware
routing only once labels exist and only as confidence-bounded recommendation.

### P9 — Provider attempt-driver contract
Extract Codex app-server, Cursor ACP, and Cursor headless behind capability
negotiation and lifecycle methods. Honest non-parity stays explicit: no
lowest-common-denominator design.

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
