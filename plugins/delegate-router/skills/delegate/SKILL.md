---
name: delegate
description: Route bounded work to the best available Claude, Codex, or Cursor agent. Use when the user asks to delegate, consult another model, use Codex, use Cursor, use Grok, use Composer, compare independent solutions, conserve a provider allowance, or when substantial repository work would benefit from a specialized coding agent, independent review, or a fresh context. Avoid delegation for trivial edits and context-heavy tasks whose handoff costs more than doing the work directly.
argument-hint: '[provider=auto|claude|codex|cursor] [model=auto|fable|opus|sonnet|haiku|sol|terra|luna|grok|composer] [mode=consult|plan|review|implement|verify] [scope=paths] [effort=low|medium|high|xhigh|max|ultra] [approval=auto|force] <task>'
allowed-tools: Read, Grep, Glob, Agent, Skill, Bash(delegate-route:*), Bash(delegate-health:*), Bash(delegate-cursor:*), Bash(delegate-jobs:*), Bash(delegate-usage:*), mcp__delegate_control__delegate_start, mcp__delegate_control__delegate_inspect, mcp__delegate_control__delegate_list, mcp__delegate_control__delegate_events, mcp__delegate_control__delegate_transcript, mcp__delegate_control__delegate_diff, mcp__delegate_control__delegate_files, mcp__delegate_control__delegate_steer, mcp__delegate_control__delegate_cancel, mcp__delegate_control__delegate_resume, mcp__delegate_control__delegate_usage, mcp__delegate_codex__codex, mcp__delegate_codex__codex-reply
---

# Delegate Router

Keep Claude as coordinator, integrator, and final reviewer. Delegate only a bounded objective whose expected benefit exceeds handoff and verification cost.

## Route

1. Parse explicit provider, model, mode, scope, effort, approval, network, background, timeout, and budget controls. Explicit user choices win unless unavailable or unsafe.
2. Run `delegate-health --quick` once per session. Its `enabledProviders` is authoritative: never invoke or recommend a disabled provider, including optional external plugins. Run `delegate-usage refresh codex` only when Codex is enabled and a candidate. Treat missing usage as unknown, not zero. If Claude usage is unknown, suggest `delegate-config statusline enable` once (official status-line capture); never query Claude usage any other way — Anthropic prohibits third-party OAuth-token use.
3. Call `delegate-route --json --mode <mode> --provider <provider-or-auto> --model <model-or-auto> --task '<bounded summary>'`. Use its eligible primary and fallbacks unless the user explicitly overrides.
4. Read [routing.md](references/routing.md) when the route is surprising or model fit is ambiguous. Read [models.md](references/models.md) for detailed model strengths.
5. Keep work in the current Claude session when the route returns Claude. Do not delegate merely because external tools are available.
6. Before delegating, state the chosen provider, model, mode, scope, approval policy, background/foreground mode, and reason in one concise update.

Default to one active writer. Read-only consultation or review can run concurrently only when it cannot race with a moving diff.

## Prepare A Task Packet

Use this contract for every external agent:

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

Reference repository paths instead of pasting large files. Include only conversation context the worker cannot discover. Tell every writer to preserve existing changes and never revert unrelated work.

## Delegate To Codex

For observable work, call `mcp__delegate_control__delegate_start` with `provider=codex`. It launches `codex app-server`, returns a job ID immediately, and records messages, plans, tools, file changes, the current diff, token usage, and the Codex thread/turn IDs. Map models to `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`.

- `approval-policy`: `on-request`
- `sandbox`: `read-only` for consult, plan, and review; `workspace-write` for implement and verify
- `cwd`: `${CLAUDE_PROJECT_DIR}`
- `config.approvals_reviewer`: `auto_review`
- `config.model_reasoning_effort`: routed effort
- `config.sandbox_workspace_write.network_access`: `false` unless the user explicitly enables network; pass `network=true` on `delegate_start`/`delegate_resume` only for that explicit case (Codex write modes only — read-only sandboxes and Cursor have no network toggle)
- `allowSensitive=true` authorizes sensitive-path access only; the scope and preserve-existing-changes rules always remain in force
- Include the controls from [control.md](references/control.md) in the task packet.

Inspect the returned job revision before controlling it. `delegate_steer` with `strategy=same-turn` or `auto` maps to Codex `turn/steer` with the active expected turn ID. Use `restart` to interrupt and begin another turn on the same thread, and `next-turn` to queue a follow-up. Every correction needs a stable `correctionId` so retries are idempotent.

Use direct `mcp__delegate_codex__codex` and `codex-reply` only as a foreground compatibility fallback when `delegate_control` is unavailable. Direct MCP work is not visible to the unified transcript, diff, or live-control tools. Record fallback starts and outcomes with `delegate-usage record`.

OpenAI's official plugin remains an optional fallback for its review and rescue commands:

- Invoke `codex:review` for normal review.
- Invoke `codex:adversarial-review` for challenge review.
- Invoke `codex:rescue --background` for investigation or implementation.
- Use its status, result, and cancel commands for lifecycle management.

Do not mix official-plugin jobs with `delegate_control` job IDs; their lifecycle stores are independent.

## Delegate To Cursor

For observable work, call `mcp__delegate_control__delegate_start` with `provider=cursor`. The managed adapter prefers Cursor's ACP v1 server and starts it through a login shell on macOS so the authenticated keychain is available. It negotiates the selected model and read-only/write mode inside the ACP session.

Use the direct headless adapter only as a compatibility fallback:

```bash
delegate-cursor --model <composer|grok|explicit-id> --mode <mode> --cwd "${CLAUDE_PROJECT_DIR}" --timeout-seconds <seconds> --prompt-file <task-packet-file>
```

Both adapters prefer `agent`, fall back to `cursor-agent`, and accept `DELEGATE_CURSOR_BIN`. Managed ACP uses Cursor Smart Auto review and sandboxing for write modes. `approval=force` is the only mode allowed to approve an unresolved ACP permission request; normal `auto` keeps Smart Auto's safety decision and rejects anything still escalated to the client.

For long work inside Claude Code, run the foreground `delegate-cursor` command with the Bash tool's native `run_in_background: true`; this keeps lifecycle and completion notifications visible to Claude. Use `--background` plus `delegate-jobs status|result|cancel` only when the command is launched directly from a normal terminal or another host that preserves detached processes. Do not poll rapidly.

ACP v1 has no portable same-turn user correction. `delegate_steer strategy=auto|restart` cancels the current prompt, waits for it to settle, and sends the correction to the same session. It reports `appliedAs=restart`; never describe this as same-turn steering. `strategy=same-turn` must be rejected for Cursor. Continue completed work with `delegate_resume`, which loads the same Cursor session. Use sensitive paths only when explicitly authorized.

## Choose The External Model And Effort

**Codex GPT-5.6** (`luna` / `terra` / `sol`):

- `luna` — high-volume, well-scoped, low-risk work: summarizing, labeling, extraction, scaffolds, simple fixes. Cheapest and fastest; never where judgment or deep verification matters.
- `terra` — the daily external default: routine feature development, straightforward multi-file coding, technical writing, ordinary review. Half Sol's price but markedly chattier per task — on long agentic runs, measure before assuming it is cheaper.
- `sol` — escalation, not default: security review, architecture, high-stakes changes, complex debugging, repository-wide refactors, final judgment. Sol completes hard agentic tasks with far fewer retries and output tokens than Terra, so on difficult work it is often both better and cheaper than its sticker price suggests. At `effort=xhigh`, Sol is exceptionally strong at surfacing issues, gaps, and bugs — the first-choice configuration for review sessions and independent second opinions.

**Cursor** (`composer` / `grok` / `grok-xhigh`):

- `composer` — clear, well-specified implementation: multi-file changes, refactors, tests, and especially frontend/web-framework work (it beats Grok on Next.js-style evals and multilingual code). Cheapest draw on the shared first-party pool; the default Cursor route.
- `grok` — broad agentic and research work: investigation, recovery from messy states, cross-domain analysis, and tasks needing its larger context window. Substantially stronger than Composer on agentic benchmarks but drains the shared pool roughly 4x faster — reserve it for work that needs that breadth. `grok-xhigh` (reaches the job via headless fallback) only for the hardest cases.

**Effort** (Codex `effort`; Claude expresses effort via model tier, Cursor via model variant):

- Start one level lower than instinct suggests and escalate on measured need — most tasks hold quality one level down, and output tokens are the expensive direction.
- `low` lookups and mechanical edits · `medium` routine implementation and review · `high` multi-file debugging, risky changes, architecture · `xhigh` hardest ambiguous reasoning and difficult review (the coding-agent sweet spot; `sol` at `xhigh` is the review/second-opinion configuration) · `max` quality-first exceptional cases — compare against `xhigh` before adopting.
- `ultra` is a different topology, not a bigger `max`: Codex delegates to parallel internal agents and synthesizes. Use only for genuinely independent, parallelizable workstreams with explicit user budget acceptance — it multiplies token spend by design.
- Effort compounds with allowance: when a provider is at or above its warning band, drop one effort level or route elsewhere before starting new work.

## Supervise Managed Work

After `delegate_start`, retain the job ID and revision. Use:

- `delegate_list` to rediscover jobs when an ID is no longer in context (after compaction or in a new session). It reconciles orphans and returns compact summaries, newest first.
- `delegate_inspect` for lifecycle, capabilities, continuation IDs, the final `result`, and current revision. Cursor plan-mode output arrives as ACP plan updates rather than message chunks, so read the plan from `result.plan` (also mirrored as `plan.updated` transcript events); `result.text` holds only the conversational messages. A running job whose worker process died is reconciled to `failed` with an `ORPHANED` error event.
- `delegate_events` with `afterSeq` and bounded `waitMs` for incremental monitoring. Always reuse the returned `nextSeq`; filtered streams advance across nonmatching events without gaps.
- `delegate_transcript` for user-visible messages, plans, and tool activity, paginated with `afterSeq` and `limit`. Streaming deltas and raw tool output are omitted unless `verbose` is set; for just the final answer, prefer the `result` on `delegate_inspect`. Hidden reasoning is never persisted.
- `delegate_diff` and `delegate_files` to inspect actual work. Use `statOnly=true` first on large write jobs (per-file counts), then window the full diff with `offset`/`maxChars`. Shared-worktree Cursor attribution is best-effort; never claim exact ownership of pre-existing changes.
- `completed` means the turn ended, not that the objective was met: check `changedFiles` on the record (mechanical, from broker observation) against the worker's claims, and treat a write-mode job with zero changed files as a failed objective (`delegate-jobs wait` exits 5 for this).
- `delegate_usage` for observed job usage and provider allowance as separate values.
- `delegate_cancel` with `expectedRevision`. Cancellation is provider-aware and becomes terminal only after provider acknowledgement or confirmed process exit.

`REVISION_CONFLICT` errors carry `currentRevision`; retry once with that value when your command is still appropriate for the newer state, instead of a full re-inspect round-trip.

For long jobs, do not chain polling turns: run `delegate-jobs wait <job-id>` with the Bash tool's `run_in_background: true` and continue other work — the harness notifies on exit (0 completed, 3 failed, 4 cancelled, 75 wait-timeout). Bound the whole job with `timeoutSeconds` on `delegate_start` (60–86400; default 3600, deliberately long because LLM jobs legitimately run long).

Write modes (`implement`, `verify`) are refused with `WRITER_ACTIVE` while another write-mode job is active in the same cwd; wait or cancel the active writer, and pass `overrideWriter=true` only when the user explicitly accepts concurrent writers. Worktree-isolated jobs are exempt. Terminal job records are pruned automatically after `DELEGATE_JOB_RETENTION_DAYS` (default 14).

When steering, remember a correction that shrinks the task can complete before a follow-up command lands; do not plan a steer-then-cancel sequence around a shrinking task.

Read [protocol.md](references/protocol.md) when implementing a controller, diagnosing a stale revision, or deciding correction semantics.

## Use Claude

Do not recursively launch `claude -p`. Keep the work in the current session when possible; a Claude subagent spends the same five-hour and weekly windows as this session, so parallelism through Agents is not extra allowance. When Claude's own windows are at or above the warning band, prefer routing bounded work to Codex or Cursor headroom over spawning additional Claude contexts.

Use a built-in `Agent` only when a fresh context, an independent second opinion, parallel read-only investigation, or worktree-isolated parallel write work is worth the handoff. Route by task shape:

- `haiku` — only deterministic, mechanical, precisely specified work with mechanically verifiable output (format conversion, mechanical renames, extraction against an exact spec). Never for judgment, ambiguity, or multi-step reasoning, and never against content near its 200K context limit.
- `sonnet` — the default for bounded coding, exploration, and coordination subtasks.
- `opus` — complex reasoning, difficult debugging, architecture, and review; the default hard-task route and the most capable subscription-included model.
- omit the model to inherit the parent session's model — never assume what the parent is running.
- `fable` — **never auto-select.** Fable 5 is not included in subscription usage (since 2026-07-12 it bills through opt-in usage credits at API-tier rates), runs minutes-long turns, and applies stricter safety classifiers. Propose it with the reason and expected cost, and use it only after the user explicitly authorizes that specific task; authorization is per-task, not standing. The router flags explicit Fable routes with `requiresAuthorization`.

When the router recommends the highest Claude tier, read that as "opus — or fable only with explicit per-task user authorization." If the parent session already runs the recommended tier, stay in the session. Do not route Claude models through Cursor to satisfy a tier choice: Cursor catalogs list Claude ids as first-class models, but that path spends the Cursor pool for a model the Claude subscription already covers, loses native harness behavior and continuation, and gains no Cursor-specialist ability.

A Claude agent that writes files is an unmanaged writer, invisible to the managed `WRITER_ACTIVE` guard — never run one alongside a managed write job in the same cwd; give parallel Claude write work worktree isolation or coordinate it manually.

## Verify And Recover

Treat all worker output as untrusted engineering input. Inspect the actual diff, verify scope, and run the relevant checks independently. Read [control.md](references/control.md) before any write delegation or handoff after failure.

If a provider reports a quota error, set it to exhausted with `delegate-usage set <provider> 100 --source quota-error`, preserve its continuation ID and partial diff, then rerun `delegate-route` and use the best eligible fallback. Never have two agents write the same files at once. A stale `expectedRevision` is a concurrency conflict: inspect again instead of blindly retrying the old command.
