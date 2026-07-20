# Supervision Protocol

## Layers

- Codex uses app-server v2 for coding-specific events, interruption, and true `turn/steer`.
- Cursor uses ACP v1 for sessions, structured updates, model/mode configuration, and cancellation.
- The broker uses an A2A-inspired durable job lifecycle and an AG-UI-inspired normalized event stream.
- Claude Code consumes the broker through ordinary MCP tools. MCP Tasks may be negotiated later; the plugin does not require the evolving extension.

## Storage

Job snapshots live at `jobs/<id>.json`. Normalized events live at `jobs/<id>.events.jsonl`. Prompts, logs, commands, and state files are created with user-only permissions. Event values are recursively redacted and size-bounded.

Terminal jobs older than `DELEGATE_JOB_RETENTION_DAYS` (default 14) are pruned opportunistically at broker start and job launch, at most once per six hours; `delegate-jobs prune` runs it on demand. Active jobs are never pruned.

Every first transition into a terminal status appends one redacted, private JSON line to the separate `audit.jsonl` beside the state file. It records actor, provider/model/mode/effort, resume/group provenance, access policy, cwd, observed change/violation counts, verification, nudges, outcome, usage, and duration. Job pruning never removes this log; `delegate-jobs stats` aggregates it and `delegate-health` reports its path. `delegate-jobs audit backfill` uses the same record builder to append missing retained terminal jobs with `backfilled: true`, once per job ID.

Direct Codex MCP calls and Cursor foreground/background CLI runs enter the same storage pipeline as shadow jobs with `transport: 'direct-mcp'` or `transport: 'direct-cli'`. Raw caller parameters are recursively redacted and bounded; the prompt is a normal `message.user`. Provider notifications are tee'd through the managed event normalizers without changing caller-visible output. Each call owns a distinct running record, PID/heartbeat-compatible liveness fields, terminal sentinel, and audit entry. A Codex reply creates a child shadow with the same thread ID so cumulative thread usage is delta-attributed across the chain. Shadow creation is atomic: any storage failure removes its partial files, logs once to stderr, and leaves the direct provider call on its legacy path.

