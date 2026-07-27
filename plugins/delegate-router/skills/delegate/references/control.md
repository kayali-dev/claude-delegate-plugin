# Delegation Control Protocol

## Before Starting

1. Inspect the current worktree and identify pre-existing changes.
2. Define an explicit allowed path scope and non-goals.
3. Select read-only or write access deliberately.
4. Specify acceptance criteria; inspect the derived verification profile or provide an explicit command/recorded exception.
5. Record the provider, model, mode, and start.

Use `delegate-cursor --dry-run ...` when an explicit user constraint, unfamiliar machine, or sensitive workspace makes the resolved command worth inspecting first.

When only intent or repository evidence exists, compile before starting:

```bash
delegate-jobs spec \
  --intent 'Implement the bounded change' \
  --from-diff \
  --allowed-paths bin/lib/example.mjs,test/example.test.mjs \
  --acceptance 'The requested behavior is covered by focused tests.' \
  --timeout-seconds 900 \
  --max-rounds 2 \
  --max-output-tokens 4000
```

The compiler also accepts `--failure-output`, `--todo path[:line]`,
`--task-record path`, and `--from-conventions`. It reads the P3 verification
profile for a real repository recipe and renders one provenance/confidence
card. Missing or low-confidence WorkSpec fields remain unresolved. A write
start requires explicit `--allowed-paths`; inferred scope is a claim, not a
grant.

Using the same intent flags with `delegate-jobs start` enters the existing
managed start and plan-first path only after card confirmation. Interactive
confirmation is the default. Automation must pass `--accept-spec` explicitly;
the flag cannot resolve an incomplete draft. No intent compilation path
infers network, sandbox-off, privilege, scope widening, or a budget increase.
Hand-written `--prompt` packets keep the previous behavior.

## Access Policies

- Codex uses `approval_policy=on-request` with `approvals_reviewer=auto_review`. This is Approve-for-me: Auto-review evaluates escalations rather than bypassing the sandbox.
- Cursor write modes use `--auto-review --trust`. `approval=force` selects only ACP `allow_once`, never `allow_always` (which would contaminate global Cursor configuration). `network=true` with `sandbox=off` is also a force-level grant because Cursor requires `--force` for WebFetch and equivalent ACP permission handling; obtain the same explicit authorization as any sandbox-off force run.
- New Codex starts are blocked by a `PreToolUse` quota hook at or above the avoid threshold. Users can deliberately override with `DELEGATE_ALLOW_OVER_LIMIT=codex`.
- Network remains off unless the task needs current external information and the user permits it; the explicit control is `network=true` on `delegate_start` for both providers. Every Cursor launch emits `network.preflight` with the requested/effective mode, sandbox state, `sandbox.networkAccess`, temporary sandbox policy, force state, expected egress, and the separate WebFetch gate.
- `sandbox=off` disables provider sandboxing entirely (Codex `danger-full-access`, Cursor `--sandbox disabled`) for jobs that require host tools: git push, gh/PR flows, package installs, authenticated CLIs, live web. It is a per-job caller judgment — decide from the task packet, surface to the user when unsure, record the choice in the pre-delegation update, and never pair it with `approval=force` without explicit user acceptance. Codex web search turns on automatically when `network=true` or `sandbox=off`.
- Consult, plan, and review modes are read-only. Cursor ask/plan modes categorically reject network tools, so a read-only Cursor job with `network=true` is launched in agent mode with a strict injected no-write/no-destructive-command preamble and a loud `network.mode-elevated` event. This changes the provider mode, never the job's read-only contract.
- Sensitive files are excluded by default. Do not read or transmit `.env*`, `*secret*`, `*credential*`, `*.pem`, or `*.key` without explicit path-level authorization. Outbound task packets are scanned for credential-shaped values and fail with `SECRET_IN_PROMPT`; `allowSensitive=true` explicitly overrides both checks and emits `security.warning`. It never removes scope control or the preserve-existing-changes rule. Project tooling may consume secrets internally, but workers must never echo or relocate their contents.

