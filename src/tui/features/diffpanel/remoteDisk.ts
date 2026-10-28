import type { ClientApi } from "../../../server/api.js";
import type { FileReader } from "../../model/filecache.js";
import type { GitRunner } from "../../model/gitdiff.js";

/**
 * The live diff overlay's disk, when the server is on another machine: its
 * git reads and file reads go to the server (`workspace.git`,
 * `workspace.read`) instead of this machine, where the thread's folder does
 * not exist. The overlay's three git calls map onto the query's fixed ones.
 */
export function remoteDisk(client: ClientApi, threadId: string, root: string): { run: GitRunner; read: FileReader } {
  const run: GitRunner = async (args) => {
    const separator = args.indexOf("--");
    const call = args[0] === "status" ? "status" : args.includes("--name-only") ? "changed" : "diff";
    const paths = call === "diff" && separator >= 0 ? args.slice(separator + 1) : [];
    const { stdout } = await client.query({ type: "workspace.git", threadId, root, call, ...(paths.length > 0 ? { paths } : {}) });
    return { stdout };
  };
  const read: FileReader = async (path) => (await client.query({ type: "workspace.read", threadId, root, path })).content;
  return { run, read };
}
