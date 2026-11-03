# Threads and turns

Long single-line labels scroll sideways when hovered or selected, after a short
pause. Moving away or changing the selection restores the beginning. This
applies to titles, settings, pickers and task labels; adjacent columns stay
still. Longer descriptions and task output wrap inside their scrollable views.

While Settings or another modal is open, its keyboard input cannot edit or send
the composer draft, answer a pending agent question, or approve a tool beneath it.
Closing the modal restores normal input to the underlying view.

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

Internal image-generation tasks are stored as hidden child threads. They run
and record usage normally, but the server leaves them out of shell snapshots,
thread lists and search, so they do not appear under the parent in the sidebar.
Task-id reads, completion notifications and cancellation still work. The hidden
flag is persisted from creation; ordinary delegated work is not hidden.

A turn's answer is the provider's final message. Notes the provider writes
between tool calls are kept as their own messages, so the transcript folds
them between the calls they narrate. Completed thinking is stored whole;
live thinking streams only.

Failed MCP calls show their failure and the error returned by the provider,
including a reason when an automatic approval review rejects a call.

For Claude Code, OpenCode and Codex, a completed reply can show an estimated tokens per second.
It estimates tokens from the characters streamed in thinking, messages and
tool inputs, and divides by the observed time for those blocks. Tool execution
and waits are excluded; network and stream delays can affect the estimate.
Thinking contributes when the provider supplies it. Codex's estimate covers
streamed messages only: its app-server does not provide tool-input generation
timing, and its reasoning summaries are not full thinking traces. Turns without
streaming measurements, including older turns, do not show a rate.

When one tool call edits several files, its inline diffs have separate sections
with each file's full path and its own added/removed line counts. The tool header
names the first file and how many others the operation touches; counts beneath
a file describe that file's displayed diff.

A provider session stays warm between turns until it has been idle for its
lifetime (`sessionTtl`, 1h unless set; `providers.<kind>.sessionTtl` over it):
no event, no open turn, no background task. Then it is ended (`core/threads/idle.ts`),
and the next message resumes the provider's own session from the thread's
cursor. A wake-up Claude Code schedules inside its own process further out
than the lifetime is lost with it.

When a plan limit stops a turn, a continue can be scheduled for just after
the reset: `autoContinueAtUsageLimit`, or `providers.<kind>.autoContinueAtUsageLimit`
for one provider, at most `usageLimitContinues` (default 2) in a row.

### Protect work before the allowance runs out

`usageProtection` is opt-in: `off` (the default), `notify`, or `auto`.
Claude Code and Codex subscription windows feed the shared account forecast.
Notify shows a notice above the composer with the percentage, estimated working
time left and reset time; its **Wrap up now** action pauses the account's running
threads. Automatic uses the same action without waiting for a click. The server
owns this work, so closing the TUI does not disable it.

The server checks every two seconds, sharing one candidate snapshot with the work
queue: running or queued turns, usage holds and active overrides. A startup scan
finds existing work; store change events keep that set current, with a full scan
every minute for writes from other processes. Idle history is not reread on normal
ticks. Context readings are retained from store events after one initial activity
read per running thread, and completed costs are counted once per server lifetime.

Before interrupting any turn, Moxen persists a hold on every affected thread.
It then asks the model for a safe stopping point, one thread at a time, without
requesting a full summary. The transcript marks this request with a **Usage
protection** notification card, distinct from the later recovery notice.
Continuation is in the same conversation unless the
user explicitly chooses a new thread in Work queue. Sending an immediate user
message after protection releases that thread's hold, cancels its automatic
recovery entry, and disables protection for that thread until the provider's
next allowance reset. Other threads remain protected. The override survives a
server restart; protection re-enables automatically at a known reset time or
when telemetry reports a reset. Scheduled/explicitly queued messages and internal
notifications do not disable protection. A
wrap-up stops at 97% reported usage or after two minutes; threads that cannot
start one safely wait without spending more. An interruption is not a rollback:
edits already on disk remain. Provider telemetry can lag or be missing, and
other clients can spend the same allowance, so this cannot guarantee staying
below a limit.

