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

A live provider session belongs to the process whose drivers started it,
and only that process can stream its text, steer it, or answer a question
it is parked on. So exactly one process runs moxen: the server. It owns
the store, the config, the keychain entries Moxen keeps and every
provider session, and serves `ClientApi` over a named pipe (unix socket
elsewhere). Every client reaches every session, and turns outlive the
client that started them.

Clients never change anything themselves. The TUI and every CLI command
connect to this machine's server, starting it in the background when none
is running (`moxen server start` runs it in the foreground instead), or
to a paired server on another machine (below). They never fall back to
running moxen in-process — that is for the server and for tests only — and
`MOXEN_SERVER=direct`, which used to ask for it, is refused. Reads of the
server's files go through it too: the live diff overlay's git and file
reads, and the images of sent messages. A layering test fails if client
code imports what writes the config or the keychain, or runs moxen
in-process. What a client keeps of its own is only what belongs to that
machine: its list of paired servers and their tokens, the clipboard, its
copy of the last thing copied, and files it was asked to write there
(an export).

The server runs on one config file: `~/.moxen/config.json`, or
`MOXEN_CONFIG`, which `--config` sets for one command. A client that asked
for a file has it passed to a server it starts, and refuses a running
server on another file (`SERVER_CONFIG_MISMATCH`, also for a server too old
to say) rather than reading or writing a config nobody asked for. The old
config location is brought over by the server when it starts.

The wire opens with a protocol-version handshake. A client newer than a
long-running server is refused rather than guessed at: restart the server
after upgrading.

A server can be lost without its socket closing — frozen, its machine
asleep, the network gone — so the client keeps a heartbeat: it pings
when the server has been quiet, and after 15 seconds of silence (or a
connect or handshake that takes over 10) it drops the connection, fails
what was in flight, and keeps reconnecting until a server answers. The
TUI says so over the composer while it is cut off; it never restarts a
server itself. The server, in turn, drops a client that pinged and then
went silent for 30 seconds, releasing its subscriptions.

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
through the provider's own channel. They say only what Moxen knows — the
session runs in Moxen, in a worktree, as a delegated task, how its shell and
tools behave on this machine, how to use Moxen memory and the web tools it
has — under one heading per subject, and end with the user's own
instructions. Every top-level thread also gets the `moxen` MCP server
(`delegate`, `task_status`, `task_cancel`), so an agent can hand work to a
subagent thread in a worktree of its own, find and read other threads
(`thread_search`, `thread_read`), and keep Moxen memory (`memory_*`, see
[threads.md](threads.md#memory)). Delegated threads get only `web_fetch` and
`memory_read`; `"moxen": null` in `mcpServers` turns it off.

`thread_read` never floods the caller's context: it returns an outline (one
line per turn, newest first), then the turns asked for (each tool call one
line, numbered `12.3`), then one tool call in full, in pages. An answer is
held to 16 K characters, at most 40 K, and to about 5% of the caller's free
context, so a caller that is nearly full gets only the outline and is told
why. Every cut names the call that fetches the rest, and the thread's text
is wrapped as untrusted. Both tools search this project's threads unless the
model asks for `scope: "all"`.

A session is held to its worktree: file edits, a shell in the main
checkout, and path redirects outside it are refused (each through the
provider's own mechanism — a hook, a permission denial, a sandbox).

## Usage

Subscription windows (Claude's session and weekly limits)
belong to the account, not the thread. The process owning the sessions
merges what drivers report into one record per provider, persisted next to
the thread store, so a fresh process shows the last reading before its
first turn.

### Stats

`▤ stats` in the Threads sidebar's footer, between Settings and Panels, opens
what every thread on every provider has spent, over all time, the last 30 days
or the last 7 (click a range, or `r`). The **Overview** tab has the counts
(sessions, messages, tokens, active days, peak hour, favorite model, best
streak, cost, turns) and a heatmap of the last year. Narrowing the range keeps
every active day on the heatmap: days before it turn grey, days in it stay
lit. The **Models** tab charts tokens per day by model (the biggest seven in
their own colour, the rest in one grey row; a long history shares a column
across days) and lists each model and provider with its tokens, cost and share.

Tokens are those the providers report, so a provider that reports none adds
activity but no tokens. **Cost** is what the provider says the turn cost: an
estimate, not a bill, and never a price Moxen made up. `unpriced` means no turn
reported one, and a trailing `+` means some did not. Deleted threads are not
counted.

`s` (or `s copy card`) copies a **stats card** for the range on screen to the
clipboard as an image, ready to paste: a PNG in the current theme's colours
with the token total, the heatmap, best streak, active days and sessions. Where the machine has no image
clipboard (a bare SSH session, no `xclip` or `wl-copy`) it saves the card as
`moxen-stats-<date>.png` in the folder Moxen was started in (numbered if the
name is taken) and copies that path, and says so. A client makes its own card
copy, so one from a paired server lands on the machine you are using.
