/**
 * The project tools (MXN-415): `project_list` and `project_resolve`, the
 * registry as reads, through the real tool handler (`callMoxenTool`), the
 * real server connection and the real registry. The only fakes are the
 * provider drivers (`testHarness`). Registering a folder stays the user's
 * (`moxen projects ensure`), so no `project_register` tool may exist: these
 * tests pin that none is listed and that calling one answers "Unknown tool".
 */
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testHarness } from "../../../core/testing/harness.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, fullyQualifiedFolder, moxenToolsFor, PROJECT_TOOLS } from "../tools.js";

/** Paths meet the registry once canonicalized: on macOS `/var` and `/private/var` are the same folder. */
const real = realpathSync.native;

async function connect() {
  const harness = await testHarness({});
  const connection = new DirectConnection({
    storeRoot: harness.root,
    drivers: harness.drivers,
    config: async () => harness.config,
  });
  return { harness, connection };
}

/** A connection with the harness's work folder registered and a thread in it, the world the tools run in. */
async function setup() {
  const { harness, connection } = await connect();
  const ensured = await connection.dispatch({ type: "project.ensure", cwd: harness.work });
  const parent = await connection.dispatch({ type: "thread.create", projectId: ensured.project.id });
  return { harness, connection, work: real(harness.work), parentThreadId: parent.threadId };
}

const registered = (connection: DirectConnection) => connection.query({ type: "projects.list" }).then((result) => result.projects);
const list = (connection: DirectConnection) => callMoxenTool(connection, "any-thread", "project_list", {});
const resolve = (connection: DirectConnection, cwd: string) => callMoxenTool(connection, "any-thread", "project_resolve", { cwd });

describe("project tools: which sessions get them", () => {
  it("offers the registry reads and never a register, to any session and every switch", () => {
    expect(moxenToolsFor({}).filter((tool) => PROJECT_TOOLS.some((project) => project.name === tool.name)).map((tool) => tool.name)).toEqual([
      "project_list",
      "project_resolve",
    ]);
    // The reads ride along unconditionally, so the stripped sessions (delegated, web off, memory off) keep them.
    for (const options of [{ delegated: true }, { delegated: true, webFetch: false, memory: "off" as const }]) {
      expect(moxenToolsFor(options).map((tool) => tool.name)).toEqual(expect.arrayContaining(["project_list", "project_resolve"]));
    }
    // No tool that writes the registry exists to offer: registering is the user's.
    expect(moxenToolsFor({}).map((tool) => tool.name)).not.toContain("project_register");
  });

  it("refuses project_register when it is called anyway, having never been shown", async () => {
    const { connection } = await connect();
    try {
      const refused = await callMoxenTool(connection, "any-thread", "project_register", { cwd: path.join("/") });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Unknown tool: project_register");
    } finally {
      await connection.close();
    }
  });
});

describe("project_list", () => {
  it("shows the registered projects as `moxen projects list` does, leaving the scratch entry out", async () => {
    const { harness, connection, work } = await setup();
    try {
      // A scratch thread creates the one shared "No project" entry: a real project's list never names it.
      await connection.dispatch({ type: "thread.create", scratch: true });
      const result = await list(connection);
      expect(result.isError).toBe(false);
      const project = (await registered(connection)).find((entry) => entry.workspaceRoot === work);
      expect(result.text).toContain(`- ${project!.id} · ${work} · work`);
      expect(result.text).not.toContain("No project");
    } finally {
      await connection.close();
    }
  });

  it("says so when nothing is registered", async () => {
    const { connection } = await connect();
    try {
      const result = await list(connection);
      expect(result.isError).toBe(false);
      expect(result.text).toBe("No registered projects. Registering a folder is the user's (`moxen projects ensure`).");
    } finally {
      await connection.close();
    }
  });
});

describe("project_resolve", () => {
  it("resolves a folder to its project, with the workspace read the CLI gives", async () => {
    const { harness, connection, work } = await setup();
    try {
      const result = await resolve(connection, harness.work);
      expect(result.isError).toBe(false);
      const project = (await registered(connection)).find((entry) => entry.workspaceRoot === work);
      expect(JSON.parse(result.text)).toMatchObject({
        workspace: { workspaceRoot: work, isGitRepository: true },
        project: { id: project!.id, title: "work", workspaceRoot: work },
      });
    } finally {
      await connection.close();
    }
  });

  it("reports no project for a folder outside any, without listing one", async () => {
    const { harness, connection } = await setup();
    try {
      const outside = path.join(harness.root, "outside");
      await mkdir(outside);
      const result = await resolve(connection, outside);
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.text) as { project: unknown; note: string };
      expect(parsed.project).toBeNull();
      expect(parsed.note).toContain("No project for");
    } finally {
      await connection.close();
    }
  });

  it("refuses a folder that does not exist or is not a directory", async () => {
    const { harness, connection } = await setup();
    try {
      const missing = await resolve(connection, path.join(harness.root, "missing"));
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("WORKSPACE_NOT_FOUND");
      const file = path.join(harness.root, "file.txt");
      await writeFile(file, "x");
      const notDir = await resolve(connection, file);
      expect(notDir.isError).toBe(true);
      expect(notDir.text).toContain("WORKSPACE_NOT_DIRECTORY");
    } finally {
      await connection.close();
    }
  });

  it("refuses a relative path instead of resolving it against the server's own working directory", async () => {
    const { connection } = await setup();
    try {
      const result = await resolve(connection, "some/folder");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("must be a fully qualified absolute path");
      expect(result.text).toContain("not resolved against your working directory");
    } finally {
      await connection.close();
    }
  });

  it("preserves a folder's exact path, one whose name ends in a space (POSIX: Windows cannot hold the name)", async () => {
    if (process.platform === "win32") return; // a Windows folder name cannot end in a space, so such a folder does not exist there.
    const { harness, connection } = await setup();
    try {
      const folder = path.join(harness.root, "proj-with-space ");
      await mkdir(folder);
      const result = await resolve(connection, folder);
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.text) as { workspace: { workspaceRoot: string } };
      expect(parsed.workspace.workspaceRoot).toBe(real(folder));
      expect(parsed.workspace.workspaceRoot.endsWith("proj-with-space ")).toBe(true);
    } finally {
      await connection.close();
    }
  });
});

describe("fullyQualifiedFolder: only a complete path may name a folder", () => {
  it("takes a Windows volume or UNC share, and refuses what resolves against something else", () => {
    const win32 = [
      ["C:\\folder", true],
      ["c:/folder", true],
      ["\\\\server\\share\\folder", true],
      ["\\\\server\\share", true],
      ["\\\\server", false], // a UNC server without a share names no folder
      ["\\\\server\\", false], // nor with a trailing separator: Windows reads it on the current drive
      ["//server/", false],
      ["\\\\server\\\\", false],
      ["//server/share", true], // either separator names the same share
      ["\\\\", false],
      ["C:\\", true], // a drive root keeps its separator
      ["/folder", false], // path.isAbsolute says true on win32 without a volume; a volume is what makes it a folder
      ["C:folder", false], // drive-relative: the current folder on C
      ["C:", false],
      ["folder\\x", false],
    ] as const;
    for (const [value, expected] of win32) expect(fullyQualifiedFolder(value, "win32")).toBe(expected);
    const darwin = [
      ["/folder", true],
      ["C:\\folder", false],
      ["folder", false],
    ] as const;
    for (const [value, expected] of darwin) expect(fullyQualifiedFolder(value, "darwin")).toBe(expected);
  });
});
