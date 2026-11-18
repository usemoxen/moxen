import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureStoredProject,
  listStoredProjects,
  removeStoredProject,
  renameStoredProject,
  resolveStoredProject,
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
    const revived = await ensureStoredProject(root, { workspaceRoot: "/repo" });
    expect(revived.created).toBe(false);
    expect(revived.project.id).toBe(project.id);
    expect(revived.project.deletedAt).toBeNull();
    expect(revived.command).toBeNull();
    expect((await listStoredProjects(root)).map((entry) => entry.id)).toEqual([project.id]);
  });

  it("refuses a rename onto another live project's title", async () => {
    const root = await tmpRoot();
    const first = await ensureStoredProject(root, { workspaceRoot: "/one" });
    const second = await ensureStoredProject(root, { workspaceRoot: "/two" });
    await expect(renameStoredProject(root, second.project.id, first.project.title)).rejects.toMatchObject({
      code: "PROJECT_ALREADY_EXISTS",
    });
  });
});
