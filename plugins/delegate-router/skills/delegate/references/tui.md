# Delegate TUI

`delegate-tui` is a zero-dependency ANSI dashboard over Delegate Router's existing local job store, read-only remote exports, or a federated mix of both. It does not start providers on launch and it does not write job or usage files directly. In local mode, its control actions call the same broker functions as `delegate-jobs`, including optimistic revisions, dry-run revert planning, provider-aware cancellation, and ordinary launch admission. Remote rows disable every control; a remote-only fleet disables the launcher too.

## Launch

Start it from an interactive macOS or Linux terminal:

```bash
delegate-tui
```

Open a known job directly in detail view with `delegate-tui --job <id>`. An unknown id is rejected before terminal initialization with exit 1.

From a source checkout, use `node bin/delegate-tui`. `DELEGATE_STATE_FILE`, `DELEGATE_ENABLED_PROVIDERS`, provider configuration, allowance guard bands, profile directories, and the ordinary state-directory defaults are honored. `node bin/delegate-tui --help` prints usage without switching terminal screens. If stdout is not a TTY, the command exits 2 without emitting terminal escapes.

At startup the TUI measures a bounded set of width-sensitive graphemes with terminal cursor-position reports. Successful measurements are cached in private `<state-dir>/tui-prefs.json` entries keyed by `TERM`, terminal program/version, and whether tmux is interposed; saves merge per-identity measurements so concurrent local and SSH/tmux sessions cannot clobber one another. `DELEGATE_TUI_WIDTH_PROBE=off` skips the measurement, while `verbose` records the satisfying foreground/background phase, final family verdicts, measured table, and elapsed time in the `M` status-history overlay. A short foreground deadline keeps the first frame prompt with conservative glyphs, then an input-safe background continuation waits patiently for delayed tmux-over-SSH replies and atomically upgrades glyphs, cache, and screen when the batch arrives. If that continuation expires or is cancelled, a passive ten-second filter swallows only late cursor-position replies addressed to the probe row; every other input byte passes through in order, and the filter removes itself completely after the grace window. On an interactive terminal the TUI also requests synchronized frame output, bracketed paste, and focus reporting. Unsupported modes are ignored by the terminal; every requested mode is disabled before suspend or exit. Bracketed multi-line input is inserted as literal text, and spinner/clock animation pauses while the terminal is unfocused.

The probe covers the complete visual chrome set: pane rails, floating-overlay borders, scrollbar track/thumb, braille spinner frames, eighth-block meters, sparklines, separators, truncation, selection markers, and tool/status glyphs. Each glyph has three tiers: probe-gated elegant, statically width-certain Unicode, and ASCII. The elegant candidate is used only after the active terminal layer reports width 1 for every grapheme in that candidate. `DELEGATE_TUI_ASCII=1` forces the final tier for troubleshooting, recordings, and minimal terminals.

For a reproducible rendering trace, launch with `DELEGATE_TUI_DIAG=/private/path delegate-tui`. Press `Ctrl-G` immediately after seeing corruption. The recorder stores terminal bytes and compact intended grids in that directory with private permissions; analyze them without a TTY using `delegate-tui --analyze /private/path`. An agreement verdict means the emitted bytes paint the intended grid in the bundled VT replay model, while a writer-bug verdict names the first differing cell and prints a bounded hex/ASCII byte window.

### Running under tmux

tmux is an intermediate VT interpreter with its own character-width tables. Ghostty (or another outer terminal) may therefore render the same grapheme differently inside and outside tmux. Cursor-position replies inside tmux measure tmux, which is the layer the TUI must agree with, and the cache identity includes tmux presence so an outer-terminal result is never reused in a tmux session. Old tmux releases and mixed locale/Unicode-table configurations can still disagree on newer emoji, variation selectors, ZWJ sequences, modifiers, and East-Asian-ambiguous symbols.

