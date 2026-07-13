# Delegate TUI

`delegate-tui` is a zero-dependency ANSI dashboard over Delegate Router's existing local job store. It does not start providers on launch and it does not write job or usage files directly. Its control actions call the same broker functions as `delegate-jobs`, including optimistic revisions, dry-run revert planning, provider-aware cancellation, and ordinary launch admission.

## Launch

Start it from an interactive macOS or Linux terminal:

```bash
delegate-tui
```

Open a known job directly in detail view with `delegate-tui --job <id>`. An unknown id is rejected before terminal initialization with exit 1.

From a source checkout, use `node bin/delegate-tui`. `DELEGATE_STATE_FILE`, `DELEGATE_ENABLED_PROVIDERS`, provider configuration, allowance guard bands, profile directories, and the ordinary state-directory defaults are honored. `node bin/delegate-tui --help` prints usage without switching terminal screens. If stdout is not a TTY, the command exits 2 without emitting terminal escapes.

## Screens

- **Fleet** sorts active jobs before terminal jobs, then by recent activity. It shows provider/model/mode, status and phase, heartbeat age, elapsed time, output-token budget, continuation/group markers, safety badges, provider allowance, and current shared-worktree writer ownership.
- **Groups** aggregates jobs by `groupId`, with member/running/terminal/stalled counts, newest activity, and the all-terminal barrier state. Enter opens that group's members in the ordinary fleet row format.
- **Job detail** has Transcript, Diff, Record, Usage, and Events tabs. A sixth Chain tab appears for a root with children or a resumed child; it orders rounds and shows changed-file count, verification exit, objective/suspicion markers, and the first outcome line. Enter on a chain round jumps to that job. Transcript and Events can follow live journal tails. Diff starts with per-file stats; Enter opens one file's windowed hunks. Record intentionally limits itself to curated broker fields. Usage includes cached-input percentage, output budget, and continuation-chain totals.
- **Providers** shows enabled state, allowance windows, colored warning/avoid bands, deep-health `lastVerified` data when available, and active writer jobs grouped by cwd.
- **Stats** renders the never-pruned audit-log aggregation for the last seven days. `/` incrementally filters the already-loaded audit rows without touching the store.
- **Launcher** selects a local/bundled profile and ordinary provider/model/mode/effort/scope fields, plus a verify command and comma-separated absolute ingest paths. The route-advisor pane recomputes after form changes and shows the primary route, top fallback, scores, and matching historical usage bands when available; it is advisory and never gates launch. Press `e` to edit the packet body in `$VISUAL` or `$EDITOR`, `d` for the mandatory side-effect-free packet preview, and `y` to launch only while that preview exactly matches the current form.

`$VISUAL`/`$EDITOR` handoff writes only a private `0600` scratch file under the Delegate Router state directory. The TUI disables raw mode and mouse reporting and leaves the alternate screen before spawning the editor, then reinitializes the terminal and fully repaints. A signalled or nonzero editor leaves the previous packet body unchanged; when neither variable is set, editing stays inline.

Transcript, Events, and an opened Diff file support case-insensitive `/` search over logical lines. Matches use the palette's search background, the title shows the current/total counter, and `n`/`N` move forward/backward with automatic scroll. `Esc` clears the search. Search hit mapping composes with the virtualized wrap cache rather than wrapping the complete journal.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move selection or scroll |
| `Enter` | Open a job/diff file or edit a launcher field |
| `Esc` | Back or close the current overlay/file view |
| `a` | Fleet active-only toggle |
| `G` | Open/close Groups |
| `/` | Fleet filter; detail-pane search; Stats loaded-row filter |
| `n`, `N` | Next/previous active search match; `n` otherwise keeps its narration-nudge behavior |
| `p`, `t`, `N` | Providers, stats, launcher (`N` opens Launcher when no search is active) |
| `[`/`]`, `1`–`6` | Switch available job-detail tabs |
| `f` | Toggle follow in Transcript or Events |
| `s` | Steer an active job using its current revision |
| `r` | Resume a terminal job with a new packet |
| `R` | Release a start-paused job using its current revision |
| `n` | Resume a suspicious read result with the standard inline-findings nudge |
| `c` | Cancel after typing the last four job-id characters |
| `v` | Show the safe revert dry-run plan, then require the job-id suffix |
| `w` | On a terminal job, collect findings and start a shared diff-aware review round |
| `←`/`→` | Cycle launcher choices or page a selected file diff |
| `e` | Edit the launcher packet body through `$VISUAL`/`$EDITOR` |
| `d`, `y` | Build launcher dry run; launch the matching preview |
| `b` | Toggle desktop notifications for this TUI session |
| Mouse click | Select a Fleet/Groups row or switch a detail tab; wheel scroll is unchanged |
| `?` | Complete in-app key reference |
| `q`, `Ctrl-C` | Quit (`q` applies on Fleet) |

Revision conflicts and all other typed broker errors stay in the status line; they do not terminate the TUI. Cancellation is shown as queued until the provider acknowledges or its process exits. Revert can touch only the safe subset reported by the existing broker helper.

## Themes and notifications

The default palette targets dark terminals. Set `DELEGATE_TUI_THEME=light` before launch for the light-terminal palette. `NO_COLOR` still removes color from either theme while retaining structural bold/dim styling; all component colors come from the selected semantic palette.

While the TUI is running, terminal transitions, new stalls, recorded scope violations, and budget stops can send a desktop notification through `osascript` on macOS or `notify-send` on Linux. Dispatch is non-blocking, missing platform commands are ignored, and each job is limited to one notification per five seconds. Notification text contains only the job id, status, provider, and event kind—never prompt, transcript, result, path, or diff content. Press `b` to toggle the session; `DELEGATE_TUI_NOTIFY=0` disables notifications entirely.

## Limitations

- The TUI supports macOS and Linux terminals, not Windows. SGR button press and wheel input are supported; drag/motion gestures are not.
- Inline launcher and review input remains single-line; use `$VISUAL`/`$EDITOR` for multi-line text.
- Common emoji, ZWJ sequences, flags, combining marks, and East Asian wide ranges are width-aware. Exotic grapheme clusters may occupy a different number of cells on a particular terminal.
- The dashboard consumes already-redacted broker records, journals, audit rows, and diff artifacts. It does not ingest coordinator-session messages or raw provider payloads.
- Shared-worktree changed-file attribution remains best-effort, exactly as in the broker. Writer ownership shown by the TUI covers managed shared-worktree jobs, not unmanaged editors.
- Dangerous launch overrides (`overrideWriter`, sandbox off, and forced approval) are intentionally absent. Use the explicit CLI/MCP paths with the required user authorization when those exceptional controls are necessary.
