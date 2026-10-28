# Providers

Moxen drives two provider runtimes through their own CLIs, and runs a third
itself. Each CLI driver is a thin adapter over one runtime: no shared layers,
no host services, only our own root types plus type-level imports, so drivers
stay dependency-clean.

| # | Provider | Transport | Auth |
|---|---|---|---|
| 1 | Claude Code | Official `claude` CLI via the Agent SDK | Inherited CLI login (Pro/Max), API key, Bedrock |
| 2 | OpenCode | OpenCode v2 (2.0+): `opencode serve` plus the generated client | API keys; ChatGPT Pro/Plus and SuperGrok logins are built into v2 (`opencode auth login`) |
| 3 | Moxen Harness | Our own agent loop over an endpoint you configure (`providers.harness.profiles`): OpenAI Chat Completions, OpenAI Responses or Anthropic Messages | A key kept in the OS keychain, or read from the environment variable a profile names; never in the config file |

Credentials live with the provider CLIs (OpenCode keeps them in its own
SQLite, read only as provider type). This CLI never handles their tokens; the
only keys Moxen holds are a harness profile's and a search key, in the OS
keychain.

GPT (ChatGPT Pro/Plus) and Grok (SuperGrok) models run through
OpenCode; there are no native Codex or Grok drivers.

## Defaults

When nothing names a model — no flag, no config, no project or thread
selection — a thread runs on Claude, on its bundled catalog default, when
it is installed. OpenCode
routes to many providers, so picking one would be a guess; it is never
the implicit default. `MOXEN_DEFAULT_MODEL` (`<instance>/<model>`) pins
the default outright.

## Per-provider gaps

- Moxen has no plan mode. Claude Code's own plan tools (`EnterPlanMode`,
  `ExitPlanMode`) are never offered, and an OpenCode session an older build
  left on its read-only `plan` agent goes back to `build`.
- After a 5-hour limit Anthropic may keep serving a subscription on spare
  capacity (Claude Code's `/low-priority`). Moxen cannot drive that lane:
  the SDK never forwards the offer, only the slash command reaches us as
  an ordinary command.
- The `/` picker leaves out the Claude Code commands that need its own
  interactive app, an account, or the session Moxen owns (`/clear`,
  `/model`, `/effort`, `/rename`, `/config`, `/mcp`, `/goal`, …): they do
  nothing useful sent as a prompt. Its bundled skills (`/code-review`,
  `/simplify`, `/verify`, …) and a user's, project's, plugin's or MCP
  server's own commands are all offered. The list is a deny-list in
  `core/providers/claude/commands.ts`.

## OpenCode's system prompt

OpenCode picks a short base prompt for the model's family (its repository's `system-prompt/*.txt`). Moxen replaces it
for OpenCode's `build` and `plan` agents with its own, through the documented agent `system` setting
(`providers.opencode.moxenPrompt`, on by default): the working principles of the Moxen Harness's prompt (look
before you change, check your work, the rules for someone else's checkout, how to report), with the tools named the
way OpenCode names them, and without a line for a tool you switched off under `disabledNativeTools`. Your `AGENTS.md`
files, skills, MCP guidance, OpenCode's date and environment block and Moxen's runtime instructions are still added by
OpenCode and Moxen as before, and an agent you gave your own `system` keeps it. The prompt is part of the server's
config, so a change to it waits until nothing runs on that server, then restarts it.

Moxen does not use OpenCode's free models any way but through OpenCode itself: those are served to OpenCode's own client,
and Moxen does not imitate it.

Without a login, the pickers offer OpenCode's own provider's free tier only: models models.dev lists at no cost that
OpenCode's inference endpoint (`https://opencode.ai/inference/v1/models`) still serves, so retired free models are
not offered. The endpoint's list is cached beside the models.dev cache (`~/.moxen/cache/opencode-served-models.json`)
on the same five-minute freshness; offline, an older copy is used, and with none every free models.dev model is
offered and the provider's status says some may be retired. `OPENCODE_DISABLE_FREE_MODELS=1` (or `true`), which
makes OpenCode hide its free models, makes Moxen offer none. A per-model hand-off or compaction size saved for a
model that is no longer offered stays listed as "not offered", so it can be removed.

## Moxen Harness

For open models behind llama.cpp, vLLM, Ollama and similar.

A profile in the config file makes `harness/<id>` a provider:

```json
{
  "providers": {
    "harness": {
      "profiles": [
        {
          "id": "colab",
          "label": "Qwen on Colab",
          "baseUrl": "https://your-tunnel.example.com",
          "apiKeyEnv": "COLAB_API_KEY",
          "models": [{ "id": "qwen3.8-flash-next", "contextWindow": 262144, "vision": true }],
          "sampling": { "temperature": 1.0, "topP": 0.95, "topK": 20 },
          "slots": 1
        }
      ]
    }
  }
}
```

