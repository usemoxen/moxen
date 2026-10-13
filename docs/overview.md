# Overview

Moxen is a terminal UI and CLI for coding-agent threads. It drives provider
CLIs directly — `claude`, `opencode` — instead of calling
provider APIs itself. Provider CLIs own their own logins; Moxen never sees
credentials, only whether a login exists.

## Concepts

- A **thread** is a task: one conversation with a provider, stored as
  append-only JSONL under `~/.moxen` (`MOXEN_STORE_ROOT` overrides it).
- A **turn** is one run of the provider within a thread: prompt in, settled
  outcome out. See [Threads and turns](threads.md).
- A **project** maps folders to stored defaults (default model and more) in
  `<storeRoot>/projects.json`.
- Delegated work runs in a **worktree**: its own git checkout, so an agent
  works on its own copy of the code.

## How it runs

Every client — the CLI, the TUI, the shared server — talks to the same core
through one typed boundary, `ClientApi` (`dispatch` for commands, `query`
for reads, plus two subscriptions). No client reaches the domain any other
way; a layering test pins that direction.

A live provider session belongs to the process whose drivers started it.
Only that process can stream its text, steer it, or answer a question it
is parked on. So there are three modes, chosen by `MOXEN_SERVER`:

- `direct` — each client owns its drivers. A turn dies with the client
  that started it; another client can read the ledger but not reach the
  session.
- `daemon` — one shared server (`moxen server start`) owns every session
  and serves `ClientApi` over a named pipe (unix socket elsewhere). Every
  client reaches every session, and turns outlive the client that started
  them. One writer per session is enforced here.
- `auto` (the default) — uses a running server when there is one, runs
  in-process otherwise.

The wire opens with a protocol-version handshake. A client newer than a
long-running server is refused rather than guessed at: restart the server
after upgrading.

Running two in-process clients against one thread means two writers on one
ledger. Prefer the shared server when clients overlap.

## Sessions

A restarted client resumes the provider-side conversation: the provider's
native session handle is stored on the thread and passed back at start. A
handle the provider no longer recognizes starts fresh instead of failing.

Beyond the prompt, a session starts with short runtime instructions sent
through the provider's own channel. They say only what Moxen knows: the
session runs in Moxen, in a worktree, as a delegated task, plus the user's
own instructions. Every top-level thread also gets the `moxen` MCP server
(`delegate`, `task_status`, `task_cancel`), so an agent can hand work to a
subagent thread in a worktree of its own. Delegated threads do not get it;
`"moxen": null` in `mcpServers` turns it off.

A session is held to its worktree: file edits, a shell in the main
checkout, and path redirects outside it are refused (each through the
provider's own mechanism — a hook, a permission denial, a sandbox).

## Usage

Subscription windows (Claude's session and weekly limits)
belong to the account, not the thread. The process owning the sessions
merges what drivers report into one record per provider, persisted next to
the thread store, so a fresh process shows the last reading before its
first turn.
