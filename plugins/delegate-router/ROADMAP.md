# Roadmap — production-hardening waves

Consolidated from five coordinator field reports (2026-07-13) plus the CHANGELOG "Planned" list. Deduped against shipped behavior; each item carries a design sketch and size (S/M/L). Waves are release-sized: a wave ships as one version with tests.

## Already covered (asks answered by 0.14.x or earlier — no work)

- Broker scope fencing → `allowedPaths` + `scopeViolations` + `scope.violation` event (0.14.0). Flag-not-reject is deliberate: the broker cannot intercept provider writes mid-turn; it guarantees detection, not prevention.
- Drift report → `baselineHashes` + normalized `changedFiles` + `scopeViolations` are the three components; Wave 2 adds the convenience assembly on inspect.
- Resume-flow surprise → `reviewFlowEngaged` + fail-fast `RESUME_UNSUPPORTED` (0.13.0); Wave 2 adds `resumable` on inspect.
- Plan-before-write → `mode: 'plan'` already exists; use it explicitly for high-risk clusters (docs strengthened).
- Version skew → CHANGELOG + `delegate-health` active-version line (0.14.x).
- Transcript secret redaction → shipped since 0.7.0 (recursive redaction + streaming-delta tails). The *outbound prompt* scan is new (Wave 1).
- Resume chains → `session`/`rootJobId` on list rows (0.14.0); Wave 3 adds the chain view.
- WRITER_ACTIVE is already cross-session for managed jobs (shared per-user store); the real gap is unmanaged editors — Wave 2 documents the boundary and adds a dirty-tree warning; an inter-tool lockfile convention is listed under Declined/Deferred with reasoning.

## Wave 1 — v0.15.0 "safe to leave running" (top-ranked by every report)

1. **`idempotencyKey` on `delegate_start`** (S). Client-supplied key stored on the job; a replayed start with the same key returns the existing job instead of double-launching a writer. Same pattern as `correctionId`. Keyed lookup inside the existing per-cwd launch lock so the check is atomic.
2. **Per-job budget cap** (M). `maxOutputTokens` on start/resume; the broker already receives `usage.updated` pushes — when the total crosses the cap it issues the provider-aware cancel, marks `stoppedReason: 'budget'` with `BUDGET_EXCEEDED`, and the partial diff/continuation id are preserved exactly as for timeout. No `maxCostUSD`: there is no reliable cross-provider price table; tokens are the honest unit. `delegate_usage` gains chain-cumulative totals via `rootJobId`.
3. **Typed error taxonomy** (M). Closed enum on every thrown broker error: `{ code, retryable, provider }` (`WRITER_ACTIVE` retryable-after-wait, `QUOTA_GUARD` fallback, `REVISION_CONFLICT` retry-with-current, `INVALID_MODEL`/`WRONG_LANE` terminal, transport errors retryable…). Errors already carry `code` strings; this normalizes the set, adds `retryable`, and documents it in protocol.md so orchestrators branch without string-matching.
4. **Heartbeat / stall detection** (S). `lastActivityAt` (journal tail timestamp) on inspect/list plus `stalled: true` when a running job has no new events for `DELEGATE_STALL_SECONDS` (default 300). Flags, never kills — "slow vs stuck" becomes visible.
5. **Outbound prompt secret scan** (S). Run the existing sensitive-value patterns over the task packet at job creation; block with `SECRET_IN_PROMPT` (allowSensitive overrides to warn-and-event). Closes the coordinator-side half of the secret door.
6. **Append-only audit log** (S). One redacted JSONL line per terminal transition — who/provider/model/mode/sandbox/network/approval/cwd/changedFiles-count/scopeViolations-count/outcome/usage/duration — in a separate never-pruned file, so "what did the delegate touch under what permissions" survives the 14-day job retention.

## Wave 2 — v0.16.0 "recovery & verification"

