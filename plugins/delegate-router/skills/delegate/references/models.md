# Model Notes

Research snapshot: 2026-07-12 (Cursor plans verified 07-11; GPT-5.6 GA, Fable subscription status, and tier benchmarks verified 07-12). Model availability and pricing can change; query installed CLIs before relying on a model ID.

## Claude

- Fable 5 is Anthropic's most capable route for the hardest long-running work, broad knowledge, vision, science, and large autonomous software tasks — but **it is not included in subscription usage as of 2026-07-12**: it bills through opt-in usage credits at API-tier rates ($10/$50 per MTok), runs minutes-long turns, and applies stricter safety classifiers. Never auto-select it; the router refuses to, and explicit requests carry `requiresAuthorization` so the skill obtains per-task user approval first. Anthropic has said the removal is temporary ("once capacity allows"), with no date — re-verify before relying on this status.
- Opus 4.8 is the default hard-task route and the most capable subscription-included model: long-horizon agentic work, difficult debugging, review, architecture, memory.
- Sonnet 5 is the daily coding and coordination default — near-Opus quality on coding and agentic work at Sonnet cost.
- Haiku 4.5 is for deterministic, mechanical, precisely specified work only: it is explicitly weak on complex reasoning and large-codebase analysis, has a 200K context window (vs 1M for the rest of the family), and the oldest knowledge cutoff (2025-02). Never route judgment or ambiguity to it.

Sources: https://code.claude.com/docs/en/model-config, https://www.anthropic.com/news/claude-fable-5-mythos-5, https://www.bleepingcomputer.com/news/artificial-intelligence/claude-fable-5-isnt-permanently-leaving-subscriptions-anthropic-says/, https://theaicareerlab.com/blog/which-claude-model-should-you-use

## Codex GPT-5.6

GA across ChatGPT, Codex, and the API since 2026-07-09 (after a two-week limited preview).

- Sol is the escalation tier, not the default: security review, architecture, high-stakes changes, complex debugging, repository-wide refactors, and final judgment. Benchmarks show why it earns hard work: ~64% of repo tasks completed with zero trial-and-error (vs ~41% for Terra), and roughly 21k output tokens per completed task vs Terra's ~56k — on difficult agentic work Sol is often both better and cheaper than its 2x sticker price suggests. At `effort=xhigh` it is exceptionally strong at surfacing issues, gaps, and bugs — the first-choice configuration for review sessions and independent second opinions (field-verified by this plugin's own external reviews).
- Terra is the daily external default: routine feature development, straightforward multi-file coding, technical writing, ordinary review. Markedly chattier per task than Sol — measure before assuming the lower price wins on long runs.
- Luna is for high-volume, well-scoped, low-risk work: summarizing, labeling, extraction, scaffolds, simple fixes.
- `max` effort is for unusually hard single-agent work; compare against `xhigh` before adopting. `ultra` is a different topology, not a bigger max: Codex delegates to parallel internal agents and synthesizes, multiplying token spend by design — only for genuinely independent parallelizable workstreams with explicit budget acceptance.

Sources: https://openai.com/index/gpt-5-6/, https://www.vellum.ai/blog/gpt-5-6-benchmarks-explained, https://www.coderabbit.ai/blog/gpt-5-6-sol-and-terra-benchmark, https://www.toolcolumn.com/learn/gpt-5-6-max-vs-ultra

## Cursor Plans And Pools

Cursor subscriptions (Pro $20, Pro+ $60, Ultra $200 per month; Teams Standard $40 and Premium $120 per user) meter usage in two separate monthly pools:

- **First-party pool**: Auto, Composer 2.5, and Grok 4.5 draw from a dedicated, more generous allocation. This is the pool Delegate Router consumes, because it routes to Composer and Grok.
- **API pool**: third-party models charged at API price against a tier-based inclusion ($20 / $70 / $400).

Both pools are token-metered at per-model rates, so model choice changes how fast the shared first-party pool drains: Grok 4.5 ($2/$6 per 1M in/out) consumes it roughly 3-4x faster than Composer 2.5 ($0.5/$2.5). There are no five-hour or weekly windows; the cycle is monthly, and exhausted included usage falls through to on-demand billing rather than a hard block.

