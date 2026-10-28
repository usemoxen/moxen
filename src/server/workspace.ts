/**
 * The two reads behind `workspace.git` and `workspace.read`: what the TUI's
 * live diff overlay does on its own disk when the server is local, done
 * here for a client on another machine. Deliberately narrow — three fixed
 * git invocations and one capped file read under the thread's folder —
 * so the queries cannot be bent into running anything else.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { imageMimeForPath } from "../core/attachments.js";
import { CliError } from "../core/errors.js";
import type { WorkspaceGitCall } from "./protocol.js";

/** The overlay's own caps (`tui/model/gitdiff.ts`, `tui/model/filecache.ts`). */
const GIT_MAX_BUFFER = 256 * 1024;
const READ_MAX_BYTES = 256 * 1024;

export function workspaceGitArgs(call: WorkspaceGitCall, paths: readonly string[]): string[] {
  if (call === "changed") return ["diff", "HEAD", "--no-color", "--no-ext-diff", "--name-only", "-z", "--"];
  if (call === "status") return ["status", "--porcelain=v1", "-uall", "--no-renames", "--"];
  // After `--` git takes every argument as a path; a leading dash is refused anyway.
  if (paths.length === 0 || paths.some((entry) => entry.startsWith("-"))) {
    throw new CliError("INVALID_QUERY", "workspace.git diff needs repo-relative paths.", { exitCode: 2 });
  }
  return ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", ...paths];
}

export function workspaceGit(root: string, call: WorkspaceGitCall, paths: readonly string[]): Promise<string> {
  const args = ["-C", root, ...workspaceGitArgs(call, paths)];
  return new Promise((resolve, reject) => {
    execFile("git", args, { timeout: 15_000, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
      if (error !== null) reject(new CliError("WORKSPACE_GIT_FAILED", error.message));
      else resolve(String(stdout));
    });
  });
}

/** One file under `root` (relative or absolute), refused if it lies outside or is too big. */
export async function workspaceRead(root: string, file: string): Promise<string> {
  const base = path.resolve(root);
  const target = path.resolve(base, file);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CliError("WORKSPACE_OUTSIDE_THREAD", "That file is outside this thread's folder.");
  }
  const info = await stat(target).catch(() => null);
  if (info === null || !info.isFile()) throw new CliError("WORKSPACE_READ_FAILED", "No such file.");
  if (info.size > READ_MAX_BYTES) throw new CliError("WORKSPACE_READ_FAILED", "The file is too big to diff live.");
  return await readFile(target, "utf8");
}

/** Ids the store gives attachments: anything else could name a path. */
const ATTACHMENT_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * A sent message's image, for a client to copy it: looked up by id alone
 * in the folders attachments are saved in (`dirs`, the store's first), never
 * by a path a client sends.
 */
export async function readAttachment(dirs: readonly string[], attachmentId: string): Promise<{ mimeType: string; dataUrl: string }> {
  if (!ATTACHMENT_ID.test(attachmentId)) {
    throw new CliError("ATTACHMENT_NOT_FOUND", `No attachment ${attachmentId}.`, { details: { attachmentId } });
  }
  for (const dir of dirs) {
    const name = (await readdir(dir).catch(() => [] as string[])).find((entry) => path.parse(entry).name === attachmentId);
    if (name === undefined) continue;
    const mimeType = imageMimeForPath(name);
    return { mimeType, dataUrl: `data:${mimeType};base64,${(await readFile(path.join(dir, name))).toString("base64")}` };
  }
  throw new CliError("ATTACHMENT_NOT_FOUND", `No attachment ${attachmentId}.`, { details: { attachmentId } });
}