7. **`retryPolicy`** (M). `{ maxAttempts, retryOn: ['transport', 'rate-limit'] }` on start — transport-level failures only (handshake, process exit before turn, 429/5xx), never task-level; backoff between attempts; each retry evented and counted on the record. Builds on the Wave-1 taxonomy's `retryable` flag.
8. **`verifyCommand` post-run gate** (M). `verify: { command, timeoutSeconds }` on write modes; the broker runs it in the real checkout after completion and records structured `verification: { command, exitCode, outputTail }` on the record; `delegate-jobs wait` gains exit 6 for verification failure. This is the coordinator's own command (they already have shell) — no new privilege.
9. **Timeout/failure checkpoint formalization** (S). On TIMEOUT/failure: record `failureReason`, partial-diff pointer, continuation id, and a `resumeHint` in one `checkpoint` block; cancel path gains a short drain grace (interrupt → wait → kill) to avoid truncating an in-flight write.
10. **`delegate-jobs revert <id>`** (M). Safe manual rollback instead of auto-rollback: revert exactly the job's authored changes using baseline hashes, refusing files flagged `overlapsPreexisting` (surface those for manual resolution). Auto-rollback is deliberately rejected — in a shared dirty worktree it can destroy concurrent work.
11. **`resumable` + `driftReport` on inspect** (S). `resumable: { ok, reason }` (review-flow, missing session, active parent); `driftReport: { modified, newFiles, outsideScope }` assembled from data the broker already has.
12. **Dirty-tree warning + provider min-version assertion** (S). Write-mode start against a dirty baseline emits a warning event; adapters assert minimum CLI versions with a clear `PROVIDER_TOO_OLD` error at start, not a cryptic mid-turn failure.

## Wave 3 — v0.17.0 "fleet & DX"

13. **`delegate-jobs stats [--since]`** (M). Aggregates from the Wave-1 audit log: jobs by provider/model/mode, success/resume/nudge/violation rates, mean tokens and duration. Turns "Grok reviews need a resume 40% of the time" into data — and feeds…
14. **Cost band in `delegate-route`** (S, after 13). Historical p50/p90 token band for the (provider, model, effort, mode) cell, shown as advisory pre-flight.
15. **Job profiles** (M). Named packet skeletons (`~/.delegate/profiles/<name>.md` with required-field frontmatter: objective/scope/acceptance/verification/return-contract); `--profile independent-review` merges skeleton + task objective; packet lint warns on missing required fields.
16. **Fan-out groups** (M). `delegate_start_batch` (or `groupId` on start): starts N jobs tagged as a group, `delegate_list --group` shows grouped state, and group completion = all sentinels present (composes with Monitor). Read-only fan-out unrestricted; write fan-out requires worktree isolation per job.
17. **`startPaused`** (M). Create the thread/session (id available immediately, gated plans can be filed), worker holds before the first turn until a `release` control. Both providers have a natural pause point (Codex `thread/start` without `turn/start`; ACP `session/new` before `session/prompt`). Supersedes the remaining race that `waitForSession` narrows but does not close.
18. **`ingestFiles`** (M). Copy declared out-of-tree files into a `.delegate-staging/` area inside the workspace on start (auto-added to `allowedPaths`) and back on successful completion; the staging recipe in control.md becomes mechanical.
19. **`autoNudge` opt-in** (S). Read-mode jobs flagged `resultSuspect` get one automatic resume ("paste the full findings now") when `autoNudge: true`; off by default because a false positive costs a turn.
20. **`delegate-health --deep`** (M). One tiny live read-only probe per enabled provider (1 turn, no writes), stamping `lastVerified: { provider, cliVersion, date }` into state — catches auth/adapter breakage before a real job does.
21. **Large-write circuit breaker** (M, honest limits). Codex streams `fileChange` items live: crossing `DELEGATE_MAX_CHANGED_FILES` (default 200) triggers pause-and-surface (cancel + checkpoint). Cursor reports files only at completion, so there it is a post-hoc `largeWrite: true` flag + refusal to auto-accept — documented asymmetry.
22. **Structured result contract** (M). Optional `reportSchema` on start: the packet instructs the worker to end with a fenced JSON block; the broker parses it into `result.structured` (with `objectiveMet: true/false/partial` as a required key), flags `structuredMissing` when absent. Best-effort by design — workers are untrusted; the mechanical fields (changedFiles, verification) remain the ground truth.

