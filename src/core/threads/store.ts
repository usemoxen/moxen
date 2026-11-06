/**
 * JSONL thread store: per-thread directories with one `thread.json`
 * record plus append-only `turns/messages/activity/checkpoints` ledgers,
 * and a root-level `delegations.jsonl`.
 *
 * All mutations for a thread are serialized through a per-thread
 * promise-chain mutex (the enforceable replacement for a racy
 * dispatch-then-poll preflights: one active turn per session). Record
 * writes are atomic (tmp file + rename). Zero new dependencies.
 * See docs/threads.md.
 */
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renameReplacing } from "../infra/atomic.js";
import { appEnv, appHomeDir } from "../config.js";
import { CliError } from "../errors.js";
import type { EventBus } from "../events/bus.js";
import { createEventBus } from "../events/bus.js";
import type { BackendEvent } from "../events/bus.js";
import { decodeDataUrl, imageExtension, type ImageAttachmentUpload } from "../attachments.js";
import { storedInteractionMode } from "../interactionmode.js";
import type {
  StoredActivity,
  StoredAttachment,
  StoredCheckpoint,
  StoredDelegation,
  StoredMessage,
  StoredThread,
  StoredTurn,
} from "./types.js";
import { type StoreProblem, storeProblemId } from "./problems.js";

export interface ThreadStoreOptions {
  readonly bus?: EventBus<BackendEvent>;
  /** Milliseconds since epoch; injectable for tests. */
  readonly clock?: () => number;
}

/** Home of the JSONL thread store + the projects registry. */
export function resolveStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = appEnv("STORE_ROOT", env)?.trim();
  if (raw) return path.resolve(raw);
  return path.join(appHomeDir(), "threads");
}

type LedgerName = "turns" | "messages" | "activity" | "checkpoints";

function ledgerFile(root: string, threadId: string, name: LedgerName): string {
  return path.join(root, "threads", threadId, `${name}.jsonl`);
}

function parseLedgerLine<T>(line: string, file: string, lineNumber: number): { value: T } | { problem: Omit<StoreProblem, "id"> } {
  try {
    return { value: JSON.parse(line) as T };
  } catch {
    return {
      problem: {
        kind: "ledger-line",
        file,
        line: lineNumber,
        message: `Line ${lineNumber} of ${file} is not valid JSON and was skipped; the rest of the ledger still loads.`,
      },
    };
  }
}

