# Delegate TUI

`delegate-tui` is a zero-dependency ANSI dashboard over Delegate Router's existing local job store or one read-only remote export. It does not start providers on launch and it does not write job or usage files directly. In local mode, its control actions call the same broker functions as `delegate-jobs`, including optimistic revisions, dry-run revert planning, provider-aware cancellation, and ordinary launch admission. Remote mode disables every control and launcher action.

## Launch

Start it from an interactive macOS or Linux terminal:

```bash
delegate-tui
```

Open a known job directly in detail view with `delegate-tui --job <id>`. An unknown id is rejected before terminal initialization with exit 1.

From a source checkout, use `node bin/delegate-tui`. `DELEGATE_STATE_FILE`, `DELEGATE_ENABLED_PROVIDERS`, provider configuration, allowance guard bands, profile directories, and the ordinary state-directory defaults are honored. `node bin/delegate-tui --help` prints usage without switching terminal screens. If stdout is not a TTY, the command exits 2 without emitting terminal escapes.

At startup the TUI measures a bounded set of width-sensitive graphemes with terminal cursor-position reports. Successful measurements are cached in private `<state-dir>/tui-prefs.json` entries keyed by `TERM`, terminal program/version, and whether tmux is interposed; saves merge per-identity measurements so concurrent local and SSH/tmux sessions cannot clobber one another. `DELEGATE_TUI_WIDTH_PROBE=off` skips the measurement, while `verbose` records the satisfying foreground/background phase, final family verdicts, measured table, and elapsed time in the `M` status-history overlay. A short foreground deadline keeps the first frame prompt with conservative glyphs, then an input-safe background continuation waits patiently for delayed tmux-over-SSH replies and atomically upgrades glyphs, cache, and screen when the batch arrives. If that continuation expires or is cancelled, a passive ten-second filter swallows only late cursor-position replies addressed to the probe row; every other input byte passes through in order, and the filter removes itself completely after the grace window.

The probe covers the complete visual chrome set: light and rounded borders, scrollbar track/thumb, braille spinner frames, eighth-block meters, sparklines, separators, truncation, selection markers, and tool/status glyphs. Each glyph has three tiers: probe-gated elegant, statically width-certain Unicode, and ASCII. The elegant candidate is used only after the active terminal layer reports width 1 for every grapheme in that candidate. `DELEGATE_TUI_ASCII=1` forces the final tier for troubleshooting, recordings, and minimal terminals.

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

Remote federation is one host at a time in this version. A combined fleet spanning several `--connect` targets is future work.

## Screens

- **Dashboard** is the default, attention-first home. The first pane contains jobs that need a person: approval or input waits, stalls, scope violations, suspect results, and budget stops. Enter opens the selected job. Four compact tiles summarize running/paused work, today's jobs and success rate, today's tokens, and mean cache hit; 14-day jobs/day and mean-duration sparklines sit beside the corresponding values. Provider meters and the last 15 notable cross-job audit/journal events complete the overview. `F` opens the complete Fleet and `Esc` walks back toward Dashboard.
- **Fleet** sorts active jobs before terminal jobs, then by recent activity. It shows provider/model/mode, transport-honest live activity, elapsed time, output-token budget, continuation/group markers, safety badges, provider allowance, and current shared-worktree writer ownership. Activity can identify approval/input waits, context compaction, an open tool, thinking, streaming, broker phases, quiet time, and stalls only when that transport exposes the corresponding signal. Remote mode also shows the connected host.
- **Groups** aggregates jobs by `groupId`, with member/running/terminal/stalled counts, newest activity, and the all-terminal barrier state. Enter opens that group's members in the ordinary fleet row format.
- **Sessions** is a read-only, best-effort overview of Claude Code coordinator sessions around the managed fleet. It reads only the newest 64 KiB of at most 200 recently modified `~/.claude/projects/<encoded-cwd>/*.jsonl` files, shows active/idle age, project cwd, approximate size, one redacted activity label, active managed-job count by exact cwd, and existing managed writer ownership. It never opens a transcript. Enter filters Fleet to the selected cwd; `Esc` clears the Fleet filter.
- **Job detail** has Transcript, Diff, Record, Usage, and Events tabs. A sixth Chain tab appears for a root with children or a resumed child; it orders rounds and shows changed-file count, verification exit, objective/suspicion markers, and the first outcome line. Enter on a chain round jumps to that job. The detail header always shows the current transport-honest activity. Transcript is a coalesced conversation: message deltas form one live block, completed text replaces its deltas, the latest plan replaces older plans, provider noise is omitted, and tool start/status/output/completion events form one expandable line. Each Codex or Cursor file change is a separate compact cwd-relative edit line with green `+A`, red `−R`, and rename/delete labels; counts are absent when unknowable. ACP restored events collapse under one `restored history` row; replay never drives the live thinking/tool state. Network preflight/elevation, input waits, mode/model/session changes, subagent activity, and artifacts render as bounded typed notices. Events remains the raw normalized stream. Diff starts with per-file stats; Enter opens one file's windowed hunks. Record intentionally limits itself to curated broker fields. Usage labels provider tokens/output budget separately from ACP context occupancy and continuation-chain totals.
- **Providers** shows enabled state, allowance windows, colored warning/avoid bands, deep-health `lastVerified` data when available, and active writer jobs grouped by cwd.
- **Stats** renders the never-pruned audit-log aggregation for the last seven days. `/` incrementally filters the already-loaded audit rows without touching the store.
- **Launcher** selects a local/bundled profile and ordinary provider/model/mode/effort/scope fields, plus a verify command and comma-separated absolute ingest paths. The route-advisor pane recomputes after form changes and shows the primary route, top fallback, scores, and matching historical usage bands when available; it is advisory and never gates launch. Press `e` to edit the packet body in `$VISUAL` or `$EDITOR`, `d` for the mandatory side-effect-free packet preview, and `y` to launch only while that preview exactly matches the current form.

