# Agent on desktop

Moxen Agent has two clients: the TUI and the desktop app. They share their ideas, words, keys and order. They don't share a layout. The TUI's layout is shaped by what a terminal can't do. The desktop app keeps the ideas and drops those workarounds.

The reference screen is the [Agent desktop mockup](../mockups/agent-desktop/main.png). When this page and the mockup disagree, this page wins.

## Keep from the TUI

- **The five states and their glyphs**, on threads, tasks, subagents and the live step.
- **Order:** threads on the left, the turn in the middle, details on the right.
- **Threads grouped by project**, with subthreads nested under their parent.
- **Its colour.** Project badges are filled with the project's label colour. Model names take their provider's colour (Claude is `label-1`). Effort is `label-5`. Context categories and plan usage have their own colours, and commands get syntax colours. These are identity and category colours from the `label-*` set. They never stand in for a state.
- **Every step stays visible**, thoughts included.
- **The same words and shortcuts:** ⌘K, ⌃T for tasks, "Compact", "Keep full history".

## Do differently on desktop

### Window

- The thread's name appears once, in the title bar, after the Agent mark: `project / thread`. The mark's head turns `live` while the thread runs.
- The title bar also holds the live state ("◐ Working · 4m 12s"), the **Tasks 3/6** toggle and the inspector toggle (⌘I). Nothing else goes there.
- Regions are separated by a `rule` line and a change of surface. Panes don't carry their name in the border on desktop.
- There are no rows of key hints. A shortcut lives in its control's tooltip and in menus.

### Sidebar

- At the top: search with ⌘K and a new-thread button, then a `Segmented` control for All, Projects and This project.
- Project headers use the filled badge and the name. Each thread row shows its state glyph, title and age; a selected row sits on `sunk` with a `live` bar.
- Settled threads and Settings sit at the bottom.

### Turn

- The transcript is a centred reading column of about 720px. Prose is `body` at 15/1.6, since people read it for hours.
- **Agent messages** have a header with the model name in its provider colour and the time, then the prose. There's no avatar, bar or bubble. While live, the header shows "◐ working · 4m 12s" on the right.
- **Your messages** are a `sunk` pill on the right. Images sit above the pill as chat-style thumbnails, not file chips.
- **Steps (tool calls):** one row each.
  - The row is a tool icon (read is a blue file, a command is a green `$`, an edit is an amber pencil, a thought is a grey ✻), a verb in Next, the target in Mono with syntax colours, and the time on the right.
  - Clicking a row shows its output, diff or script underneath, indented under a thin rule.
  - There are no boxes and no tree lines. A finished run folds into "Ran 4 commands, read 3 files · 38s".
- **Thoughts** are steps too. The row shows the start of the thought in italic `ink-2`, and clicking it shows the whole text.
- **Edits** close with a one-line receipt: "Edited 3 files +266 −64 Review". Review opens the Diff tab. A receipt is never a card.
- **Usage limits** are three lines:
  1. A band tinted `broken` reading "Usage limit reached", with the limit and its reset time.
  2. A dotted pause line with how long the thread was paused.
  3. An amber ↻ with "Continued after the reset".

### Composer

- The composer is one control: who it goes to, the text, attach, stop and send.
- Model and effort are one pill ("Opus 5.5 Medium"). It opens a small popover with:
  - search at the top;
  - models grouped by provider, one line each with the context size and a ✓ on the current one;
  - effort as a `Segmented` control.

  The popover has no descriptions, tags or subtitles. Access is its own chip next to the pill.
- Queued messages sit just above the composer, with Edit and Send now.
- Under the composer is one status line:
  - the branch and its uncommitted changes, which opens Git;
  - one pill with context and plan usage, which opens Context. Two numbers that lead to the same place share one control.

### Inspector

- The inspector replaces the side pane. It can be closed (⌘I), resized, and widened for diffs and commits.
- **Tasks** are pinned at its top: "Tasks 3 of 6", a segment strip, then the list with the running task on `sunk`. The title bar's Tasks toggle shows and hides them.
- **Tabs:** Diff, Git, Context, Agents and Background.
  - **Git** shows the pull request with real buttons, then the working tree and history. A commit opens in place, with back, copy sha, open on the forge and widen, then a collapsible message and files that fold open to their diff.
  - **Context** shows a coloured stacked bar with the auto-compact mark, the categories, the heaviest tools and plan usage.
  - **Agents** has two groups. **Moxen threads** are delegated through moxen: each is a full thread, and clicking it opens it. **Provider subagents** run inside the thread and are read-only. Neither group needs an "Open" link, because the row is the link.

### Pickers and popovers

- Popovers float with `shadow-float` and stay small. If a popover needs a subtitle on every row, it's doing too much.

## Components

- **`Steps`:** the one-line steps, with thoughts, folding and click-to-open.
- **`Command`:** a command's syntax colours.
- **`TaskList`:** the pinned plan.
- **`ModelPicker`:** the model and effort pill and popover.
- **`Pause`:** the usage-limit block.
- **`Meter`:** the context bar, with coloured `parts`.
- **`Composer`:** for Agent it uses `controls`, `onStop` and `below`.

Colours come from the label aliases in `tokens.json`: `provider-*`, `effort`, `tool-*`, `syntax-*` and `context-*`. `Trail` and `Furrow` stay for Board and Dispatch.

## Don't

- Don't copy the TUI's layout because it's the TUI's: a permanent third column, tasks wedged between the turn and the composer, or rows of key hints.
- Don't put cards inside panes, boxes around steps, or tree lines down the trail.
- Don't draw task progress as a furrow line. Use the state glyphs and the segment strip.
- Don't use provider logos. Providers are identified by name and colour.