Track the **first-party pool** percentage from the dashboard: `delegate-usage set cursor <percent> --window first-party --source dashboard --reset <cycle-end-epoch>`.

**Auto mode** (`auto`, advertised as `default[]` over ACP) lets Cursor route within the first-party pool itself and is the default for non-complex Cursor tasks when the user has not named a model — the router emits it in that case. Pin `composer` or `grok` explicitly when the task is complex or consistent single-model behavior matters.

**Fast variants are opt-in.** When a catalog advertises fast and non-fast forms of the same model, resolution defaults to non-fast; a fast variant is selected only when the request itself says fast (`composer-2.5-fast`, `grok-fast`, `grok-4.5-fast-high`, or an exact attributed token with `fast=true`). Never choose fast on the user's behalf — it trades allowance for latency.

Sources: https://cursor.com/docs/models-and-pricing and https://forum.cursor.com/t/grok-4-5-pricing-for-subscription-plans/165207

## Cursor Grok 4.5

Grok 4.5 is Cursor's broad frontier route for long-running creative tool use spanning software engineering, data science, finance, legal, research, and knowledge work. Its training emphasizes investigation, recovery, and verification, and it substantially outscores Composer on agentic benchmarks (SWE-Bench Pro ~65% vs ~54%) with a larger context window (500K vs 200K). It is subscription-included as a first-party model, but drains the shared first-party pool several times faster than Composer — reserve it for work that needs its breadth. Use `grok-4.5-high` for the cost-balanced route and `grok-4.5-xhigh` for the hardest cases. Avoid Fast variants unless latency matters more than allowance. On review tasks Grok has twice ended its first turn narrating that it was "filing the scan report" without pasting the findings — instruct it to inline the findings in its final message, and expect an occasional `delegate_resume` nudge.

ACP sessions may advertise fewer Grok tiers than the CLI catalog (observed: ACP capped at `effort=high` while `agent models` lists `-xhigh`). When a requested tier is missing from the ACP catalog but present in the CLI catalog, the managed adapter automatically switches that job to the headless transport with the CLI-validated id — evented as `cursor:acp-tier-fallback`, with correction semantics degrading to cancel-and-resume for that job.

Cursor disclosed that an earlier Cursor code snapshot entered training, so do not over-weight CursorBench when comparing it with other providers.

Source: https://cursor.com/blog/grok-4-5

## Cursor Composer 2.5+

Composer is Cursor's coding specialist for sustained multi-file changes, refactors, tests, and clear implementation work — and it beats Grok on web-framework evals (Next.js-style ~92% vs ~83%) and multilingual code, at roughly a quarter of Grok's token cost. Composer 2.5 improved long-running coding, complex instruction following, and effort calibration. It is subscription-included as a first-party model and is the cheapest draw on the shared first-party pool, which makes it the default efficiency route; Fast costs materially more.

The adapter defaults to `composer-2.5`. Override `DELEGATE_CURSOR_COMPOSER_MODEL` when a later Composer ID is available. `agent models` (or `cursor-agent models`) is the source of truth for account-specific ids: catalogs expose fully-qualified tier ids (for example `grok-4.5-high`, `grok-4.5-xhigh`, `composer-2.5`) and may include cross-provider models. ACP sessions advertise the same models as attribute-serialized values (`grok-4.5[effort=high,fast=true]`); the managed adapter normalizes both forms, so suffixed ids, bare bases, full attributed tokens, and the shorthands `composer`, `grok`, and `grok-xhigh` all resolve against the session's advertised list. Anything unmatched fails closed with `INVALID_MODEL`, and the resolved advertised value is recorded on the job as `resolvedModel`. The ids recommended in this file are pinned by a regression test against a realistic attributed catalog so docs and matcher cannot drift apart.

Sources: https://cursor.com/blog/composer-2-5 and https://cursor.com/blog/composer-2-technical-report

## Comparison Limits

Provider benchmark numbers are not directly interchangeable: the harness, tools, prompting, and available context differ. Route by task shape, verified local behavior, allowance headroom, and total coordination cost rather than declaring one universal winner.
