# AGENTS.md

Moxen is a terminal UI and CLI for coding-agent threads. This file says how
to work on it. The details live in `docs/`; read `docs/contributing.md`
before changing code.

Keep this file under 200 lines and 10,000 characters.

## How to work

- Check `git status` first. The tree may hold someone else's changes; don't
  revert, stash or commit what you didn't change.
- Respect the layering: core, then the server boundary, then the clients. New
  frontend surface goes in the server, not in a client. The layering test
  enforces it.
- Keep CLI `--json` output backward compatible. Change a golden only on
  purpose, and say so.
- Never print a credential or write one to a file.
- Settings live in one table. Add a setting there, not in a client.
- Never build shell commands by joining strings.
- Write tests to pin a bug, a contract or an invariant, not for coverage.
- Match the code around you, and look for an existing helper before writing
  one.
- If you change behavior a doc describes, update the doc.

## Cross-platform

Moxen runs on more than one OS, and nothing you write may assume one. Never
hardcode a path style, separator, home variable, shell, newline or timing.
The checklist is in `docs/contributing.md`. If you can't run a platform
yourself, reason about it and say what you couldn't verify.

## Done means

- The project's full check passes (`bun run check`), and you say what you
  didn't run.
- CI passes completely. Whatever it runs today, and however that changes, a
  red job is a real failure: don't rerun it and hope, don't call the work
  done, fix it.
- When asked to push, push, then watch the CI run to the end and report the
  result of every job.

## Linear

All work has a Linear issue (team Moxen, `MXN-n`).

1. Search for an existing issue first.
2. If there is none, show the user the issue you'd create and wait for a yes.
3. Set it In Progress when you start and In Review when the work is done and
   checked. Never set Done yourself. Write what happened in the issue.
4. Big work gets a main issue with sub-issues, labelled. The main issue isn't
   In Review until all its sub-issues are.
5. After the work is finished and moved into In review, commit. Put the key in the commit subject, e.g. `(MXN-151)`.

## Git

- Commit only when asked. Stage files by name, not `git add -A`.
- Don't skip hooks, force-push, or amend pushed commits.
