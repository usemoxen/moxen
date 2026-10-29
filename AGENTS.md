# AGENTS.md

Moxen (`moxen`) is an interactive terminal UI plus CLI for coding-agent
threads. It drives `claude` and `opencode` directly (GPT and Grok go through
OpenCode). Bun + TypeScript + React via `@opentui/react`. Provider CLIs own
their logins; this tree never touches *their* credentials.

**Keep this file under 200 lines and 10,000 characters, always.** Put detail
in `docs/`, and link to it from here.

## Read first

- [`docs/contributing.md`](docs/contributing.md) — layout, TUI conventions,
  boundaries, tests policy. Read it before changing code.
- [`docs/overview.md`](docs/overview.md), [`docs/threads.md`](docs/threads.md),
  [`docs/providers.md`](docs/providers.md), [`docs/cli.md`](docs/cli.md) — how
  Moxen runs.

## Architecture in one paragraph

One core (`src/core/`), one boundary (`src/server/`, the `ClientApi`), two
clients (`src/cli/`, `src/tui/`). `core/` imports no client; clients reach
core only through `server/`. New frontend surface goes in `server/`, not in a
client. `src/tests/layering.test.ts` enforces this with no exceptions.

## Commands

- `bun install`, then `bun run check` (typecheck + tests, ~20s).
- `bun run check:tui` (`bun src/tui/render-check.tsx`) after TUI changes.
- `bun run build` writes `dist/`; `bun run tui` rebuilds and opens the TUI.
- `moxen --json doctor`, `moxen server start|status|stop`.
- `bun run test:inventory <path-part>` lists existing test titles.

## Always

1. Run `git status` first. The tree is often dirty with someone else's work;
   never revert, stash or commit changes you did not make.
2. Keep CLI `--json` envelopes backward compatible. `src/cli/tests/envelopes/`
   pins them byte for byte; change a golden only for an intended change, and
   say so.
3. Never print a credential or write one to a file. The OS keychain, through
   `core/secrets.ts`, is the only place Moxen keeps one. Config holds a
   `keychain:<name>` reference, never the key.
4. Settings live in one table, `core/configschema.ts`. Add a descriptor there;
   never a key list in a client.
5. Pass prompts as argv/stdin arrays, never concatenated into a shell command.
6. Do not add a test for coverage's sake. Read the tests policy in
   `docs/contributing.md` and extend the nearest test.
7. Run `bun run check` before claiming completion. State plainly what you did
   not run.

## Windows and macOS: CI runs both

CI (`.github/workflows/ci.yml`) runs `bun run check` and `bun run build` on
`macos-latest` **and** `windows-latest`, under Git Bash. Passing on macOS does
not mean CI passes. Most Windows failures so far were one of these:

- **Short vs long temp paths.** `os.tmpdir()` on Windows can return an 8.3
  short name (`C:\Users\RUNNER~1\…`) while git, the server or the OS report
  the long one. Compare paths in canonical form: `fs.realpathSync.native`,
  never plain `realpathSync` (fixed in `732d287`). Do the same before
  asserting equality on any path that crossed a process boundary.
- **Separators and drive case.** Never build or match paths with a hard-coded
  `/` or a regex on `/`; use `node:path`. Windows paths ignore case and a
  drive may come as `c:\` or `C:\`. Compare through a normalising helper, not
  `===`. Goldens that contain rooted paths pin forward slashes (`61dda8d`).
- **POSIX literals in expectations.** `path.resolve("/Users/x")` becomes
  `C:\Users\x` on Windows. Derive the expected value from the same `path`
  call instead of typing a POSIX string (the `memory.test.ts` failure).
- **Home directory.** Windows `os.homedir()` reads `USERPROFILE`, not `HOME`.
  A test that isolates the home folder must set both, or it writes to the
  real one.
- **`~` is not expanded** by PowerShell or cmd. Run user-supplied paths
  through `expandHome` before `path.resolve`.
- **Locked files.** A file in use throws `EBUSY`/`EPERM` on delete or rename.
  Cleanup code must tolerate it; tests must close handles and stop servers
  and subprocesses before removing their folder.
- **Processes.** There are no POSIX signals or process groups to rely on. Use
  the existing kill helper, and never shell out to `sh`, `kill`, `ps`, `chmod`
  or `/tmp` in code or tests. A test that is truly POSIX-only is skipped on
  `win32` with the reason in its title.
- **Line endings.** CI sets `core.autocrlf false`; files are LF as committed.
  Do not write tests that depend on the platform's newline. Do not introduce
  CRLF into tracked files.
- **Timing.** Windows runners are slower and start processes slowly. Wait on
  a condition, never on a fixed `sleep`.

You cannot run Windows locally on macOS. So when you touch paths, processes,
the filesystem, the home folder or temp dirs, reason about every item above
and say which you checked. After pushing, watch the run:

```
gh run list --limit 3
gh run view <id> --json jobs --jq '.jobs[]|[.name,.conclusion]|@tsv'
gh run view <id> --log-failed | grep -E 'FAIL|Error|×'
```

A red Windows job is a real failure, not flakiness. Do not rerun it hoping it
goes green. When asked to push, push, then watch the run to the end
(`gh run watch <id> --exit-status`) and report both jobs. Work is not done
until CI is green on both; if it is red, fix it and push again.

## Linear

Every piece of work is scoped in Linear (team Moxen, `MXN-n`).

1. Search for an existing issue first (`list_issues` with a query).
2. If none exists, show the user the issue you would create and wait for
   approval. Then create it and start the work.
3. Move the issue as you go: In Progress when you start, In Review when the
   change is done and verified, never Done on your own. Post status updates
   as comments or in the description (cause, fix, what was and was not run).
4. Big work gets a main issue plus sub-issues, categorised and labelled
   (`Bug`, `Feature`, `Improvement`, `Cleanup`, `Windows`, `macOS`, `TUI`).
   The main issue is not In Review until every sub-issue is.
5. Put the issue key in the commit subject, e.g. `(MXN-151)`.

## Git

- Commit only when the user asks. Stage files by name, not `git add -A`,
  so work that is not yours stays out of your commit.
- Do not skip hooks, force-push, or amend published commits.
- Commit subjects are short, imperative sentences ending in the issue key.

## Style

- Match the surrounding code: naming, comment density, idiom.
- Prefer the existing helper over a new one; grep before writing.
- Docs use one word per concept ("hand off", "thread" vs "session"); see
  `docs/contributing.md`.
- When you change behavior a doc describes, update the doc in the same change.
