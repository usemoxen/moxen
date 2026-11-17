# Moxen Agent — native desktop

A standalone Rust/GPUI client. By default it connects to this machine's Moxen
server and lists the user's real projects and threads, live. The inspector's
Context view still has fixtures only (`--mock` or demo); it shows no made-up
numbers against a real server. The desktop parity work is tracked under MXN-30.

## The server connection

`wire.rs` speaks the server's newline-delimited JSON protocol
(`src/server/transport/wire.ts`) over its local endpoint: `MOXEN_SERVER_ENDPOINT`,
else `~/.moxen/server.sock`. `live.rs` is the `ThreadSource` over the shell
subscription; its ordering, nesting and status rules follow the TUI's sidebar
(`src/tui/model/sidebar.ts`, `shell.ts`). The thread subscription includes the
same native subagent rows the TUI derives from the activity history.

- The server refuses a client from another build. The desktop is not built
  from the same code, so it asks once with a placeholder build, reads the
  server's own build from the greeting (a local socket is greeted even on a
  mismatch) and presents it on a second socket. The protocol version is the
  compatibility check.
- A thread's transcript is read over its own `subscribeThread` subscription for
  the thread on screen (`ThreadSource::focus`), dropped when another is opened.
  `transcript.rs` projects messages and activities into rows: a tool call's
  `started` and `completed` activities pair by `toolCallId` into one step
  (command, read, search, edit, thought or generic tool, with its duration or
  line counts), and live `thread.message-sent` / `thread.reasoning-delta` text
  extends the row until the next snapshot. The rules follow the TUI
  (`src/tui/model/activity.ts`) for the common tools; the TUI's richer views
  (todos, tasks, questions, memory, web, image) show as generic tool rows for now.
  A run of consecutive steps folds under one summary row; finished runs start
  folded, the last stays open while it ends the conversation.
- Sending, stopping and queueing drive real turns (`live.rs`, over `Wire::dispatch`;
  every command runs on its own thread, so the window never waits for the
  server). Enter on an idle thread sends `thread.turn.start` (a settled thread
  wakes on the send). On a running thread Enter steers (`delivery: "steer"`,
  lands at the turn's next step) and Cmd/Ctrl+Enter or Queue queues
  (`delivery: "queue"`), as the TUI's Enter and Tab do. Stop and Escape send
  `thread.turn.interrupt`, only while a turn runs. A command the server refuses
  shows its message above the composer and puts the unsent text back in the
  draft.
- The queue strip lists the thread's waiting messages in the server's order
  (`queuedTurns` joined with `queue.read`, which knows which are held). Each can
  move earlier or later (`queue.edit` `up`/`down`, as many steps as other
  threads' entries between them, like the TUI's work queue), be held or
  released, be taken back into the draft to edit, be removed (a
  `thread.turn.interrupt` with the turn id, as the TUI's Queued panel cancels),
  and the first can be sent now (it moves first and the running turn is
  interrupted, so the queue promotes it). A message that has not run yet, or
  was taken back, is not in the transcript.
- New thread (the pencil in the sidebar): a draft view with project, access
  (runtime mode) and mode (interaction mode) choices above the composer.
  `thread.create` then `thread.turn.start`; the window opens the thread once the
  shell lists it. "Add project…" asks for a folder with the system picker and
  sends `project.create`. The model is the one chosen in the model picker,
  else the one the project's newest thread runs on (the server's default with
  none). The access and mode chips of an open,
  idle thread change it (`thread.runtime-mode.set`, `thread.interaction-mode.set`).
  Not done: attachments, scheduled sends and queue conditions, starting the
  first thread of an account with none, and the run-size question of `/research`.
- A thread that waits on the person shows a panel in the composer's place, as
  the TUI's answer and permission panels do (`ask.rs`, `pending.rs`). Both are
  read from the thread snapshot's activities (`permission.requested` /
  `user-input.requested` minus their `.resolved`, oldest first; a question wins
  the slot over an approval). A tool approval offers Yes, Yes for this session
  and No (`thread.permission.respond` with `accept`, `accept-session`,
  `decline`; the × denies). Agent questions show one question at a time with
  numbered choices, an optional written answer, Continue for a multi-select and
  a tab per question; answers walk to the nearest unanswered question and are
  sent together from the last (`thread.user-input.respond`), and × dismisses
  (`thread.user-input.dismiss`). Keys: Up/Down move, Enter or a digit picks,
  Left/Right change question. An answered request disappears at once and
  returns with the reason only if the server refuses it and it is still open
  (a refusal after another client answered first is silent). A plan the agent
  proposes (`proposedPlans`) is a collapsible "Plan proposed" row in the
  transcript, read-only like the TUI's; `thread.plan.set` is the agent's own
  checklist, not a client action, so the desktop does not send it. The mock
  fixtures hold an approval (Screen-sharing thread), two questions
  (Verify authentication) and a plan (Recover partial frame headers).
