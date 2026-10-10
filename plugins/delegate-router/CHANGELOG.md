# Changelog

All surfaces (skill, MCP servers, CLI) version together. The CLI resolves to the installed plugin on every run via `delegate-shim`; the skill and MCP servers pin at Claude Code session start — reload plugins after upgrading to align all surfaces. `delegate-health` prints the active installed version.

## 0.73.0 — 2026-10-10

- Reconcile Codex shell writes from the actual shared tree before scope checks,
  verification and acceptance. Non-Git writes use a bounded fingerprint baseline
  with an early observability notice; incomplete inventories block acceptance.
  Preserve owner untracked bodies, credential exclusions and private runtime state.
- Treat out-of-fence plan targets as structural conflicts even when the plans
  share other targets. Expose explicit trivial review-round plan/comparison
  options without removing the default human gate.
- Refuse shared-job integration without inventing an owner cwd/revision. Add
  explicit integration inspection and idempotent worktree cleanup, retaining
  private patches/manifests. Owner application remains intentionally deferred.
- Correct nested Codex output usage, shared base revision, cache-write counters,
  summary revisions and millisecond attempt timestamps. Mark pending checks as
  skipped on cancellation/failure. Valid structured and explicitly terse results
  no longer trigger the short-final heuristic.
- Polish native selected tabs/hotkeys, attention-first jobs, optional history,
  compact composer, expandable evidence/diagnostics and host diff/Markdown
  rendering. Preserve other AbovePrompt content and review view on refresh.
- Add fake-provider, filesystem/privacy, integration and model-free native UI
  regressions; document observation limits and asynchronous intake semantics.

## 0.72.0 — 2026-10-09

- Add native task composition, exact route/scope/check/budget preview, explicit
  paid-launch confirmation and opt-in redacted public conversation excerpts.
  Writes retain plan-first gates; no arbitrary commands, permissions or model
  substitution enter the native bridge.
- Add a private durable pending queue with priorities, bounded resident passes,
  provider admission caps, quota/writer/claim blockers, eight-hour approval
  expiry and workspace/verification revalidation. Crash recovery reuses the
  reserved idempotent job. This queues jobs, not Claude turns.
- Add paginated diff/plan/report evidence, literal search and recorded-file
  selection with content-version checks, broker verification output and candidate
  base comparison. No automatic owner acceptance or integration.
- Add inline managed-tool inspection cards and a bounded AbovePrompt attention
  band without automatic focus/model turns, plus a unified Claude/broker/provider
  agent view with unknown usage and relationship gaps labeled honestly.
- Add explicit same-workspace revisioned/idempotent supervision claims. Preserve
  immutable launch attribution and permission boundaries; monitor/session scope
  follows the current controller, including subsequent managed continuations.
- Fix Claude monitoring with exact native spawn binding and host lifecycle
  snapshots, retaining classic-hook/transcript fallbacks. Silence alone never
  fails an agent or raises a stall alert; unknown state stays unknown. Quiet
  orphan reconciliation additionally requires a confirmed coordinator exit.
- Unify displayed and enforced wall-clock budgets, retain millisecond start
  precision and freeze default timeout configuration for new jobs. Approval
  wait counts; output silence is not a timer or heartbeat. Add fake-only broker
  and model-free native regression coverage and align operator documentation.

## 0.71.1 — 2026-10-08

- Detect the removal of `codex mcp-server` through bounded top-level CLI help,
  never by trying an unknown command that can become an interactive prompt.
  Keep the optional legacy registration healthy with no tools and instructions
  to use managed app-server tools on current/unverified CLIs. Preserve direct
  shadow-journaled tools on older CLIs that still advertise the command.
- Skip all executable probing for disabled providers. Report optional legacy
  MCP availability in quick health without degrading managed Codex readiness.
  Add fake-only compatibility and fail-closed deadline/output tests; align docs.

## 0.71.0 — 2026-10-08

- Add native Claude Code Mods: seven immediate local commands, an explicitly
  opened terminal/Desktop job panel, scoped metadata polling, bounded evidence
  and diffs, and text fallback on unsupported surfaces. Preserve CLI/MCP and
  classic hooks when native integration is disabled. Target tested host 2.1.294+.
- Human-confirm answer/cancel/steer controls through an allowlisted broker bridge;
  preserve owner-session checks, enabled providers, optimistic revisions, stable
  command IDs and actual provider acknowledgement. Refuse acceptance of missing
  or truncated plan evidence. Never grant sandbox/scope/budget changes from UI.
- Stamp live coordinator identity on this plugin's managed MCP starts, preventing
  stale MCP startup-session attribution after clear/resume without changing
  task, model, scope or permission arguments; leave other tools untouched.
- Capture only official native Claude five-hour/weekly usage fields, sharing
  the private atomic status-line parser. Keep missing data unknown, debounce
  unchanged readings and emit only one capture-fallback notice per session.
- Add native `/config` preferences and a bounded read-only reviewer Agent with
  model inheritance and a plugin-specific allowance guard; no automatic model
  substitution or interception of unrelated agents.
- Make the skill entrypoint lean and load advanced workflows progressively.
  Retain critical write/privacy/approval rules up front and remove mutation tools
  from its automatic permission allowlist. Correct compaction documentation.
- Negotiate supported MCP JSON-RPC versions rather than echoing an unsupported
  new wire revision. Add server discovery instructions and conservative tool
  annotations without changing existing tool names, input schemas or order.
- Add model-free native host tests and a pinned CI host job. Include native tests
  in check/release validation, reject unsupported installer host versions, and
  preserve existing provider selection when no install preset is supplied.

## 0.70.0 — 2026-10-08

- Add bounded, connection-local Codex catalog preflight for model and effort
  support; refuse known invalid selections before opening a thread, preserve
  explicit pins, and never confuse catalog metadata with account entitlement.
- Use compatible native JSON contracts for Codex structural plans and reports,
  while independently validating raw/fenced JSON in the broker. Bound and
  validate the supported report-schema subset; refuse ignored constraints and
  never reuse an earlier fenced deliverable after a malformed final fence.
- Add optional immutable work-level reported-output budgets across continuation,
  auto-fix, and independent planner jobs, with locked private monotonic accounting,
  Codex thread-counter deduplication, and fail-closed ledger recovery. Add
  explicit Codex native-subagent concurrency controls without changing defaults.
- Continue captured isolated candidates in fresh worktrees/provider sessions on
  their original base, checking patch and content manifests, retaining scope
  and verification, and enabling existing bounded deterministic auto-fix there.
  Owner-tree landing and semantic autonomous repair remain deferred.
- Add exact-model statistics cohorts/filtering without relabeling historical
  aliases, and test the runtime's Node 18 minimum as well as current LTS in CI.
- Repair Node 18 event-loop liveness for awaited terminal-width probing and
  child subscribe/unsubscribe deadlines; clear settled deadline timers and
  bound subscribe waits, while interactive background polling remains unref'd.

- Refresh Codex aliases to GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna; retain
  GPT-5.6 Terra as the cost-balanced tier and preserve all explicit model pins.
  Infer native providers for full GPT, Claude, Composer, and Grok IDs, retaining
  provider-disable/quota admission and authorization for full Fable IDs.
- Support current Grok 4.7 base/prefixed CLI and attributed ACP catalogs,
  explicit fast selection, and missing-family/tier refusals. Empty CLI catalogs
  use updated fallback IDs; available catalogs remain authoritative.
- Align README, skill, controls, usage, protocol, TUI, and contributor guidance
  with implemented planning budgets, network controls, monitor/wait behavior,
  supervisor ingestion, and shipped live child transcripts. Mark old roadmap
  and design diagnoses as historical, and remove the duplicate Unreleased
  entry for the child-stream feature already shipped in 0.69.0.
- Refresh model notes from official provider documentation, including current
  Claude aliases and account-dependent Fable billing. Correct the Auto route
  explanation: Cursor may select third-party models, so Auto does not guarantee
  first-party-pool usage. Keep the existing automatic routing order.
- Advertise the broker's existing verification-exception and bounded auto-fix
  options on start/resume MCP schemas so schema-driven clients can use the
  documented controls. Preserve the existing command-verification path.

## 0.69.1 — 2026-08-04

- Pin the behaviour the live child path actually depends on. `thread/list`
  reports a child's status as `notLoaded` even while that child is working —
  the field describes thread-store residency, not execution — and every fixture
  used `active`, so nothing covered the shape production returns. The live path
  is gated on that decision: a refactor dropping the parent-lifecycle preference
  would leave every child looking idle, no subscription would ever be attempted,
  and the tab would serve stored snapshots forever with a green suite. The
  regression asserts the lifecycle wins in both directions and that the thread
  status still governs when no lifecycle evidence exists.

## 0.69.0 — 2026-08-04

- Give a running Codex child a genuinely live transcript, brokered through the
  parent worker's existing app-server connection. Codex tracks thread membership
  per connection, so resuming a child on the connection that already owns it
  introduces no second client and violates no documented assumption — verified
  against `thread_state.rs` rather than assumed. Child events are ephemeral:
  they cross a private `0600` socket under the state root, never enter the
  parent journal, never become a job, and never touch disk. `Live` appears only
  on a confirmed subscription; a rejected, unsupported, worker-gone, or
  acknowledged-then-dropped subscription renders `Stored`, and terminal children
  keep their stored snapshot because it is already complete.

## 0.68.0 — 2026-08-04

- Stop subagent turns from rebinding the parent job's Codex thread. Codex
  reports `turn/started` for SUBAGENT turns on the same connection, carrying the
  child's `threadId` and turn id, and `recordSession` accepted them — so a parent
  that spawned three subagents ended up recorded as the third child. Everything
  keyed on that field then read a child: resume would continue the wrong thread,
  owned-thread exclusion guarded the wrong id, `providerTurnId` aimed steering at
  a turn the coordinator never started, and the Subagents tab asked `thread/list`
  for the descendants of a descendant, which is why it found none. Thread
  identity is now established only by the job's own thread start or resume;
  anything else may confirm it, never replace it, and a foreign thread no longer
  announces a `session.updated` that did not happen.

## 0.67.0 — 2026-08-04

- Stop redacting subagent cache-token counters. Every usage field name contains
  `token`, so each is presumed sensitive and rescued by an allow-list; the
  transcript ingestor introduced `cacheReadInputTokens` and
  `cacheCreationInputTokens`, which the list had never heard of, so a live
  subagent wrote both to its journal as `[REDACTED]`. Unit tests could not see
  it — they assert on the normalizer's output and redaction happens one seam
  later. The allow-list now covers those names, credential-shaped keys are still
  rejected, and a string under a usage-shaped key is still redacted so the
  rescue cannot smuggle one through.

