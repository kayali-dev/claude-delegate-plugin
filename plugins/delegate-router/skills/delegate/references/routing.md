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
| Clear multi-file implementation, refactor, or tests | Composer 2.5+ | GPT-5.6 Terra | GPT-5.6 Sol |
| Difficult debugging, terminal-heavy engineering, code review, security, frontend verification | GPT-5.6 Sol | Claude Fable/Opus | Grok 4.5 |
| Broad research plus tools, data/science/finance/legal context, creative recovery | Grok 4.5 | Claude Fable/Opus | GPT-5.6 Sol |
| Very ambiguous long-horizon migration, vision-heavy work, or task tied to conversation judgment | Current Claude Fable/Opus | GPT-5.6 Sol | Grok 4.5 |
| Fast bounded low-risk coding | GPT-5.6 Luna or Claude Haiku | Composer | Current Claude |
| Architecture or product tradeoff | Current Claude Fable/Opus | Grok 4.5 | GPT-5.6 Sol |

These are routing heuristics, not cross-provider benchmark rankings. Benchmarks use different harnesses and tool environments.

`delegate-route` implements this matrix deterministically. The skill should call it before selecting a provider; prose reasoning is for interpreting or overriding its result, not replacing the headroom checks.

## Effort

- `low`: lookup, formatting, narrow mechanical change.
- `medium`: normal implementation and review.
- `high`: multi-file debugging, risky behavior, architecture.
- `xhigh`: hard ambiguous reasoning or difficult review.
- `max`: exceptional single-agent work where latency and usage are acceptable.
- `ultra`: Codex only; use for genuinely independent demanding workstreams with explicit budget headroom. Never use merely to make a routine task faster.

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

Use Composer standard rather than Composer Fast by default. Use Grok standard rather than Grok Fast. Composer and Grok share one Cursor first-party monthly pool, and Grok drains it roughly 3-4x faster per token — prefer Composer for routine implementation and spend Grok on work that needs its breadth. Use Sol only when its verification, terminal, or reasoning advantages justify its higher cost. Staying in the current Claude conversation is often most efficient for small work because it avoids a full context handoff.

Do not delegate the same question to several expensive models by default. Multiple opinions are justified for high-risk review, uncertain architecture, or explicit comparison; keep them read-only and synthesize the disagreements.
