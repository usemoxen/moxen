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
  `<storeRoot>/projects.json`. A thread can also start with **no project**
  (`--no-project` on the CLI, "No project" in the TUI's project picker): it
  runs in its own folder, `<storeRoot>/scratch/<thread id>/`, under one
  shared "No project" entry, and deleting the thread deletes the folder.
- Delegated work runs in a **worktree**: its own git checkout, so an agent
  works on its own copy of the code. Its branch is `moxen/<title>`.
  Archiving or deleting the thread removes the checkout (gitignored build
  output included, so they do not pile up) and keeps the branch; a checkout
  with uncommitted work is left alone. The running server also tidies up
  after threads archived for `branchPruneDays` (14 by default, 0 never):
  a `moxen/…` branch already merged into the project's branch is deleted,
  and its copy on `origin` too when it was pushed and is the same commit.
  A branch with unmerged commits is never deleted.

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

## Another machine

The shared server can also be driven from another machine — the Mac's TUI
against the Windows box's server, say — over the local network or a
Tailscale tailnet. Everything goes through the same `ClientApi` and wire;
only the transport and who may connect are new.

- **Off by default.** With `remote.enabled` off the server listens on this
  machine only (the pipe or socket above). On, it also listens on TCP over
  TLS (port 47317 unless `remote.port` says otherwise), on the addresses
  `remote.interfaces` picks: private LAN addresses, the Tailscale address,
  or both — never every address, and never a public one. Turning it off
  closes the listeners and drops every remote client at once. The palette
  (Turn remote access on) and `moxen remote enable` set it.
- **Pairing, not passwords.** The server shows a pairing code (palette ›
  Show pairing code, or `moxen remote code`): eight characters, single use,
  valid five minutes, dead after five wrong tries. The other machine enters
  it once (palette › Pair with a server, or `moxen remote pair <address>
  <code>`) and gets a device token; after that it connects with the token
  alone. The server lists its devices and can revoke one, which disconnects
  it at once.
- **The server's key is pinned.** The server's TLS key lives in its OS
  keychain and its certificate is rebuilt from it; when a machine pairs it
  remembers the key's fingerprint and refuses any other key from then on,
  before it sends its token. Both ends show the fingerprint at pairing, so
  it can be compared by eye. Nothing about remote access is a CA chain to
  trust.
- **Credentials stay in keychains.** Device tokens (on both ends) and the
  TLS key are kept only in the OS keychain. The files beside them —
  `~/.moxen/remote/devices.json` on the server, `servers.json` on a
  client — hold names, addresses and fingerprints, nothing secret.
- **A paired device may do everything a local client can**, settings and
  keys included, except stop the server: that is only done on its own
  machine.
- **Paths are the server's.** A remote client works on the server's
  projects and folders: the CLI never sends its own working folder (pass
  `--cwd` with a path on the server, or `--no-project`), a new project in
  the TUI takes a full path on the server, and the live diff overlay reads
  through the server.

Choosing the server: `--server <name>` on any command, `MOXEN_SERVER=<name>`
(any value that is not a mode names a paired server), or palette › Switch
server in the TUI, which reconnects without restarting. A paired server is
never started by a client and never silently swapped for a local one; the
TUI's sidebar title names it while connected.

Two things to know on Windows:

- **Firewall.** The first time the server listens, Windows asks whether to
  let Bun through; allow it for private networks, or nothing reaches the
  port. A client that cannot connect says to check this.
- **Keychain over SSH.** A server started from an SSH session cannot reach
  Windows Credential Manager (error 1312, "logon session does not exist"),
  so remote access cannot load its key there. Start the server from the
  desktop session — at login, or with a scheduled task that runs in it.

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
