/**
 * Bad records readers skip. One corrupt `thread.json`, one bad ledger
 * line, one bad `delegations.jsonl` line, a turn with a status no build
 * writes, a running turn no process owns: readers skip what they can't
 * read and report it here — with its location — so the server can warn
 * with fix options instead of failing the whole read. Nothing is deleted
 * or rewritten unless the user picks a fix.
 */
export type StoreProblemKind =
  | "thread-record"
  | "ledger-line"
  | "delegation-line"
  | "turn-status"
  | "turn-ownerless";

export interface StoreProblem {
  /** Stable across polls, so a client can track and dismiss one: kind, file, line and turn. */
  readonly id: string;
  readonly kind: StoreProblemKind;
  readonly threadId?: string;
  readonly turnId?: string;
  /** Absolute path of the file holding the bad record. */
  readonly file: string;
  /** 1-based line number, for ledger and delegation lines. */
  readonly line?: number;
  /** One sentence saying what is wrong and what still works without it. */
  readonly message: string;
}

export function storeProblemId(problem: Omit<StoreProblem, "id" | "message">): string {
  return [problem.kind, problem.file, problem.line ?? "", problem.threadId ?? "", problem.turnId ?? ""].join("|");
}
