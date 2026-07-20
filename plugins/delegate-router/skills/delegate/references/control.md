# Delegation Control Protocol

## Before Starting

1. Inspect the current worktree and identify pre-existing changes.
2. Define an explicit allowed path scope and non-goals.
3. Select read-only or write access deliberately.
4. Specify acceptance criteria and verification commands.
5. Record the provider, model, mode, and start.

Use `delegate-cursor --dry-run ...` when an explicit user constraint, unfamiliar machine, or sensitive workspace makes the resolved command worth inspecting first.

## Access Policies

- Codex uses `approval_policy=on-request` with `approvals_reviewer=auto_review`. This is Approve-for-me: Auto-review evaluates escalations rather than bypassing the sandbox.
- Cursor write modes use `--auto-review --trust`. `approval=force` selects only ACP `allow_once`, never `allow_always` (which would contaminate global Cursor configuration). `network=true` with `sandbox=off` is also a force-level grant because Cursor requires `--force` for WebFetch and equivalent ACP permission handling; obtain the same explicit authorization as any sandbox-off force run.
- New Codex starts are blocked by a `PreToolUse` quota hook at or above the avoid threshold. Users can deliberately override with `DELEGATE_ALLOW_OVER_LIMIT=codex`.
- Network remains off unless the task needs current external information and the user permits it; the explicit control is `network=true` on `delegate_start` for both providers. Every Cursor launch emits `network.preflight` with the requested/effective mode, sandbox state, `sandbox.networkAccess`, temporary sandbox policy, force state, expected egress, and the separate WebFetch gate.
- `sandbox=off` disables provider sandboxing entirely (Codex `danger-full-access`, Cursor `--sandbox disabled`) for jobs that require host tools: git push, gh/PR flows, package installs, authenticated CLIs, live web. It is a per-job caller judgment — decide from the task packet, surface to the user when unsure, record the choice in the pre-delegation update, and never pair it with `approval=force` without explicit user acceptance. Codex web search turns on automatically when `network=true` or `sandbox=off`.
- Consult, plan, and review modes are read-only. Cursor ask/plan modes categorically reject network tools, so a read-only Cursor job with `network=true` is launched in agent mode with a strict injected no-write/no-destructive-command preamble and a loud `network.mode-elevated` event. This changes the provider mode, never the job's read-only contract.
- Sensitive files are excluded by default. Do not read or transmit `.env*`, `*secret*`, `*credential*`, `*.pem`, or `*.key` without explicit path-level authorization. Outbound task packets are scanned for credential-shaped values and fail with `SECRET_IN_PROMPT`; `allowSensitive=true` explicitly overrides both checks and emits `security.warning`. It never removes scope control or the preserve-existing-changes rule. Project tooling may consume secrets internally, but workers must never echo or relocate their contents.

- `allowedPaths` on write modes declares the job's file fence: injected into the worker prompt and enforced post-hoc as `scopeViolations` + a `scope.violation` event. Prefer it over prose-only fencing for every bounded write job.
- `ingestFiles` accepts up to 20 absolute regular files outside cwd, each smaller than 10 MB. The broker copies them into `.delegate-staging/<jobId>`, records the source-content hash, and adds that directory when `allowedPaths` is set. Byte-changed staged content copies back only after `completed`; a concurrently changed source is preserved and the staged version is written to `<source>.delegate-new` with `ingest.diverged`. Failures leave staging referenced by the checkpoint. Sensitive names still require `allowSensitive=true`.
- Cursor headless consult/plan/review runs use streaming NDJSON under `--mode ask|plan`; thinking, assistant, and structured tool events remain visible. Networked read-only work is the explicit agent-mode elevation above. With sandboxing enabled, `networkAllow` materializes a merged temporary `.cursor/sandbox.json` (`default: deny` plus the supplied domains; omitted means `default: allow`) and restores the exact prior file on every exit path. Existing denies win and conflicting requests fail before launch. Project `.cursor/cli.json` supports only `permissions.allow/deny`; malformed or wrong-schema files fail as `CURSOR_PROJECT_CONFIG_INVALID` health detail and an actionable preflight error naming the file.

Advanced Cursor-only start/resume options are `addDirs[]` (`--add-dir`), `approveMcps` (`--approve-mcps`), `cursorWorktree` (`--worktree`), and `cursorWorktreeBase` (`--worktree-base`). CLI spellings are `--add-dir` (repeatable), `--approve-mcps`, `--cursor-worktree`, and `--cursor-worktree-base`.

`delegate_transcript` includes compact `file.changed` entries: one cwd-relative `✎ path (+A −R)` line for each change, with rename/delete labels and counts only when the journal's unified hunk or old/new text can establish them. It never returns the full diff or old/new file bodies through that transcript surface; use `delegate_diff` for hunks.

## Writer Ownership

Allow only one writer for a path set. A read-only reviewer may inspect a stable diff, but do not ask it to review files while another agent is actively changing them. The coordinator owns final integration.

