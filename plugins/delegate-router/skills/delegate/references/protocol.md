# Supervision Protocol

## Layers

- Codex uses app-server v2 for coding-specific events, interruption, and true `turn/steer`.
- Cursor uses ACP v1 for sessions, structured updates, model/mode configuration, and cancellation.
- The broker uses an A2A-inspired durable job lifecycle and an AG-UI-inspired normalized event stream.
- Claude Code consumes the broker through ordinary MCP tools. MCP Tasks may be negotiated later; the plugin does not require the evolving extension.

## Provider attempt-driver contract

Managed execution selects exactly one lane: `codex-app-server`, `cursor-acp`,
or `cursor-headless`. Each lane implements `start`, `resume`, `prompt`,
`steer`, `cancel`, and `close`. The lifecycle surface standardizes broker
ownership; it does not imply feature parity.

Negotiation returns one entry for each capability:
`sameTurnSteering`, `liveShellStdout`, `midTurnTokenUsage`,
`contextOccupancyUsage`, `planMode`, `mcpInjection`, `worktreeSupport`, and
`startBeforePrompt`. Each entry has `{ supported, mode, evidence }`.
`evidence.source` is `probed` only for a read-only installed-build observation
and otherwise `declared-from-documentation`; unsupported properties remain
first-class entries rather than disappearing.

The scheduler derives separate workflow, budget, checkpoint, and containment
profiles. A workflow requiring an unsupported entry fails before dispatch with
the lane and capability attached to the broker error. Existing decisions now
using that path are plan-first admission, broker-worktree admission,
pre-prompt pause, and same-turn steering. Completion-only accounting is not
accepted as `midTurnTokenUsage`, and ACP context occupancy is not accepted as
billable token usage.

The existing compact `job.capabilities` record is compatibility output and
keeps its prior keys and values. P9 does not add an event, rewrite a record,
change a result shape, or alter retry/fallback ordering. In-flight and
historical jobs therefore stay readable across the extraction.

## Storage

Job snapshots live at `jobs/<id>.json`. Normalized events live at `jobs/<id>.events.jsonl`. Prompts, logs, commands, and state files are created with user-only permissions. Event values are recursively redacted and size-bounded.

P3 fields are additive. Historical records may omit `verificationProfile`,
structured `verification`, append-only `verificationEvidence`, `acceptance`,
and `autoFix`; readers and WorkItem projections preserve that absence without
migration. New write records retain the repository-sourced verification
profile and an acceptance object beside the unchanged lifecycle `status`.
`verification` remains the latest-record compatibility projection. Readers
project a historical standalone `verification` as a one-record evidence chain
without rewriting it.

P5 compiled starts add `workSpec` and `specCompilation` to the job snapshot.
`workSpec` is the validated P1 schema consumed by the WorkItem projection.
`specCompilation` retains the deterministic digest, evidence-source labels,
field-level provenance/confidence, never-infer authority projection, and
confirmation method. These fields exist only on the additional compiler path;
historical and hand-written-packet records omit them. No existing event or MCP
tool schema changes.

New job/attempt records add an immutable launch identity:
`origin: { projectDir, cwd, brokerVersion, launchedAtMs }`. `projectDir` is the
launcher's `CLAUDE_PROJECT_DIR`, with launch cwd as the fallback; `origin.cwd`
is the launcher's cwd and is intentionally distinct from the provider's
`job.cwd`. Resume and review-round attempts inherit the complete parent origin.
Readers accept its absence on historical records.

Schema version 1 of the native work model is available as a compatibility
layer. `delegate-jobs work [--json] [--id <job-or-work-id>]` and the read-only
`delegate_work` MCP tool project the existing job store without reconciling,
repairing, or rewriting it; an unfiltered MCP read defaults to 20 WorkItems and
accepts a limit up to 100. A standalone job projects as one WorkItem, one Run,
and one Attempt. Records connected by observed `parentJobId`/`rootJobId`
project as one WorkItem with ordered Runs, including branches whose review
rounds share a root. Projection IDs are deterministic from that root job ID;
the original job IDs remain the Attempt IDs and remain addressable everywhere.
Facts absent from historical records remain explicit `null`/empty values (with
`scopeClaim: "unfenced"` for a missing scope) rather than being inferred.