## 0.66.0 — 2026-08-04

- Wait for the plan confirmation gate to exist before reporting a degraded
  launch notice. `recordPrimaryPlanDegradation` records
  `confirmationRequired` together with `planning.state='degraded'`, and the gate
  itself is opened by a later write, so `waitForPlanFirstLaunch` could return
  inside that window and tell a caller `blocking: false` about a job that was
  about to pause for a human decision. The wait now ends when the gate exists,
  when the decision resolves, or at the deadline — where a degraded notice is
  still returned in preference to the generic pending one, so waiting never
  costs the caller its evidence. This surfaced as a ~33% flake in
  `planning-interrogation.test.mjs` that was present in 0.64.0 and 0.65.0; two
  deterministic regressions now pin the window instead of racing for it.

## 0.65.0 — 2026-08-04

- Tail correlated Claude Agent/Task subagent transcripts from the resident
  supervisor into the managed journal, including content-free reasoning
  activity, message boundaries, tools, bounded/redacted output, observed usage,
  model identity, and file-change signals. Durable byte and usage checkpoints
  keep growth live and supervisor restarts idempotent; terminal jobs receive a
  final post-stop drain. `DELEGATE_AGENT_TAIL=0` disables ingestion without
  disabling the existing shadow-job hooks.
- Keep lifecycle-hook transcript ids separate from Agent result display names,
  use readable `meta.json` sidecars only for exact `toolUseId` correlation, and
  reject display-shaped legacy ids during transcript lookup. The agent-type
  heuristic remains only for runs without a readable sidecar. Nested subagents
  at spawn depth 2 or greater still receive no invented shadow job when no
  hook-correlated stub exists.
- Render Claude subagents from ingested journal events when available and retain
  the existing bounded transcript reader only as an all-or-nothing fallback.
- Add a parent-owned Subagents tab to managed Codex and Cursor job detail.
  Codex discovers descendants through version/capability-gated `thread/list`
  and reads only the selected child through bounded `thread/read` snapshots,
  with a version-detected exact-thread local rollout fallback. Running-child
  snapshots are explicitly point-in-time and may be incomplete; they are not
  live subscriptions because cross-process live attachment to a child owned by
  another app-server remains unverified. Cursor renders observed lifecycle rows
  with child transcripts explicitly unavailable instead of inventing sessions.
- Make existing dashboard attention surfaces subagent-aware without adding a
  new attention kind: child errors appear in the notable feed, stale correlated
  children can stall an otherwise chatty parent with the child named in Needs
  you, and successful parents that swallowed a child failure are marked
  `resultSuspect: 'subagent-error-swallowed'` unless an earlier suspect reason
  already explains the required review.

## 0.64.0 — 2026-08-01

- Canonicalize newline-composite Cursor input request IDs at ACP ingestion,
  publish their aliases under one canonical gate, accept any published ID, and
  reject unmatched response IDs synchronously before command intake.
- Attach the latest bounded ACP checklist to Cursor plan confirmations without
  promoting it to a structural plan or ambiguity-comparison input.
- After an unanswered gate auto-rejects, retain timed-out question evidence
  while clearing live attention and the stale `user-input-required` phase
  across fleet, monitor, native-context, and TUI projections.

## 0.63.0 — 2026-08-01

- Add a declared-and-observed `structuralPlanOutput` attempt capability. The
  ambiguity planner now skips incapable provider/model candidates, preserves
  same-provider model independence, records an explicit cold-start degradation
  when none qualify, and can re-admit a lane from bounded valid probe evidence.
- Preserve Cursor assistant-message boundaries across ACP and headless instead
  of concatenating every burst into one terminal message. Correlated deltas and
  completions render once in conversational order; the installed ACP build's
  missing `messageId` has an explicit tool/turn-boundary fallback.
- Map ACP tool `content`/`rawInput`, in-progress status, bounded result output,
  optional usage cost, and newline-composite tool ids into clean normalized
  events. Label nonstandard terminal usage supplied by installed Cursor builds
  as provider-reported extensions; no token totals are inferred.

## 0.62.0 — 2026-08-01

- Weight structural ambiguity evidence by reliability: agreed concrete file
  targets now outweigh component naming, approach organization, and unproven
  prose variance, while disjoint files and explicit same-topic contradictions
  remain blocking. Additive variance metadata and plan-confirmation wording say
  when independent plans describe the same work with different naming; the
  existing `convergent` / `divergent` / `inconclusive` verdict enum is unchanged.
- Preserve asymmetric true positives by comparing pairwise precedence among
  shared decision terms even when one plan omits another term. High-confidence
  negation, opposing-default/action, and known exclusive-scope inversions also
  remain strong blocking assumption conflicts without restoring prose-based
  false positives.

## 0.61.0 — 2026-08-01

- Keep live plan-first state visible throughout job detail with a bounded sticky
  summary, and append a wrapped full Plan tab for structural targets, approach,
  assumptions, and risks. The registry-owned `P` binding reaches the tab
  without moving any existing detail binding.

## 0.60.0 — 2026-07-31

- Pause write-mode jobs at an explicit human plan-confirmation gate whenever
  primary planning degrades. Missing `Allowed scope` is now a caller-facing
  write-launch blocker unless `allowedPaths` or the explicit
  `allowUnscopedWrite` / `--allow-unscoped-write` escape hatch is supplied.
- Retry a primary plan exactly once at its already-recorded ceiling after a
  hard-limit breach. Initial allowances remain fixed by provider/configuration;
  packet bytes and directive counts still do not scale the budget.
- Preserve successful verification verdicts while extracting engine and
  toolchain warnings into additive `verification.caveats[]`.
- Add `delegate_inspect view=summary` / `delegate-jobs inspect --view summary`;
  full remains the default. Add `phase` and `blockedOnInput` list filters to MCP
  and CLI monitoring surfaces.
- Publish additive `attention.state: "user-input-required"` and terminal
  `conclusion: { disposition, health, reason }` vocabulary across records and
  events. A declined plan retains legacy `status: "cancelled"` while reporting
  `disposition: "declined"` and healthy gate operation.
- Keep shared-tree isolation as the compatibility default: worktree isolation
  still requires a Git repository, explicit path claims, sandboxing, and has
  continuation/integration constraints that would reject legitimate existing
  launches. Containment remains one flag plus claims away with
  `isolation=worktree` / `--isolation worktree`.

## 0.59.0 — 2026-07-31

- Preserve path, identifier, and prose casing in stored/presented structural
  plans while retaining folded derived keys for matching and deduplication.
- Make monitor pushes self-identifying with origin session, ownership,
  observed revision, and gate expiry metadata; workspace fallback now states
  that sibling-session jobs will be delivered, cross-session gates stay
  visible without response affordances, and answered gates emit supersession.
- Persist SessionStart correlation before optional inventory/context work and
  prefer a directly supplied monitor session identity when available.
- Mark detection-only changed-file counts as lower bounds across job,
  acceptance, audit, MCP, monitor, and TUI surfaces; contained workspace counts
  remain exact.

## 0.58.0 — 2026-07-31

- Plan-confirmation monitor pushes now carry `requiresHumanDecision: true`,
  name only the inspection pull path, and explicitly forbid unattended agent
  decisions. They no longer include a pre-filled accept/reject command,
  revision, or request id; owner CLI, TUI, and MCP response paths are unchanged.
- Independent-plan records now separate provider lifecycle from output
  validity and expose wasted observed/reserved output-token spend. Stats and
  seven-day health report the comparable-plan rate and degrade loudly after
  three structurally unparseable probes, while unusable passes remain
  non-blocking.
- Strengthened Cursor plan-lane final-answer framing against narration-only
  completion while retaining the existing one-shot independent-model fallback.

## 0.57.0 — 2026-07-31

- Compare shared-topic assumptions by normalized decisions instead of literal
  prose, preserving genuine action and step-order conflicts while ignoring
  case, punctuation, filler, and equivalent parser-precedence wording.
- Normalize free-text component identities and make approach listing order
  non-material. Divergence questions now include the differing left and right
  decision summaries instead of reason codes alone.

## 0.56.0 — 2026-07-31

- Accept a balanced JSON object embedded in narrated plan output only after the
  existing fenced and whole-body parser paths, without weakening structural
  validation. Cursor plan prompts now require the final message to end with the
  fenced deliverable and contain nothing afterward.
- When a completed, within-budget independent probe is structurally invalid,
  run exactly one alternate-model fallback on the parent provider. Timeout,
  quota, budget, cancellation, and provider failures do not retry, and every
  failed or unusable plan remains non-blocking.
- Preserve both plan attempts and their token costs on the parent job. Launch
  notices and plan-first stats retain the exact
  `plan-structural-output-invalid:<parser-reason>` and distinguish structural
  invalidity from other degradation causes.

## 0.55.0 — 2026-07-29

- Validate `delegate-jobs respond` and MCP `delegate_respond` against the
  pending request kind before command intake. Plan confirmations now require
  `--accept` / `--reject` or `accept=true|false`; answer-only submissions fail
  immediately. Both surfaces wait for the applied/rejected command outcome and
  distinguish command claim from the identified request resolution instead of
  returning an ambiguous intake-level `accepted`.
- Derive monitor needs-input guidance from `pendingInput.kind`, and lead
  plan-confirmation documentation with the boolean decision forms while
  reserving `--answer` and structured answer/steer objects for free-form
  questions.
- Bound every test polling helper with condition-specific timeout diagnostics
  and compact last-observed state so unreachable states fail instead of
  blocking indefinitely.

## 0.54.0 — 2026-07-29

- Sized the plan pass generously on both axes and per provider. The independent
  planner prefers PROVIDER independence, so a Codex parent with Cursor enabled
  plans on Cursor — which is materially slower to first token and was dying on
  the old ceiling, while Codex/luna finished in a median 46s. Codex now gets
  8,192 nominal tokens (9,830 with the recoverable band) and a 300s floor;
  Cursor gets 12,288 (14,745) and a 600s floor. Both runaways observed in the
  field, 66,428 and 77,912 tokens, still exceed every allowance and still fail.
- The two failure modes are not symmetric, so the numbers are deliberately not
  fitted to observed spend: too small means plan-first silently does not work,
  which is what happened fifteen consecutive times, while too large costs a few
  tokens only if the model fills the room — and the compact JSON contract plus
  the recoverable-overrun band already bound that. The previous 4,915 effective
  ceiling would also have rejected the largest legitimate spend measured (8,373)
  as a runaway.
- `DELEGATE_PLAN_OUTPUT_TOKENS` and `DELEGATE_PLAN_TIMEOUT_SECONDS` still win,
  the ceiling still applies, and a plan still cannot outlive its parent.