The broker enforces this for managed jobs: a write-mode start (`implement` or `verify`) in a cwd that already has an active write-mode job fails with `WRITER_ACTIVE` and the blocking job's ID. Orphaned writers (dead worker process) are reconciled to `failed` automatically and stop blocking. Worktree-isolated jobs are exempt. `overrideWriter=true` bypasses the guard; use it only with explicit user acceptance of concurrent writers.

This guard cannot see unmanaged editors, including the current coordinator or a built-in subagent. Direct Codex MCP and Cursor CLI launches remain behavior-compatible and are never blocked by the managed writer guard. Their shadow record instead sets `overlapsManagedWriter: true` and emits `DIRECT_WRITER_OVERLAP` as a warning when a write-capable direct call shares a cwd with an active managed writer. A write job launched from a non-empty Git baseline emits `baseline.dirty` with a bounded path list; treat either signal as a coordination warning, not proof that no other editor is active.

Give any start that may be retried a stable `idempotencyKey`. Lookup and job creation are atomic under the per-cwd launch lock, so a replay returns the existing job instead of launching a second worker.

An opt-in `retryPolicy` may set `maxAttempts` from 1–5 and choose `transport` and/or `rate-limit`. Retries reuse the same job and provider session when one exists, are journaled as `job.retry`, and never apply to scope, quota, model, budget, user-input, or other task-level outcomes. The default is one attempt.

Tag independent fan-out jobs with one `groupId`; `delegate_list` can filter or summarize the group. The ordinary same-cwd writer guard still applies to grouped write jobs, so use read-only fan-out or actual worktree isolation.

Every writer must:

- Preserve user changes and unrelated dirty files.
- Avoid destructive Git commands.
- Stay inside allowed scope.
- Stop if the scope or acceptance criteria conflict.
- Report exact changed files and verification performed.

## Continuations

Store the Codex `threadId` or Cursor chat ID with the task. Resume only for the same objective. A follow-up should include new information, a correction, or a verification request rather than repeating the original prompt. Codex threads that engaged the multi-agent review flow (typically write-mode jobs whose approvals escalated) may refuse direct resume with `RESUME_UNSUPPORTED`; recover by starting a fresh job whose task packet folds in the prior findings.

Managed control commands use optimistic concurrency. Read the current job revision immediately before steering or cancelling and send it as `expectedRevision`. A `REVISION_CONFLICT` includes `currentRevision`, so one retry with that value is enough when your command is still appropriate; never overwrite another controller's newer decision. Reuse the same `correctionId` when retrying the same request.

`startPaused=true` opens the provider thread/session and sets phase `paused` before any prompt. Release it with `delegate_release` (or `delegate-jobs release`) at the current revision; cancellation works while paused, `waitFor='session'` (and the `waitForSession` alias) returns as soon as the paused session exists, and `timeoutSeconds` continues counting during the pause. `waitFor='turn'` and `waitFor='first-output'` use the same bounded journal-cursor poller.

A steer that reduces the remaining work can finish the job before any follow-up command arrives. Do not design a steer-then-cancel sequence around a shrinking task; cancel first if termination is the goal.

- Codex can accept a genuine same-turn correction through app-server `turn/steer`.
- Cursor ACP v1 cannot. Its correction path cancels the prompt and resumes the same session, and must be reported as a restart.

Cursor `cursor/ask_question` and `cursor/create_plan` requests are blocking control-inbox items, not provider noise. The job stays running in phase `user-input-required`, persists the redacted request under `pendingInput`, and emits `input.requested`. Inspect the latest revision, then use MCP `delegate_respond` or `delegate-jobs respond <id> --expected-revision N --request-id ... --answer ...` (with `--accept`/`--reject` for plans); retry the same response with the same `commandId`. No answer or plan approval is fabricated. `DELEGATE_CURSOR_INPUT_TIMEOUT_SECONDS` (default 300) bounds the wait; expiry rejects the provider request and fails with `stopReason: input-timeout`.

For managed runs, store the job ID and use the `delegate_control` inspection and control tools. Direct Codex MCP calls and Cursor foreground/background CLI runs create observable shadow jobs (`direct-mcp` and `direct-cli`) in the same store, event journal, transcript, diff/files, usage, audit/stats, orphan-reconciliation, and terminal-sentinel pipeline. They remain unmanaged provider loops: steer, cancel, release, respond, resume, review round, and revert return `DIRECT_TRANSPORT`, while inspect, list, events, transcript, diff, files, and usage stay available. Official Codex plugin jobs retain their own independent lifecycle commands. Never describe a direct or external-plugin job as a managed control-plane job.

## Idempotency

`idempotencyKey` guards against double-launching the same request (orchestrator restart, lost acknowledgement): a replayed start with the same key and cwd returns the existing job. It deliberately replays terminal jobs too, including ones whose objective failed — the caller must see the failed job, not silently relaunch it. When you intend a changed retry (new packet line, folded-in findings, different scope), that is a new request: use a new key.

## Timeouts

