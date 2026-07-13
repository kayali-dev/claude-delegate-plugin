# Delegate TUI

`delegate-tui` is a zero-dependency ANSI dashboard over Delegate Router's existing local job store. It does not start providers on launch and it does not write job or usage files directly. Its control actions call the same broker functions as `delegate-jobs`, including optimistic revisions, dry-run revert planning, provider-aware cancellation, and ordinary launch admission.

## Launch

Start it from an interactive macOS or Linux terminal:

```bash
delegate-tui
```

From a source checkout, use `node bin/delegate-tui`. `DELEGATE_STATE_FILE`, `DELEGATE_ENABLED_PROVIDERS`, provider configuration, allowance guard bands, profile directories, and the ordinary state-directory defaults are honored. `node bin/delegate-tui --help` prints usage without switching terminal screens. If stdout is not a TTY, the command exits 2 without emitting terminal escapes.

## Screens

- **Fleet** sorts active jobs before terminal jobs, then by recent activity. It shows provider/model/mode, status and phase, heartbeat age, elapsed time, output-token budget, continuation/group markers, safety badges, provider allowance, and current shared-worktree writer ownership.
- **Job detail** has Transcript, Diff, Record, Usage, and Events tabs. Transcript and Events can follow live journal tails. Diff starts with per-file stats; Enter opens one file's windowed hunks. Record intentionally limits itself to curated broker fields. Usage includes cached-input percentage, output budget, and continuation-chain totals.
- **Providers** shows enabled state, allowance windows, colored warning/avoid bands, deep-health `lastVerified` data when available, and active writer jobs grouped by cwd.
- **Stats** renders the never-pruned audit-log aggregation for the last seven days.
- **Launcher** selects a local/bundled profile and ordinary provider/model/mode/effort/scope fields. Press `d` for the mandatory side-effect-free packet preview. `y` is accepted only while that preview exactly matches the current form.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move selection or scroll |
| `Enter` | Open a job/diff file or edit a launcher field |
| `Esc` | Back or close the current overlay/file view |
| `a` | Fleet active-only toggle |
| `/` | Fleet substring filter over id/model/cwd; Events type filter |
| `p`, `t`, `N` | Providers, stats, launcher |
| `[`/`]`, `1`–`5` | Switch job-detail tabs |
| `f` | Toggle follow in Transcript or Events |
| `s` | Steer an active job using its current revision |
| `r` | Resume a terminal job with a new packet |
| `R` | Release a start-paused job using its current revision |
| `n` | Resume a suspicious read result with the standard inline-findings nudge |
| `c` | Cancel after typing the last four job-id characters |
| `v` | Show the safe revert dry-run plan, then require the job-id suffix |
| `←`/`→` | Cycle launcher choices or page a selected file diff |
| `d`, `y` | Build launcher dry run; launch the matching preview |
| `?` | Complete in-app key reference |
| `q`, `Ctrl-C` | Quit (`q` applies on Fleet) |

Revision conflicts and all other typed broker errors stay in the status line; they do not terminate the TUI. Cancellation is shown as queued until the provider acknowledges or its process exits. Revert can touch only the safe subset reported by the existing broker helper.

## Limitations

- v1 supports macOS and Linux terminals, with no Windows or mouse support.
- Launcher prompt editing is single-line. Profiles remain the preferred way to prepare structured multi-line packets.
- Common emoji, ZWJ sequences, flags, combining marks, and East Asian wide ranges are width-aware. Exotic grapheme clusters may occupy a different number of cells on a particular terminal.
- The dashboard consumes already-redacted broker records, journals, audit rows, and diff artifacts. It does not ingest coordinator-session messages or raw provider payloads.
- Shared-worktree changed-file attribution remains best-effort, exactly as in the broker. Writer ownership shown by the TUI covers managed shared-worktree jobs, not unmanaged editors.
- Dangerous launch overrides (`overrideWriter`, sandbox off, and forced approval) are intentionally absent. Use the explicit CLI/MCP paths with the required user authorization when those exceptional controls are necessary.

