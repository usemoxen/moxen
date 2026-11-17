import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../projects/projects.js";
import { branchSlug, provisionWorktree, removeThreadWorktree, restoreThreadWorktree } from "../operations.js";
import type { StoredThread } from "../types.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "moxen-wtclean-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

async function setup(id: string) {
  const repo = path.join(root, `repo-${id}`);
  const store = path.join(root, `store-${id}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, ".gitignore"), "target/\n");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const wt = await provisionWorktree({ projectCwd: repo, baseBranch: "main", startFromOrigin: false, threadId: id, storeRoot: store });
  const thread = { env: { mode: "worktree", path: wt.path, branch: wt.branch } } as unknown as StoredThread;
  return { repo, store, wt, thread };
}

describe("removeThreadWorktree", () => {
  it("removes a clean checkout including ignored build output, keeping the branch", async () => {
    const { repo, store, wt, thread } = await setup("clean-1");
    mkdirSync(path.join(wt.path, "target"));
    writeFileSync(path.join(wt.path, "target", "big.bin"), "x");
    expect(await removeThreadWorktree(store, thread)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
  });

  it("leaves a checkout with uncommitted work alone", async () => {
    const { store, wt, thread } = await setup("dirty-1");
    writeFileSync(path.join(wt.path, "new.txt"), "work");
    expect(await removeThreadWorktree(store, thread)).toBe(false);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("reattaches the retained branch at the original checkout path", async () => {
    const { repo, store, wt, thread } = await setup("restore-1");
    const { project } = await ensureStoredProject(store, { workspaceRoot: repo });
    writeFileSync(path.join(wt.path, "a.txt"), "branch work");
    git(wt.path, "commit", "-qam", "on the thread branch");
    const tip = git(wt.path, "rev-parse", "HEAD");
    expect(await removeThreadWorktree(store, thread)).toBe(true);
    await restoreThreadWorktree(store, { ...thread, projectId: project.id });
    expect(git(wt.path, "branch", "--show-current").trim()).toBe(wt.branch);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("ignores threads that are not in a Moxen-provisioned worktree", async () => {
    const { store } = await setup("other-1");
    const local = { env: { mode: "local", path: root, branch: "main" } } as unknown as StoredThread;
    const foreign = { env: { mode: "worktree", path: path.join(root, "elsewhere"), branch: "x" } } as unknown as StoredThread;
    expect(await removeThreadWorktree(store, local)).toBe(false);
    expect(await removeThreadWorktree(store, foreign)).toBe(false);
  });
});

describe("worktree branch names", () => {
  it("slugs a task name", () => {
    expect(branchSlug("Fix login redirect!")).toBe("fix-login-redirect");
    expect(branchSlug("Añadir  caché")).toBe("anadir-cache");
    expect(branchSlug("***")).toBe("");
    expect(branchSlug("a ".repeat(40)).length).toBeLessThanOrEqual(40);
    expect(branchSlug("refactor the authentication middleware to use sessions")).toBe("refactor-the-authentication-middleware");
  });

  it("names the branch moxen/<name>, numbering a repeat", async () => {
    const { repo, store, wt } = await setup("named-1");
    expect(wt.branch).toMatch(/^moxen\/named1$/);
    const first = await provisionWorktree({ projectCwd: repo, baseBranch: "main", startFromOrigin: false, threadId: "t-a", storeRoot: store, name: "Fix login" });
    const second = await provisionWorktree({ projectCwd: repo, baseBranch: "main", startFromOrigin: false, threadId: "t-b", storeRoot: store, name: "fix login" });
    expect([first.branch, second.branch]).toEqual(["moxen/fix-login", "moxen/fix-login-2"]);
  });
});
