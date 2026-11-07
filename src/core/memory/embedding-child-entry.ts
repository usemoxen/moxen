/**
 * The embedding worker's bundle entry, run unconditionally like
 * `../server/daemon.ts` is for the server process: the runtime spawns this
 * file (`bun <entry> <runtime> <cache> <download|offline> <device>`), and so
 * does `scripts/verify-memory-embeddings.ts`. The protocol itself lives in
 * `./embedding-child.ts`, which the standalone executable dispatches to
 * in-process instead of spawning.
 */
import { runEmbeddingChild } from "./embedding-child.js";

await runEmbeddingChild();
