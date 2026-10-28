import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { workspaceGit, workspaceGitArgs, workspaceRead } from "../workspace.js";

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-workspace-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  await writeFile(path.join(root, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  return root;
}

describe("workspace reads for remote clients", () => {
  it("runs only the overlay's three git reads", () => {
    expect(workspaceGitArgs("changed", [])).toContain("--name-only");
    expect(workspaceGitArgs("status", [])[0]).toBe("status");
    expect(workspaceGitArgs("diff", ["a.txt"]).slice(-2)).toEqual(["--", "a.txt"]);
    expect(() => workspaceGitArgs("diff", [])).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(() => workspaceGitArgs("diff", ["--output=/tmp/x"])).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
  });

  it("reports a modified and an untracked file as the overlay expects", async () => {
    const root = await repo();
    await writeFile(path.join(root, "a.txt"), "two\n");
    await writeFile(path.join(root, "b.txt"), "new\n");
    expect(await workspaceGit(root, "changed", [])).toBe("a.txt\u0000");
    expect(await workspaceGit(root, "status", [])).toContain("?? b.txt");
    expect(await workspaceGit(root, "diff", ["a.txt"])).toContain("+two");
  });

  it("reads a file under the folder, absolute or relative, and nothing outside it", async () => {
    const root = await repo();
    expect(await workspaceRead(root, "a.txt")).toBe("one\n");
    expect(await workspaceRead(root, path.join(root, "a.txt"))).toBe("one\n");
    await expect(workspaceRead(root, "../outside.txt")).rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE_THREAD" });
    await expect(workspaceRead(root, os.homedir())).rejects.toMatchObject({ code: "WORKSPACE_OUTSIDE_THREAD" });
    await expect(workspaceRead(root, "missing.txt")).rejects.toMatchObject({ code: "WORKSPACE_READ_FAILED" });
  });
});