- Pinned the two tests that hardcoded the shipped default rather than the
  relationship they exercise. A test asserting that a marginal overrun recovers,
  or that a runaway reports observed-versus-cap, must set the cap it is testing;
  inheriting the default meant raising it turned an overrun into an underrun and
  the awaited state never arrived.

## 0.53.0 — 2026-07-29

- Replaced packet-size plan allowance scaling with a compact structural
  4,096-token default. Parseable overruns through 20% are recovered for
  comparison, while invalid output and hard-limit runaways still degrade
  non-blockingly with observed-vs-cap evidence.
- Plan wall clock remains token-budget-derived, parent-clamped, and
  operator-overridable; ambiguity comparison now waits through that same
  bounded wall clock instead of timing out at an unrelated 30/120-second cap.
- CLI and MCP starts now return an additive `launchNotice` when plan-first
  completes, recovers, remains pending, or degrades. Degradation is included in
  the launch response and durable job record without blocking the requested
  worker.
- `delegate_stats` and `delegate-jobs stats` now expose exact plan-first
  completion, recovery, degradation, pending, and historical-unknown counts and
  rates.

## 0.52.1 — 2026-07-28

- Removed 26,639 lines of verification scratch (fifteen full TAP logs, load
  samples and latency captures) that a coordinator `git add -A` swept into
  v0.52.0, and added `test/.gitignore` so a marketplace install can never again
  carry a worker's test output. Evidence belongs in the job record and the
  commit message, not in the shipped plugin.

## 0.52.0 — 2026-07-28

- Completed the TUI count audit. Existing destinations now have registry-owned
  drill-downs for transcript tools (`O`), provider subagents (`U`), Event
  errors (`A`), and Event warnings (`W`); Sessions `Enter` now opens the exact
  active managed-job IDs counted for that coordinator cwd. Each new count/list
  pair shares one projected collection and has a disagreement regression.
  Counts without an honest existing destination are documented rather than
  linked to partial evidence.
- Workspace composition now enumerates manifest overlap and compare-and-swap
  conflicts independently of patch artifact health. A forced process-global
  state-root switch deterministically reproduces the one-sighting
  `outside private broker storage` preemption; the overlapping-path conflict
  now remains first and visible, while both storage failures are still
  reported. Normal CLI/MCP callers load and preflight synchronously under one
  fixed process state root, so the exact root-switch cause is test/embedding
  state, while suppression by any unrelated artifact failure was a real
  preflight-reporting defect.
- Unambiguous zero-delay input frames now batch at the event-loop check phase
  reached directly after stdin polling instead of entering the timer queue.
  On an 80-job/500-event diagnostic fixture, Fleet median queue time moved from
  5.55 ms to 4.62 ms and input-to-paint from 10.32 ms to 9.95 ms; Transcript
  queue moved from 4.74 ms to 3.63 ms and input-to-paint from 11.31 ms to
  9.93 ms. Escape and bracketed-paste deadlines remain 50 ms and 5000 ms.

## 0.51.0 — 2026-07-28

- Terminal job records and finished sentinels are now published only after the
  final lifecycle event, journal compression handoff, and applicable terminal
  audit row are durable. Previously terminalization saved the job JSON first;
  a concurrent transcript reader could select the plain JSONL immediately
  before compression unlinked it, treat the resulting `ENOENT` as an empty
  journal, and observe `completed` with no transcript. Journal reads also retry
  the gzip path when they race that plain-to-compressed handoff. Held-audit-lock
  regressions force the direct Codex and detached Cursor interleavings without
  retrying assertions, widening tolerances, or serializing the suite.

## 0.50.0 — 2026-07-28

- Direct Codex MCP responses now remain private to the wrapper until their
  shadow job has completed terminal artifacts and audit publication. Previously
  the response was published first, so any reader treating it as the completion
  boundary — the TUI, the monitor, `delegate_stats`, or a caller script — could
  observe a terminal job whose chain-attribution audit row had not yet landed,
  under-counting that row. It surfaced as an intermittent suite failure (two
  completed parent/child shadows, one audit row), which is how it was found,
  but the window was real for every reader. A held-audit-lock regression pins
  the response boundary and fails against the previous ordering; it uses no
  retry, sleep, widened tolerance, or suite serialization, and observation
  stays fail-open so provider bytes are always relayed.
- Removed the redundant PostCompact session-hook registration and its invalid
  `hookSpecificOutput` discriminant. Claude Code invokes SessionStart again
  with `source=compact`, whose documented output schema supports the existing
  bounded `additionalContext` and collision `watchPaths`; a closed-field test
  now validates the registered event and emitted payload shape.

## 0.49.0 — 2026-07-28

- At real-store scale (141 jobs; largest journal 19,418,996 bytes), reduced
  median TUI input-to-paint latency from 40.16 ms to 23.86 ms on Fleet and from
  33.01 ms to 15.03 ms on that job's Detail/Transcript by dispatching
  unambiguous keys on the next event-loop turn instead of waiting for a 16 ms
  display-frame batch. Ambiguous escape sequences and bracketed paste keep
  their independent correctness deadlines. The existing flight recorder now
  attributes input-to-paint queue, view-model, projection, wrapping, paint,
  screen diff, diagnostic serialization, terminal write, and clone time, plus
  datasource refresh/watch triggers and frame causes.
- Made transcript anomaly totals actionable through the single KEYMAP registry.
  `A` toggles the exact projected anomaly list counted by the badge, and the
  Diff action menu opens existing scope-violation evidence in Record.
- Added registry-enforced confirmation metadata and generic dispatch for every
  destructive binding. Direct keys and the action menu now both refuse a
  destructive entry that lacks a declared confirmation gate.
- Gave detail tab strips the same solid raised-surface owner as the pane they
  label while retaining accent and underline active cues for color, NO_COLOR,
  and ASCII rendering.
- Added a responsive Fleet Changed column using the same latest-activity value
  as the existing sort and the shared absolute/relative timestamp formatter.
  Elapsed remains a separate duration, and Changed drops cleanly before narrow
  local or remote tables can overflow.

## 0.48.0 — 2026-07-28

- Added local re-verification with `delegate-jobs verify <job-id>` and MCP
  `delegate_verify`. It reruns only a verification-blocked managed job's recorded
  verification command against the current shared tree, never launches or
  resumes a provider, and accepts no command replacement or gate override.
- Verification evidence is now append-only under `verificationEvidence`;
  the existing `verification` field remains the latest-evidence compatibility
  projection. Inspect and the TUI show the ordered chain, including each
  record's repository revision and tree digest, while acceptance continues to
  refuse whenever the latest evidence fails, times out, or becomes stale.
- Each re-verification appends a higher outcome-audit revision, so P8 uses the
  current real-tree label without deleting or rewriting the earlier failure.
  Historical job records without a chain still inspect and decide through a
  one-record compatibility projection. Discarded isolated workspaces fail
  closed because checking the owner tree without their captured change set
  would verify a different artifact.

## 0.47.0 — 2026-07-28

- Replaced the fixed 2,048-token plan-pass ceiling with a deterministic,
  packet-scaled sub-budget. The default floor is 4,096 tokens; packet bytes and
  structural directive markers add 1,024-token steps up to the existing 16,384
  hard ceiling. `DELEGATE_PLAN_OUTPUT_TOKENS` remains the bounded explicit
  override, explicit job caps remain authoritative, and budget compilation is
  local—no provider round-trip or launch latency was added.
- Independent plan jobs now project terminal outcome back onto their implement
  attempt as additive `planPass` state with reason, job id, status, observed
  cost, and limit. Inspect returns it and TUI detail shows `PLAN DEGRADED`.
  Historical records tolerate the field's absence. Failed and over-budget
  planning remains non-gating and continues the requested launch.
- Split ambient `budget-breach` (configured per-job output cap) from
  `allowance-breach` (provider quota/rate exhaustion), with distinct remedies.
  A terminal failure whose code is exactly the already-active breach cause no
  longer produces a duplicate line; a different failure cause remains queued
  under the existing edge dedupe, cooldown, rate, and priority policy. MCP
  schemas and CLI flags are unchanged.
- Added retries to every recursive temp-directory teardown in the test suite.
  A spawned worker could still be writing into its directory when the `after`
  hook ran, so `rmSync` raised `ENOTEMPTY` and failed the run: measured at 1/10
  on `shadow-jobs`, identically at the prior release, so it was environmental
  rather than caused by any change. None of the 48 recursive teardowns used
  Node's retry option, which exists for exactly this errno class. 0/35 after.
- `package.test.mjs` no longer pins the version as a literal. It asserts the
  semver shape and that `CHANGELOG.md` carries a dated section for the current
  version, so a release that forgets to document itself fails instead of a line
  that merely goes stale on every bump.

## 0.46.0 — 2026-07-28

- Fixed Escape needing a second keypress to take effect. A lone `ESC` byte is
  also a prefix of the bracketed-paste opener `ESC[200~`, and the decoder's
  paste-prefix guard was the only incomplete-sequence guard that ignored
  `final`, so `flush()` could not drain it either and the keypress surfaced
  only when the user next typed. Every Escape consumer was affected — leaving
  a transcript, closing the help dialog, the action menu, status history.
  `BufferedInput` now holds an ambiguous prefix on a bounded escape timeout
  (50ms) rather than indefinitely, with a separate 5s deadline for a paste body
  and idle semantics so a sequence split over a slow link still coalesces. A
  forward-progress invariant makes an input wedge unrepresentable, and an
  unterminated paste is delivered rather than held forever.
- Narrowed the `tui-datasource` close assertion, which timed a synchronous
  `fs.watch` teardown whose macOS FSEvents latency is unbounded (13–30ms
  typical, 9713ms observed) and accounted for 100% of the measured span, while
  the deferred hydration it names settled in 0.0ms on every run. It now times
  only the hydration settling and keeps every teardown assertion.
- Bounded the complete Delegate Router state directory with an age policy plus
  a 1.5 GiB default `DELEGATE_STATE_BUDGET_BYTES` budget. Budget reclaim is
  oldest-terminal-first and never removes non-terminal work, `ready-for-review`
  or `blocked` work, live supervisor leases, or the newest 20 terminal jobs.
  If protected state prevents the target, reclaim stops and records a loud
  over-budget warning instead of deleting work.
- Terminal journals now gzip in place and every journal reader permanently
  accepts both `.events.jsonl` and `.events.jsonl.gz`. The monitor retains its
  cheap extension-aware mtime/size stamp, while MCP events, transcript/diff
  projections, the TUI, and outcome readers transparently decode gzip.
- Added a 32 MiB default `DELEGATE_JOB_JOURNAL_CAP_BYTES` cap. A capped live
  journal retains its head and newest tail, inserts a visible
  `journal.truncated` event, and records cumulative omission details on the job.
