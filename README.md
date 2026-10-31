# moxen

`moxen` drives provider CLIs directly from your terminal: a full interactive TUI for working with threads, plus a scriptable CLI for handovers, thread inspection, messaging, and automation. Threads, projects, and orchestration live in a local store (`~/.moxen`), and turns run against `claude`, `codex app-server` or `opencode serve` through their own logins.

## Requirements

Bun (it manages packages and runs everything) and at least one provider CLI: `claude` (`claude auth login`), `codex` 0.164.0 or newer (`codex login`), or `opencode` v2 or newer (`opencode auth login`, including `openai` for ChatGPT and `xai` for SuperGrok, or provider API keys).

## Install

```bash
git clone https://github.com/arrrnmp/moxen.git
cd moxen
bun install
```

Build the bundle once, and again after pulling changes (it takes a second or two):

```bash
bun run build
```

Then point a `moxen` command at `dist/`, from any working directory, with nothing to put on PATH.

macOS/Linux (bash/zsh) — add to your shell profile (`~/.bashrc`, `~/.zshrc`, ...):

```bash
moxen() { bun "/absolute/path/to/moxen/dist/cli/index.js" "$@"; }
```

Windows (PowerShell) — add to your `$PROFILE`:

```powershell
function moxen { bun "C:\absolute\path\to\moxen\dist\cli\index.js" @args }
```

Reload the shell, then verify:

```bash
moxen --json doctor
```

Every example below assumes `moxen` resolves that way. This package is not published
(`private: true`), so install it by cloning.

## Terminal UI

```bash
moxen tui
```

Opens the interactive client: sidebar with your threads, the live transcript with per-turn diffs,
and a composer with model/effort pickers, image attachments, and an external-editor shortcut.
Clicking a user prompt opens message actions (copy, revert); clicking a diff-turn header jumps
the transcript to that turn; the command palette covers copy/thread/jump actions.

| Keys | Action |
| --- | --- |
| `enter` | Send (composer) / confirm (close menu) |
| `shift+enter`, `ctrl+j` | Newline in the composer |
| `esc` | Unfocus composer / close diff / cancel menus |
| `ctrl+c` | Clear prompt → close menu → quit (empty prompt jumps straight to the menu) |
| `ctrl+t` | Toggle tasks panel |
| `ctrl+p` | Command palette |
| `ctrl+o`, `alt+e` | Edit the draft in `$VISUAL` / `$EDITOR` |
| `ctrl+v`, `cmd+v` | Paste an image from the clipboard |
| `i` | Focus the composer |
| `s`, `[`, `]` | Sidebar mode / cycle project |
| `arrows`, `pgup/pgdn` | Scroll the focused pane |

The UI needs at least a 180×47 terminal (btop-style): below that it shows a
resize notice instead of a broken layout, and resumes live when you grow it
back. Resizes are followed over SSH too.

## CLI

The same binary scripts everything the TUI does, with stable `--json` envelopes for automation:

```bash
moxen handover --prompt "Continue the implementation from this handover."
moxen threads list --status active --cwd .
moxen threads send --thread <thread-id> --prompt "Run the morning check."
```

Full reference: [`docs/cli.md`](docs/cli.md). How it runs under the hood:
[`docs/overview.md`](docs/overview.md), [`docs/threads.md`](docs/threads.md),
[`docs/providers.md`](docs/providers.md).

## Security

There are no bearer tokens anywhere in this stack: provider CLIs own their own logins, and this CLI never reads their secrets — it only observes credential *presence* for status display. Threads live as local JSONL under `~/.moxen` (override with `MOXEN_STORE_ROOT`).

## License

AGPL-3.0-only. See [LICENSE](LICENSE). The tree-sitter grammars under
`src/core/syntax/` are attributed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