The forecast learns active thread-time and dollars per percentage point separately
for each window; user-input and approval waits are excluded. It budgets cached
reads, cache writes and 4,096 output tokens for each model's wrap-up, with a 50%
margin and at least two percentage points of reserve. Before calibration or for
unknown model prices, it reserves two points per running thread. Claude's reported
cumulative cost is counted by gains (native child costs are not added again);
Codex tokens use a dated API-equivalent price table. `usage status --json` labels
the cost source. These are estimates, not subscription charges or an invoice.

Recovery waits for the reset of the window that triggered protection or ran out,
with a short grace period. If several windows triggered it, recovery waits for
all of their resets. A manual wrap-up with no triggering forecast waits for the
window with the highest usage percentage; ties use the earliest reset.
After that, all reported windows must
have room. `usageRecovery` supplies the initial concurrency for recovery entries:
`parallel` admits eligible work together; `sequential` admits one entry at a time
per provider. The queue exposes the order and lets each entry change this choice.
Automatic continuation also requires `usageMinimumSession` (3% by default) and
`usageMinimumWeekly` (5%) remaining. Zero removes that discretionary reserve,
never a provider's actual limit. An entry may require a larger minimum.
Missing reset times keep work held until the provider supplies one. Queue order,
phase and holds survive a server restart. Settled and snoozed threads are not
automatically resumed. Turning protection off stops new automatic holds but does
not discard an existing queue: use **Cancel recovery** to remove an entry without
sending its queued messages. A failed pause or recovery stays visible for inspection.

Same-thread continuation is the default and does not spend allowance on a full
summary. A queue entry can instead choose a new thread with a **stored handoff**
(no model usage) or a **model handoff** (spends remaining allowance). The latter
runs a focused summary turn: the model submits the payload through
`submit_handoff`, scoped to that pending request. Successful durable submission,
not final-response prose, is the acceptance boundary. A later usage failure does
not discard an accepted payload. If no payload is submitted, Moxen uses the stored
handoff. Summary generation uses current allowance before the destination's start
conditions are met, and is stopped after two minutes of running or a reported
hard limit. It does not silently retry summary generation. Both paths keep original
image paths outside transcript trimming and carry the selected entry's unsent
request. Other queued/scheduled requests stay on the source thread. Destination
identity is persisted before creation to avoid duplicate handoffs after restart.
A delegated task that continues in a new thread stays its parent's task: the
parent is not told when the source hands off, and is told once when the
continuation settles, by its new taskId with the original one named. A thread
that continues while tasks it delegated are still running takes them along:
the handoff lists them, and their notifications go to the new thread.
A provider's prompt cache lasts minutes up to an hour, so a recovery long after
the thread's last activity reads the whole conversation again. With
`usageColdResume handoff`, a due automatic recovery whose thread has been idle
longer than `usageColdResumeAfter` (default `1h`) and whose last context reading
is at least `usageColdResumeTokens` (default 65,536) becomes a stored handoff
into a new thread instead. Missing activity or context data keeps it in place.
The older `usageContinuation` config key remains readable but is hidden; new
protection entries default to continuing here. Automatic usage-limit continuation
and long-thread compaction do not compete with a held wrap-up.

### Work queue and conditional scheduling

Open **Work queue** from the Command Palette, including from the new-thread
view. **Schedule work** queues the composer draft (or the first message of a new
thread) with conditions. **Schedule message** keeps the existing date/time picker.
The server owns admission, so closing the TUI does not cancel queued work.

Each entry can wait for a date/time, the next reported session/weekly reset,
a minimum remaining allowance, a provider running out or entering protection,
or a thread/queue entry finishing. All of its conditions must hold. An **After**
provider event is latched once observed; **While** checks the current state.
Missing quota/reset data blocks explicit usage conditions rather than guessing.
Conditions may refer to a different provider from the one that will run the work.
Blocked entries do not prevent unrelated eligible provider lanes from proceeding.
Finishing dependencies include completed, failed and interrupted work; a thread
dependency waits until none of that thread's turns are running or queued.
An entry dependency follows a handoff to its destination instead of treating
summary preparation as completion of the queued work.

Use Move up/down or Move first/last to order work, Hold/Release to control
admission, and Remove/Add back held to withdraw or restore an entry without
deleting its stored message or thread. Space selects entries; changes to concurrency,
continuation and conditions apply to the selection. Failed/interrupted managed
entries remain visible for inspection and an explicit retry. A restarted server
never blindly replays a provider request whose acceptance is uncertain.

