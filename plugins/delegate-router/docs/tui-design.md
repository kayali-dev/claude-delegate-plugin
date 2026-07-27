# delegate-tui design spec

Status: active. Owner-approved 2026-07-27 (all four tracks).
Derived from a design research pass; every diagnosis below was verified against
the code before adoption.

## Verified diagnosis

1. **The palette is 256-colour in a truecolor costume.** All 32 tokens carrying
   an xterm index have RGB *exactly equal* to that index's cube value
   (`tone(236,[48,48,48])`, `tone(73,[95,175,175])`, …). Truecolor is detected
   (`ansi.mjs:28-30`) and emitted (`:70`) and buys nothing. The xterm greyscale
   ramp has no hue axis, so index-first authoring makes tinted neutrals
   structurally impossible — pure neutral grey is the strongest "terminal
   default" signal a palette can send.
2. **The accent is the default, not the exception.** `transcriptLineStyle()`
   ends `return palette.accent`; `lineStyleForEvent()` maps every `tool.*` event
   and diff file headers to accent. The colour reserved for "where am I" paints
   everything unclassified.
3. **We have painters, not components.** `components.mjs` has no key/value
   painter, no rail painter, no diff-line painter, no section-header painter.
   Every secondary screen falls through to `paintLogPane` (a coloured line
   list). The Dashboard is the only screen with purpose-built components — which
   is mechanically why everything past it reads as barebones.
4. **Footer/help/docs are three hand-maintained lists that already disagree.**
   `viewmodels.mjs:228` filters `['N','s','r','R','c','v','w']` out of the
   footer for read-only remote, but six of those seven keys appear in no footer
   group at all — a fossil proving the lists diverged.
5. **Measured failures.** `dimFg` on surface = 3.83:1 and `statusRunning` =
   3.69:1 (both below the 4.5:1 floor). The light surface ramp steps ΔL 0.030
   then 0.061 — visibly uneven, which is why light reads washed out.

## Governing constraint

The native-substrate program's "nothing breaks" invariants apply in full.
Additionally, for TUI work:

- Every existing fuzz, frame-overflow, nasty-journal, snapshot, and
  width/glyph-probe test stays green. These are the safety net; they are not
  to be weakened to accommodate a redesign.
- `width.mjs` remains the single truncation authority; viewmodels stay pure;
  rendering stays O(viewport).
- The probe-gated glyph tiers are untouched — new glyphs must declare fallbacks.
- Behaviour changes ship behind the existing preference/theme mechanism where a
  user could reasonably disagree.

## Track A — colour

Author perceptually; derive the index. Never the reverse.

### Progress — 2026-07-27

- Implemented the 41-token OKLCH palette, contrast solver, constant-lightness
  dark/light surface ramps, tinted neutrals, derived 256-colour indices, and
  truecolor/256/ANSI fallback ladder.
- Added all six presets, validated custom `base` + `overrides` preferences,
  daltonized blue/yellow semantic pairs, and self-verifying contrast/headless
  render tests.
- Reclaimed accent for focus, live state, active tabs, and selection; default
  transcript content, tool events, and diff file headers now use body or
  semantic colour.

**Seeds**
```
accentHue 195   accentChroma 0.09
neutralHue 235  neutralChroma 0.012   // tinted neutrals, not pure grey
```

**Surface ramp** — constant ΔL (dark 0.045, light 0.035; the eye is more
sensitive near white):

| token | dark L | light L |
|---|---|---|
| `bg` | 0.180 | 0.985 |
| `surface` | 0.225 | 0.950 |
| `surfaceRaised` | 0.270 | 0.915 |
| `surfaceOverlay` | 0.315 | 0.880 |

**Text and border tiers are solved for a contrast target against their actual
surface**, not picked by lightness: `text` 8:1, `textSecondary` 5.5:1,
`textMuted` 4.5:1 (floor), `borderSubtle` 1.6:1, `border` 2.2:1,
`borderActive` 3.5:1. Semantic states re-solve to ≥4.5:1.

**Token set (~41):** surfaces 4, borders 3, text 4, accent ramp 4, semantic 8
(`{success,warning,error,info}` × `{fg,subtleBg}`), selection 2, meter 2,
diff 6, categorical 8 (quarantined, for provider/agent identity only).

**Fallback ladder:** truecolor (authored OKLCH → sRGB) → 256 (`rgbTo256()`,
already in `ansi.mjs:51`) → `-ansi` variant that emits **no colour** for
text/background so it inherits the user's terminal theme.

