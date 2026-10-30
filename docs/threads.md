# Threads and turns

## Lifecycle

A turn goes from queued to running to settled. A running turn records the
process running it (pid and host). If that process dies mid-turn — a
crashed server, a killed CLI, a TUI closed during a turn — nothing would
ever settle it, so the next operation that touches the thread interrupts
the orphaned turn and runs the one queued behind it. A turn owned on
another host is never judged.

When a turn settles, its checkpoint and its context-window reading are
written before its outcome, so anyone who sees the turn complete also sees
both. Each turn records the model it actually ran on.

A turn's answer is the provider's final message. Notes the provider writes
between tool calls are kept as their own messages, so the transcript folds
them between the calls they narrate. Completed thinking is stored whole;
live thinking streams only.

A provider session stays warm between turns until it has been idle for its
lifetime (`sessionTtl`, 1h unless set; `providers.<kind>.sessionTtl` over it):
no event, no open turn, no background task. Then it is ended (`core/threads/idle.ts`),
and the next message resumes the provider's own session from the thread's
cursor. A wake-up Claude Code schedules inside its own process further out
than the lifetime is lost with it.

When a plan limit stops a turn, a continue can be scheduled for just after
the reset: `autoContinueAtUsageLimit`, or `providers.<kind>.autoContinueAtUsageLimit`
for one provider, at most `usageLimitContinues` (default 2) in a row.

Runtime instructions end with the user's own, in this order: the global
`instructions`, the provider's `providers.<kind>.instructions`, the project's
`moxen.json` `instructions`, then (on the Moxen Harness) the profile's.

## What a new thread starts with

One rule, most specific first, the same for `moxen handover`, `moxen threads create` and a thread started from the TUI (`resolveModelSelection` in `core/catalog/selection.ts`; the TUI marks the same model as the default in its picker):

- **Provider:** the request, then the project's stored default, then the global Provider, then the installation default (Claude Code when it is installed, or `MOXEN_DEFAULT_MODEL`). A project's own default beats the global Provider.
- **Model:** the request; the project's model when the thread is on the project's provider; the provider tab's Model; the global Model, only when the global Provider is this provider (a model belongs to one provider, so with no global Provider the global Model is ignored and the settings page says so); then the installation default's model when it is on this provider. A provider with none of these asks for `--model`.
- **Effort:** the request, the provider tab's Effort, then the global Effort. With no global Provider, the page offers only the levels every provider's model takes.
- **Permissions:** the request, the provider tab's Permissions, then the global one.
- **Checkout or worktree:** the request, the project's stored default, its `moxen.json`, then the global Thread environment. `auto`, which always meant the checkout, still loads and reads as `local`.

A follow-up, and a delegated task, keeps its parent thread's selection unless the request overrides it, and never falls back to the settings or the installation default.

## Modes: Build, Research and Orchestrate

A thread is in one mode until the user changes it: **Build** (the default),
**Research** or **Orchestrate**. Research and Orchestrate are procedures
for delegating (`core/threads/modes.ts`): Research runs researcher agents,
a critic and a finalizer towards one report; Orchestrate splits the work
into tasks, each on the model that fits it. Both share the same steps for
budget, memory, a model per task and isolation.

- **Switching:** Shift+Tab cycles the thread's mode and it stays until
  changed (also `--mode research|orchestrate` on `moxen handover` /
  `threads create`, or the `thread.interaction-mode.set` command).
  `/research` or `/orchestrate` in the composer are for one prompt: with
  text after them, that prompt runs in the mode; alone, the mode is armed
  for the next prompt (the same command again disarms it). Either way the
  thread's own mode is untouched, and the next prompt is told the mode is
  off. On the wire it is `interactionMode` on `thread.turn.start`. There
  are no trigger words: a false trigger would spend usage on delegated
  tasks.