The renderer uses four defenses. Self-generated chrome is selected centrally: measured elegant glyphs when the interposed terminal proves them single-width, otherwise statically certain Unicode or ASCII. Raw components never embed ambiguous punctuation or box drawing directly. The static suspect table includes every Ambiguous range from Unicode 17 `EastAsianWidth.txt`, while runtime measurements correct probed graphemes for the active terminal layer. Arbitrary transcript graphemes are emitted as isolated absolute-positioned runs and followed by an absolute guard-cell repaint so their implicit cursor advance cannot displace neighboring ASCII. The adversarial VT regression suite deliberately renders every Ambiguous code point wide and permits differences only in the suspect glyph's own cells.

## Remote

Export the job store on the machine that owns it:

```bash
delegate-tui --serve
```

The server is hard-bound to `127.0.0.1` on port 4263 by default; `--port N` changes only the port. It refuses non-loopback bind requests and intentionally sends no CORS headers. The first launch generates a 32-byte bearer token at `<state-dir>/serve-token` with mode `0600` and prints it once with connection instructions. Later launches reuse the private file without printing the token. `DELEGATE_SERVE_TOKEN` is an in-memory override intended for controlled automation and tests.

For another machine, tunnel the loopback listener over SSH rather than exposing it on a network interface:

```bash
ssh -L 4263:127.0.0.1:4263 host
```

Then, in another terminal on the client machine, connect through the tunnel using either a private token file or the environment:

```bash
delegate-tui --connect http://127.0.0.1:4263 --token-file /private/path/to/serve-token
# or
DELEGATE_CONNECT_TOKEN='<printed token>' delegate-tui --connect http://127.0.0.1:4263
```

The header includes `[remote]` and the connected host, and Fleet adds a Host column when space permits. Fleet data polls every five seconds; the selected job follows its event journal over SSE. Connection loss remains in the status line and retries automatically with bounded backoff instead of terminating the dashboard.

The export is read-only by construction: it exposes authenticated GET health, jobs, event pages/streams, transcript, bounded diff, job/provider usage, coordinator-session, and aggregate-stat reads only. It accepts job ids and bounded repository-relative diff selectors, never server filesystem paths. Steer, resume, release, nudge, review round, cancel, revert, and launcher keys report `read-only remote` and do nothing.

The one-remote form above is unchanged. For a federated view, open one SSH tunnel per host and repeat `--connect`; repeat `--token-file` in the same order. `DELEGATE_CONNECT_TOKEN` is the fallback for every target without a paired token file. Add `--include-local` when the machine running the TUI should appear beside the remotes:

```bash
ssh -L 4263:127.0.0.1:4263 build-a
ssh -L 4264:127.0.0.1:4263 build-b
delegate-tui \
  --connect http://127.0.0.1:4263 --token-file /private/build-a.token \
  --connect http://127.0.0.1:4264 --token-file /private/build-b.token \
  --include-local
```

The optional private `<state-dir>/remotes.json` avoids repeating stable targets:

```json
[
  { "url": "http://127.0.0.1:4263", "tokenFile": "/private/build-a.token", "label": "build-a" },
  { "url": "http://127.0.0.1:4264", "tokenFile": "/private/build-b.token", "label": "build-b" }
]
```

CLI targets merge with that file and win when URLs conflict. Labels are redacted and bounded; otherwise the Host cell uses URL `host:port`. Each host has its own app-bar connection chip and bounded retry state. One failed host turns only its chip red, keeps the other hosts live, and ages its last rows out after the configured stale interval. Every remote row remains read-only, including external Codex rows and Claude Agent stubs returned by that host. Federation changes neither the loopback bind nor bearer-authentication model.

## Screens

