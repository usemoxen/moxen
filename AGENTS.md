# AGENTS.md

Moxen is a terminal UI and CLI for coding-agent threads. It drives `claude`
and `opencode` (GPT and Grok go through OpenCode). Bun + TypeScript + React
via `@opentui/react`.

Keep this file under 200 lines and 10,000 characters. Put detail in `docs/`.

## Read first

`docs/contributing.md` has the layout, TUI conventions, boundaries and the
tests policy. Read it before changing code. `docs/overview.md`,
`docs/threads.md`, `docs/providers.md` and `docs/cli.md` explain how Moxen
runs.

## Layout

`src/core/` is the domain. `src/server/` is the boundary (`ClientApi`).
`src/cli/` and `src/tui/` are the two clients. Core imports no client, and
clients reach core only through `server/`. `src/tests/layering.test.ts`
checks this.

## Commands

- `bun run check`: typecheck and tests.
- `bun run check:tui`: TUI render check.
- `bun run build`: writes `dist/`. `bun run tui` rebuilds and opens the TUI.
- `moxen --json doctor`, `moxen server start|status|stop`.
- `bun run test:inventory <path-part>`: lists existing test titles.

## Rules

1. Run `git status` first. The tree often holds someone else's changes. Don't
   revert, stash or commit what you didn't change.
2. Don't break CLI `--json` output. `src/cli/tests/envelopes/` pins it byte
   for byte. Change a golden only on purpose, and say so.
3. Never print a credential or write one to a file. Keys live only in the OS
   keychain, through `core/secrets.ts`.
4. Settings live in one table, `core/configschema.ts`. Add a setting there,
   not in a client.
5. Never build shell commands by joining strings. Pass argv arrays or stdin.
6. Don't add tests just for coverage. See the tests policy in
   `docs/contributing.md`.
7. Run `bun run check` before saying you're done, and say what you didn't run.

## CI: macOS and Windows

CI runs `bun run check` and `bun run build` on both. Passing on macOS doesn't
mean it passes on Windows. You can't run Windows locally, so check these when
you touch paths, files, processes or temp dirs:

- Don't type POSIX paths into expectations. `path.resolve("/Users/x")` is
  `C:\Users\x` on Windows. Build the expected value with the same `path` call.
- Compare paths with `fs.realpathSync.native` (not `realpathSync`). Windows
  temp dirs can come back as short names like `RUNNER~1`.
- Use `node:path`, not `/` in code or regexes. Drive letters can be `c:` or
  `C:`.
- Windows reads `USERPROFILE`, not `HOME`. Tests that fake the home folder
  must set both.
- PowerShell and cmd don't expand `~`. Use `expandHome`.
- Deleting a file in use fails with `EBUSY`/`EPERM`. Handle it, and close
  handles and stop servers before removing a test folder.
- Don't use `sh`, `kill`, `ps`, `chmod` or `/tmp`. Skip POSIX-only tests on
  `win32` and say why in the title.
- Files are LF. Don't depend on the platform's newline.
- Wait on a condition, not a fixed `sleep`. Windows is slower.

When asked to push: push, then run `gh run watch <id> --exit-status` and
report both jobs. A red Windows job is a real failure; fix it and push again.
To read one: `gh run view <id> --log-failed | grep -E 'FAIL|Error|×'`.

## Linear

All work has a Linear issue (team Moxen, `MXN-n`).

1. Search for an existing issue first.
2. If there is none, show the user the issue you'd create and wait for a yes.
3. Set it In Progress when you start and In Review when the work is done and
   checked. Never set Done yourself. Write what happened in the issue.
4. Big work gets a main issue with sub-issues, labelled (`Bug`, `Feature`,
   `Improvement`, `Cleanup`, `Windows`, `macOS`, `TUI`). The main issue isn't
   In Review until all its sub-issues are.
5. Put the key in the commit subject, e.g. `(MXN-151)`.

## Git

- Commit only when asked. Stage files by name, not `git add -A`.
- Don't skip hooks, force-push, or amend pushed commits.

## Style

- Match the code around you.
- Look for an existing helper before writing one.
- If you change behavior a doc describes, update the doc.