Future native WorkItems have a reserved sibling layout at `work/<id>.json`
under the same state directory. That directory is created lazily only by a
WorkItem write. Phase 1 production paths never call those write helpers.
Readers accept positive future schema versions, and read-modify-write must
retain the complete stored object so unknown fields survive older binaries.
Existing `jobs/` records are never migrated into this directory or augmented
with work-model fields.

Terminal jobs older than `DELEGATE_JOB_RETENTION_DAYS` (default 14) are pruned opportunistically at broker start and job launch, at most once per six hours; `delegate-jobs prune` runs it on demand. Active jobs are never pruned.

Every first transition into a terminal status appends one redacted, private JSON line to the separate `audit.jsonl` beside the state file. It records actor, provider/model/mode/effort, resume/group provenance, access policy, cwd, observed change/violation counts, verification, nudges, outcome, usage, and duration. Job pruning never removes this log; `delegate-jobs stats` aggregates it and `delegate-health` reports its path. `delegate-jobs audit backfill` uses the same record builder to append missing retained terminal jobs with `backfilled: true`, once per job ID.

Direct Codex MCP calls and Cursor foreground/background CLI runs enter the same storage pipeline as shadow jobs with `transport: 'direct-mcp'` or `transport: 'direct-cli'`. Raw caller parameters are recursively redacted and bounded; the prompt is a normal `message.user`. Provider notifications are tee'd through the managed event normalizers without changing caller-visible output. Each call owns a distinct running record, PID/heartbeat-compatible liveness fields, terminal sentinel, and audit entry. A Codex reply creates a child shadow with the same thread ID so cumulative thread usage is delta-attributed across the chain. Shadow creation is atomic: any storage failure removes its partial files, logs once to stderr, and leaves the direct provider call on its legacy path.

Claude built-in Agent visibility uses `transport: 'claude-agent'` and
`managedBy: 'delegate-agent-hook'`. PreToolUse/PostToolUse payloads are joined
by `tool_use_id`; the pre hook creates one lightweight running record and
`job.created`. Foreground post results retain their existing terminal
semantics, while a background spawn return stays non-terminal.
`SubagentStart`/`SubagentStop` add `agent_id` lifecycle correlation and the stop
hook records the terminal response. A derivable subagent transcript is retained
only as a pointer and read with the same bounded-tail/redaction discipline as
coordinator Sessions. A non-terminal stub with no transcript growth for the
configured quiet window becomes failed `ended-unknown` at inspection, with a
distinct `AGENT_COMPLETION_UNKNOWN` reason rather than fabricated success.
Recent growth is active, quiet within policy is idle, reconciliation is
idempotent, hook failure is fail-open, and ordinary job retention applies.

External Codex session rows are not job records and never enter the broker store. The scanner reads at most 200 newest files and only bounded metadata/tail windows from the observed `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl` layout. The first `session_meta` payload carries stable `id`/`session_id`, `cwd`, `originator`, and `source`; token-count events near the tail may carry provider totals. Newest files win and repeated rollout files with the same stable identity collapse to one thread. An id recorded as a managed or shadow provider session is excluded. Proven Claude-adjacent originators or app-server/MCP/subagent sources may surface; interactive `codex-tui`/`cli` and unknown provenance are personal-by-default and excluded. All surfaced strings pass the shared redactor, detail reads are bounded, and every mutation rejects as read-only.

Managed attempts normally have `executionOwner: "supervisor"`. The resident is
single-instance per state directory and records a private lock identity
`{pid, bootId, startedAt, brokerVersion, protocolVersion}` plus one durable
lease per attempt `{jobId, attemptId, pid, pgid, bootId, heartbeatAt,
expiresAt}`. Its `0600` Unix-domain socket exposes local request/response
`submit`, `status`, and `drain` only; there is no network listener. On boot it
reconciles only lease files it created: a positively identified live worker is
adopted, a gone worker fails with unavailable-exit-status attribution, and a
live PID that fails identity is terminal `unknown`. Lease-less records,
including every pre-upgrade inline job, are never scanned or reclassified.
Terminal records and audit rows retain exit code, signal, PID/PPID/PGID,
supervisor and lease boot IDs, final heartbeat/expiry, and attachability.

