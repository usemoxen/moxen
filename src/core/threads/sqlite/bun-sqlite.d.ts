/**
 * The slice of `bun:sqlite` the SQLite store uses.
 *
 * This repo does not depend on `bun-types`, so without a declaration `tsc`
 * cannot resolve the module at all. Declaring only the members we call keeps
 * the surface honest: add one here when the store starts using it, rather
 * than vendoring the whole runtime's types.
 */
declare module "bun:sqlite" {
  export type SQLQueryBindings =
    | string
    | number
    | bigint
    | boolean
    | null
    | Uint8Array
    | Readonly<Record<string, string | number | bigint | boolean | null | Uint8Array>>;

  export interface StatementResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<Row = Record<string, unknown>, Params extends readonly unknown[] = readonly unknown[]> {
    all(...params: Params): Row[];
    get(...params: Params): Row | null;
    run(...params: Params): StatementResult;
  }

  export interface Transaction<Params extends readonly unknown[]> {
    (...params: Params): void;
    deferred(...params: Params): void;
    /** `BEGIN IMMEDIATE`: every write transaction in the store uses this. */
    immediate(...params: Params): void;
    exclusive(...params: Params): void;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
    strict?: boolean;
    safeIntegers?: boolean;
  }

  export class Database {
    constructor(filename: string, options?: DatabaseOptions);
    query<Row = Record<string, unknown>, Params extends readonly unknown[] = readonly unknown[]>(sql: string): Statement<Row, Params>;
    exec(sql: string): void;
    transaction<Params extends readonly unknown[]>(fn: (...params: Params) => void): Transaction<Params>;
    close(): void;
  }
}
