# Moxen Agent — GPUI first slice

A standalone native Rust client on **mock data only**. It does not start Moxen,
read local threads, contact providers, or connect to the server.

## Run

Install Rust with rustup, then from this directory:

```sh
cargo run
```

`rust-toolchain.toml` selects Rust **1.98.1**, matching the pinned Zed checkout.
The upstream macOS implementation uses APIs unavailable on Rust 1.95.
Native platform build prerequisites also apply (Xcode command-line tools on
macOS; the corresponding native toolchain on Windows/Linux).

- Click a thread; Up/Down changes selection while the sidebar has focus.
- Click the composer to type. It supports multiple lines, Unicode grapheme
  deletion, Left/Right, Up/Down, Select All and paste.
- Enter sends; Shift+Enter adds a newline. The Send button uses the same action.
- Expand/collapse a tool row by clicking it. Scroll the transcript normally.
- Each thread keeps its own draft, scroll position and tool expansion state.
- A send marks that thread running and streams a reply every 65 ms. Sending
  again while it runs is disabled; an in-progress draft is retained.
- Cmd+Q quits.

The eight initial threads, ages, provider/model names, statuses, transcript,
tool results and generated reply are fixtures. The initially running fixture
stays running; only sent replies run a simulated lifecycle. Nothing persists
after exit. This is deliberately not a full editor: no undo stack, drag
selection, rich Markdown, attachments, settings or packaging.

## Non-interactive render/interaction harness

```sh
cargo run -- --demo
# Save current frames even while the window is covered:
cargo run --features render-harness -- --demo
```

This does **not** activate the app or inject OS keyboard/mouse events. It starts
with the first tool expanded, prints `demo: expanded tool ready`, and leaves
12 seconds to capture it. Then it exercises the native input handler and
composer actions (typing, arrows, Shift+Enter/newline, backspace, send), switches
threads mid-stream and returns after completion. Assertions pin the submitted
text, cleared composer, idle status and untouched destination thread. The log
prints `demo: input, thread switch and completed reply verified` on success.
The window stays open for inspection and screenshot capture. With
`render-harness`, GPUI's public test-support `draw` / `render_to_image` APIs
save both stages into `screenshots/`. This is necessary when macOS has stopped
presenting a covered window: `screencapture` then returns its stale last frame.
The feature is optional and is not enabled in the normal app.

On macOS, capture **only this app's window** without focusing it:

```sh
swift -e 'import CoreGraphics; for w in CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]] where (w[kCGWindowOwnerName as String] as? String) == "moxen-desktop" { print(w[kCGWindowNumber as String]!) }'
screencapture -x -l WINDOW_ID screenshots/expanded-tool.png
# After the completion log:
screencapture -x -l WINDOW_ID screenshots/completed-reply.png
```

The committed native capture is `expanded-tool-native.png`; the two current
offscreen frames are `expanded-tool.png` and `completed-reply.png`. They were
visually inspected for contrast, clipping and overlap. The automated harness
replaces external input driving so it can run
while someone uses the computer. It exercises the same input implementation,
not a separate mock UI. It does not prove physical keyboard/mouse delivery.

## Implementation and dependency pin

GPUI and `gpui_platform` both use Zed revision
**`596dfdcf32d85d4d8d17a8887b4d0979ec7c5e14`**. This is the exact upstream
checkout whose `input.rs`, `uniform_list.rs`, `list_example.rs`, input-handler,
text-layout and async context sources were read for this implementation. It
uses the current platform split rather than APIs remembered from older GPUI.
The lockfile pins the transitive dependency graph too.

`font-kit` is explicitly enabled: the default Apple rasterizer at this revision
produced empty glyphs on the test Mac (quads rendered but all text disappeared).
The supported font-kit backend fixed it. Atkinson Hyperlegible Next is bundled
for portable font identity, under `fonts/OFL.txt` (Google Fonts,
`ofl/atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext[wght].ttf`).

- `workspace.rs`: root Entity, source, selected identity, per-thread state,
  subscriptions and weak-entity timer tasks.
- `sidebar.rs`: focus-scoped actions/key bindings and `uniform_list`.
- `thread_view.rs`: variable-height `list`, reading column and expandable tools.
- `composer.rs`: independent Entity per draft; native `EntityInputHandler`,
  UTF-16/UTF-8 mapping, wrapped text shaping, cursor painting/hit testing.
- `model.rs`: data types and `ThreadSource` boundary.
- `mock.rs`: in-memory source; replies target an immutable thread/message pair.
- `theme.rs`: all application colour and spacing decisions; colour/spacing
  values resolve directly from the pinned design-system tokens.

`design-system/` is a public-file snapshot of `usemoxen/design-system` at
`ff2e9a65a278df4198b573413007132d20858a75`. Refresh deliberately with
`python3 sync-design-system.py` (requires authenticated `gh` access). Do not edit
the snapshot by hand. The native ListRow, Steps and Composer presentations
follow the included component contracts; the copied web component bundle is
reference material, not embedded browser UI. The intentionally reduced scope
omits the full product's inspector, project groups and model picker.

## Checks

```sh
cargo fmt --check
cargo build
cargo clippy -- -D warnings
cargo test
```

The source invariant test pins duplicate-send rejection and thread-isolated
reply updates. macOS was exercised; Windows/Linux builds were not run.
