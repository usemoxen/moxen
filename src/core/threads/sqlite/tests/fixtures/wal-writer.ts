/**
 * A store writer that gets killed (MXN-392): it commits schema version 99
 * and its DDL, leaves them only in the WAL, and waits to be killed. The
 * parent kills it and checks that refusing the newer store does not
 * checkpoint that WAL into the database file.
 */
import { Database } from "bun:sqlite";

import { STORE_APPLICATION_ID } from "../../connection.js";

const file = process.argv[2];
if (!file) throw new Error("wal-writer needs the database path");

const db = new Database(file, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`);
db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
db.exec("PRAGMA user_version = 99");
db.exec("INSERT INTO meta (key, value) VALUES ('engine', 'sqlite')");
console.log("ready");
setInterval(() => {}, 1000);