Managed jobs are bounded by `timeoutSeconds` (60–86400) or, when unset, `DELEGATE_CODEX_TIMEOUT_SECONDS` / `DELEGATE_CURSOR_TIMEOUT_SECONDS` (default 3600). Defaults are deliberately long — LLM agent jobs legitimately run long — so set an explicit value only when the task warrants a tighter or looser bound. A timeout interrupts the active turn and fails the job with a `TIMEOUT:` error; the thread remains resumable.

Codex interruption waits up to `DELEGATE_DRAIN_GRACE_MS` (default 3000, maximum 15000) for the turn to settle before the provider process is killed. Every terminal failure or cancellation records a `checkpoint` containing `failureReason`, `continuationId`, `lastDiffEventSeq`, and an actionable `resumeHint`.

`maxOutputTokens` is an optional per-job cap on provider-reported output tokens. Crossing it uses the normal provider-aware cancel path and fails with `stoppedReason: "budget"` plus `BUDGET_EXCEEDED`; partial events, diff, and continuation remain inspectable. Resumes accept a new cap and otherwise inherit the parent cap.

`DELEGATE_MAX_CHANGED_FILES` defaults to 200. Codex live `fileChange` paths crossing it interrupt and fail with non-retryable `LARGE_WRITE` plus a checkpoint. Cursor exposes only completion inventory, so its record is flagged `largeWrite: true` and evented `large.write` post-hoc; that asymmetry cannot prevent Cursor's writes.

Every write mode must set `verify: { command, timeoutSeconds }` (default 600 seconds) to the project's real check command. The worker runs `/bin/sh -c` in the real job cwd only after provider success, outside the provider sandbox, and records command, exit code, duration, and a redacted output tail. A nonzero verdict does not rewrite the provider outcome: status remains `completed`, while `delegate-jobs wait` exits 6.

Adapters assert their CLI versions before opening a provider session. `DELEGATE_MIN_CODEX_VERSION` and `DELEGATE_MIN_CURSOR_VERSION` override the validated built-in floors (`0.144.0` and `2026.7.0` respectively); a lower observed version fails with non-retryable `PROVIDER_TOO_OLD` and reports both versions.

Profiles live under `${DELEGATE_PROFILES_DIR:-~/.delegate/profiles}/<name>.md`; simple frontmatter supplies mode/model/effort/allowedPaths/reportSchema defaults and explicit start options win. The body must contain `{{objective}}`. Packet lint warns when Objective, Allowed scope, Acceptance criteria, or Return is missing. The bundled `independent-review` profile is used only when no local override exists. Optional `reportSchema` instructs a final fenced JSON block; a conforming final object becomes `result.structured`, `objectiveMet` is surfaced, and missing or nonconforming output sets `structuredMissing` without changing terminal status.

The bundled independent-review profile uses the canonical review object: `objectiveMet` is boolean; `findings` is an array of `{ severity: 'blocking' | 'non-blocking', file, line, summary, evidence }`; and `clean` is true when no findings remain. Structured output remains best-effort and the inline prose findings remain required, but coordinators should triage `result.structured.findings` by severity before reading the prose fallback.

`delegate_start dryRun=true` / `delegate-jobs start --dry-run` resolves profile and launch options, ingest destinations, lint findings, and the exact final provider packet without creating job or staging state. For a terminal continuation, `delegate_review_round` / `delegate-jobs review-round` prepends the recorded diff stat, changed files, and allowed scope to the caller's findings, then applies the ordinary resume and secret-scan rules.

## Failure And Quota Recovery

On timeout, output-budget exhaustion, quota exhaustion, or agent failure:

1. Stop the failed process; do not start a competing writer while it may still run.
2. Inspect the actual diff and process state.
3. Record the failure and provider usage state.
4. Build a recovery packet with completed work, partial changes, failed verification, continuation ID, and remaining acceptance criteria.
5. Select the best eligible fallback from the routing matrix.
6. Tell the fallback it owns an existing partial diff and must not revert unrelated changes.

`delegate_inspect` exposes `resumable: { ok, reason }` from the same predicate used by `delegate_resume`, plus `driftReport: { modified, newFiles, outsideScope }`. For manual rollback, run `delegate-jobs revert <id> --dry-run` first. Revert requires a terminal job, restores only non-overlapping files whose current content still matches the recorded final state, and reports `{ reverted, skipped, conflicts }`; it never overwrites pre-existing or later edits.

Long result text can be read with `delegate_inspect.resultWindow` or `delegate-jobs result --find/--offset/--max-chars`; offsets and `nextOffset` are absolute. A cancel queued during retry backoff is applied as `cancel-before-retry` before another provider starts, while steering between attempts is rejected clearly.

## Acceptance

Do not report completion solely from an agent message. Require every write-mode delegation to declare `verify: { command, timeoutSeconds }` with the project's real check command. Treat its real-tree verdict as the verification of record; never substitute a worker's self-reported sandbox green. Inspect changes, verify requested behavior, and identify any checks that could not run. External-agent claims are evidence to validate, not proof.