The same controls are available without a TUI:

```sh
moxen config set usageProtection auto
moxen usage status --json
moxen usage wrap --provider codex
moxen usage queue --thread <id> --move first
moxen usage queue --thread <id> --move last
moxen usage queue --thread <id> --move cancel
```

For Claude, `providers.claude.usageWrapUp=provider` leaves stopping to Claude
Code's native allowance instead of requesting Moxen wrap-up. In automatic mode,
Moxen holds and recovers threads that report native wrap-up without interrupting
that allowance or sending a second wrap-up prompt. Claude applies the allowance
automatically to eligible accounts; its SDK has no documented enable/disable
switch. This setting selects who initiates stopping, not account eligibility.
Even in Moxen mode an already-running native allowance is respected.

See [provider contracts](providers.md#usage-protection-contracts) for supported
quota sources and the limits of tool-call enforcement.

Runtime instructions are headed sections — Environment, Look it up, Moxen
knowledge base (when its tools are available), Progress
notes, Showing images, Layouts, charts and states (not for a delegated task,
whose report another agent reads; OpenCode adds Checklist and Subagents),
Shell, Messages from Moxen, Memory, Web, and for a delegated task Your task —
followed by the user's own
instructions, in this order: the global `instructions`, the provider's
`providers.<kind>.instructions`, the project's `moxen.json` `instructions`,
then (on the Moxen Harness) the profile's. The Environment section names the
app, Moxen; which harness it is comes from the provider's own base prompt, so
no section says it twice.

A reply can show images and data as a layout. A fenced block tagged
`moxen-ui` holds JSON (`core/threads/uiblock.ts` is the schema, and the
Layouts, charts and states section is what the model is told): rows, columns
and grids of images, text, bar charts, progress rows, key-value lists and
status grids. An image can be cropped (which is also the zoom), padded to a
shape and annotated with boxes, arrows and highlights, and two images can be
laid over each other or differenced. The TUI draws it from the theme's colours
and stacks it in a narrow pane; under a modal the images are text cells.
Only images in the visible part of the transcript hold native image resources;
scrolling them out releases those resources while keeping their space in the reply. A
block that is not valid, over a limit (8 images, 4 levels, 12 bars, 20 rows) or
still streaming stays the code the model wrote, and the desktop app, which has
no renderer for it yet, and the CLI show it the same way. Images are files on
the machine the session runs on, read by path.

Click an image to open the viewer on that picture. Left and right step through
the loaded images in its layout block, showing each caption. Use +/− or the
mouse wheel to zoom. The fitted image grows across the canvas and clips at the
pane boundary. Use 0 (or the percentage button) to fit again, up/down and
Shift+left/right to pan, or drag the image. Stepping to another picture resets
the view. Esc, the close button and a click outside the pane close the viewer;
the composer stays below it.

The Shell section is built from the machine (`core/threads/shells.ts`): its
platform, the login shell and the shells found on `PATH`, and whether the
command-line tools are the BSD ones or GNU. A Windows session is told which
shell its harness runs commands in. The text therefore differs per machine,
which is safe because a conversation's copy is frozen when it begins.

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
- A waiting message runs in the thread's mode when it starts, unless it was
  sent with its own mode.
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
  `memory_search`, `memory_save`, `memory_edit`, `memory_append` and
  `memory_delete` on the `moxen` MCP server. The model picks the scope.
  A delegated task gets `memory_read` and `memory_search` only.
- **Reading:** the index is not shipped in the runtime instructions: it can
  reach 200 lines / 25 KB, and `memory_read` with no name returns it as it is
  now, so the rules point there instead of duplicating it. A memory itself is
  read on demand, and the agent decides which ones the work touches.
- **Searching:** `memory_search` searches names, descriptions and bodies in
  the current project and global memory, including entries omitted from the
  capped index. An optional `scope` restricts it to `project` or `global`.
  Keywords are case-insensitive and split at punctuation, including short
  terms such as `CI`. Any keyword can match; more distinct matching keywords
  rank first, then matches in names and descriptions, weighted twice as much
  as body matches. Ties prefer project memory, then name order. Results include
  short excerpts; read a result in full with `memory_read` and its name and
  scope. `limit` defaults to 10 (1–50); queries are at most 1,000 characters.
  Searches read the current files and never download anything.
- **Semantic search (optional):** choose **With embeddings** in onboarding,
  or enable **Memory embeddings** on the **Memory** settings page. This
  explicitly authorizes installing the pinned Transformers.js 4.3.2 runtime
  and EmbeddingGemma 2 q4 text weights on the server. Setup tests retrieval
  against six labelled queries with distractors, including Spanish; every
  query must retrieve its expected document and warm query p95 must be at
  most one second. This is a readiness smoke check, not a general accuracy
  benchmark. Setup then backfills global memory and every registered project
  with memory enabled; semantic search is activated only after all steps pass.
  Failure offers retry or keyword memory, and progress/results appear inline.
  `moxen memory embeddings setup` remains an administrative option for the
  current project (`--all` for every registered project).
  The model is about 207 MB, plus roughly 471 MiB of runtime dependencies.
  No vision or audio weights are loaded. A project's `moxen.json`
  may set `memoryEmbeddings` to override the global preference; memory off
  still wins. Changes apply to the next search without restarting the server.
  Native inference runs in a managed process. Setup tries WebGPU on Windows
  and macOS, with CPU fallback if loading, correctness or latency checks fail.
  The passing backend and measurements are saved against the pinned runtime
  and model identity. Search is fully offline, combining the
  keyword and cosine rankings by reciprocal rank fusion (`k=60`), with exact
  memory slugs first. Semantic candidates are the ten highest cosine matches;
  keyword candidates remain available regardless of semantic rank. This is
  retrieval ranking, not a calibrated confidence score.
  Content/model-versioned sidecars are rebuilt from memory files after writes
  and before search. Missing or corrupt cache files are repaired; edits and
  deletions cannot reuse stale vectors. Searches use keywords while indexing
  is busy. An incomplete cache contributes only compatible vectors; a search
  repairs at most eight entries within a 15-second inference budget and keeps
  all keyword matches. Documents are truncated at 2,048 tokens for inference;
  keyword search still covers their entire body. `moxen memory embeddings rebuild`
  repairs the current project's cache (`--all` for every registered project).
  `moxen memory embeddings status` reports loading, readiness, failures and
  download files and per-file progress; `unload` cancels pending inference and releases
  the model. **Model loading** (`memoryEmbeddingLoading`) defaults to **Keep
  loaded**: a validated local model loads asynchronously at server startup and
  stays resident until shutdown. **On demand** loads on the first search and
  unloads after 60 seconds idle. Startup never installs or downloads anything;
  a missing or incompatible readiness record requires setup again to preload.
  Disabled or failed inference leaves keyword search working; a requested
  semantic search reports when it fell back to keywords, including in the
  model-visible MCP response when there are no keyword matches. Its 15-second
  inference budget cancels queued requests too; an active inference is stopped
  by terminating the model process. Filesystem reads and keyword matching are
  outside that inference deadline.
- **Rules:** always on while memory is (`MEMORY_GUIDANCE` in
  `threads/instructions.ts`): what to save, what to skip, which scope.
  Lessons from a session are saved on the agent's own initiative.
- **Claude Code:** its auto memory is off in Moxen's sessions
  (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the process Moxen starts), so
  there is one memory, not two. The user's own `claude` keeps its memory.
- **Switching off:** the `memory` setting, or `"memory": false` in a
  project's `moxen.json`. Each provider also has a Memory participation switch
  (`providers.<kind>.memory`); a provider cannot override global/project off.
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

Codex uses the Harness `ask` tool in that same answer panel, waiting until it is
answered or dismissed. Its native question tools are disabled. Previously
opened native asynchronous questions remain answerable while the agent keeps
working. They stay pending after its turn finishes, and across a server restart,
until answered or dismissed. Answering steers a running turn or starts a normal
follow-up turn when idle; dismissing closes the question without sending an
answer. These questions do not become final-answer text or pause the work clock.
Answer-panel replies stay in the ledger for delivery and recovery, but do not
appear as user messages in the conversation.

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
