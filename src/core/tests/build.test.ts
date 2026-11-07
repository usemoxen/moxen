import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildIdOf, describeBuildMismatch, readGitRevision } from "../build.js";

async function fakeCheckout(head: string, refs: Record<string, string> = {}, packed = ""): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-build-"));
  const git = path.join(root, ".git");
  await mkdir(path.join(git, "refs", "heads"), { recursive: true });
  await writeFile(path.join(git, "HEAD"), head);
  for (const [name, hash] of Object.entries(refs)) {
    const file = path.join(git, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${hash}\n`);
  }
  if (packed) await writeFile(path.join(git, "packed-refs"), packed);
  return root;
}

const HASH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const HASH_B = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("build identity", () => {
  it("reads a detached HEAD", async () => {
    const root = await fakeCheckout(`${HASH_A}\n`);
    expect(readGitRevision(root)).toBe(HASH_A);
  });

  it("follows HEAD through a ref file", async () => {
    const root = await fakeCheckout("ref: refs/heads/main\n", { "refs/heads/main": HASH_A });
    expect(readGitRevision(root)).toBe(HASH_A);
  });

  it("falls back to packed-refs when the ref file is gone", async () => {
    const root = await fakeCheckout("ref: refs/heads/main\n", {}, `${HASH_B} refs/heads/main\n`);
    expect(readGitRevision(root)).toBe(HASH_B);
  });

  it("follows a worktree's gitdir file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-build-"));
    const real = path.join(root, "real.git");
    await mkdir(path.join(real, "refs", "heads"), { recursive: true });
    await writeFile(path.join(real, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(real, "refs", "heads", "main"), `${HASH_A}\n`);
    await writeFile(path.join(root, ".git"), `gitdir: ${real}\n`);
    expect(readGitRevision(root)).toBe(HASH_A);
  });

  it("follows a linked worktree's commondir for the ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-build-"));
    const git = path.join(root, "work.git");
    const common = path.join(root, "common.git");
    await mkdir(path.join(git, "refs", "heads"), { recursive: true });
    await mkdir(path.join(common, "refs", "heads"), { recursive: true });
    await writeFile(path.join(git, "HEAD"), "ref: refs/heads/feature\n");
    await writeFile(path.join(git, "commondir"), "../common.git\n");
    await writeFile(path.join(common, "refs", "heads", "feature"), `${HASH_B}\n`);
    await writeFile(path.join(root, ".git"), `gitdir: ${git}\n`);
    expect(readGitRevision(root)).toBe(HASH_B);
  });

  it("returns null when there is no commit to read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moxen-build-"));
    expect(readGitRevision(root)).toBeNull();
  });

  it("gives source builds an id that differs between commits", () => {
    const one = buildIdOf({ kind: "source", version: "0.1.3", revision: HASH_A });
    const two = buildIdOf({ kind: "source", version: "0.1.3", revision: HASH_B });
    expect(one.id).not.toBe(two.id);
    expect(one.display).toContain("0.1.3");
    expect(one.display).toContain(HASH_A.slice(0, 12));
    expect(one.display).not.toContain(HASH_A);
  });

  it("names both builds and the next step in a mismatch", () => {
    const server = buildIdOf({ kind: "source", version: "0.1.3", revision: HASH_A });
    const client = buildIdOf({ kind: "release", version: "0.2.0", target: "macos-arm64" });
    const message = describeBuildMismatch({ server, client, remote: false });
    expect(message).toContain(server.display);
    expect(message).toContain(client.display);
    expect(message).toContain("moxen server stop");
  });

  it("tells a remote client to restart the server on its own machine", () => {
    const server = buildIdOf({ kind: "source", version: "0.1.3", revision: HASH_A });
    const client = buildIdOf({ kind: "source", version: "0.1.3", revision: HASH_B });
    const message = describeBuildMismatch({ server, client, remote: true });
    expect(message).toContain(server.display);
    expect(message).toContain(client.display);
    expect(message).toContain("its own machine");
  });
});
