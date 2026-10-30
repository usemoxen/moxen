/**
 * The shells a machine has, and the part of the runtime instructions that
 * tells a session how to write commands for them (`instructions.ts`).
 *
 * Shell commands are where agents burn the most retries: bash written for
 * zsh (a pattern that matches nothing is an error there, not text passed on),
 * GNU `sed` flags on the BSD ones macOS ships, a heredoc in fish, or `&&` in
 * Windows PowerShell 5.1. Which of those bites depends on the machine the
 * session runs on, so the section is built from what is actually there
 * instead of one fixed text that is wrong somewhere: the login shell
 * (`SHELL`), the shells found on `PATH`, and the platform's tool flavour.
 *
 * The text differs per machine, and that is safe: a conversation's
 * instructions are frozen when it begins (`planInstructions`), so the
 * prompt's prefix stays cached.
 */
import { resolveOnPath } from "../infra/process.js";

/** The shells worth mentioning: everything a `bash`-style or PowerShell command can land in. */
export type ShellKind = "zsh" | "bash" | "fish" | "nu" | "sh" | "pwsh" | "powershell" | "cmd";

export interface ShellDetection {
  readonly platform: NodeJS.Platform;
  /** The shells this machine has, the login shell first; empty when none is on `PATH`. */
  readonly shells: readonly ShellKind[];
  /** The shell `SHELL` names, when it names one we know: the one a session's commands usually land in. */
  readonly login: ShellKind | null;
}

export interface ShellLookup {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Whether a program name is on `PATH`; `resolveOnPath` by default. */
  readonly exists?: (name: string) => boolean;
}

/** What each shell is looked up as, in the order the text names them. */
const CANDIDATES: readonly { readonly kind: ShellKind; readonly exe: string }[] = [
  { kind: "zsh", exe: "zsh" },
  { kind: "bash", exe: "bash" },
  { kind: "fish", exe: "fish" },
  { kind: "nu", exe: "nu" },
  { kind: "sh", exe: "sh" },
  { kind: "pwsh", exe: "pwsh" },
  { kind: "powershell", exe: "powershell" },
  { kind: "cmd", exe: "cmd" },
];

/** `SHELL` names a program, with either path separator; map it to the shell it is, when it is one we know. */
function loginShell(env: NodeJS.ProcessEnv): ShellKind | null {
  const raw = env.SHELL;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const base = raw.trim().split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  return CANDIDATES.find((candidate) => candidate.kind === base)?.kind ?? null;
}

/** The shells this machine has, looked up on `PATH` with `SHELL` first. */
export function detectShells(lookup: ShellLookup = {}): ShellDetection {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? ((name: string) => resolveOnPath(name, env) !== null);
  const found = CANDIDATES.filter((candidate) => exists(candidate.exe)).map((candidate) => candidate.kind);
  const login = loginShell(env);
  return { platform, shells: login === null ? found : [login, ...found.filter((kind) => kind !== login)], login };
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  netbsd: "NetBSD",
  sunos: "SunOS",
  aix: "AIX",
};

/** What a command written for one shell must respect that the others do not. */
const SHELL_NOTES: Readonly<Record<ShellKind, string>> = {
  zsh: "zsh: a glob that matches nothing is an error (`no matches found: --include=*.ts`), not text passed on; write `--include='*.ts'`, `find . -name '*.ts'`, `git log -- 'src/*.ts'`. Unquoted variables do not split into words, and arrays count from 1.",
  bash: "bash: unquoted variables split into words, arrays count from 0, and `echo` does not expand `\\n`; use `printf '%s\\n' \"$text\"` for anything exact.",
  fish: "fish is not POSIX: `set -x NAME value` instead of `export NAME=value`, `$status` instead of `$?`, `(cmd)` or `$(cmd)` for substitution, `end` instead of `fi`, `done` or `}`, no heredocs and no `!!`.",
  nu: "nu (Nushell) is not POSIX either: `let`, `where` and `each` are its own language, and `^name` runs an external program that a builtin shadows.",
  sh: "sh is POSIX only: no arrays, no `[[ ]]` and no `local`; use `[ ]` and `$(...)`.",
  pwsh: "pwsh (PowerShell 7): `&&` and `||` work. Single quotes are literal, so write patterns and paths in them; `~` is not expanded in arguments to external programs, and native commands get each argument as given, so quote paths with spaces.",
  powershell: "powershell (Windows PowerShell 5.1) has no `&&` or `||`: chain commands with `;` and check `$LASTEXITCODE`. Single quotes are literal; `~` is not expanded in arguments to external programs.",
  cmd: "cmd.exe: `&&` and `||` work, variables are `%NAME%` set with `set NAME=value`, there is no `$HOME`, and `~` is not expanded.",
};