- The inspector's Git and Diff tabs read the server, not the machine (`git.rs`,
  `git_view.rs`); the window never runs git or `gh` itself. Opening either tab
  reads the thread's checkout and forge once (and Refresh reads again).
  **Git**: the thread's pull request (`forge.request.status`) with its state,
  review decision, conflicts, size and CI runs (failures first, "+N more"),
  other open requests (`forge.requests.list`), local branches with ahead/behind
  (click one to read its history, click the current one to follow the
  checkout again), the branch's commits with author, age and CI
  (`forge.commits.checks`), and a pinned footer with the forge slug, branch and
  what is uncommitted. A commit opens in full (`git.commit.detail`, its CI from
  `forge.commit.runs`): message, people, refs, parents, files with their patch
  (files start folded; at most 500 lines of a file are drawn). Forge and git
  reads are separate, so a slow or missing forge (no remote, no CLI, not signed
  in: its reason is shown) never holds up history. Forge writes are visible to
  others the moment they land, so none fires on one click: Comment and "Open a
  draft PR yourself" open a field (Enter sends, Esc cancels) and Merge arms
  first, then offers Squash or Merge commit (`forge.request.comment` /
  `.create` / `.merge`; the branch it merges into is picked from the local
  branches, the default first). "Have the agent open a draft PR / open it ready
  for review" sends the TUI's exact instruction as a queued message, and the
  transcript shows it as one "Asked the agent to open …" line. The status line's
  branch chip shows the branch and what is uncommitted once the Git tab has
  read them.
  **Diff**: the turns that changed files (from the snapshot's checkpoints,
  newest open first, one at a time) with each turn's patch from `turnDiff`,
  and "Working tree" (`workspace.git`: the files changed against HEAD, then
  their diff; untracked files are not in it). No syntax highlighting yet.
  Not done: handing the request to another provider when the thread's own is
  at its limit (the TUI does), opening a request with a body, rebase merges,
  deleting the branch on merge, and Windows.
- **Tasks** pins a thread's latest checklist above the inspector tabs. The
  title-bar toggle and the checklist header count completed steps from the
  snapshot. The checklist is read-only. Escape dismisses an agent question
  without answering it; an open permission request still needs a decision.
  Neither Escape action interrupts the turn.
- **Agents** lists delegated threads and provider subagents. Click a delegated
  thread to open its own conversation and composer. Its **Info** tab shows its
  task, parent link, model and checkout; a live delegated task can be cancelled
  there, with a choice whether to notify its parent when notifications are on
  (`thread.delegation`, `thread.task.status`, `thread.task.cancel`).
  Click a provider subagent to read its prompt, steps and replies
  (`thread.subagent`); it updates while the subagent runs. The Stop action
  is shown for independently stoppable work. Back or Escape returns to the list.
- **Background** groups the jobs reported by the live session; the composer
  status line also opens the tab when the thread reports background work.
  Click a job to see its command, status and output. The list and open output
  refresh while the tab is visible (`thread.background.list`,
  `thread.background.output`). Stop dispatches `thread.background.stop` for
  that job, not the thread's turn. A partial list is marked as such.
- With no server running the window says so and offers Retry. It does not
  start the server (a later issue).
- macOS and Linux (unix sockets) only. The Windows named pipe needs
  overlapped I/O (a blocked read on a synchronous handle stalls a write), which
  is not written; the connection fails with an explanatory message there.
  Windows was not run.