- **Fixed while a turn runs:** the mode cannot change while a turn is
  running, by Shift+Tab, `/research`, `/orchestrate` or
  `thread.interaction-mode.set`, and a steer, an inject or a queued send
  carries no mode (`MODE_LOCKED_WHILE_RUNNING`). In the TUI a mode command
  typed during a turn stays in the draft and the composer says why. Once the
  turn stops, the mode changes again.
- **Delivery, cache-safe:** never in the system prompt. On Claude and the
  Moxen Harness the procedure goes ahead of the next prompt as a
  `<moxen-mode>` block, once; going back to Build sends a short "mode is
  off" note the same way. Which mode each provider's conversation was told
  is kept on the thread (`modeState`), and forgotten after a compaction or
  a revert so the procedure is sent again. On OpenCode it is an instruction
  entry (`moxen-research` / `moxen-orchestrate`), removed in Build.
- A new thread starts in Build unless a mode is picked while drafting it,
  and a delegated task runs in Build unless the model that delegates asks for Research (`delegate`'s `mode`); a task is never in Orchestrate.
- The TUI shows the mode as the composer's left-edge colour (Build sky,
  Research violet, Orchestrate fuchsia), its running pulse, and in the
  footer.

## Memory

Moxen keeps one memory per project, and one global, for every provider
(`core/memory/`), modelled on Claude Code's auto memory but owned by Moxen,
so a change on Claude's side does not change it.

- **Where:** on the server, never in the repository:
  `<store>/memory/global/` (about the user, for every project) and
  `<store>/memory/projects/<projectId>/`. One file per memory, with
  `name`, `description` and `type` (`user`, `feedback`, `project`,
  `reference`) frontmatter, and `MEMORY.md`, the index, which Moxen writes
  itself on every save and delete.
- **Tools:** `memory_read` (no name: the index as it is now),
  `memory_save` and `memory_delete` on the `moxen` MCP server. The model
  picks the scope. A delegated task gets `memory_read` only.
- **Reading:** a conversation starts with both indexes in its runtime
  instructions (global first, each capped at 200 lines / 25 KB), and keeps
  the index it began with: a save later does not rewrite a cached prompt.
  A memory itself is read on demand.
- **Rules:** always on while memory is (`MEMORY_GUIDANCE` in
  `threads/instructions.ts`): what to save, what to skip, which scope.
  Lessons from a session are saved on the agent's own initiative.
- **Claude Code:** its auto memory is off in Moxen's sessions
  (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the process Moxen starts), so
  there is one memory, not two. The user's own `claude` keeps its memory.
- **Switching off:** the `memory` setting, or `"memory": false` in a
  project's `moxen.json`.
- **Importing Claude's:** only on request: `moxen memory import-claude`,
  or Import Claude Code memory in the command palette. `user` memories go to
  the global scope; a memory Moxen already has under the same name stays.

## The activity ledger

The ledger records lifecycle bookkeeping plus one row per tool call,
append-only. Without the tool rows a turn that did real work would render
as a duration over a prompt echo, so rows are written while the turn runs.
A row is only appended when its signature changes, so streamed output does
not flood the ledger. Parked questions land as rows too: the answer panel
reads open questions off the ledger, so a question that never becomes a
row can never be answered. Tool approvals work the same way: a
`permission.requested` row carries the tool, its command or path, and the
agent's reason, and the permission panel (yes / yes for the session / no)
answers it with `thread.permission.respond`.

## Steering

Sending into a running turn steers it when the provider takes mid-turn
input (Claude, OpenCode) and is only recorded otherwise. A steer
never starts a second provider run.

Some providers wake a session on their own — a finished background task,
a monitor event. That output arrives as a turn like any other and is shown
in the side panel's Background tab, which can also list and stop running
background work. Background work lives in the session, so it outlasts a
turn only where the session does: in a shared server, or a client that
stays open.

## Live updates

The instructions a conversation began with are kept, not rewritten. What
changes since — edited rule files (sent as a patch, never the whole file),
MCP server sets, skills — rides ahead of the next prompt.