- **Dashboard** is the default, attention-first home. The first pane contains jobs that need a person: approval or input waits, acceptance blockers, stalls, scope violations, suspect results, and budget stops. Enter opens the selected job. Four compact tiles summarize running/paused work, today's jobs and success rate, today's tokens, and mean cache hit; 14-day jobs/day and mean-duration sparklines sit beside the corresponding values. Provider meters and the last 15 notable cross-job audit/journal events complete the overview. `F` opens the complete Fleet and `Esc` walks back toward Dashboard.
- **Fleet** sorts active jobs before terminal jobs, then by recent activity. It shows provider, cwd basename, model, routed effort, mode, transport-honest live activity, elapsed time, output-token budget, continuation/group markers, safety badges, provider allowance, current shared-worktree writer ownership, and a Host column for federation. Shadow jobs carry a `direct` badge; a write-capable direct launch overlapping an active managed writer also carries `writer!`. Proven tool-originated external Codex sessions are dimmed with an `external` badge; the `x` action menu hides or restores them and they are shown by default. Claude hook stubs carry an `agent` badge. The full cwd remains in the detail header; compact density drops Directory, Effort, and then Host by width priority. Activity can identify approval/input waits, context compaction, an active provider subagent, an open tool, thinking, streaming, broker phases, quiet time, and stalls only when that transport exposes the corresponding signal.
- **Groups** aggregates jobs by `groupId`, with member/running/terminal/stalled counts, newest activity, and the all-terminal barrier state. Enter opens that group's members in the ordinary fleet row format.
- **Sessions** is a read-only, best-effort overview of Claude Code coordinator sessions around the managed fleet. It reads only the newest 64 KiB of at most 200 recently modified `~/.claude/projects/<encoded-cwd>/*.jsonl` files, shows active/idle age, project cwd, approximate size, one redacted activity label, active managed-job count by exact cwd, and existing managed writer ownership. It never opens a transcript. Enter filters Fleet to the selected cwd; `Esc` clears the Fleet filter.
- **Job detail** has Transcript, Diff, Record, Usage, and Events tabs. A sixth Chain tab appears for a root with children or a resumed child; it orders rounds and shows changed-file count, verification exit, objective/suspicion markers, and the first outcome line. Enter on a chain round jumps to that job. The Record view includes additive verification-profile provenance, verification state, and acceptance evidence when present; historical records without those fields continue to render. The detail header always shows the current transport-honest activity. Transcript is a coalesced conversation: message deltas form one live block, completed text replaces its deltas, the latest plan replaces older plans, provider noise is omitted, and tool start/status/output/completion events form one expandable line. Provider subagents form equivalent provider-neutral blocks with their task, tiered status glyph, terminal duration, and expandable bounded output; unknown provider items use generic labeled blocks with compact summaries and expandable JSON. Metadata-only legacy items render an explicit payload-not-captured explanation. External Codex detail reads only a 64 KiB redacted tail of its source file; Claude Agent detail applies the same bound to its derivable subagent transcript. A selected read-only transcript is re-read on the ordinary refresh cadence only when its mtime or size changes, so follow mode remains live without polling unselected rows. Claude Agent transcript linkage is retried when detail opens and while it remains selected; a resolved path is saved back to the stub without a revision transition. If the coordinator transcript path was unavailable to the hook, discovery stays inside the stub cwd's encoded Claude project directory and checks at most eight newest session sidecars. An unresolved transcript shows an explicit retry explanation instead of a blank pane. Neither observed transport opens a complete external transcript and neither enables Diff or controls. Each managed Codex or Cursor file change is a separate compact cwd-relative edit line with green `+A`, red `−R`, and rename/delete labels; counts are absent when unknowable. ACP restored events collapse under one `restored history` row; replay never drives the live thinking/tool state. Network preflight/elevation, input waits, mode/model/session changes, and artifacts render as bounded typed notices. Events remains the raw normalized stream. Diff starts with per-file stats; Enter opens one file's windowed hunks. Usage labels provider tokens/output budget separately from ACP context occupancy and continuation-chain totals.

