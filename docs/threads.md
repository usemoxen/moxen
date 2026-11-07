# Threads and turns

Long single-line labels scroll sideways when hovered or selected, after a short
pause. Moving away or changing the selection restores the beginning. This
applies to titles, settings, pickers and task labels; adjacent columns stay
still. Longer descriptions and task output wrap inside their scrollable views.

While Settings or another modal is open, its keyboard input cannot edit or send
the composer draft, answer a pending agent question, or approve a tool beneath it.
Closing the modal restores normal input to the underlying view.

## Improve a draft

Click **improve** in the composer (under **more** in a narrow window) to clarify
an unsent prompt before sending it. The result stays editable and **undo improve**
restores the original while the improved draft is unchanged. It never sends the
prompt or creates a thread. You can keep typing; a response for an older draft
or destination is discarded rather than overwriting your work.

The improver uses Claude Haiku 5.5 through your Claude Code login by default,
regardless of the coding model selected for the draft. To use another model,
change **Prompt improver** on the **Agent context** settings page: its
**Provider** and **Model** (`promptImprover.provider` and
`promptImprover.model`). Only providers that can complete a request with no
tools are offered, which today means Claude Code and OpenCode. A model on any
other provider is refused rather than run; the draft stays intact and the
error names the model and the setting to change. There is no silent fallback.

The improver requires access to the chosen model and sends only the draft,
ancestor `AGENTS.md` rules (`CLAUDE.md` where there is no `AGENTS.md`), and
global, destination-provider, project `moxen.json` and Harness profile custom
instructions. Reference context is bounded to 48,000 characters. The improver
has no tools and sees no conversation history or attachment contents;
attachment markers are preserved. Its instructions ask it to retain your
language, wording and intent without inventing requirements. Errors leave the
draft intact.

## Lifecycle

A turn goes from queued to running to settled. A running turn records the
process running it (pid and host). If that process dies mid-turn — a
crashed server, a killed CLI, a TUI closed during a turn — nothing would
ever settle it, so the next operation that touches the thread interrupts
the orphaned turn and runs the one queued behind it. A turn owned on
another host is never judged.

A queued message outlives the settle it was waiting for when the thread
cannot take it: a snoozed thread, or a provider whose allowance is
exhausted, holds it instead of starting it (the Work queue says the
thread is not active). The server starts it on its own once the thread is
active again and the provider has room — an unsnooze, or the snooze or
the limit lapsing, is enough; no message needs to be sent. A message left
queued any other way still waits for the next message or settle.

A send on an idle thread never jumps ahead of an older held turn: the new
message queues behind it, held for admission in turn, and the send reports
it queued (it waits in the Work queue, it is not lost). The older turn goes
first once nothing blocks it. A held turn that genuinely cannot run yet — a
snoozed thread, a provider with no room — still holds its place, so the new
message waits behind it rather than running first; unsnoozing, or the limit
lapsing, releases both in order. Sending an immediate user message to end
usage protection is the exception: it releases that hold and runs first.
"Older held turn" includes a due one: a continue set for a usage-limit
reset, or a message held behind one, whose time has come. The rule is oldest
first — the new message rides along in the older turn when model and mode
match, or runs next once it settles.

A due held turn starts after the running turn settles, oldest first, with
later held messages batched into it as one turn. It never starts while the
limit still stands, while usage protection holds the thread, or while the
thread is snoozed or settled: those wait for the reset, the release, or the
thread becoming active again. An automatic continue whose time came while
the thread already resumed — a turn ran to completion after it came due —
is taken back before it runs instead of firing as a pointless turn; a turn
that failed or was interrupted does not count as resumed.

When a turn settles, its checkpoint and its context-window reading are
written before its outcome, so anyone who sees the turn complete also sees
both. Each turn records the model it actually ran on.

Internal image-generation tasks are stored as hidden child threads. They run
and record usage normally, but the server leaves them out of shell snapshots,
thread lists and search, so they do not appear under the parent in the sidebar.
Task-id reads, completion notifications and cancellation still work. The hidden
flag is persisted from creation; ordinary delegated work is not hidden.

Research delegation defaults to one read-only researcher. A full research run
is worth the extra cost for claims that matter and need an adversarial check,
not every review or scout pass. It uses a lead, the chosen researchers and
critics, and one finalizer. Each is a separate conversation spending provider
usage; a size of 2 researchers and 1 critic means 5 threads including the lead.
Researchers gather evidence, critics challenge it independently, and the
finalizer composes from validated findings. Every run gets three reviews:
Evidence (is each claim sourced?), Risks (what breaks or is missing?) and
Alternatives (what was not considered?). A run has 1 critic, who does all three
in one verdict with a labelled section for each, or 3 critics, who do one each.
There is no 2: the server refuses it. The server tells each critic its lens, so
the finalizer reads the same labelled structure either way. Usage protection applies to every
role just as it does to any other thread.

The `delegate` tool can suggest a full run with `mode: "research"` and
`researchProposal: { size: { researchers: 2, critics: 1 }, models: { ... } }`.
The optional model entries are keyed by `researcher`, `critic` and `finalizer`,
each using `provider`, `model` and `thinkingEffort`. The suggestion alone creates
no lead or role thread. Only a user answer starts a full run. Without someone
to answer, the task runs as one researcher.

Review delegation is a single reviewer: `mode: "review"` with the PR or
branch named in the task. The reviewer checks the target out in a scratch
worktree, changes nothing in it, proves each finding with a throwaway test
(or marks it read from code) and ends with `VERDICT: MERGE` or
`VERDICT: FIX FIRST` on the report's last line — only a trailing verdict
counts. Pass target-specific questions to attack in the task;
the report answers each one first-class. The task notification and
`task_status` carry the verdict and the review; a finished review with no
trailing `VERDICT` line is said visibly instead of passed on as finished.
When the reviewer runs on the same model as the delegating thread, both say so: a
warning, not a refusal. The comparison reads the models recorded when the
task was delegated, so a parent that moves on cannot rewrite it. The
settled verdict is pinned on the delegation: a conversational follow-up
turn cannot rewrite it, while a follow-up that settles with its own verdict
re-pins. Continuing a review child starts the new thread in Build, with a
ledger note saying Review was reset.

