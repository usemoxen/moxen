/**
 * The project tools (`project_list`, `project_resolve`, `project_register`),
 * through the real tool handler (`callMoxenTool`), the real server
 * connection and the real registry. The only fakes are the provider drivers
 * (`testHarness`). `project_register` takes no policy argument on purpose:
 * the configured `projectPolicy` decides, and these tests pin that it is
 * honoured, never bypassed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testHarness } from "../../../core/testing/harness.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, moxenToolsFor, PROJECT_TOOLS } from "../tools.js";

/** Paths meet the registry once canonicalized: on macOS `/var` and `/private/var` are the same folder. */
const real = realpathSync.native;

async function connect(config: Record<string, unknown> = {}) {
  const harness = await testHarness({});
  const connection = new DirectConnection({
    storeRoot: harness.root,
    drivers: harness.drivers,
    config: async () => ({ ...harness.config, ...config }),
  });
  return { harness, connection };
}

/** A connection with the harness's work folder registered and a thread in it, the world the tools run in. */
async function setup(config: Record<string, unknown> = {}) {
  const { harness, connection } = await connect(config);
  // The fixture's own ensure names the policy the CLI's --project-policy create does, so a config's policy never decides it.
  const ensured = await connection.dispatch({ type: "project.ensure", cwd: harness.work, projectPolicy: "create" });
  const parent = await connection.dispatch({ type: "thread.create", projectId: ensured.project.id });
  const register = async (args: Record<string, unknown>) => callMoxenTool(connection, parent.threadId, "project_register", args);
  return { harness, connection, work: real(harness.work), parentThreadId: parent.threadId, register };
}

const registered = (connection: DirectConnection) => connection.query({ type: "projects.list" }).then((result) => result.projects);
const list = (connection: DirectConnection) => callMoxenTool(connection, "any-thread", "project_list", {});
const resolve = (connection: DirectConnection, cwd: string) => callMoxenTool(connection, "any-thread", "project_resolve", { cwd });

describe("project tools: which sessions get them", () => {
  it("lists every tool for an orchestrator, and keeps only the reads for a delegated task", () => {
    expect(moxenToolsFor({}).filter((tool) => PROJECT_TOOLS.some((project) => project.name === tool.name)).map((tool) => tool.name)).toEqual([
      "project_list",
      "project_resolve",
      "project_register",
    ]);
    expect(moxenToolsFor({ delegated: true }).map((tool) => tool.name)).toEqual(expect.arrayContaining(["project_list", "project_resolve"]));
    expect(moxenToolsFor({ delegated: true }).map((tool) => tool.name)).not.toContain("project_register");
  });

  it("refuses a delegated task the register call, naming it as the orchestrator's", async () => {
    const harness = await testHarness({});
    // The refusal comes before any query, so the api is never reached.
    const refused = await callMoxenTool({} as never, "task-1", "project_register", { cwd: harness.work }, { delegated: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("project_register is not available in a delegated task");
    expect(refused.text).toContain("Say what needs registering in your report");
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
      expect(result.text).toBe("No registered projects. Register a folder with project_register.");
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
});

describe("project_register", () => {
  it("registers an existing folder as a project, and says what already has one", async () => {
    const { harness, connection, register, work } = await setup();
    try {
      const folder = path.join(harness.root, "proj-a");
      await mkdir(folder);
      const registeredFolder = real(folder);
      const created = await register({ cwd: folder });
      expect(created.isError).toBe(false);
      expect(JSON.parse(created.text)).toMatchObject({
        project: { title: "proj-a", workspaceRoot: registeredFolder },
        workspaceRoot: registeredFolder,
        created: true,
      });
      expect(created.text).toContain("Registered: threads for this folder now live under this project");
      // It is in the registry the user's project list reads.
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === registeredFolder && entry.title === "proj-a")).toBe(true);
      // Registering the same folder again says what already has one, changing nothing.
      const again = await register({ cwd: folder });
      expect(JSON.parse(again.text)).toMatchObject({ created: false, workspaceRoot: registeredFolder });
      expect(again.text).toContain("already has a project");
      // The parent thread's own folder already has one: nothing changed there either.
      const existing = await register({ cwd: harness.work });
      expect(JSON.parse(existing.text)).toMatchObject({ created: false, project: { workspaceRoot: work } });
    } finally {
      await connection.close();
    }
  });

  it("dryRun reports what would be registered without writing it", async () => {
    const { harness, connection, register } = await setup();
    try {
      const folder = path.join(harness.root, "proj-b");
      await mkdir(folder);
      const registeredFolder = real(folder);
      const dry = await register({ cwd: folder, dryRun: true });
      expect(dry.isError).toBe(false);
      expect(JSON.parse(dry.text)).toMatchObject({ dryRun: true, created: true, project: { title: "proj-b", workspaceRoot: registeredFolder } });
      expect(dry.text).toContain("Dry run: nothing was written");
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === registeredFolder)).toBe(false);
      // The real call still registers it.
      const realRun = await register({ cwd: folder });
      expect(JSON.parse(realRun.text)).toMatchObject({ created: true });
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === registeredFolder)).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("honours a projectPolicy that refuses creation, instead of bypassing it", async () => {
    const { harness, connection, register, work } = await setup({ projectPolicy: "existing" });
    try {
      const folder = path.join(harness.root, "proj-c");
      await mkdir(folder);
      const registeredFolder = real(folder);
      const refused = await register({ cwd: folder });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("PROJECT_NOT_FOUND");
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === registeredFolder)).toBe(false);
      // A dry run is refused through the same path, never a preview of a write the policy forbids.
      const dry = await register({ cwd: folder, dryRun: true });
      expect(dry.isError).toBe(true);
      expect(dry.text).toContain("PROJECT_NOT_FOUND");
      // What the registry already holds is resolved either way, under the same policy.
      const existing = await register({ cwd: harness.work });
      expect(JSON.parse(existing.text)).toMatchObject({ created: false, project: { workspaceRoot: work } });
    } finally {
      await connection.close();
    }
  });

  it("refuses a folder that does not exist or is not a directory, creating nothing", async () => {
    const { harness, connection, register } = await setup();
    try {
      const missing = await register({ cwd: path.join(harness.root, "missing") });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("WORKSPACE_NOT_FOUND");
      const file = path.join(harness.root, "file.txt");
      await writeFile(file, "x");
      const notDir = await register({ cwd: file });
      expect(notDir.isError).toBe(true);
      expect(notDir.text).toContain("WORKSPACE_NOT_DIRECTORY");
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(file))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("refuses a relative path instead of resolving it against the server's own working directory", async () => {
    const { harness, connection, register } = await setup();
    try {
      const result = await register({ cwd: "some/folder" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("must be an absolute path");
      expect(result.text).toContain("not resolved against your working directory");
      const resolveToo = await resolve(connection, "some/folder");
      expect(resolveToo.isError).toBe(true);
      expect(resolveToo.text).toContain("must be an absolute path");
      const badFlag = await register({ cwd: harness.root, dryRun: "yes" });
      expect(badFlag.isError).toBe(true);
      expect(badFlag.text).toContain("dryRun must be true or false");
    } finally {
      await connection.close();
    }
  });
});