## Wave 4 — v0.18.0 "coordinator dogfood" (friction observed while delegating Waves 1-3 through the plugin itself)

Waves 1-3 were implemented by delegated Codex Sol@xhigh jobs supervised through this plugin (3 implement jobs + 1 review-fix resume, 4 releases, 2 defects caught by coordinator review, 0 escaped). Every item below is a compensation the coordinator performed by hand during that run.

23. **First-output wait** (S). `waitForSession` returns at session establishment, but "has it actually started producing?" still needed a sleep-then-inspect. Generalize to `waitFor: 'session' | 'turn' | 'first-output'` on start (bounded like waitForSession), keyed off existing phase transitions and first delta event.
24. **Result windowing** (S). Long `resultText` had to be sliced with ad-hoc python three times. `delegate-jobs result <id> [--find <text>] [--offset N] [--max-chars N]` and matching windowing on the MCP read path — same pattern as `delegate_diff`.
25. **Review-round helper** (M). Each fix round meant hand-assembling a packet of defects + diff context. `delegate-jobs review-round <id> --prompt-file <findings>` (and MCP equivalent): wraps `delegate_resume` and auto-prepends the job's diffStat, changedFiles, and scope so the worker re-anchors without the coordinator pasting context.
26. **`start --dry-run` packet preview** (S). `delegate-cursor` has `--dry-run`; `delegate-jobs start` does not. Print the fully-merged packet (profile + scope fence + preamble + ingest note) and resolved options without launching — the natural companion to packet lint.
27. **Ingest copy-back divergence guard** (S). `completeIngestedFiles` copies staged content back over the source even if the user edited the source mid-job. Record the source hash at ingest; on divergence write `<source>.delegate-new` beside it and report, instead of clobbering.
28. **Cancel honored during retry backoff** (S). A cancel landing in the backoff window between retry attempts is only honored after the next provider spawn. Check pending cancel commands before relaunching.
29. **Stats backfill** (S). `audit.jsonl` only starts at v0.15.0; terminal job records still in retention are invisible to `stats`. `delegate-jobs audit backfill` appends synthetic audit lines for terminal jobs missing from the log (idempotent by jobId).

## Declined / deferred, with reasons

- **Native harness notification from the broker** — a detached worker cannot re-invoke the Claude Code harness; that is what background tasks/Monitor are for. `finishedPath` + Monitor stays the canonical long-wait; a bounded `delegate_wait` MCP tool would cap at ~30s long-poll like `delegate_events` and add little.
- **Auto-rollback on failure** — unsafe in shared dirty worktrees (can destroy concurrent work); replaced by explicit `delegate-jobs revert` (Wave 2).
- **`maxCostUSD`** — no trustworthy cross-provider price table; token caps only.
- **Worktree-per-writer auto-merge** — isolation exists (`isolation: 'worktree'`); automatic merge + conflict resolution is a large project with sharp failure modes; revisit after fan-out groups land.
- **Per-provider concurrency cap / fair queue** — real but heavier; revisit with fan-out usage data from `stats`.
- **Repo-scoped advisory lockfile for unmanaged editors** — only works if every other tool honors it; documented as a convention (the broker could optionally emit one) rather than promised as a guarantee.
- **Cache-growth notices** — host-disk hygiene is outside the broker's contract; a `stats` footnote at most.
- **Tenant isolation guarantees** — this is a single-user local tool; multi-tenant hardening is out of scope until that changes.