- `allowedPaths` on write modes declares the job's file fence: injected into the worker prompt and enforced post-hoc as `scopeViolations` + a `scope.violation` event. In interactive Claude Code, those roots and already-observed attempt changes also feed the bounded live collision watch described under Writer Ownership. Prefer `allowedPaths` over prose-only fencing for every bounded write job.
- Broker worktree isolation is explicit and never inferred. Set
  `isolation: "worktree"` plus `pathClaims[]` on MCP, or
  `--isolation worktree --path-claims a,b` on CLI. `allowedPaths` remains the
  write fence; concrete `pathClaims` must cover it and exist only to schedule
  writers. Optional `resourceClaims[]` / `--resource-claims id,id` serialize
  exact non-file resources. Claims schedule; isolation contains. Neither is a
  substitute for the other.
- `ingestFiles` accepts up to 20 absolute regular files outside cwd, each smaller than 10 MB. The broker copies them into `.delegate-staging/<jobId>`, records the source-content hash, and adds that directory when `allowedPaths` is set. Byte-changed staged content copies back only after `completed`; a concurrently changed source is preserved and the staged version is written to `<source>.delegate-new` with `ingest.diverged`. Failures leave staging referenced by the checkpoint. Sensitive names still require `allowSensitive=true`.
- Cursor headless consult/plan/review runs use streaming NDJSON under `--mode ask|plan`; thinking, assistant, and structured tool events remain visible. Networked read-only work is the explicit agent-mode elevation above. With sandboxing enabled, `networkAllow` materializes a merged temporary `.cursor/sandbox.json` (`default: deny` plus the supplied domains; omitted means `default: allow`) and restores the exact prior file on every exit path. Existing denies win and conflicting requests fail before launch. Project `.cursor/cli.json` supports only `permissions.allow/deny`; malformed or wrong-schema files fail as `CURSOR_PROJECT_CONFIG_INVALID` health detail and an actionable preflight error naming the file.

Advanced Cursor-only start/resume options are `addDirs[]` (`--add-dir`), `approveMcps` (`--approve-mcps`), `cursorWorktree` (`--worktree`), and `cursorWorktreeBase` (`--worktree-base`). CLI spellings are `--add-dir` (repeatable), `--approve-mcps`, `--cursor-worktree`, and `--cursor-worktree-base`.

Broker isolation is distinct from Cursor's native worktree flags and refuses
that combination. The contained first cut also refuses sandbox-off,
`addDirs`, `ingestFiles`, auto-fix/continuation rounds, subdirectory roots,
submodules, bare/non-Git repositories, unsafe state placement, missing
immutable `HEAD`, bounded Git-inspection overflow, and worktree creation
failure. Repository-local clean/smudge filters are also refused; broker Git
commands disable hooks, fsmonitor hooks, and global/system configuration. It
supports dirty owners, detached owners, and owners that are
existing linked worktrees. Dirty content is never copied into the attempt:
the workspace starts at committed `HEAD`, records owner dirty paths as
evidence, and later requires exact target CAS.

`delegate_transcript` includes compact `file.changed` entries: one cwd-relative `✎ path (+A −R)` line for each change, with rename/delete labels and counts only when the journal's unified hunk or old/new text can establish them. It never returns the full diff or old/new file bodies through that transcript surface; use `delegate_diff` for hunks.

Provider-spawned agents are ordinary inspection data, not provider noise. `delegate_transcript` admits their start/progress/terminal lifecycle as provider-neutral plain-text lines. `delegate_inspect` and `delegate-jobs result` retain bounded child results under `result.subagents[]`; read those entries separately from `result.text`, because the latter remains the parent's own final message. A `subagent-output-dominates-final` suspicion means the child output is materially larger than that parent response and deserves direct review.

## Writer Ownership

Allow only one writer for a path set. A read-only reviewer may inspect a stable diff, but do not ask it to review files while another agent is actively changing them. The coordinator owns final integration.