On the CLI, `moxen threads delegate --thread <id> --prompt <task> --mode research`
starts one researcher. Adding `--research-size 2,1` supplies the user's size and
starts a full run without a proposal. `--research-models` accepts the model
entries as a JSON object. Omitted role models inherit the lead's model and
effort, and become the run's fixed defaults; a role tool cannot override them.
`--mode review` starts a reviewer for the PR or branch in the prompt.
Existing calls and CLI JSON envelopes are unchanged.

### Research run view

The TUI shows a run as one sidebar row, the lead's, marked `◈`; the role threads
have no rows of their own and their completions raise no toasts. Opening the lead
shows the run in place of its chat, with no side panel: a header (the run's name,
its phase and the time it has taken or took), a roster with one glyph per agent
(`○` waiting, `◐` working, `✓` done, `✗` failed, `■` stopped; up to 8 researchers,
3 critics and the finalizer) and three live columns, one agent per role. The
phase decides the widths: researchers are wide first, then the critics, then the
finalizer; a column nothing has started in shrinks to a sliver. Below about 66
columns it shows one column at a time under a switcher, roster still on top.

Keys (chat focus): `←`/`→` walk the roster and show that agent in its column, `tab`
moves between columns, `↑`/`↓`/page keys scroll the focused column, `enter` opens the
agent as a normal full thread with a bar to go back to the run (`esc` or a click
on it), `l` (or the footer link) opens the lead's own thread the same way. Clicking
a glyph shows that agent too. A run that is over keeps its view; slots nobody
started are dropped from the roster.

The size picker is a modal asking for a `research.proposal.answer`: researchers
as dots (1–8, a total for the run), critics as two choices (1 or 3), the model and
effort per role, the thread count and the providers. `←`/`→` change the focused
row, `↑`/`↓` move between rows, `enter` starts, `esc` runs one researcher instead.
The TUI opts in (`researchProposals`) for the open thread while it is in Research
or Orchestrate mode or `/research` is typed.

### Research proposal API

The server owns approval; a client only presents it. A capable client opts in
with `subscribeShell({ researchProposals: [threadId] }, ...)`, listing the
user threads for which it can show and answer a picker. A normal shell
subscription does not count. Opt in before requesting research.

- Query `research.proposals` with `threadId`, or read `researchProposals` in
  shell snapshots. Each proposal has `id`, `threadId`, `task`, `target`
  (`delegation` or `user-thread`), `plan`, `leadModel` and `expiresAt`.
- `plan` contains `size` (researchers 1–8, critics 1 or 3) and the resolved
  per-role `models`. Use the model catalog for display names, efforts and
  choices. Count `researchers + critics + 2` threads, including the lead and
  finalizer; the providers are the union of the lead and role models.
- Answer with `research.proposal.answer`, `proposalId`, `choice: "start"`
  and the user's final `plan`, or `choice: "single"` to use one researcher.
  The answer acknowledges acceptance; the original delegation/send resolves
  after it starts (and, when requested, after its normal wait).
- With no opted-in subscription for that thread, fall back immediately.
  Losing the last such subscription also falls back. An unanswered proposal
  falls back after 45 seconds, below the usual MCP call timeout. The deadline
  is absolute; duplicate or late answers fail with `RESEARCH_PROPOSAL_EXPIRED`.
  A `user-thread` proposal (below) has no deadline (`expiresAt` is `null`): it
  waits while the client stays connected, because nothing is waiting on a tool
  call. Only the `delegation` target keeps the 45 seconds.
  Invalid answers leave the proposal pending until corrected or expired.
- Pending proposals are transient, not thread records. Server shutdown cancels
  pending commands rather than starting new work while closing. Clients must
  discard stale pickers on disconnect or when the proposal leaves snapshots.

`/research` (`interactionMode: "research"` on `thread.turn.start`) uses this
same surface. After approval, the user's own thread is the lead; no delegated
lead is created. With a single-researcher answer or no answering client, it
researches directly without role tools. The picker shows for `/research`,
for the first prompt after the user switches the thread into Research mode,
and for the first prompt of a thread created in Research mode (a new-thread
draft sent while Research is picked): the thread keeps a `researchPicker` mark
until that first prompt, not on every message of a thread that stays in
Research mode. Clients that have not opted in keep the
single-researcher behavior.

A full-run lead's `thread.json` stores a
`researchRun`: the lead id, role thread ids with their role and question, state,
and creation/update times. Role threads store `researchRole` with the lead id
and role, and keep their own conversation, turn and usage ledgers. The existing
delegation ledger nests each role under the lead, with notifications disabled.
Only the lead reports back to the orchestrator: one task id, one notification,
and the lead's final answer as the report.

The server offers `research_role_start`, `research_role_report` and
`research_role_cancel` only to a full-run lead, and checks that ownership on
every call. Roles run read-only in Research mode with no delegation or role
tools; ordinary delegated tasks still cannot delegate. Shell snapshots expose
`researchRuns` for run discovery and membership changes. The `research.run`
query returns the lead and roles with current thread/task state and reports;
clients use the existing per-thread subscriptions for each role's live chat.
The run also stores its user-chosen size (1–8 researchers and 1 or 3 critics), role
models and an ordered message log. Older internal runs without a size keep the
8-researcher/3-critic limits. `research_messages` reads that log for the
calling session's run only; neither it nor `research_message_submit` accepts a
target run. Both the role's membership and the lead's ownership are checked.
Submissions are explicit: researchers publish reports, critics publish verdicts,
the lead publishes follow-ups, and the finalizer publishes a final report. Chat
answers alone do not count as submitted reports or verdicts. Starting a role
records its question as a hand-off. The `research.run` query includes this log.

