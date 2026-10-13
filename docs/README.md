# Moxen documentation

- [Overview](overview.md) — what Moxen is, its concepts, and how it runs.
- [Threads and turns](threads.md) — the turn lifecycle, the activity ledger, steering, background work, revert.
- [Providers](providers.md) — the four providers, how they authenticate, defaults, and per-provider gaps.
- [CLI reference](cli.md) — every command, flag, setting, and output shape.
- [Contributing](contributing.md) — working on Moxen: layout, workflow, conventions, boundaries, tests.

Reference material we check behavior against lives in [external/](external/):
mirrors of the Claude Code and OpenCode v2 docs, refreshed with
`bun run update:docs` (`claude` / `opencode`, `--dry-run`, `--prune`).
`git diff docs` after a run is the changelog. They are behavior references,
not Moxen documentation.