- Maintenance remains on the shared six-hour stamp but now runs from MCP, CLI,
  TUI, managed-launch, and the supervisor idle path. Each sweep examines at
  most 500 records, removes at most 25, and compresses at most 25 legacy
  terminal journals. A private bounded `maintenance.jsonl` records high-water
  warnings, compression measurements, deletions, and age-versus-budget reason.
- `delegate-health` now reports state-store bytes, file count, budget,
  high-water threshold, and signed headroom in both JSON and human output. No
  MCP schema or CLI flag changed.

## 0.45.0 — 2026-07-27

- Completed P9 with a formal provider attempt-driver contract for Codex
  app-server, Cursor ACP, and Cursor headless. Each lane implements the common
  `start`, `resume`, `prompt`, `steer`, `cancel`, and `close` lifecycle and
  negotiates explicit capabilities instead of spreading provider-name
  conditionals through managed-attempt selection.
- Capability negotiation records honest non-parity for same-turn steering,
  live shell stdout, mid-turn token totals, context occupancy, plan mode, MCP
  injection, broker-worktree containment, and pre-prompt pause. Scheduling
  profiles distinguish workflow, budget, checkpoint, and containment
  guarantees; a workflow that needs an absent capability is refused with the
  capability and lane named.
- Added read-only `delegate-health --capabilities` output. It performs no model
  turn, marks installed-build handshake/help observations as `probed`, and
  marks claims that cannot be established without a provider turn as
  `declared-from-documentation`. `DELEGATE_ENABLED_PROVIDERS` may temporarily
  include Cursor for this inspection without editing live provider
  configuration.
- This is a behavior-preserving refactor: legacy job capability records,
  transport events and ordering, errors, retries, ACP-to-headless fallback, MCP
  tool schemas, and CLI flags remain unchanged. No version was bumped.

## 0.44.0 — 2026-07-27

- Added the P7 WorkItem cockpit as a new `g w` TUI surface without replacing
  Dashboard, Fleet, job detail, Groups, Sessions, Providers, Stats, or
  Launcher. Compose reuses the P5 structured spec card with field provenance,
  confidence, and visible unresolved write-dispatch blockers.
- Review now keeps the bounded changed-file diff, immutable base revision,
  broker verification, scope/drift verdict, and findings checklist together.
  Compare aligns the latest two candidates under the same diff-shape, checks,
  findings, duration, usage, and unresolved-risk criteria. Converge coalesces
  open/resolved/regressed findings and shows the WorkSpec round bound before
  offering the existing review-round action.
- Approve exposes only existing P3 evidence-bound accept/reject decisions and
  P6 CAS-preflighted integration-worktree composition. Direct application into
  the owner's tree remains absent and is explicitly labelled deferred.
- Replay is visibly disabled in this narrower first cut. The normalized journal
  has no persisted projection checkpoints or reversible reducer, so arbitrary
  historical state cannot be rebuilt without full-prefix loading (and the
  endpoint requires the entire journal) while preserving O(viewport).
- Added WorkItem modes and actions through the single KEYMAP registry, including
  generated footer/help/reference documentation, remote read-only policy,
  ASCII/NO_COLOR coverage, nasty-journal coverage, and 120x40 frame tests.

## 0.43.0 — 2026-07-27

- Added the P8 local outcome ledger. New attempt records and full terminal or
  owner-decision audit snapshots carry broker, adapter, provider CLI, policy,
  and event-schema versions; task shape; canonical packet-section presence;
  real-tree verification outcome; bounded findings; explicit acceptance;
  usage; and redacted rejection reasons. Later decision snapshots coalesce by
  job/revision without rewriting history or double-counting attempts/tokens.
- Replaced the ambiguous displayed success rate with separate
  provider-completion, verification-pass, and owner-acceptance measurements.
  Every measurement includes numerator, sample size, and a minimum of 10;
  smaller samples return `insufficient-data` and a null rate. Historical rows
  without new fields remain readable and aggregate with explicit missing
  labels.
- Extended `delegate-jobs stats` and additive `delegate_stats` inputs with ISO
  date/broker-version `since` views, exclusive date `until`, broker and UTC-day
  cohorts, and explicit ORPHANED counts. Existing duration filters, totals,
  transport groups, external totals, and approximate unattributed movement
  remain.
- Added a read-only outcome-routing recommendation shape. It uses only
  explicit owner-acceptance labels for a matching task shape, requires 20
  samples per provider and separated fixed-95% Wilson intervals, and otherwise
  returns `insufficient-data`. The existing static router is unchanged.

## 0.42.0 — 2026-07-27

- Added opt-in P6 broker workspaces. Managed write starts now accept additive
  `isolation: "worktree"`, `pathClaims`, and `resourceClaims` controls (CLI:
  `--isolation worktree --path-claims ... [--resource-claims ...]`). Shared
  remains the default. Workspace launches require an explicit allowed-path
  fence plus covering path claims, retain sandboxing, and refuse external write
  grants or unsupported Git shapes before provider launch.
- Isolated attempts run in a detached Git worktree at an immutable base,
  capture a private portable full-index binary change set, and discard only
  their validated broker-owned workspace on terminal completion, failure, or
  cancellation. Dirty owner trees, detached owners, and owners that are
  existing linked worktrees are supported; bare/non-Git repositories,
  subdirectory roots, submodules, unsafe state placement, bounded-inspection
  overflow, repository-local clean/smudge filters, and worktree creation
  failure are explicit refusals. Broker Git commands disable hooks, fsmonitor
  hooks, and global/system Git configuration.
- Workspace writers schedule on overlapping concrete path claims and exact
  resource claims. Claims schedule; the worktree/sandbox contains. Shared-tree
  jobs retain the existing conservative whole-cwd writer guard, P2.5 remains
  detection-only, and legacy `delegate-jobs revert` behavior is unchanged.
- Added `delegate_integrate` / `delegate-jobs integrate` and
  `delegate_workspace_discard` / `delegate-jobs workspace discard`.
  Integration performs strict target content-and-mode CAS preflight and applies
  portable change sets only inside a broker-owned integration worktree. It
  stops on same-path or Git apply conflicts and never uses a three-way merge.
- Direct multi-file application to the owner's working tree is deliberately
  deferred because it cannot be made atomic against unmanaged editors with the
  available filesystem/Git primitives. Workspace acceptance therefore returns
  `CAS_CONFLICT` for moved targets or `WORKSPACE_APPLY_DEFERRED` after a clean
  preflight; it never overwrites the owner tree. Workspace continuation,
  submodules, subdirectory roots, external ingest/add-dir grants, sandbox-off,
  and auto-fix rounds are also deferred. No global `WorktreeCreate` hook is
  registered, so ordinary worktree creation is untouched.

## 0.41.0 — 2026-07-27

- Added the P5 local intent-to-spec compiler. `delegate-jobs spec` and the TUI
  launcher can derive a versioned WorkSpec draft from an owner sentence, the
  current changed-path inventory, failing-check output, a TODO, a JSON task
  record, and repository conventions. Objective, scope claim, acceptance
  criteria, P3 verification recipe, budget, and immutable base each retain
  field-level provenance and high/medium/low confidence in one confirmation
  card; low-confidence or missing values remain visibly unresolved.
- Compiled write starts are blocked until the draft is complete and the owner
  confirms the card. Interactive CLI confirmation is the default;
  `--accept-spec` is the explicit automation confirmation flag and cannot
  resolve a missing field. The TUI keeps the card and exact provider packet in
  its existing dry-run-gated launcher review pane. Confirmed packets enter the
  unchanged managed-start and plan-first path, and the P1 WorkItem projection
  uses their stored WorkSpec.
- The compiler never derives `allowedPaths`, network, sandbox disablement,
  privilege, scope widening, or a budget increase. Write compilation therefore
  requires an explicit allowed-path fence even when evidence provides a strong
  scope candidate. Existing hand-written packets, CLI flags, MCP tool schemas,
  job IDs, and historical projections remain unchanged. Packet lint now also
  exposes which compiler field can fill each missing section.

## 0.40.0 — 2026-07-27

- Write-mode managed starts are now plan-first by default. The first provider
  turn is read-only and presents a structural plan, predicted file/component
  blast radius, and observed token/duration bands before any write. Accepting
  through the revisioned response inbox continues the same Codex thread or
  Cursor session with write mode enabled; declining stops without writes.
  Trivial changes have an explicit escape hatch:
  `delegate-jobs start --no-plan-first` or additive MCP
  `delegate_start_trivial`. `DELEGATE_PLAN_FIRST=0` is the broker-wide
  emergency opt-out.
- Optional ambiguity checking launches one independently budget-capped plan
  attempt using another enabled provider or model. Plans are compared only by
  structural targets, ordered approach shape, and declared assumptions.
  Material divergence becomes the confirmation question; convergence opens no
  ambiguity question; missing comparable structure is reported as
  `inconclusive` and never promoted to a verdict. Use
  `--no-ambiguity-check` or `DELEGATE_AMBIGUITY_CHECK=0` to skip the second
  pass.
- Added additive MCP `delegate_interrogate` and CLI
  `delegate-jobs interrogate` for read-only questions to a running worker.
  Codex uses explicit no-action `turn/steer` framing; Cursor queues a separate
  read-only turn and remains explicitly non-same-turn. Questions cannot carry
  scope, privilege, network, sandbox, timeout, or budget changes; answers are
  evidence only, attach as WorkItem findings, and surface observed provider
  token cost inside the existing `maxOutputTokens` budget.
- Every new interaction degrades independently. Invalid/unavailable plan
  output falls back to the explicitly requested legacy write launch and records
  why; a missing second planner yields a non-gating inconclusive comparison;
  an unavailable interrogation retains the existing job and journal evidence.
  No plan is auto-accepted, and no write begins from a successful plan without
  an explicit revisioned confirmation.

## 0.39.0 — 2026-07-27

- Added P4.5 conversational delegation through a separate broker-owned MCP
  server injected into managed Codex, Cursor ACP, and Cursor headless sessions.
  Its hard allowlist exposes exactly blocking `ask_coordinator` and
  non-blocking `report_progress`; it cannot import or dispatch control-plane
  mutations. Questions, bounded current diffs, considered options, responses,
  and optional within-contract steers use the existing private redacted
  journal and revisioned response inbox.
- Worker questions now pause in `user-input-required` without becoming stalled,
  charge wait time to the current attempt lease and original wall-clock
  timeout, and reject continuation with `stopReason: input-timeout` when the
  declared default expires. Back-channel injection is fail-open: Codex and ACP
  retry session establishment without it, while Cursor headless retries without
  its private MCP plugin if the CLI rejects that plugin.
