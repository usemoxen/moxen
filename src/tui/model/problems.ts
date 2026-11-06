import type { QueryResult } from "../../server/protocol.js";

type StoreProblem = QueryResult<"store.problems">["problems"][number];
type ConfigProblem = QueryResult<"config.read">["problems"][number];

/**
 * One bad record as the warning shows it: what is wrong, where it is, and
 * which fix fits. Store problems carry their location; config problems
 * carry the entry's path in the file (values never cross the boundary —
 * they may be secrets).
 */
export interface ProblemRow {
  readonly key: string;
  readonly kind: StoreProblem["kind"] | "config";
  readonly message: string;
  /** A ledger's `file:line`, a record's file, or a config entry's path. */
  readonly location: string;
  /** The text `Copy path` takes. */
  readonly copyText: string;
  /** `store.quarantine` target, for records a move-aside repairs. */
  readonly quarantineId?: string;
  /** `settings.set` key an empty value resets, for entries a reset repairs. */
  readonly resetKey?: string;
  /** `thread.turn.interrupt` target, for turns a stop clears. */
  readonly stop?: { threadId: string; turnId: string };
}

/**
 * The settings key an empty value resets for a skipped config entry: a
 * scalar or section field is its own path, an MCP server is addressed by
 * name, a profile by id. An entry that does not even name itself (a
 * profile without id) has no key: only the file helps.
 */
export function configResetKey(path: string): string | null {
  const mcp = /^mcpServers\.([A-Za-z0-9_-]+)$/.exec(path);
  if (mcp) return `mcpServers[${mcp[1]}]`;
  const profile = /^providers\.harness\.profiles\[([^\]]+)\]$/.exec(path);
  if (profile) {
    // An index, not an id: the entry never parsed, so no key addresses it.
    if (/^\d+$/.test(profile[1]!)) return null;
    return path;
  }
  if (/^providers\.harness\.profiles$/.test(path)) return null;
  if (/^providers(\.|$)|^mcpServers$/.test(path)) return null;
  return path;
}

export function problemRows(
  store: readonly StoreProblem[],
  configPath: string,
  configProblems: readonly ConfigProblem[],
): ProblemRow[] {
  const rows: ProblemRow[] = store.map((problem) => ({
    key: problem.id,
    kind: problem.kind,
    message: problem.message,
    location: problem.line === undefined ? problem.file : `${problem.file}:${problem.line}`,
    copyText: problem.file,
    ...(problem.kind === "turn-status" || problem.kind === "turn-ownerless"
      ? { stop: { threadId: problem.threadId!, turnId: problem.turnId! } }
      : { quarantineId: problem.id }),
  }));
  for (const problem of configProblems) {
    const resetKey = configResetKey(problem.path);
    rows.push({
      key: `config:${problem.path}`,
      kind: "config",
      message: problem.message,
      location: problem.path,
      copyText: configPath,
      ...(resetKey === null ? {} : { resetKey }),
    });
  }
  return rows;
}
