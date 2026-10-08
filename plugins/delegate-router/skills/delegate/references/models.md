# Model Notes

Reviewed against source and official provider documentation on 2026-10-08.
These are routing defaults; account catalogs, client versions, and provider
configuration determine availability. Explicit model IDs keep their generation.

## Current Routes

| Provider | Alias | Current selection | Role |
| --- | --- | --- | --- |
| Codex | `sol` | `gpt-6.1-sol` | Complex coding, debugging, review |
| Codex | `astra` | `gpt-6-astra` | Explicit escalation for the hardest work |
| Codex | `luna` | `gpt-6-luna` | Focused coding and high-volume bounded work |
| Codex | `terra` | `gpt-5.6-terra` | Retained cost-balanced coding tier |
| Claude | `opus` | Opus 5.5 on Anthropic | Complex reasoning and coordination |
| Claude | `sonnet` | Sonnet 5.5 on Anthropic | Daily coding and coordination |
| Claude | `haiku` | Haiku 5.5 on Anthropic | Simple bounded work |
| Claude | `fable` | Fable 5.1 on Anthropic | Explicit, authorized long-running work |
| Cursor | `composer` | Newest eligible non-fast Composer; currently 2.5 | Clear implementation |
| Cursor | `grok` / `grok-xhigh` | Newest advertised eligible tier; currently 4.7 | Sustained investigation and tool work |
| Cursor | `auto` | Account's Auto selection | Default for non-complex Cursor work |

The Codex aliases live in `bin/lib/models.mjs`. Full IDs such as `gpt-6-sol`,
`gpt-5.6-sol`, and `gpt-5.6-luna` pass through unchanged. `auto` leaves the
Codex model unset so its configuration wins. The router infers native providers
from full GPT, Claude, Composer, and Grok IDs; explicit `provider` still wins.
Managed starts require Codex or Cursor; Claude remains in-session or a built-in
agent. Disabled providers and quota gates apply to every model generation.

OpenAI currently recommends GPT-6.1 Sol for complex coding when available and
GPT-6 Luna for focused work. Astra is the most capable route. GPT-5.6 remains
available during rollout, which is why Terra and explicit older pins are kept.
An unavailable requested model is not automatically replaced. `ultra` is a
Codex subagent topology; GPT-6 Luna supports up to `max`, not `ultra`.
Sources: [Codex models](https://learn.chatgpt.com/docs/models),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), and
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Codex Runtime Preflight

Managed app-server jobs fetch `model/list` with bounded pagination and hidden
models included, caching only within that connection. Known unsupported model
IDs, reasoning efforts, or input modalities fail before `thread/start` or
`turn/start`; no model or effort is silently substituted. Incomplete, empty,
or unsupported catalogs remain explicitly unverified and leave final validation
to the provider. Discovery is not account entitlement or a successful inference.
Source: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

`maxSubagents` (CLI `--max-subagents`) is a Codex-only opt-in concurrent-child
limit, 0–16, excluding the primary agent; zero disables native subagents and a
positive value explicitly enables that limit. Omitting it preserves provider
configuration. It is inherited on Codex continuation and independent planning
jobs and is not a total-spawn or token-cost guarantee. Source:
[Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Claude Availability

Claude Code resolves its aliases for the configured provider; gateways and
cloud providers may resolve older versions. Full pins include
`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, and
`claude-fable-5-1`. Use Claude Code 2.1.293 or later for all those releases.
Fable billing depends on plan and seat tier. The router conservatively excludes
it from automatic candidates and sets `requiresAuthorization` on both its
alias and full IDs. Check the account's model picker before authorizing.
Source: [Claude model configuration](https://code.claude.com/docs/en/model-config).

## Cursor Catalogs And Pools

`agent models` or `cursor-agent models` supplies CLI IDs; managed ACP uses the
session's model config catalog, preferring `parameterizedModelPicker` values.
Composer/Grok aliases choose the newest eligible advertised version. Pins via
`DELEGATE_CURSOR_COMPOSER_MODEL`, `DELEGATE_CURSOR_GROK_MODEL`, or
`DELEGATE_CURSOR_GROK_XHIGH_MODEL` must exist when a CLI catalog is available.
A missing requested family/tier fails with `INVALID_MODEL`; an empty CLI
catalog uses the documented fallback IDs, leaving provider validation in place.

ACP can expose attributed IDs such as `grok-4.7[effort=high,fast=false]` while
CLI uses `cursor-grok-4.7-high`. Both shapes are supported. Base CLI IDs such as
`grok-4.7` are supported for the default high-effort alias. Fast is opt-in when
both forms exist. If ACP is fast-only, the adapter prefers a CLI-validated
non-fast headless fallback; with no such CLI model it records
`cursor:fast-fallback` rather than hiding the compromise. A missing ACP tier
may use headless only when the CLI advertises that exact tier, evented as
`cursor:acp-tier-fallback`. An active ACP session is never silently downgraded.

Cursor Models and Other Models are separate monthly pools. Composer and Grok
use Cursor Models; Auto can select third-party models and bill Other Models.
Pin Composer/Grok when first-party pool selection matters. Record dashboard
percentages manually; local tokens are not allowance. GPT selections through
Cursor remain blocked with `WRONG_LANE` while native Codex is enabled and below
its avoid band, unless explicitly requested with `overrideLane=true`.
Sources: [Cursor pricing](https://cursor.com/docs/models-and-pricing),
[Grok 4.7](https://cursor.com/docs/models/grok-4-7), and
[Composer 2.5](https://cursor.com/docs/models/cursor-composer-2-5).

## Lane Limits And Comparison

Model quality does not supply a missing transport capability. Only managed
Codex has same-turn steering, live shell stdout, and mid-turn token totals.
Cursor ACP has context occupancy and restart-only correction; headless has
terminal usage when reported, no context occupancy, and no pre-prompt pause.
All three support plan mode, MCP injection, and broker-owned worktrees on
supported builds. `delegate-health --capabilities` distinguishes no-turn probe
evidence from documentation declarations. Production ACP fs/terminal client
capabilities remain false; the health probe tests them separately.

Route by task shape, actual verification, headroom, and coordination cost.
Provider benchmarks and historical field observations are not interchangeable
rankings or current account-availability guarantees.