The broker enforces this for managed jobs. Shared write-mode starts retain the
conservative whole-cwd `WRITER_ACTIVE` guard. Workspace-isolated starts
schedule against concrete path-prefix overlap within one owner repository and
exact resource IDs across repositories; conflicts return `CLAIM_CONFLICT`.
An active shared writer owns the whole repository for this admission check.
Orphaned writers are reconciled before scheduling. `overrideWriter=true`
remains a shared-tree escape hatch and is rejected for workspace claims.

This guard still cannot contain unmanaged editors, including the current
coordinator or a built-in subagent. Interactive sessions add early detection:
SessionStart watches live attempts' owned roots, FileChanged observes external
touches, and fail-open PostToolUse(Edit|Write)/PostToolBatch hooks observe
coordinator edits. A collision records one edge per attempt/path through the
ordinary monitor pipeline and marks covering verification evidence
`state: "stale"`, `inputChanged: true`, with `base-drift` blocking undecided
acceptance. Attempt metadata fingerprints suppress its own watcher events.
Because FileChanged carries no writer identity, a first event without provider
attribution does not guess; Claude-session writes are still observed by the
Edit/Write hooks, with post-hoc checks as the fallback.

The dynamic set is capped at 256 absolute paths including one private refresh
signal. The first 255 deterministic owned roots are armed. Roots past that cap
record `collisionWatch.reason: "watch-path-cap-exceeded"` on affected attempts;
watcher failures record their reason. Both cases retain coordinator Edit/Write
observation and the existing post-hoc scope/drift checks. Hooks always exit zero
and run only after a tool/file change; they never gate or block that change.

For shared-tree attempts this is detection, not containment: it does not
prevent, isolate, or roll back a write. Only an explicit broker-owned P6
workspace records `containment: "broker-workspace"`. Direct Codex
MCP and Cursor CLI launches remain behavior-compatible and are never blocked by
the managed writer guard. Their shadow record instead sets
`overlapsManagedWriter: true` and emits `DIRECT_WRITER_OVERLAP` as a warning
when a write-capable direct call shares a cwd with an active managed writer. A
write job launched from a non-empty Git baseline emits `baseline.dirty` with a
bounded path list; treat either signal as a coordination warning, not proof that
no other editor is active.

Give any start that may be retried a stable `idempotencyKey`. Lookup and job creation are atomic under the per-cwd launch lock, so a replay returns the existing job instead of launching a second worker.

An opt-in `retryPolicy` may set `maxAttempts` from 1–5 and choose `transport` and/or `rate-limit`. Retries reuse the same job and provider session when one exists, are journaled as `job.retry`, and never apply to scope, quota, model, budget, user-input, or other task-level outcomes. The default is one attempt.

Tag independent fan-out jobs with one `groupId`; `delegate_list` can filter or summarize the group. Shared grouped writers retain the same-cwd guard. Isolated grouped writers may run concurrently only when their path and resource claims do not overlap.

## Workspace Change Sets And Integration

An isolated terminal attempt stages only its broker-owned workspace index and
emits a private full-index binary Git patch plus a manifest of immutable-base
and result object IDs/modes. It then removes the validated state-directory
worktree. Removal never targets a caller-supplied path and never invokes the
legacy shared-tree revert machinery.

Use `delegate_integrate { jobIds }` or
`delegate-jobs integrate <job-id> [job-id ...]`. `preflight=true` /
`--preflight` performs only the compare step. CAS compares current owner bytes
and executable/symlink mode for every target with that change set's immutable
base. Any moved, added, deleted, unreadable, or same-path-multi-change-set
target is returned as a conflict before an integration worktree is created.
Clean change sets are applied in order to a detached integration worktree from
current `HEAD`, with no `--3way`; the first apply conflict discards that
integration workspace and stops.

The resulting integration record and patch are reviewable broker artifacts;
`ownerApplied` remains false. This phase deliberately does not copy multiple
paths into the owner's working tree because Git/filesystem operations cannot
atomically compare and replace them against unmanaged editors. Consequently a
workspace `delegate_decide accepted` returns `CAS_CONFLICT` when targets moved
or `WORKSPACE_APPLY_DEFERRED` after clean preflight, without recording
acceptance or touching owner bytes. Rejection and
`delegate_workspace_discard` / `delegate-jobs workspace discard` remove only
broker workspace storage. `delegate-jobs revert` continues unchanged for
legacy shared-tree jobs and refuses workspace jobs.