**Presets:** `dark`, `light`, `dark-daltonized`, `light-daltonized`,
`dark-ansi`, `light-ansi`. Daltonized replaces red/green contrast with
blue/yellow. Custom themes are `base` + `overrides`; unknown tokens and invalid
values are ignored so a typo cannot break rendering.

**Accent discipline:** accent answers *where am I / what is live*; semantic
answers *what happened*. Never both on one token. A selected-and-failed row puts
accent in the gutter and semantic in the status cell — different columns.
`transcriptLineStyle`'s default becomes body text, not accent.

**Contrast is self-verifying:** ship a test that computes every token pair
against its surface and fails below target. A palette that can drift silently
will.

## Track B — surfaces and rhythm

### Progress — 2026-07-27

- Implemented tinted `surface` / `surfaceRaised` pane ownership with persistent
  `▎` rails, accent focus rails, subtle resting rails, subtle scrollbar tracks,
  and normal/active overlay border weights. Full rectangles now remain only on
  floating help and confirmation surfaces.
- Centralized the `0 1 2 3 4 6 8` spacing scale, asymmetric pane padding,
  two-cell table gaps and indent, the scrollbar margin, and the named
  30-row height-pressure threshold.
- Locked title/content alignment plus selection, glyph-prefix, and diff marker
  gutters with headless every-screen invariants. Unicode probing, ASCII and
  `NO_COLOR` retain the same layout, with a structural `|` rail fallback.

- **A full rectangle is the most expensive containment device available. Spend
  it only on overlays.** Regions are a background tint + a left rail (`▎`), not
  a box. Borders split into subtle/normal/active; subtle is the resting state.
  Border weight equals the dimmest text weight.
- **Nesting limit 1.** A bordered surface never contains another bordered box.
- **Spacing scale: only `0 1 2 3 4 6 8` cells.** A cell is ~1×2, so padding is
  asymmetric: **2 columns / 1 row** inside panes. Sections separated by exactly
  one blank row. Table column gap ≥2. Indent step 2. One column of margin before
  a scrollbar.
- **Reserved gutters — content never shifts.** A selected row and an unselected
  row place their first character in the identical column. Same for
  glyph-prefixed rows and diff markers. Shifting content on selection reads as
  broken.
- **One content-left column per pane**: title, summary strip, section labels and
  rows all align to it.
- Under height pressure (≤30 rows) drop section blank lines rather than adding
  rules; never trade whitespace for ink.

## Track C — the missing painters

**`paintKeyValue`** (Record, Usage, Chain, launcher review): one alignment grid
across all sections (`labelWidth = clamp(maxLabel, 14, 22)`); uppercase dim
section labels with one blank line above; humanised keys (`objectiveMet` →
`objective met`); nulls collapse to a dim `—` (never blank, never `""`);
anomalies promote a right-aligned badge onto the *section header* so a
scrolled-past section still advertises trouble. Replaces the current
`JSON.stringify` dump and `usageLines`' hand-padded spaces.

**`paintRail`** (transcript, events): three-zone row grammar
`[time][rail][content]…[measure]`. Rail glyph carries role structurally — `▌`
message body, `│ ├─ └─` tool/subagent children, `◈` system markers — so nesting
survives `NO_COLOR` and colourblindness for free. Blank line *between* blocks,
never within one. Right-aligned measure column at a fixed offset for `exit N`,
duration, `+A −R`. Colour only for anomalies.

**`paintDiffLine`**: line-number gutter with a `│` separator; absent-side rows
paint the gutter cell dark red/green so the column never breaks rhythm;
per-file band carrying `+A −B`; hunk header shows the enclosing symbol (nearest
preceding non-indented line is ~90% as useful as real parsing); full-width
background tint on changed lines (ragged-right colour reads as output, a solid
block reads as a row); word-level intra-line highlight via common
prefix/suffix trim — and **dim the unchanged remainder**, which matters more
than highlighting the change. Skip syntax highlighting (most cost, least
differentiation).

**Summary strip** on every secondary pane: `12 files · +840 −213 · 2 outside
scope` before row one.

## Track D — keymap, help, discoverability

**One `KEYMAP` registry** is the single source of truth, rendering the footer,
the help modal, the `x` action menu, and the generated `tui.md` table. Entry
shape:

```js
{ keys: ['[', ']'],          // array — never a pre-joined string
  relation: 'pair',          // single|alternatives|pair|range|chord|sequence
  label: 'previous / next tab',
  action: 'detail.tab.cycle',
  scope: ['detail'],
  class: 'navigation',       // navigation|steering|destructive|view|diagnostic
  when: (ctx) => ctx.tabCount > 1,
  unavailableReason: (ctx) => ctx.readOnly ? 'read-only remote' : null,
  footer: true }
```

**Surface is decided by class, not taste:**

| class | footer | treatment |
|---|---|---|
| navigation | entry screen only | dim |
| **steering** (`s` `n` `R` `w` `r`) | **always when valid** | normal weight |
| **destructive** (`c` `v`) | **always when valid** | own trailing group + `⚠` marker |
| view (`a` `x` `o` `z` `t` `f` `T`) | if ≥3 slots remain | dim |
| diagnostic (`M` `Ctrl-G`) | never | help only |

Destructive keys are **not** red in the footer — red before anything is wrong
spends the loudest signal on a resting state. Separation and a marker carry it;
red is reserved for the confirm overlay where it is earned.

**Notation vocabulary** (rendered from structure, never hand-typed):

| relation | notation | example |
|---|---|---|
| single | bare | `q  quit` |
| alternatives | space-separated; `/` lives in the LABEL | `n N  next / previous match` |
| pair | space-separated | `[ ]  previous / next tab` |
| range | `…` | `1 … 6  open tab by number` |
| chord | `-` | `Ctrl-G  mark diag frame` |
| sequence | `g …` in footer, expanded in popup | `g …  go to` |

Two rules make the `[/]` bug class unrepresentable: **`/` never appears in the
key column** except as the search binding itself, and **`-` means chord only**
(ranges use `…`). Separation is carried by spacing first, weight second, colour
third, background pill only at truecolor and only in the help modal (a pill
costs 2 cells per hint; ten hints is a quarter of an 80-column row).

**Help modal:** one key per row (this alone fixes the positional-decoding,
arity-mismatch and duplicate-`y` defects); fixed-width key column with the
action column starting at one column for every row; scope right-aligned on
section headers; destructive marked with a right-aligned dim word plus `⚠`;
paged by section. A rectangle is correct here — it is an overlay — over a dim
scrim.

**`x` contextual action menu:** the home for the ~20 keys with no footer slot.
Unavailable entries stay visible with their reason (`needs a terminal job`),
never hidden. `/` filters.

**Vim coherence — commit, do not abandon.** Claude Code's own transcript viewer
is a less/vim keymap, so vim-consistency is host-consistency. Inviolable:
`n`/`N` next/previous match unconditionally; `y` yank unconditionally;
`g`/`G` top/bottom; `/` search. A **`g` prefix** for screen navigation
(`g f` fleet, `g r` groups, `g s` sessions, `g p` providers, `g t` stats,
`g l` launcher) frees `G`, `N`, `F`, `S`, `p`, `t` in one move and is the
natural home for a helix-style auto-info popup. Keep `F` as a documented
single-key alias for Fleet. Launch moves off `y` onto the dry-run confirm
overlay — a launch is a commitment and belongs on a confirm surface. Nudge moves
into the `x` menu.

## Track E — terminal capabilities (independent of aesthetics)

- **`?2026` synchronized output** — wrap each frame so the terminal never paints
  a half-drawn grid. Highest perceived-quality change available; degrades
  silently where unsupported.
- **`?2004` bracketed paste** — currently a latent bug: multi-line paste into
  the launcher is interpreted as keystrokes, so embedded newlines submit.
- **`?1004` focus reporting** — stop animating when the terminal is unfocused.
- **Kitty keyboard protocol** — unambiguous Shift-Tab, Ctrl combos, and Esc vs
  Alt-prefixed sequences.

## Motion

Animate **brightness, not shape** — a shimmer reads as alive without the
peripheral-vision cost of a spinning glyph (Claude Code ships six
colour/shimmer token pairs for exactly this). One animated element per screen;
nothing animates unfocused; liveness is better signalled by an incrementing
elapsed counter than by movement. Honour reduced-motion by changing animation
only — never layout.

## Anti-goals

Hierarchy from colour alone (strip colour and it must still work); box-in-box;
mouse-required interaction (mouse stays strictly additive); spinner noise;
layout that shifts under the cursor; hiding unavailable actions instead of
disabling them; emoji in chrome; centred body text; more than two badges per
row; colour *and* brackets on the same badge; pure neutral greys.
