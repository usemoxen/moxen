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
import { type StoreProblem, isKnownTurnStatus, storeProblemId } from "./problems.js";

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

/**
 * Thread ids are directory names under the store: letters, digits and a
 * few safe characters, never a separator or an escape. Checked at the read
 * boundary, so no caller can reach a path outside the store.
 */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkThreadId(threadId: string): void {
  if (!THREAD_ID.test(threadId)) {
    throw new CliError("INVALID_THREAD_ID", `Invalid thread id: ${JSON.stringify(threadId)}.`, {
      exitCode: 2,
      details: { threadId },
    });
  }
}

function ledgerFile(root: string, threadId: string, name: LedgerName): string {
  checkThreadId(threadId);
  return path.join(root, "threads", threadId, `${name}.jsonl`);
}

function ledgerProblem(kind: "ledger-line" | "delegation-line", file: string, lineNumber: number, validJson: boolean): Omit<StoreProblem, "id"> {
  const what = validJson ? "has no row id" : "is not valid JSON";
  return {
    kind,
    file,
    line: lineNumber,
    message:
      kind === "ledger-line"
        ? `Line ${lineNumber} ${what} and was skipped; the rest of the ledger still loads.`
        : `Line ${lineNumber} ${what} and was skipped; the other tasks still load.`,
  };
}

/** One verdict on a raw ledger line, shared by readers, rewrites and quarantine. */
function classifyLedgerLine(line: string): "row" | "bad-json" | "bad-row" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "bad-json";
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && typeof (parsed as { id?: unknown }).id === "string"
    ? "row"
    : "bad-row";
}

/** Canonical JSON for comparing rows: object keys sorted, so key order never matters. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A row's comparison key: canonical JSON of what `JSON.stringify` would
 * write, so in-memory values JSON drops (`undefined`, functions, symbols)
 * compare as their written form instead of doubling the line.
 */
function canonicalRowKey(row: unknown): string {
  try {
    return canonicalJson(JSON.parse(JSON.stringify(row) ?? "null") as unknown);
  } catch {
    return "";
  }
}