No `WorktreeCreate` hook is globally registered. The explicit broker launch
option is the owner-approved workflow boundary, so ordinary Claude Code and
Git worktree creation retain their default behavior.

Every writer must:

- Preserve user changes and unrelated dirty files.
- Avoid destructive Git commands.
- Stay inside allowed scope.
- Stop if the scope or acceptance criteria conflict.
- Report exact changed files and verification performed.

## Continuations

Store the Codex `threadId` or Cursor chat ID with the task. Resume only for the same objective. A follow-up should include new information, a correction, or a verification request rather than repeating the original prompt. Codex threads that engaged the multi-agent review flow (typically write-mode jobs whose approvals escalated) may refuse direct resume with `RESUME_UNSUPPORTED`; recover by starting a fresh job whose task packet folds in the prior findings.

Workspace-isolated attempts are also intentionally single-attempt in this
phase. Resume, review-round, and auto-fix continuation return
`RESUME_UNSUPPORTED`; start a fresh isolated attempt from a newly inspected
immutable base.

Managed control commands use optimistic concurrency. Read the current job revision immediately before steering or cancelling and send it as `expectedRevision`. A `REVISION_CONFLICT` includes `currentRevision`, so one retry with that value is enough when your command is still appropriate; never overwrite another controller's newer decision. Reuse the same `correctionId` when retrying the same request.

`startPaused=true` opens the provider thread/session and sets phase `paused` before any prompt. Release it with `delegate_release` (or `delegate-jobs release`) at the current revision; cancellation works while paused, `waitFor='session'` (and the `waitForSession` alias) returns as soon as the paused session exists, and `timeoutSeconds` continues counting during the pause. `waitFor='turn'` and `waitFor='first-output'` use the same bounded journal-cursor poller.

Write launches are plan-first by default. The broker runs a bounded read-only
plan turn, presents its structural blast radius and observed-band estimates,
then waits for the coordinator to confirm or decline. Confirmation continues
the same provider thread/session into write mode. Use
`delegate_start_trivial` or `delegate-jobs start --no-plan-first` only for an
explicitly trivial change; `--no-ambiguity-check` skips only the independent
comparison pass. A missing plan capability or comparison candidate degrades to
the legacy explicitly requested launch and records why; no plan pass may
accept itself or start write work.

When enabled, ambiguity detection sends the same WorkSpec to an independent
cheap plan pass using a different provider or model. It compares only parsed
target files, components, ordered approach shape, and declared assumptions.
Material divergence becomes a revisioned coordinator question before write
work. Convergence proceeds after the ordinary plan confirmation. Invalid or
unavailable structural evidence is reported as inconclusive and never
converted into a guessed ambiguity verdict.

A steer that reduces the remaining work can finish the job before any follow-up command arrives. Do not design a steer-then-cancel sequence around a shrinking task; cancel first if termination is the goal.

- Codex can accept a genuine same-turn correction through app-server `turn/steer`.
- Cursor ACP v1 cannot. Its correction path cancels the prompt and resumes the same session, and must be reported as a restart.

Cursor `cursor/ask_question` and `cursor/create_plan` requests are blocking control-inbox items, not provider noise. The job stays running in phase `user-input-required`, persists the redacted request under `pendingInput`, and emits `input.requested`. Inspect the latest revision, then use MCP `delegate_respond` or `delegate-jobs respond <id> --expected-revision N --request-id ... --answer ...` (with `--accept`/`--reject` for plans); retry the same response with the same `commandId`. No answer or plan approval is fabricated. `DELEGATE_CURSOR_INPUT_TIMEOUT_SECONDS` (default 300) bounds the wait; expiry rejects the provider request and fails with `stopReason: input-timeout`.