If resident startup or submission fails for any reason, the unchanged
detached-spawn behavior runs and records
`executionOwner: "inline-detached"`. Those inline records retain the legacy
read-time reconciliation: a running job whose worker process no longer exists
becomes failed `ORPHANED`. SessionStart and PostCompact rehydrate bounded
session-owned IDs; `delegate_list` remains the new-session, overflow, and
cross-scope discovery fallback.

Inspect and list rows expose `lastActivityAt` from the last complete non-replay journal line (the ordinary fast path reads only the tail; a replay tail falls back to the newest live event). `stalled=true` means a running job has emitted nothing for more than `DELEGATE_STALL_SECONDS` (default 300); this flag never cancels work.

Every terminal transition also writes the job's `finishedPath` sentinel file (content: the terminal status). Its existence is the durable "job is done" signal for file watchers, which survive host harnesses that reap background waiter processes. Codex jobs that engaged the multi-agent review flow are marked `reviewFlowEngaged: true` (detected from collab-agent items), and `delegate_resume` refuses them fast with `RESUME_UNSUPPORTED`.

`lastSeq` changes for every event. `revision` changes only for lifecycle and control transitions. Read events after the last observed sequence. Send `expectedRevision` with steering and cancellation so concurrent controllers cannot both mutate stale state.

Event reads return `nextSeq`, `latestSeq`, and `hasMore`. Reuse `nextSeq`, including for filtered streams. `waitMs` provides bounded long polling and is capped at 30 seconds.

## Events

Stable types include:

```text
job.created, job.state, job.completed, job.cancelled
provider.initialized, session.created, session.updated, turn.started, turn.completed
message.user, message.delta, message.completed
activity
plan.updated, plan.ambiguity.started, plan.ambiguity.completed
plan.presented, plan.confirmed, plan.declined, plan.degraded
compaction.started, compaction.completed
tool.started, tool.status, tool.output, tool.completed
file.changed, diff.updated
usage.updated, usage.context
approval.requested, approval.resolved
input.requested, input.response.requested, input.resolved, progress.reported
backchannel.unavailable
network.preflight, network.mode-elevated, network.policy.materialized, network.policy.restored
config.updated, mode.updated, model.updated, commands.updated
subagent.started, subagent.progress, subagent.completed, subagent.errored
subagent.activity, artifact.created
correction.requested, correction.applied, correction.queued, correction.restarted
command.applied, command.rejected
scope.violation, ingest.diverged
security.warning, baseline.dirty, budget.exceeded
job.retry, verification.finished
acceptance.decided, autofix.launched, autofix.stopped
error, provider.event, provider.item
```

Independent plan jobs retain `planningFor` as before. Their terminal transition
also updates the parent attempt with additive `planPass` state and the existing
`planning.ambiguity` compatibility view. Readers must tolerate both fields
being absent. The update contains closed status/reason/cost metadata only; it
does not copy the plan packet or provider payload into the parent.

`activity` contains only `{ kind: 'thinking' | 'output', at }`. Codex reasoning items plus Cursor ACP and headless thinking chunks produce transition markers at most once per two seconds; a bounded thought tail exists only in the provider process and is never written to the job record or journal. `provider.event` contains only a redacted event name and safe metadata. The raw transport stream and hidden reasoning remain excluded. An otherwise-unmapped Codex thread item additionally emits `provider.item` with `{ itemType, itemId, phase, item }`; the item is recursively redacted and capped by the ordinary event/string bounds, so the next provider item type remains inspectable without persisting an unbounded raw stream.

Cursor headless assistant chunks obey the provider's dedupe contract: only chunks with `timestamp_ms` and without `model_call_id` become `message.delta`; buffered pre-tool flushes and the timestamp-free final flush are skipped. `result.result` is the authoritative `message.completed`, with a content-free mismatch diagnostic when streamed text differs. Only the final result envelope supplies headless token usage.

Cursor ACP `tool_call_update` without output emits `tool.status`; completion `rawOutput` becomes bounded/redacted `tool.output` plus `tool.completed` with `exitCode`. Nested `{ path, oldText, newText }` diff content becomes `file.changed` and `diff.updated`. `session_info_update`, current mode, available commands, todo updates, nested task activity, and generated images map to the typed events above.