## Long threads: compaction and hand-off

Models make more tool-call mistakes as their window fills, so a long thread is
either compacted (its history summarised in place) or handed off (continued in
a fresh thread opened with a handoff document). Every provider's settings page
has the same "Long threads" group, and the global Long threads tab holds the defaults:

| Row | Key | Values |
| -- | -- | -- |
| Compaction | `providers.<kind>.compaction`, default `longThreads.compaction` | `provider`, `ask`, `auto`, `off` (the Moxen Harness: `ask`, `auto`, `off`) |
| Compact at | `providers.<kind>.compactAt`, default `longThreads.compactAt` | a line |
| Kept word for word | `providers.harness.keepRecentTokens` | tokens (Harness only) |
| Hand off | `providers.<kind>.handoff`, default `longThreads.handoff` | `ask`, `auto`, `off` |
| Hand off at | `providers.<kind>.handoffAt`, default `longThreads.handoffAt` | a line |
| Per model | `providers.<kind>.handoffModels`, `autoHandoffModels`, `compactionModels`, `compactAtModels` | `model=choice` or `model=tokens` pairs |

A **line** is a share of the model's window (`70%`, 10 to 95) or a size
(`32K`, `256K`, `1M`, or a plain token count; K and M count in powers of
two), with the same meaning on every tab. A share follows the window, so a
bigger model hands off later; a size suits a small local model. The page
offers shares from 40% and sizes from 8K.

**Precedence is specificity only**: the model's own size, then the
provider's tab, then the global Long threads tab, then the built-in default (hand off at
50%, compact at 80%; the Harness compacts at 70% of the window, 60% under
128K), whatever unit each level is written in. The rules are in core
(`core/threads/longthreads.ts`: `longThreadPolicy`, `handoffLineFor`,
`compactLineFor`), and the server applies them after every turn settles,
background turns included (`actOnLongThread` in `core/threads/operations.ts`),
so a thread no client has open is looked after too.

**Hand off.** `ask` (the default) draws a card over the composer with **Hand
off** and **Not now**; `auto` has the server continue the thread itself (the
same handoff document as "Continue in a new thread", and a `thread.continued`
note marked `automatic`, which the TUI follows) once nothing is running that
the new thread would lose track of: no turn, no subthread, no background task
and no queued message. Until then the card names what it waits for. It fires at
most once per thread, and never for a delegated task, whose parent waits on that
thread; that one is compacted instead when it can be.