export class ThreadStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, () => void>();
  private readonly bus: EventBus<BackendEvent>;
  private readonly clock: () => number;
  /** Bad records readers skipped, by stable id: reported once, kept until fixed. */
  private readonly problems = new Map<string, StoreProblem>();

  private constructor(
    private readonly root: string,
    options: ThreadStoreOptions = {},
  ) {
    this.bus = options.bus ?? createEventBus({ bufferSize: 0 });
    this.clock = options.clock ?? Date.now;
  }

  static async open(root: string, options: ThreadStoreOptions = {}): Promise<ThreadStore> {
    await mkdir(path.join(root, "threads"), { recursive: true });
    return new ThreadStore(root, options);
  }

  nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  newId(): string {
    return randomUUID();
  }

  /** Serialize async work per key; concurrent callers queue behind each other. */
  async withThreadLock<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.locks.set(threadId, current);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(threadId) === current) {
        this.locks.delete(threadId);
      }
    }
  }

  emit(threadId: string, reason: string): void {
    this.bus.publish({ type: "backend.thread.changed", threadId, reason });
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }

  /** Bad records readers skipped, oldest first. The same record is never reported twice. */
  storeProblems(): StoreProblem[] {
    return [...this.problems.values()];
  }

  /**
   * Record a skipped bad record. The connection's poll calls this for turn
   * problems it spots while it already holds every turn; readers call it
   * for the records they skip. Returns the stored problem.
   */
  noteProblem(problem: Omit<StoreProblem, "id">): StoreProblem {
    const id = storeProblemId(problem);
    const existing = this.problems.get(id);
    if (existing) return existing;
    const stored: StoreProblem = { ...problem, id };
    this.problems.set(id, stored);
    return stored;
  }

  /**
   * Replace one thread's turn problems (unknown statuses, ownerless running
   * turns) with what its turns show now: a turn that stopped or was fixed
   * clears its own warning.
   */
  replaceTurnProblems(threadId: string, problems: Array<Omit<StoreProblem, "id">>): void {
    for (const [id, problem] of [...this.problems]) {
      if (problem.threadId === threadId && (problem.kind === "turn-status" || problem.kind === "turn-ownerless")) {
        this.problems.delete(id);
      }
    }
    for (const problem of problems) this.noteProblem(problem);
  }

  /** Drop one problem, after its fix (a quarantine, a reset, a stop) landed. */
  dropProblem(id: string): void {
    this.problems.delete(id);
  }

  /** Absolute path of a thread's turns ledger, for problem reports. */
  turnsFile(threadId: string): string {
    return ledgerFile(this.root, threadId, "turns");
  }

  /**
   * Move a reported bad record aside into `<root>/quarantine/` — never
   * deleted — and repair the source: a bad thread record is moved away so
   * the thread reads as missing, a ledger loses only the bad line (the
   * original is kept beside the moved record). Problems resolve from the
   * store's own log by id, so a client can never name an arbitrary path.
   * Turn problems cannot be quarantined: the error names the fix that
   * handles them instead.
   */
  async quarantineProblem(id: string): Promise<{ movedTo: string }> {
    const problem = this.problems.get(id);
    if (!problem) {
      throw new CliError("PROBLEM_NOT_FOUND", `No bad record is reported with id ${id}.`, { details: { id } });
    }
    const stale = (message: string): Error => {
      this.problems.delete(id);
      return new CliError("PROBLEM_STALE", message, { details: { id } });
    };
    const quarantineDir = path.join(this.root, "quarantine");
    const movedName = (base: string): string => path.join(quarantineDir, `${base}-${process.pid}-${Date.now()}`);
    if (problem.kind === "turn-status" || problem.kind === "turn-ownerless") {
      throw new CliError("PROBLEM_NOT_QUARANTINED", `This problem is a stuck turn, not a bad record: stop it with thread.turn.interrupt instead.`, { details: { id } });
    }
    if (problem.kind === "thread-record") {
      const threadId = problem.threadId!;
      return await this.withThreadLock(threadId, async () => {
        let raw: string;
        try {
          raw = await readFile(problem.file, "utf8");
        } catch {
          throw stale(`Thread ${threadId} already reads, so there is nothing to move aside.`);
        }
        try {
          JSON.parse(raw);
          throw stale(`Thread ${threadId} parses now, so there is nothing to move aside.`);
        } catch (error) {
          if (error instanceof CliError) throw error;
          // Still bad: move it aside below.
        }
        await mkdir(quarantineDir, { recursive: true });
        const movedTo = movedName(`${threadId}-thread.json`);
        await renameReplacing(problem.file, movedTo);
        this.problems.delete(id);
        return { movedTo };
      });
    }
    const line = problem.line!;
    const lockId = problem.kind === "delegation-line" ? "!delegations" : problem.threadId!;
    return await this.withThreadLock(lockId, async () => {
      let raw: string;
      try {
        raw = await readFile(problem.file, "utf8");
      } catch {
        throw stale(`The file is already gone, so there is nothing to move aside.`);
      }
      const lines = raw.split("\n");
      const bad = lines[line - 1];
      if (bad === undefined || bad.trim().length === 0) throw stale(`Line ${line} is already gone, so there is nothing to move aside.`);
      try {
        JSON.parse(bad);
        throw stale(`Line ${line} parses now, so there is nothing to move aside.`);
      } catch (error) {
        if (error instanceof CliError) throw error;
        // Still bad: move it aside below.
      }
      await mkdir(quarantineDir, { recursive: true });
      const movedTo = movedName(path.basename(problem.file));
      await writeFile(movedTo, raw, "utf8");
      const kept = [...lines.slice(0, line - 1), ...lines.slice(line)];
      await writeFile(problem.file, kept.join("\n"), "utf8");
      this.problems.delete(id);
      return { movedTo };
    });
  }

  /** Stage 2 drivers register a live run so interrupt can abort it. */
  trackRunning(turnId: string, abort: () => void): void {
    this.aborts.set(turnId, abort);
  }

  /**
   * Take a promoted turn for one runner, or lose it to the one already running
   * it. A turn stays `running` and untracked until `executeTurn` is past its
   * setup, so without this a settling runner and the work queue both start it.
   * `executeTurn` replaces this placeholder with the real abort.
   */
  claimRun(turnId: string): boolean {
    if (this.aborts.has(turnId)) return false;
    this.aborts.set(turnId, () => undefined);
    return true;
  }

  /** Whether a run in this process owns the turn. */
  isTracked(turnId: string): boolean {
    return this.aborts.has(turnId);
  }

  untrackRunning(turnId: string): void {
    this.aborts.delete(turnId);
  }

  abortRunning(turnId: string): boolean {
    const abort = this.aborts.get(turnId);
    if (!abort) return false;
    this.aborts.delete(turnId);
    abort();
    return true;
  }

  private threadDir(threadId: string): string {
    return path.join(this.root, "threads", threadId);
  }

  private threadFile(threadId: string): string {
    return path.join(this.threadDir(threadId), "thread.json");
  }

  async readThreadRecord(threadId: string): Promise<StoredThread | null> {
    const file = this.threadFile(threadId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A record that cannot even be read is skipped like a corrupt one:
      // one bad file must not blank the sidebar.
      this.noteProblem({
        kind: "thread-record",
        threadId,
        file,
        message: `Thread ${threadId} could not be read and is skipped until it is fixed or moved aside.`,
      });
      return null;
    }
    let record: unknown;
    try {
      record = JSON.parse(raw) as unknown;
    } catch {
      // Skipped, not fatal: one corrupt record must not blank the sidebar.
      this.noteProblem({
        kind: "thread-record",
        threadId,
        file,
        message: `Thread ${threadId} could not be parsed and is skipped until it is fixed or moved aside.`,
      });
      return null;
    }
    if (record === null || typeof record !== "object" || (record as { id?: unknown }).id !== threadId) {
      this.noteProblem({
        kind: "thread-record",
        threadId,
        file,
        message: `Thread ${threadId} has an invalid record and is skipped until it is fixed or moved aside.`,
      });
      return null;
    }
    // Fixed by hand since: the warning goes with the bad bytes.
    this.problems.delete(storeProblemId({ kind: "thread-record", threadId, file }));
    // A thread saved in a mode since removed (plan) reads as Build.
    const stored = record as StoredThread;
    const mode = storedInteractionMode((record as { interactionMode?: unknown }).interactionMode);
    return stored.interactionMode === mode ? stored : { ...stored, interactionMode: mode };
  }

  async writeThreadRecord(thread: StoredThread): Promise<void> {
    await mkdir(this.threadDir(thread.id), { recursive: true });
    const file = this.threadFile(thread.id);
    const tmp = `${file}.tmp.${process.pid}.${this.newId()}`;
    await writeFile(tmp, `${JSON.stringify(thread)}\n`, "utf8");
    await renameReplacing(tmp, file);
  }

  /**
   * A token that changes whenever anything stored for the thread does: its
   * record and each ledger, by identity, size and modification time (a write
   * replaces the record's file and appends to or rewrites a ledger, and each
   * moves at least one of them). Cheap — five stats — so a watcher can ask
   * "did anything change?" instead of reading and parsing megabytes of
   * ledger every time it looks.
   */
  async threadVersion(threadId: string): Promise<string> {
    const files = [this.threadFile(threadId), ...(["turns", "messages", "activity", "checkpoints"] as const).map((name) => ledgerFile(this.root, threadId, name))];
    const parts = await Promise.all(
      files.map(async (file) => {
        try {
          const info = await stat(file);
          return `${info.ino}:${info.size}:${info.mtimeMs}`;
        } catch {
          return "-";
        }
      }),
    );
    return parts.join("|");
  }

  /**
   * The thread-list counterpart of `threadVersion`: one token over every
   * thread's record and turns plus the delegations ledger — everything the
   * sidebar's rows are built from — for the price of a stat each.
   */
  async shellVersion(): Promise<string> {
    const statOf = async (file: string): Promise<string> => {
      try {
        const info = await stat(file);
        return `${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch {
        return "-";
      }
    };
    const ids = await this.listThreadIds().catch(() => []);
    const parts = await Promise.all(
      ids.map(async (id) => `${id}=${await statOf(this.threadFile(id))},${await statOf(ledgerFile(this.root, id, "turns"))}`),
    );
    return [await statOf(this.delegationsFile()), ...parts.sort()].join("|");
  }

  async listThreadIds(): Promise<string[]> {
    const entries = await readdir(path.join(this.root, "threads"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  async readLedger<T>(threadId: string, name: LedgerName): Promise<T[]> {
    const file = ledgerFile(this.root, threadId, name);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: T[] = [];
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim().length === 0) continue;
      const parsed = parseLedgerLine<T>(line, file, index + 1);
      if ("value" in parsed) {
        rows.push(parsed.value);
        // Fixed by hand since: the warning goes with the bad bytes.
        this.problems.delete(storeProblemId({ kind: "ledger-line", threadId, file, line: index + 1 }));
      } else this.noteProblem({ ...parsed.problem, threadId });
    }
    return rows;
  }

  /**
   * Save an image sent with a message and describe it. Bytes live under
   * the store root, beside the ledgers that reference them, so a queued
   * turn — possibly run by another process — can still send them, and the
   * transcript can show them.
   */
  async saveAttachment(upload: ImageAttachmentUpload): Promise<StoredAttachment> {
    const decoded = decodeDataUrl(upload.dataUrl);
    if (!decoded) {
      throw new CliError("ATTACHMENT_INVALID", `${upload.name} is not a base64 data URL.`, {
        exitCode: 2,
        details: { name: upload.name },
      });
    }
    const id = this.newId();
    const dir = path.join(this.root, "attachments");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}${imageExtension(decoded.mimeType)}`);
    const bytes = Buffer.from(decoded.data, "base64");
    await writeFile(file, bytes);
    return { type: "image", id, name: upload.name, mimeType: decoded.mimeType, sizeBytes: bytes.length, path: file };
  }

  /** Replace a ledger wholesale (tmp file + rename). Caller holds the thread lock. */
  async rewriteLedger(threadId: string, name: LedgerName, rows: readonly unknown[]): Promise<void> {
    await mkdir(this.threadDir(threadId), { recursive: true });
    const file = ledgerFile(this.root, threadId, name);
    const tmp = `${file}.tmp.${process.pid}.${this.newId()}`;
    await writeFile(tmp, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
    await renameReplacing(tmp, file);
  }

  async appendLedger(threadId: string, name: LedgerName, row: unknown): Promise<void> {
    await mkdir(this.threadDir(threadId), { recursive: true });
    await appendFile(ledgerFile(this.root, threadId, name), `${JSON.stringify(row)}\n`, "utf8");
    if (name === "activity") {
      const activity = row as StoredActivity;
      if (activity.kind === "context-window.updated" && activity.payload) {
        this.bus.publish({ type: "backend.context.updated", threadId, payload: activity.payload });
      }
    }
  }

  async readTurns(threadId: string): Promise<StoredTurn[]> {
    return await this.readLedger<StoredTurn>(threadId, "turns");
  }

  async updateTurn(threadId: string, turnId: string, patch: Partial<StoredTurn>): Promise<StoredTurn | null> {
    const turns = await this.readTurns(threadId);
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return null;
    const updated = { ...turns[index]!, ...patch, id: turnId, threadId };
    const next = [...turns.slice(0, index), updated, ...turns.slice(index + 1)];
    const file = ledgerFile(this.root, threadId, "turns");
    const tmp = `${file}.tmp.${process.pid}.${this.newId()}`;
    await writeFile(tmp, next.map((turn) => JSON.stringify(turn)).join("\n") + "\n", "utf8");
    await renameReplacing(tmp, file);
    return updated;
  }

  async readMessages(threadId: string): Promise<StoredMessage[]> {
    return await this.readLedger<StoredMessage>(threadId, "messages");
  }

  async readActivities(threadId: string): Promise<StoredActivity[]> {
    return await this.readLedger<StoredActivity>(threadId, "activity");
  }

  async readCheckpoints(threadId: string): Promise<StoredCheckpoint[]> {
    return await this.readLedger<StoredCheckpoint>(threadId, "checkpoints");
  }

  private delegationsFile(): string {
    return path.join(this.root, "delegations.jsonl");
  }

  async readDelegations(): Promise<StoredDelegation[]> {
    let raw: string;
    try {
      raw = await readFile(this.delegationsFile(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const file = this.delegationsFile();
    const rows: StoredDelegation[] = [];
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim().length === 0) continue;
      const parsed = parseLedgerLine<StoredDelegation>(line, file, index + 1);
      if ("value" in parsed) {
        rows.push(parsed.value);
        this.problems.delete(storeProblemId({ kind: "delegation-line", file, line: index + 1 }));
      } else this.noteProblem({ ...parsed.problem, kind: "delegation-line", message: `Line ${index + 1} of ${file} is not valid JSON and was skipped; the other tasks still load.` });
    }
    return rows;
  }

  async appendDelegation(delegation: StoredDelegation): Promise<void> {
    await appendFile(this.delegationsFile(), `${JSON.stringify(delegation)}\n`, "utf8");
  }

  async updateDelegation(
    delegationId: string,
    patch: Partial<StoredDelegation>,
  ): Promise<StoredDelegation | null> {
    return await this.withThreadLock("!delegations", async () => {
      const all = await this.readDelegations();
      const index = all.findIndex((delegation) => delegation.id === delegationId);
      if (index < 0) return null;
      const updated: StoredDelegation = {
        ...all[index]!,
        ...patch,
        id: delegationId,
        updatedAt: this.nowIso(),
      };
      const next = [...all.slice(0, index), updated, ...all.slice(index + 1)];
      const file = this.delegationsFile();
      const tmp = `${file}.tmp.${process.pid}.${this.newId()}`;
      await writeFile(tmp, next.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
      await renameReplacing(tmp, file);
      return updated;
    });
  }

  /**
   * Rewrite several delegation rows at once, under one lock and one file
   * replacement: readers see every row before or every row after the patch,
   * never a mixture. A transfer that moved half its rows would leave one
   * parent notified for a task that already reports to the other.
   */
  async updateDelegations(patches: ReadonlyArray<{ readonly id: string; readonly patch: Partial<StoredDelegation> }>): Promise<void> {
    if (patches.length === 0) return;
    const wanted = new Map(patches.map((entry) => [entry.id, entry.patch]));
    await this.withThreadLock("!delegations", async () => {
      const all = await this.readDelegations();
      const next = all.map((delegation) => {
        const patch = wanted.get(delegation.id);
        return patch === undefined ? delegation : { ...delegation, ...patch, id: delegation.id, updatedAt: this.nowIso() };
      });
      const file = this.delegationsFile();
      const tmp = `${file}.tmp.${process.pid}.${this.newId()}`;
      await writeFile(tmp, next.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
      await renameReplacing(tmp, file);
    });
  }
}

export async function openThreadStore(
  root: string,
  options: ThreadStoreOptions = {},
): Promise<ThreadStore> {
  return await ThreadStore.open(root, options);
}
