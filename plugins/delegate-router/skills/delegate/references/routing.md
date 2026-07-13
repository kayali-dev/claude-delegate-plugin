# Routing Policy

## First Decision: Delegate Or Stay

Stay in the current Claude session for trivial edits, conversational follow-ups, ambiguous requests needing user clarification, and work dominated by context already in the conversation. Delegation adds prompt construction, startup, coordination, and verification cost.

Delegate when the objective is independently specifiable and one or more are true:

- It needs sustained repository exploration or terminal work.
- A specialist model has a clear advantage.
- An independent review materially reduces risk.
- A fresh context avoids crowding the main conversation.
- The current provider is near its allowance threshold.

## Default Model Order By Task

| Task shape | First choice | Efficient fallback | Strong fallback |
| --- | --- | --- | --- |
| Small or context-heavy change | Current Claude | Claude Sonnet | Composer |
| Clear multi-file implementation, refactor, or tests | Cursor Auto (Composer when explicitly pinned) | GPT-5.6 Terra | GPT-5.6 Sol |
| Difficult debugging, terminal-heavy engineering, code review, security, frontend verification | GPT-5.6 Sol (`xhigh` for review/second opinions) | Claude Opus | Grok 4.5 |
| Broad research plus tools, data/science/finance/legal context, creative recovery | Grok 4.5 | Claude Opus | GPT-5.6 Sol |
| Very ambiguous long-horizon migration, vision-heavy work, or task tied to conversation judgment | Current Claude / Opus (Fable only with explicit per-task authorization) | GPT-5.6 Sol | Grok 4.5 |
| Fast bounded low-risk coding | GPT-5.6 Luna or Claude Haiku | Composer | Current Claude |
| Architecture or product tradeoff | Current Claude / Opus (Fable only with explicit per-task authorization) | Grok 4.5 | GPT-5.6 Sol |

These are routing heuristics, not cross-provider benchmark rankings. Benchmarks use different harnesses and tool environments.

`delegate-route` implements this matrix deterministically. The skill should call it before selecting a provider; prose reasoning is for interpreting or overriding its result, not replacing the headroom checks.

When terminal audit samples exist for a candidate's provider/model/effort cell, the route includes advisory `usageBand: { p50OutputTokens, p90OutputTokens, samples }`. This history never changes eligibility, score, or ordering. Refresh fleet evidence with `delegate-jobs stats [--since 7d]`.

## Effort

Start one level lower than instinct suggests and escalate on measured need — most tasks hold quality one level down, and output tokens are the expensive direction.

- `low`: lookup, formatting, narrow mechanical change.
- `medium`: normal implementation and review.
- `high`: multi-file debugging, risky behavior, architecture.
- `xhigh`: hard ambiguous reasoning or difficult review; the coding-agent sweet spot. Sol at `xhigh` is the review/second-opinion configuration — exceptionally strong at surfacing issues, gaps, and bugs.
- `max`: exceptional single-agent work where latency and usage are acceptable; compare against `xhigh` before adopting.
- `ultra`: Codex only, and a different topology rather than a bigger `max` — parallel internal delegation plus synthesis, multiplying token spend by design. Use only for genuinely independent demanding workstreams with explicit user budget acceptance. Never use merely to make a routine task faster.

## Headroom And Fallback

Use the maximum active-window percentage for a provider. Default bands for Claude and Codex (Cursor in parentheses — stricter because Cursor overage bills on-demand instead of throttling):

- Below 80% (70%): normal routing.
- 80-89% (70-79%): prefer an equally suitable cheaper provider.
- 90-97% (80-97%): do not start new work on that provider unless explicitly overridden.
- 98-100%: treat as unavailable.
- Unknown: eligible, but monitor quota failures; never interpret unknown as 0%.

Bands act only on reliable data: provider-timed windows (Codex app-server, Claude status line) or manual entries fresher than `DELEGATE_MANUAL_USAGE_TTL_DAYS` (default 7). Stale manual entries revert to unknown rather than silently gating decisions.

Fallback order is task-specific, not a fixed provider chain. Recompute model fit after removing providers at or above the avoid threshold. Prefer finishing an already-started bounded task on its current provider when it is below 98%, because migration also consumes allowance.

The Codex `PreToolUse` hook and Cursor adapter independently enforce the 90% default avoid threshold. This prevents an accidental tool call from bypassing the route calculation.

## Cost Discipline

Fast variants (Composer Fast, Grok Fast) are opt-in: select one only when the user explicitly asks for fast; resolution otherwise defaults to the non-fast form. For non-complex Cursor work with no user-named model, default to Cursor Auto mode and let the first-party pool route it. Composer and Grok share one Cursor first-party monthly pool, and Grok drains it roughly 3-4x faster per token — prefer Auto or Composer for routine implementation and spend Grok on work that needs its breadth. Use Sol only when its verification, terminal, or reasoning advantages justify its higher cost. Staying in the current Claude conversation is often most efficient for small work because it avoids a full context handoff.

For routine scoped code review and second opinions, default to one managed Codex `mode=review` run with Sol at `xhigh`; its read-only transcript, diff, and usage trail costs far less than multi-agent review. Reserve multi-agent workflows for exhaustive audits.

Use the right tool for the model: GPT models run on Codex, Composer/Grok/Auto on Cursor, Claude in-session or via built-in agents. Running a GPT model through Cursor's API pool is refused (`WRONG_LANE`) while Codex is enabled and under its avoid band; it is acceptable only on explicit user request (`overrideLane=true`) or when Codex is disabled or exhausted.

Do not delegate the same question to several expensive models by default. Multiple opinions are justified for high-risk review, uncertain architecture, or explicit comparison; keep them read-only and synthesize the disagreements.