`apiKeyEnv` is the **name** of an environment variable; a value that looks like
a key is rejected. To save a key instead, set it on the Settings page or with
`moxen config set`: it goes to the OS keychain and wins over `apiKeyEnv`. The model id picks a quirk preset (`family` overrides it) and
`quirks` overrides single flags.

### Editing profiles

Profiles can be edited three ways, all of which end up in the same file and
all validated by the same code: the config file, the Settings page (Moxen
Harness, Profiles: add, edit, copy, remove, test, probe), and the CLI. Entries
are addressed by id, never by position.

Adding a profile on the Settings page is guided: pick a server type (Ollama,
LM Studio, llama.cpp, vLLM, a hosted OpenAI- or Anthropic-compatible one, or
other), confirm the address (it starts from the usual `localhost` port but is
often another machine), and for a hosted server name the environment variable
that holds its key. Moxen then asks the server for its models (`GET /v1/models`)
and offers them as a searchable multi-select, with the window the server
reports; if the server has no list, you type a model name. The new profile
opens with a connection test already run. MCP servers are added the same way,
from a short list of well-known ones or a custom command, and connect once so
their tools are listed. A harness profile's flow never asks for a key (only the
variable's name is stored; save the key on the profile afterwards). A
well-known MCP server that takes one (GitHub, Brave Search, Exa Search) asks
for it instead of a command: Moxen fills the command in, and the key goes to the
OS keychain.


```sh
moxen harness profile add colab --base-url https://tunnel.example.com \
  --model qwen3.8-flash-next --api-key-env COLAB_API_KEY
moxen harness profile edit colab --set 'models[qwen3.8-flash-next].contextWindow=262144' \
  --set sampling.topK=20 --set quirks.systemFirstOnly=false
moxen harness profile list | show <id> | duplicate <id> <new-id> | remove <id>
moxen harness profile export <id> [--out file]      # a JSON document to share
moxen harness profile import <file> [--id <id>] [--replace]
moxen harness profile test <id> [--model <id>]     # one tiny request
moxen harness probe <id> [--model <id>] [--dry-run] # the battery; saves what it settles
moxen config get 'providers.harness.profiles[colab].sampling.topK'
moxen config set 'providers.harness.profiles[colab].baseUrl' http://localhost:8080
```

An exported profile never holds a saved key or probe results (a probe describes one
server's chat template): the receiver sets their own key and probes for themselves.
Import checks the file as the config file is checked, and a taken id is an error
unless `--id` picks another or `--replace` overwrites it. The Settings page has the
same: `e` exports the open profile, and "Import from a file" on the list adds one
(a taken id gets a `-2`).

`config set` on `providers.harness.profiles[<id>]` takes a JSON object (creates or
replaces), on a field takes its text; an empty value removes the entry or
clears the field. Fields of the `models` list are addressed
`models[<model id>].<field>`. `--json` envelopes are `{ok, data}` like every
other command; `harness profile show` includes, per field, the value in force
and where it comes from. Profiles never hold a key or a header: such a field is
refused by name. Edits reach the next message of a running thread; no restart.

`harness probe` sends about a dozen tiny requests, one at a time, and writes
what the server's chat template accepts to the model's `probed` block, never
to `quirks`. The order of precedence is family preset, then `probed`, then
your `quirks`; a stated `vision` beats a probed `images`, and the server's
reported context size is used only while the model has no `contextWindow`.
A check the server could not answer (timeout, 429/503) writes nothing. It
refuses to start while a llama.cpp slot is busy. On a one-slot server the
requests still take the slot, which replaces the cached prompt of your last
conversation. `--dry-run` reports without saving.

A model's `efforts` (`low,medium,high`, comma-separated in the editor) puts an
Effort choice in the model picker; a chat server receives the pick only when its
family has an effort setting (Qwen does, or set `quirks.effortParam` /
`effortKwarg`), while the Responses and Anthropic formats always send it. The
repeat guards (`loopGuard.calls` for identical tool calls, `loopGuard.text` for a
reply or its reasoning looping) can each be turned off per profile.

Approvals follow the runtime mode: reading is always allowed; edits ask in
`approval-required`; commands ask in `approval-required` and `auto-accept-edits`
(`auto` and `full-access` run them). "Allow for this session" is remembered per
tool and path scope or command pattern for the life of the process (`git status`
does not cover `git push`; compound commands cover only themselves). A delegated
task has nobody to ask, so a call that needs approval is refused with a reason
and the model gets no `ask` tool. The model also has `todo` (the tasks panel),
`ask` (the answer panel) and `enter_plan_mode` / `exit_plan_mode`; text sent
during a turn reaches the model at its next step. The context meter is the
server's last count, estimated (and flagged) when there is none yet.

Compaction needs the model's `contextWindow` in its profile to run on its own.
It clears old tool output, then summarises on the same conversation, and trims
if the summary cannot be had. `/compact`
and `/compact <focus>` run it by hand. Settings: the Long threads group on
the Moxen Harness tab (`providers.harness.compaction`, `compactAt`, falling back
to `longThreads.compactAt`, and `keepRecentTokens`; see [threads](threads.md)) for every profile,
and a profile's own `compaction` fields (`auto`, `fraction`, `tokens`,
`keepRecentTokens`, `effort`) over them; the profile editor shows which value is in
force and where it comes from. Turns before a compaction can be read
but not rolled back.

