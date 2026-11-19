/**
 * A writer killed with an open rollback transaction (MXN-392): it leaves a
 * hot `-journal` behind, which a read-only connection cannot recover. The
 * parent must still open the store (writable), and the uncommitted row must
 * be gone.
 */
import { Database } from "bun:sqlite";

import { STORE_APPLICATION_ID } from "../../connection.js";
import { SCHEMA_V1 } from "../../schema.js";

const file = process.argv[2];
if (!file) throw new Error("journal-writer needs the database path");

const db = new Database(file, { create: true });
db.exec("PRAGMA application_id = " + STORE_APPLICATION_ID);
db.exec("PRAGMA journal_mode = DELETE");
db.exec(SCHEMA_V1);
db.exec("PRAGMA user_version = 1");
db.exec("INSERT INTO meta (key, value) VALUES ('engine', 'sqlite')");
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO meta (key, value) VALUES ('half', 'written')");
console.log("ready");
setInterval(() => {}, 1000);