- `cargo run -- --mock` shows the fixtures; `--demo live` is the screenshot stage
  for the real server.

## Run and check

Run these commands **from `src/desktop/`** so rustup selects the pinned Rust
1.98.1 toolchain (the parent repository's default Rust is too old for the pinned
GPUI macOS implementation):

```sh
cargo run
cargo build
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features render-harness -- -D warnings
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
  reveals finished families. A settled task stays off the sidebar while
  its parent is active; it is still available from the parent's inspector.
- Click a step to open its output beneath a rule. The run summary folds its
  steps, including thoughts.
- The model pill (or Cmd+M) opens a searchable, provider-grouped model picker
  (`model_picker.rs`, data and rules in `catalog.rs`). Over the real server it
  lists what `getConfig` reports, with the TUI's rules (`core/catalog/selection.ts`,
  `summary.ts`, `tui/model/display.ts`, `continue.ts`):
  - A new thread lists every enabled provider; an open thread stays on its own
    provider, so only that provider's models are listed, even if the provider
    has been turned off since. A model the user hid (`models hide`) is left out
    unless the thread is on it. A "default" tag marks the catalog's default; a
    "Low–Max" range shows the reasoning levels a model takes.
  - A provider that is not installed has its models disabled; one that is
    installed but signed out shows the server's own status ("Run codex login")
    and can still be chosen, as the TUI does.
  - Each select option of the chosen model (reasoning effort, say) is a
    segmented control; the level in force is the chosen one, else the catalog's
    current/default, else medium (or the middle level). Switching model keeps
    flags and any option value the new model also offers, and sets missing
    reasoning levels to their default (`Catalog::rebase`).
  - An open thread changes model with `thread.model-selection.set` (shown at
    once; a refusal puts the old model back). A new-thread draft keeps the
    choice in `Workspace.new_model` and sends it on `thread.create` and
    `thread.turn.start`. The catalog is read on connect and again whenever the
    picker opens, so a newly hidden model or a signed-in provider shows up.
  - The transcript's author line and the pill use the catalog's name and the
    provider's colour (`provider-claude`, `provider-opencode`, else ink).
  Not done: arrow/Enter keyboard navigation in the picker, the per-thread model
  of each past turn (the thread's current model labels every turn), and the
  "default" tag following the settings' Model (only the catalog's default).
- Cmd+I or the title-bar control toggles the inspector. Ctrl+T, Tasks or the
  inspector's Tasks header toggles its pinned tasks. Drag the inspector's left
  edge to resize it; it never takes the turn below 480pt.
- Cmd+K, Ctrl+P, or the search field opens the thread and action palette.
  Type to filter and press Enter to pick the first match. Right-click a
  sidebar row to act on it, or use the header's Actions menu. Shift+F10
  opens the selected thread's menu; F2 opens Rename.
- Settling a thread also settles its tasks. If the family has running or
  queued work, confirm before stopping it. Unsettle wakes the family.
  Snoozed threads stay visible and can be unsnoozed early. Archiving removes
  a thread from the list; open Archived to restore it. Deleting is permanent
  and asks for confirmation. Escape closes the action menu or dialog first.
- Continue in a new thread carries the conversation and its tasks over. Pick
  a provider, model and effort in the dialog. The current provider waits for
  a known usage reset; a different provider can start without that wait. You
  can also schedule or cancel a continuation in the existing thread. A
  prompt-based hand-off starts a separate thread; delegation starts a task.
- Ask a side question without adding to the conversation. Only one can be
  in flight at a time; Show last side answer reopens the answer for that thread.
  Right-click a message with a checkpoint to revert to before its turn, with or without
  restoring files. A reverted prompt returns to the draft.
- Git, Diff, Agents and Background show the server's data (fixtures with
  `--mock`). The mock usage control opens Context.
- The composer preserves native multiline input, Unicode grapheme deletion,
  Left/Right, Up/Down, Select All and paste. Enter sends; Shift+Enter adds a line;
  Cmd/Ctrl+Enter queues while a turn runs. Send uses the same action. In the mock, Stop (Escape) cancels the simulated
  reply; late words from that reply cannot mutate a later turn.
- Tab and Shift+Tab move focus between controls; the focused one carries a
  2px `live` ring. Hovered controls show a tooltip with their shortcut as a key
  cap; the toolbar controls (search, Tasks, inspector, stop, send) show the
  same tip while they hold keyboard focus, since GPUI hides hover tooltips in
  keyboard mode.
- Cmd+Q quits. Nothing persists after exit.

The interaction below describes the mock window (`--mock`).

New-thread creation, attachments, settings, access selection, commit history,
real usage, queued-send execution and forge actions are not wired to a
backend; their controls say so in a tooltip. The initial running fixture stays
live until Stop is clicked.

## Look and motion

Numbers come from the mockup's HTML/CSS (`design-system/mockups/agent-desktop/source/`)
and `tokens.json`. The mockups and `screenshots/` are not in git: run
`python3 sync-design-system.py` to fetch the mockups, and the capture script
to make screenshots. Both paths are ignored in `.gitignore`. Values also come from `tokens.json`; colours, radii, strokes and the float shadow are read from
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

## Driving the window without focus (automation)

For checking the app while someone is using the computer: the window is created
hidden and never activated, so it cannot come to the front or take keyboard
focus. It is compiled only with the `render-harness` feature and runs only when
`MOXEN_DESKTOP_AUTOMATION` names a script; a normal build ignores it.

```sh
python3 automate.py script.txt --mock     # --mock for fixtures, or omit for the real server
```

`automate.py` builds with the feature, runs the script and, on macOS, samples
the frontmost application (`lsappinfo front`) for the whole run and fails if it
is ever the app itself (you switching apps meanwhile is fine). Input goes into GPUI as platform events (no OS event, no accessibility
permission) and a screenshot is GPUI's own offscreen render of the frame, in
Retina pixels, without the native traffic lights. One command per line; a line
starting with `#` is a comment:

```text
wait 500                  # run frames for 500 ms, so animations advance
move X Y                  # pointer to a window point (points, origin top-left)
click X Y                 # also rightclick X Y
scroll X Y DX DY
key cmd-k                 # a keystroke: enter, escape, tab, shift-tab, cmd-k
type some text            # the rest of the line, as written, into the focused input
screenshot out/main.png
quit
```

The app waits 1.5 s for its first frame (and the server's first snapshot)
before the first command. It exits non-zero, naming the line, on a bad script or
a failed command. Frames are drawn on demand, so a timer or animation advances
only during `wait` and between commands. macOS was exercised; Windows and Linux
were not.

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
thumbnail in the fixture; the Git fixture is a shortened history and one
pull request.

## Implementation and design assets

`ThreadSource` remains the data boundary for thread/transcript and inspector
data. `mock.rs` owns the fixtures and `live.rs` the real server's threads.

- `workspace.rs`: selection, per-thread UI state, subscriptions and timers.
- `title_bar.rs`, `sidebar.rs`, `inspector.rs`: window regions and controls.
- `thread_view.rs`: reading column and composer shell.
- `steps.rs`: compact tool/thought rows, syntax colours and expanded output.
- `model_picker.rs`: model and effort popover.
- `catalog.rs`: the providers, models and efforts `getConfig` reports, and the
  TUI's selection rules over them (offered models, names, effort, rebase).
- `composer.rs`: native input, shaping, caret and hit testing.
- `theme.rs`: colour, pixel-token, focus-ring and shadow resolution through the
  pinned tokens, and layout constants.
- `ui.rs`: shared primitives: icons, state glyphs, controls and tooltips, key
  caps, `Segmented`, section labels and transition timing.
- `inspector.rs`, `usage.rs`: the pinned checklist, tabs and the Context view.
- `work.rs`, `work_view.rs`: data and inspector controls for checklists,
  delegated threads, provider subagents and background jobs.
- `git.rs`: the Git and Diff data and its rules (decoders, patch parser, CI
  glance, ages, the open-request prompt); `git_view.rs` draws the tabs and runs
  their controls; `diff.rs` draws a file's hunks; `mock_git.rs` is the fixture,
  written as the server answers and read by the same decoders.

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
