# Changelog

All surfaces (skill, MCP servers, CLI) version together. The CLI resolves to the installed plugin on every run via `delegate-shim`; the skill and MCP servers pin at Claude Code session start — reload plugins after upgrading to align all surfaces. `delegate-health` prints the active installed version.

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