Managed sessions also receive the separate `delegate-backchannel-mcp`.
Codex and Cursor headless use it for the free-form question path that ACP
already provides; all three transports render the same `pendingInput`
question/options/urgency/context/default shape. `ask_coordinator` blocks and
`report_progress` does not. Press `a` in TUI detail or use the same revisioned
`delegate_respond`/`delegate-jobs respond` flow. To attach an in-contract steer,
use `--response-json '{"answer":"...","steer":"..."}'`.

The back-channel is data, never authority. Its server exposes only those two
tools and rejects extra arguments. Responses accept only `answer` plus optional
`steer`; neither may widen scope/allowed paths, grant permission or approval,
raise a budget/timeout, enable network, disable sandboxing, self-approve, or
invoke cancellation, steering, or resume. The original job contract always
wins. Both directions pass through the ordinary redactor and size caps.
`DELEGATE_BACKCHANNEL_INPUT_TIMEOUT_SECONDS` defaults to 300; expiry rejects
continuation, records `stopReason: input-timeout`, and never invents a default
answer. Waiting remains inside the job's original wall-clock deadline, is
attributed on its attempt lease, and does not count as a stall.

`delegate_interrogate` / `delegate-jobs interrogate` asks a running managed
worker one read-only question. The strict command accepts only the expected
revision, request identity, and question; the work item must already have a
bounded output-token budget. Codex uses a no-action `turn/steer` frame; Cursor
queues a separate plan-mode turn on the same session after the current prompt
and is explicitly not same-turn steering. The reply is appended to `findings`
as evidence with its provider, session, request ID, and observed token cost.
That cost consumes the original work-item budget. The answer can explain
evidence but cannot authorize, approve, steer, widen scope, alter privileges,
or increase any budget.

For managed runs, store the job ID and use the `delegate_control` inspection and control tools. Direct Codex MCP calls and Cursor foreground/background CLI runs create observable shadow jobs (`direct-mcp` and `direct-cli`) in the same store, event journal, transcript, diff/files, usage, audit/stats, orphan-reconciliation, and terminal-sentinel pipeline. They remain unmanaged provider loops: steer, cancel, release, respond, resume, review round, and revert return `DIRECT_TRANSPORT`, while inspect, list, events, transcript, diff, files, and usage stay available. Official Codex plugin jobs retain their own independent lifecycle commands. Never describe a direct or external-plugin job as a managed control-plane job.

Managed launch ownership normally belongs to the resident
`delegate-supervisor`, not the MCP/CLI session. Its private Unix-domain socket
accepts only local `submit`, `status`, and `drain` requests; attempt leases and
heartbeats make restarts inspectable and allow a new compatible resident to
monitor an already-running leased worker. `SIGHUP` persists and continues,
`SIGTERM`/`SIGINT` stop admission and drain, and
`DELEGATE_SUPERVISOR_IDLE_MS` controls the lease-free idle exit (default 30
minutes). `delegate-supervisor start|status|drain` is also available directly.
If the resident is disabled, unavailable, unresponsive, or incompatible while
holding leases, launch falls back to the historical detached worker and records
`executionOwner: "inline-detached"`; this condition never fails a job start.
Lease-less jobs from an older broker are deliberately outside resident
reconciliation.

Built-in Claude `Agent` and legacy `Task` tool calls are observability-only too.
Plugin PreToolUse/PostToolUse hooks still create and correlate a
`claude-agent` stub by `tool_use_id`; additive `SubagentStart`/`SubagentStop`
hooks attach and finish it by `agent_id`. Model, agent type, cwd, prompt summary,
and terminal response are redacted and bounded. When available, the stub retains
a pointer to the coordinator session's `subagents/agent-*.jsonl` file for
bounded read-only TUI tailing. Because a session crash can omit every stop
signal, inspection also reconciles a non-terminal stub whose transcript has
been quiet past `DELEGATE_AGENT_STUB_QUIET_SECONDS` (default 1800) to failed
`agentLifecycle: "ended-unknown"` with an explicit no-completion-signal reason.
Recent transcript growth renders active; quiet within the window renders idle.
No success is inferred. Every hook exits zero, performs no network access, and
swallows store errors after one stderr diagnostic so visibility can never block
the Agent call. `DELEGATE_AGENT_STUBS=0` disables the hooks. These records reject
all control mutations and obey `DELEGATE_JOB_RETENTION_DAYS` pruning.

