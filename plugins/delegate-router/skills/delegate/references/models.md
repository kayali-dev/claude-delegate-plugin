# Model Notes

Research snapshot: 2026-07-11. Model availability and pricing can change; query installed CLIs before relying on a model ID.

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

## Cursor Grok 4.5

Grok 4.5 is Cursor's broad frontier route for long-running creative tool use spanning software engineering, data science, finance, legal, research, and knowledge work. Its training emphasizes investigation, recovery, and verification. Use `grok-4.5-high` for the cost-balanced route and `grok-4.5-xhigh` for the hardest cases. Avoid Fast variants unless latency matters more than allowance.

Cursor disclosed that an earlier Cursor code snapshot entered training, so do not over-weight CursorBench when comparing it with other providers.

Source: https://cursor.com/blog/grok-4-5

## Cursor Composer 2.5+

Composer is Cursor's coding specialist for sustained multi-file changes, refactors, tests, and clear implementation work. Composer 2.5 improved long-running coding, complex instruction following, and effort calibration. Standard Composer is the default efficiency route; Fast costs materially more.

The adapter defaults to `composer-2.5`. Override `DELEGATE_CURSOR_COMPOSER_MODEL` when a later Composer ID is available. Run `agent models` or `cursor-agent models` to verify account-specific availability.

Sources: https://cursor.com/blog/composer-2-5 and https://cursor.com/blog/composer-2-technical-report

## Comparison Limits

Provider benchmark numbers are not directly interchangeable: the harness, tools, prompting, and available context differ. Route by task shape, verified local behavior, allowance headroom, and total coordination cost rather than declaring one universal winner.
