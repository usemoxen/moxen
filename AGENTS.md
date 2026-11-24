# AGENTS.md

Moxen is a terminal UI and CLI for coding-agent threads. Rules shared across
every Moxen repo live in `AGENTS.base.md` in the private `usemoxen/home` repo
(`~/moxen/home`); this file adds the rules specific to Moxen. Deeper
architecture and conventions live in `docs/`. Read `docs/contributing.md`
before changing code.

Keep this file under 200 lines and 10,000 characters.

## How to work

Start by checking `git status`. The working tree may hold someone else's
changes, so never revert, stash, or commit files you didn't touch. Match the
code around you, look for an existing helper before writing a new one, and
update any doc whose described behavior you change.

### Architecture and safety

- Respect the layering: core, then the server boundary, then the clients. New
  frontend surface belongs in the server, never in a client. The layering test
  enforces this.
- Settings live in one table. Add new settings there, not in a client.
- Keep CLI `--json` output backward compatible. Change a golden only on
  purpose, and say so.
- Never print a credential or write one to a file, and never build shell
  commands by joining strings.
- Never invoke bare `moxen`: it opens the interactive TUI. Always pass an
  explicit command (`moxen --help` for help, or a CLI subcommand).
- Write tests to pin a bug, a contract, or an invariant, not for coverage.

### Provider and platform terms

When making changes, respect the terms of service, consumer terms, usage
terms, and API or SDK policies of every provider and platform Moxen works
with, including Anthropic (Claude, Claude Code, Claude Agent SDK), OpenAI
(ChatGPT, Codex), Google (Gemini, Antigravity), Anomaly (OpenCode), and any
other upstream service. Don't build features, auth flows, delegation or
orchestration paths, or workarounds that violate consumer plan restrictions,
bypass official interfaces or usage limits, spoof clients, or circumvent
access controls. When you're unsure whether an integration pattern is allowed
(such as consumer login vs. API key, third-party harnesses, or multi-account
and orchestration use), check the provider's current terms and official
guidance before implementing it.

Exception: Antigravity delegation and automatic prompts may exist as a setting
that is off by default and warns that Google doesn't support it on consumer
plans. Never turn it on for the user.

### UI and the design system

For visual changes, use the render harness and inspect the result to verify
how it looks.

Desktop UI uses the design system in `usemoxen/design-system`, a private repo.
Only its public files (tokens, bundle, logos) are copied to
`src/desktop/design-system/`, pinned to a commit and updated by a sync script,
never by hand or as a submodule. Use its tokens and components instead of
hand-copied values. Its docs, component READMEs, and mockups are private and
must never be committed; the sync script fetches them locally into the
git-ignored `src/desktop/design-system/.private/` (Agent's desktop rules are
in `.private/docs/agent-desktop.md`, and mockups are in
`.private/mockups/agent-desktop/`).

### Delegated threads

Settle a delegated subthread once it's no longer needed: when its work is
merged, its report has been used, or it was superseded or stopped. Remove its
worktree when settling unless the branch still holds unmerged work, and don't
settle a thread that is running or still has work you plan to act on.

## Cross-platform

Moxen runs on Windows and macOS, and nothing you write may assume either.
Never hardcode a path style, separator, home variable, shell, newline, or
timing; follow the checklist in `docs/contributing.md`. If you can't run on a
platform yourself, reason about how your change behaves there and say what you
couldn't verify.

## Done means

- The project's full check passes (`bun run check`), and you say what you
  didn't run.
- CI passes completely. Whatever jobs CI runs today or later, a red job is a
  real failure: don't rerun it and hope, don't call the work done, fix it.
- When asked to push, push, watch the CI run to the end, and report the result
  of every job.

## Linear

All work has a Linear issue (team Moxen, `MXN-n`, project Moxen Agent).

Search for an existing issue first. If there isn't one, show the user the
issue you'd create (title, labels, description) and wait for a yes. In
Orchestrate mode, you may file issues and sub-issues directly without waiting
when the work is clearly wanted (bugs you or your workers find, review
findings, and steps of a plan the user approved), as long as you still search
first, follow every rule below, and say in your reply what you filed. A new
product direction or a change of scope still needs a yes.

Assign every issue and sub-issue to `@me`, set a priority other than
`No priority`, and fill in Linear's size estimate field.

### Scope and formatting

- The user writes the main issue and its title defines the subject of the
  work; don't rewrite that subject. A small edit is fine when the scope moved
  a little and the subject stays the same (a typo, a word, a clarified
  qualifier), but a different subject means a different issue: leave the title
  alone and split the work instead. Turning "A lion and a horse" into
  something else is not an edit.
- When work outgrows an issue, add ordered sub-issues under it rather than
  widening the parent, one piece of work each, with the same labels. Don't
  move the parent to In Review until all of its sub-issues are In Review.
- Format titles as `<area>: <what it does>`, lowercase after the colon (for
  example `tui: image viewer pan, zoom and stepping through a set`, or
  `core+tui: ...` when more than one area is involved). Keep the user's own
  words when they wrote the issue; add the area, don't rename.
- Give every issue and sub-issue (including archived issues) exactly one type
  label (`Feature`, `Improvement`, or `Bug`) and all applicable area labels.
  Reuse existing labels first; create a label only when none fits, and make it
  general enough to reuse across issues.
- Write descriptions with the problem in prose, followed by optional
  `## Design`, `## Out of scope`, and `## Open` sections. Link related issues,
  and start every sub-issue with "Part of MXN-n". A description may grow to
  explain the core problem in more depth, but never put progress, status
  updates, or summaries of what sub-issues did in it.

### Lifecycle and attribution

Set the issue In Progress when you start and In Review when the work is done
and checked. Never set Done yourself: the user moves issues to Done, and may
ask you to do it for them.

Put progress in a comment on the issue (or on the sub-issue where it happened):
what changed, what was checked, what wasn't, and what is left. Every issue
also names the model and effort working on it:

- When you set it In Progress, comment `<model> (<effort>) is picking up this
  work.`, for example `GPT-6.1-Sol (Medium) is picking up this work.`
- When you set it In Review, end your progress comment with a footer line of
  its own: `Work done by <model> (<effort>).`

After the work is finished and moved to In Review, commit and include the
issue key in the commit subject, e.g. `(MXN-151)`.

## Git

Stage files by name, not `git add -A`. Don't skip hooks, force-push, or amend
pushed commits.
