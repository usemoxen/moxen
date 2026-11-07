/**
 * Format versions for the data moxen writes: the config file and the thread
 * store each carry one, so a future format change has somewhere to be
 * detected and a downgrade has something to refuse. Today's shapes are
 * version 1, and a value that names none reads as version 1. Anything older
 * than today's shapes gets no migration work.
 */
import { CliError } from "./errors.js";

/** What a versioned value carries when it predates versions: today's shape. */
export const FIRST_FORMAT_VERSION = 1;

/**
 * One step forward: `migrate` reads version `from` and returns version `to`.
 * Steps move one version at a time; the runner applies them in order.
 */
export interface FormatMigration {
  readonly from: number;
  readonly to: number;
  migrate(data: unknown): unknown;
}

/**
 * The version a versioned value carries: its `formatVersion`, or 1 when it
 * names none. A present version that is not a positive whole number is not
 * a version at all — it refuses, rather than guessing what it meant.
 */
export function formatVersionOf(data: unknown): number {
  if (data === undefined) return FIRST_FORMAT_VERSION;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError("INVALID_FORMAT_VERSION", `formatVersion must be a whole number from 1, not ${JSON.stringify(data) ?? "null"}.`);
  }
  const version = (data as { formatVersion?: unknown }).formatVersion;
  if (version === undefined) return FIRST_FORMAT_VERSION;
  if (typeof version !== "number" || !Number.isInteger(version) || version < FIRST_FORMAT_VERSION) {
    throw new CliError("INVALID_FORMAT_VERSION", `formatVersion must be a whole number from 1, not ${JSON.stringify(version) ?? "null"}.`);
  }
  return version;
}

/** A build faced with data newer than it knows: it refuses, naming both. */
export function formatTooNew(what: string, found: number, current: number): CliError {
  return new CliError(
    "FORMAT_TOO_NEW",
    `${what} is version ${found}, and this build reads up to version ${current}. Update moxen to read it; this build will not write to it.`,
  );
}

/**
 * Bring versioned data up to `current`: run every registered step in order,
 * or refuse what is newer than the build knows. With no steps registered the
 * data passes through untouched — the runner exists so the first format
 * change has somewhere to go, not for today's shapes.
 */
export function migrateFormat(
  data: unknown,
  options: { readonly what: string; readonly from: number; readonly current: number; readonly migrations: readonly FormatMigration[] },
): unknown {
  const { what, from, current, migrations } = options;
  if (from > current) throw formatTooNew(what, from, current);
  let version = from;
  let next = data;
  while (version < current) {
    const step = migrations.find((migration) => migration.from === version && migration.to === version + 1);
    if (!step) {
      throw new CliError(
        "FORMAT_MIGRATION_MISSING",
        `${what} is version ${version}, and this build has no migration to version ${version + 1}.`,
      );
    }
    next = step.migrate(next);
    version += 1;
  }
  return next;
}