`$VISUAL`/`$EDITOR` handoff writes only a private `0600` scratch file under the Delegate Router state directory. Before terminal ownership moves to the editor, an active background width probe is cancelled without applying partial measurements and releases its CPR check listener. The TUI then disables raw mode and mouse reporting and leaves the alternate screen before spawning the editor, reinitializes the terminal afterward, and fully repaints. A signalled or nonzero editor leaves the previous packet body unchanged; when neither variable is set, editing stays inline.

Transcript, Events, and an opened Diff file support case-insensitive `/` search over logical lines. Matches use the palette's search background, the title shows the current/total counter, and `n`/`N` move forward/backward with automatic scroll. `Esc` clears the search. Search hit mapping composes with the virtualized wrap cache rather than wrapping the complete journal.

Transcript tool lines prefer the richest already-redacted journal fields: commands and exit codes, file basenames and change kinds, MCP server/tool names, Cursor titles/locations, durations, and output-line counts. `Enter` expands the focused tool to its full wrapped command, a differing cwd, file list, and last approximately 20 output lines. File-change lines are individually selectable/clickable and use the same glyph-tier fallbacks as tools. `d` opens Diff filtered to the focused tool or file-change path; `Esc` clears the filter. `E` jumps to the corresponding raw Events position on a best-effort sequence mapping.

Codex context compaction appears between conversation blocks as a one-line system marker with a spinner while active and elapsed duration when complete. While its start has no matching completion, Fleet and the detail header report the animated `compacting` state instead of quiet/idle; the same normalization recognizes older journals whose lifecycle exists only as `provider.event` context-compaction items.

### Visual and interaction principles

- **Attention first:** actionable amber/red states lead Dashboard, Fleet badges, and the detail header. Decorative chrome stays quiet.
- **Progressive disclosure:** Dashboard answers “what needs me?”, Fleet shows everything, Detail explains one job, and Events exposes the raw normalized stream. `Esc` walks back one level and the app-bar breadcrumb shows the current level.
- **Focus and one accent:** only the focused pane gets the desaturated accent border. The same accent is reserved for the left-edge selection marker, active-tab underline, and footer keys; status colors remain semantic.
- **Breathing room:** distinct rounded panes have inner horizontal padding and blank gaps. Tables separate columns with whitespace and an underlined header instead of vertical rules.
- **Contextual help:** the footer contains only actions valid for the current screen. `?` presents the full reference in the Dashboard → Fleet → Detail progression, followed by controls and launcher actions.
- **No dead ends:** empty panes say what fills them, such as `N to launch a job` or `F to open Fleet`.

### Activity visibility by transport

The activity derivation uses this capability table; a missing capability means “not exposed”, never “not happening”. Content-free `activity` markers record only thinking/output transitions and never reasoning text.

| Transport | Visible activity signals |
| --- | --- |
| Codex app-server | Context compaction, thinking, streaming, command/MCP/file tools, approval, required input, broker phase, quiet, stalled |
| Cursor ACP | Thinking, streaming, titled/location-bearing tools, approval, required input, broker phase, quiet, stalled |
| Cursor headless | Thinking markers, streaming assistant text, structured tool starts/completions, broker phase, quiet, stalled, terminal status; no approval/input callback signal |

Cursor headless thinking/tool state comes only from actual stream-json events; the TUI never infers approval or input waits that transport cannot produce. Thought text is never persisted or displayed.

## Keys

