/**
 * Import the JSONL store into `store.db` (MXN-393, docs/sqlite-store.md).
 *
 * The JSONL tree is only read: it stays the source of truth until the
 * cut-over, and the rollback copy after it. `store.json` is not touched.
 *
 * Each thread is one `BEGIN IMMEDIATE` transaction that deletes the thread's
 * rows (and the quarantine rows an earlier run made for it) and inserts every
 * record again in file order, so `seq` keeps append order and parseable rows
 * that repeat an id all survive. A crash leaves `import_state = 'running'` and
 * whole threads only; running again replaces each one, so resume and re-import
 * are the same pass. The delegations ledger gets its own transaction under the
 * same rules.
 *
 * Every record in the source ends up in exactly one place: a live row, or a
 * `quarantine` row saying why. Nothing is defaulted to make a bad record fit
 * (`validate.ts`). A file that cannot be read at all is not a bad record: the
 * import stops there, still `running`, rather than dropping what it never saw.
 *
 * `bun:sqlite` is synchronous, so each transaction blocks the process for one
 * thread's worth of rows; the pass yields between threads.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Database, Statement } from "bun:sqlite";

import { CliError } from "../../errors.js";
import { FIRST_FORMAT_VERSION } from "../../format.js";
import { readFileRetrying } from "../../infra/atomic.js";
import { storedInteractionMode } from "../../interactionmode.js";
import { isThreadId, parseLedgerLine, readStoreVersion } from "../store.js";
import type { StoredActivity, StoredCheckpoint, StoredDelegation, StoredMessage, StoredThread, StoredTurn } from "../types.js";
import { openStoreDatabase, storeDatabasePath } from "./connection.js";
import {
  INSERT_ACTIVITY,
  INSERT_CHECKPOINT,
  INSERT_DELEGATION,
  INSERT_MESSAGE,
  INSERT_QUARANTINE,
  INSERT_THREAD,
  INSERT_TURN,
} from "./inserts.js";
import { SCHEMA_VERSION } from "./migrations.js";
import { encodeActivity, encodeCheckpoint, encodeDelegation, encodeMessage, encodeThread, encodeTurn } from "./records.js";
import { activityProblem, checkpointProblem, delegationProblem, messageProblem, threadProblem, turnProblem } from "./validate.js";

export const IMPORT_TABLES = ["threads", "turns", "messages", "activities", "checkpoints", "delegations"] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

/** One table's accounting: every source record is imported or quarantined. */
export interface ImportTableCounts {
  /** Records found in the JSONL store: one per thread record, one per non-blank ledger line. */
  readonly source: number;
  /** Live rows, counted in SQLite after the import. */
  readonly imported: number;
  /** Source records in the `quarantine` table instead. */
  readonly quarantined: number;
}

export interface StoreImportReport {
  readonly storeRoot: string;
  readonly database: string;
  readonly importedAt: string;
  readonly durationMs: number;
  readonly tables: Readonly<Record<ImportTable, ImportTableCounts>>;
  /** Source records quarantined, all tables together. */
  readonly quarantined: number;
}

/** Where the pass is: inside a transaction about to commit, or just after it. `threadId` is null for delegations. */
export interface ImportStep {
  readonly phase: "before-commit" | "committed";
  readonly threadId: string | null;
}

export interface ImportOptions {
  /** Stops the pass between threads, leaving `import_state = 'running'`. */
  readonly signal?: AbortSignal;
  /** Milliseconds since epoch; injectable for tests. */
  readonly clock?: () => number;
  /** Test seam: production never sets it. Throwing (or dying) here is how the tests crash the import. */
  readonly onStep?: (step: ImportStep) => void;
}

/** Marks the quarantine rows this importer owns, so re-running replaces them and leaves any others alone. */
const QUARANTINE_ORIGIN = "jsonl-import";

const LEDGERS = [
  { file: "turns.jsonl", table: "turns", insert: INSERT_TURN, problem: turnProblem, encode: (row: unknown) => encodeTurn(row as StoredTurn) },
  { file: "messages.jsonl", table: "messages", insert: INSERT_MESSAGE, problem: messageProblem, encode: (row: unknown) => encodeMessage(row as StoredMessage) },
  { file: "activity.jsonl", table: "activities", insert: INSERT_ACTIVITY, problem: activityProblem, encode: (row: unknown) => encodeActivity(row as StoredActivity) },
  { file: "checkpoints.jsonl", table: "checkpoints", insert: INSERT_CHECKPOINT, problem: checkpointProblem, encode: (row: unknown) => encodeCheckpoint(row as StoredCheckpoint) },
] as const;

