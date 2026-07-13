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
- Cursor write modes use `--auto-review --trust`. Use `--force` only for an explicit `approval=force` override.
- New Codex starts are blocked by a `PreToolUse` quota hook at or above the avoid threshold. Users can deliberately override with `DELEGATE_ALLOW_OVER_LIMIT=codex`.
- Network remains off unless the task needs current external information and the user permits it; the explicit control is `network=true` on `delegate_start` (Codex workspace-write sandbox only).
- `sandbox=off` disables provider sandboxing entirely (Codex `danger-full-access`, Cursor `--sandbox disabled`) for jobs that require host tools: git push, gh/PR flows, package installs, authenticated CLIs, live web. It is a per-job caller judgment — decide from the task packet, surface to the user when unsure, record the choice in the pre-delegation update, and never pair it with `approval=force` without explicit user acceptance. Codex web search turns on automatically when `network=true` or `sandbox=off`.
- Consult, plan, and review modes are read-only.
- Sensitive files are excluded by default. Do not read or transmit `.env*`, `*secret*`, `*credential*`, `*.pem`, or `*.key` without explicit path-level authorization. `allowSensitive=true` relaxes only that rule; the base security packet (scope control, preserve existing changes) is always sent. The base rule explicitly permits running project tooling that consumes secrets internally (builds, tests, dev servers reading `.env`) while forbidding the worker from echoing or relocating their contents — so build-class steps that read environment files work sandboxed, and a worker's claim of a "sanitized workspace" build is a deviation worth flagging.

- `allowedPaths` on write modes declares the job's file fence: injected into the worker prompt and enforced post-hoc as `scopeViolations` + a `scope.violation` event. Prefer it over prose-only fencing for every bounded write job.
- Out-of-tree deliverables (a file outside the job cwd): Cursor workers cannot write outside the workspace. Stage a copy inside the repo (e.g. `.delegate-staging/<name>`), add that path to `allowedPaths`, and copy back after verifying the diff touched nothing else. An `ingestFiles` option is on the roadmap.
- Cursor read-only modes block the shell entirely, including read-only git commands; a review task that needs `git log`/`git show` history should run on Codex (its read-only sandbox permits read-only shell) or accept the limitation.

## Writer Ownership

Allow only one writer for a path set. A read-only reviewer may inspect a stable diff, but do not ask it to review files while another agent is actively changing them. The coordinator owns final integration.

The broker enforces this for managed jobs: a write-mode start (`implement` or `verify`) in a cwd that already has an active write-mode job fails with `WRITER_ACTIVE` and the blocking job's ID. Orphaned writers (dead worker process) are reconciled to `failed` automatically and stop blocking. Worktree-isolated jobs are exempt. `overrideWriter=true` bypasses the guard; use it only with explicit user acceptance of concurrent writers.

Every writer must:

- Preserve user changes and unrelated dirty files.
- Avoid destructive Git commands.
- Stay inside allowed scope.
- Stop if the scope or acceptance criteria conflict.
- Report exact changed files and verification performed.

## Continuations

Store the Codex `threadId` or Cursor chat ID with the task. Resume only for the same objective. A follow-up should include new information, a correction, or a verification request rather than repeating the original prompt. Codex threads that engaged the multi-agent review flow (typically write-mode jobs whose approvals escalated) may refuse direct resume with `RESUME_UNSUPPORTED`; recover by starting a fresh job whose task packet folds in the prior findings.

Managed control commands use optimistic concurrency. Read the current job revision immediately before steering or cancelling and send it as `expectedRevision`. A `REVISION_CONFLICT` includes `currentRevision`, so one retry with that value is enough when your command is still appropriate; never overwrite another controller's newer decision. Reuse the same `correctionId` when retrying the same request.

A steer that reduces the remaining work can finish the job before any follow-up command arrives. Do not design a steer-then-cancel sequence around a shrinking task; cancel first if termination is the goal.

- Codex can accept a genuine same-turn correction through app-server `turn/steer`.
- Cursor ACP v1 cannot. Its correction path cancels the prompt and resumes the same session, and must be reported as a restart.

For managed runs, store the job ID and use the `delegate_control` inspection and control tools. Direct Cursor jobs remain available through `delegate-jobs`; official Codex plugin jobs retain their own lifecycle commands. Never describe a foreground MCP call or an external-plugin job as a managed control-plane job.

## Timeouts

Managed jobs are bounded by `timeoutSeconds` (60–86400) or, when unset, `DELEGATE_CODEX_TIMEOUT_SECONDS` / `DELEGATE_CURSOR_TIMEOUT_SECONDS` (default 3600). Defaults are deliberately long — LLM agent jobs legitimately run long — so set an explicit value only when the task warrants a tighter or looser bound. A timeout interrupts the active turn and fails the job with a `TIMEOUT:` error; the thread remains resumable.

## Failure And Quota Recovery

On timeout, quota exhaustion, or agent failure:

1. Stop the failed process; do not start a competing writer while it may still run.
2. Inspect the actual diff and process state.
3. Record the failure and provider usage state.
4. Build a recovery packet with completed work, partial changes, failed verification, continuation ID, and remaining acceptance criteria.
5. Select the best eligible fallback from the routing matrix.
6. Tell the fallback it owns an existing partial diff and must not revert unrelated changes.

## Acceptance

Do not report completion solely from an agent message. Inspect changes, verify requested behavior, and identify any checks that could not run. External-agent claims are evidence to validate, not proof.