Inspection reconciles liveness: a job recorded as `running` whose worker process no longer exists is transitioned to `failed` with an `ORPHANED` error event before the snapshot is returned. `delegate_list` rediscovers jobs by recency when an ID is no longer in context.

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
plan.updated
compaction.started, compaction.completed
tool.started, tool.status, tool.output, tool.completed
file.changed, diff.updated
usage.updated, usage.context
approval.requested, approval.resolved
input.requested, input.response.requested, input.resolved
network.preflight, network.mode-elevated, network.policy.materialized, network.policy.restored
config.updated, mode.updated, model.updated, commands.updated
subagent.activity, artifact.created
correction.requested, correction.applied, correction.queued, correction.restarted
command.applied, command.rejected
scope.violation, ingest.diverged
security.warning, baseline.dirty, budget.exceeded
job.retry, verification.finished
error, provider.event
```

`activity` contains only `{ kind: 'thinking' | 'output', at }`. Codex reasoning items plus Cursor ACP and headless thinking chunks produce transition markers at most once per two seconds; a bounded thought tail exists only in the provider process and is never written to the job record or journal. `provider.event` contains only a redacted event name and safe metadata. Raw provider payload persistence and hidden reasoning are intentionally excluded.

Cursor headless assistant chunks obey the provider's dedupe contract: only chunks with `timestamp_ms` and without `model_call_id` become `message.delta`; buffered pre-tool flushes and the timestamp-free final flush are skipped. `result.result` is the authoritative `message.completed`, with a content-free mismatch diagnostic when streamed text differs. Only the final result envelope supplies headless token usage.

Cursor ACP `tool_call_update` without output emits `tool.status`; completion `rawOutput` becomes bounded/redacted `tool.output` plus `tool.completed` with `exitCode`. Nested `{ path, oldText, newText }` diff content becomes `file.changed` and `diff.updated`. `session_info_update`, current mode, available commands, todo updates, nested task activity, and generated images map to the typed events above.

Every `file.changed` change normalizes at the broker boundary to a cwd-relative path and, when derivable, exact `{ added, removed }` line counts. Unified hunks count leading `+`/`-` lines except file headers; Cursor old/new text uses a line edit diff. Unknown counts are omitted rather than represented as zero. `delegate_transcript` admits these events with one compact plain-text `✎ path (+A −R)` line per change (including rename/delete labels), strips full diff/text bodies from that transcript view, and applies the same normalization when reading legacy journals.

During `session/load`, every replay-derived event has top-level `replay: true`. Replay does not update live message/result assembly, activity, notifications, or usage, and repeat loads suppress already-fingerprinted replay updates. Transcript consumers group it under one collapsed restored-history block.

Codex context-compaction item lifecycles additionally emit `compaction.started` and `compaction.completed` with `{ itemId }`; the existing redacted `provider.event` passthrough remains alongside them for raw event fidelity. Transcript readers admit the first-class lifecycle so compacting is visible without exposing compacted context or hidden reasoning.

## Error Taxonomy

Every broker error has `{ code, retryable, provider }`; `provider` is null/omitted only when no provider is known. Controllers branch on this closed code set, never on message text.

| Retryable | Codes |
| --- | --- |
| `true` | `LOCK_TIMEOUT`, `WRITER_ACTIVE`, `REVISION_CONFLICT`, `ORPHANED`, `PARENT_ACTIVE`, `TIMEOUT`, `RPC_TIMEOUT`, `TRANSPORT_ERROR`, `PROVIDER_ERROR`, `STATE_ERROR` |
| `false` | `INVALID_REQUEST`, `NOT_FOUND`, `QUOTA_GUARD`, `INVALID_MODEL`, `WRONG_LANE`, `RESUME_UNSUPPORTED`, `DIRECT_TRANSPORT`, `ACP_TIER_UNAVAILABLE`, `USER_INPUT_REQUIRED`, `SECRET_IN_PROMPT`, `BUDGET_EXCEEDED`, `LARGE_WRITE`, `PROVIDER_DISABLED`, `PROVIDER_TOO_OLD`, `SESSION_UNAVAILABLE`, `UNMANAGED_JOB`, `JOB_TERMINAL`, `UNSUPPORTED_STRATEGY`, `INTERNAL` |

`retryable: true` means retrying the same request, possibly after backoff, can succeed. `QUOTA_GUARD` needs a window reset or different provider; `ACP_TIER_UNAVAILABLE` needs a catalog or transport change; `USER_INPUT_REQUIRED` needs new information in a resume; and `BUDGET_EXCEEDED` needs a higher cap. `REVISION_CONFLICT` includes `currentRevision`; budget and timeout failures retain partial state for an explicit resume.

`DIRECT_TRANSPORT` means the record is an observability shadow whose original caller owns the provider loop. All mutation controls reject without signalling the provider; read-only inspection, events, transcript, diff, files, usage, and aggregate stats remain available.

`retryPolicy` is narrower than the taxonomy: only retryable `TRANSPORT_ERROR`, `RPC_TIMEOUT`, or `PROVIDER_ERROR` failures during provider startup/turn execution qualify as `transport`; provider 429/5xx signatures qualify as `rate-limit`. Each retry stays on the same job, reuses a continuation when present, increments `retries`, and emits `job.retry`. The default is no retries. Commands are claimed after backoff and immediately before relaunch: cancel terminals the job without another spawn, and steer is rejected because there is no active attempt.

## Correction Semantics

- Codex `same-turn`: call `turn/steer` using the active thread and expected turn.
- Codex `restart`: interrupt, wait for the turn to settle, then start another turn on the same thread.
- Codex `next-turn`: queue another turn without misrepresenting it as steering.
- Cursor `auto` or `restart`: send `session/cancel`, wait for the prompt response, then prompt the same ACP session.
- Cursor `same-turn`: reject as unsupported by ACP v1.

Every correction supplies a caller-stable `correctionId`; repeating it returns the existing control record. Every result states how it was applied.

Direct-transport shadows support none of these correction or continuation operations. A direct `codex-reply` call is journaled as a new caller-owned child shadow rather than a broker resume.

If Codex requests interactive user input, managed v1 records the request and fails explicitly rather than inventing an empty answer. Cursor ACP `cursor/ask_question` and `cursor/create_plan` instead enter the revisioned control inbox: phase becomes `user-input-required`, the redacted payload is inspectable, and MCP `delegate_respond` or CLI `delegate-jobs respond` completes the JSON-RPC request exactly once. Timeout rejects it with `USER_INPUT_REQUIRED` and `stopReason: input-timeout`; plans are never auto-accepted.

ACP permissions remain deny-by-default. Force-level jobs choose only an advertised `allow_once`; `allow_always` is never selected. Approval events carry normalized tool kind, repo-relative paths under cwd (plus explicit outside paths), domain, command, and `ambiguous: true` for shell-like requests lacking a structured command.

## Attribution

Codex app-server produces provider-level file and aggregated diff events. Cursor ACP reports tool locations when available and the broker records a final Git diff. Job creation captures a content hash of every already-dirty file alongside `baselineFiles`; at completion, pre-existing files whose bytes are unchanged are excluded from the diff, the file inventory, and `changedFiles` — a file the job merely read never appears as work. A pre-existing file the job did modify stays in the diff with `overlapsPreexisting: true`, and its hunks remain mixed (pre-existing plus job changes cannot be separated without a content snapshot), so attribution stays `best-effort` for those files only; `includesPreexistingChanges` on `diff.updated` is now set precisely when such a file contributed content. Files too large to hash (>10 MB) and jobs created before hashing existed fall back to the old include-everything behavior. Worktree-isolated jobs can later report high-confidence ownership without changing this protocol.

`changedFiles` entries are normalized repo-relative and deduped across provider-reported (sometimes absolute) and git-inventory paths. With `allowedPaths` set, out-of-scope entries are recorded as `scopeViolations` (each carrying its `preexisting`/`overlapsPreexisting` flags so concurrent-session noise is distinguishable) and emitted as a `scope.violation` event. `baselineFiles` on the job record is the attribution baseline — files already dirty when the job started — not files the job changed. On write-mode completion the broker records `changedFiles` (count, a 50-path summary, bounded entries, and final content hashes) from its own file-change tracking, so the job record is grounded in observation and safe revert can detect later edits. `driftReport` assembles modified, new, and out-of-scope paths for inspection. `resolvedModel` records the provider-confirmed model when available.

## Completion Semantics

`resultText` normalizes the three provider result shapes (Codex string, Cursor ACP object, Cursor headless CLI envelope) into one always-readable field; provider extras are preserved under `result`. Read-mode jobs whose final message is narration-length are flagged `resultSuspect: 'short-final-message'`; opt-in `autoNudge` performs one same-session correction, replaces the result, and preserves `result.firstAttemptText`. `reportSchema` parses only the last fenced JSON object into `result.structured`, surfaces `objectiveMet`, and otherwise sets `structuredMissing`. Cursor sessions that advertise a model only as its fast variant are escaped to the headless transport with the CLI's non-fast id when one exists (`cursor:acp-tier-fallback`), or proceed fast with a `cursor:fast-fallback` event; a session reporting a different model than negotiated raises `cursor:model-mismatch`. Cursor plan-mode plans arrive as ACP `plan` updates, not agent messages: they are journaled as `plan.updated` and folded into the terminal record as `result.plan`, while `result.text` carries only conversational messages. `completed` means the provider turn and optional verification command ended, not that the objective was met. Read `result`, `changedFiles`, `driftReport`, and the diff before treating a job as successful. `delegate-jobs wait` exits 5 when a write-mode job completes with zero observed file changes and 6 when verification is nonzero; verification failure leaves status `completed`. Terminal failures and cancellations include a checkpoint, while `resumable` uses the exact same decision predicate as `delegate_resume`. Codex threads that engaged the multi-agent review flow may refuse direct resume; that surfaces as `RESUME_UNSUPPORTED`, and the recovery is a fresh job whose packet folds in the prior findings.

## Honest Cursor non-parity

The adapter does not simulate capabilities Cursor lacks:

- no same-turn steering; corrections are cancel-and-resume restarts;
- no live shell stdout (ACP exposes completion `rawOutput` only);
- no mid-turn token usage (headless reports tokens only in the final result; ACP `usage_update {used,size}` is context occupancy);
- no rate-limit or allowance feed (Cursor allowance remains manual dashboard state).

ACP initialize advertises fs read/write and terminal capabilities as false. A versioned no-turn health probe may advertise them experimentally and reports observed client requests, but production flags remain false until an installed release actually routes a request through the client.

## Response Bounds

Event pages are additionally capped by serialized size (not just event count); a truncated page sets `truncated: "response-size"` and a valid `nextSeq`. Large diffs are windowed: `delegate_diff` accepts `offset`/`maxChars` and returns `totalChars`/`nextOffset`, or `statOnly` for per-file addition/deletion counts. Result text uses the same absolute-offset shape through `delegate_inspect.resultWindow` and `delegate-jobs result`; `find` is case-sensitive and chooses the window start.