/** The command-line tools a platform ships: the flags that differ are what most retries are about. */
function toolsNote(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "The command-line tools are the BSD ones macOS ships: `sed -i '' 's/a/b/' file` (GNU takes no argument after -i), no `\\+`, `\\|` or `\\n` in a sed pattern or replacement (use `sed -E`, a real newline or `tr`), no `grep -P` (use `grep -E`), and no `date -d`, `stat -c` or `xargs -r`.";
  }
  if (platform === "win32") {
    return "Outside Git Bash, Windows has none of the POSIX tools: no `sed`, `grep`, `find`, `ls`, `cat` or `/tmp`. Use the read, glob and grep tools for files and the platform's own programs for the rest.";
  }
  if (platform === "linux") {
    return "The command-line tools are GNU (sed, grep, findutils), so the flags BSD lacks exist here; the portable ones still read better where both matter.";
  }
  return "The flags of sed, grep and find differ from the GNU ones on this platform: check what is installed before relying on a GNU-only flag.";
}

/**
 * The shell a command lands in on Windows depends on the harness, which here
 * means the tool it hands the model: Claude Code's is Git Bash, OpenCode's is
 * PowerShell, and the Moxen Harness offers both.
 */
function windowsShellNote(harness: string): string {
  if (harness === "Claude Code") return "On Windows Claude Code runs your commands in Git Bash: write for bash there, not for PowerShell.";
  if (harness === "OpenCode") return "On Windows OpenCode runs your commands in PowerShell: write for PowerShell there, not for bash.";
  return "On Windows your harness offers bash (Git Bash) and powershell as separate tools: write each command for the shell you call it in, never for the other.";
}

/** "a, b and c": the list as prose. */
function joinNames(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The shell section: which shells this machine runs commands in, and what a
 * command must respect for each. `harness` decides which one a command lands
 * in on Windows, where there is no single default.
 */
export function buildShellGuidance(input: ShellDetection & { readonly harness: string }): string {
  const platform = PLATFORM_NAMES[input.platform] ?? input.platform;
  const names = input.shells;
  const listed =
    names.length === 0 ? "" : ` Its shells are ${joinNames(names.map((kind) => (kind === input.login ? `${kind} (the login shell)` : kind)))}.`;
  const header =
    `Commands you run go through the user's own shell, not Moxen's. This machine runs ${platform}.${listed} ` +
    "Most failed commands are syntax written for another shell or OS, so write for the lowest common denominator and read the error before a retry:";
  const bullets = [
    "Quote paths that contain spaces. Prefer absolute paths to `cd`, so a command does not depend on where an earlier one left the shell; and do not prepend `cd <the directory you are in>` to a git command, which already works there.",
    "To change a file, use the edit tool rather than sed, and to search it, use grep or glob rather than the shell's: those are the default, not a rule. When the shell expresses the job better — a negated or multi-line match, `jq` on structured data, one pipeline answering across many files, or one mechanical change across all of them — use it, with whatever this machine has.",
  ];
  if (names.includes("bash")) {
    bullets.push("If you are not sure of the shell, or the command has a loop, a condition, a variable or a heredoc, hand it to bash explicitly: `bash -c '...'`, or for several lines `bash <<'EOF'`. A quoted heredoc delimiter (`<<'EOF'`) switches every expansion off, which makes it the safe way to pass code, JSON or text with quotes and `$` in it.");
  }
  if (input.platform === "win32") bullets.push(windowsShellNote(input.harness));
  for (const kind of names) bullets.push(SHELL_NOTES[kind]);
  return [header, bullets.map((line) => `- ${line}`).join("\n"), toolsNote(input.platform)].join("\n\n");
}
