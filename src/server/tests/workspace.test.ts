import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readAttachment, readImageFile, workspaceGit, workspaceGitArgs, workspaceRead } from "../workspace.js";

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

describe("attachment reads", () => {
  it("finds an image by id in the store's folder, then the older one, and takes no path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-attachments-"));
    const store = path.join(root, "store");
    const older = path.join(root, "older");
    await mkdir(store);
    await mkdir(older);
    await writeFile(path.join(store, "abc-123.png"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(older, "old-1.jpg"), Buffer.from([4]));
    await writeFile(path.join(root, "secret.png"), Buffer.from([9]));

    expect(await readAttachment([store, older], "abc-123")).toEqual({ mimeType: "image/png", dataUrl: "data:image/png;base64,AQID" });
    expect((await readAttachment([store, older], "old-1")).mimeType).toBe("image/jpeg");
    await expect(readAttachment([store, older], "missing")).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    for (const id of ["../secret", "secret.png", "/etc/passwd", ""]) {
      await expect(readAttachment([store, older], id)).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    }
  });
});

describe("readImageFile", () => {
  it("reads an image by absolute path or relative to the thread's folder, and refuses what is not an image", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-image-read-"));
    await writeFile(path.join(dir, "shot.PNG"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, "notes.txt"), "secret");
    const expected = { mimeType: "image/png", dataUrl: "data:image/png;base64,AQID" };
    expect(await readImageFile(dir, path.join(dir, "shot.PNG"))).toEqual(expected);
    expect(await readImageFile(dir, "shot.PNG")).toEqual(expected);
    // Any file the user can read, but only an image: a text file named in a reply is not sent to a client.
    await expect(readImageFile(dir, "notes.txt")).rejects.toMatchObject({ code: "IMAGE_NOT_SUPPORTED" });
    await expect(readImageFile(dir, "missing.png")).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });
});
