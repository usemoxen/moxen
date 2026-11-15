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
- The model pill opens a searchable, provider-grouped model picker. Selecting
  a model changes the pill; effort has a segmented control.
- Cmd+I or the title-bar control toggles the inspector. Ctrl+T or Tasks toggles
  its pinned tasks. Drag the inspector's left edge to resize it.
- Git contains the mock commit and file counts. Other inspector tabs are empty
  states. The usage control opens Context.
- The composer preserves native multiline input, Unicode grapheme deletion,
  Left/Right, Up/Down, Select All and paste. Enter sends; Shift+Enter adds a line.
  Send uses the same action. Stop cancels the simulated reply; late words from
  that reply cannot mutate a later turn.
- Cmd+Q quits. Nothing persists after exit.

Search/action navigation, new-thread creation, attachments, settings, access
selection, real usage, queued-send execution and forge actions are not wired to
a backend. The initial running fixture stays live until Stop is clicked.

## Render harness

```sh
cargo run --features render-harness -- --demo
```

The initial frame is a 1440×900 logical window, with the mockup's first thread,
model picker and Git inspector selected. GPUI's public draw/render_to_image APIs
save `screenshots/vs-mockup.png`. The harness then closes the picker and saves
`screenshots/steps.png` with the thought expanded. Retina captures have twice
the logical pixel dimensions; the committed comparison frames are normalized
to 1440×900 with `sips -z 900 1440 screenshots/vs-mockup.png screenshots/steps.png`.

The demo subsequently exercises the existing native input handler (typing,
arrows, newline, backspace, send), switches threads while streaming, and returns
after completion. `demo: input, thread switch and completed reply verified`
means the assertions passed. It neither focuses the app nor injects OS input.
The process remains open for inspection; stop the process you started afterward.

The frames were compared against the reference through multiple render/fix
passes, inspecting title bar, sidebar, transcript, composer and inspector.
Remaining differences: native window controls are outside the offscreen capture;
several icons use font glyphs rather than the web mockup's SVG strokes; the mock
contains two settled threads rather than 170; the queued-message strip and the
Git file's expanded diff are absent. Git files and summary counts represent a
shortened fixture, not the complete 73-file commit. Model popover positioning is
relative to the transcript pane rather than a general-purpose overlay service.

## Implementation and design assets

`ThreadSource` remains the data boundary for thread/transcript and inspector
fixtures. `mock.rs` owns the source; no frontend data access was added.

- `workspace.rs`: selection, per-thread UI state, subscriptions and timers.
- `title_bar.rs`, `sidebar.rs`, `inspector.rs`: window regions and controls.
- `thread_view.rs`: reading column and composer shell.
- `steps.rs`: compact tool/thought rows, syntax colours and expanded output.
- `model_picker.rs`: model and effort popover.
- `composer.rs`: native input, shaping, caret and hit testing.
- `theme.rs`: colour resolution through the pinned tokens and layout constants.

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