| Key | Action |
| --- | --- |
| `F` | Open the complete Fleet from any screen |
| `↑`/`↓`, `j`/`k` | Move the logical selection one block; scroll follows only to keep it visible |
| `Enter` | Open a job/diff file, expand a focused Transcript tool, or edit a launcher field |
| `Esc` | Close the current overlay/file view or walk Detail → Fleet → Dashboard |
| `a` | Fleet active-only toggle |
| `G`, `S` | Open/close Groups or coordinator Sessions |
| `/` | Fleet filter; detail-pane search; Stats loaded-row filter |
| `n`, `N` | Next/previous active search match; `n` otherwise keeps its narration-nudge behavior |
| `p`, `t`, `N` | Providers, stats, launcher (`N` opens Launcher when no search is active) |
| `[`/`]`, `1`–`6` | Switch available job-detail tabs |
| `f` | Toggle follow in Transcript or Events |
| `d` | From a Transcript tool or file-change line, open Diff filtered to its paths; in Launcher, build the dry run |
| `E` | From Transcript, jump to the corresponding raw Events position |
| `s` | Steer an active job using its current revision |
| `r` | Resume a terminal job with a new packet |
| `R` | Release a start-paused job using its current revision |
| `n` | Resume a suspicious read result with the standard inline-findings nudge |
| `c` | Cancel after typing the last four job-id characters |
| `v` | Show the safe revert dry-run plan, then require the job-id suffix |
| `w` | On a terminal job, collect findings and start a shared diff-aware review round |
| `←`/`→` | Cycle launcher choices or page a selected file diff |
| `e` | Edit the launcher packet body through `$VISUAL`/`$EDITOR` |
| `y` | Launch the matching launcher preview |
| `b` | Toggle desktop notifications for this TUI session |
| `Ctrl-G` | Mark the current diagnostic frame when `DELEGATE_TUI_DIAG` is enabled |
| Mouse click | Select a Fleet/Groups/Transcript row or switch a detail tab; wheel moves only the viewport |
| `?` | Complete in-app key reference |
| `q`, `Ctrl-C` | Quit immediately |

Revision conflicts and all other typed broker errors stay in the status line; they do not terminate the TUI. Cancellation is shown as queued until the provider acknowledges or its process exits. Revert can touch only the safe subset reported by the existing broker helper.

## Themes and notifications

The default palette targets dark terminals. Set `DELEGATE_TUI_THEME=light` before launch for the light-terminal palette. `NO_COLOR` still removes color from either theme while retaining structural bold/dim styling; all component colors come from the selected semantic palette.

While the TUI is running, terminal transitions, new stalls, recorded scope violations, and budget stops can send a desktop notification through `osascript` on macOS or `notify-send` on Linux. Dispatch is non-blocking, missing platform commands are ignored, and each job is limited to one notification per five seconds. Notification text contains only the job id, status, provider, and event kind—never prompt, transcript, result, path, or diff content. Press `b` to toggle the session; `DELEGATE_TUI_NOTIFY=0` disables notifications entirely.

## Limitations

- The TUI supports macOS and Linux terminals, not Windows. SGR button press and wheel input are supported; drag/motion gestures are not.
- Claude coordinator-session discovery is best-effort because the Claude Code JSONL format and encoded project-directory convention are not stable interfaces. Missing, unreadable, truncated, malformed, or oversized transcript content is skipped; a missing/unreadable projects directory produces one explanatory line and does not affect managed-job views. `DELEGATE_CLAUDE_PROJECTS_DIR` overrides the projects root and `DELEGATE_SESSION_ACTIVE_SECONDS` overrides the default 300-second active window. Files are rescanned every ten seconds and on project-directory watch events when available.
- Inline launcher and review input remains single-line; use `$VISUAL`/`$EDITOR` for multi-line text.
- Unicode width remains terminal-dependent, especially through tmux. Width-suspect content is confined with absolute cursor placement and guard repainting; a terminal may clip the suspect glyph itself, but it cannot leave following ordinary text displaced. The optional probe improves the glyph itself when CPR is supported.
- The dashboard consumes already-redacted broker records, journals, audit rows, and diff artifacts. Coordinator ingestion extracts only bounded metadata and one shared-redactor-filtered tail label; it does not expose transcript viewing or ingest raw provider payloads.
- Cursor still has no live shell stdout: headless and ACP tool output appears only when Cursor emits completion data. Headless exposes thinking markers and structured tool lifecycle, but not approval/input callbacks; hidden thought text is never retained.
- Remote export is single-host and read-only. It is not a multi-tenant service and must remain behind the documented loopback listener and SSH tunnel.
- Shared-worktree changed-file attribution remains best-effort, exactly as in the broker. Writer ownership shown by the TUI covers managed shared-worktree jobs, not unmanaged editors.
- Dangerous launch overrides (`overrideWriter`, sandbox off, and forced approval) are intentionally absent. Use the explicit CLI/MCP paths with the required user authorization when those exceptional controls are necessary.