## Native Session Surfaces

`delegate-config statusline enable` is the opt-in native work row. It saves the
entire prior `statusLine` object, prefixes a compact Delegate Router chip, then
runs the original command with its unchanged stdin and shell semantics. It
sets `refreshInterval: 5`, or preserves a faster existing interval, because
event-driven refresh can be silent while the coordinator waits; Claude Code
still applies its documented 300 ms debounce. Disable with
`delegate-config statusline disable`, or retain official usage capture while
hiding only the chip with `DELEGATE_NATIVE_STATUSLINE=0`.

SessionStart injects `additionalContext` beside the existing collision
`watchPaths`; PostCompact injects the byte-identical work projection again.
It is session-scoped by default and contains only safe attempt/root IDs,
provider/lifecycle tokens, closed blocker codes, counts, and allowance state.
It never reads prompts, results, diffs, repository paths, secrets, pending
questions, or free-form errors. The payload is hard-capped at 2,048 UTF-8
bytes. When entries exceed the item/byte bounds, policy breach, human input,
acceptance-ready work, and resumable failure win over lower-priority/older
state; an omitted count points to `delegate_list`. Set
`DELEGATE_NATIVE_CONTEXT=0` to suppress injection without disabling P2.5
watch arming.

The control MCP advertises read-only `delegate://work/active` and
`delegate://repo/profile` resources, a bounded
`delegate://job/{id}/diff` template, and the
`delegate_start_scoped_review` / `delegate_resume_with_findings` prompts.
Clients that do not implement resources or prompts ignore these capabilities
and keep the exact existing tool surface. `DELEGATE_NATIVE_MCP=0` hides the
additive capabilities only.

Status-line enable also appends one linear `footerLinksRegexes` entry for
managed/direct job IDs. It points at the private job record through an allowed
editor deep-link scheme and never replaces existing footer rules. The default
is `vscode`; set `DELEGATE_NATIVE_FOOTER_SCHEME=cursor` before enabling when
appropriate. `delegate-config footer-links disable` removes only the rule this
plugin added; `DELEGATE_NATIVE_FOOTER_LINKS=0` skips its installation.

All native surfaces are accelerators. A missing status line, unavailable
hooks, a client without MCP resources, or a disabled monitor changes no CLI,
MCP tool, TUI, `finishedPath`, or inspection/control pull behavior.

## Ambient Push Bridge

Interactive Claude Code sessions with the experimental Monitor surface
automatically start `delegate-monitor`. It reads bounded job records and
journal tails and pushes only actionable edge transitions, in this order:
policy breach (scope or budget/allowance), human input or blocked permission,
ready for review, terminal failure, and stalled running work. It never emits
progress, deltas, tool activity, usage ticks, or successful intermediate steps.
Every line is compact, redacted, and carries the job id plus the launch
workspace basename; inspect that job and its immutable `origin.sessionId`,
`origin.workspaceId`, and `origin.projectDir` before acting.
The origin is captured from `CLAUDE_PROJECT_DIR` at launch (falling back to the
launching process cwd). `workspaceId` resolves the actual worktree/project
identity through realpath, while `sessionId` comes from the launching Claude
MCP process and is `null` for a CLI launch outside Claude. Origin remains
distinct from delegated `job.cwd` and is inherited unchanged by resume,
review-round, and automatic continuation children.

