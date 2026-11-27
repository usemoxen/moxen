/**
 * The `store` commands. `import` asks the server, which owns the thread store,
 * to copy the JSONL ledgers into its `store.db` (docs/sqlite-store.md).
 */
import type { CommandResult } from "../../server/protocol.js";
import type { CliConfig } from "../../core/types.js";
import { cliClient } from "../infra/client.js";

export type StoreImportResult = CommandResult<"store.import">;

export async function importStore(config: CliConfig): Promise<StoreImportResult> {
  return await (await cliClient(config)).dispatch({ type: "store.import" });
}

export function describeStoreImport(report: StoreImportResult): string {
  const tables = Object.entries(report.tables);
  const lines = [
    `Imported the JSONL store into ${report.database} in ${(report.durationMs / 1000).toFixed(1)} s.`,
    ...tables.map(([table, counts]) => `${table}\t${counts.imported} of ${counts.source}${counts.quarantined > 0 ? ` (${counts.quarantined} quarantined)` : ""}`),
  ];
  if (report.quarantined > 0) {
    lines.push(`${report.quarantined} record${report.quarantined === 1 ? "" : "s"} could not be imported: the quarantine table in the database keeps each one with the reason.`);
  }
  lines.push("The JSONL store is unchanged, and Moxen still reads and writes it.");
  return lines.join("\n");
}