MCP servers (`mcpServers`, global or per project, plus moxen's own tools) are
connected when the session starts, over stdio or HTTP, and their tools appear as
`mcp__<server>__<tool>` after the built-in ones. A tool the server marks
read-only runs without asking; any other asks like a shell
command does ("don't ask again" covers that one tool) and is refused in a
delegated task. Results are cut to a head and tail (the whole is saved to a file
the model is told about) and arrive inside `<untrusted_context>`. A stdio server
gets a small environment (`PATH`, `HOME` and the like) plus its own `env`, not
moxen's; add what it needs (a proxy, a CA file) to its `env`. A server that fails
to start is reported at the next turn and the rest carry on; one that dies
mid-session is started again by the next call, at most three times. The tool set
is fixed for the session (it keeps the server's prompt cache): changing
`mcpServers` says so once and applies to a new thread. Skills (`SKILL.md`
folders in the project's `.claude/skills` and `.agents/skills`, the home
directory's, and moxen's bundled ones when they are served) are listed in a
`skill` tool and loaded on request. A worktree-isolated session is held to its
worktree for edits, commands and MCP arguments alike, following symlinks.

`read` returns png, jpg, gif and webp files as pictures to a model with vision.
`bash` can start a command in the background (`run_in_background`); `task_output`
reads it and `task_stop` ends it, and it appears in the tasks panel. It ends with
the session, not with an interrupted turn. `subagent` runs a separate agent with
an empty context on the same model and returns its report: `explore` reads and
searches, `general` can also change files and run commands under the thread's
permissions (approvals reach you as usual). `/btw` and the thread title work too:
the title is made by the model after its first answer and again on request.

A profile's API format (`apiFormat`: `chat`, `responses`, `anthropic`; `moxen harness
profile add --api-format …`) says which API the server speaks. `anthropic` and
`responses` are for the vendors' own APIs (a key from the variable the profile
names, `--base-url https://api.anthropic.com`); the reasoning those APIs sign or
encrypt goes back with the conversation, and Claude models are treated as seeing
images (on `responses`, set `vision` on the model). The probe is for chat servers
only; `profile test` works for all three.

`web_fetch` reads a page (or a server on this machine) as text and `web_search`
searches. A plain request is tried first, with browser-like headers; a page that
turns it away, or is built by scripts, is loaded in an installed Chrome or
Chromium (headless, throwaway profile) when `web.browser` allows.
Searching uses DuckDuckGo by default (no account); `webSearch` can be `exa`,
`brave` (each with a key of its own, saved in the keychain as
`webSearchKeys.<service>` or named by `webSearchKeyEnvs.<service>`; both are
metered, so check your plan's terms) or `searxng` (your instance, `searxngUrl`).
This machine is always reachable without asking; any other host asks like a
command does, once per host for the session; the local network needs
`web.privateNetwork` and cloud metadata addresses are never reached. Results are
marked as untrusted data.

The `web` settings (Agent context tab, Web tools) are shared: the `web_fetch` Moxen
offers Claude Code and OpenCode follows them too, so Never starts no browser on
any provider. A file from before they were shared still means what it did:
`providers.harness.webBrowser` and `webBrowserPath` apply to every provider
while `web.*` is unset, and `providers.harness.webPrivateNetwork` still opens
the Harness's tools only. The older single `webSearchKey` / `webSearchKeyEnv`
slot is read for the selected service until any service has a key of its own;
switching services on the page first files it under the service it was used
for (the same keychain entry, not a copy).

Gaps: the two API formats and the web tools have only been exercised against
fakes and local fixture sites (no live API, search service or real site), a
finished background command does not wake an idle session (the model hears of it
at its next step), a subagent has no MCP tools and cannot run in the background,
there is no PDF reading, MCP gives tools only (no resources, prompts, sampling or OAuth
sign-in; a bearer token in `headers` works), a rule file edited while the thread
was closed is not noticed on resume (an edit while it is open reaches the model as a
patch ahead of its next message), and a resumed session starts with no session
approvals and an empty checklist.
