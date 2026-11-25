import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../../infra/process.js";
import { resolveWorkspace } from "../workspace.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveWorkspace", () => {
  it("resolves a nested folder to the Git root in repo mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-workspace-"));
    cleanup.push(root);
    await runProcess("git", ["init", "-b", "main"], { cwd: root });
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    const resolution = await resolveWorkspace(nested, "repo");

    expect(resolution.workspaceRoot).toBe(await realpath(root));
    expect(resolution.isGitRepository).toBe(true);
    expect(resolution.branch).toBe("main");
  });

  it("keeps the exact nested folder in folder mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-folder-"));
    cleanup.push(root);
    await runProcess("git", ["init", "-b", "main"], { cwd: root });
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    const resolution = await resolveWorkspace(nested, "folder");

    expect(resolution.workspaceRoot).toBe(await realpath(nested));
    expect(resolution.isGitRepository).toBe(true);
  });

  it("resolves a repo root whose name ends in a space, not onto the folder beside it (POSIX: Windows cannot hold the name)", async () => {
    if (process.platform === "win32") return; // a Windows folder name cannot end in a space, so neither root exists there.
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-space-"));
    cleanup.push(root);
    const spaced = path.join(root, "repo ");
    await mkdir(spaced);
    await runProcess("git", ["init", "-b", "main"], { cwd: spaced });
    await mkdir(path.join(root, "repo"));

    const resolution = await resolveWorkspace(spaced, "repo");

    expect(resolution.workspaceRoot).toBe(await realpath(spaced));
    expect(resolution.workspaceRoot.endsWith("repo ")).toBe(true);

    // The folder beside it resolves to itself alone.
    const beside = await resolveWorkspace(path.join(root, "repo"), "folder");
    expect(beside.workspaceRoot).toBe(await realpath(path.join(root, "repo")));
  });
});
