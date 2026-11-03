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
- For visual changes, use the render harness and inspect the result to verify
  how it looks.
- If you change behavior a doc describes, update the doc.

## Cross-platform

Moxen runs on Windows and macOS, and nothing you write may assume either. Never
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

All work has a Linear issue (team Moxen, `MXN-n`, project Moxen Agent).

- Search for an existing issue first. If there is none, show the user the issue
  you'd create (title, labels, description) and wait for a yes.
- The user writes the main issue and its title is the subject of the work.
  Don't rewrite that subject. A small edit is fine when the scope moved a
  little and the subject stays the same: a typo, a word, a clarified qualifier.
  A different subject means a different issue, so leave the title alone and
  split the work instead. Turning "A lion and a horse" into something else is
  not an edit.
- When the work outgrows the issue, add sub-issues under it rather than
  widening the parent. One piece of work each, in order, same labels. The main
  issue is not In Review until all of its sub-issues are.
- Set the issue In Progress when you start and In Review when the work is done
  and checked. Never set Done yourself: the user moves issues to Done, and may
  ask you to do it for them.
- Every issue says which model works on it, by name and effort:
  - When you set it In Progress, comment `<model> (<effort>) is picking up
    this work.`, for example `GPT-6.1-Sol (Medium) is picking up this work.`
  - When you set it In Review, end your progress comment with a footer line of
    its own: `Work done by <model> (<effort>).`
- Follow the format the team already uses:
  - Title: `<area>: <what it does>`, lowercase after the colon, for example
    `tui: image viewer pan, zoom and stepping through a set`, or
    `core+tui: ...` when more than one area is involved. Keep the user's own
    words when they wrote the issue; add the area, don't rename.
  - Labels: one type (`Feature`, `Improvement`, `Bug`) plus every area that
    applies (`TUI`, `Desktop`, `Cleanup`, `macOS`, `Windows`). Label
    sub-issues the same way.
  - Description: the problem in prose, then optional `## Design`,
    `## Out of scope` and `## Open` sections. Link related issues, and start a
    sub-issue with "Part of MXN-n".
- The description may grow to explain the core problem in more depth. It does
  not hold progress, and it does not explain what the sub-issues did.
- Put progress in a comment on the issue, or on the sub-issue where it
  happened: what changed, what was checked, what wasn't, what is left. Status
  updates never go in the description.
- After the work is finished and moved to In Review, commit. Put the key in the
  commit subject, e.g. `(MXN-151)`.

## Git

- Stage files by name, not `git add -A`.
- Don't skip hooks, force-push, or amend pushed commits.