Every secondary pane begins with a one-line quantity/anomaly summary. Record,
Usage, Chain, and launcher review share one humanized key/value grid across all
of their sections; missing values render as a dim dash and anomalous sections
carry a header badge. Transcript and Events use fixed time, structural rail,
content, and right-aligned measure zones, so tool/subagent nesting and exit
codes remain scannable in `NO_COLOR` and ASCII mode. Opened diffs retain the
index stat in a file band, use stable old/new line gutters, replace raw hunk
coordinates with an enclosing-symbol hint, tint the full changed row, and
emphasize only the changed portion of paired removal/addition lines.
- **Providers** shows enabled state, allowance windows, colored warning/avoid bands, deep-health `lastVerified` data when available, active writer jobs grouped by cwd, and a subtle aggregate `~Npp outside tracked` note when capture history contains an unattributed Codex allowance marker. That note never links to a thread and is explicitly approximate.
- **Stats** renders the never-pruned audit-log aggregation for the last seven days, grouped by provider/model/mode/transport, plus external thread totals and aggregate-only unattributed allowance markers. `/` incrementally filters the already-loaded audit rows without touching the store.
- **Launcher** starts in the existing hand-written packet mode and also offers
  sentence, current diff, failing output, TODO, JSON task-record, and
  repository-conventions intent sources. Intent mode adds acceptance,
  wall-time, round, and output-token fields beside the explicit allowed-path
  fence and verification command. Press `d` to compile and render the same
  provenance/confidence WorkSpec card as the CLI above the exact provider
  packet. Unresolved or low-confidence fields keep launch disabled; a complete
  card still requires the launch confirmation overlay. The compiler never
  turns inferred scope into allowed paths or infers network, sandbox-off,
  privilege, or budget increases. Profiles remain for hand-written packet mode
  only. The route-advisor pane recomputes after form changes and remains
  advisory. Press `e` to edit the packet/intent body in `$VISUAL` or `$EDITOR`;
  `y` always yanks the focused value.

`$VISUAL`/`$EDITOR` handoff writes only a private `0600` scratch file under the Delegate Router state directory. Before terminal ownership moves to the editor, an active background width probe is cancelled without applying partial measurements and releases its CPR check listener. The TUI then disables raw mode and mouse reporting and leaves the alternate screen before spawning the editor, reinitializes the terminal afterward, and fully repaints. A signalled or nonzero editor leaves the previous packet body unchanged; when neither variable is set, editing stays inline.

Transcript, Events, and an opened Diff file support case-insensitive `/` search over logical lines. Matches use the palette's search background, the title shows the current/total counter, and `n`/`N` unconditionally mean next/previous match with automatic scroll. Without an active search they explain how to start one; narration nudge lives in the `x` action menu. `Esc` clears the search. Search hit mapping composes with the virtualized wrap cache rather than wrapping the complete journal.

Transcript tool lines prefer the richest already-redacted journal fields: commands and exit codes, file basenames and change kinds, MCP server/tool names, Cursor titles/locations, durations, and output-line counts. `Enter` expands the focused tool to its full wrapped command, a differing cwd, file list, and last approximately 20 output lines. File-change lines are individually selectable/clickable and use the same glyph-tier fallbacks as tools. `d` opens Diff filtered to the focused tool or file-change path; `Esc` clears the filter. `E` jumps to the corresponding raw Events position on a best-effort sequence mapping.

Subagent lifecycle blocks use the same expansion and width authority as tool blocks. The label comes from the job provider (`Codex agent`, `Cursor agent`, or a neutral fallback), never from the transport-specific event shape. An unmatched legacy `subagent.activity` or `provider.event` item stub remains visible with a question glyph and a statement that its recorder version did not capture payload content; the TUI never reconstructs missing output.

Codex context compaction appears between conversation blocks as a one-line system marker with a spinner while active and elapsed duration when complete. While its start has no matching completion, Fleet and the detail header report the animated `compacting` state instead of quiet/idle; the same normalization recognizes older journals whose lifecycle exists only as `provider.event` context-compaction items.

### Visual and interaction principles