The monitor is read-only with respect to jobs and control. The separate
collision hook may add `collision.detected`/staleness evidence, after which the
monitor only reads that edge. The monitor cannot start,
steer, cancel, respond to, reconcile, or otherwise mutate a job, and it cannot
invoke a provider or spend allowance. Its only write is private
`0600` session-correlation metadata under `<state-dir>/monitor-correlation/`.
Per-job edge deduplication (including exact collision paths), a 30-second
cooldown, and a six-lines-per-minute global ceiling enforce the nagware
boundary. The stall threshold defaults to
ten minutes; configure
`DELEGATE_MONITOR_STALL_SECONDS`,
`DELEGATE_MONITOR_COOLDOWN_SECONDS`, and
`DELEGATE_MONITOR_MAX_LINES_PER_MINUTE` only when the local policy requires it.
The priority remains policy breach → human input → acceptance ready → failure.
Do not emit after every edit or command, repeat a suggestion within one logical
task, announce successful intermediate activity, or treat provider completion
alone as a demand for review. Non-actionable state belongs in the native
status-line chip.

Push defaults to `DELEGATE_MONITOR_SCOPE=session`: only records whose
`origin.sessionId` matches the SessionStart correlation marker can emit.
The private marker lasts 72 hours and records the coordinator plus a bounded
ancestor chain as `(pid, process start time)` pairs. At boot the monitor walks
its own parent chain, selects the marker with the nearest common identity, and
uses the newest marker only when one session has duplicates. Equally specific
distinct sessions are ambiguous. PID reuse, missing process start times, dead
coordinators, absent matches, and conflicting markers cause no guess. The
monitor persists `effectiveScope: "workspace"` plus the reason and emits one
workspace-labeled degradation line before falling back. Each run prunes a
bounded set of expired markers, dead-coordinator markers, old resolution
records, and obsolete request/response handshake debris.

Set scope to `workspace` to include every record whose realpath-normalized
`origin.workspaceId` (or legacy `origin.projectDir`) equals the current
worktree/project. The former `project` value remains an alias. Set `all` only
in a deliberate fleet-overview session; origin-less lines are then explicitly
labeled `legacy@<cwd-basename>`. Origin-less records are silent under both
session and workspace scopes. Set `off` to emit nothing. These scopes never
gate control: `delegate_list`, `delegate_inspect`, the TUI, resume, steer,
cancel, respond, and every other pull/control path continue to cover the full
store.

Set `DELEGATE_MONITOR=0` before starting Claude Code to disable the push bridge.
To snooze non-breach edges, place a future ISO timestamp or epoch in
`{"snoozeUntil":"2026-07-26T15:00:00Z"}` at
`<state-dir>/monitor.json` (the directory containing `DELEGATE_STATE_FILE`, or
the ordinary Delegate Router state directory). Policy breaches bypass snooze.

