/**
 * What changes when this code runs from a `bun build --compile` standalone
 * executable instead of from Bun: the bundle's own folder is the folder
 * holding the executable (beside it travel the exe's support files), and
 * child processes that used to be `bun <entry>` become the executable
 * itself, re-run with an internal first argument.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Whether this process is a compiled executable, not `bun <file>`. Prefers
 * the official API when the running Bun has it; older Bun answers through
 * the entry's path, which points inside the binary.
 */
export function isStandaloneExecutable(): boolean {
  const official = (globalThis as { Bun?: { isStandaloneExecutable?: unknown } }).Bun?.isStandaloneExecutable;
  if (typeof official === "boolean") return official;
  // A compiled binary runs as `bun <$bunfs entry> <args>`; `bun <file>`
  // names a file on the disk instead. Verified on Bun 1.3.11 (macOS);
  // Windows names the same root `B:\~BUN\...`, the prefix OpenTUI detects.
  const entry = process.argv[1] ?? "";
  return entry.includes("$bunfs") || /^[A-Za-z]:[\\/]~BUN/i.test(entry);
}

/**
 * The executable's own first arguments, one per internal mode. A child
 * process is the same binary re-run with one of these: the daemon a client
 * autostarts, the MCP server a provider session launches, and the embedding
 * worker the server owns. Each is a single argument so the mode's own
 * argument parsing (`process.argv.slice(2)`) keeps working.
 */
export const STANDALONE_DAEMON_ARG = "--moxen-internal-daemon";
export const STANDALONE_MCP_ARG = "--moxen-internal-mcp";
export const STANDALONE_EMBEDDING_ARG = "--moxen-internal-embedding";

export type StandaloneMode = "daemon" | "mcp" | "embedding";

/** Which internal mode `argv` asks for, or null for the plain CLI. */
export function standaloneMode(argv: readonly string[] = process.argv): StandaloneMode | null {
  // A compiled binary runs as `bun <$bunfs entry> <args>`, like `bun <file> <args>`: user flags start at [2].
  const flag = argv[2];
  if (flag === STANDALONE_DAEMON_ARG) return "daemon";
  if (flag === STANDALONE_MCP_ARG) return "mcp";
  if (flag === STANDALONE_EMBEDDING_ARG) return "embedding";
  return null;
}

/**
 * The folder an install lives in: the folder holding the executable when
 * standalone (where `import.meta` points at `$bunfs`, not the disk), else
 * the folder above `from` that holds `package.json`. Null when neither
 * holds one. `execDir` and `standalone` are injected in tests.
 */
export function resolveAppRoot(from: string, execDir: string = path.dirname(process.execPath), standalone: boolean = isStandaloneExecutable()): string | null {
  if (standalone) return existsSync(path.join(execDir, "package.json")) ? execDir : null;
  let folder = from;
  while (!existsSync(path.join(folder, "package.json"))) {
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return folder;
}