Every `file.changed` change normalizes at the broker boundary to a cwd-relative path and, when derivable, exact `{ added, removed }` line counts. Unified hunks count leading `+`/`-` lines except file headers; Cursor old/new text uses a line edit diff. Unknown counts are omitted rather than represented as zero. `delegate_transcript` admits these events with one compact plain-text `✎ path (+A −R)` line per change (including rename/delete labels), strips full diff/text bodies from that transcript view, and applies the same normalization when reading legacy journals.

During `session/load`, every replay-derived event has top-level `replay: true`. Replay does not update live message/result assembly, activity, notifications, or usage, and repeat loads suppress already-fingerprinted replay updates. Transcript consumers group it under one collapsed restored-history block.

Codex context-compaction item lifecycles additionally emit `compaction.started` and `compaction.completed` with `{ itemId }`; the existing redacted `provider.event` passthrough remains alongside them for raw event fidelity. Transcript readers admit the first-class lifecycle so compacting is visible without exposing compacted context or hidden reasoning.

Managed Codex `subAgentActivity` and `collabAgentToolCall` items, direct Codex `collab_*`/`sub_agent_*` notifications, and Cursor `cursor/task` updates all normalize to `subagent.started`, `subagent.progress`, `subagent.completed`, or `subagent.errored`. Events use the best provider-exposed identity, type, task, status, duration, usage, and output; absent fields stay absent. The broker correlates partial updates and preserves each latest aggregate under `result.subagents[]` rather than concatenating a child response into the parent's `result.text`. Pre-upgrade `provider.event` item stubs normalize only for display and explicitly say their payload was not captured.

## Error Taxonomy

Every broker error has `{ code, retryable, provider }`; `provider` is null/omitted only when no provider is known. Controllers branch on this closed code set, never on message text.

| Retryable | Codes |
| --- | --- |
| `true` | `LOCK_TIMEOUT`, `WRITER_ACTIVE`, `REVISION_CONFLICT`, `ORPHANED`, `PARENT_ACTIVE`, `TIMEOUT`, `RPC_TIMEOUT`, `TRANSPORT_ERROR`, `PROVIDER_ERROR`, `STATE_ERROR` |
| `false` | `INVALID_REQUEST`, `NOT_FOUND`, `QUOTA_GUARD`, `INVALID_MODEL`, `WRONG_LANE`, `RESUME_UNSUPPORTED`, `DIRECT_TRANSPORT`, `ACP_TIER_UNAVAILABLE`, `USER_INPUT_REQUIRED`, `SECRET_IN_PROMPT`, `BUDGET_EXCEEDED`, `LARGE_WRITE`, `PROVIDER_DISABLED`, `PROVIDER_TOO_OLD`, `SESSION_UNAVAILABLE`, `UNMANAGED_JOB`, `JOB_TERMINAL`, `ACCEPTANCE_BLOCKED`, `UNSUPPORTED_STRATEGY`, `INTERNAL` |

`retryable: true` means retrying the same request, possibly after backoff, can succeed. `QUOTA_GUARD` needs a window reset or different provider; `ACP_TIER_UNAVAILABLE` needs a catalog or transport change; `USER_INPUT_REQUIRED` needs new information in a resume; and `BUDGET_EXCEEDED` needs a higher per-job or plan-pass cap. These are distinct edge classes: allowance exhaustion is never described as a configured output budget. `REVISION_CONFLICT` includes `currentRevision`; budget and timeout failures retain partial state for an explicit resume.

`DIRECT_TRANSPORT` means the record is an observability shadow whose original caller owns the provider loop. All mutation controls reject without signalling the provider; read-only inspection, events, transcript, diff, files, usage, and aggregate stats remain available.

Capability refusals retain the existing public error code and message where a
legacy path already had one. The error also carries closed metadata
`{ capability, lane, workflow, capabilityReason }`, so schedulers do not need
to parse prose.

`claude-agent` stubs, external Codex rows, and every federated remote row follow the same read-only control convention. They must never be steered, cancelled, resumed, released, reverted, or used as a route to mutate the source host.