- **Attention first:** actionable amber/red states lead Dashboard, Fleet badges, and the detail header. Decorative chrome stays quiet.
- **Progressive disclosure:** Dashboard answers “what needs me?”, Fleet shows everything, Detail explains one job, and Events exposes the raw normalized stream. `Esc` walks back one level and the app-bar breadcrumb shows the current level.
- **Focus and one accent:** every pane is a tinted surface with a persistent left rail. Only the focused pane gets the accent rail; resting rails use the subtle border weight. The same accent is reserved for the left-edge selection marker, active-tab underline, and footer keys; status colors remain semantic.
- **Breathing room:** panes use two columns and one row of inner padding, table columns keep at least two cells between them, and scrollbars retain a one-column margin. Sections have one blank row above 30 terminal rows and reclaim it at 30 or fewer. Full rectangles are reserved for floating overlays.
- **Stable rhythm:** titles, summaries, section labels, and rows share one content-left column per pane. Selection, glyph, and diff-marker gutters are permanently reserved, so moving focus never shifts content.
- **Contextual help:** the footer contains only actions valid for the current screen. `?` starts with the current screen and pages by action class through the complete registry; `x` opens contextual actions and leaves unavailable entries visible with a reason.
- **No dead ends:** empty panes say what fills them, such as `g l to launch a job` or `F to open Fleet`.

### Activity visibility by transport

The activity derivation uses this capability table; a missing capability means “not exposed”, never “not happening”. Content-free `activity` markers record only thinking/output transitions and never reasoning text.

| Transport | Visible activity signals |
| --- | --- |
| Codex app-server | Context compaction, provider subagents, thinking, streaming, command/MCP/file tools, approval, required input, broker phase, quiet, stalled |
| Codex direct MCP | Context compaction, provider subagents, thinking, streaming, command/MCP/file tools, plan, usage, broker phase, quiet, stalled |
| Cursor ACP | Provider subagents, thinking, streaming, titled/location-bearing tools, approval, required input, broker phase, quiet, stalled |
| Cursor headless | Provider subagents when stream-json exposes them, thinking markers, streaming assistant text, structured tool starts/completions, broker phase, quiet, stalled, terminal status; no approval/input callback signal |
| Claude Agent stub | Hook-derived foreground terminal state or background spawn-return state plus a bounded redacted subagent transcript tail when its path is derivable. Claude Code exposes no background completion signal to this hook, so background rows use transcript-mtime `active`/`idle` state and age instead of fabricating completion. |
| External Codex | Bounded redacted session tail only; metadata-proven tool origin, never live control |

Cursor headless thinking/tool state comes only from actual stream-json events; the TUI never infers approval or input waits that transport cannot produce. Thought text is never persisted or displayed.

Direct-shadow detail views otherwise render like managed jobs, including Directory and Effort columns, normalized transcript edit lines, diff/files, and usage. Mutation keys (`s`, `c`, `r`, `R`, `n`, and review/respond actions) do nothing and put `read-only: direct-transport job` in the status line because the launching caller owns the loop.

## Keys

