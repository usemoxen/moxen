# Providers

Moxen drives provider runtimes through their own CLIs (Claude Code, OpenCode,
Codex, Antigravity, and configured ACP agents), and runs Moxen Harness itself.
Each driver is a thin adapter over one runtime implementing the shared
`ProviderAdapter` contract (`core/providers/spi.ts` — the contract itself
imports only our own root types plus type-level `effect` modules, without the
upstream reference's Layers or host services). A driver otherwise imports
shared core modules freely, runtime imports included (`effect`, `threads/store.js`,
`skills/discovery.js`, even the Harness's tool implementations for Codex) —
but never reaches upward into the server or a client
(`src/tests/layering.test.ts` pins this).

| # | Provider | Transport | Auth |
|---|---|---|---|
| 1 | Claude Code | Official `claude` CLI via the Agent SDK | Inherited CLI login (Pro/Max), API key, Bedrock |
| 2 | OpenCode | OpenCode v2 (2.0+): `opencode serve` plus the generated client | API keys; ChatGPT Pro/Plus and SuperGrok logins are built into v2 (`opencode auth login`) |
| 3 | Codex | `codex app-server` over stdio JSON-RPC (tested on 0.166.0) | Inherited `codex login`; the CLI owns authentication |
| 4 | Moxen Harness | Our own agent loop over an endpoint you configure (`providers.harness.profiles`): OpenAI Chat Completions, OpenAI Responses or Anthropic Messages | A key kept in the OS keychain, or read from the environment variable a profile names; never in the config file |
| 5 | Antigravity | Official `agy` CLI unmodified (`agy acp`) over pinned ACP v1 (`protocolVersion: 1`) | Inherited `agy` login; Moxen never reads or stores credentials |
| 6 | Mistral Vibe | Official `vibe-app-server` over stdio JSON-RPC 2.0 (tested on 3.1.4) | Inherited `vibe` login (OS keyring or `~/.vibe/.env`); Moxen never reads or stores credentials |
| 7 | ACP | Agent Client Protocol v1 (`protocolVersion: 1`) over stdio JSON-RPC for profiles you configure (`providers.acp.agents`, from the ACP Registry or manually) | Inherited by each ACP CLI; Moxen never reads or stores credentials |

Credentials live with the provider CLIs (OpenCode keeps them in its own
SQLite, read only as provider type). This CLI never handles their tokens; the
only keys Moxen holds are a harness profile's and a search key, in the OS
keychain.

GPT models can run through native Codex, OpenCode, or Sign in with ChatGPT
via Moxen Harness. When a ChatGPT attachment or tool image exceeds OpenAI's
30,000-patch limit at full resolution, Moxen asks OpenAI to resize it using
high detail. The original image stays unchanged, and smaller images keep the
model's default detail.

Grok (SuperGrok) models run through OpenCode; there is no native Grok driver.

Subscription windows are reported per account and shown per instance: Claude
and Codex report for the whole driver, while OpenCode's `opencode-go` plan
belongs to that instance alone and is read from the server's experimental
`/api/experimental/usage/limits` route (the same server the thread runs on)
when a Go session starts and after its turns, at most once a minute. Every
other OpenCode provider reports no plan windows; when the route has nothing
to say — not signed in, no Go plan, an older server — usage is simply unknown,
never an error. Each provider's probe or refresh lists every window the
account has and replaces what Moxen recorded, so a quota the provider withdrew
stops being shown (Google removed Antigravity's separate Argon quota on
2026-11-23); an event that reports a single window — Antigravity's quota reply,
Claude's `rate_limit_event` — refreshes that one and leaves the rest.

## Antigravity and ACP

Moxen speaks **Agent Client Protocol v1** over newline-delimited JSON-RPC 2.0 on
stdio, pinning **`protocolVersion: 1`** during `initialize`: an agent that
negotiates any other protocol version is refused loudly
(`ACP_PROTOCOL_VERSION_UNSUPPORTED`) rather than running in an unverified mode.

- **Antigravity (`antigravity`)**: a first-class provider alongside Claude Code,
  Codex and OpenCode. It runs the official `agy` CLI unmodified (`agy acp`,
  configured under `providers.antigravity.binaryPath` and
  `providers.antigravity.launchArgs`), updates itself via
  `moxen update antigravity` (`agy update`), and is probed by `moxen doctor`.
- **Unsupported use (`providers.antigravity.allowUnsupportedUse`, off by
  default)**: Google's consumer sign-in for Antigravity covers one person, one
  account, and prompts you type yourself in an ACP client — not another agent
  delegating to `agy`, app-driven or unattended prompts, or several accounts
  on one machine. While this is off Moxen refuses to delegate a task to any
  Antigravity account (`antigravity`, `antigravity/<id>`, legacy `agy`) before
  a thread or worktree is created, holds automatic prompts on Antigravity
  threads (task notices, agent-queued messages, continues after a usage
  limit, usage-protection wrap-ups and recoveries, Moxen's own compaction
  prompts and their post-compaction resume, automatic hand-offs) in the work
  queue and notice batch instead of starting them, and never signs in an
  account with its own isolated home folder. The gate is one decision at the
  dispatch boundary, so every path - the turn a settling run promotes,
  recovery and steer redelivery, admission, a send whose session started
  while the setting was still on - holds alike, reading the setting in force
  at that moment, at the boundary itself: the decision's facts resolve first
  and the setting is read at the send or the steer, so a change landing
  during the gate's own reads is seen, not raced. A task
  notice rides only a live turn you wrote, decided before anything is
  written: a gate-refused notice records no ledger row and arms no retry
  timer. Redelivered standalone, or with
  only a Moxen-started turn live, it is held in its durable batch like any
  other automatic prompt. On Antigravity threads a promotion never folds a
  message of Moxen's into one of yours either way, even opted in; other
  providers batch as before. Nothing of a held entry is lost: it keeps its
  text and runs with your next message or when you turn the setting on.
  A launch or login input that
  moves the login off the host environment — an account `env` override of
  `HOME`, `USERPROFILE`, `SSH_CONNECTION` or the home/profile/config-dir
  variables, or a `--gemini-dir` launch argument — is refused with
  `ANTIGRAVITY_ACCOUNT_OFF`, never silently stripped down to the host login.
  Stored usage and credits of a gated account are not served, and turning
  the setting off stops that account's live driver and sessions without a
  restart. What you type, queue, schedule or click always runs. Turning it
  on is your choice: Google does not support delegation, automatic prompts or
  multiple accounts on consumer plans and may suspend the Antigravity account,
  and the TUI, desktop and CLI say so when you enable it. A turn the provider
  starts itself (a reactive wake-up inside `agy`) is not a Moxen prompt and is
  left alone.
- **Multiple accounts** (`antigravity/<id>`): an Antigravity account with a
  `homePath` runs `agy` with `HOME` and `USERPROFILE` pointed at that folder
  and a synthetic `SSH_CONNECTION`, so `agy` keeps its login in that folder
  instead of the OS keychain. While `providers.antigravity.allowUnsupportedUse`
  is off (the default), Moxen runs at most one Antigravity account: the first
  configured without a `homePath`, which shares the host `agy` login with its
  environment untouched. Every account with a `homePath` — or whose own `env`
  or launch args move its login off the host environment — and every account
  beyond that one, is shown as disabled with the reason
  (`moxen providers accounts list`, the settings pages; the provider catalog
  reports the reason before so much as checking whether `agy` is installed in
  that folder), is never launched,
  probed for usage or credits, or routed to, and a request that targets it
  fails with `ANTIGRAVITY_ACCOUNT_OFF`, naming the setting and how to fix it:
  remove the account's `homePath`, or turn the setting on. Your config is
  never deleted or rewritten on this path. Signing in an isolated account is
  refused the same way while the setting is off. Adding an Antigravity account
  is part of that too: while the setting is off, the TUI wizard's home step
  starts empty (the account signs in on the host `agy` login), the desktop
  add form writes no `homePath`, and the server's account login assigns no
  managed folder — a home you type yourself, or an account that already has
  one, still meets the same refusal. When an Antigravity account is already
  configured, the wizard and the desktop form say up front that the extra
  account stays disabled until you turn the setting on. With the setting on,
  the add flow behaves exactly as before: every new account gets Moxen's
  managed isolated folder (`~/.moxen/accounts/antigravity/<id>`).
- **ACP profiles (`providers.acp.agents`)**: managed like Moxen Harness
  profiles (`providers.harness.profiles`). Add as many ACP agents as you want
  — either picked from the pinned v1 ACP Registry
  (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
  cached under `<storeRoot>/cache/acp-registry.json` with offline fallback) or
  added manually (`id`, `name`, `command`, `args`, `launchArgs`, `env`,
  `enabled`, `defaultModel`, `defaultMode`). Each enabled profile appears as
  `acp/<id>` in the model picker. Launch arguments are tokenized into argv
  arrays and never joined into a shell string.
- **Worktree isolation, permissions & questions**: when Antigravity or an ACP
  agent delegates `fs/*` or `terminal/*` to the client, Moxen enforces worktree
  isolation on writes and commands and spawns processes with `shell: false`.
  Permission requests (`session/request_permission`) normalize both ACP and
  PascalCase `agy` tool inputs before enforcing worktree isolation, honor
  `approval-required`, `auto-accept-edits`, `auto`, and `full-access` (including
  for delegated threads and live `setRuntimeMode` / `session/set_mode`
  switches and configured `defaultMode`), reply with `allow_once` on automatic
  approvals and isolated sessions so agents cannot cache approvals past
  Moxen's gates, and cancel parked prompts when a turn settles or is
  interrupted. Form elicitations (`elicitation/create`, e.g. `agy`'s
  `ask_question`) surface in Moxen's interactive answer panel (`respondToUserInput`),
  while URL/OAuth elicitations and delegated sessions decline cleanly.
- **Session lifecycle, steering, compaction & skills**: `AcpDriver` registers
  peer handlers before `session/new` / `session/load` / `session/resume` so
  startup updates (`available_commands_update`, `usage_update`,
  `config_option_update`, `current_mode_update`, `session_info_update`) are
  never dropped, prefers `session/resume` over `session/load` when advertised,
  sends best-effort `session/close` on session teardown, adopts provider titles
  from `session_info_update` (`sessionTitle`), and refreshes cached agent
  profiles live when `providers.acp.agents` changes. For Antigravity, Moxen
  wires mid-turn steering (`steerTurn` via concurrent `session/prompt`; the
  main prompt's terminal outcome — success or error, with its usage and
  carried instructions — is held while a sibling steer is pending and
  reconciled by the last sibling to exit, whatever the order. A steer refused
  before its acknowledgement window is handed back to the caller and the turn
  keeps running on the main prompt, while any failure after acknowledgment
  fails the turn and sends `session/cancel` exactly like a main prompt failure,
  abandoning the surviving prompts so the next send drains them — bounded, so
  a silent agent cannot hold the drain forever — and their trailing output
  never leaks into the next turn) and
  `/compact` compaction (`session.notice: "compacted"`), merges local
  `.claude/skills` / `.agents/skills` with live `available_commands_update` in
  `skillInventory`, and computes estimated `contextBreakdown` from the live
  transcript since the last compaction.
- **Diagnostics & discovery**: `moxen doctor` probes `agy`, and the Settings
  page checks Antigravity's latest GitHub Release alongside Claude Code,
  OpenCode and Codex. Catalog discovery runs `initialize`, and when the agent
  advertises `sessionCapabilities.close`, probes `session/new` followed
  immediately by `session/close` (cached on disk under
  `<storeRoot>/cache/antigravity-models.json` per version) to surface the
  agent's live models, per-model effort levels, and subscription tier
  (`_meta.antigravity.tier.name`) without reading credentials. Non-Gemini
  models hosted through Antigravity (such as Claude Sonnet 5.5 and Claude Opus
  5.5) carry an `(Antigravity)` suffix so they stay distinct from Claude Code's
  own models across every client.
- **Context, token & plan usage**: `AcpDriver` consumes ACP `usage_update`
  notifications for live context-window readings (`contextUsage`; its `cost` is
  the session's cumulative cost per ACP v1. Each turn keeps the high-water mark
  of the readings observed while it was open — a snapshot equal to or below the
  baseline is never evidence of zero spend (the counter can lag a turn's own
  final charge). The driver maintains an effective baseline in cumulative-
  counter units, distinct from the booked turn-ledger sum: a reading with no
  turn open raises it (and establishes an unknown one — a fresh session's
  origin is zero, a resumed session's stays unknown until such a reading,
  with post-resume prompt-result costs never establishing it; the first idle
  reading initialises it to at least the result costs booked in the meantime,
  never their sum, since the reading may already include those charges), and a
  settled turn advances it to the counter reading it actually used, or by the
  cost it booked when the counter was silent or lagging — so spend already
  booked is never rebooked when the counter catches up, and unattributed
  out-of-turn growth is never charged to an arbitrary turn. At settle, the turn's cost is
  the in-turn counter delta above the baseline — the spec-defined cumulative
  counter wins over the prompt result's vendor-specific cost field — or the
  result cost when the counter did not move in-turn; a snapshot that never
  moved leaves the cost undefined so token-based estimation applies, never a
  reported $0 or an invented negative delta. The booked turn ledger totals
  the counter's movement) and
  per-turn `session/prompt` `usage` metrics for token/cost stats. For Antigravity,
  Moxen also probes `agy --print /usage --output-format json` and
  `agy --print /credits --output-format json` (zero-turn local slash commands,
  no shell, no credential access) to report subscription quota windows and
  remaining credits in the Context tab and `usage.limits`. Compact composer
  gauges track the `Gemini` pool (`5h`, `wk`, plus `Argon` once it reaches
  70%), while the extended Plan usage panel divides windows into `Gemini`
  (`5h`, `Weekly`, `Argon`) and `Claude & GPT` (`5h`, `Weekly`) subcategories.
  When `agy acp` surfaces quota exhaustion as a warning reply (`⚠ ...`),
  `AcpDriver` converts it into a `rate-limits.updated` + `rate-limited` state
  event, fails the turn, and triggers a forced usage refresh so usage-limit
  cards, `autoContinueAtUsageLimit`, and pool-scoped work-queue/protection
  rules work consistently with other providers.
- **Tool canonicalization, background tasks & reactive wakeups**: `AcpDriver`
  unwraps ACP lazy MCP calls (`call_mcp_tool` / `"MCP Tool <name>"`) and
  `"Run mcp_<server>_<tool>"` calls into `mcp__<server>__<tool>` rows,
  normalizes `list_dir`, `read_url_content`, `search_web`, `find_by_name`, and
  `"Run <tool>"` orchestration calls, promotes backgrounded `run_command` /
  `invoke_subagent` calls into `backgroundTasks(threadId)` (`background.task`
  and `background.tasks.changed`), exposes `backgroundTaskOutput` from
  accumulated tool updates or live client-owned `terminal/*` buffers, supports
  `stopBackgroundTask` for client-terminal-backed tasks (while agent-internal
  tasks like `agy`'s `run_command` remain `stoppable: false`), and records
  out-of-turn tool completions and reactive wakeup turns
  (`origin: "background"`). Because ACP cannot see internal `schedule` timers or
  pre-restart background tasks inside an agent, background task lists for `acp`
  and `antigravity` are marked `partial: true` alongside `opencode`. Native
  `invoke_subagent` (`Agent`) tool calls also publish `subagent.updated`
  (`started` / `stopped`) so they appear in the Agents view with their role and
  summary; full child subagent transcript inspection (`subagentHistory`) is not
  available because ACP v1 and `agy` do not expose child session IDs or subagent
  history RPCs.
- **ACP v1 protocol boundaries**: `AcpDriver` declares
  `supportsConversationRollback: false` (no conversation rewind RPC), forwards
  stdio and Streamable HTTP `mcpServers` on `session/new`, `session/resume`, and
  `session/load` (treating Antigravity as HTTP-capable when `agy acp` omits
  `mcpCapabilities` from `initialize`, routing Antigravity's external
  non-`moxen` MCP servers through a compact per-session loopback lazy gateway
  `moxen-mcp` (loopback-only HTTP that validates `Origin` and `Host` as MCP
  Streamable HTTP requires, plus a per-session bearer token) with
  `search_tools` and `call_tool` so `agy`'s 20,000-token eager
  schema budget never evicts tools while also honoring `disabledTools`,
  restoring host `HOME`/`USERPROFILE` and clearing the synthetic
  `SSH_CONNECTION` marker on direct stdio MCP children under isolated
  Antigravity accounts, and falling back to Moxen's stdio server
  for built-in tools on ACP agents without `mcpCapabilities.http`), forks
  sessions via `session/fork` automatically whenever an agent advertises
  `agentCapabilities.sessionCapabilities.fork` (failing cleanly with
  `FORK_UNSUPPORTED` when unadvertised, as in `agy acp` v1.5.13), and leaves
  operations without ACP v1 RPCs unadvertised (`sideQuestion` / `/btw`, prompt
  improver `completeText`, client-side session rename/title regeneration, and
  live mid-session MCP/tool updates).

## Mistral Vibe

Moxen drives **Mistral Vibe (`vibe`)** as an opt-in first-class provider (`providers.vibe.enabled: true`) over Mistral's official `vibe-app-server` stdio JSON-RPC 2.0 protocol (verified on `mistral-vibe` v3.1.4).

- **Authentication & single-account scope**: Moxen inherits the `vibe` CLI's own login (OS keyring or `~/.vibe/.env`) and never reads, copies, or stores Mistral credentials. In line with Mistral's consumer terms, Mistral Vibe is configured as a single-account provider (no multi-account pooling or rotation). `initialize.clientInfo` identifies Moxen honestly (`name: "moxen"`, `entrypoint: "unknown"`), and per-session model/effort picks always pass `sessionOnly: true` so Moxen never mutates global `vibe` defaults.
- **Discovery, diagnostics & updates**: Catalog discovery runs `initialize` → `setup/status` + `config/read` passively (no session started, cached under `<storeRoot>/cache/vibe-models.json`) to surface every unlocked model on your plan along with its `thinkingLevels` and context window size. `moxen doctor` probes `vibe` / `vibe-app-server`, Settings checks the latest `mistralai/mistral-vibe` GitHub Release, and `moxen update vibe` upgrades via `uv tool upgrade mistral-vibe`.
- **Sessions, streaming & tools**: `VibeDriver` handles RFC 6902 JSON-Patch streaming (`history/entry/updated`, including `append` ops), interim assistant notes, reasoning updates, checklists (`todo`), image attachments, mid-turn steering (`turn/steer` with unconfirmed-steer recovery), native compaction (`session/compact` handoff), conversation rewind (`session/rewind` handoff), session forking (`session/fork`), tool-free `/btw` side questions (`session/fork` with `enabledTools: []` — plus a deny-all `re:.*` in `disabledTools`, because on Vibe 3.1.5 an empty `enabledTools` list alone does not reach the MCP tool filter, so native MCP servers of the user's own Vibe configuration would otherwise stay routable), context breakdown (`session/context/read`), background shell processes (`session/backgroundProcess/{output,stop}`), and session rename (`session/title/update`). Vibe's built-in `task` subagent tool is always disabled via `disabledTools` so delegation runs through Moxen's tracked threads, and per-tool MCP exclusions (`mcp__<server>__<tool>`) are resolved against Vibe's `disabledTools` filter, which matches display names case-insensitively and digest-suffixes colliding names. For a server whose full tool list Moxen knows (Moxen's own in-process server), Moxen recomputes Vibe's published display names exactly — alias and identifier normalization included, digest disambiguation of genuinely colliding names (`write-file` and `write_file` both publish as `demo_write_file_<digest>`) — and emits an anchored exact-match pattern for the excluded tool's published name, so a real name collision cannot leave the tool callable; if the case-insensitive filter would also hide a published name that is not excluded (a case-fold sibling such as `write` beside `WRITE`), the server is not offered instead, with a notice. For any other server Moxen cannot know whether Vibe will digest-suffix the target's published name, so no pattern is trusted: instead of withholding the whole server, the servers that hold excluded tools are routed through Moxen's lazy MCP gateway (LOCAL-032) — a loopback HTTP server with a per-session Bearer token and a randomized name (`moxen-mcp-<hex>`) that exposes only `search_tools` and `call_tool`. Before merging the gateway, Moxen inspects the native Vibe catalog through a short tool-free preflight session (no offer, no turn) reading `config/effective/read`, allocates an identity verified free of both server-name collisions and tool display-name reflows against that catalog and the session's own offers, and refuses the start if the catalog cannot be read or if a surviving native same-name copy of a routed server would still expose an excluded tool directly (Vibe's `MergeStrategy.UNION` keeps a native entry the offer does not override, so omission is not a deny). Moxen connects to the real servers itself and enforces its own exclusions inside the gateway — an excluded tool is neither listed nor callable. Vibe's own tool restrictions are honored there too: after `session/start` (or `session/resume`) Moxen reads `config/effective/read` again — the whole merged configuration (user, trusted project, env, session overrides, agent profile, admin policy; credentials redacted), which Vibe only answers for a live session — excludes the gateway's own entry by its exact name and URL so it is never mistaken for a native collision, verifies the merged entry, and denies the gateway the tools that configuration turns off: a natively `disabled` server, a server's own `disabled_tools` (matched on the raw remote tool name), a per-tool `[tools.<server>_<tool>] permission = "never"` (a hard deny), and global `enabled_tools`/`disabled_tools` patterns (fnmatch globs with character classes and negation, or `re:` regex full matches, evaluated against every display name Vibe could publish for the tool, plain and digest-suffixed; any pattern syntax Moxen cannot prove equivalent to Vibe's fails closed). If the post-start read fails or times out the gateway is locked for the session; if it returns a shape Moxen cannot prove, or a native route now exposes a routed exclusion, the start is refused. The gateway route is taken only on the exact verified releases 3.1.4/3.1.5 (an allowlist, not a prefix — a lookalike build such as 3.1.5.post1 falls back to withholding); on anything else the implicated servers are withheld — today's behaviour, never less strict. The gateway's `call_tool` is identified strictly by the session-allocated name (a resembling digest-suffixed native sibling is not the gateway), a malformed or unknown target is denied before any approval opens, approvals for a genuine gateway call are judged and shown under the real server and tool with its real arguments (never as a generic `call_tool`), a "for the session" grant is downgraded so Vibe never remembers it for `call_tool` as a whole, and the gateway closes with its session. Every server without an exclusion, and Moxen's own in-process server, keep their offer untouched through the same plan (an ambiguous exclusion naming more than one server out-of-process routes those servers and is denied under every parse inside the gateway). That notice is published with the first send rather than at session start, so a subscriber attaching after startup — the normal send path's turn subscriber — still sees it once. Two MCP-override limits cannot be closed, and only one is guarded. First, when no MCP servers are supplied at all, Moxen sends no `mcpServers` key (and does not refuse startup): Vibe 3.1.4 then supplies no MCP override, so the user's own Vibe configuration's `mcp_servers` stay in scope — a native copy of a server is not denied, and Moxen's exclusions do not reach it there. Second, when servers ARE supplied but enforcing the exclusions would withhold every one of them and the lazy gateway route cannot be taken — an unverified Vibe version, or in-process case-fold conflicts with nothing left to offer — the payload would equally carry no override — so Moxen refuses to start that session with `VIBE_MCP_EXCLUSION_UNENFORCEABLE` (naming the excluded tools) instead of sending an override it cannot rely on; withholding some servers while at least one nonempty override remains stays allowed (a session routed through the gateway always has the gateway's own entry in its override, so the refusal is unreachable on that route). On Windows the launcher must be a direct executable or a shim `resolveWindowsLaunch` can unwrap (an npm-style `.cmd` to its real entry, or a `.ps1` run through `powershell -File`); an unrecognized `.bat`/`.cmd` wrapper is rejected with `VIBE_UNSUPPORTED_LAUNCHER` rather than run through `cmd.exe`, which would not preserve argument boundaries, and a drive-relative path (`C:tool.cmd`, or a bare drive qualifier `C:`) is rejected with `VIBE_INVALID_BINARY_PATH` in both discovery and session start. A relative `providers.vibe.binaryPath` resolves against the Moxen server's working directory.
- **Permissions, worktree isolation & questions**: `callback/call` uses Vibe's two-phase flow (immediate `{ callbackId, accepted: true }` acknowledgement followed by `callback/result`). Moxen enforces worktree isolation on file writes and shell commands across every permission mode (never allowing `allow_session` / `allow_always` in isolated worktrees), gates shell commands with `assessCommandLine` in `auto` mode, and bridges `ask_user_question` callbacks to Moxen's interactive answer UI (declining cleanly on delegated threads). Policy writes and turn admission share one per-session queue, and each turn carries its own requested mode (an overlapping send never substitutes a wider mode, and a mode-less send borrows the latest selection at send time). The requested mode, the mode currently being written and the last definitely acknowledged policy are kept separate: a turn is admitted only once its requested policy is definitely acknowledged, and after every awaited write the admission rechecks the latest selection — a newer, narrower one is applied (re-written and acknowledged) before the turn starts, so a queued admission can never start a turn wider than the caller's latest choice. A refused downgrade fails the turn start instead of running. A policy write that times out closes the session (the server may have applied it while the reply was lost, so the cached acknowledgement is unsafe), a `pending` response is not treated as applied and discards the cached acknowledgement (`pending` does not mean the previous approval policy is still in effect: Vibe applies the live approval change before parking the rest of the configuration, so the next turn re-writes and needs a fresh definite acknowledgement), and the session is rechecked open and registered immediately before `turn/start`. Turn completions are routed by server turn id first and otherwise correlated with the active server turn (only the `turn/start` response binds the id; early `turn/started` metadata and completions are buffered and consumed on binding, stale completions dropped, a duplicate replaces its buffer entry, and a genuine overflow fails the turn and closes the session), so a send queued behind a policy write can no longer strand the previous turn's completion; a turn start that times out closes the session (the server may be running a turn Moxen cannot identify); an interrupt requested while the id is still binding is sent once it is known, and if that deferred interrupt is refused the failure is reported as a notice while the accepted turn keeps its identity and completion tracking; and stopping a session settles every outstanding turn (queued sends included) as interrupted. A tightening `setRuntimeMode` made while a turn runs writes at once, skips queued setters the newer selection superseded before their RPC goes out, never widens the local callback gate past the latest selection (tight or pending), and defers a widening write until the session is idle again (only a write the live-turn check actually deferred is replayed at completion — a tightening answered `pending` is never re-sent, because Vibe already applied it live). Three limits remain, in plain words: Vibe applies a policy change to the running turn live, so a mid-turn upgrade can still take effect on the running turn; a withheld MCP server can remain callable through a native copy in the user's Vibe configuration when Moxen offers no MCP servers at all (there is no override left to deny it — when enforcing an exclusion would withhold every offered server, Moxen refuses session startup with `VIBE_MCP_EXCLUSION_UNENFORCEABLE` instead of sending that ineffective empty override); and overlapping sends to one provider thread are not supported: admission is serialized, but a send made while an earlier turn is still active can attempt a policy update and a `turn/start` concurrently with that live turn, and streaming attribution across such sends is best effort.
- **Plan usage**: `account/read` reports Mistral Vibe's monthly budget (`Monthly`, or `Monthly (PAYG)` when pay-as-you-go overage is enabled so 100% does not block continuation) and reset timestamp into `usage.limits` and the Context/Settings UI.

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
  left on its read-only `plan` agent goes back to `build`. Claude Code's native
  subagent tool is never offered either, under both of its names (`Agent` in
  `tool_use` blocks, `Task` in the `system:init` tools list): both stay out of
  the model's list in every Moxen-started session, whatever `disabledNativeTools`
  holds (a stored `Agent` or `Task` entry changes nothing), and the settings
  tool list leaves both out so neither can be switched back on. Fan out through
  Moxen's `delegate` tool instead, which Moxen tracks.
- Antigravity's internal orchestrator models (`gemini-pro-orchestrator-neon` /
  "Orchestrator (Neon)" and `gemini-pro-orchestrator-g1-pro` / "Orchestrator
  (Argon)") are omitted from Moxen's offered Antigravity catalog for the same
  reason: their orchestration stays opaque inside `agy` rather than creating
  tracked Moxen threads. Use Moxen's `delegate` tool for multi-thread work.
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
- A Claude reply can end with only a thinking block and no text: after one
  "no visible output" nudge from the CLI, the run still reports `success` with
  an empty result, which is what hides the answer of a `/btw` on the models
  that think adaptively (Fable 5.2, Opus 5.5, Sonnet 5.5). A reply's content
  blocks arrive as one assistant message each, all under one message id, while
  the result repeats only that message's last text block — so Moxen reassembles
  the whole final message when the result matches that block, and otherwise
  takes the result, which is then the answer after an interim note. A child
  tool's frames and another session's, as named by the run's `init`, are left
  out. When there is genuinely no text it says the model replied with thinking
  only instead of "empty". A turn that died on an API error also reports
  `success`, with the raw upstream body in its result; that body can echo the
  request, a credential included, so it is reported as a failure named by the
  SDK's own error kind and the HTTP status alone ("Claude is rate limited
  (HTTP 429)"), never as the model's answer.

## Codex

Install Codex and run `codex login` on the machine running Moxen's server.
Select **Codex** in the model picker, or set `provider` to `codex` with
`moxen config set provider codex` and
`moxen config set providers.codex.model codex-default`. The model and effort choices come from
`model/list`, including all pages, with the CLI's current default marked.
Existing `codex-default` selections still mean the CLI's configured default.
Moxen never reads or copies Codex credentials. Catalog and skill scans start
only a short-lived protocol connection; they create no Codex threads.

The Codex settings tab uses the same table as the CLI: `providers.codex.*`.
It includes executable and configuration directory, extra launch arguments,
default model, effort and permissions, instructions, idle lifetime, MCP access,
Moxen tools and memory, usage-limit continuation, compaction and hand-off rules.
`homePath` overrides `CODEX_HOME`; otherwise Codex's normal home is used.
Launch arguments are tokenized and passed as argv, never executed as a shell
command. The Settings page, command palette and `moxen update codex` run
`codex update` on the server machine, using the configured executable. The
page checks the published version alongside Claude Code and OpenCode. Running
sessions keep their current build until restarted.

| Moxen feature | Codex integration |
|---|---|
| Persistent conversations | Native thread start/resume; the saved handle survives idle expiry and Moxen restart |
| Models, effort and speed | Live model and effort discovery; model/effort changes per turn; service-tier options are forwarded |
| Streaming and timeline | Separate progress notes and final answers, detailed reasoning summaries with section boundaries, command output, file patches and MCP calls |
| Images and steering | Native image inputs and steering; distinct image-generation status, saved files and generated-image counts |
| Permissions and questions | Harness shell approvals and `ask` questions in the existing panels; native file/MCP approvals and elicitation remain supported |
| Tasks and agents | Native checklist and subagent lifecycle/history; Harness background commands with output and individual stop controls; native agents can be interrupted individually |
| Delegation and memory | Moxen's MCP tools, plus native conversation forks for delegated threads |
| Side questions and titles | `/btw` uses a disposable read-only native fork; native title read/rename, automatic generation and explicit regeneration on a fork; manual titles win over pending generation |
| Context and limits | Reported context totals, estimated categories from retained history after compaction, token usage and subscription windows; shared usage-limit continuation |
| Prompt suggestions | Native completed predictions feed Moxen’s composer when Codex emits them |
| Long threads | Native `/compact`, Moxen hand-off rules and optional Moxen-driven compaction |
| Rollback | Paginated retained history and `thread/revert`, with hydrated-history/`thread/rollback` fallback for older runtimes; files remain owned by Moxen's checkpoints |
| Diagnostics | Codex executable/version included in `doctor`; CLI JSON envelopes keep their existing fields |

Codex maps Supervised to untrusted/read-only, Auto-accept edits and Auto to
on-request/workspace-write, and Full access to never/danger-full-access. Auto
routes native approval review through Codex’s automatic reviewer; the other
modes use the user reviewer.
These policies govern Codex's remaining native tools. Shell commands run in
Moxen's process through the same Harness tools and safety checks as a Harness
session, rather than inside Codex's OS sandbox: Supervised and Auto-accept
edits ask about commands, Auto applies the Harness command assessment, and Full
access allows commands except those the Harness refuses as catastrophic.
Session approvals cover the matching command pattern, not every command.
Changes apply at the next turn. A worktree-isolated thread keeps a
workspace-write sandbox for native tools even in Full access; the Harness
worktree guard also refuses shell redirects into the protected checkout.

Moxen disables native `exec_command`, `write_stdin`, `request_user_input` and
`request_user_input_async`. The private `moxen_harness` MCP server supplies
`bash`, `powershell` when installed on Windows, `ask`, `task_output`,
`task_stop` and the `todo` checklist (unless the to-do list is off), using the
Harness implementations. `todo` updates feed the tasks panel, and Codex's own
`update_plan` is removed. This transport also attaches
the tools to existing rollouts without replacing the conversation. Disabling
Shell in Codex's tool settings removes the replacement shell tools too.
Harness calls require a live turn, including turns Codex starts in the
background. A delayed interrupt reply or start failure can only end its own
turn; it does not disable the tools for a later turn.
All MCP servers attached by Moxen, including its own memory/delegation tools and
configured servers, are exposed as direct tool calls alongside the Harness
tools. They bypass `functions.exec` and tool-search deferral. Other code-mode
options and existing direct-only namespace choices are preserved; strict
third-party deferral is disabled so it cannot move these tools back behind the
executor.
Delegated threads have no `ask` tool and refuse commands that need an absent
user's approval. Shell environments exclude provider keys, including configured
Harness profile key variables.

`ask` waits for the answer panel; dismissing it lets the model choose an
assumption. Interrupting a turn releases pending questions and approvals and
stops its foreground command. Commands started with `run_in_background`
survive turn interruption, expose output and an individual Stop action in the
tasks panel, and stop when the session ends. Completion is reported in the
next tool result or next turn; it does not wake an idle Codex session.

Native web activity preserves Codex’s provider identity and distinguishes searches
(including multiple queries), page opens and in-page finds. Older rows use the
turn’s saved provider when their activity payload has no provider identity.
MCP calls retain the server name and use the same readable server/tool labels as
Claude Code, such as `Linear · Get issue`, instead of bare method names and raw
response JSON.

Codex discovers and loads skills itself, including implicit activation. Reading a
chosen `SKILL.md` through a shell command is normal native Codex behavior; it has
no separate Claude-style Skill tool. Moxen’s skill picker reads the native
`skills/list` inventory and sends explicit `/name` or `$name` selections as
structured native skill references (name and path). See [native skills](https://developers.openai.com/codex/skills).

Moxen replaces Codex's own base prompt (`baseInstructions`, built in
`src/core/providers/codex/prompt.ts`) and adds its runtime instructions as developer
instructions. `bun scripts/system-prompt.ts --provider codex` prints both. Resumed
threads send the new base prompt too, so their cached prefix is read afresh once.

That base prompt doesn't state a model, and neither does the Moxen Harness's, and
Claude Code's names the model but not the effort, so the runtime instructions tell
every session its model and effort. A change mid-thread reaches it as an
instructions update on the next turn.

Every provider also gets `Your Moxen thread id is <id>.` at the end of its
runtime instructions. Delegated and research threads get their own id, and a
continued thread gets its new id. This immutable session context is appended
after instruction-update comparison; it does not change the shared instruction
text or trigger repeat-turn updates. Instruction previews built without a
thread id omit the line.

The shared runtime instructions allow relevant read-only Moxen CLI inspection.
They tell agents to use the agent tools for thread and task management, not to
bypass their restrictions, and to get explicit authorization for the action and
target before changing another thread through the CLI. This guidance does not
change CLI permissions or override server or sandbox denials.

Thinking summaries default to Detailed (`providers.codex.reasoningSummary`),
with Automatic, Concise and Off also available. Moxen preserves the reported
sections and renders their markdown; the amount of reasoning exposed remains
model-dependent. See [summary settings](https://developers.openai.com/codex/config-reference).

Image generation has its own running, completed and failed rows and counts. The
installed native protocol reports no numerical generation progress, so a
running generation shows a plain status label rather than a guessed
percentage. The runtime instructions tell models to embed a generated or edited
image’s absolute saved path in their final reply; a tool result alone does not
display an image in the answer. They also name `image_gen` (when it is in the
tool list) or the provider’s own tool as the way to generate, and say to report
image generation as unavailable rather than draw the picture with code.

Other providers can use Moxen's `image_gen` tool to run a focused Codex image
task in the same workspace. It uses the installed `codex app-server`, not an
internal image API, and does not read or export Codex credentials. Codex
threads use their native image tool instead; delegated tasks and providers
with orchestration switched off do not get the bridge.

Each image call resolves the newest released GPT Luna model (GPT-6 or later)
advertised by Codex's live model catalog. Versions are compared numerically,
so a future GPT-6.1 Luna or newer Luna release is picked without a config
edit. A rolling model alias is preferred over dated snapshots of the same
version; preview and hidden catalog entries are excluded. The task uses that
model's lowest supported reasoning effort other than `none`, regardless of
the parent's model or effort. If the latest Luna has no supported reasoning
effort, or Codex advertises no suitable Luna, generation is unavailable rather
than silently switching to another model. The catalog is not an entitlement
guarantee: Codex still validates access when the task starts. This selects the
model that calls the native image tool, not the underlying image renderer or
its quality setting.

New image-generation child threads are automatically hidden from the sidebar,
thread lists and thread search. They are stored normally, not archived or
deleted, and remain addressable by task id for results, cancellation and
diagnostics. Hiding survives reconnects and server restarts; ordinary delegated
tasks remain visible. Their completion notifications still reach the parent.

The bridge is offered only after Codex reports a supported paid ChatGPT plan
and current usage windows with at least **3% remaining in the five-hour
window and 1% in the weekly window**. Moxen checks again before starting
each generation. Either reserve falling below its threshold blocks the call,
even in an already-running agent. Missing, expired or unreadable limits block
it too; Moxen never assumes that an old window has reset. Switching off
Codex's native image-generation tool also switches off the bridge. API-key
accounts are not eligible for this subscription-only tool.

Pass a prompt and optionally up to five absolute reference-image paths on
the server machine. The tool returns a task id immediately, then an ordinary
task notification arrives when Codex settles. Call `image_gen` with that task
id to read its `images` list, or use `task_cancel` to stop it. Only successful
native image-generation events supply paths; a final message claiming to have
saved a file does not count. A settled task with no generated image reports
an explicit failure. Codex still decides availability and enforces its own
generation and safety limits.

Gaps and native limits:

- Dollar cost is not supplied. Context categories are explicitly estimates,
  using the same method as OpenCode; native totals remain authoritative.
- Legacy native command output remains visible, with no independent stop
  operation; stopping the parent turn remains available. New commands use the
  Harness tools. Native agent cancellation targets only that agent's current
  turn. Moxen delegated threads remain fully managed.
- Native plan mode is not exposed; Moxen’s interaction modes use shared
  instructions. Prompt suggestions depend on the runtime emitting predictions.
- The tool page lists shell, patching, subagents, web search, local image
  viewing, image generation, browser, computer, apps and sleep. Supported
  switches disable the native tool or family; availability still depends on
  Codex’s model and setup. Patching is shown as always on because Codex has no
  independent removal switch. Pre-tool hooks can deny it, but session-injected
  hooks need separate exact-hash trust approval; Moxen does not bypass that
  boundary. Goals (`create_goal`, `get_goal`, `update_goal`) are off by default; setting
  the list yourself replaces that default, so leave `goals` in it to keep them off. Codex's `update_plan` is always removed (`tools.update_plan.enabled`),
  since Moxen's `todo` replaces it; switching the to-do list off removes `todo`
  as well.
- `/btw` disables inherited MCP servers, apps, plugins, shell, subagents,
  web search, image tools, browser/computer tools, sleep and goals on its read-only fork, and declines approval requests.
  Unlike Claude's empty tool list, Codex may still offer harmless native
  tools such as its checklist. The parent conversation is never changed.
- Simple MCP elicitation forms use the answer panel; URL/OAuth elicitations
  are declined because Moxen does not host their browser sign-in flow.
- Previously opened native async questions still use the answer panel.
  Replies carry Codex's stable question IDs through
  its answered-question envelope, and can be submitted after the turn finishes
  or the server restarts. Pending questions are stored in Moxen's ledger.
  Answer-panel replies are internal inputs, hidden from the conversation view.
- MCP and native-tool configuration apply when a session starts. Restart an
  existing session to change them. Codex-owned compaction uses its native
  threshold; Moxen-driven modes suppress that threshold and invoke native
  compaction at Moxen's line. Per-model native compaction changes require a
  new session.

Protocol references: [Codex app-server](https://developers.openai.com/codex/app-server),
[configuration reference](https://developers.openai.com/codex/config-reference),
and [hooks and trust](https://developers.openai.com/codex/hooks).
The installed CLI's `app-server generate-ts` schemas were also checked; no
generated third-party protocol code is included in Moxen.

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

Servers Moxen starts also load the bundled `moxen.compaction` plugin, and with it Moxen runs OpenCode's
compaction itself, with the same summary prompt and checks as the Moxen Harness (`src/core/compaction/summaryprompt.ts`;
the plugin gets them as its `brief` option, so there is one wording). Moxen sets OpenCode's own `compaction.auto` to
`false` on those servers, whatever your config says. Then:

- **Writing the summary.** In OpenCode's `compaction` hook (for `/compact`, an automatic compaction and an overflow
  rescue alike) the plugin asks the session's own model, in the thread, for the summary: a private `<analysis>` pass
  that is thrown away, then the sections Objective, Requirements and corrections, Decisions, Errors and fixes, Ruled
  out, Work state (completed, active, blocked), Current work, Next step, Relevant files, Facts that are hard to
  rediscover and Workflow state. When the conversation already begins with a checkpoint, it is updated into one
  consolidated summary where newer history wins. The reply must have the Objective, Work state and Next step headings;
  if not, it is asked for once more with a short correction, and then the compaction fails with an error you see.
  OpenCode's own summary prompt is never the fallback.
- **No tools in that turn.** The summary request is a `session.generate` call made from the plugin; the plugin's
  `generate` hook empties the request's tool list for it, so the model is offered no tools. (Checked against a real
  OpenCode server: the request reaching the model had no `tools`.)
- **Recording it.** The plugin hands the text back as the hook's `result`, which OpenCode records as the session's own
  compaction (so its session state, `compacted` events and later turns are consistent) and skips its own summary
  request. The checkpoint is then OpenCode's, in OpenCode's storage, and survives a restart like any compaction.
- **When.** Moxen's "provider" compaction setting (`autoCompact`, `compactBuffer`) now decides: before a model request
  the plugin compares the last measured usage with the window the model can be given less the buffer (a tenth of it,
  at least 16k on windows of 32k and up, unless set), and asks for a compaction at the next step boundary, so the turn
  goes on afterwards. If a request is still rejected as too long, the driver compacts once and tells the model to
  carry on; a second rejection ends the turn with the provider's error. Moxen's own long-thread settings (compaction by
  Moxen, hand-off) work as before.

The plugin also keeps a durable cache of recent whole exchanges. The retained
tail is bounded to 12,000 estimated tokens and 16 MiB. After summary compaction it restores those
exchanges as real messages: roles, exact text, complete tool calls and results,
and actual attached image inputs with their original requests. It does not keep
older reference images outside that recent tail. An exchange that exceeds the
allowance or has an incomplete tool pair stays represented by OpenCode's summary
instead of being partially replayed. When the native retained range is longer
than the cached tail, its serialized historical prefix remains alongside the
restored messages. The cache survives OpenCode server restarts and repeated
compaction; reverted checkpoints do not gain future messages. Native replay
proof is removed when restoring onto a different model.

Retention applies to every compaction, independently of `moxenPrompt`. Native provider
compaction uses the provider's own checkpoint instead. External OpenCode servers Moxen did not start keep their own
settings and their own compaction: Moxen does not turn off their `compaction.auto`, and the plugin writes summaries only
when it is loaded through the `plugins` list with Moxen's `brief` option (without it, only the retention above runs and
OpenCode summarises in its own format). A running server loads the bundled hook when it next starts.

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
well-known MCP server that takes one (Brave Search, Exa Search) asks
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
the model is told about) and arrive inside `<untrusted_context>`. PNG, JPEG, GIF
and WebP results reach models that take images, like pictures from the built-in
file reader. Text keeps position markers and pictures keep their result order.
Each image has the file reader's 5 MB raw-byte cap; the attachment limits also
apply (100 images, 30 MiB encoded in one result, 8000 px per side, or 2000 px
above 20 images). Unsupported, invalid or over-limit images keep a text
placeholder explaining why; models without vision get placeholders too. The
MCP transport's existing 8 MB message cap still applies. A stdio server
gets a small environment (`PATH`, `HOME` and the like) plus its own `env`, not
moxen's; add what it needs (a proxy, a CA file) to its `env`. A server that fails
to start is reported at the next turn and the rest carry on; one that dies
mid-session is started again by the next call, at most three times. The tool set
is fixed for the session (it keeps the server's prompt cache): changing
`mcpServers` says so once and applies to a new thread. Skills (`SKILL.md`
folders in the project's `.claude/skills` and `.agents/skills`, the home
directory's) are listed in a
`skill` tool and loaded on request. A worktree-isolated session is held to its
worktree for edits, commands and MCP arguments alike, following symlinks.

User packages can restrict their providers with a `providers` list in the package's
`.moxen-skill-routing.json`; absent or empty means all providers that discover that package.
Use `moxen skills list` to read the choice and `moxen skills providers` to change it
(see [skill management](cli.md)). Claude receives an SDK skill context filter and per-skill deny rules, and its agent-skills
mod omits excluded packages. Codex receives session-local `skills.config` disables by file path.
OpenCode receives session-local skill-ID denies, including on an external server; Harness leaves
excluded skills out of its tool. Inventories offered through the server are filtered too. These
choices apply to new sessions and do not delete packages or prevent ordinary file reads.

Saving an edited skill replaces its file atomically after the conflict check: a same-directory
temporary file is renamed over it, with retry handling for Windows sharing violations. Disable/enable
keeps its exclusive-create collision protection.

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
Searching uses DuckDuckGo by default (no account); `webSearch` can also be
`searxng` (your instance, `searxngUrl`). Exa and Brave are not built in: add
their MCP servers from Moxen's own list (MCP servers → Add) and the Harness gets
their tools and the key they keep in the keychain, so there is one client and
one key per service. A file that still names `exa` or `brave` as `webSearch`
loads and searches with DuckDuckGo; its old `webSearchKey*` entries are ignored
(the keychain entries they pointed at are left for you to delete).
This machine is always reachable without asking; any other host asks like a
command does, once per host for the session; the local network needs
`web.privateNetwork` and cloud metadata addresses are never reached. Results are
marked as untrusted data.

The `web` settings (Agent context tab, Web tools) are shared: the `web_fetch` Moxen
offers Claude Code and OpenCode follows them too, so Never starts no browser on
any provider. A file from before they were shared still means what it did:
`providers.harness.webBrowser` and `webBrowserPath` apply to every provider
while `web.*` is unset, and `providers.harness.webPrivateNetwork` still opens
the Harness's tools only.

Gaps: the two API formats and the web tools have only been exercised against
fakes and local fixture sites (no live API, search service or real site), a
finished background command does not wake an idle session (the model hears of it
at its next step), a subagent has no MCP tools and cannot run in the background,
there is no PDF reading, MCP gives tools only (no resources, prompts, sampling or OAuth
sign-in; a bearer token in `headers` works), a rule file edited while the thread
was closed is not noticed on resume (an edit while it is open reaches the model as a
patch ahead of its next message), and a resumed session starts with no session
approvals and an empty checklist.

## Usage protection contracts

The shared [usage protection](threads.md#protect-work-before-the-allowance-runs-out)
coordinator uses existing driver interruption and turn-start operations. It holds
queues first, interrupts active work, then starts a dedicated wrap-up turn. This
works for Codex review/compact turns too, without assuming they accept steer.
It does not silently install or approve provider hooks.

Conditional messages, new threads and usage recovery share server-owned queue
admission. Explicit usage conditions require a real quota feed; a thread on a
provider without one (an OpenCode provider other than Go, or the Harness) can
still use time, dependencies, and another provider's quota conditions.
OpenCode Go reports its own plan windows; they belong to that instance.
Automatic recovery checks the session and weekly reserves immediately
before admission. Model-written handoffs use a dedicated summary turn and the
request-scoped `submit_handoff` tool, not final-response parsing. Providers whose
MCP definitions are fixed at session creation reopen the same conversation from
its saved cursor to make that tool available. Missing or disabled tools fall back
to the stored handoff rather than claiming a model summary was delivered.

Contracts checked against current documentation on 2026-11-02 and the installed
Claude Agent SDK 0.3.292 / OpenCode client 2.0.24:

- [Claude SDK](https://code.claude.com/docs/en/agent-sdk/typescript): usage probes
  and `rate_limit_event` supply subscription windows; the existing driver maps
  those to account-wide limits. Result cost is cumulative and includes native
  tasks. Streaming sessions support interruption and subsequent input.
- [Claude Wrap-Up Allowance](https://support.claude.com/en/articles/17040437-claude-code-wrap-up-allowance):
  provider-controlled and automatic for eligible accounts, with no documented SDK
  switch. Moxen exposes a preference for its own proactive stopping or the native
  allowance, not a pretend allowance toggle. A native `usage-wrap-up` event wins
  over a second Moxen prompt. It may pass 100% of the five-hour window because that
  allowance is explicitly additional usage.
- [Codex app-server](https://developers.openai.com/codex/app-server):
  `account/rateLimits/read` and updates expose percentage/reset windows;
  `turn/interrupt` stops a turn, and `turn/start` resumes work. Input totals include
  cached tokens; Moxen records camelCase `inputTokens` minus `cachedInputTokens`
  as uncached input, with cache reads recorded separately. Anthropic-style
  `input_tokens` / `cache_read_input_tokens` are already separate and stay so.
  Existing recorded usage is not rewritten. Estimates do not add reasoning output
  twice. A model with no price anywhere stays uncalibrated: neither its past
turns nor a wrap-up for it are given a cost.
- [OpenCode v2 API](https://opencode.ai/v2/docs/api): ordinary external-provider
  sessions have no general subscription quota feed. The docs list
  `experimental.usage.limits`, which covers the OpenCode Go/Console workspace's
  5-hour, weekly and monthly allowances, not arbitrary connected Claude/Codex
  accounts. The installed client does not expose the route, so Moxen calls it on
  the server it already runs (the connection's own Basic auth, the location
  query), only for a Go session, at session start and after a turn, at most once
  a minute, and treats every failure or changed body as unknown. Only
  `opencode/opencode-go` gets those windows; other OpenCode providers stay
  outside quota-triggered protection. It retains its existing
  per-turn usage, interruption, durable inbox and usage-limit continuation.
- Moxen Harness API endpoints likewise have no subscription-window contract;
  token totals alone cannot supply remaining account allowance.

There is no hard cross-provider tool-call cap in this feature. Claude hooks can
deny calls, but Codex pre-tool hooks require user-approved hashes and OpenCode
does not expose the same hook contract. Moxen instead bounds its wrap-up by
reported quota and elapsed time, and instructs the model to use essential tools
only. It never bypasses hook approval to claim stronger enforcement. A request
already in flight may still consume usage after the last observation.
