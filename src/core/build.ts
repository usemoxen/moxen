/**
 * What moxen this is: the build identity a client's hello carries and the
 * server checks, so two different builds never share a server or a store.
 *
 * A release is identified by its version and platform: every install of
 * `0.2.0` for `macos-arm64` runs the same code. A source checkout is
 * identified by its version and its commit: the version alone never changes
 * between commits, so the commit hash is what tells two checkouts apart.
 * `scripts/build.ts` bakes the commit it built from into the bundle; a
 * source run directly (`bun src/cli …`) reads the checkout's git HEAD
 * instead, so a stale `dist/` bundle and the checkout it was built from
 * still count as different builds.
 *
 * The commit is read from the files, never by running git: `HEAD`, the ref
 * it names, and `packed-refs` as a fallback, following a worktree's
 * `gitdir` pointer. An uncommitted edit changes no identity (same commit,
 * same build for this check's purposes); a checkout with no commit to read
 * reports `unknown`, which matches only `unknown`.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { APP_VERSION } from "./version.js";
import { readInstall } from "./selfupdate/install.js";

declare const __MOXEN_BUILD_REVISION__: string | undefined;

export interface BuildInfo {
  /** Compared for equality: `release:<version>:<os>-<arch>`, or `source:<version>:<commit>`. */
  readonly id: string;
  /** Said to a person: `release 0.2.0 (macos-arm64)`, or `source 0.1.3 (a1b2c3d4e5f6)`. */
  readonly display: string;
  readonly version: string;
  readonly kind: "release" | "source";
  /** The full commit hash for a source build, else the version. Null when no commit could be read. */
  readonly revision: string | null;
}

/** The commit the bundle was built from (`scripts/build.ts` defines it); absent on a direct source run. */
function bakedRevision(): string | null {
  try {
    const value = typeof __MOXEN_BUILD_REVISION__ === "string" ? __MOXEN_BUILD_REVISION__ : null;
    return value !== null && /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readLine(file: string): string | null {
  try {
    const first = readFileSync(file, "utf8").split("\n")[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/** The git dir for a checkout root: its `.git` directory, or the target of a worktree's `gitdir` pointer file. */
function gitDirOf(folder: string): string | null {
  const dotGit = path.join(folder, ".git");
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (stat.isFile()) {
    const pointer = readLine(dotGit);
    if (pointer !== null && pointer.startsWith("gitdir:")) {
      const target = pointer.slice("gitdir:".length).trim();
      if (target.length > 0) return path.resolve(folder, target);
    }
  }
  return null;
}

/**
 * The commit a checkout root sits on, from its git files. Null when there
 * is no commit to read (no `.git`, an unborn HEAD, an unreadable ref).
 *
 * A linked worktree's `.git` file points at its own git dir, whose refs
 * live in the main checkout (`commondir`): the ref is looked up in both,
 * then in each one's `packed-refs`.
 */
export function readGitRevision(folder: string): string | null {
  const git = gitDirOf(folder);
  if (git === null) return null;
  const head = readLine(path.join(git, "HEAD"));
  if (head === null) return null;
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = head.startsWith("ref: ") ? head.slice("ref: ".length).trim() : null;
  if (ref === null || ref.startsWith("/") || ref.includes("..")) return null;
  const common = readLine(path.join(git, "commondir"));
  const dirs = [git, ...(common !== null ? [path.resolve(git, common)] : [])];
  for (const dir of dirs) {
    const hash = readLine(path.join(dir, ...ref.split("/")));
    if (hash !== null && /^[0-9a-f]{40}$/.test(hash)) return hash;
  }
  for (const dir of dirs) {
    let packed: string;
    try {
      packed = readFileSync(path.join(dir, "packed-refs"), "utf8");
    } catch {
      continue;
    }
    for (const line of packed.split("\n")) {
      const match = /^([0-9a-f]{40}) (.+)$/.exec(line.trim());
      if (match?.[2] === ref) return match[1]!;
    }
  }
  return null;
}

export function buildIdOf(input: {
  readonly kind: "release" | "source";
  readonly version: string;
  readonly target?: string;
  readonly revision?: string | null;
}): BuildInfo {
  if (input.kind === "release") {
    const platform = input.target ?? "unknown-platform";
    return {
      id: `release:${input.version}:${platform}`,
      display: `release ${input.version} (${platform})`,
      version: input.version,
      kind: "release",
      revision: input.version,
    };
  }
  const revision = input.revision ?? null;
  return {
    id: `source:${input.version}:${revision ?? "unknown"}`,
    display: revision === null ? `source ${input.version} (unknown commit)` : `source ${input.version} (${revision.slice(0, 12)})`,
    version: input.version,
    kind: "source",
    revision,
  };
}

/** This running moxen's build identity. */
export function buildIdentity(): BuildInfo {
  const version = APP_VERSION;
  try {
    const install = readInstall();
    if (install.kind === "release" && install.target !== null) {
      return buildIdOf({ kind: "release", version, target: `${install.target.os}-${install.target.arch}` });
    }
    if (install.folder !== null) {
      return buildIdOf({ kind: "source", version, revision: bakedRevision() ?? readGitRevision(install.folder) });
    }
  } catch {
    // An unreadable install is never a release; fall through to unknown.
  }
  return buildIdOf({ kind: "source", version, revision: bakedRevision() });
}

/**
 * Why a hello's build does not match the server's, and what to do next.
 * Both builds are named; a local client is told to stop the server and
 * start again from its own build, while a remote one must do that on the
 * server's own machine (a paired client can never stop it).
 */
export function describeBuildMismatch(options: {
  readonly server: BuildInfo;
  readonly client: BuildInfo;
  readonly remote: boolean;
}): string {
  const { server, client } = options;
  const next = options.remote
    ? "Restart the moxen server on its own machine from this same build (moxen server stop, then start Moxen again there); that interrupts its running threads, so do it when you are ready."
    : "Stop the server (moxen server stop) and start Moxen again from this build so both match; that interrupts running threads, so do it when you are ready.";
  return `This moxen server runs ${server.display}, but the client runs ${client.display}. ${next}`;
}
