/**
 * Bare `moxen` (no command) opens the TUI: `moxen` behaves like `moxen tui`.
 * Without an interactive terminal there is nothing to open, so it prints help
 * plus a hint instead of launching. `moxen tui` itself is untouched.
 */

/** Global options that take a value: bare means nothing but these (and `--json`) was given. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--config", "--server"]);

/**
 * Whether these CLI arguments hold no command: only global options (and their
 * values). Anything else — a command, `--help`/`--version`, an unknown flag —
 * is left for commander to run or refuse as it does today.
 */
export function isBareInvocation(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return index === args.length - 1;
    if (arg === "--json") continue;
    if (VALUE_OPTIONS.has(arg)) {
      // A value must follow; without one commander reports the missing value, not the TUI.
      if (index + 1 >= args.length) return false;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=") || arg.startsWith("--server=")) continue;
    return false;
  }
  return true;
}

export type BareDecision =
  | { readonly kind: "tui"; readonly argv: readonly string[] }
  | { readonly kind: "help" }
  | { readonly kind: "passthrough" };

/** Without a terminal to open in, bare `moxen` says this after the help. */
export const BARE_NO_TTY_HINT =
  "moxen opens its terminal UI, which needs an interactive terminal. Run `moxen tui` in a terminal, or `moxen --help` for the scriptable commands.";

/**
 * How to run these CLI arguments. `tui` carries the arguments with `tui`
 * last, so commander's global options (`--server`, `--config`, `--json`)
 * parse exactly as in `moxen --server <name> tui`.
 */
export function decideBareInvocation(args: readonly string[], stdoutTTY: boolean): BareDecision {
  if (!isBareInvocation(args)) return { kind: "passthrough" };
  if (stdoutTTY) return { kind: "tui", argv: [...args, "tui"] };
  return { kind: "help" };
}
