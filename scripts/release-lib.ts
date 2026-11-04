/** Pure rules for release archives (names live in `src/core/release.ts`), shared by `package-release.ts`, `smoke-release.ts` and the release workflow. */
import path from "node:path";

export {
  archiveFileName,
  checksumFileName,
  RELEASE_MARKER,
  releaseBaseName,
  releaseMarker,
  releaseTarget,
  releaseTargetOf,
  tagForVersion,
  tagMismatch,
} from "../src/core/release.js";
export type { ReleaseArch, ReleaseMarker, ReleaseOs, ReleaseTarget } from "../src/core/release.js";
import type { ReleaseTarget } from "../src/core/release.js";

export interface ArchiveCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * The tar invocation that packs `folder` (a directory inside `parent`) into `archive`, or unpacks `archive`
 * into `destination`. Windows uses the system bsdtar, which writes and reads zip: Git Bash's own `tar` is GNU
 * tar and does neither, and it comes first on PATH there.
 */
export function packCommand(target: ReleaseTarget, archive: string, parent: string, folder: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return target.extension === "zip"
    ? { command: windowsTar(env), args: ["-a", "-c", "-f", archive, "-C", parent, folder] }
    : { command: "tar", args: ["-czf", archive, "-C", parent, folder] };
}

export function unpackCommand(target: ReleaseTarget, archive: string, destination: string, env: NodeJS.ProcessEnv = process.env): ArchiveCommand {
  return { command: target.extension === "zip" ? windowsTar(env) : "tar", args: ["-xf", archive, "-C", destination] };
}

function windowsTar(env: NodeJS.ProcessEnv): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "tar.exe");
}