export class ThreadStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, () => void>();
  private readonly bus: EventBus<BackendEvent>;
  private readonly clock: () => number;
  /** Bad records readers skipped, by stable id: reported once, kept until fixed. */
  private readonly problems = new Map<string, StoreProblem>();
  /**
   * A bad final line without a trailing newline may be a torn append — a
   * crash between the bytes and the newline — rather than corruption. It is
   * reported only once it is still there on the next read.
   */
  private readonly pendingTorn = new Map<string, { line: number; raw: string }>();

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
    // Problems resolve from the store's own log by id, so a client can
    // never name an arbitrary path — and the file is still verified to be
    // the expected file inside the store before any rename or write.
    this.assertInsideRoot(problem.file);
    const stale = (message: string): Error => {
      this.problems.delete(id);
      return new CliError("PROBLEM_STALE", message, { details: { id } });
    };
    const quarantineDir = path.join(this.root, "quarantine");
    const movedName = (base: string): string => {
      const movedTo = path.join(quarantineDir, `${base}-${process.pid}-${Date.now()}-${this.newId()}`);
      this.assertInsideRoot(movedTo);
      return movedTo;
    };
    if (problem.kind === "turn-status" || problem.kind === "turn-ownerless") {
      throw new CliError("PROBLEM_NOT_QUARANTINED", `This problem is a stuck turn, not a bad record: stop it with thread.turn.interrupt instead.`, { details: { id } });
    }
    if (problem.kind === "thread-record") {
      const threadId = problem.threadId!;
      checkThreadId(threadId);
      if (problem.file !== this.threadFile(threadId)) {
        throw new CliError("INVALID_STORE_PATH", `Refusing to move an unexpected file aside: ${problem.file}.`, { details: { id } });
      }
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
        const live = (await this.readTurns(threadId)).some((turn) => turn.status === "running" || !isKnownTurnStatus(turn.status) || this.isTracked(turn.id));
        if (live) {
          throw new CliError("THREAD_BUSY", `Thread ${threadId} has a live turn: stop it before moving its record aside.`, {
            exitCode: 4,
            details: { threadId },
          });
        }
        await mkdir(quarantineDir, { recursive: true });
        const movedTo = movedName(`${threadId}-thread.json`);
        await renameReplacing(problem.file, movedTo);
        this.problems.delete(id);
        return { movedTo };
      });
    }
    const line = problem.line!;
    const kind = problem.kind === "delegation-line" ? ("delegation-line" as const) : ("ledger-line" as const);
    if (problem.kind === "delegation-line") {
      if (problem.file !== this.delegationsFile()) {
        throw new CliError("INVALID_STORE_PATH", `Refusing to move an unexpected file aside: ${problem.file}.`, { details: { id } });
      }
    } else {
      const threadId = problem.threadId!;
      checkThreadId(threadId);
      const ledgers = (["turns", "messages", "activity", "checkpoints"] as const).map((name) => ledgerFile(this.root, threadId, name));
      if (!ledgers.includes(problem.file)) {
        throw new CliError("INVALID_STORE_PATH", `Refusing to move an unexpected file aside: ${problem.file}.`, { details: { id } });
      }
    }
    const lockId = problem.kind === "delegation-line" ? "!delegations" : problem.threadId!;
    return await this.withThreadLock(lockId, async () => {
      const current = await this.readRawLedgerLines(problem.file);
      if (current === null) throw stale(`The file is already gone, so there is nothing to move aside.`);
      const bad = current[line - 1];
      if (bad === undefined || bad.trim().length === 0) throw stale(`Line ${line} is already gone, so there is nothing to move aside.`);
      // Stale only when the line left its reported bad state: it parses with
      // a row id now. Anything else is still worth moving aside.
      if (classifyLedgerLine(bad) === "row") throw stale(`Line ${line} parses now, so there is nothing to move aside.`);
      await mkdir(quarantineDir, { recursive: true });
      const movedTo = movedName(path.basename(problem.file));
      await writeFile(movedTo, `${current.join("\n")}\n`, "utf8");
      this.assertInsideRoot(movedTo);
      const kept = [...current.slice(0, line - 1), ...current.slice(line)];
      await this.writeLedgerFile(problem.file, kept);
      this.resyncLedgerProblems(problem.file, kind, problem.kind === "delegation-line" ? undefined : problem.threadId, kept);
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
    checkThreadId(threadId);
    return path.join(this.root, "threads", threadId);
  }

  private threadFile(threadId: string): string {
    return path.join(this.threadDir(threadId), "thread.json");
  }

  /** Refuse any path that is not the expected file inside the store root. */
  private assertInsideRoot(file: string): void {
    const relative = path.relative(this.root, file);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new CliError("INVALID_STORE_PATH", `Refusing a path outside the thread store: ${file}.`, {
        details: { file },
      });
    }
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
    return this.parseLedgerLines<T>(raw, file, "ledger-line", threadId);
  }

  /**
   * Parse raw ledger lines into rows, reporting what cannot be read. Returns
   * the rows; rewrites re-read the file themselves and splice skipped lines
   * back, so no writer below can lose what it could not read.
   */
  private parseLedgerLines<T>(raw: string, file: string, kind: "ledger-line" | "delegation-line", threadId?: string): T[] {
    const rows: T[] = [];
    const lines = raw.split("\n");
    const complete = raw.endsWith("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim().length === 0) continue;
      const lineNumber = index + 1;
      const report = (validJson: boolean): void => {
        this.noteProblem({ ...ledgerProblem(kind, file, lineNumber, validJson), ...(threadId !== undefined ? { threadId } : {}) });
      };
      switch (classifyLedgerLine(line)) {
        case "row":
          break;
        case "bad-row":
          // Complete JSON with no row id: from a hand edit, never a build.
          // Reported like corruption so it can be quarantined, never read.
          report(true);
          continue;
        case "bad-json":
          if (index === lines.length - 1 && !complete) {
            const pending = this.pendingTorn.get(file);
            if (!pending || pending.line !== lineNumber || pending.raw !== line) {
              // First sight: a crash in flight, not corruption yet. Re-read once.
              this.pendingTorn.set(file, { line: lineNumber, raw: line });
              continue;
            }
          }
          report(false);
          continue;
      }
      rows.push(JSON.parse(line) as T);
      // Fixed by hand since, or complete now: the warning goes with the bad bytes.
      this.problems.delete(storeProblemId({ kind, file, line: lineNumber, ...(threadId !== undefined ? { threadId } : {}) }));
      if (this.pendingTorn.get(file)?.line === lineNumber) this.pendingTorn.delete(file);
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

  /** Raw lines of a ledger file, exactly as stored; null when it does not exist. */
  private async readRawLedgerLines(file: string): Promise<string[] | null> {
    this.assertInsideRoot(file);
    try {
      return (await readFile(file, "utf8")).split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Write ledger lines atomically (tmp file + rename), so a crash cannot tear the ledger. */
  private async writeLedgerFile(file: string, lines: string[]): Promise<void> {
    this.assertInsideRoot(file);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${this.newId()}`;
    await writeFile(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    await renameReplacing(tmp, file);
  }

  /**
   * Drop this file's line problems and report what its new lines show, so
   * line numbers stay accurate across rewrites. A rewritten file always
   * ends complete, so bad lines are reported at once here.
   */
  private resyncLedgerProblems(file: string, kind: "ledger-line" | "delegation-line", threadId: string | undefined, lines: string[]): void {
    for (const [id, problem] of [...this.problems]) {
      if (problem.file === file && problem.kind === kind) this.problems.delete(id);
    }
    this.pendingTorn.delete(file);
    lines.forEach((line, index) => {
      if (line.trim().length === 0) return;
      const classification = classifyLedgerLine(line);
      if (classification === "row") return;
      this.noteProblem({ ...ledgerProblem(kind, file, index + 1, classification !== "bad-json"), ...(threadId !== undefined ? { threadId } : {}) });
    });
  }

  /**
   * Splice a row list into raw ledger lines: rows with an id replace the
   * parsed line with the same id; rows without one consume one value-equal
   * file line each, so a rewrite never doubles them. Parsed lines with no
   * match in the list are dropped, and every other line is kept
   * byte-for-byte. Blank lines are dropped, as rewrites always did.
   */
  private mergeLedgerLines(current: string[], rows: readonly unknown[]): string[] {
    const wanted = new Map<string, unknown>();
    const idless: Array<{ row: unknown; key: string }> = [];
    for (const row of rows) {
      const id = (row as { id?: unknown } | null)?.id;
      if (typeof id === "string") {
        wanted.set(id, row);
        continue;
      }
      const key = canonicalRowKey(row);
      // An unserializable row cannot match a file line; it is appended below.
      idless.push({ row, key });
    }
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of current) {
      if (raw.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        next.push(raw);
        continue;
      }
      const id = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { id?: unknown }).id
        : null;
      if (typeof id === "string") {
        if (!wanted.has(id)) continue;
        seen.add(id);
        next.push(JSON.stringify(wanted.get(id)));
        continue;
      }
      const match = idless.findIndex((entry) => entry.key !== "" && entry.key === canonicalRowKey(parsed));
      if (match >= 0) idless.splice(match, 1);
      next.push(raw);
    }
    for (const [id, row] of wanted) if (!seen.has(id)) next.push(JSON.stringify(row));
    for (const { row } of idless) next.push(JSON.stringify(row));
    return next;
  }

  /**
   * Replace a ledger from an explicit row list. Rows the list drops go;
   * lines the list cannot replace (bad lines) stay byte-for-byte.
   * Caller holds the thread lock.
   */
  async rewriteLedger(threadId: string, name: LedgerName, rows: readonly unknown[]): Promise<void> {
    const file = ledgerFile(this.root, threadId, name);
    const next = this.mergeLedgerLines((await this.readRawLedgerLines(file)) ?? [], rows);
    await this.writeLedgerFile(file, next);
    this.resyncLedgerProblems(file, "ledger-line", threadId, next);
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
    await this.rewriteLedger(threadId, "turns", next);
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
    return this.parseLedgerLines<StoredDelegation>(raw, this.delegationsFile(), "delegation-line");
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
      await this.writeDelegationRows(next);
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
      await this.writeDelegationRows(next);
    });
  }

  /** Replace the delegations ledger, splicing skipped lines back byte-for-byte. Caller holds the lock. */
  private async writeDelegationRows(rows: readonly StoredDelegation[]): Promise<void> {
    const file = this.delegationsFile();
    const next = this.mergeLedgerLines((await this.readRawLedgerLines(file)) ?? [], rows);
    await this.writeLedgerFile(file, next);
    this.resyncLedgerProblems(file, "delegation-line", undefined, next);
  }
}

export async function openThreadStore(
  root: string,
  options: ThreadStoreOptions = {},
): Promise<ThreadStore> {
  return await ThreadStore.open(root, options);
}
