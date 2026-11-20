/**
 * One side of the migration race (MXN-392): its own connection, a barrier
 * file from the parent, then a first step that holds the write lock for
 * 400 ms after creating the schema. Two of these start together; the loser
 * must see the winner's committed version and skip the step, not run the
 * DDL again.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { migrateStoreSchema } from "../../migrations.js";
import { SCHEMA_V1 } from "../../schema.js";

const [file, dir, id] = process.argv.slice(2);
if (!file || !dir || !id) throw new Error("migration-racer needs the database path, the barrier folder and an id");

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const db = new Database(file, { create: true });
db.exec("PRAGMA busy_timeout = 5000");
writeFileSync(path.join(dir, `${id}.ready`), "ready");
while (!existsSync(path.join(dir, "go"))) sleep(5);

migrateStoreSchema(db, {
  migrations: [
    {
      version: 1,
      name: "create schema v1 slowly",
      up: (connection) => {
        connection.exec(SCHEMA_V1);
        sleep(400);
      },
    },
  ],
});
db.close();
