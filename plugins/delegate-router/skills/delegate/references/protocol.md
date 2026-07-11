# Supervision Protocol

## Layers

- Codex uses app-server v2 for coding-specific events, interruption, and true `turn/steer`.
- Cursor uses ACP v1 for sessions, structured updates, model/mode configuration, and cancellation.
- The broker uses an A2A-inspired durable job lifecycle and an AG-UI-inspired normalized event stream.
- Claude Code consumes the broker through ordinary MCP tools. MCP Tasks may be negotiated later; the plugin does not require the evolving extension.

## Storage

Job snapshots live at `jobs/<id>.json`. Normalized events live at `jobs/<id>.events.jsonl`. Prompts, logs, commands, and state files are created with user-only permissions. Event values are recursively redacted and size-bounded.

Terminal jobs older than `DELEGATE_JOB_RETENTION_DAYS` (default 14) are pruned opportunistically at broker start and job launch, at most once per six hours; `delegate-jobs prune` runs it on demand. Active jobs are never pruned.

Inspection reconciles liveness: a job recorded as `running` whose worker process no longer exists is transitioned to `failed` with an `ORPHANED` error event before the snapshot is returned. `delegate_list` rediscovers jobs by recency when an ID is no longer in context.

`lastSeq` changes for every event. `revision` changes only for lifecycle and control transitions. Read events after the last observed sequence. Send `expectedRevision` with steering and cancellation so concurrent controllers cannot both mutate stale state.

Event reads return `nextSeq`, `latestSeq`, and `hasMore`. Reuse `nextSeq`, including for filtered streams. `waitMs` provides bounded long polling and is capped at 30 seconds.

## Events

Stable types include:

```text
job.created, job.state, job.completed, job.cancelled
session.updated, turn.started, turn.completed
message.user, message.delta, message.completed
plan.updated
tool.started, tool.output, tool.completed
file.changed, diff.updated
usage.updated
approval.requested, approval.resolved
correction.requested, correction.applied, correction.queued, correction.restarted
command.applied, command.rejected
error, provider.event
```

`provider.event` contains only a redacted event name and safe metadata. Raw provider payload persistence and hidden reasoning are intentionally excluded.

## Correction Semantics

- Codex `same-turn`: call `turn/steer` using the active thread and expected turn.
- Codex `restart`: interrupt, wait for the turn to settle, then start another turn on the same thread.
- Codex `next-turn`: queue another turn without misrepresenting it as steering.
- Cursor `auto` or `restart`: send `session/cancel`, wait for the prompt response, then prompt the same ACP session.
- Cursor `same-turn`: reject as unsupported by ACP v1.

Every correction supplies a caller-stable `correctionId`; repeating it returns the existing control record. Every result states how it was applied.

If Codex requests interactive user input, managed v1 records the request and fails explicitly rather than inventing an empty answer. Resume the terminal job with the answer in a new prompt.

## Attribution

Codex app-server produces provider-level file and aggregated diff events. Cursor ACP reports tool locations when available and the broker records a final Git diff. In a shared dirty worktree that diff may include pre-existing work, so attribution is `best-effort`. Worktree-isolated jobs can later report high-confidence ownership without changing this protocol.

`baselineFiles` on the job record is the attribution baseline — files already dirty when the job started — not files the job changed. On write-mode completion the broker records `changedFiles` (count plus up to 50 paths) from its own file-change tracking, so the job record is grounded in observation even when the worker's final message misstates what it did. `resolvedModel` records the provider-confirmed model when available.

## Completion Semantics

`completed` means the provider turn ended, not that the objective was met. Read `result`, `changedFiles`, and the diff before treating a job as successful. `delegate-jobs wait` exits 5 when a write-mode job completes with zero observed file changes — a strong signal the objective was not met. Codex threads that engaged the multi-agent review flow may refuse direct resume; that surfaces as `RESUME_UNSUPPORTED`, and the recovery is a fresh job whose packet folds in the prior findings.

## Response Bounds

Event pages are additionally capped by serialized size (not just event count); a truncated page sets `truncated: "response-size"` and a valid `nextSeq`. Large diffs are windowed: `delegate_diff` accepts `offset`/`maxChars` and returns `totalChars`/`nextOffset`, or `statOnly` for per-file addition/deletion counts.
