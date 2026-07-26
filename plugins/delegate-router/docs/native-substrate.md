# Native substrate program

Status: active. Owner-approved 2026-07-26 as a single program.
Supersedes the direction in `ROADMAP.md` (whose waves shipped through v0.26.x).

## Progress

- P2a push bridge is implemented additively: the experimental Claude Code
  plugin monitor watches bounded tails of the existing `jobs/` store and emits
  only redacted actionable edge transitions. It is read-only, never replays
  individual historical outcomes at startup, and leaves `delegate_inspect`,
  `finishedPath`, and the TUI unchanged as the universal pull fallback.
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