Plugin monitors are experimental, interactive-session-only, and absent when
Claude Code's Monitor tool is unavailable, including Bedrock, Vertex, Foundry,
and configurations with `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. In every such case the ordinary
pull path is identical: use `delegate_inspect`, the TUI, or a manual
Monitor-tool until-loop over `finishedPath`. Ambient push is an accelerator,
never a completion or acceptance dependency.

## Idempotency

`idempotencyKey` guards against double-launching the same request (orchestrator restart, lost acknowledgement): a replayed start with the same key and cwd returns the existing job. It deliberately replays terminal jobs too, including ones whose objective failed — the caller must see the failed job, not silently relaunch it. When you intend a changed retry (new packet line, folded-in findings, different scope), that is a new request: use a new key.

## Timeouts

Managed jobs are bounded by `timeoutSeconds` (60–86400) or, when unset, `DELEGATE_CODEX_TIMEOUT_SECONDS` / `DELEGATE_CURSOR_TIMEOUT_SECONDS` (default 3600). Defaults are deliberately long — LLM agent jobs legitimately run long — so set an explicit value only when the task warrants a tighter or looser bound. A timeout interrupts the active turn and fails the job with a `TIMEOUT:` error; the thread remains resumable.

Codex interruption waits up to `DELEGATE_DRAIN_GRACE_MS` (default 3000, maximum 15000) for the turn to settle before the provider process is killed. Every terminal failure or cancellation records a `checkpoint` containing `failureReason`, `continuationId`, `lastDiffEventSeq`, and an actionable `resumeHint`.

`maxOutputTokens` is an optional per-job cap on provider-reported output tokens. Crossing it uses the normal provider-aware cancel path and fails with `stoppedReason: "budget"` plus `BUDGET_EXCEEDED`; partial events, diff, and continuation remain inspectable. Resumes accept a new cap and otherwise inherit the parent cap.

`DELEGATE_MAX_CHANGED_FILES` defaults to 200. Codex live `fileChange` paths crossing it interrupt and fail with non-retryable `LARGE_WRITE` plus a checkpoint. Cursor exposes only completion inventory, so its record is flagged `largeWrite: true` and evented `large.write` post-hoc; that asymmetry cannot prevent Cursor's writes.

Every write mode gets broker verification by default. Precedence is: nearest
`CLAUDE.md`, then nearest `AGENTS.md`, with non-mutating commands from Commands,
Quality, Development Workflow, Verification, Tests, or Testing sections;
package manifests are the fallback, preferring `check`, then `checks`, then
`test` + `lint` + `typecheck`, using the declared/detected bun, pnpm, yarn, or
npm runner. The profile is cached per repository under the state directory and
records the source path, sections/scripts, package manager, and cache state.
Only commands actually present in those sources qualify.

Explicit `verify: { command, timeoutSeconds }` (default 600 seconds) always
wins. If no reliable non-mutating check exists, record
`verify: { exception: "<reason>" }`; `DELEGATE_VERIFY=off` disables broker
verification globally. These are documented escape hatches, not silent
absence: inspect records `exception`, `no-recipe`, or `skipped` with a reason.
After provider success and nonzero observed changes, the broker runs the recipe
on the real repository tree with one overall timeout and a bounded redacted
tail. It fingerprints the repository revision and worktree metadata before and
after; movement makes the evidence stale and blocks acceptance. Zero-change
jobs never run verification. A nonzero verdict or timeout does not rewrite the
provider outcome: status remains `completed`, while `delegate-jobs wait` keeps
its existing exit 6 behavior for a nonzero verification exit.

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

Do not report completion solely from an agent message. `status` retains its
provider-lifecycle meaning. Write-mode completion adds
`acceptance: { state, blockedBy, evidence, decidedBy, decidedAt }`:
`ready-for-review` when the mechanical evidence is clean, or `blocked` for
verification failure/timeout, zero changes, scope violation, unresolved
structured findings, or base/input drift. A live collision adds its path to
`baseDriftPaths`; verification evidence that predates the touch is marked
`stale` with `inputChanged: true`. No broker path auto-accepts.

After reviewing the diff and evidence, record the owner decision with
`delegate-jobs accept|reject <id> [--reason ...]` or additive MCP
`delegate_decide`. Acceptance is refused while blockers remain. Both commands
bind the decision to an evidence digest and only update the record; they never
apply, commit, revert, or otherwise mutate source.

Each explicit decision also appends a full redacted outcome-audit revision.
Ledger readers select the newest revision for that job, so the durable owner
label survives job pruning without double-counting the attempt or its
thread-cumulative usage. Rejection reasons are bounded and pass through the
same credential redactor as prompts, events, and terminal failures.

Use `delegate-jobs stats --since <duration|ISO-date|broker-version>
[--until <ISO-date>]` or `delegate_stats` to inspect provider completion,
real-tree verification pass, and explicit owner acceptance separately. Every
measurement includes its numerator, sample size, and minimum sample; fewer than
10 labels is `insufficient-data`, never a numeric rate. Broker-version and
UTC-day cohorts retain an explicit ORPHANED count. An optional
`--recommend-for <mode>` / `recommendFor` request requires 20 owner labels per
provider and non-overlapping fixed 95% Wilson intervals before it returns an
advisory provider; sparse or overlapping evidence declines. This advisory
shape is read-only and does not feed or modify the static router.

`autoFix: { maxRounds }` / `--auto-fix-rounds` is off by default and hard-capped
at three. A continuation is permitted only for deterministic verification or
scope evidence with unchanged scope/privileges, remaining time/output budget,
and a lower failure or scope-violation count. Ambiguity, semantic findings,
timeout, drift, no progress, exhausted budget, or the cap stops the loop and
records why.