`retryPolicy` is narrower than the taxonomy: only retryable `TRANSPORT_ERROR`, `RPC_TIMEOUT`, or `PROVIDER_ERROR` failures during provider startup/turn execution qualify as `transport`; provider 429/5xx signatures qualify as `rate-limit`. Each retry stays on the same job, reuses a continuation when present, increments `retries`, and emits `job.retry`. The default is no retries. Commands are claimed after backoff and immediately before relaunch: cancel terminals the job without another spawn, and steer is rejected because there is no active attempt.

## Correction Semantics

- Codex `same-turn`: call `turn/steer` using the active thread and expected turn.
- Codex `restart`: interrupt, wait for the turn to settle, then start another turn on the same thread.
- Codex `next-turn`: queue another turn without misrepresenting it as steering.
- Cursor `auto` or `restart`: send `session/cancel`, wait for the prompt response, then prompt the same ACP session.
- Cursor `same-turn`: reject through the attempt-driver requirement
  `sameTurnSteering`; ACP and headless both advertise restart-only behavior.

Every correction supplies a caller-stable `correctionId`; repeating it returns the existing control record. Every result states how it was applied.

Direct-transport shadows support none of these correction or continuation operations. A direct `codex-reply` call is journaled as a new caller-owned child shadow rather than a broker resume.

The separate broker-owned back-channel MCP server is injected into managed
Codex, Cursor ACP, and Cursor headless sessions. It has a hard two-tool
allowlist: blocking `ask_coordinator(question, options?, urgency)` and
non-blocking `report_progress(milestone)`. It has no control-plane dispatcher.
Codex receives it in per-thread `config.mcp_servers`, ACP in
`session/new|load.mcpServers`, and headless Cursor through a private per-job
plugin plus `--approve-mcps`. Injection failure emits
`backchannel.unavailable` and falls back to session establishment without the
server; it never fails the job.

Back-channel and native Cursor questions share one redacted/bounded
`pendingInput`: `{ requestId, kind: "question", question, options, urgency,
context: { stuckOn, diffSoFar, optionsConsidered }, requestedAt, timeoutMs,
expiresAt, defaultAction: "reject" }`. Phase becomes
`user-input-required`; `input.requested` carries that shape, and revisioned MCP
`delegate_respond`, CLI `delegate-jobs respond`, or the TUI `a` action queues
`input.response.requested`. `input.resolved` journals the redacted answer and
optional steer. Structured back-channel responses reject every field except
`answer` and `steer`; the returned tool result explicitly preserves all
original scope, permission, approval, budget, timeout, network, sandbox, and
control constraints.

Question waiting time remains inside the original wall-clock deadline and is
accumulated as `blockedMs` on an existing P2b attempt lease. While phase is
`user-input-required`, derived activity never reports a stall. Expiry always
rejects continuation with `USER_INPUT_REQUIRED`, `defaultAction: reject`, and
`stopReason: input-timeout`; no answer or plan approval is fabricated.
`cursor/update_todos` and `cursor/task` remain non-round-trip progress inputs.

ACP permissions remain deny-by-default. Force-level jobs choose only an advertised `allow_once`; `allow_always` is never selected. Approval events carry normalized tool kind, repo-relative paths under cwd (plus explicit outside paths), domain, command, and `ambiguous: true` for shell-like requests lacking a structured command.

## Attribution

Codex app-server produces provider-level file and aggregated diff events. Cursor ACP reports tool locations when available and the broker records a final Git diff. Job creation captures a content hash of every already-dirty file alongside `baselineFiles`; at completion, pre-existing files whose bytes are unchanged are excluded from the diff, the file inventory, and `changedFiles` — a file the job merely read never appears as work. A pre-existing file the job did modify stays in the diff with `overlapsPreexisting: true`, and its hunks remain mixed (pre-existing plus job changes cannot be separated without a content snapshot), so attribution stays `best-effort` for those files only; `includesPreexistingChanges` on `diff.updated` is now set precisely when such a file contributed content. Files too large to hash (>10 MB) and jobs created before hashing existed fall back to the old include-everything behavior. Worktree-isolated jobs can later report high-confidence ownership without changing this protocol.