- Added `a` for inline TUI answers and made `needs-input` monitor lines include
  both the TUI action and the exact revisioned `delegate-jobs respond` path.
  Cursor ACP corrections remain explicitly cancel-and-resume restarts;
  `cursor/update_todos` and `cursor/task` remain one-way progress signals.

## 0.38.0 — 2026-07-27

- Added P4 native session integration. `delegate-config statusline enable` now
  composes a compact `D` work-state chip before the user's existing status-line
  command, preserves and restores that command exactly, and sets a five-second
  `refreshInterval` (Claude Code still applies its documented 300 ms debounce).
  The chip reports session-scoped running/review-ready counts plus one reliable
  provider allowance percentage. Footer job-ID badges are appended without
  replacing user badge rules and can be disabled independently.
- SessionStart now injects bounded live work metadata alongside the existing
  P2.5 `watchPaths`; PostCompact re-injects the identical state. The payload
  contains only safe job IDs and closed lifecycle/blocker labels, never prompts,
  results, diffs, paths, or free-form errors. It is hard-capped at 2,048 UTF-8
  bytes; policy breaches, human input, review-ready work, and resumable failures
  win over lower-priority/older entries, and overflow records an omitted count.
- Added read-only MCP resources for active work and the repository verification
  profile, a bounded per-job diff resource template, and prompts for scoped
  review and findings-driven continuation. The existing 17 MCP tools, names,
  order, input schemas, and SHA-256 compatibility guard are unchanged.
- Confirmed the existing fail-open Edit/Write and batch collision path remains
  the sole overlap-invalidation implementation: one deduplicated edge marks
  covering verification stale and blocks undecided acceptance. No second P4
  edit observer or event vocabulary was added.
- Tightened the ambient attention boundary: write-job completion is review
  actionable only when acceptance evidence is explicitly `ready-for-review`.
  Historical records with no acceptance state stay silent, so provider
  completion alone never becomes a review demand.
- Every P4 ambient surface is optional. Disable the chip with
  `DELEGATE_NATIVE_STATUSLINE=0`, injected context with
  `DELEGATE_NATIVE_CONTEXT=0`, MCP resources/prompts with
  `DELEGATE_NATIVE_MCP=0`, footer badges with
  `delegate-config footer-links disable`, and monitors with
  `DELEGATE_MONITOR=0`; existing CLI/MCP tools, sentinels, TUI, and pull paths
  remain unchanged.

## 0.37.0 — 2026-07-27

- Added P2.5 live collision detection for managed write attempts. SessionStart
  returns a dynamic `watchPaths` set containing a private refresh signal plus
  the running attempt's `allowedPaths` roots and already-observed changed
  files. `FileChanged`, fail-open `PostToolUse(Edit|Write)`, and
  `PostToolBatch` hooks record a deduplicated `collision.detected` edge when
  another writer touches an owned path. A private refresh signal re-arms the
  dynamic set when an attempt starts or reports another changed file.
- Collision edges use the existing monitor policy and therefore inherit
  session/workspace/all scope, per-attempt cooldown, per-attempt/path
  deduplication, snooze priority, and the global rate ceiling. Attempt-owned
  file fingerprints suppress watcher self-alerts; a first watcher event with
  no provider attribution is left to the coordinator hooks and post-hoc checks
  instead of guessing that the attempt was an external writer. A collided path
  records `baseDrift`, sets applicable verification evidence to
  `state: "stale"` with `inputChanged: true`, and blocks undecided acceptance
  on `base-drift`.
- The dynamic watch set is capped at 256 absolute paths, including its private
  refresh signal. The first 255 deterministic owned roots are armed; attempts
  with omitted roots record `collisionWatch.status: "degraded"` and
  `reason: "watch-path-cap-exceeded"`. Watcher/refresh failure records its
  reason and falls back to coordinator Edit/Write observation plus the
  existing post-hoc completion checks.
- This is early detection only. It does not prevent, contain, or isolate a
  collision; transactional workspace containment remains P6 work.

## 0.36.1 — 2026-07-27

- Fixed P2.4 session correlation by replacing the short-lived
  SessionStart/request/responder handshake with a private durable marker.
  Markers retain the session/workspace identity and a bounded coordinator
  ancestor chain as PID/start-time pairs for 72 hours. Monitors match their own
  parent chain, prefer the nearest common ancestor, select the newest duplicate
  marker for one session, and explicitly degrade to workspace scope when
  process start time is unavailable, no marker matches, or distinct sessions
  are equally specific. PID reuse cannot correlate.
- Correlation cleanup now prunes a bounded set of expired markers,
  dead-coordinator markers, resolution records, and obsolete handshake files on
  each hook or monitor run. Ambient scope still affects push only:
  `DELEGATE_MONITOR_SCOPE=session|workspace|all`, origin-less records remain
  silent except under `all`, every emitted line remains workspace-labeled, and
  pull/control behavior is unchanged.

## 0.36.0 — 2026-07-27

- Replaced the TUI's independent footer, help, and documentation key lists with
  one structured `KEYMAP` registry. It now derives per-key notation, class- and
  width-budgeted footers, contextual-first paged help, the `x` action menu, and
  the generated reference table. Destructive actions retain a non-red warning
  marker and their own trailing footer group; unavailable menu actions remain
  visible with a reason.
- Redesigned help as a centred raised dialog over a theme-specific dim scrim,
  with `surfaceOverlay` ownership, generous rhythm-based margins/padding,
  padded `surfaceRaised` key caps, aligned action text, quiet right-aligned
  paging/close utilities, content-sized height, symmetric odd-width margins,
  pointer affordances in their own quiet section, and explicit light, dark,
  ASCII, and `NO_COLOR` fallbacks. Section paging uses one title counter and
  the footer key hint without a redundant border-adjacent scrollbar.
- Committed the Vim-coherent bindings: `n`/`N` are always next/previous match,
  `y` always yanks, `g`/`G` are top/bottom, `/` searches, and `Ctrl-D` now pairs
  with `Ctrl-U`. `g` also arms the screen prefix: `g f` Fleet, `g r` groups,
  `g s` sessions, `g p` providers, `g t` stats, and `g l` launcher; `F`
  remains the Fleet alias. The former `G`, `S`, `p`, `t`, and `N` screen
  bindings report these replacements on first use. Lowercase `t` now toggles
  timestamp mode alongside `T`.
- Moved Fleet external-thread visibility from direct `x` activation into the
  `x` contextual action menu, and moved narration nudge from `n` into that
  menu. Pressing either moved binding reports the new location instead of
  failing silently. Launcher `y` now yanks like every other screen; `d` builds
  the dry run and opens the typed confirmation that launches the matching
  packet.
- Added defensive synchronized-output frames (`?2026`), bracketed paste
  (`?2004`), and focus reporting (`?1004`). Multi-line pastes enter text inputs
  as one literal payload instead of submitting embedded newlines, unfocused
  terminals stop animation, unsupported modes retain the prior behavior, and
  every enabled mode is disabled during suspend and exit.

## 0.35.0 — 2026-07-27

- **Stricter push default, with an explicit widening path:** Delegate Monitor
  notifications now default to `DELEGATE_MONITOR_SCOPE=session`, so two Claude
  sessions launched in the same workspace do not notify each other. Set
  `DELEGATE_MONITOR_SCOPE=workspace` to see all work launched from the current
  worktree/project, or `all` for the complete fleet; `off` remains the push kill
  switch and the former `project` value remains a compatibility alias for
  `workspace`. These settings affect push only—MCP/CLI inspection, the TUI, and
  every revision-safe control operation continue to see and manage all jobs.
- New attempts add immutable `origin.sessionId` and realpath-normalized
  `origin.workspaceId`; resume, review, and automatic continuation rounds
  inherit both without replacement. SessionStart writes a private correlation
  marker so the monitor can bind itself without guessing. Missing, late, dead,
  or ambiguous correlation persists a degradation record and emits a
  workspace-labeled status line before falling back to workspace scope.
  Origin-less records remain silent under session and workspace scopes and are
  visible only under `all`.
- A controlled Claude Code 2.1.220 hook experiment found that both a manual Git
  worktree and `claude --worktree` set the SessionStart `cwd` and
  `CLAUDE_PROJECT_DIR` to the actual worktree path. The previously inferred
  parent-directory collision for Claude-created worktrees was not reproduced;
  no special-case workaround was added.

## 0.34.0 — 2026-07-27

- Replaced the secondary-screen line-list presentation with purpose-built
  key/value, structural rail, and diff-line painters. Record, Usage, Chain, and
  launcher review now share one humanized alignment grid; Transcript and Events
  use scannable time/role/measure rails; opened diffs add stable line-number
  gutters, file stats, enclosing-symbol hunk labels, full-row change tint, and
  intra-line emphasis.
- Added a summary strip before row one of every secondary pane, anomaly badges
  on key/value section headers, null and copy affordances, and complete
  Unicode/ASCII glyph tiers. Rendering remains virtualized and uses the
  existing width, palette, surface, rail, and spacing authorities.

## 0.33.0 — 2026-07-27

- Replaced rectangular TUI pane chrome with perceptual `surface` /
  `surfaceRaised` tints and persistent left rails. Focused rails use the accent;
  resting rails and scrollbar tracks use `borderSubtle`; full rectangles remain
  only on floating overlays, where `borderActive` is used.
- Added the shared `0 1 2 3 4 6 8` spacing scale, two-column/one-row pane
  padding, two-column table gaps, a scrollbar margin, fixed selection/prefix
  gutters, one content-left column per pane, and named compact-height handling
  that removes section blank rows at 30 rows or fewer.
- Added headless invariants for selection-stable content columns on every
  screen, diff and glyph-prefix gutters, both sides of the height threshold,
  surface ownership, overlay-only boxes, and Unicode/ASCII rail fallbacks.
  Keys, navigation, content, data, CLI flags, and MCP schemas are unchanged.

## 0.32.0 — 2026-07-27

- Re-authored the TUI palette as 41 perceptual OKLCH tokens with tinted
  neutrals, constant-lightness dark/light surface ramps, contrast-solved text,
  border, and semantic tiers, truecolor output, and mechanically derived
  256-colour indices.
- Added dark/light daltonized and colour-inheriting ANSI presets, validated
  custom theme overrides, and self-verifying contrast plus headless render
  coverage for every preset and `NO_COLOR`.
- Reserved the accent for focus, live state, active tabs, and selection.
  Default transcript content, tool events, and diff file headers now use body
  or semantic colour without changing layout, content, glyphs, or keys.

## 0.31.0 — 2026-07-27