Researcher reports share one findings revision until a critic submits a verdict.
A report after review starts a new revision. Each critic may submit at most three
verdicts across the whole run; new revisions never reset that budget. Finalization
requires at least one critic, and every started critic must have a verdict on the
current revision or have exhausted its three rounds. There is one finalizer.
The chosen researcher and critic counts limit total agents across the run;
finished agents never free slots. A follow-up researcher needs unused capacity.
Caps are checked under the lead's lock before creating
a role thread, so a refused or concurrent over-cap start leaves no orphan thread.

A user's own lead run ends once its lead turn has settled and no role has a
running or queued turn (including scheduled resumes). Later turns cannot reopen
it: ordinary delegation returns and role tools and lead instructions disappear.
A new `/research` can propose a fresh run with fresh caps. The ended run remains
in `researchRun` until replaced, then moves to `pastResearchRuns` on the thread;
`research.run` includes that history and shell snapshots include the old runs.
An old role's `research.run` still reads its original run, but it cannot submit
to a newer run or gain delegation. Delegated leads keep their task lifecycle,
one task id, one final report and one notification.

A busy `/research` never opens a proposal. It follows the same send policy as
the single-researcher fallback: existing mode locks, queue and delivery rules
still apply, so a mode change during a running turn can be refused. Maintenance
turns never ask and never spend the question either: a bare `/compact`, a
usage-limit continue, and a held work-queue entry run as they are, leaving the
run-size mark for the first real prompt.

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
The stopping instructions themselves stay hidden; the model's stopping notes
remain in the transcript and thread history. Text already streamed is saved even
if protection interrupts the turn before its result arrives. This also applies
to Claude Code's native wrap-up. Recovery receives those saved notes explicitly,
including when it resumes the same provider conversation; a handoff keeps every
message from the wrap-up, not just its last reply.
Native wrap-up turns keep a **Usage-protection wrap-up** label visible even when
their work is folded.
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

The server command `thread.protect` takes `threadId` and manually protects that
thread. A running turn is interrupted with the same durable pause reason as
automatic protection, then gets one bounded wrap-up turn when allowance permits.
An idle thread simply waits. Manual protection has no window reset: only sending
an immediate user message ends it. This also wins over an existing automatic hold;
a window reset cannot release a manually protected thread. Sending that message
interrupts any remaining wrap-up and starts the user's normal turn first.
Explicitly queued or scheduled user messages do not release protection.
Ending a purely manual hold leaves automatic protection armed; ending one that
automatic protection also placed pauses it until the next reset, as it does for
any automatic hold. Protecting a thread during an automatic wrap-up lets that
wrap-up finish rather than starting a second one. A turn the user's protection
interrupts carries `StoredTurn.usagePause.forced`.
Archived threads cannot be protected, and neither can settled ones: a forced
hold ends on a message, but settled threads refuse messages and the queue
cannot cancel a forced hold, so a hold that outlived its thread would stick
forever. Settling a thread ends its manual protection; a forced hold found on
a settled thread from before is released instead — on the next tick. Automatic
input never unsettles a settled thread while held.

While held, automatic deliveries become durable conditional queue entries rather
than new turns or steers: delegated-task reports (including their structured
facts), messages from a task's parent, question-answer deliveries, usage-limit
continuations, and provider-native task/Monitor notifications. Scheduled messages
keep their existing conditions and are held at admission. Native completion
notifications retain the SDK payload, including the summary and output-file
reference; replay does not look up a still-live task. Provider-native injected
messages retain their text. Held task reports stay in the durable notification
batch instead of starting a wake-up turn behind the hold; an existing batch is
kept when protection begins, and goes out as one message once the thread
recovers, or with the user's releasing turn. Wake-ups retain insertion
order and content across a server restart, then run separately through the work
queue after automatic recovery, or after the user's releasing turn. The existing
allowance reserves and inactive-thread checks still apply. Archived, deleted,
settled or snoozed threads are never admitted automatically.

Native sources include Claude background Bash/Monitor/subagent completions and
injected deliveries, Harness background shells/subagents, Codex native command
and child-thread completions, and OpenCode background shell/subagent completions.
If a provider exposes only a self-started turn rather than its triggering input,
Moxen queues the native start metadata and preserves its resume cursor instead of
silently dropping the wake-up. The original native conversation remains the
source for any trigger text the provider did not expose.

Clients call `ClientApi.dispatch({ type: "thread.protect", threadId })`; it follows
the same paired-remote access rule as ordinary thread commands. The TUI's
`/protect` (listed in the composer's `/` picker, a bare command that is never
sent to the agent and cannot be scheduled) dispatches it for the open thread;
the CLI has no command for it. While held, the TUI shows one line over the
composer: "Thread protected" (by you, when forced, saying a message ends it)
and the number of wake-ups waiting. A turn a forced hold cut off closes on a
"Protected by you" marker with no reset line, and a queued provider
notification (`origin: "background-notification"`) shows as "Background task
finished" instead of its raw payload. In `ThreadEnvelope` (`src/core/types.ts`),
`protection` is present only while held and contains `protected: true`, `forced`
(boolean), and `waitingWakeUps` (queued automatic deliveries and scheduled
messages, excluding the protection recovery entry and removed entries). The field
is available on thread reads/inspection and thread subscription snapshots/updates,
projected in `src/core/threads/project.ts`. Unprotected threads omit it, preserving
existing JSON envelopes. `StoredThread.usagePause.forced` persists the manual hold;
held automatic entries carry `StoredTurn.queue.wakeUp` in the existing turn ledger.

