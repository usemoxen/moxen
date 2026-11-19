/**
 * One side of the two-process open race (MXN-392): waits for the parent's
 * signal, then opens the same store root as its sibling through the public
 * opener. Both must succeed and see one initialized schema.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openStoreDatabase } from "../../connection.js";

const [root, dir, id] = process.argv.slice(2);
if (!root || !dir || !id) throw new Error("open-racer needs the store root, the barrier folder and an id");

writeFileSync(path.join(dir, `${id}.ready`), "ready");
while (!existsSync(path.join(dir, "go"))) {
  // Spin rather than sleep so both processes leave the barrier together.
}

const db = openStoreDatabase(root);
db.close();