- **Stricter default, with recorded escape hatches:** write-mode jobs now derive
  a repository verification profile and run it on the real tree after observed
  changes. Explicit `verify.command` still wins. Per-job
  `verify: { exception: "<reason>" }` and broker-wide `DELEGATE_VERIFY=off`
  skip the run, but both persist a visible verification exception; a repository
  with no derivable recipe records `verification.state: "no-recipe"`.
  Derivation checks nearest repository `CLAUDE.md` then `AGENTS.md` quality
  sections before `package.json` scripts, caches the profile and its source in
  the state directory, and never invents a command outside those sources.
- Added the acceptance dimension without changing job `status`.
  Write-mode provider completion still reports `status: "completed"` and now
  also records `acceptance: { state, blockedBy, evidence, decidedBy,
  decidedAt }`. Clean evidence becomes `ready-for-review`; verification
  failure/timeout, zero changes, scope violations, unresolved structured
  findings, or base/input drift becomes `blocked`. Acceptance is never
  automatic. `delegate-jobs accept|reject` and the additive `delegate_decide`
  MCP tool record an evidence-bound owner/coordinator decision without
  applying, reverting, or committing code.
- The push monitor consumes acceptance state. `blocked` is a distinct edge
  ahead of `ready-for-review`, and check labels now reflect broker pass, fail,
  timeout, stale, or recorded no-run evidence.
- Added opt-in `autoFix: { maxRounds }` / CLI `--auto-fix-rounds`. It remains
  off by default, is hard-capped at three rounds, continues only for
  deterministic verification/scope evidence with measurable progress and
  remaining budget, and stops on semantic findings, ambiguity, no progress,
  drift, timeout, or budget exhaustion.

## 0.30.0 — 2026-07-26

- Added the resident, user-level `delegate-supervisor`. Managed attempts now run
  under a single private Unix-domain-socket supervisor with durable
  PID/PGID/boot leases, heartbeats, clean signal draining, idle exit, boot
  adoption, and exact exit/signal attribution. Concurrent lazy starts converge
  on one resident. Incompatible residents drain only when lease-free; otherwise
  the new launcher uses the unchanged inline-detached fallback. Every supervisor
  startup or submission failure also falls back and records
  `executionOwner: "inline-detached"`; lease-less pre-upgrade jobs are never
  adopted or reclassified.
- Fixed background Claude Agent stubs remaining `running` forever. Additive
  `SubagentStart`/`SubagentStop` hooks correlate by `agent_id` and retain the
  terminal response. A read-time quiet-transcript backstop (30 minutes by
  default) marks missing-completion records as failed `ended-unknown`, never as
  successful; Fleet renders recent growth as active, quiet-within-policy as
  idle, and the terminal uncertainty distinctly. Existing records heal on
  inspection and ordinary retention prunes them.
- Fixed cross-project monitor notifications. New attempts retain immutable
  launch origin `{ projectDir, cwd, brokerVersion, launchedAtMs }`; continuation
  rounds inherit it. Push defaults to the realpath-normalized origin project,
  excludes origin-less legacy jobs, distinguishes worktrees, and labels every
  line with its workspace. `DELEGATE_MONITOR_SCOPE=all` explicitly enables a
  fleet overview and `off` disables push. Inspection and the TUI detail header
  expose origin separately from the delegated cwd.

## 0.29.0 — 2026-07-26

- Added the experimental Claude Code push bridge in `monitors/monitors.json`.
  Its read-only watcher emits only redacted policy-breach, needs-input,
  ready-for-review, failure, and stalled edges, with boot baselining,
  per-job deduplication/cooldown, snooze, kill switch, and a global rate
  ceiling. The existing MCP/CLI/TUI/`finishedPath` pull paths are unchanged.
- Fixed the v0.27.0 transcript regression where `agentMessage` starts and
  legacy first-class Codex item events became unmatched generic provider-item
  blocks and spun indefinitely. First-class item exclusions are now shared
  across live and historical normalization, while any genuinely unmatched
  provider-item or subagent start ends with an explicit unknown outcome once
  its job is terminal.

## 0.28.0 — 2026-07-26

- Added schema-versioned WorkSpec, WorkItem, Attempt, Finding, ChangeSet, and Decision models plus total, deterministic compatibility projections. Existing resume/review chains collapse into ordered Runs under one WorkItem; missing historical facts remain explicit instead of inferred.
- Added read-only `delegate-jobs work` and `delegate_work` projection surfaces without changing any existing CLI flag or MCP schema. Existing job records remain untouched.
- Reserved the lazy `work/` state-directory sibling and added forward-compatible persistence helpers for later phases. No production path writes WorkItems in this phase, and unknown fields survive read-modify-write.

## 0.27.0 — 2026-07-26

- Provider-spawned Codex and Cursor subagents now share one durable `started` → `progress` → `completed`/`errored` lifecycle across managed app-server, direct MCP, ACP, and headless transports. Their identity, task, status, duration, usage, and bounded redacted output remain inspectable in `result.subagents[]`, plain-text transcripts, and expandable provider-neutral TUI blocks; active subagents also drive Fleet/detail activity.
- Unrecognized Codex app-server items now retain a bounded, recursively redacted payload in `provider.item` instead of losing everything except type/id metadata. Unknown and web-search items render without type-specific UI code, while legacy metadata-only journals show an explicit payload-not-captured block.
- Completed jobs whose preserved subagent output substantially outweighs a thin parent response are marked `resultSuspect: 'subagent-output-dominates-final'`.

## 0.26.2 — 2026-07-22

- The external Codex thread scanner no longer crashes the TUI when a rollout file appears mid-refresh with its meta line still being written (explicit-null identity guard, per-file isolation with an `unreadableExcluded` count, and a timer-level catch that degrades the external scan to an error status instead of killing the process).

## 0.26.1 — 2026-07-20

- Claude Agent stubs retain the agent id and coordinator sidecar needed to resolve transcripts after `PostToolUse`, retry bounded cwd-scoped linkage when detail is viewed, persist successful linkage without a revision bump, and explain transcripts that have not appeared yet. Selected Claude Agent and external Codex transcripts now refresh only after an mtime/size change and stop tailing on deselection.
- Background Agent spawn acknowledgements remain nonterminal and display transcript-mtime `active`/`idle` age because the hook receives no background completion signal; foreground Agent results keep their true completed lifecycle.

## 0.26.0 — 2026-07-20

- Fleet now discovers bounded, read-only external Codex session metadata under `~/.codex/sessions`, includes only threads whose persisted origin metadata proves a Claude-adjacent tool origin, excludes broker-owned and personal-by-default sessions, and exposes exact carried token counters when present. Allowance snapshots can also record aggregate-only, approximate `unattributed-burn` windows when allowance moved with no tracked Codex job capable of accounting for it.
- Built-in Claude `Agent`/legacy `Task` calls create fail-open `claude-agent` visibility stubs through correlated PreToolUse/PostToolUse hooks. The stubs retain only bounded redacted summaries and an optional read-only subagent transcript pointer, reject every control action, obey ordinary retention, and can be disabled with `DELEGATE_AGENT_STUBS=0`.
- `delegate-tui --connect` and `--token-file` are repeatable, `<state-dir>/remotes.json` supplies optional labeled hosts, and `--include-local` adds the local store. The composite fleet namespaces remote identities, adds width-aware Host cells and per-host status chips, isolates failures with per-host backoff and row aging, and keeps all remote controls disabled. The loopback-only bearer-authenticated export is unchanged.

## 0.25.0 — 2026-07-20

- Direct Codex MCP calls and Cursor foreground/background CLI runs now create durable read-only shadow jobs in the ordinary store. Their redacted prompts and parameters, normalized live messages/plans/tools/file edits/usage, diffs, liveness, terminal sentinels, audits, and stats are visible in the CLI, MCP inspection surfaces, and TUI without changing provider results; journaling failure falls back to the prior unobserved behavior.
- `codex-reply` creates a child shadow on the same provider thread so cumulative usage retains chain-delta attribution. Direct shadows reject mutation controls with `DIRECT_TRANSPORT`, while inspection remains available.
- Fleet rows mark shadows with `direct` and flag observational overlap with an active managed writer as `writer!`; direct launches remain unblocked and caller-owned. The direct Cursor adapter now uses the shared macOS login-shell headless launch path.

## 0.24.3 — 2026-07-17

- Corrected audit output-token aggregates to delta-attribute thread-cumulative Codex resume chains, use one time snapshot for each `delegate_stats` response, and treat explicit null usage fields as missing rather than zero samples.
- Fleet rows now show each job's cwd basename and routed effort, with width-aware truncation and compact-density priority dropping.

## 0.24.2 — 2026-07-17

- Terminal completions now record `verificationOrigin`; sandbox-only worker checks are surfaced as partial evidence in `delegate-jobs status` and `result`, while broker verification and unsandboxed workers are distinguished structurally.
- The bundled independent-review profile carries a canonical best-effort findings schema, validates the final fenced JSON object into `result.structured`, and retains inline prose as the fallback.
- Packet-lint warnings now include one stderr-only copy-paste skeleton containing exactly the missing canonical sections.
- Added the read-only MCP `delegate_stats` tool with duration filtering, audit aggregates, terminal-status counts, and summed output tokens.

## 0.24.1 — 2026-07-15

- `delegate-jobs status` preserves requested auto-model labels, strips empty model-attribute suffixes such as `default[]`, and includes resolved detail only when it is informative.
- The opt-in no-turn Cursor ACP handshake now retains and validates the live session model catalog. The installed build currently exposes ordinary select options rather than `parameterizedModelPicker`; both that real fallback shape and the picker-preference path have regression coverage.
- Background width probes pass through all real input while swallowing late probe-row CPR stragglers for a bounded ten-second grace after timeout, budget exhaustion, or editor cancellation, then remove the filter completely. Editor handoff cancels an active probe before releasing terminal ownership and never applies partial measurements.

## 0.24.0 — 2026-07-15