Protection interruptions keep `StoredTurn.status = "interrupted"` for existing
readers and add `StoredTurn.usagePause` in the turns ledger. This records
`provider`, `windows` (each window's `id`, `kind`, `label`, and `resetsAt`),
`resetsAt` (the latest required allowance reset, or `null` when unknown),
`pausedAt`, and `hasUncommittedChanges` (`true`/`false` for a readable git
checkout, `null` when git status is unavailable, including a non-git folder).
It is a snapshot at interruption, not the current working tree or recovery
schedule. Sequential recovery and queue conditions can delay actual resumption.
A normally completed wrap-up and an ordinary user interrupt do not get this
field. Recovery or cancellation does not erase it from the old turn.

Clients read historical markers from `ThreadEnvelope.turnUsagePauses[turnId]`
on `ClientApi.subscribeThread` snapshot frames (`snapshot.thread`), or from
`query({ type: "thread.read", threadId })` (`result.thread`) and
`query({ type: "thread.inspect", threadId })` (`result.thread`). The map is
optional and absent when no turn has pause metadata; a missing entry means no
recorded protection pause, including turns stored by older versions. Join it
to transcript messages and activities by `turnId`; do not infer it from the
latest turn or the thread's temporary recovery hold. The marker renderer is a
client concern. Existing turn state values and CLI JSON goldens are unchanged.

The forecast learns active thread-time and dollars per percentage point from the
cumulative gains since each window's first observed sample, starting over at reset;
each account window is learned separately (Claude's session and weekly, OpenCode
Go's 5-hour, weekly and monthly). User-input and approval waits
are excluded. It budgets cached reads, cache writes and 4,096 output tokens for
each model's wrap-up, with a 50%
margin and between two and ten percentage points of reserve. The ten-point cap
prevents delayed cost reports from stopping work before 87% usage. Before
calibration, or where a running model's wrap-up has no price, it reserves two
points per running thread, capped at ten. Claude's reported
cumulative cost is counted by gains (native child costs are not added again);
turns that report no cost are valued at the model's current prices: the
provider's Model prices rows over Moxen's shipped list, and a model with no
price anywhere counts as zero here. `usage status --json` labels
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
sending its queued messages. Once the recovery turn is running the banner and the
work queue both say the work **resumed**, with no countdown and nothing to cancel;
the entry leaves when that turn ends. A failed pause or recovery stays visible for
inspection.

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
that continues hands every task it delegated to the new thread — running,
idle, finished and cancelled alike, including tasks that themselves carried
on (research roles stay with the run): the handoff lists them, and from then
on steering, `task_status` and completion notifications resolve against the
new parent while the old one reads `TASK_NOT_FOUND`. The re-pointing is one
atomic write, so a notification deciding mid-transfer sees every row before
or every row after it; a report queued and fully delivered just before the
transfer still reaches the old thread — the task's next report, and
`task_status` on the new parent at any time, cover it. A continued thread
starts no new delegations (`THREAD_CONTINUED` names the live thread):
otherwise the row would answer to a dormant thread while its continuation
steers beside it. A
continuation can also change the model: continuing in a new thread keeps the
project, the checkout and the handoff, and takes an optional target
model/provider — the palette's second continue row, or `moxen threads
continue --provider/--model` (with `--thinking-effort`/`--speed-mode` for the
effort; without them a model switch re-resolves effort from the settings, as
for a new thread, while the TUI picker keeps the compatible knobs). The new
thread keeps the source's model unless the request overrides it; a provider
switch names its model. The command takes either a full `modelSelection` or
`provider`/`model`, never both at once. The tasks keep
their own provider and model either way, so the handoff works across
providers and grants no extra access. No extra guard applies when the new
thread runs a more restricted runtime mode: the mode governs only that
thread's own turns, and steering a task is a message, not execution.
A continuation held for the reset inherits the source's usage-limit hold
when the hold applies to it: the new thread runs on the same account (its
model is on the held provider) and the limit still stands (the reset is
still ahead and the allowance is still out). Then the new thread waits,
shows the limit block from the start, and holds task notifications without
spending a turn, and its first turn is the recovery entry that runs once
the reset comes. Otherwise the scheduled turn is created without the hold
and runs at its time. An immediate message still releases a hold and runs
first, as on any held thread. A pause notice batched for the source but not
yet delivered moves to the continuation when it inherits the hold, so the
parent still hears it naming the live task; without an inherited hold it is
dropped, and the task's settle report covers it.
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

The work queue modal is one list, grouped by what is happening: **Running now**,
**Up next** (ready or waiting for a condition) and **On hold**. A line above it
names what runs next and what it waits for. Only the focused entry opens up: it
says in words what will happen (the thread's title and a description, never the
internal prompt), what it waits for as sentences, and the keys that apply to it.
Removed and stopped entries sit below the live queue behind "Removed or stopped".

Every action has a key and can be clicked:

| Key | Does |
| --- | --- |
| `↑` `↓` | choose an entry |
| `ctrl+↑` `ctrl+↓` | move the focused entry earlier or later among its group (held or not) |
| `space` | start selecting; checkboxes appear only then, and the keys act on every ticked entry (`ctrl+a` ticks all, `esc` ends) |
| `h` | hold, or release a held entry |
| `x` | remove (the stored message or thread is kept) |
| `r` | add a removed or stopped entry back, held |
| `c` | conditions |
| `o` | options ("How it runs": one at a time or alongside others of the provider; where it continues) |
| `a` | add a thread to the queue, held, through the thread picker |
| `esc` | back one level; closes at the top |

`c` opens a plain list that reads as a sentence, "Start … when…": an allowance
resets, enough allowance is left, a set time arrives, another thread finishes,
another queue entry finishes, a provider is out or protected. Each choice leads to
the next question (which provider, which allowance, how much, what must happen,
when it counts) and the last answer adds the condition. Below the list, the
entry's current conditions can be removed. A condition can wait on any provider
that reports usage, in each window it can name (session, weekly) or all of them
(`all` covers every reported window, an OpenCode Go monthly one included).
Failed/interrupted managed entries remain visible for inspection and an explicit
retry. A restarted server never blindly replays a provider request whose
acceptance is uncertain. **Schedule work** uses the same steps on one page that
ends in "Queue this work".

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
A picture bigger than the display cap but inside what the decoder reads is
drawn from a smaller copy; one past the decoder's ceiling, or corrupt, cannot
be shrunk — nothing available decodes it — and collapses to one line saying it
could not be drawn, which still opens the viewer on the original bytes for
opening externally.
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
the composer stays below it. An image that cannot be drawn says so in the
viewer's canvas while its header and opening externally keep working.

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

A follow-up, a delegated task, and a thread continued in a new one keeps its
source thread's selection unless the request overrides it, and never falls
back to the settings or the installation default. The continuation's model
request is how a handoff changes models; anything it does not name stays the
source's.

## Modes: Build, Research, Orchestrate and Review

A thread is in one mode until the user changes it: **Build** (the default),
**Research** or **Orchestrate**. Research and Orchestrate are procedures
for coordinated work (`core/threads/modes.ts`): Research offers a full run with
the user's thread as lead, or one researcher when no full run is approved.
Full-run leads use role tools, never `delegate`; the server enforces the chosen
size and review gates. Orchestrate splits the work into tasks, each on the
model that fits it, checking budget, memory and isolation before delegating.
Budget means calling the `usage_status` tool before fanning out: every set-up
provider's windows, fresh rather than the hours-old figures `models` carries,
so work routes around providers at or near 100%.
**Review** is the fourth procedure but not a fourth thread mode: it runs a
delegated review task (`delegate` with `mode: "review"`), or one prompt
(`/review`), and never stays on a thread.

- **Switching:** Shift+Tab cycles the thread's mode (Build, Research,
  Orchestrate) and it stays until
  changed (also `--mode research|orchestrate` on `moxen handover` /
  `threads create`, or the `thread.interaction-mode.set` command).
  `/research`, `/orchestrate` or `/review` in the composer are for one prompt: with
  text after them, that prompt runs in the mode; alone, the mode is armed
  for the next prompt (the same command again disarms it). Either way the
  thread's own mode is untouched, and the next prompt is told the mode is
  off. On the wire it is `interactionMode` on `thread.turn.start`. There
  are no trigger words: a false trigger would spend usage on delegated
  tasks.
- A waiting message runs in the thread's mode when it starts, unless it was
  sent with its own mode.
- **In the transcript:** the command stays hidden, and each message shows
  the mode it ran in: its rail (and its reply's) takes the mode's colour,
  and Research, Orchestrate or Review is named beside the time, with "once" when
  the mode was for that message only. Build looks as it always did. The
  envelope's `turnInteractionModes` (by turn id) carries it, only for turns
  that ran outside Build. A queued or scheduled message shows
  nothing until it starts, because it takes the thread's mode then (unless
  it was sent with its own).
- **Fixed while a turn runs:** the mode cannot change while a turn is
  running, by Shift+Tab, `/research`, `/orchestrate`, `/review` or
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
  entry (`moxen-research`, `moxen-orchestrate`, `moxen-review`), removed in Build.
- **Told once the provider answers:** a mode block, and a runtime instruction
  update, count as delivered when the provider has produced output for the
  prompt that carried them, not when it accepts the prompt. A first turn on a
  conversation that ends with no output (a usage limit stopped it before the
  model ran) is marked `unanswered`: its session handle is dropped, nothing
  is recorded as told, and the next turn starts clean with that turn's prompt
  (a handoff document, say) ahead of it, up to the last turn the provider
  answered, along with the mode block.
- A new thread starts in Build unless a mode is picked while drafting it,
  and a delegated task runs in Build unless the model that delegates asks for
  Research or Review (`delegate`'s `mode`); a task is never in Orchestrate. A thread
  drafted in Research mode asks for the run size on its first prompt.
- The TUI shows the mode as the composer's left-edge colour (Build sky,
  Research violet, Orchestrate fuchsia, Review orange), its running pulse, and in the
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
- **Managing:** the TUI's memory manager shows the same memories the agents
  see: open it from Settings > Memory (Manage memories) or the command
  palette. Memories read global first, then this project, with the same
  search agents use. One opens in full; creating and editing take a name,
  description, type, scope and body. Saving over a name that exists asks
  first, deleting asks first, and a memory another agent saved while it was
  open is shown rather than silently overwritten. Viewing works with memory
  off, and says so; saving, editing and deleting are refused while it is off,
  in the manager, the CLI and on the server.
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
not flood the ledger. A call whose arguments arrive after it starts (OpenCode
begins it pending and then runs it with the command) appends that second row,
and the transcript folds the two onto one card by `toolCallId`, so the command
is visible while it runs. Parked questions land as rows too: the answer panel
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
input and this process holds the session, and is only recorded otherwise
(`steerDelivered` says which; the decision is the driver having `steerTurn`,
a live session, and the steer succeeding, not a list of providers). A steer
never starts a second provider run.

### Messaging a delegated task (`task_send`)

A thread can message a task it delegated, to correct or redirect it instead of
cancelling it. `task_send` takes `taskId`, `message` and an optional `wake`, and
goes through the same send path as `threads send`. The message reaches the task
as a user turn headed "Message from the thread that delegated this task (not from
the user)", stored with `origin: "task-message"`, and the task's instructions say
what that header means. The result's `outcome` reports what really happened:

- `steered`: the running turn received it and reads it at its next step.
- `queued`: the task is busy and its driver cannot take input mid-turn here (no
  `steerTurn`, or no live session in this process), so the message waits and
  runs as the task's next turn. The task has not read it; do not assume it acts
  on it. It is not refused.
- `started`: the task was idle and a new turn began.
- `not_delivered`: the steer was recorded but did not reach the running turn
  (the provider refused it); nothing resends it, so send it again.

A task that has finished or been settled is refused (`TASK_SETTLED`) unless the
caller passes `wake: true`, which starts a new turn and spends usage. The parent
is told again, by a task notification, when the task next has nothing left to
run: the notification is not one-shot, and covers a queued message's turn too.
`task_status` reports `running` from the moment of the wake.

A turn-end notification always fires on time and nothing can hold it. When the
task's turn ends with background work still running, the notification names
that work and for how long (for example "turn ended, 1 background process
still running: bun run check, 4m"), and reads as not finished: the parent must
not treat the task's report as complete. The named list is a snapshot taken
when the notification is assembled; work may have ended or started since.
When that work ends, the task wakes to pick up the result where its provider
allows it, and the parent gets a second notification if the task wakes and
next has nothing left to run. Work its provider never wakes stays visible in
task_status instead of arriving as a notification, and work that never ends
(a dev-server watcher) sends nothing further and blocks nothing. `task_status`
lists what is still running and for how long; past `backgroundForgottenAfter`
(30m unless set) it is flagged as probably forgotten, and Moxen never stops it
on its own. Where Moxen cannot check — no live session here, or a provider
that cannot report it all (OpenCode reports only the background shells and
subagents its own server started) — the notification and `task_status` say so
plainly instead of implying nothing is running.

### A delegated task that runs out of usage

A task that runs out of usage auto-continues as any thread does: a continue
is scheduled for just after the reset (or protection holds and recovers it),
and the work goes on there. Its parent is told twice: once when the task
pauses, with the expected resume time, and again with the normal report when
the task finishes. `task_status` reads `running` while the resume waits,
so a waiter does not mistake the pause for the task failing.

Cancelling that automatic continue ends the resume, and the task will not
pick the work back up on its own. In the TUI this asks first: Cancel and
notify parent (the default), Cancel without notifying, or Go back. Without a
modal — the CLI, or another agent cancelling through `task_cancel` — the
parent is told by default. Either way `task_status` reads `cancelled` from
then on, until a wake (`task_send` with `wake: true`) revives the task.

A parent that has itself run out of usage does not receive task notices yet:
they wait, durably — a restart inside the wait loses nothing — and arrive
together as one message once its usage is back. When its automatic continue
is switched off, there is no recovery to ride on, so they go out with the
user's next message instead, all together rather than each on its own.
Continuing the parent into a new thread moves the wait with it: the live
thread resolves through `continuedIn`, so the new parent gets the message
and the old one gets nothing.

Only the thread that owns a task steers it: the one that delegated it, or the
continuation that took it over. Continuing hands every delegation row to the
new thread — running, idle, finished, cancelled, and carried-on alike — so from then on `task_send`,
`task_ask`, `message_queue`, `task_cancel` and `task_status` resolve against
the new parent and read as `TASK_NOT_FOUND` on the old one, stranger or not.
Reading the task's thread itself stays project-scoped (`thread_read`), so
the old thread can still look at what its former task did. A task keeps its
own provider, model and modes; only the parent link moves, across providers
and models alike, so the handoff grants the new thread no extra access. A `fork: true`
task moves the same way: its conversation was copied at delegate time, and
the continuation shares the checkout, so one owner stays unambiguous.
A research run's lead and roles are never reachable (`TASK_SEND_RESEARCH`):
their messages are scoped and capped by the run, and a free message would be
a way round both. A delegated task, a research lead and a research role are
not offered `task_send` or `task_ask` at all. An empty message is refused as
in `threads send`; there is no length cap, as there is none there.

### Asking a delegated task a side question (`task_ask`)

`task_ask` takes `taskId` and `question` and answers it the way `/btw` answers
a person's: the task's own provider replies on a copy of its session, with no
tools, and neither the question nor the answer is recorded in the task or
touches its turn (`thread.side-question`). It therefore works while the task is
running, and the answer cannot read a file or run a command; the result says
so, so a limit in the answer is not read as a fault in the task. A finished
task answers from its recorded session; a task with no session yet answers
without its context, and the result says that too.

The ownership rule is `task_send`'s: the thread that owns the task asks, and
any other thread reads `TASK_NOT_FOUND`. A research run's lead and roles are
refused (`TASK_ASK_RESEARCH`). A provider that cannot
copy a session returns `SIDE_QUESTION_UNSUPPORTED` as a plain result rather
than an error, so the orchestrator can fall back to `thread_read`. The call
waits at most 45 seconds, then returns a `timedOut` result; the task is
unchanged either way.

### Where a delegated task works

`delegate` defaults to a worktree: the child gets its own checkout on a new
branch cut from the parent's, so two agents never edit the same files at
once. The branch is read from the parent's checkout, even when the parent
thread's record names none (threads the TUI creates record none). A
`fork: true` task always shares the parent's checkout, since its copied
conversation belongs to the directory it runs in, and an explicit
`isolation: "shared"` is for read-only work, or when nothing else writes at
the same time. Where there is no branch to cut from — a detached HEAD, or a
project that is not a git repository at all — there is no worktree to give,
so the call fails with `WORKTREE_UNAVAILABLE` and tells you to pass
`isolation: "shared"`. It never quietly shares your checkout.

OpenCode keys MCP servers by name per directory, so every thread in one
checkout shares a single `moxen` entry. The first thread to start keeps it:
a later session on the same server never replaces it (replacing it would
restart the server mid-call), and when the owning thread's session closes,
ownership passes to the earliest session still running. Each tool call is
routed to the session that made it, so a shared task still gets only its
own tools — a delegated task's `delegate` call is refused even though the
shared listing shows the owner's catalog. A call naming a session that is
not live fails instead of landing on another thread; a call with no session
at all fails too while sessions share the server, and otherwise runs as the
entry owner's thread. Changing the entry itself — the owning thread's own
tool settings changing — still restarts that checkout's server, interrupting
whatever else is running on it; nothing else on the server re-registers, so
nothing else pays that price.

### Starting several tasks in one call (`delegate`)

One `delegate` call takes shared settings (`provider`, `model`, `effort`,
`isolation`, plus `rules`: instructions appended to every task's prompt
under "Common rules for this task") beside a `tasks` list of at most 20
entries. Each entry has its own `title` and `task` text and may override
`provider`, `model`, `effort` or `isolation`; an entry takes no other field.
An entry on another provider does not inherit the shared `model` or
`effort`: it names its own model, or its start fails. `mode` and `fork` are
shared by the whole call. The single-task form (`task` plus `title`) keeps
working unchanged, and `researchProposal` cannot be combined with `tasks`.

What is bad on its face — a malformed entry or list, a forked task in a
worktree, a provider with no model anywhere — fails the whole call with
nothing started. Once starting, each task is on its own: one that fails to
start is reported as that entry's `error` while the rest still start, so the
others are neither lost nor silently doubled. A top-level `idempotencyKey`
is derived per entry from the key plus the entry's own title and task, so
retrying the whole call — in any order, with entries added or removed —
returns each original task instead of starting duplicates; a task's own
`idempotencyKey` wins for that entry. The result lists every task's `taskId`
and `isolation`, with one `warning` when any task shares your checkout.

### Stopping several tasks at once (`task_cancel`)

`task_cancel` takes `taskId` for one task or `taskIds` for several; its
thread and worktree are kept either way. Each task's outcome
(`cancelRequested`, `status`) is reported separately, and one bad id is that
entry's `error` rather than a failed call, so it never stops the others. A
repeated id stops once, in order. When the parent itself is missing, the
call fails as the single form does instead of reporting one error per id.

### Settling a delegated task (`task_settle`)

`task_settle` marks a delegated task finished once its work is done and
reviewed: use it (not `task_cancel`) when the report is in and nothing is
left to run. It takes `taskId` (or `taskIds` for several, each reported
separately so one bad id never stops the others), plus two optional flags.
It goes through the same settle path as `threads settle`: the task and the
tasks it delegated settle, the parent and siblings are untouched, and a task
that is still running is refused unless `stop: true` ends its work first, as
with `threads settle --stop`. The task's thread and branch are always kept.

With `removeWorktree: true` the task's worktree checkout goes too, once it is
safe to lose: only a Moxen-managed checkout belonging to that task's own
thread (never a shared checkout, never the parent's own directory), with no
uncommitted or untracked changes (ignored files like build output don't
count), and only when its branch is merged into the default branch or it
never committed. Ancestry alone says "not merged" for squash-merged work, so
an equivalent patch upstream (`git cherry` `-`) and an empty merge
(`git merge-tree` giving the default branch's own tree) count as merged too;
anything inconclusive refuses, and the branch stays either way. An idle
provider session in that checkout is closed first, so nothing keeps running in
a deleted directory, and a removal the OS refuses (a locked directory on
Windows) is reported rather than thrown. Settling still happens when the
removal is refused: the result says `settled` with `worktreeRemoved: false`
and the reason, so a refusal never looks like a failed settle. Waking a task
whose worktree is gone (`task_send` with `wake: true`) fails plainly
(`TASK_WORKTREE_REMOVED`): re-delegate the follow-up as a new task.

Only the thread that owns a task settles it: the one that delegated it, or
the continuation that took it over — exactly like `task_cancel`. Continuing
hands every delegation row to the new thread, so from then on `task_settle`
resolves against the new parent and reads as `TASK_NOT_FOUND` on the old one.
A research run's lead and roles have no
delegation rows, so they are refused with the same `TASK_NOT_FOUND` another
thread's id gets.

### Queueing a message from an agent (`message_queue`)

An agent can queue or schedule a message on a thread without a shell:
`message_queue` takes `message`, and optionally `threadId`, `delivery`, `at` and
`conditions`. It goes through the composer's send path, so the durable queue
owns admission and the entry shows in Work queue, where the user can edit or
remove it. The result carries the `turnId`, the `threadId`, `status`,
`expectedRun` (in words), `scheduledFor` and `waitingFor`.

- `threadId` defaults to the calling thread. An agent may name only a task it
  delegated (the `task_send` rule, continuations included); anything else is
  `TASK_NOT_FOUND`, and a research run's roles and lead are refused
  (`QUEUE_MESSAGE_RESEARCH`). A delegated task, a research lead and a role are not
  offered the tool.
- `delivery` accepts only `queue`: it never steers or restarts a turn, so a thread
  queueing for itself mid-turn waits for that turn instead of joining it.
- `at` is read by the same code as `threads send --at`: an ISO date-time, or
  `HH:MM` on the machine's local clock (today, or tomorrow once that has passed).
  `conditions` are the queue's own (reset, usage, thread, entry, at, provider).
- With neither, the message queues behind the current turn and runs once when it
  ends. On an idle task it starts a turn at once (there is nothing to wait for);
  a settled task is refused as in `threads send`.
- The message is headed "Message you queued for this thread earlier with
  message_queue (not from the user)" (or the task header when sent to a task) and
  stored with `origin: "agent-message"`; the transcript labels it "queued by the
  agent", not as the user's. That origin is why it cannot end a usage hold: on a
  protected thread it is an automatic wake-up that waits behind the hold.

### Continuing your own thread from an agent (`thread_continue`)

An agent can continue its own thread in a new one, the way the user's
**Continue in a new thread** palette action does: `thread_continue` takes the
handoff `summary` the agent wrote and an optional `first` message saying what
the new thread should do first. The summary replaces the generated handoff
record; the first message is folded into the new thread's first turn. The
result carries the new thread's id and title, the tasks it adopted, and a note
telling the agent to end its turn. `provider`/`model`/`effort` run the new
thread on another model, resolved like a follow-up; tasks keep their own.
A `modelSelection` with `provider`/`model` together is refused.

- It takes no thread id: it always continues the calling thread, so a
  delegated child cannot continue its parent (or any other thread). A
  delegated task is not offered the tool and is refused when it calls
  anyway: its long work is compacted in place, and its report — not a
  forked continuation — decides what runs next.
- The same conditions as the palette action apply: a missing, deleted,
  archived or settled thread is refused with a clear error, as is a thread
  held by usage protection (its recovery runs first). A research run's
  roles and lead are refused (`THREAD_CONTINUE_RESEARCH`).
- An agent may continue its thread up to 3 times in a row
  (`MAX_CONSECUTIVE_AGENT_CONTINUATIONS`); a 4th is refused until the user
  speaks in the thread, which resets the count. A user's own palette
  continue never counts. A call retried with the same `idempotencyKey`
  returns the first continuation with a note, even when the new text
  differs: the first summary is kept.
- Mid-turn ordering: the new thread's first turn waits until the source
  thread has nothing running or queued (an entry condition on the calling
  turn plus a thread condition on the source, admitted by the work queue),
  because the two share a checkout. On an idle source it starts at once. A
  plain user send on the source after the destination has started is the
  user's own choice, as after the palette action, and is not refused. The
  calling agent must end its turn promptly instead of starting new work.
- Every task the source thread delegated moves to the new thread — running,
  idle, finished and cancelled alike (research roles stay with the run) —
  and from then on `task_send`, `task_ask`, `task_status` and completion
  notifications resolve against the new thread while the old one reads
  `TASK_NOT_FOUND`. The handoff lists the moved tasks.
- Once the calling turn settles, the old thread's provider session is
  closed, so a background task or late notification cannot wake it; task
  notifications already route to the new thread with it. Queued work left
  on the old thread stays there and runs there.
- While it waits, the new thread's entry shows in Work queue, blocked on
  the old thread, where the user can hold or remove it. There is no CLI
  surface for this: the palette and `threads continue` stay the user's.

Some providers wake a session on their own — a finished background task,
a monitor event. That output arrives as a turn like any other and is shown
in the side panel's Background tab, which can also list and stop running
background work. Background work lives in the session, so it outlasts a
turn only where the session does: in a shared server, or a client that
stays open. What `moxen threads background` lists comes from the same
driver view: Claude, Codex and the Harness report their background commands,
monitors and subagents; OpenCode reports the background shells and subagents
its own server started, and cannot see a shell background process started any
other way. A settled thread's background work cannot wake it: the wake-up
arrives as a turn, and a settled thread takes no turn.

A thread that has only finished a turn keeps those wake-ups: an orchestrator
relies on a watcher to wake it. A thread that was continued in a new one does
not. Continuing ends its provider session (`endContinuedSession` in
`core/threads/operations.ts`), which stops its background tasks and closes the
way they could start a turn there, so the old thread and the new one never act
on the same news. If a turn is still open on it, the session is left to finish
and only the tasks the provider can name are stopped. Sending the old thread a
message resumes it from its cursor, without its old background work. Delegated
tasks are separate and unchanged by this.

Usage protection also stops the background tasks a provider can name, both
when it holds a thread and while its wrap-up runs. This deliberately stops
long builds as well as cheap watchers: an unattended task must not keep the
wrap-up open or spend the protected allowance. Each task's disposition and
available output are kept in the thread and included in the recovery prompt.
If an independent stop is unsupported or fails, protection interrupts the
turn and detaches its provider session instead. A detached task's process
may still be running; recovery must check before restarting it. Once the
turn settles, protection closes the session so late task output cannot wake
the held thread. Background turns are refused while protection holds it.

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

**Reading the number.** The composer shows the thread's latest context
reading: tokens used, window size and the share of it. An agent sees the same
figure with the `context_usage` tool (on the `moxen` server, a delegated task
included), which returns those totals and when the reading was taken, never an
estimate. A thread with no reading yet is told so; a reading from before a
compaction comes back marked not current, with its time, rather than passed off
as the figure now. An agent told to hand off at a size can therefore measure
instead of guessing.

**Shared usage.** An agent sees every set-up provider's allowance with the
`usage_status` tool (on the `moxen` server, a delegated task included): each
window's percent used, reset time and label, when that reading was taken, and
whether it is stale. It tries a cheap fresh reading first and falls back to
the stored one with its age, and what usage protection holds or has queued.
A provider with no windows has no data, which is not the same as unlimited.

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
records it too, an estimate and not a bill; without one the field is absent.
A turn that recorded no cost keeps none on the ledger: Stats and usage
protection price it at the model's current prices instead (below), and only a
model with no price anywhere reads as unpriced.

### Stats

`usage.stats` (a server query, range `7d`, `30d` or `all`) turns the turn
ledgers into the numbers the stats screen shows; `usage.card` returns the
shareable PNG for a range. Both read every thread that is not deleted, a turn
counting on the day it started in the machine's local time, and a turn still
queued counting for nothing. Sessions are the threads with a turn in the
range, messages are the user's and the assistant's (not notes Moxen wrote),
and a streak is consecutive days with a turn. Cost adds what the providers
reported, and estimates the rest at the model's current prices: the
per-provider Model prices rows over Moxen's shipped price list, which also
drive usage protection's estimates (see below). A turn's recorded cost is
never rewritten: a past turn with a reported cost keeps it, and one without is
priced at today's values. Cost stays unset, never zero, where no turn was
priced; a reported or priced zero (a free model) is free. A model with no price
anywhere stays unpriced. A Claude turn's spend is the gain over the previous turn, as
above, so the instances stored as running totals are the Claude ones
(`core/usage/statsstore.ts`).

### Model prices

Each provider's settings page, under Model prices, values that provider's
models in USD per million tokens: an input, output, cache-read and
cache-write price per model, as `model=price` pairs
(`moxen config set providers.opencode.modelInputPrices 'opencode-go/muse-spark-1.3-contributor=2'`).
A row you set beats Moxen's shipped price for those fields on that provider,
so the same model can cost differently on two providers; clearing a row, or a
model from it, returns to the shipped price. A price with only some fields
values what it names and counts the rest as zero. Models match by the string
Stats buckets them under, slash included.
