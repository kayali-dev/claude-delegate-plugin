# Model Notes

Research snapshot: 2026-07-11 (Cursor plans re-verified same day). Model availability and pricing can change; query installed CLIs before relying on a model ID.

## Claude

- Fable 5 is Anthropic's most capable route for the hardest long-running work, broad knowledge, vision, science, and large autonomous software tasks. Prefer it when ambiguity, visual input, or the current conversation context dominates.
- Opus 4.8 is the complex-reasoning fallback when Fable is unavailable or unnecessary.
- Sonnet 5 is the daily coding and coordination default.
- Haiku is appropriate for simple, bounded, low-risk work.

Sources: https://code.claude.com/docs/en/model-config and https://www.anthropic.com/news/claude-fable-5-mythos-5

## Codex GPT-5.6

- Sol is the strongest Codex coding route for terminal-heavy work, difficult debugging, code review, frontend and computer-use workflows, defensive security, and long-horizon verified execution.
- Terra is the cost-balanced route for substantial routine coding.
- Luna is the fast route for bounded low-risk work.
- Max is for unusually hard single-agent work. Ultra is for demanding independent workstreams and has a much larger usage footprint.

Sources: https://openai.com/index/gpt-5-6/ and https://developers.openai.com/api/docs/models/gpt-5.6-sol

## Cursor Plans And Pools

Cursor subscriptions (Pro $20, Pro+ $60, Ultra $200 per month; Teams Standard $40 and Premium $120 per user) meter usage in two separate monthly pools:

- **First-party pool**: Auto, Composer 2.5, and Grok 4.5 draw from a dedicated, more generous allocation. This is the pool Delegate Router consumes, because it routes to Composer and Grok.
- **API pool**: third-party models charged at API price against a tier-based inclusion ($20 / $70 / $400).

Both pools are token-metered at per-model rates, so model choice changes how fast the shared first-party pool drains: Grok 4.5 ($2/$6 per 1M in/out) consumes it roughly 3-4x faster than Composer 2.5 ($0.5/$2.5). There are no five-hour or weekly windows; the cycle is monthly, and exhausted included usage falls through to on-demand billing rather than a hard block.

Track the **first-party pool** percentage from the dashboard: `delegate-usage set cursor <percent> --window first-party --source dashboard --reset <cycle-end-epoch>`.

Sources: https://cursor.com/docs/models-and-pricing and https://forum.cursor.com/t/grok-4-5-pricing-for-subscription-plans/165207

## Cursor Grok 4.5

Grok 4.5 is Cursor's broad frontier route for long-running creative tool use spanning software engineering, data science, finance, legal, research, and knowledge work. Its training emphasizes investigation, recovery, and verification. It is subscription-included as a first-party model, but drains the shared first-party pool several times faster than Composer — reserve it for work that needs its breadth. Use `grok-4.5-high` for the cost-balanced route and `grok-4.5-xhigh` for the hardest cases. Avoid Fast variants unless latency matters more than allowance.

Cursor disclosed that an earlier Cursor code snapshot entered training, so do not over-weight CursorBench when comparing it with other providers.

Source: https://cursor.com/blog/grok-4-5

## Cursor Composer 2.5+

Composer is Cursor's coding specialist for sustained multi-file changes, refactors, tests, and clear implementation work. Composer 2.5 improved long-running coding, complex instruction following, and effort calibration. It is subscription-included as a first-party model and is the cheapest draw on the shared first-party pool, which makes it the default efficiency route; Fast costs materially more.

The adapter defaults to `composer-2.5`. Override `DELEGATE_CURSOR_COMPOSER_MODEL` when a later Composer ID is available. Run `agent models` or `cursor-agent models` to verify account-specific availability.

Sources: https://cursor.com/blog/composer-2-5 and https://cursor.com/blog/composer-2-technical-report

## Comparison Limits

Provider benchmark numbers are not directly interchangeable: the harness, tools, prompting, and available context differ. Route by task shape, verified local behavior, allowance headroom, and total coordination cost rather than declaring one universal winner.