`changedFiles` entries are normalized repo-relative and deduped across provider-reported (sometimes absolute) and git-inventory paths. With `allowedPaths` set, out-of-scope entries are recorded as `scopeViolations` (each carrying its `preexisting`/`overlapsPreexisting` flags so concurrent-session noise is distinguishable) and emitted as a `scope.violation` event. `baselineFiles` on the job record is the attribution baseline — files already dirty when the job started — not files the job changed. On write-mode completion the broker records `changedFiles` (count, a 50-path summary, bounded entries, and final content hashes) from its own file-change tracking, so the job record is grounded in observation and safe revert can detect later edits. `driftReport` assembles modified, new, and out-of-scope paths for inspection. `resolvedModel` records the provider-confirmed model when available.

## Completion Semantics

`resultText` normalizes the three provider result shapes (Codex string, Cursor ACP object, Cursor headless CLI envelope) into one always-readable field; provider extras are preserved under `result`. Provider-spawned child work stays distinct in `result.subagents[]` as bounded `{ id, type, task, status, durationMs, output }` entries, with exposed name/usage fields when available. Read-mode jobs whose final message is narration-length are flagged `resultSuspect: 'short-final-message'`; jobs whose preserved subagent output substantially outweighs the parent response use the distinct `subagent-output-dominates-final` code. Opt-in `autoNudge` performs one same-session correction, replaces the result, and preserves `result.firstAttemptText`. `reportSchema` parses only the last fenced JSON object into `result.structured`, surfaces `objectiveMet`, and otherwise sets `structuredMissing`. Cursor sessions that advertise a model only as its fast variant are escaped to the headless transport with the CLI's non-fast id when one exists (`cursor:acp-tier-fallback`), or proceed fast with a `cursor:fast-fallback` event; a session reporting a different model than negotiated raises `cursor:model-mismatch`. Cursor plan-mode plans arrive as ACP `plan` updates, not agent messages: they are journaled as `plan.updated` and folded into the terminal record as `result.plan`, while `result.text` carries only conversational messages.

`completed` retains exactly its provider-lifecycle meaning. Verification
failure/timeout never converts it to `failed`. Write completion separately
records acceptance state: broker `ready-for-review` for clean evidence or
`blocked` with explicit reasons; only `delegate-jobs accept|reject` or
`delegate_decide` records `accepted`/`rejected`. The decision retains the
evidence and digest it was made against and performs no source operation.
Existing consumers may continue branching on `status === "completed"`.
`delegate-jobs wait` keeps exit 5 for zero observed changes and 6 for nonzero
verification.

`delegate-jobs verify` and MCP `delegate_verify` append fresh local evidence
for a verification-blocked managed shared-tree job by executing only its private recorded
recipe. They never open a provider session and expose no command replacement
or acceptance override. Every record retains its own repository revision and
tree digest; acceptance and the outcome ledger select the newest record while
inspect and TUI expose the ordered chain.

## Honest Cursor non-parity

The adapter does not simulate capabilities Cursor lacks:

- no same-turn steering; corrections are cancel-and-resume restarts;
- no live shell stdout (ACP exposes completion `rawOutput` only);
- no mid-turn token usage (headless reports tokens only in the final result; ACP `usage_update {used,size}` is context occupancy);
- no rate-limit or allowance feed (Cursor allowance remains manual dashboard state).

ACP initialize advertises fs read/write and terminal capabilities as false. A versioned no-turn health probe may advertise them experimentally and reports observed client requests, but production flags remain false until an installed release actually routes a request through the client.

Cursor ACP does expose context occupancy through `usage_update`; that is useful
for a context checkpoint but never satisfies an output-token budget. Cursor
headless exposes output-token totals on the terminal result only and no context
occupancy. Both lanes support plan mode, MCP injection, and broker-owned
worktrees on the supported installed builds, but headless still cannot satisfy
pre-prompt pause.

## Response Bounds

Event pages are additionally capped by serialized size (not just event count); a truncated page sets `truncated: "response-size"` and a valid `nextSeq`. Large diffs are windowed: `delegate_diff` accepts `offset`/`maxChars` and returns `totalChars`/`nextOffset`, or `statOnly` for per-file addition/deletion counts. Result text uses the same absolute-offset shape through `delegate_inspect.resultWindow` and `delegate-jobs result`; `find` is case-sensitive and chooses the window start.