<!-- BEGIN GENERATED KEYMAP -->
| Key | Action | Scope |
| --- | --- | --- |
| `?` | keys | global |
| `Esc` | back | global |
| `q` | quit | global |
| `Ctrl-C` | quit | global |
| `Up Down` | previous / next item | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `j k` | next / previous item | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Mouse wheel` | scroll viewport | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Mouse click` | select / open | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `PgUp PgDn` | previous / next viewport | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Ctrl-U` | previous viewport | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Ctrl-D` | next viewport | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `g G` | top / bottom | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Home End` | top / bottom alias | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Tab` | next pane | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Shift-Tab` | previous pane | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `Enter` | open / edit / expand | dashboard, fleet, groups, group-members, sessions, providers, stats, launcher, detail |
| `/` | filter / search | fleet, group-members, stats, detail |
| `n N` | next / previous match | global |
| `[ ]` | previous / next tab | detail |
| `1 … 6` | open tab by number | detail |
| `g f` | go to Fleet | global |
| `F` | open Fleet alias | global |
| `g r` | go to groups | global |
| `g s` | go to sessions | global |
| `g p` | go to providers | global |
| `g t` | go to stats | global |
| `g l` | go to launcher | global |
| `s` | steer | detail |
| `a` | answer worker question | detail |
| `r` | resume | detail |
| `R` | release paused start | detail |
| `w` | review round | detail |
| `x menu` | nudge suspicious result | detail |
| `c` | cancel | detail |
| `v` | safe revert | detail |
| `x` | actions | global |
| `x menu` | toggle external threads | fleet |
| `a` | active jobs only | fleet |
| `o` | cycle Fleet sort | fleet |
| `z` | toggle Fleet density | fleet |
| `f` | toggle follow | detail |
| `E` | jump to raw Events | detail |
| `d` | open focused Diff | detail |
| `Left Right` | previous / next choice or diff page | launcher, detail |
| `e` | edit packet body | launcher |
| `d` | dry run, then confirm launch | launcher |
| `y` | yank focused value | global |
| `t T` | toggle timestamp mode | global |
| `b` | toggle notifications | global |
| `M` | status-message history | global |
| `Ctrl-G` | mark diagnostic frame | global |
<!-- END GENERATED KEYMAP -->

`g` still jumps to the top and also arms the 300 ms navigation prefix: `g f`
Fleet, `g r` groups, `g s` sessions, `g p` providers, `g t` stats, and `g l`
launcher. `G` is bottom; `F` remains the documented Fleet alias. The first use
of a moved legacy key reports its replacement in the status line.

Revision conflicts and all other typed broker errors stay in the status line; they do not terminate the TUI. Cancellation is shown as queued until the provider acknowledges or its process exits. Revert can touch only the safe subset reported by the existing broker helper.

When a managed worker is in `user-input-required`, open its detail view and
press `a` to answer inline. The action re-reads the live revision and pending
request ID before queuing the response, so a stale detail frame cannot
overwrite a newer coordinator decision. The question notice shows the same
normalized redacted text for Codex, Cursor ACP, and Cursor headless; raw Events
contains its bounded stuck context, diff so far, and considered options.

## Themes and notifications

The default perceptual palette targets dark terminals. Set
`DELEGATE_TUI_THEME` to `dark`, `light`, `dark-daltonized`,
`light-daltonized`, `dark-ansi`, or `light-ansi` before launch. The existing
`dark` and `light` values remain compatible. Daltonized presets replace
red/green semantic pairs with blue/yellow; the `-ansi` presets emit no
foreground or background colour and inherit the terminal theme. `NO_COLOR`
also removes colour from any preset while retaining structural bold, dim, and
underline styling. Truecolor terminals receive the authored OKLCH-derived
sRGB values; other coloured terminals receive mechanically derived 256-colour
indices.

The persisted `theme` preference also accepts a custom object with a preset
`base` and OKLCH `overrides`, for example
`{"base":"dark","overrides":{"accent":[0.68,0.09,195]}}`. Overrides are keyed
by semantic token name. Unknown tokens and invalid OKLCH values are ignored, so
a typo cannot break rendering.

While the TUI is running, terminal transitions, new stalls, recorded scope violations, and budget stops can send a desktop notification through `osascript` on macOS or `notify-send` on Linux. Dispatch is non-blocking, missing platform commands are ignored, and each job is limited to one notification per five seconds. Notification text contains only the job id, status, provider, and event kind—never prompt, transcript, result, path, or diff content. Press `b` to toggle the session; `DELEGATE_TUI_NOTIFY=0` disables notifications entirely.

Separately, interactive Claude Code sessions can receive the experimental
plugin push bridge without opening the TUI. `delegate-monitor` emits only
redacted actionable transitions (live collision detected, breach, input,
acceptance-blocked, review-ready, failure, stall)
and observes the same existing store without mutating jobs. Push defaults to
the launching Claude session via a private SessionStart correlation marker.
Set `DELEGATE_MONITOR_SCOPE=workspace` to widen to the current
worktree/project or `all` for a fleet overview. Correlation failure is recorded
and emitted once before workspace fallback; it never guesses. Scope affects
push only—Fleet and every detail/control view remain complete.
`DELEGATE_MONITOR=0` or scope `off` disables that bridge;
`<state-dir>/monitor.json` with a future `snoozeUntil` suppresses non-breach
edges. Deduplication, cooldown, and a global rate ceiling are the nagware
boundary. Unsupported/non-interactive hosts continue to use `delegate_inspect`,
this TUI, and `finishedPath` exactly as before.

Live collision edges come from separate fail-open hooks: SessionStart arms the
attempt's owned paths, FileChanged observes watched touches, and
PostToolUse(Edit|Write)/PostToolBatch cover successful coordinator edits. A
collision follows the same session/workspace/all scope as other push edges and
marks applicable verification stale. The dynamic set is capped at 256 paths
including its private refresh signal; cap overflow or watcher failure is
recorded as degraded and retains coordinator-hook plus post-hoc detection.
This is early detection only. It does not prevent or isolate the write; P6
transactional workspaces are the containment boundary.

## Limitations

- The TUI supports macOS and Linux terminals, not Windows. SGR button press and wheel input are supported; drag/motion gestures are not.
- Claude coordinator-session discovery is best-effort because the Claude Code JSONL format and encoded project-directory convention are not stable interfaces. Missing, unreadable, truncated, malformed, or oversized transcript content is skipped; a missing/unreadable projects directory produces one explanatory line and does not affect managed-job views. `DELEGATE_CLAUDE_PROJECTS_DIR` overrides the projects root and `DELEGATE_SESSION_ACTIVE_SECONDS` overrides the default 300-second active window. Files are rescanned every ten seconds and on project-directory watch events when available.
- External Codex discovery is also best-effort. On the observed CLI layout it reads only the first metadata line and newest 64 KiB from at most 200 recent `~/.codex/sessions/YYYY/MM/DD/*.jsonl` files. Stable thread/session ids collapse repeated rollout files and exclude broker-owned records. Only persisted originator/source values that prove app-server, MCP, companion, delegate-router, or structured subagent origin are admitted; interactive CLI sessions and unknown provenance are personal-by-default and never appear. Missing, changed, malformed, or unreadable layouts degrade to no external rows without affecting broker jobs.
- Inline launcher and review input remains single-line; use `$VISUAL`/`$EDITOR` for multi-line text.
- Unicode width remains terminal-dependent, especially through tmux. Width-suspect content is confined with absolute cursor placement and guard repainting; a terminal may clip the suspect glyph itself, but it cannot leave following ordinary text displaced. The optional probe improves the glyph itself when CPR is supported.
- The dashboard consumes already-redacted broker records, journals, audit rows, and diff artifacts. Coordinator ingestion extracts only bounded metadata and one shared-redactor-filtered tail label; it does not expose transcript viewing or ingest raw provider payloads.
- Cursor still has no live shell stdout: headless and ACP tool output appears only when Cursor emits completion data. Headless exposes thinking markers and structured tool lifecycle, but not approval/input callbacks; hidden thought text is never retained.
- Remote export and federation are read-only. They are not a multi-tenant service: every source must remain behind its own documented loopback listener, bearer token, and SSH tunnel.
- Shared-worktree changed-file attribution remains best-effort, exactly as in the broker. Writer ownership shown by the TUI covers managed shared-worktree jobs, not unmanaged editors.
- Dangerous launch overrides (`overrideWriter`, sandbox off, and forced approval) are intentionally absent. Use the explicit CLI/MCP paths with the required user authorization when those exceptional controls are necessary.
