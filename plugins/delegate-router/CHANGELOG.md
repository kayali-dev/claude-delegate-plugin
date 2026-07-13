# Changelog

All surfaces (skill, MCP servers, CLI) version together. The CLI resolves to the installed plugin on every run via `delegate-shim`; the skill and MCP servers pin at Claude Code session start — reload plugins after upgrading to align all surfaces. `delegate-health` prints the active installed version.

## 0.14.1 — 2026-07-13

- `delegate-health` human output leads with the active version and the surface-pinning rule.

## 0.14.0 — 2026-07-13

Field-report remediation (three independent coordinator evaluations).

- **Non-fast contract enforced end-to-end.** Live ACP catalogs can advertise `composer`/`grok` only as fast variants; the resolver now flags that compromise, and the adapter escapes to the headless transport with the CLI's non-fast id (`cursor:acp-tier-fallback`) or, when no non-fast form exists anywhere, proceeds fast with a loud `cursor:fast-fallback` event. Never silent.
- **`cursor:model-mismatch` event** when the session's `session_info_update` reports a different model than negotiated (previously overwrote `resolvedModel` silently).
- **`cursor-grok-4.5-*` id drift**: shorthands and headless resolution now match the CLI's `cursor-` prefixed Grok ids; regression fixtures pin the live catalog shapes.
- **`changedFiles` normalized and deduped**: absolute provider paths are rewritten repo-relative and merged, so one file is one entry.
- **`allowedPaths` scope fencing** on `delegate_start`/`delegate_resume` (`--allowed-paths` on CLI): the fence is injected into the worker prompt, and out-of-scope changed files are recorded as `scopeViolations` on the job plus a `scope.violation` event.
- **`waitForSession`** (`--wait-for-session`): block briefly until the provider session id is recorded, removing the race in gated/plan-filed delegation.
- **`resultText`** on terminal records: one normalized text field across Codex (string), Cursor ACP (`{text, plan}`), and Cursor headless (CLI envelope) result shapes.
- **`resultSuspect: 'short-final-message'`** on read-mode jobs whose final message looks like narration instead of findings — resume with "paste the full findings now".
- **`capabilities.selfEnforcesProjectHooks`**: Codex workers load trusted-project docs/hooks themselves; Cursor workers do not.
- **`delegate_diff paths` / `diff --paths`**: filter the unified diff to given path prefixes (e.g. the job's `allowedPaths`).
- **`delegate_list` chain grouping**: rows carry `session` and `rootJobId` so resume chains group.
- **`delegate-jobs start --wait`**: start and block to terminal state in one command.
- **`delegate-health`** prints the active version, a surface-pinning note, and explains Cursor's permanently-manual usage.
- This CHANGELOG.

Planned (recorded asks, not yet shipped): `startPaused`, broker-run post-completion verification gate (`verifyCommand`), out-of-tree file hand-off (`ingestFiles`), `delegate_start_batch` fan-out, automatic narration-turn nudge.

## 0.13.x — 2026-07-13

- `finishedPath` sentinel written on every terminal transition (background waiter processes can be reaped by the host harness; watch the sentinel instead).
- `reviewFlowEngaged` detection from collab-agent items; `delegate_resume` fails fast with `RESUME_UNSUPPORTED`.
- Security preamble permits project tooling to consume secrets internally (builds, tests, dev servers) while forbidding echoing contents.
- Doctrine: green checks are not a correctness gate for stateful/billing/auth work; adversarial review every round. (0.13.1: keep skill docs project-agnostic.)

## 0.12.0 — 2026-07-12

- `WRONG_LANE` guard: GPT models on `provider=cursor` are refused while Codex is enabled and under its avoid band; `overrideLane` for explicit user requests.
- Full MCP↔CLI parity for start/resume/list/events/diff options; positional-vs-flag-value parsing fixes.

## 0.11.x — 2026-07-12

- Per-job `sandbox=off` (Codex `danger-full-access`, Cursor `--sandbox disabled`) with coordinator judgment guidance; Codex web search auto-enables with network or full access. (0.11.1: document the Grok narration-turn pattern.)

## 0.10.0 — 2026-07-12

- Baseline content hashes: pre-existing dirty files the job never changed are excluded from diff/inventory/changedFiles; `overlapsPreexisting` flags mixed files.
- Cursor fast variants opt-in; router emits Cursor Auto for non-complex tasks with no user-named model.

## 0.9.0 — 2026-07-12

- Researched routing policy: Fable never auto-selected (`requiresAuthorization`), Sol@xhigh as the review/second-opinion configuration, model/effort guidance sections.

## 0.8.x — 2026-07-11

- Two-machine field-report remediation: fail-closed Cursor model resolution, `changedFiles` mechanical record, diff windowing/`statOnly`, `wait` exit 5, `RESUME_UNSUPPORTED` mapping, events size-cap, `list` alias. (0.8.1: normalize attribute-serialized catalogs; 0.8.2: headless fallback for ACP tier gaps; 0.8.3: plan-mode plans reach `result.plan`.)

## 0.7.x — 2026-07-11

- External security review remediation: security preamble always applied, streaming-delta redaction, state-write lock, per-cwd writer atomicity. (0.7.1: cursor-based journal reads; 0.7.2: `--effort` flag.)

## 0.5.0 – 0.6.0 — 2026-07-11

- Compliant allowance monitoring: Codex windows push-captured, Claude via status-line wrapper only (ToS), Cursor manual with TTL; stricter Cursor guard bands.

## 0.4.x — 2026-07-11

- Initial public release: managed job store, `delegate_list`, orphan reconcile, writer guard, per-job timeouts, transcript pagination, retention pruning, `delegate-jobs wait`; one-step marketplace install with self-provisioning shims.
