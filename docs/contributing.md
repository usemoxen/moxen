# Contributing to Moxen

Read this before changing code. The user-facing docs (`overview.md`,
`threads.md`, `providers.md`) explain how Moxen runs; this page explains
how to work on it.

## Layout

The tree is **one core, several clients**.

`core/` imports no client — that invariant holds and is worth keeping
(a contract test asserting a client can read core's output belongs on
the client side, as `tui/model/tests/toolactivity.test.ts` does).

The shared kernel (`core/types.ts`, `core/errors.ts`, `core/config.ts`,
`core/mcp.ts`, and pure rules like `catalog/selection.ts` and
`threads/views.ts`) is common vocabulary and imported freely.
The reverse now holds too, apart from the shared kernel: both clients go
through `server/` (`ClientApi`) for every operation, `doctor` included
(it is a server query). `src/tests/layering.test.ts` pins this, with no
exceptions.

- `src/core/` — the domain, with no opinion about how it is driven:
  `providers/` (the four driver implementations + `spi.ts`), `threads/`
  (store, lifecycle, turn runner, tool-activity mapping, read views, and
  `operations.ts` — handover, delegation, send policies — that every
  client calls), `projects/` (registry + workspace resolution),
  `checkpoints/`, `usage/`, `events/`, `catalog/`, `git/` (read-only local
  history, branches and status — separate from `checkpoints/git.ts`, which
  writes), `forge/` (pull and merge requests through `gh` / `glab`; we drive
  their CLIs so we never hold a token), plus the shared kernel
  `types.ts` / `errors.ts` / `config.ts` / `configschema.ts` (the settings
  table both clients render from). Each area keeps its own `tests/`.
- `src/core/syntax/` — the vendored tree-sitter grammars plus their
  loader, shared by every presentation client (the TUI today, the desktop
  next). The one `core/` area clients may import directly; the layering
  test pins the exception.
