# moxen

`moxen` drives provider CLIs directly from your terminal: a full interactive TUI for working with threads, plus a scriptable CLI for handovers, thread inspection, messaging, and automation. Threads, projects, and orchestration live in a local store (`~/.moxen`), and turns run against `claude`, `codex app-server` or `opencode serve` through their own logins.

## Requirements

Bun (it manages packages and runs everything) and at least one provider CLI: `claude` (`claude auth login`), `codex` 0.164.0 or newer (`codex login`), or `opencode` v2 or newer (`opencode auth login`, including `openai` for ChatGPT and `xai` for SuperGrok, or provider API keys).

## Install

### From a release

One line on macOS (Apple silicon):

```bash
curl -fsSL https://github.com/usemoxen/moxen/releases/latest/download/install.sh | sh
```

One line on Windows (x64, PowerShell):

```powershell
irm https://github.com/usemoxen/moxen/releases/latest/download/install.ps1 | iex
```

Either script fetches the latest release's archive, installs Bun first when it
is missing, checks the archive against its `.sha256` and refuses a mismatch,
then runs `self-update --install` and puts Moxen on your PATH: on macOS it
appends a marker-guarded `export PATH` snippet to your shell profile (zsh:
`~/.zshrc`, bash: `~/.bash_profile`), added once and never duplicated; on Windows it
adds the folder to your user PATH. Set `MOXEN_INSTALL_NO_PATH=1` to skip that
step. New terminals pick it up.
Linux and Intel Macs have no build yet. The one-liners download the scripts
from the release itself, so they work from the next release on; until then,
follow the by-hand steps below.

Each tagged release on [GitHub Releases](https://github.com/usemoxen/moxen/releases)
carries the same steps in its notes, and holds an archive per
platform, `moxen-<version>-macos-arm64.tar.gz` or `moxen-<version>-windows-x64.zip`, and a `.sha256` file
beside it. Bun is the only thing you need installed: the archive holds the bundle and its native library.

```bash
tar -xzf moxen-<version>-macos-arm64.tar.gz     # Windows: tar -xf moxen-<version>-windows-x64.zip
bun moxen-<version>-macos-arm64/dist/cli/index.js self-update --install
```

Check the download against its `.sha256` first (`shasum -a 256 -c <file>.sha256` on macOS; on Windows compare
`Get-FileHash` with the file's contents). `self-update --install` copies the release to
`~/.moxen/app/versions/<version>/`, records it in `~/.moxen/app/current`, writes a `moxen` launcher (`moxen.cmd` on
Windows) in `~/.moxen/app/bin`, and prints how to put that folder on your PATH. It edits no shell profile (the
one-line installers above do that step for you). Run
it again any time: an installed version is left as it is. After that you can delete the unpacked folder, and `moxen`
starts the version `current` names. The builds are not signed or notarized.

To update an installed Moxen, run `moxen self-update`: it downloads the latest release, verifies its checksum, starts
it once to be sure it works, and only then switches to it. `moxen self-update --rollback` goes back to the version
before. Running threads keep their version until the moxen server restarts; the update restarts nothing.
`moxen self-update --check` only looks. The same is in the TUI: **Update Moxen** in the command palette.

### From a checkout

```bash
git clone https://github.com/usemoxen/moxen.git
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

Bare `moxen` opens the TUI too; `moxen --help` opens help, and anything else
after `moxen` is a CLI command with args (see below). Without an interactive
terminal, bare `moxen` prints help plus a hint instead of launching.

Opens the interactive client: sidebar with your threads, the live transcript with per-turn diffs,
and a composer with model/effort pickers, image attachments, and an external-editor shortcut.
The first-run guide covers appearance, models, memory and MCP tools. Reopen **Getting started**
or browse **What's new** from the command palette; see [the guide](docs/getting-started.md).
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
