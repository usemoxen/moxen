/**
 * Worktree isolation: what a session running in its own worktree may not
 * touch. A worktree is only a directory; nothing stops an agent from
 * editing the checkout it was cut from, so every provider is held to the
 * same rule — natively where it has a mechanism, through this guard where
 * it only has a callback.
 *
 * The rule is Claude Code's, reduced to what can be decided from a tool
 * call alone: a file edit that targets the main checkout, a command whose
 * working directory is the main checkout, and a command that redirects `cd`
 * or git into it (`git -C`, `--git-dir`, `--work-tree`, `GIT_DIR`,
 * `GIT_WORK_TREE`). Like Claude's, it does not track what a shell command
 * writes (`cp`, a redirect), so it is a guard rail, not a sandbox.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

import { runProcess } from "../infra/process.js";
import type { ThreadEnv } from "./types.js";

export interface WorktreeIsolation {
  /** The session's own checkout; everything under it is allowed. */
  readonly worktreeRoot: string;
  /** Checkouts the session must stay out of: the one the worktree was cut from. */
  readonly protectedRoots: readonly string[];
}

/** Tools that write a file, and the input key that names it. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

const SHELL_TOOLS = new Set(["Bash", "Monitor"]);

/** A command word or flag that points the next token's directory at the shell or at git. */
const REDIRECTS = new Set(["cd", "pushd", "-C", "--git-dir", "--work-tree", "GIT_DIR", "GIT_WORK_TREE"]);

async function real(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

/**
 * The isolation for a thread, or null when it shares a checkout (nothing to
 * guard) or the main checkout cannot be found (a bare repository has none).
 */
export async function resolveIsolation(env: ThreadEnv): Promise<WorktreeIsolation | null> {
  if (env.mode !== "worktree" || !env.path.trim()) return null;
  const worktreeRoot = await real(env.path);
  const common = await runProcess("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktreeRoot })
    .then((result) => result.stdout.trim())
    .catch(() => "");
  if (!common || path.basename(common) !== ".git") return null;
  const main = await real(path.dirname(common));
  if (main === worktreeRoot) return null;
  return { worktreeRoot, protectedRoots: [main] };
}

function within(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether `target` is in a protected checkout and not in the worktree (which may itself sit inside one). */
export function escapes(isolation: WorktreeIsolation, target: string, cwd: string): boolean {
  const resolved = path.resolve(cwd, target);
  if (within(resolved, isolation.worktreeRoot)) return false;
  return isolation.protectedRoots.some((root) => within(resolved, root));
}

/** The first redirect in a shell command that lands in a protected checkout, or null. */
function commandRedirect(isolation: WorktreeIsolation, command: string, cwd: string): string | null {
  for (const simple of command.split(/[;&|\n]+/)) {
    const words = simple.split(/[\s'"`=()]+/).filter((word) => word.length > 0);
    for (let index = 0; index < words.length - 1; index += 1) {
      const word = words[index]!;
      if (!REDIRECTS.has(word)) continue;
      const target = words[index + 1]!;
      if (target.startsWith("-")) continue;
      if (escapes(isolation, target, cwd)) return `${word} ${target}`;
    }
  }
  return null;
}

/**
 * Why this tool call must not run, or null when it may. `cwd` is the
 * directory the call runs in (the hook's, which follows `cd`).
 */
export function isolationViolation(
  isolation: WorktreeIsolation,
  call: { readonly tool: string; readonly input: unknown; readonly cwd: string },
): string | null {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const stay = `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. `;
  const fileKey = FILE_TOOLS[call.tool];
  if (fileKey) {
    const target = input[fileKey];
    if (typeof target === "string" && escapes(isolation, target, call.cwd)) {
      return `${stay}${target} is outside it. Make the same change under ${isolation.worktreeRoot}.`;
    }
    return null;
  }
  if (SHELL_TOOLS.has(call.tool)) {
    if (escapes(isolation, call.cwd, call.cwd)) {
      return `${stay}The command's working directory ${call.cwd} is in the main checkout. Run it from ${isolation.worktreeRoot}.`;
    }
    const command = typeof input["command"] === "string" ? input["command"] : "";
    const redirect = commandRedirect(isolation, command, call.cwd);
    if (redirect) return `${stay}\`${redirect}\` points at the main checkout. Use the worktree path instead.`;
  }
  return null;
}

/**
 * Whether a provider's own permission request (OpenCode's `permission.asked`:
 * an action and the resources it covers, as globs like `/repo/*`) reaches a
 * protected checkout. Only the actions that touch the filesystem count.
 */
export function permissionEscapes(
  isolation: WorktreeIsolation,
  request: { readonly action: string; readonly resources: readonly string[] },
  cwd: string,
): boolean {
  if (request.action !== "external_directory" && request.action !== "edit" && request.action !== "read") return false;
  return request.resources.some((resource) => escapes(isolation, resource.replace(/[/\\]?\*+$/, "") || "/", cwd));
}

/**
 * Why a provider tool call of unknown shape must not run (an untyped
 * `rawInput`, whose fields nothing here pins down): any path-like string in
 * it that lands in a protected checkout, or a `command` that redirects into
 * one. Free text with whitespace is only read where it is a command.
 */
export function rawInputViolation(isolation: WorktreeIsolation, rawInput: unknown, cwd: string): string | null {
  const stay = `This session is isolated in its own worktree at ${isolation.worktreeRoot}; the main checkout is off limits. `;
  const visit = (value: unknown, key: string, depth: number): string | null => {
    if (depth > 6) return null;
    if (typeof value === "string") {
      if (/^(command|cmd)$/i.test(key)) {
        const redirect = commandRedirect(isolation, value, cwd);
        return redirect ? `${stay}\`${redirect}\` points at the main checkout.` : null;
      }
      return !/\s/.test(value) && value.length > 0 && escapes(isolation, value, cwd)
        ? `${stay}${value} is outside it. Use the same path under ${isolation.worktreeRoot}.`
        : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, key, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) {
        const found = visit(item, name, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(rawInput, "", 0);
}

/** The standing instruction every provider gets alongside its enforcement. */
export function isolationInstructions(isolation: WorktreeIsolation): string {
  return (
    `You are isolated in the git worktree ${isolation.worktreeRoot}. Read, edit and run commands only inside it. ` +
    `Never write to, or run git or other commands in, ${isolation.protectedRoots.join(", ")}: it is another checkout of the same repository, ` +
    "and the session will refuse tool calls that reach it. If a path you were given points there, use the same path under your worktree."
  );
}