**Per model.** One row lists the provider's models ("None" until one has
anything of its own); a model opens a page of four fields, each following the
provider until set: Hand off (ask, auto, off), Hand off at (a size from 16K to
1M), Compaction (the provider's choices) and Compact at (a size). `d` lets a
field follow the provider again, or on the list clears a whole model. In the
file each field is its own map: `handoffModels` and `compactionModels` take
`model=choice` pairs, `autoHandoffModels` and `compactAtModels` `model=tokens`
pairs (`config set providers.claude.handoffModels "claude-opus-5=off"`; one
pair per line or comma, `k` and `m` meaning thousands and millions). A model's
own beats the provider's row, which beats the global one. OpenCode's own
compaction is one switch for its whole server, so there a model chooses its
Compaction only while that switch is off, and cannot turn it on. On Claude
Code a model's Compaction and size apply when its session starts.

**Compaction.** `provider` leaves it to the provider: Claude Code's own, which
takes a size under Compact at as its auto-compact window (100K to 1M), or
OpenCode's own, near the model's limit (its buffer, `compactBuffer`, is still
read from the file). `ask` and `auto` are Moxen's: it switches the
provider's own compaction off (Claude Code's `autoCompactEnabled: false`,
OpenCode's `compaction.auto`) and, past Compact at, shows a card or sends
`/compact` itself once no turn is running and nothing is queued. Because the
provider's own is off, `ask` does not wait forever: a delegated task is
compacted at the line, and any thread halfway from the line to a full window is
compacted unasked, with a notice saying why. A turn that is running does not
get to run past the line: when a context reading during it (each request's usage
is read as it arrives) is over the line that would compact the thread once the turn
ended (`auto`, a delegated task, or past the hard line on `ask`), Moxen stops the
turn, compacts, and sends a continue so the task goes on from where it was
(`compactMidTurn` in `core/threads/operations.ts`). A compaction that left the thread
past its line is not repeated until it has dropped below it once. `off`: nobody
compacts. With Claude Code compacting by itself, a model's own Compact at size
becomes that model's auto-compact window (100K to 1M) when its session starts;
on the Moxen Harness a profile's own compaction still wins for its models. The Moxen Harness compacts inside its own loop: its own
compaction is `auto` (so a global `provider` means `auto` there). On `ask` it
offers the same card at the line its loop would use (the profile's, the
model's, its tab's, or its rule by window size), and the loop compacts unasked
only past the hard line, so a long turn never runs into the wall (see
[providers](providers.md)). Left unset on every tab, each provider keeps its own
default: Claude Code asks, OpenCode compacts by itself, the Moxen Harness by
itself.

**Both lines.** Hand-off is offered first when its line is lower than
compaction's. Past both, the lower line acts first: compaction set below the
hand-off line runs even with hand-off on Automatic, and the thread is handed
off if compacting did not bring it back below.

**Older keys** still load and mean what they did: `ui.autoHandoff`,
`ui.autoHandoffPercent`, `ui.autoHandoffTokens`, `providers.<kind>.autoHandoff`,
`autoHandoffPercent`, `autoHandoffTokens`, `providers.claude.autoCompact`
(`claude` is `provider`), `autoCompactPercent`, `autoCompactWindow`,
`providers.opencode.autoCompact` and `providers.harness.autoCompact`,
`autoCompactPercent`, `autoCompactTokens`. Each sits at its own level, just
below the key that replaced it, and the page's Default names it when it
applies. `moxen config set` on one still writes it, for an older build sharing
the file, and writes its replacement too.

## Revert

Revert rolls back every provider that saw a dropped turn, then cuts the
ledger. Files stay as they are unless asked back too (`--restore-files`),
in which case the worktree returns to the first dropped turn's snapshot
and the replaced state is pinned under a `revert-*` ref to undo by.

## Usage accounting

Drivers report usage when a turn settles and it is recorded on the turn;
stats add it up. Providers that report nothing contribute zeros:
degradation, never invention.

What a turn records depends on the provider. OpenCode and the Harness record
what that turn spent (OpenCode sums the assistant steps that answer the turn's
messages). Claude records the thread's running total after the turn: it never
goes down, the cost keeps its highest value, and a compaction keeps the counts
and carries on adding to them. Stats read a Claude turn's spend as the gain
over the thread's previous turn, and the thread's total as its final value, so
threads stored before this read the same way; a total that drops (a resumed
process starts counting again) counts as new spend. Where the provider reports a cost
(`costUsd`: Claude's `total_cost_usd`, OpenCode's per-step `cost`) the turn
records it too, an estimate and not a bill; without one the field is absent
and the turn reads as unpriced.

### Stats

`usage.stats` (a server query, range `7d`, `30d` or `all`) turns the turn
ledgers into the numbers the stats screen shows; `usage.card` returns the
shareable PNG for a range. Both read every thread that is not deleted, a turn
counting on the day it started in the machine's local time, and a turn still
queued counting for nothing. Sessions are the threads with a turn in the
range, messages are the user's and the assistant's (not notes Moxen wrote),
and a streak is consecutive days with a turn. Cost adds the costs providers
reported and stays unset, never zero, where none did; a reported zero (a free
model) is free. A Claude turn's spend is the gain over the previous turn, as
above, so the instances stored as running totals are the Claude ones
(`core/usage/statsstore.ts`).
