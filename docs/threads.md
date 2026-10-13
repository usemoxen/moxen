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

## The activity ledger

The ledger records lifecycle bookkeeping plus one row per tool call,
append-only. Without the tool rows a turn that did real work would render
as a duration over a prompt echo, so rows are written while the turn runs.
A row is only appended when its signature changes, so streamed output does
not flood the ledger. Parked questions land as rows too: the answer panel
reads open questions off the ledger, so a question that never becomes a
row can never be answered.

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

## Revert

Revert rolls back every provider that saw a dropped turn, then cuts the
ledger. Files stay as they are unless asked back too (`--restore-files`),
in which case the worktree returns to the first dropped turn's snapshot
and the replaced state is pinned under a `revert-*` ref to undo by.

## Usage accounting

Drivers report per-turn usage deltas, recorded at settle and summed for
the usage panels. Providers that report nothing contribute zeros:
degradation, never invention.