- Width probing now returns promptly for the first frame but continues behind an input-safe CPR filter for backpressured tmux-over-SSH sessions, then applies late results in one glyph/cache/redraw upgrade. Preference saves merge per-terminal identities so concurrent direct and tmux sessions retain both measurements; probeVersion remains 3.
- Codex context compaction is journaled as first-class start/completion events, rendered in transcripts with duration or an in-progress marker, and exposed as an animated `compacting` fleet/detail activity state. Legacy context-compaction provider events normalize through the same TUI path.
- Headless consult/plan/review now uses streaming NDJSON with Cursor's timestamp/model-call dedupe contract, authoritative final result text/usage, ephemeral content-free thinking activity, structured tool lifecycle, requested sandbox policy, rejection reason, and pre-turn `create-chat` session establishment with an older-CLI fallback.
- `network=true` is enforced for Cursor ACP and headless. Read-only network jobs elevate to agent mode under a strict injected read-only preamble; sandbox-off adds force-level authorization, while sandbox-on atomically merges/restores a temporary domain policy from `networkAllow`. Every launch emits structured preflight/elevation/policy events and malformed project CLI configuration is diagnosed distinctly.
- ACP now maps status-only tool progress, completion raw output, nested diffs, session/mode/model/command changes, todos, task/subagent activity, and generated artifacts. Thought text remains process-local. Session-load history is tagged `replay`, excluded from live state, duplicate-suppressed, and collapsed in Transcript.
- `cursor/ask_question` and `cursor/create_plan` use a revisioned `user-input-required` control-inbox flow with `delegate-jobs respond`, stable command idempotency, configurable reject timeout, and no fabricated answers or plan acceptance. Force permissions select only `allow_once` and journal normalized decision context.
- ACP initialize/session catalogs are retained, `parameterizedModelPicker` is preferred when present, context occupancy is separated from output-token usage, health prefers `agent status --format json`, and a versioned no-turn terminal/fs capability probe keeps production client capabilities false until observed working.
- Added advanced Cursor job/CLI fields `addDirs`, `approveMcps`, `cursorWorktree`, and `cursorWorktreeBase`. Documented the remaining honest non-parities: restart-only correction, completion-only shell output, no mid-turn token usage, and no rate-limit/allowance feed.
- `file.changed` is now visible in CLI/MCP and TUI transcripts as one compact cwd-relative line per file, with normalized added/removed line counts when source diff or old/new text is available. Rename/delete labels, Diff-tab navigation, semantic count colors, glyph fallbacks, and legacy journal normalization are shared across Codex and Cursor.

## 0.23.3 — 2026-07-14

- Width probe now completes on terminals that pace CPR replies per render frame (bare Ghostty): event-driven incremental reply parsing, budget scaled to the measured reply cadence (cap 500ms), raw-mode enforcement, exclusive stdin ownership during the probe, and distinct unproven(budget)/timeout/no-raw-mode verdicts. probeVersion=3 invalidates prior verdicts. Restores the elegant glyph set on directly-attached fast terminals.

## 0.23.2 — 2026-07-14

- App-bar version now comes from package.json at startup (a hardcoded `v0.22.0` fallback in the view had been lying since the restyle, causing a cross-machine version-skew wild-goose chase); absent version renders `v?` so failure is visible.
- delegate-shim warns on stderr before its sibling fallback (missing installed binary or failed registry lookup) — silent fallback masked broken installs.
- delegate-bootstrap re-points stale delegate-* symlinks to the current version's shim each session and recreates dangling ones, so pruned old cache versions can no longer strand commands.

## 0.23.1 — 2026-07-14

- Width-probe hardening for fast local terminals (bare Ghostty): strict in-order CPR parsing with resynchronization past malformed replies (previously a bad reply shifted width assignments across glyph families), explicit measured/parse/timeout outcomes in verbose mode, and `probeVersion` in the cache identity so stale verdicts invalidate on update — restores missing icons/glyphs on machines whose first probe ran under earlier builds.
- Transcript plan checklists render via the tiered glyph system (✓ / spinner / ○ with fallbacks) instead of ASCII markers.

## 0.23.0 — 2026-07-14

The TUI modernization release: fourteen owner-tested rounds on one Codex Sol thread.

- Transcript redesigned as a coalesced conversation (blocks, not deltas); enriched clickable tool lines (commands, exit codes, durations, files; expandable output; `d` jumps to path-filtered diff); live activity states (thinking/streaming/tool/approval) with per-transport honesty and content-free journal markers.
- Rendering correctness, ten root causes each sealed by a fail-first invariant: wide-glyph spans, SGR bleed, raw-write terminal ownership (stdout/stderr capture into the status history), selection mapping unification (three regressions -> one frame-level contract), edge-column ownership, scrollbar geometry in display-line units, ambiguous-width classification (full Unicode 17 EastAsianWidth=A table; suspect-grapheme confinement so tmux width disagreement cannot displace neighbors), directional pre-clear styling, palette initialization staleness (live-palette rule), and dashboard band ownership. Verified byte-level: a VT-interpreter oracle over real emitted output, adversarial width-reversal thrash, and a flight recorder (`DELEGATE_TUI_DIAG`, Ctrl-G markers, `--analyze` writer-vs-terminal verdicts) that closed the investigation with a 618-frame byte-perfect capture on the owner's Ghostty+tmux stack.
- Modern design language: three-tier probe-gated glyphs (CPR-measured on the interposed terminal, cached per identity incl. tmux) restoring rounded corners and box borders on proven terminals with safe fallbacks; one-accent discipline, focus borders, whitespace tables, underline tabs, app bar with allowance chips, eighth-block meters, 100ms unison braille spinners, pill badges, designed empty states, light theme.
- Attention-first Dashboard home: "what needs you" section, stat tiles with truthful chain-aware token attribution (resume chains no longer multiply thread-cumulative totals — fixed a 1.08B-token day down to its real 138M), provider allowance strip, activity feed, labeled sparklines with sparse-data placeholders.
- Fleet/UX: groups and chain screens, in-pane search, launcher with $EDITOR handoff + verify/ingest fields + live route advisor, review-round from detail, desktop notifications, clipboard copy, timestamp toggle, persisted preferences, follow-mode symmetry across all input paths, fleet freshness fixes, redesigned events view with JSON syntax coloring.
- Broker fixes surfaced by the TUI: compound usage-key redaction (cachedInputTokens etc. no longer redacted as secrets, sensitive token keys still protected); hermetic test harness with a polluted-environment proof (suite passes on machines with real prefs/probe caches).

- Added an attention-first Dashboard home with actionable jobs, daily outcome/token/cache tiles, provider allowance meters, notable cross-job activity, 14-day trend sparklines, and progressive Dashboard → Fleet → Detail → Events navigation.
- Restyled every TUI screen around one semantic palette and one probe-gated glyph system: rounded focused panes, padded whitespace tables, underlined tabs/headers, compact app/footer bars, subtle left-edge selection, pills, centered empty states, braille spinners, and eighth-block meters with deterministic Unicode and ASCII snapshots.
- Restored elegant borders, scrollbars, separators, meters, and status/tool glyphs only when CPR proves them width-1 on the active terminal or tmux layer; conservative Unicode/ASCII fallbacks and `DELEGATE_TUI_ASCII=1` retain the rendering guarantees when probing is unavailable.
- Hardened rendering for Ghostty-inside-tmux and other width-table mismatches: data-row chrome is width-certain, suspect transcript graphemes are isolated with absolute cursor placement and guard repainting, and a tmux-aware runtime CPR cache corrects measured widths.
- Completed the width defense with Unicode 17's full East-Asian-Ambiguous range table, ASCII replacements for ambiguous punctuation and borders, explicit new-owner styling for suspect-span pre-clears, and independent Transcript selection at viewport boundaries.
- Added opt-in `DELEGATE_TUI_DIAG` byte/frame flight recording, `Ctrl-G` sighting markers, and no-TTY `delegate-tui --analyze` replay with writer-vs-terminal verdicts and bounded byte windows.
- Repaired Transcript selection after scrollbar line-metric refactoring by sharing the exact painted pane rectangle across wrap, highlight, click, search, and scroll-into-view; frame-level wheel/arrow/expansion/streaming regressions now pin selected text.
- Redesigned Transcript as a coalesced conversation view: exact message-delta joining with authoritative completions, replace-in-place plans, compact expandable tool activity, provider-noise exclusion, block-aware search/follow, and best-effort raw-Events jumps.
- Enriched Codex and Cursor tool lines with commands, exits, duration, file kinds/locations, MCP names, bounded output tails, and direct path-filtered Diff navigation.
- Added transport-honest live activity to Fleet and every detail tab. Codex app-server and Cursor ACP emit rate-limited, content-free thinking/output transition markers; Cursor headless explicitly retains reduced streaming/quiet/stall visibility without inferred reasoning, tools, or approvals.
- Added deterministic coalesced-transcript and activity snapshots plus transition, provider-capability, wrap-cache, and tool-derivation regressions. Runtime/plugin versions remain unchanged pending owner validation.

## 0.22.0 — 2026-07-14

- Added a loopback-only, bearer-authenticated `delegate-tui --serve [--port N]` read export over dependency-free HTTP/SSE, with private first-use token generation, constant-time authentication, bounded event/diff responses, connection caps, slow-client deadlines, access logging, and graceful shutdown.
- Added a fetch-backed `RemoteDatasource` and `delegate-tui --connect URL` client with five-second fleet polling, selected-job SSE follow, bounded retry backoff, a remote host column/header marker, and connection-loss state that never terminates the dashboard.
- Remote mode disables all broker mutations and launcher controls; cross-machine access is documented exclusively through an SSH loopback tunnel. Multi-host aggregation remains future work.
- Runtime/plugin versions intentionally remain unchanged until owner interactive validation and release.

## 0.21.0 — 2026-07-14

- Added a read-only, best-effort Claude coordinator Sessions screen with bounded transcript-tail parsing, redacted last-activity labels, active/idle classification, exact-cwd managed-job counts, and existing writer-lock attribution.
- Added ten-second and filesystem-watch refreshes, a 200-session newest-first scan cap, missing-directory degradation, and Enter-to-Fleet cwd filtering without transcript viewing.
- Runtime/plugin versions intentionally remain unchanged until owner interactive validation and release.

## 0.20.0 — 2026-07-13

- Added group barrier/member screens and a conditional sixth Chain detail tab with round outcomes, changed-file counts, verification exits, result markers, and direct round jumps.
- Added incremental, palette-highlighted search for Transcript, Events, and opened Diff panes with lazy wrap-cache hit mapping, plus loaded-audit-row filtering in Stats.
- Matured the launcher with private `$VISUAL`/`$EDITOR` packet-body handoff, verify and ingest-file fields, and a debounced advisory route pane. Terminal detail now starts diff-aware review rounds through the shared broker assembly.
- Added privacy-safe, non-blocking terminal/stall/scope/budget desktop notifications with per-job debounce, an in-session toggle, and `DELEGATE_TUI_NOTIFY=0` suppression.
- Added click-to-select rows and click-to-switch detail tabs, `delegate-tui --job <id>`, and the `DELEGATE_TUI_THEME=light` palette variant.
- Runtime/plugin versions intentionally remain unchanged until owner interactive validation and release.

## 0.19.0 — 2026-07-13

First release of `delegate-tui` — a zero-dependency hand-rolled ANSI dashboard over the local job store (fleet board, five-tab job detail with live transcript follow, providers/stats panels, safe controls, profile-aware launcher with mandatory dry-run). Implemented by delegated Codex Sol@xhigh with three owner-tested fix rounds: semantic muted palette + NO_COLOR, fast paint (8ms real-store startup) and instant teardown, transcript history hydration, stale-record reconciliation in the TUI and in pruneJobs, virtualized scrolling with wrap caching and input coalescing (1.3ms mean scroll frame on a 26k-event journal), SGR mouse-wheel support with mouse-off guaranteed on every exit path.

