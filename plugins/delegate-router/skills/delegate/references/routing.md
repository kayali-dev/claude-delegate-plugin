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
| Clear multi-file implementation, refactor, or tests | Cursor Auto (Composer when explicitly pinned) | GPT-5.6 Terra | GPT-6.1 Sol |
| Difficult debugging, terminal-heavy engineering, code review, security, frontend verification | GPT-6.1 Sol (`xhigh` for review/second opinions) | Claude Opus | Grok 4.7 |
| Broad research plus tools, data/science/finance/legal context, creative recovery | Grok 4.7 | Claude Opus | GPT-6.1 Sol |
| Very ambiguous long-horizon migration, vision-heavy work, or task tied to conversation judgment | Current Claude / Opus (Fable only with explicit per-task authorization) | GPT-6.1 Sol | Grok 4.7 |
| Fast bounded low-risk coding | GPT-6 Luna or Claude Haiku | Composer | Current Claude |
| Architecture or product tradeoff | Current Claude / Opus (Fable only with explicit per-task authorization) | Grok 4.7 | GPT-6.1 Sol |

These are routing heuristics, not cross-provider benchmark rankings. Benchmarks use different harnesses and tool environments.

`astra` explicitly selects GPT-6 Astra for the most demanding work; it is not
an automatic candidate. Claude aliases follow the host provider's current
models (currently Opus/Sonnet/Haiku 5.5 and Fable 5.1 on Anthropic). Cursor
aliases select eligible advertised versions, so account catalogs can differ
from these labels. Full model IDs infer their native provider and retain their
pin. See [model notes](models.md) for current sources and availability limits.

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

The Codex `PreToolUse` hook independently enforces its 90% default avoid threshold; Cursor launch admission uses 80%. Provider-specific overrides apply to both routing and admission.

## Cost Discipline

Fast variants are opt-in when both forms exist; a fast-only ACP catalog can trigger a loudly evented compromise or a CLI-validated non-fast fallback. Non-complex unnamed Cursor work defaults to Auto, which can select third-party models. Pin Composer or Grok when Cursor Models pool selection matters. Prefer Composer for routine pinned implementation and Grok for sustained investigation; measure observed spend rather than assuming a universal token-cost ratio. Staying in the current Claude conversation often saves a context handoff for small work.

For routine scoped code review and second opinions, default to one managed Codex `mode=review` run with Sol at `xhigh`; its read-only transcript, diff, and usage trail costs far less than multi-agent review. Reserve multi-agent workflows for exhaustive audits.

Use the right tool for the model: GPT models run on Codex, Composer/Grok/Auto on Cursor, Claude in-session or via built-in agents. Running a GPT model through Cursor's API pool is refused (`WRONG_LANE`) while Codex is enabled and under its avoid band; it is acceptable only on explicit user request (`overrideLane=true`) or when Codex is disabled or exhausted.

Do not delegate the same question to several expensive models by default. Multiple opinions are justified for high-risk review, uncertain architecture, or explicit comparison; keep them read-only and synthesize the disagreements.

## Cursor transport and network routing

Prefer ACP when its session catalog contains the requested tier; prefer the existing explicit headless transport or the automatic `cursor:acp-tier-fallback` only when ACP cannot honor the tier/start contract. Both transports now expose live assistant/thinking/tool structure, but their remaining limits matter when routing: Cursor has no same-turn steer, no live shell stdout, no mid-turn token usage, and no rate-limit/allowance feed. Route work that depends on any of those properties to Codex app-server.

`network=true` is a privilege decision, not a routing hint. Cursor ask/plan cannot use network, so networked consult/plan/review elevates the provider to agent mode under an injected strict read-only preamble. Sandboxed egress uses the temporary merged `networkAllow` policy; sandbox-off egress necessarily uses force and therefore also auto-approves actions beyond networking. Require explicit sandbox-off-level authorization for that combination.

## Capability-gated scheduling

Provider/model fit chooses a candidate; the attempt-driver contract then checks
whether that lane can honor the workflow. This is a separate decision from
quality scoring and allowance headroom. The scheduler currently names these
guarantees: `sameTurnSteering`, `liveShellStdout`, `midTurnTokenUsage`,
`contextOccupancyUsage`, `planMode`, `mcpInjection`, `worktreeSupport`, and
`startBeforePrompt`.

The resulting scheduling profile has four independent dimensions:

- workflows: plan-first, same-turn steering, and coordinator back-channel;
- budgets: mid-turn, completion-only, or unavailable output-token accounting,
  plus separate context occupancy;
- checkpoints: live shell output and context occupancy;
- containment: broker-owned worktree support.

An absent required capability makes the workflow ineligible and returns a
reason naming both the capability and lane. It never lowers the workflow to a
weaker checkpoint or budget. `delegate-health --capabilities` resolves the
installed three-lane matrix without a model turn and marks each capability
entry `probed` or `declared-from-documentation`.
