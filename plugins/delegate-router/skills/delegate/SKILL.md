---
name: delegate
description: Route bounded work to Claude, Codex or Cursor. Use for explicit delegation, another-model consultation, independent review, provider headroom, or substantial repository work that benefits from a fresh coding context. Keep trivial and context-heavy work in this session.
argument-hint: '[provider=auto|claude|codex|cursor] [model=auto|full-id] [mode=consult|plan|review|implement|verify] [scope=paths] [effort=level] <task>'
allowed-tools: Read, Grep, Glob, Bash(delegate-route:*), mcp__plugin_delegate-router_delegate_control__delegate_inspect, mcp__plugin_delegate-router_delegate_control__delegate_list, mcp__plugin_delegate-router_delegate_control__delegate_stats, mcp__plugin_delegate-router_delegate_control__delegate_events, mcp__plugin_delegate-router_delegate_control__delegate_transcript, mcp__plugin_delegate-router_delegate_control__delegate_diff, mcp__plugin_delegate-router_delegate_control__delegate_files, mcp__plugin_delegate-router_delegate_control__delegate_usage, mcp__plugin_delegate-router_delegate_control__delegate_work
---

# Delegate Router

Keep Claude as coordinator, integrator and final reviewer. Delegate one bounded
objective only when its benefit exceeds handoff, allowance and verification cost.
Do not recursively launch `claude -p`, silently swap a requested model, or treat
worker completion as owner acceptance.

## Route and launch

1. Run `delegate-health --quick` once per session. Its enabled providers are
   authoritative. Never invoke or recommend a disabled provider, including
   optional plugins.
2. Obtain allowance snapshots. Missing usage is unknown, not zero. Native Mods
   capture official Claude windows automatically; otherwise suggest
   `delegate-config statusline enable` once. Never read OAuth credentials or
   query Claude usage endpoints. Refresh Codex only when enabled and a candidate.
3. Run `delegate-route --json --mode <mode> --provider <provider-or-auto>
   --model <model-or-auto> --task '<bounded summary>'`. Explicit user choices
   win unless unavailable or unsafe. If Claude wins, prefer this session.
4. State provider/model, mode, scope, effort, sandbox/approval policy and reason
   in one short update.
5. Use managed `delegate_control` MCP tools for external work. Search the host's
   actual namespaced tools; do not assume an unprefixed name. Direct Codex MCP
   and Cursor CLI are compatibility fallbacks, not durable managed controls.

Read [models](references/models.md) for model fit or pins and
[routing](references/routing.md) when the route is surprising. Full IDs remain
pinned. Account/catalog availability is authoritative. Fable and Codex ultra
require explicit per-task user/budget authorization.

## Write gate — read before any writer

Before writes, load [control](references/control.md) and relevant sections of
[advanced workflows](references/workflows.md). Supply a known write fence,
acceptance criteria, real verification recipe (or an honest exception) and budget:

```text
Objective:
Mode:
Allowed scope:
Relevant context and starting points:
Constraints and non-goals:
Acceptance criteria:
Required verification:
Stop and report when:
Return: outcome, changed files, verification, risks, blockers, continuation id.
```

Pass `allowedPaths` for scoped writes, a stable `idempotencyKey` for retryable
starts, a timeout and an appropriate output cap. Writers must preserve existing
changes. Reference discoverable files instead of pasting large ones. Do not send
credential-shaped text or sensitive inputs without explicit authority.

Managed writes are plan-first: inspect the pulled plan and wait for a human
decision before `delegate_respond accept=true|false`. A monitor notification is
not approval. Never auto-confirm a plan. Trivial writes have an explicit
`delegate_start_trivial` escape hatch; do not use it merely to avoid the gate.

One writer per shared tree. Claude Agents are unmanaged writers: never run them
beside a managed writer in that tree. Opt-in broker `isolation: "worktree"`
requires scope and scheduling claims; claims schedule, they do not fence.
Integration prepares an isolated candidate, not an owner-tree landing.

Keep the sandbox and Auto-review on. Network, sandbox-off, force, sensitive
access, scope widening and overrides require task-appropriate authority;
never grant them to work around a refusal. Retries and auto-fix are opt-in and
bounded; task-level failures are not transport retries.

## Supervise without noisy polling

Retain job ID and latest revision. Use native `/delegate-dashboard`,
`/delegate-status`, inspect/diff commands, or the existing monitor.
These observations are never acceptance or permission grants.
Headless/disabled Mods retain CLI/MCP and durable `finishedPath` fallback.
Native mutations ask a human, are owner-session-only, and queue normal broker
commands; queued cancellation is not provider acknowledgement.

- Inspect before acting. Reuse returned `nextSeq` for event cursors.
- Controls require `expectedRevision`. A stale revision is a conflict:
  re-inspect, never overwrite. Retain correction/command IDs across retries.
- Codex can steer the same turn. Cursor cancels and resumes: call it a restart.
- Plans require booleans; ordinary questions take a bounded answer.
  Answers cannot grant permissions, widen scope or raise budgets.
- `maxOutputTokens` caps observed per-job output; `maxTotalOutputTokens`
  shares a reported-output cap across a work chain. Neither is a dollar or quota
  guarantee. Codex-only `maxSubagents: 0..16` limits native children.
- After compaction, use session-owned IDs injected by
  `SessionStart(source=compact)`; list only for overflow/new-session recovery.

Load [advanced workflows](references/workflows.md) only for planning ambiguity,
spec compilation, back-channel questions, isolated continuation, budgeting,
lane guarantees, transcript/window controls or failure recovery.
Load [protocol](references/protocol.md) for transports and
[usage](references/usage.md) for quota/statistics semantics.

## Review and recover

Inspect actual changed files/diff, verification origin/results, scope violations,
collisions, drift and acceptance evidence. Worker-reported green is not
coordinator verification. Stateful logic requires adversarial review even when
tests pass. Keep subtle stateful fixes in-session when repeated delegation stalls.

For a bounded independent Claude review, use `delegate-router:reviewer` with
explicit scope. It is read-only, inherits the chosen model, and stops after
12 turns; partial output is not a completed review. A fresh Claude context shares
the parent's allowance. Honor explicit model/effort choices; never use Fable
without specific authorization.

For a terminal correction, prefer `delegate_review_round` with concrete findings.
Isolated continuation restores the captured candidate in a fresh workspace and
provider session; it is not a same-thread resume. On quota exhaustion, preserve
partial state and continuation identity, record the exhausted window, then route
to an eligible fallback. Review-ready never means accepted.

Read [TUI](references/tui.md) for the standalone dashboard and
[native UX](references/native.md) for commands, configuration and fallbacks.