- Added `delegate-tui`, a zero-dependency, hand-rolled ANSI fleet dashboard with cursor-tailed job journals, buffered changed-run repainting, Unicode display-width handling, fleet/detail/provider/stats views, and a dry-run-gated launcher.
- Added safe interactive controls: revisioned steer/release/cancel, terminal resume and narration nudge, suffix-confirmed cancellation, and dry-run-first safe revert. Dangerous sandbox, approval-force, and concurrent-writer overrides are intentionally absent.
- Added read-only active-writer introspection in the shared control library, terminal bootstrap/shim exposure, deterministic 100×30 headless snapshots, and focused width/screen/datasource/view-model/CLI coverage.
- This development scope intentionally leaves runtime and plugin versions at `0.18.1` until interactive owner validation is complete.
- Docs: made managed Codex `mode=review` with Sol at `xhigh` the default for scoped review and required real-tree `verify` commands as the verification of record for write-mode delegations.

## 0.18.1 — 2026-07-13

- Docs: general-purpose coordinator lessons from the dogfood run moved into the skill — write-mode packets must state that zero changed files is a failed objective; idempotency replay intentionally returns objective-failed jobs (mint a new key for a changed retry); fold an analysis-only turn's output into the fresh packet as verified context.

## 0.18.0 — 2026-07-13

- **`resultSuspect: 'no-changes-write-mode'`** on completed write-mode jobs with zero observed changes — the write-mode analogue of the narration flag, on the record itself and not only via `wait` exit 5 (added by the coordinator from this wave's own failed first round).
- Generalized bounded start waits to `session`, `turn`, and `first-output`, preserving `waitForSession` / `--wait-for-session` aliases.
- Windowed terminal `resultText` by case-sensitive find or absolute offset through CLI and MCP inspect.
- Added review-round continuations that anchor findings with recorded diff stats, changed files, and scope.
- Added side-effect-free start dry-runs with resolved profiles/options, ingest plans, packet lint, and the exact provider packet.
- Guarded ingest copy-back with source hashes; divergent provider output lands at `<source>.delegate-new` and emits `ingest.diverged`.
- Retry backoff now settles cancel before any relaunch and rejects steering between attempts.
- Added idempotent terminal-audit backfill for retained jobs missing from `audit.jsonl`.

## 0.17.0 — 2026-07-13

- `delegate-jobs stats [--since]` aggregates the terminal audit log by provider/model/mode; deterministic routes gain advisory historical output-token bands when matching samples exist.
- Named packet profiles merge local or bundled skeletons with explicit-option precedence and packet-section lint warnings; `independent-review` ships as the fallback example.
- Fan-out `groupId` tagging, filtered lists, and terminal group summaries compose with the existing per-cwd writer guard.
- `startPaused` establishes a Codex thread or Cursor ACP session before the first prompt; `delegate_release` / `delegate-jobs release` advances it, while cancellation and the original timeout remain active during the pause.
- `ingestFiles` privately stages up to 20 declared out-of-tree files, copies changed content back only on completion, and leaves failed staging referenced by the checkpoint.
- Read-mode `autoNudge` performs at most one same-session inline-findings correction and preserves `result.firstAttemptText`.
- `delegate-health --deep` spends real allowance on one bounded managed read probe per enabled provider and records `lastVerified` in state.
- `DELEGATE_MAX_CHANGED_FILES` (default 200) interrupts Codex live with non-retryable `LARGE_WRITE`; Cursor records the same threshold post-hoc as `largeWrite` plus `large.write`.
- Optional `reportSchema` adds a best-effort fenced-JSON contract, parses the last block into `result.structured`, surfaces `objectiveMet`, and flags `structuredMissing` without failing the job.

## 0.16.0 — 2026-07-13

- Opt-in `retryPolicy` for transport and provider rate-limit/server failures, with bounded backoff, same-record continuation, `job.retry` events, and retry counts.
- Write-mode `verify` commands run after provider success with timeout, redacted output tail, structured verdict, and `delegate-jobs wait` exit 6 on nonzero.
- Failure/cancellation checkpoints formalize continuation and partial-diff recovery; Codex interruption drains briefly before process termination.
- `delegate-jobs revert <id> [--dry-run]` safely restores job-owned tracked files and removes job-created files while refusing pre-existing overlap and later edits.
- Inspect now derives `resumable` and `driftReport` from the same resume rules and recorded inventory.
- Dirty write baselines emit `baseline.dirty`; provider adapters assert overridable minimum CLI versions with `PROVIDER_TOO_OLD`.

## 0.15.0 — 2026-07-13

- Atomic, per-cwd `idempotencyKey` replay for `delegate_start`, with matching `--idempotency-key` CLI support.
- Per-job `maxOutputTokens` on start/resume; budget stops use provider-aware cancellation and preserve partial state/continuations under `BUDGET_EXCEEDED`. `delegate_usage` now includes chain-cumulative totals.
- Closed broker error taxonomy with `code`, `retryable`, and provider attribution.
- Journal-tail `lastActivityAt` plus non-destructive `stalled` detection (`DELEGATE_STALL_SECONDS`, default 300).
- Outbound credential-pattern scan with `SECRET_IN_PROMPT`; explicit `allowSensitive` overrides emit `security.warning`.
- Never-pruned, redacted terminal audit JSONL; `delegate-health` reports its path.

## 0.14.1 — 2026-07-13

- `delegate-health` human output leads with the active version and the surface-pinning rule.

## 0.14.0 — 2026-07-13

Field-report remediation (three independent coordinator evaluations).

- **Non-fast contract enforced end-to-end.** Live ACP catalogs can advertise `composer`/`grok` only as fast variants; the resolver now flags that compromise, and the adapter escapes to the headless transport with the CLI's non-fast id (`cursor:acp-tier-fallback`) or, when no non-fast form exists anywhere, proceeds fast with a loud `cursor:fast-fallback` event. Never silent.
- **`cursor:model-mismatch` event** when the session's `session_info_update` reports a different model than negotiated (previously overwrote `resolvedModel` silently).
- **`cursor-grok-4.5-*` id drift**: shorthands and headless resolution now match the CLI's `cursor-` prefixed Grok ids; regression fixtures pin the live catalog shapes.
- **`changedFiles` normalized and deduped**: absolute provider paths are rewritten repo-relative and merged, so one file is one entry.
- **`allowedPaths` scope fencing** on `delegate_start`/`delegate_resume` (`--allowed-paths` on CLI): the fence is injected into the worker prompt, and out-of-scope changed files are recorded as `scopeViolations` on the job plus a `scope.violation` event.
- **`waitForSession`** (`--wait-for-session`): block briefly until the provider session id is recorded, removing the race in gated/plan-filed delegation.
- **`resultText`** on terminal records: one normalized text field across Codex (string), Cursor ACP (`{text, plan}`), and Cursor headless (CLI envelope) result shapes.
- **`resultSuspect: 'short-final-message'`** on read-mode jobs whose final message looks like narration instead of findings — resume with "paste the full findings now".
- **`capabilities.selfEnforcesProjectHooks`**: Codex workers load trusted-project docs/hooks themselves; Cursor workers do not.
- **`delegate_diff paths` / `diff --paths`**: filter the unified diff to given path prefixes (e.g. the job's `allowedPaths`).
- **`delegate_list` chain grouping**: rows carry `session` and `rootJobId` so resume chains group.
- **`delegate-jobs start --wait`**: start and block to terminal state in one command.
- **`delegate-health`** prints the active version, a surface-pinning note, and explains Cursor's permanently-manual usage.
- This CHANGELOG.

Planned work now lives in [ROADMAP.md](../delegate-router/ROADMAP.md) (three prioritized waves consolidated from five field reports).

## 0.13.x — 2026-07-13

- `finishedPath` sentinel written on every terminal transition (background waiter processes can be reaped by the host harness; watch the sentinel instead).
- `reviewFlowEngaged` detection from collab-agent items; `delegate_resume` fails fast with `RESUME_UNSUPPORTED`.
- Security preamble permits project tooling to consume secrets internally (builds, tests, dev servers) while forbidding echoing contents.
- Doctrine: green checks are not a correctness gate for stateful/billing/auth work; adversarial review every round. (0.13.1: keep skill docs project-agnostic.)

## 0.12.0 — 2026-07-12

- `WRONG_LANE` guard: GPT models on `provider=cursor` are refused while Codex is enabled and under its avoid band; `overrideLane` for explicit user requests.
- Full MCP↔CLI parity for start/resume/list/events/diff options; positional-vs-flag-value parsing fixes.

## 0.11.x — 2026-07-12

- Per-job `sandbox=off` (Codex `danger-full-access`, Cursor `--sandbox disabled`) with coordinator judgment guidance; Codex web search auto-enables with network or full access. (0.11.1: document the Grok narration-turn pattern.)

## 0.10.0 — 2026-07-12

- Baseline content hashes: pre-existing dirty files the job never changed are excluded from diff/inventory/changedFiles; `overlapsPreexisting` flags mixed files.
- Cursor fast variants opt-in; router emits Cursor Auto for non-complex tasks with no user-named model.

## 0.9.0 — 2026-07-12

- Researched routing policy: Fable never auto-selected (`requiresAuthorization`), Sol@xhigh as the review/second-opinion configuration, model/effort guidance sections.

## 0.8.x — 2026-07-11

- Two-machine field-report remediation: fail-closed Cursor model resolution, `changedFiles` mechanical record, diff windowing/`statOnly`, `wait` exit 5, `RESUME_UNSUPPORTED` mapping, events size-cap, `list` alias. (0.8.1: normalize attribute-serialized catalogs; 0.8.2: headless fallback for ACP tier gaps; 0.8.3: plan-mode plans reach `result.plan`.)

## 0.7.x — 2026-07-11

- External security review remediation: security preamble always applied, streaming-delta redaction, state-write lock, per-cwd writer atomicity. (0.7.1: cursor-based journal reads; 0.7.2: `--effort` flag.)

## 0.5.0 – 0.6.0 — 2026-07-11

- Compliant allowance monitoring: Codex windows push-captured, Claude via status-line wrapper only (ToS), Cursor manual with TTL; stricter Cursor guard bands.

## 0.4.x — 2026-07-11

- Initial public release: managed job store, `delegate_list`, orphan reconcile, writer guard, per-job timeouts, transcript pagination, retention pruning, `delegate-jobs wait`; one-step marketplace install with self-provisioning shims.
