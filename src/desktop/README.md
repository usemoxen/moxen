# Moxen Agent — native desktop mockup

A standalone Rust/GPUI client using **mock data only**. It does not read local
threads, start Moxen, connect to the server, or contact a provider.

## Run and check

Run these commands **from `src/desktop/`** so rustup selects the pinned Rust
1.98.1 toolchain (the parent repository's default Rust is too old for the pinned
GPUI macOS implementation):

```sh
cargo run
cargo build
cargo clippy -- -D warnings
cargo fmt --check
cargo test
```

GPUI and gpui_platform remain pinned to Zed
`596dfdcf32d85d4d8d17a8887b4d0979ec7c5e14`, with font-kit enabled. Native
platform build prerequisites apply. macOS was exercised; Windows/Linux were not.

## Interaction

- Click a thread, or use Up/Down with sidebar focus. Each thread retains its
  draft, scroll position and expanded steps.
- All / Projects / This project changes the sidebar grouping/filter. Settled
  opens the two settled fixture threads.
- Click a step to open its output beneath a rule. The run summary folds its
  steps, including thoughts.
- The model pill (or Cmd+M) opens a searchable, provider-grouped model picker.
  Selecting a model changes the pill; effort has a segmented control.
- Cmd+I or the title-bar control toggles the inspector. Ctrl+T, Tasks or the
  inspector's Tasks header toggles its pinned tasks. Drag the inspector's left
  edge to resize it; it never takes the turn below 480pt.
- Cmd+K or the search field opens the thread palette.
- Git contains the mock commit and file counts. Agents and Background are empty
  states. The usage control opens Context.
- The composer preserves native multiline input, Unicode grapheme deletion,
  Left/Right, Up/Down, Select All and paste. Enter sends; Shift+Enter adds a line.
  Send uses the same action. Stop (Escape) cancels the simulated reply; late
  words from that reply cannot mutate a later turn.
- Tab and Shift+Tab move focus between controls; the focused one carries a
  2px `live` ring. Hovered controls show a tooltip with their shortcut as a key
  cap; the toolbar controls (search, Tasks, inspector, stop, send) show the
  same tip while they hold keyboard focus, since GPUI hides hover tooltips in
  keyboard mode.
- Cmd+Q quits. Nothing persists after exit.

New-thread creation, attachments, settings, access selection, commit history,
real usage, queued-send execution and forge actions are not wired to a
backend; their controls say so in a tooltip. The initial running fixture stays
live until Stop is clicked.

## Look and motion

Numbers come from the mockup's HTML/CSS (`design-system/mockups/agent-desktop/source/`)
and `tokens.json`; colours, radii, strokes and the float shadow are read from
the tokens in `theme.rs`.

- Interface text is 13/1.3 (`theme::UI`); transcript prose is `body` at 15/1.6
  (`theme::BODY`, `theme::LINE`), the user pill 15/1.55.
- Rows: sidebar 30pt (subthreads 26), steps 32, tasks 28 for one line, Git
  files 30, model picker 32.
- Mono is for targets, code, numbers and shas. Verbs, labels, tabs, the fold
  summary and buttons use Next. (The mockup's CSS sets tabs and the fold
  summary in Mono; this crate follows MXN-332's direction instead.)
- Icons: 16px in chrome buttons (stroke 1.5), 14px inline (1.75), 12px
  chevrons (2), so strokes render about 1px everywhere. State glyphs are 12px
  in a 14px slot.
- Motion, all ease-out: the model picker fades and grows from 96% over 120ms;
  a fold and a step's output open over 150ms, timed from the click so rows that
  scroll into view do not replay it; Git diffs open over 150ms; the inspector
  slides open and closed over 160ms; the live glyph breathes over 1.8s.

## Screenshots

```sh
python3 capture-polish.py               # main, picker, details, focus
python3 capture-polish.py small         # 1280×800
```

The script builds and runs `cargo run -- --demo <stage>`, waits for the
`demo: ready` line and captures the real window with `screencapture` into
`screenshots/polish-<stage>.png` (Retina, 2880px wide for 1440pt). Stages:

- `main`: the reference 1440×900 frame.
- `picker`: the model picker open.
- `details`: a command step's output open, and a Git file's diff.
- `focus`: Tab pressed, focus on the inspector toggle, its tip showing.
- `small`: the main frame in a 1280×800 window.
- `input` (not captured by default): types into the composer, sends, switches
  thread while streaming and asserts the result.

Measured against `main.png` at 1440pt: step rows 32 (mockup 32), sidebar rows
30 (30), subthread rows 26 (26), single-line task rows 28 (28), transcript
prose 15/1.6 (15/1.6), interface text 13 (13).

`cargo run --features render-harness -- --demo <stage>` also writes an
offscreen GPUI render to `screenshots/harness-<stage>.png`; those files are not
kept. Native window controls are outside that render.

Remaining differences from the mockup: the mock has two settled threads
rather than 170; there is no usage-limit block, edit receipt or image
thumbnail in the fixture; the Git tab opens straight on a commit, not on the
pull request and history; Git files and counts are a shortened fixture.

## Implementation and design assets

`ThreadSource` remains the data boundary for thread/transcript and inspector
fixtures. `mock.rs` owns the source; no frontend data access was added.

- `workspace.rs`: selection, per-thread UI state, subscriptions and timers.
- `title_bar.rs`, `sidebar.rs`, `inspector.rs`: window regions and controls.
- `thread_view.rs`: reading column and composer shell.
- `steps.rs`: compact tool/thought rows, syntax colours and expanded output.
- `model_picker.rs`: model and effort popover.
- `composer.rs`: native input, shaping, caret and hit testing.
- `theme.rs`: colour, pixel-token, focus-ring and shadow resolution through the
  pinned tokens, and layout constants.
- `ui.rs`: shared primitives: icons, state glyphs, controls and tooltips, key
  caps, `Segmented`, section labels and transition timing.
- `inspector.rs`, `diff.rs`, `usage.rs`: tasks, tabs, the commit, its diffs and
  the Context tab.

The design-system snapshot is pinned to
`ff2e9a65a278df4198b573413007132d20858a75`. Refresh with
`python3 sync-design-system.py` using authenticated `gh`. The script fetches the
mockup PNGs through Git's blob API (the contents API cannot return their large
payloads), together with the HTML/CSS source and its dependencies. Do not edit
the snapshot by hand. `docs/agent-desktop.md` takes precedence over the images.

Atkinson Hyperlegible Next (upright and italic) and Atkinson Hyperlegible Mono
are bundled from Google Fonts' `ofl/atkinsonhyperlegiblenext` and
`ofl/atkinsonhyperlegiblemono` directories. Their OFL notices are in `fonts/`.
No fallback font is substituted.
