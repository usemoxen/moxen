/**
 * The import worker's bundle entry, run unconditionally like
 * `../../memory/embedding-child-entry.ts`: `import-job.ts` starts a worker
 * thread on this file. It is an entry point in `scripts/build.ts` and
 * `scripts/build-exe.ts`; without that, a built Moxen has no such file.
 */
import { serveImportJob } from "./import-job.js";

await serveImportJob();
