# CLI reference

The same binary scripts everything the TUI does, with stable `--json`
envelopes (`{ "ok": true, "data": ... }`) for automation. Every command
supports human-readable output. `--json` produces `{ "ok": true, "data": ... }`
on success and a stable error envelope on failure.

## Handover

Hands the current folder or Git repository to a new thread. It resolves the workspace against the local project registry, optionally creates the missing project, creates a fresh thread, and starts its first prompt against the selected provider driver:

```bash
moxen handover --prompt "Continue the implementation from this handover."
moxen handover --prompt-file handover.txt --open none
printf '%s' "$PROMPT" | moxen handover --stdin
```

| Flag | Values |
| --- | --- |
| `--prompt`, `--prompt-file`, `--stdin` | Exactly one is required |
| `--open` | `auto`, `desktop`, `browser`, `none` |
| `--provider` | A provider instance id from `providers list` (`claudeAgent`, `opencode/<provider>`) |
| `--model` | A model slug supported by that provider instance |
| `--speed`, `--speed-mode` | `standard`, `fast` |
| `--thinking-effort` | A model-supported value such as `low`, `medium`, `high`, `xhigh` or `max` |
| `--permission`, `--runtime-mode` | `approval-required`, `auto-accept-edits`, `auto`, `full-access` |
| `--mode`, `--interaction-mode` | `build`/`default`, `research` or `orchestrate` (see [Modes](threads.md#modes-build-research-and-orchestrate)). Plan mode was removed: `plan` is refused (`PLAN_MODE_REMOVED`, exit 2), and a thread or config saved with it reads as Build |
| `--checkout`, `--env-mode` | `current`/`local`, `worktree`, or the resolved default via `auto` |

Command flags override the CLI config, which overrides the project's saved model selection. Without either override, the saved selection and its options are passed through unchanged. A newly-created project has no default; the fallback is the explicit installation default (`codex` / `gpt-5.4`).

Speed and thinking effort are stored as model options. The provider driver applies the option ids supported by the selected provider/model. If `--provider` changes the project's default provider instance, also pass `--model` because provider instance ids can be user-defined and do not imply a model.

## Existing threads

List threads across projects, or restrict discovery by project id or workspace:

```bash
moxen threads list
moxen threads list --status active --cwd .
moxen threads list --status settled --project <project-id>
moxen threads search webhook retry   # titles, messages, tool calls; settled too, active first
```

`--status` accepts `active`, `settled`, `snoozed`, or `all` (the default). A thread reads as `snoozed` while it is unsettled and its `snoozedUntil` lies in the future. Results include the exact thread id, project, title, model, and update time. Inspect the exact target before sending:

```bash
moxen threads inspect --thread <thread-id>
```

`inspect` returns a bounded preview in JSON: the 6 most recent messages, with message text limited to 2,000 characters, plus `snoozedUntil` when the thread is snoozed. Read a thread projection without truncation:

```bash
moxen threads read --thread <thread-id>
moxen --json threads read --thread <thread-id>
moxen --json threads read --thread <thread-id> --last-turn
moxen --json threads read --thread <thread-id> --view turn-items
moxen --json threads read --thread <thread-id> --view plans
moxen --json threads read --thread <thread-id> --view checkpoints
moxen --json threads read --thread <thread-id> --view transfers
```

`--view` defaults to `messages`: the JSON result stores the transcript in `data.thread.messages`. Messages remain in chronological order and retain their `turnId`. `--last-turn` keeps only messages assigned to `data.thread.latestTurn.turnId`. Neither mode truncates message text. The other views expose the thread's activity ledger (`turn-items`), proposed plans (`plans`, currently always empty — no plan capture is wired yet), and checkpoint summaries (`checkpoints`, backed by git worktree snapshots around each turn); `transfers` is always empty because no transport exposes context-transfer rows.

## Follow-up messages

Send to an existing thread instead of starting a new one. Use the **thread ID** from a previous command's JSON `data.thread.id`. `--thread` and `--thread-id` are aliases:

```bash
moxen threads send --thread <thread-id> --prompt "Run the morning check."
moxen threads send --thread-id <thread-id> --stdin --open none < follow-up.txt
moxen threads send --thread-id <thread-id> --prompt-file follow-up.txt --dry-run
```

Exactly one of `--prompt`, `--prompt-file`, or `--stdin` is required. The message is recorded as a turn on that thread and the provider run continues in the background; success reports acceptance, not agent completion. A failed send never deletes the thread. Archived threads are rejected (there is no unarchive path).

Choose how to handle active work (default `reject`):

```bash
moxen threads send --thread-id <thread-id> --if-busy inject \
  --prompt "Additional context for the work in progress…" --open none
```

- `--if-busy reject` (default) returns `THREAD_BUSY` without recording when the thread has an active or pending turn.
- `--if-busy inject` records immediately even when busy, letting the provider incorporate the prompt into active work. It does not introduce a CLI queue or send an interrupt command.

The busy check holds the per-thread mutex instead of a snapshot preflight: one active turn per thread is enforced, not raced. Success reports acceptance rather than agent completion.

Sending to a settled thread requires confirmation. Non-interactive and JSON callers must explicitly opt in with `--wake-settled`:

```bash
printf '%s' "New findings that require more work..." \
  | moxen --json threads send --thread <thread-id> --stdin --wake-settled
```

The turn keeps the thread's model, permission, and mode unless overridden. `--provider`, `--model`, `--speed`, and `--thinking-effort` override the model for that turn only (global `provider`/`model` config is ignored so a stale default cannot flip a scheduled thread's model). There is no `--permission`/`--mode` flag: change the permission in the TUI permission picker and the mode with Shift+Tab or `/research` / `/orchestrate` in the composer, since scheduled runs inherit them.

`--delivery` selects follow-up policy (default `auto`; every follow-up is recorded as a `thread.turn.start` turn, so the mode governs preconditions and reporting): `queue` records even when busy and reports `queued`, `steer` requires an active turn and reports `steered`, and `restart` interrupts the active turn first and reports `restarted` (`THREAD_NOT_STEERABLE` when idle). `--handoff-note <text>` records provider-switch context as CLI-side metadata without changing the recorded turn.

Use `--prompt-file` (or `--stdin`) for skill invocations and longer prompts, `--open none` for headless runs, and `--dry-run --json` to inspect the turn command without dispatching it.

Manage settlement explicitly without starting a new turn:

```bash
moxen threads settle --thread <thread-id>
moxen threads unsettle --thread <thread-id>
```

`settle` refuses a thread with a running session or a pending approval or user-input request. `unsettle` marks the thread manually active but does not send a message or start its provider session. Both apply synchronously to the ledger.

Snooze an active thread until an ISO-8601 datetime, interrupt an active turn, or delegate a sub-agent task to a child thread in the same project:

```bash
moxen threads snooze --thread <thread-id> --until 2030-01-01T00:00:00.000Z
moxen threads unsnooze --thread <thread-id>
moxen threads interrupt --thread <thread-id> [--run <turn-id>]
moxen threads delegate --thread <parent-id> --prompt "Self-contained task" --open none
moxen threads task-status --thread <parent-id> --task <child-thread-id>
moxen threads task-cancel --thread <parent-id> --task <child-thread-id>
```

`delegate` sends only the task prompt as the child's first turn and waits for its latest turn to reach `completed`, `interrupted`, or `error` (default budget 600000ms via `--timeout-ms`; `--no-wait` returns after acceptance). A wait timeout exits 0 with `data.task.waitTimedOut: true` and never cancels the child — re-poll with `task-status`. `task-cancel` interrupts the live provider run through the store and marks the turn interrupted.

Thread targeting uses exit code `3` for a missing target and `4` for a lifecycle/confirmation refusal.

To run a message on a schedule (for example daily at 05:01), pair it with the OS scheduler. The provider CLIs must be installed and authenticated, and the machine awake. The scheduler doesn't load your shell profile, so point it at `bun` and the script path directly rather than at the `moxen` function/alias. PowerShell example:

```powershell
$action = New-ScheduledTaskAction -Execute "bun.exe" `
  -Argument '"C:\absolute\path\to\moxen\src\cli\index.ts" --json threads send --thread <thread-id> --prompt-file "<path-to-prompt.txt>" --open none'
$trigger = New-ScheduledTaskTrigger -Daily -At 05:01
Register-ScheduledTask -TaskName "Moxen 5am thread ping" -Action $action -Trigger $trigger
```

macOS/Linux equivalent (cron):

```bash
1 5 * * * bun /absolute/path/to/moxen/src/cli/index.ts --json threads send --thread <thread-id> --prompt-file "<path-to-prompt.txt>" --open none
```

## Settings

Settings are the server's: `config show|get|list|path|set` ask this machine's moxen server (or `--server`'s), which reads and writes its config file and keychain and applies a change straight away. `--config <file>` names the file the server runs on: a server the command starts uses it, and a running server on another file is refused rather than used.

```bash
moxen config show
moxen config set projectPolicy existing
moxen config set workspaceMode folder
moxen config set threadEnvMode local
moxen config set provider opencode/openai
moxen config set model gpt-5.4
moxen config set thinkingEffort xhigh
```

| Setting | Values | Default |
| --- | --- | --- |
| `projectPolicy` | `create`, `existing` | `create` |
| `workspaceMode` | `repo`, `folder` | `repo` |
| `openMode` | Older key, kept so configs and scripts load; nothing is opened | `auto` |
| `threadEnvMode` | `local`, `worktree` (an older `auto` reads as `local`) | `local` |
| `runtimeMode` | `approval-required`, `auto-accept-edits`, `auto`, `full-access` | `full-access` |
| `interactionMode` | `default` (Build), `research` or `orchestrate`. An older config's `plan` reads as `default`: plan mode was removed | `default` |
| `provider` | Provider instance id for model overrides | Unset (inherits thread/project) |
| `model` | Model slug for overrides | Unset (inherits thread/project) |
| `speedMode` | Older key, kept so configs load; no provider reads it | Unset |
| `thinkingEffort` | Model-supported effort value | Unset (inherits thread/project) |
| `memory` | `true`, `false`: Moxen memory (see [Memory](threads.md#memory)). A project's `moxen.json` can say `"memory": false` | `true` |

**Older keys.** Settings reshaped since an older build (for example `ui.autoHandoff`, `providers.claude.autoCompact`, `providers.opencode.compactBuffer`, `installSkills`, `providers.harness.webSearchKey`, `providers.harness.webBrowser`) still load, and `config get` / `config set` still accept them; `config list` lists them too. A newer key wins once it is set; while it is unset, the older key is what applies, and the settings page names it as the Default. Loading a file never rewrites it in the new shape: the file is only written when a setting is changed, and then the older keys stay in it, so an older Moxen build sharing `~/.moxen/config.json` keeps working. The one exception is a value an older build reads the same way, such as `threadEnvMode: "auto"`, saved as `local`.

The settings page files every key under General, Defaults, Sessions, Long threads, Agent context, Interface, Git and forges, one tab per provider (each in the same order: Defaults, Tools, Long threads, Sessions, Setup, then what is particular to it), and MCP servers. Where a setting lives on the page never changes its key.

`projectPolicy: "existing"` makes a missing project a hard error. `workspaceMode: "folder"` uses the exact current folder instead of walking up to the Git root. Whether a thread from `moxen handover` or `moxen threads create` gets a worktree is decided by the command (`--checkout`), then the project, then its `moxen.json`, then `threadEnvMode`. Explicit CLI config values remain overrides.

`--checkout worktree` provisions a local worktree for the new thread: a `moxen/<id>` branch (named from the thread title: `moxen/<title-slug>`; the thread id only when there is no title) off the current branch (or its origin — new worktrees always start from origin), placed under the store's `worktrees` directory, with the thread rooted there. A repository without a current branch returns `WORKTREE_REQUIRES_BRANCH` instead of silently falling back to the current checkout.

### MCP servers

MCP servers declared under `mcpServers` are added to every provider session, alongside whatever
the provider's own config already loads. The shape is the one `.mcp.json` uses; edit the config
file directly (`moxen config path`):

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "some-mcp"], "env": { "ROOT": "/work" } },
    "docs": { "type": "http", "url": "https://docs.example/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

A project's `moxen.json` can declare `mcpServers` too: an entry replaces the global one of the
same name, and `null` removes it for that project. Servers are read when a session starts, so an
edit applies to the next session. Names may use letters, digits, `-` and `_`. `config show` redacts `env` and `headers`
values.

`env` and `headers` values are secrets: set through `moxen config set` or the settings page, each goes to the
OS keychain and the file keeps a `keychain:<name>` reference, which is read when a session starts (a value
written into the file by hand is used as it is). Adding a well-known server in the settings page (Brave Search,
Exa Search, GitHub…) asks for its key and fills in the command; `mcpRunner` (`npx` by default, or `bunx`,
`pnpm`, `yarn`) is what starts the npm ones. Exa uses its hosted server, so it installs nothing and takes the
key as the `x-api-key` header.

Which provider gets which server is set on the provider's own page (Settings → Claude Code,
OpenCode or Moxen Harness → MCP servers), or with `providers.<claude|opencode|harness>.mcpExclude`:
the names of servers that provider does not get, comma-separated. Every server is on by default, so a
server added later reaches every provider until switched off. A server switched off on its own entry
(`disabled`) or limited by an older `providers` list on it stays out either way.

### Web tools

Claude Code and OpenCode ship their own search and fetch, and you may have attached Brave or Exa. Per
provider (`providers.<claude|opencode>.…`):

- `webSearchOrder` and `webFetchOrder`: the order the model should try them in, comma-separated ids (search:
  `brave`, `exa`, `native`; fetch: `moxen`, `exa`, `native`; `native` is the provider's own). The prompt says
  "prefer in this order … go on to the next only if one fails or finds nothing useful", over the tools the session
  really has. It is advice: it turns nothing off, and the model may still choose another. Unset: no preference.
  The settings page greys each one out until there is something to rank: a Brave Search or Exa server from
  Moxen's own list (switched on for that provider) for search, Moxen's tools or Exa for fetch. Only those are
  covered, since they are the tools whose options Moxen knows; any other search server is left to the model.
- `disabledNativeTools`: the provider's own tools to switch off, comma-separated (`WebSearch,WebFetch` for Claude
  Code; `websearch,webfetch` for OpenCode). Claude Code drops them from the model's list when the session starts.
  OpenCode reads them when its server starts and takes them out of the model's list. A change waits until nothing runs on that server (no turn, background
  command or subagent, nothing waiting on you), then restarts it; the next message meets the new one.

Either way, a session is told how to use each web tool it really has (for example `mode: "extended"` for
Claude's WebSearch on anything recent, `freshness` for Brave, that Exa's fetch can answer from a cache). Nothing
is said about a tool that is switched off or not attached.

`web_fetch` is Moxen's own page reader (the one the Moxen Harness uses, minus its web search): plain request
first, a browser when the site turns it away or builds the page with scripts. It follows the shared Web tools
settings (`web.browser`, `web.privateNetwork`) on every provider, and never reaches cloud metadata. It is on the
`moxen` MCP server with the delegation tools, but each is switched on its own per provider:
`providers.<kind>.orchestration` (delegate, task status, models, cancel, thread search and read) and `providers.<kind>.webFetch`. The
older `moxenTools: false` still turns both off while they are unset. A delegated task keeps `web_fetch` (and the
checklist) but gets none of the tools that delegate. A configured server named `moxen` replaces Moxen's tools,
and the MCP tab says so.

Which provider gets a server is decided in two places only: the server's own switch, and the MCP servers
checklist on each provider's tab. The MCP tab shows the answer per provider for each server. A server's older
`providers` list ("offered to") is read once, as that checklist (a provider it left out has the server switched
off there), and decides nothing on its own; a project's `moxen.json` may still carry one.

Moxen's own skills (`skills/`) reach a thread one way, set by `skills.moxen`: `copy` (the default) puts them in a
project's `.claude/skills` or `.agents/skills` when it has one of those folders and serves them otherwise; `serve`
points each provider at Moxen's folder and takes earlier copies back out; `off` gives them to no thread. A
project's `moxen.json` can choose (`{ "skills": { "moxen": "serve" } }`), and `providers.<kind>.moxenSkills`
switches them off for one provider, or on (served) while the global is off. A delegated task gets none, and a
provider without delegation tools does not get `moxen-orchestrate` or `moxen-research`; copies a session must not
have are hidden with the provider's own rules. Each provider's tab says what is in force. The older
`installSkills: false` reads as `serve`, and with it `providers.claude.agentSkills: false` or
`providers.opencode.bundledSkills: false` as off for that provider. `agentSkills` now means only the user's own
`.agents/skills` on Claude Code.

## Remote access

Drive a moxen server on another machine (see [Another machine](overview.md#another-machine)).

On the machine whose server is shared:

```text
moxen remote enable [--interfaces lan|tailscale|both] [--port 47317]
moxen remote status            # where it listens, and the key fingerprint
moxen remote code              # a pairing code, the address(es) and the fingerprint
moxen remote devices           # paired devices; id, name, last seen, open connections
moxen remote revoke <device-id>
moxen remote disable
```

On the machine that drives it:

```text
moxen remote pair <host[:port]> <code> [--name winbox]
moxen remote servers
moxen remote forget <name>
moxen --server winbox threads list
MOXEN_SERVER=winbox moxen tui
```

Every `moxen remote` command takes `--json`. The server-side ones go
through the server, so with `--server <name>` they manage that one. Against
a remote server, commands that resolve a project from a folder need
`--cwd` with a path on the server (or `--no-project`): `REMOTE_CWD_REQUIRED`
otherwise. `moxen --json doctor` reports `checks.server.mode: "remote"` with
the server's name and key fingerprint. `server status` and `server stop`
manage this machine's server only and refuse `--server`.

Errors worth knowing: `REMOTE_PAIRING_REFUSED` (wrong, used or expired
code — show a new one), `REMOTE_DEVICE_REFUSED` (revoked, or the token is
gone — pair again), `REMOTE_KEY_MISMATCH` (the server presented a different
key than the one paired: reinstalled, or not the server you think — pair
again only if you know why), `SERVER_UNAVAILABLE` (not running, remote
access off, or a firewall in the way).

## Commands

```text
moxen tui
moxen remote pair <address> <code>
moxen --server <name> <command>
moxen --json doctor
moxen config path|show|set
moxen projects list
moxen projects resolve --cwd .
moxen projects ensure --cwd . --project-policy create
moxen providers list
moxen models list --provider claudeAgent
moxen models hide --provider opencode --model opencode/muse-spark-1.3-contributor-free
moxen models show --provider opencode --model opencode/muse-spark-1.3-contributor-free
moxen efforts list --provider claudeAgent --model claude-sonnet-5
moxen memory list --cwd .
moxen memory import-claude --cwd .
moxen threads create --stdin
moxen threads list --status active --cwd .
moxen threads inspect --thread <thread-id>
moxen threads read --thread <thread-id>
moxen threads send --thread <thread-id> --stdin
moxen threads settle --thread <thread-id>
moxen threads unsettle --thread <thread-id>
moxen threads snooze --thread <thread-id> --until <ISO-datetime>
moxen threads unsnooze --thread <thread-id>
moxen threads interrupt --thread <thread-id>
moxen threads delegate --thread <parent-id> --stdin
moxen threads task-status --thread <parent-id> --task <child-thread-id>
moxen threads task-cancel --thread <parent-id> --task <child-thread-id>
moxen handover --stdin
```

## Providers, models, and efforts

`providers list`, `models list`, and `efforts list` probe live sources on every call with no server in the loop: `claudeAgent` from its bundled catalog, and one `opencode` instance carrying the whole models.dev catalog (slugs are `provider/model`, matching migrated threads) plus local API-key presence and stored OAuth state. Use them to pick valid `--provider`, `--model`, and `--thinking-effort` values before a handover instead of guessing — unknown ids fail with `PROVIDER_NOT_FOUND` / `MODEL_NOT_FOUND` and list what exists. Choices marked `*` in human output are the model's defaults.

`models hide` / `models show` curate the pickers: hidden models stay usable when named explicitly and stay visible on threads already running them — they only leave the model picker lists.

`models list` never reports `hidden` on this backend — there is no picker-preference store yet, so everything reads visible.

`providers list` reports each instance's `usageLimits` as `null`: subscription-quota windows are session-live in every native driver and there is no session to probe at listing time. Per-turn token totals are recorded in the turn ledger as runs settle and feed the TUI usage display.

## Opening threads

`--open` is accepted everywhere for script compatibility, but there is no desktop app to deep-link into: `opened.kind` is always `none`. The TUI (`moxen tui`) is the interactive interface; use `--open none` for headless runs.