- `src/server/` — the boundary: `api.ts` is `ClientApi`, the typed
  contract every frontend talks through (`dispatch` for commands, `query`
  for reads, `subscribeShell`, `subscribeThread`, `turnDiff`,
  `getConfig`); `protocol.ts` holds the command/query/frame shapes and
  their runtime decoders; `connection.ts` is the in-process implementation
  over `core/`; `transport/` serves it over a named pipe / unix socket
  (`serve.ts`) and implements it remotely (`remote.ts`), and carries remote
  access to another machine: the TLS listener (`remoteaccess.ts`,
  `certificate.ts`), pairing and device tokens (`devices.ts`), and the
  client's paired servers (`servers.ts`); `client.ts` picks one per
  `MOXEN_SERVER` (`direct` | `auto` | `daemon`, or a paired server's name)
  or `--server`; `workspace.ts` backs the live-diff reads a remote client
  makes; `main.ts` is the
  server process; `mcp/` is the `moxen` MCP server every top-level provider
  session gets (`delegate` / `task_status` / `task_cancel`, over `ClientApi`).
  **New frontend surface goes here, not into a client.**
- `src/cli/` — a client: `index.ts` (command definitions; thin dispatch
  over the modules below), `output.ts`, `doctor.ts`, and `catalog/`,
  `handover/`, `infra/` (`client.ts` — the CLI's `ClientApi`), `projects/`,
  `threads/`, `git/` (the `git` and `pr` command groups) — flags, prompts
  and `--json` envelopes over `ClientApi`;
  `tests/envelopes/` pins every envelope byte-for-byte.
  Each has its own `tests/` subfolder.
- `src/tui/` — a client, the interactive app:
  - `app/` — the root component: `app.tsx` wires hooks together and holds root identity/picker-orchestration state, `hooks/` for cross-cutting hooks used by `app.tsx` but not owned by one feature (`useThreadCreation`, `useThreadOps`, `useQuitConfirm`), plus `utils.ts` / `constants.ts`.
  - `features/` — one folder per feature pairing its component with its hook: `sidebar/`, `composer/`, `timeline/`, `diffpanel/`, `sidepanel/` (the tab strip and the Diff / Context / Agents / Background tabs, in that order), `gitpanel/` (the Git tab: the branch's PR/MR with CI, agent-opened PRs, branches, and history with a per-commit view), `settings/` (the settings page, rendered from `core/configschema.ts`), `taskspanel/`, `answerpanel/`, `pickers/`.
  - `ui/` — generic presentational primitives with no feature-specific state: `hoverbutton.tsx`, `modalshell.tsx`, `renamemodal.tsx`, `noticebanner.tsx`, `backdrop.tsx`, `theme.ts`.
  - `model/` — pure projection logic (`thread.ts`, `turns.ts`, `activity.ts`, …), genuinely cross-cutting across features.
  - `hooks/` — shared runtime hooks used across features (`useToasts`, `useClipboard`, `useHover`, `useAnimTick`).
  - `render-check/` — snapshot harness: `fixtures.ts` (mock client/builders), `helpers.ts`, `scenarios/*.ts` (one file per feature area); `render-check.tsx` at the top level is the slim orchestrator that runs them in sequence against a mock client with scripted input and captures char frames. No live terminal needed.
- `mods/` — Claude Code mods shipped in the package and loaded into Claude sessions as local plugins: `agent-skills` (serves `.agents/skills` and, when they are served or copied there, moxen's `skills/`). Check one with `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
- `parsers-config.json` / `parsers-build.json` — the tree-sitter grammars under `src/core/syntax/`: the first lists grammars with a published wasm, the second those built from a pinned source (`bun scripts/build-tree-sitter-grammars.ts`, needs the `tree-sitter` CLI). `bun run update:tree-sitter-assets` also rewrites every `LICENSE` there and `THIRD_PARTY_LICENSES.md`.
- `docs/` — Moxen docs plus `external/`, mirrors of the Claude Code and OpenCode v2 docs we check behavior against. `bun run update:docs` refreshes the mirrors (`claude`, `opencode`, `--dry-run`, `--prune`); `git diff docs` after a run is the changelog.
- `upstream/` — read-only depth-1 clones of the reference implementations we check behavior against (OpenCode's plugin/loader contracts, compaction rules). Gitignored. Verify there before copying upstream behavior — never guess it.

## Workflow

1. Inspect `git status --short --branch` and the files being changed.
2. Keep CLI JSON envelopes backward compatible. `src/cli/tests/envelopes/` pins every one byte-for-byte, in-process and over the wire; update a golden only for an intended change, and say so.
3. Run `bun run check` (typecheck + tests) before claiming completion.
4. Extend `render-check.tsx`'s scenarios and `model/*.test.ts` when changing TUI behavior.

## TUI conventions

- New feature-specific state goes in that feature's own hook under `src/tui/features/<feature>/`; cross-cutting state that a single feature can't own goes in `src/tui/app/hooks/`. Shared, stateless-ish runtime hooks live in `src/tui/hooks/`. Avoid adding more raw `useState` to `app.tsx` itself.
- Every modal renders inside `ModalShell`; notices go through `useToasts`.
- Interactive chrome gets `useHover()` feedback and `selectable={false}`; only readable text stays selectable.
- Daily use runs the bundle: `bun run build` writes `dist/` (`scripts/build.ts`), and `moxen` is `bun dist/cli/index.js`. Bundling transpiles once, bakes in `NODE_ENV=production` (including React's production runtime) and splits the TUI out of the startup path of plain commands. The production runtime matters: under Bun's development JSX runtime every React element captures an `Error` stack in native memory, which grew a long session to 10+ GB (MXN-38). `bun run tui` rebuilds and opens the TUI in one step. Running the source directly (`bun src/cli tui`) uses the development runtime — fine for short runs, not for measuring memory or CPU. After changing anything that loads assets or finds files relative to itself, rebuild and check `bun dist/cli/index.js tui`: the tree-sitter grammars and worker are file imports that the build rewrites (see the comment in `scripts/build.ts`), and the server daemon runs `dist/server/daemon.js`.

## Boundaries

- Never print or persist provider credentials. Provider CLIs own their own logins; we only ever observe credential *presence*. The keys Moxen itself needs (a Moxen Harness profile's API key, a web-search key, MCP secrets) are stored only in the OS keychain through `core/secrets.ts` (`Bun.secrets`: Keychain, Credential Manager, libsecret); config holds a `keychain:<name>` reference or an env var name, never the key, and nothing prints one. The same rule governs forges: `gh` and `glab` own their logins, so `core/forge/` shells out to them and never handles a token. `forge.*` config is executable paths and an off switch, nothing more.
- Settings live in one table (`core/configschema.ts`). Adding a setting means adding a descriptor there — never a key list in a client — so `moxen config` and the TUI settings page stay in step by construction. A structured list (the harness profiles) is a `list` kind: its fields are `ListField`s next to the owner of the rules (`providers/harness/profileschema.ts`), its entries are addressed by id (`key[<id>].<field>`, see `core/configlist.ts`), the owner's validation runs on every edit through `normalizeConfig`, and the entries a client draws come from a `ListItemView` builder registered in `describeSettings`. A client never restates a range or a precedence rule.
  - A descriptor says what a description must not: when a change applies (`appliesAt`: next session, OpenCode restart, Moxen server restart; `--json config list` still derives `restartRequired` from it), what applies while it is unset (`fallback`: another key, a value decided elsewhere, a plain text, or a named resolver; `describeSettings` resolves it into `effective`, which the page's Default names), and when it is shown (`visibleWhen`, and on list fields `visibleWhen` relative to the item). A boolean with no default is three-way on the page: Default, On, Off.
  - A list field says it with `unset` (a value, or a few words such as "the server's"), and a field whose own item decides its choices (an effort the profile's models list) is an `effort` kind, offered as `ListFieldView.choices`. A group's shared advice is `groupDescription`, said once under its heading.
  - **Replacing a setting**: the older key stays readable (`normalizeConfig`) and its descriptor stays, `hidden: true`, so `config set` keeps accepting it; the new descriptor's `fallback` names the older value while the new key is unset; nothing is rewritten on load, and saving only normalises to values an older build reads the same way. Add the older shape to `core/tests/migration.test.ts` and check it on what a session does, not on the file's shape.
  - **Writing a description** (`configschema.test.ts` guards the mechanical part):
    1. The first sentence says what the setting changes, in the user's terms.
    2. An optional second gives a trade-off or warning worth knowing ("uses far more tokens", "touches the network each time the panel opens").
    3. Never in prose: what applies while unset (`fallback`, `unset`), when a change applies (`appliesAt`), which tab another setting is on (refer to it by its label, "the global 'Compact at'"; the page generates where it lives), or what values exist (each choice has its own line).
    4. One word per concept: "hand off" (never handover or hand-off), "compact", "share of the window" against "size", "provider" against "model server" (a Harness profile's endpoint), "thread" against "session" (a session is the provider process behind a thread).
    5. A setting every provider has comes from one template with the provider's name put in (`toolSettings`, `sessionSettings`, `longThreadSettings`, `moxenSkillsSetting`), so the three tabs cannot drift.
- Keep local project discovery read-only; fall back to authenticated HTTP when the projection DB/schema is unavailable.
- Pass handover prompts as argv/stdin arrays, never concatenated into shell commands.
- Vendoring third-party code needs its notice to travel with it: MIT-licensed reuse is permitted, the combined work stays AGPL-3.0-only, never relicense vendored files and never strip notices. Grammar licenses are generated (`bun run update:tree-sitter-assets` rewrites `THIRD_PARTY_LICENSES.md`); non-grammar vendored code is recorded in `THIRD_PARTY_NOTICES.md`, creating it if absent.

## Tests

The suite is large (~1.2k tests) and an audit found it is not padded: almost nothing lacks an assertion and almost nothing duplicates anything, because nearly every test pins something that went wrong once. So the rule is **do not add tests for coverage's sake**, and when you do add one, add it where the area already pins that behavior.

- **Write a test only to pin** one of: a bug that happened (put the failure in the title — "does not X when Y"), a byte or wire contract (the envelope goldens, `protocol.ts`), a safety boundary (credentials, worktree isolation, layering), or a non-obvious invariant a future edit would silently break.
- **Do not write** tests of types, trivial getters or pass-through wiring; tests that restate the implementation; one `it` per input where an `it.each` table says it once; a new render-check frame for behavior a `model/*.test.ts` already covers.
- **Before adding one**, read what the area pins: `bun run test:inventory <path-part>` lists every test title in matching files (and with no argument, tests and time per area plus the slow tests and big files). Extend the nearest test or table. A new test file is for a new module.
- **Mind the clock.** The whole suite runs in ~20s; a test over ~1.5s must have a reason (a real subprocess, a real timeout). `testHarness`'s `afterEach` waits up to 2s for a turn that never settles (`leaveTurnsRunning`), so a test that leaves one pays that once — do not leave runs pending you do not need.
- A test that imports `server/` lives in `src/server/tests/`; `core/` tests never import upward (`layering.test.ts` enforces it).
