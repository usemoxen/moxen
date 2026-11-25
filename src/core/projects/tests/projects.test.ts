import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureStoredProject,
  findStoredProject,
  listStoredProjects,
  registryFile,
  removeStoredProject,
  renameStoredProject,
  resolveStoredProject,
  stripTrailingSeparators,
  workspaceRootsEqual,
} from "../projects.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-projects-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("workspaceRootsEqual", () => {
  it("compares normalized roots", () => {
    expect(workspaceRootsEqual("/repo", "/repo/")).toBe(true);
    expect(workspaceRootsEqual("/repo", "/other")).toBe(false);
  });

  it("keeps a Windows volume root's trailing separator, so C:\\ never becomes C:", () => {
    // Pure path shaping, so every platform tests the same strings.
    expect(stripTrailingSeparators("C:\\")).toBe("C:\\");
    expect(stripTrailingSeparators("C:")).toBe("C:");
    expect(stripTrailingSeparators("/repo/")).toBe("/repo");
    expect(stripTrailingSeparators("/repo//")).toBe("/repo");
    expect(stripTrailingSeparators("/")).toBe("/");
    // An equal pair stays equal through the volume root, instead of both turning into C:.
    expect(workspaceRootsEqual("C:\\", "C:\\")).toBe(true);
  });
});

describe("projects registry", () => {
  it("starts empty and ensures idempotently", async () => {
    const root = await tmpRoot();
    expect(await listStoredProjects(root)).toEqual([]);
    expect(await resolveStoredProject(root, "/repo")).toBeNull();

    const first = await ensureStoredProject(root, { workspaceRoot: "/repo/" });
    expect(first.created).toBe(true);
    expect(first.project.title).toBe("repo");
    expect(first.project.workspaceRoot).toBe(path.resolve("/repo"));
    expect(first.project.defaultModelSelection).toBeNull();
    expect(first.command?.type).toBe("project.create");

    const second = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(second.command).toBeNull();

    expect((await listStoredProjects(root)).length).toBe(1);
  });

  it("enforces the existing policy", async () => {
    const root = await tmpRoot();
    await expect(ensureStoredProject(root, { workspaceRoot: "/repo", policy: "existing" })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("renames a project's title and leaves its threads' project alone", async () => {
    const root = await tmpRoot();
    const { project } = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    const renamed = await renameStoredProject(root, project.id, "  Renamed  ");
    expect(renamed.id).toBe(project.id);
    expect(renamed.title).toBe("Renamed");
    expect(renamed.workspaceRoot).toBe(project.workspaceRoot);
    expect((await listStoredProjects(root)).map((entry) => entry.title)).toEqual(["Renamed"]);
  });

  it("refuses to rename a missing project or blank title", async () => {
    const root = await tmpRoot();
    await expect(renameStoredProject(root, "missing", "Name")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    const { project } = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    await expect(renameStoredProject(root, project.id, "   ")).rejects.toMatchObject({
      code: "INVALID_PROJECT",
    });
  });

  it("removes a project with a soft delete and refuses it twice", async () => {
    const root = await tmpRoot();
    const { project } = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    const removed = await removeStoredProject(root, project.id);
    expect(removed.id).toBe(project.id);
    expect(removed.deletedAt).not.toBeNull();
    expect(await listStoredProjects(root)).toEqual([]);
    expect(await resolveStoredProject(root, "/repo")).toBeNull();
    await expect(removeStoredProject(root, project.id)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    await expect(renameStoredProject(root, project.id, "Name")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("revives a removed project on ensure with the same normalized root", async () => {
    const root = await tmpRoot();
    const { project } = await ensureStoredProject(root, { workspaceRoot: "/repo/" });
    await removeStoredProject(root, project.id);
    // A first find, removed row included, is what a preview of the revival names.
    expect(await findStoredProject(root, "/repo")).toMatchObject({ id: project.id, deletedAt: expect.any(String) });
    const revived = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    expect(revived.created).toBe(false);
    expect(revived.revived).toBe(true);
    expect(revived.project.id).toBe(project.id);
    expect(revived.project.deletedAt).toBeNull();
    expect(revived.command).toBeNull();
    expect((await listStoredProjects(root)).map((entry) => entry.id)).toEqual([project.id]);
  });

  it("keeps every acknowledged registration: parallel ensures all persist, none fails to write", async () => {
    const root = await tmpRoot();
    // A registry mutation is a read, a transform and a whole-file write:
    // sixteen parallel ones could each acknowledge and keep only the last.
    const ensured = await Promise.all(
      Array.from({ length: 16 }, (_, index) => ensureStoredProject(root, { workspaceRoot: `/repo-${index}` })),
    );
    expect(ensured).toHaveLength(16);
    const stored = await listStoredProjects(root);
    expect(stored).toHaveLength(16);
    expect(new Set(stored.map((entry) => entry.id)).size).toBe(16);
    for (const entry of ensured) {
      expect(stored.some((row) => row.id === entry.project.id && workspaceRootsEqual(row.workspaceRoot, entry.project.workspaceRoot))).toBe(true);
    }
  });

  it("refuses a rename onto another live project's title", async () => {
    const root = await tmpRoot();
    const first = await ensureStoredProject(root, { workspaceRoot: "/one" });
    const second = await ensureStoredProject(root, { workspaceRoot: "/two" });
    await expect(renameStoredProject(root, second.project.id, first.project.title)).rejects.toMatchObject({
      code: "PROJECT_ALREADY_EXISTS",
    });
  });

  it("revives a removed project with a supplied title and keeps its id", async () => {
    const root = await tmpRoot();
    const { project } = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    await removeStoredProject(root, project.id);
    const revived = await ensureStoredProject(root, {
      workspaceRoot: "/repo",
      title: "  New   Name  ",
      id: "some-other-id",
    });
    expect(revived.created).toBe(false);
    expect(revived.project.id).toBe(project.id);
    expect(revived.project.title).toBe("New Name");
    expect(revived.project.deletedAt).toBeNull();
    expect(revived.command).toBeNull();
  });

  it("collapses inner whitespace in project titles", async () => {
    const root = await tmpRoot();
    const created = await ensureStoredProject(root, { workspaceRoot: "/zero", title: "zero   hero" });
    expect(created.project.title).toBe("zero hero");
    const first = await ensureStoredProject(root, { workspaceRoot: "/one" });
    const renamed = await renameStoredProject(root, first.project.id, "a  b");
    expect(renamed.title).toBe("a b");
    const second = await ensureStoredProject(root, { workspaceRoot: "/two" });
    await expect(renameStoredProject(root, second.project.id, "a   b")).rejects.toMatchObject({
      code: "PROJECT_ALREADY_EXISTS",
    });
  });

  it("refuses a rename onto a legacy title with extra whitespace but allows renaming it in place", async () => {
    const root = await tmpRoot();
    const first = await ensureStoredProject(root, { workspaceRoot: path.join(root, "one") });
    const second = await ensureStoredProject(root, { workspaceRoot: path.join(root, "two") });
    await writeFile(registryFile(root), JSON.stringify({
      version: 1,
      projects: [{ ...first.project, title: "a  b" }, second.project],
    }));

    await expect(renameStoredProject(root, second.project.id, "a b")).rejects.toMatchObject({
      code: "PROJECT_ALREADY_EXISTS",
      details: { conflictingProjectId: first.project.id },
    });
    await expect(renameStoredProject(root, first.project.id, "a b")).resolves.toMatchObject({
      id: first.project.id,
      title: "a b",
    });
  });
});