interface Rejected {
  readonly table: ImportTable;
  readonly reason: string;
  /** Path under the store root, with `/` on every platform. */
  readonly file: string;
  readonly line: number | null;
  /** The record exactly as stored. */
  readonly raw: string;
}

interface Insert {
  readonly table: ImportTable;
  readonly sql: string;
  readonly row: object;
}

/** What one transaction writes. */
interface Plan {
  readonly inserts: Insert[];
  readonly rejected: Rejected[];
}

/** A file's text, or null when it does not exist. Any other failure stops the import. */
async function readSource(file: string): Promise<string | null> {
  try {
    return await readFileRetrying(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("STORE_IMPORT_READ_FAILED", `Could not read ${file}, so the import stopped: ${error instanceof Error ? error.message : String(error)}. Run it again once the file reads.`, {
      cause: error,
      details: { file },
    });
  }
}

/** The non-blank lines of a ledger with their 1-based numbers, as the JSONL readers see them. */
function ledgerLines(raw: string): Array<{ line: number; raw: string }> {
  return raw.split("\n").flatMap((text, index) => (text.trim().length === 0 ? [] : [{ line: index + 1, raw: text }]));
}

/** Why a parsed line is not a row, in the words a quarantine row keeps. */
function lineReason(kind: "bad-json" | "bad-row"): string {
  return kind === "bad-json" ? "line is not valid JSON" : "line has no row id";
}

function planLedger(
  plan: Plan,
  options: {
    readonly raw: string;
    readonly file: string;
    readonly table: ImportTable;
    readonly sql: string;
    /** Why a parsed row cannot be imported, or null. */
    readonly problem: (row: Record<string, unknown>) => string | null;
    readonly encode: (row: unknown) => object;
  },
): void {
  for (const entry of ledgerLines(options.raw)) {
    const reject = (reason: string): void => {
      plan.rejected.push({ table: options.table, reason, file: options.file, line: entry.line, raw: entry.raw });
    };
    const parsed = parseLedgerLine(entry.raw);
    if (parsed.kind !== "row") {
      reject(lineReason(parsed.kind));
      continue;
    }
    const problem = options.problem(parsed.row);
    if (problem !== null) {
      reject(`invalid record: ${problem}`);
      continue;
    }
    plan.inserts.push({ table: options.table, sql: options.sql, row: options.encode(parsed.row) });
  }
}

/** The thread record as the JSONL reader would show it, or why it would not. */
function readRecord(raw: string, threadId: string): { readonly thread: StoredThread } | { readonly reason: string } {
  if (!isThreadId(threadId)) return { reason: "invalid thread folder name" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "thread.json is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { reason: "invalid thread record: not an object" };
  if ((parsed as { id?: unknown }).id !== threadId) return { reason: "invalid thread record: its id does not match its folder" };
  // A removed mode reads as Build, exactly as `readThreadRecord` reads it.
  const record = { ...(parsed as Record<string, unknown>), interactionMode: storedInteractionMode((parsed as { interactionMode?: unknown }).interactionMode) };
  const problem = threadProblem(record);
  return problem === null ? { thread: record as unknown as StoredThread } : { reason: `invalid thread record: ${problem}` };
}

/** Everything one thread's folder holds. A folder with no records at all plans nothing. */
async function planThread(root: string, threadId: string): Promise<Plan> {
  const folder = path.join(root, "threads", threadId);
  const name = (file: string): string => `threads/${threadId}/${file}`;
  const record = await readSource(path.join(folder, "thread.json"));
  const ledgers = [];
  for (const ledger of LEDGERS) ledgers.push({ ...ledger, raw: await readSource(path.join(folder, ledger.file)) });
  const plan: Plan = { inserts: [], rejected: [] };
  const verdict = record === null ? { reason: "thread has no thread.json" } : readRecord(record, threadId);

  if ("thread" in verdict) {
    plan.inserts.push({ table: "threads", sql: INSERT_THREAD, row: encodeThread(verdict.thread) });
    for (const ledger of ledgers) {
      planLedger(plan, {
        raw: ledger.raw ?? "",
        file: name(ledger.file),
        table: ledger.table,
        sql: ledger.insert,
        problem: (row) => (row.threadId !== threadId ? "its threadId does not match its thread folder" : ledger.problem(row)),
        encode: ledger.encode,
      });
    }
    return plan;
  }

  // Without a record there is no thread row, and every child row needs one: the
  // whole folder goes to quarantine, line by line, so it can be put back.
  for (const ledger of ledgers) {
    for (const entry of ledgerLines(ledger.raw ?? "")) {
      const parsed = parseLedgerLine(entry.raw);
      plan.rejected.push({
        table: ledger.table,
        reason: parsed.kind === "row" ? "its thread record is quarantined" : lineReason(parsed.kind),
        file: name(ledger.file),
        line: entry.line,
        raw: entry.raw,
      });
    }
  }
  if (record !== null || plan.rejected.length > 0) {
    plan.rejected.unshift({ table: "threads", reason: verdict.reason, file: name("thread.json"), line: null, raw: record ?? "" });
  }
  return plan;
}

async function planDelegations(root: string): Promise<Plan> {
  const plan: Plan = { inserts: [], rejected: [] };
  planLedger(plan, {
    raw: (await readSource(path.join(root, "delegations.jsonl"))) ?? "",
    file: "delegations.jsonl",
    table: "delegations",
    sql: INSERT_DELEGATION,
    problem: delegationProblem,
    encode: (row) => encodeDelegation(row as StoredDelegation),
  });
  return plan;
}

async function threadFolders(root: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, "threads"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Bind a row object's fields as `$column` parameters. */
function bind(statement: Statement, row: object): void {
  const params: Record<string, string | number | null | Uint8Array> = {};
  for (const [key, value] of Object.entries(row)) params[`$${key}`] = (value ?? null) as string | number | null | Uint8Array;
  statement.run(params);
}

function write(db: Database, plan: Plan, threadId: string | null, at: string): void {
  for (const insert of plan.inserts) bind(db.query(insert.sql), insert.row);
  for (const rejected of plan.rejected) {
    const { table, reason, ...source } = rejected;
    bind(db.query(INSERT_QUARANTINE), {
      at,
      reason,
      table_name: table,
      row_json: JSON.stringify({ origin: QUARANTINE_ORIGIN, threadId, ...source }),
    });
  }
}

/** The key a quarantine row is replaced under: its thread, or "" for the delegations ledger. */
function quarantineKey(threadId: string | null): string {
  return threadId ?? "";
}

/**
 * The rows earlier runs quarantined, by owner. Read once: the table has no
 * owner column, and scanning its JSON once per thread would be quadratic.
 */
function earlierQuarantine(db: Database): Map<string, number[]> {
  const rows = db
    .query<{ rowid: number; threadId: string | null }, [string]>(
      `SELECT rowid, json_extract(row_json, '$.threadId') AS threadId FROM quarantine
       WHERE CASE WHEN json_valid(row_json) THEN json_extract(row_json, '$.origin') END = ?`,
    )
    .all(QUARANTINE_ORIGIN);
  const byOwner = new Map<string, number[]>();
  for (const row of rows) {
    const key = quarantineKey(row.threadId);
    const list = byOwner.get(key);
    if (list) list.push(row.rowid);
    else byOwner.set(key, [row.rowid]);
  }
  return byOwner;
}

function dropQuarantine(db: Database, rowids: readonly number[] | undefined): void {
  if (rowids === undefined || rowids.length === 0) return;
  db.query("DELETE FROM quarantine WHERE rowid IN (SELECT value FROM json_each(?))").run(JSON.stringify(rowids));
}

function setMeta(db: Database, values: Readonly<Record<string, string>>): void {
  const statement = db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries(values)) statement.run(key, value);
}

function transaction(db: Database, run: () => void): void {
  db.transaction(run).immediate();
}

type Tally = Record<ImportTable, { source: number; imported: number; quarantined: number }>;

function tally(counts: Tally, plan: Plan): void {
  for (const insert of plan.inserts) {
    counts[insert.table].source += 1;
    counts[insert.table].imported += 1;
  }
  for (const rejected of plan.rejected) {
    counts[rejected.table].source += 1;
    counts[rejected.table].quarantined += 1;
  }
}

/**
 * The counts SQLite holds must be the counts the pass read, and the file must
 * check out. Runs outside any transaction; a failure leaves the import
 * `running`, never `complete`.
 */
function verify(db: Database, counts: Tally): void {
  const mismatches: string[] = [];
  const quarantined = db.query<{ count: number }, [string, string]>(
    "SELECT count(*) AS count FROM quarantine WHERE table_name = ? AND CASE WHEN json_valid(row_json) THEN json_extract(row_json, '$.origin') END = ?",
  );
  for (const table of IMPORT_TABLES) {
    // The table names are this file's own constants.
    const live = db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0;
    if (live !== counts[table].imported) mismatches.push(`${table}: ${live} rows, expected ${counts[table].imported}`);
    const aside = quarantined.get(table, QUARANTINE_ORIGIN)?.count ?? 0;
    if (aside !== counts[table].quarantined) mismatches.push(`${table}: ${aside} quarantined, expected ${counts[table].quarantined}`);
  }
  if (mismatches.length > 0) {
    throw new CliError("STORE_IMPORT_MISMATCH", `The imported row counts do not match the JSONL store (${mismatches.join("; ")}). The JSONL store is unchanged.`, {
      details: { mismatches },
    });
  }
  const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().map((row) => row.quick_check);
  if (check.length !== 1 || check[0] !== "ok") {
    throw new CliError("STORE_IMPORT_CORRUPT", `SQLite's quick_check failed after the import: ${check.slice(0, 5).join("; ")}. The JSONL store is unchanged.`, {
      details: { problems: check.slice(0, 20) },
    });
  }
}

function checkInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CliError("STORE_IMPORT_INTERRUPTED", "The import was interrupted before it finished. Run it again to complete it; the JSONL store is unchanged.");
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Import every thread and the delegations ledger under `root` into its
 * `store.db`, verify the counts, and mark the import complete. Safe to run
 * again at any time while the JSONL store is the source of truth: the database
 * ends up matching it.
 */
export async function importJsonlStore(storeRoot: string, options: ImportOptions = {}): Promise<StoreImportReport> {
  const root = path.resolve(storeRoot);
  const clock = options.clock ?? Date.now;
  const started = performance.now();
  // The JSONL store's own gate, before anything is created: a newer or
  // unreadable `store.json` refuses with the codes the store already uses.
  // Data older than the 2026-11-06 baseline gets no migration: records that do
  // not have today's shape are quarantined below.
  const version = await readStoreVersion(root);
  // Version 1 is the JSONL engine. Once a later version means `store.db` is the
  // source of truth, importing the kept JSONL copy would overwrite newer data.
  if (version !== FIRST_FORMAT_VERSION) {
    throw new CliError("STORE_NOT_JSONL", `The thread store at ${root} is format version ${version}, not the JSONL format this imports. Nothing was changed.`, {
      details: { storeRoot: root, version },
    });
  }
  checkInterrupted(options.signal);
  const folders = await threadFolders(root);

  const db = openStoreDatabase(root);
  try {
    transaction(db, () => {
      setMeta(db, { engine: "sqlite", schema: String(SCHEMA_VERSION), import_state: "running" });
      db.exec("DELETE FROM meta WHERE key IN ('imported_at', 'source_rows')");
    });
    const earlier = earlierQuarantine(db);
    const at = new Date(clock()).toISOString();
    const counts = Object.fromEntries(IMPORT_TABLES.map((table) => [table, { source: 0, imported: 0, quarantined: 0 }])) as Tally;
    const present = new Set<string>();

    const replace = (threadId: string | null, plan: Plan, clear: () => void): void => {
      transaction(db, () => {
        dropQuarantine(db, earlier.get(quarantineKey(threadId)));
        clear();
        write(db, plan, threadId, at);
        options.onStep?.({ phase: "before-commit", threadId });
      });
      earlier.delete(quarantineKey(threadId));
      tally(counts, plan);
      options.onStep?.({ phase: "committed", threadId });
    };

    for (const threadId of folders) {
      checkInterrupted(options.signal);
      const plan = await planThread(root, threadId);
      if (plan.inserts.some((insert) => insert.table === "threads")) present.add(threadId);
      // The cascade takes the thread's turns, messages, activities and checkpoints with it.
      replace(threadId, plan, () => void db.query("DELETE FROM threads WHERE id = ?").run(threadId));
      await yieldToEventLoop();
    }

    checkInterrupted(options.signal);
    replace(null, await planDelegations(root), () => db.exec("DELETE FROM delegations"));

    // What an earlier run imported and the JSONL store no longer has goes too:
    // the database mirrors the source as it is now.
    transaction(db, () => {
      for (const { id } of db.query<{ id: string }, []>("SELECT id FROM threads").all()) {
        if (!present.has(id)) db.query("DELETE FROM threads WHERE id = ?").run(id);
      }
      dropQuarantine(db, [...earlier.values()].flat());
    });
    await yieldToEventLoop();
    verify(db, counts);

    const importedAt = new Date(clock()).toISOString();
    transaction(db, () => setMeta(db, { import_state: "complete", imported_at: importedAt, source_rows: JSON.stringify(counts) }));
    return {
      storeRoot: root,
      database: storeDatabasePath(root),
      importedAt,
      durationMs: Math.round(performance.now() - started),
      tables: counts,
      quarantined: IMPORT_TABLES.reduce((sum, table) => sum + counts[table].quarantined, 0),
    };
  } finally {
    db.close();
  }
}
