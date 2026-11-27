/**
 * The project tools (MXN-415, LOCAL-035): `project_list` and
 * `project_resolve` as reads, and `project_register` as the one registry
 * write an agent has — authorized inside the server, against the calling
 * thread's live state, never against the flags its session arrived with.
 * Everything runs through the real tool handler (`callMoxenTool`), the real
 * server connection and the real registry; the only fakes are the provider
 * drivers (`testHarness`). `project_register` takes no policy argument on
 * purpose: the configured `projectPolicy` decides, and these tests pin
 * that it is honoured, never bypassed.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runProcess } from "../../../core/infra/process.js";
import { testHarness } from "../../../core/testing/harness.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, fullyQualifiedFolder, moxenToolsFor, PROJECT_TOOLS } from "../tools.js";

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

/**
 * A connection with the harness's work folder registered and a thread in
 * it running in Full access, the world the tools run in. The fixture's own
 * ensure names the policy the CLI's --project-policy create does, so a
 * config's policy never decides it.
 */
async function setup(config: Record<string, unknown> = {}, runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access" = "full-access") {
  const { harness, connection } = await connect(config);
  const ensured = await connection.dispatch({ type: "project.ensure", cwd: harness.work, projectPolicy: "create" });
  const parent = await connection.dispatch({ type: "thread.create", projectId: ensured.project.id, runtimeMode });
  const register = async (args: Record<string, unknown>, threadId: string = parent.threadId) => callMoxenTool(connection, threadId, "project_register", args);
  return { harness, connection, work: real(harness.work), parentThreadId: parent.threadId, register };
}

const registered = (connection: DirectConnection) => connection.query({ type: "projects.list" }).then((result) => result.projects);
const list = (connection: DirectConnection) => callMoxenTool(connection, "any-thread", "project_list", {});
const resolve = (connection: DirectConnection, cwd: string) => callMoxenTool(connection, "any-thread", "project_resolve", { cwd });

describe("project tools: which sessions get them", () => {
  it("offers the reads to every session, and the register to none that must not write", () => {
    expect(moxenToolsFor({}).filter((tool) => PROJECT_TOOLS.some((project) => project.name === tool.name)).map((tool) => tool.name)).toEqual([
      "project_list",
      "project_resolve",
      "project_register",
    ]);
    // A delegated task (or a provider with orchestration switched off, which shares the flag) never sees the write.
    for (const options of [{ delegated: true }, { delegated: true, webFetch: false, memory: "off" as const }]) {
      expect(moxenToolsFor(options).map((tool) => tool.name)).toEqual(expect.arrayContaining(["project_list", "project_resolve"]));
      expect(moxenToolsFor(options).map((tool) => tool.name)).not.toContain("project_register");
    }
    // A research run's lead and roles never see it either; the listing is advice, the server authorizes the call.
    expect(moxenToolsFor({ researchMember: true }).map((tool) => tool.name)).not.toContain("project_register");
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
      expect(result.text).toContain("must be a fully qualified absolute path");
      expect(result.text).toContain("not resolved against your working directory");
      const badFlag = await register({ cwd: harness.root, dryRun: "yes" });
      expect(badFlag.isError).toBe(true);
      expect(badFlag.text).toContain("dryRun must be true or false");
    } finally {
      await connection.close();
    }
  });

  it("preserves a folder's exact path, one whose name ends in a space (POSIX: Windows cannot hold the name)", async () => {
    if (process.platform === "win32") return; // a Windows folder name cannot end in a space, so such a folder does not exist there.
    const { harness, connection, register } = await setup();
    try {
      const folder = path.join(harness.root, "proj-with-space ");
      await mkdir(folder);
      const created = await register({ cwd: folder });
      const canonical = JSON.parse(created.text) as { project: { workspaceRoot: string } };
      expect(canonical.project.workspaceRoot).toBe(real(folder));
      expect(canonical.project.workspaceRoot.endsWith("proj-with-space ")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("keeps every acknowledged registration: two concurrent ones both persist", async () => {
    const { harness, connection, register } = await setup();
    try {
      const folders = [path.join(harness.root, "proj-one"), path.join(harness.root, "proj-two")];
      for (const folder of folders) await mkdir(folder);
      const results = await Promise.all(folders.map((folder) => register({ cwd: folder })));
      for (const result of results) expect(result.isError).toBe(false);
      const roots = (await registered(connection)).map((entry) => entry.workspaceRoot);
      expect(roots).toEqual(expect.arrayContaining(folders.map((folder) => real(folder))));
    } finally {
      await connection.close();
    }
  });
});

describe("project_register: a removed project comes back", () => {
  it("reports a revival instead of saying nothing changed, and previews it with the original id", async () => {
    const { harness, connection, register, work } = await setup();
    try {
      const folder = path.join(harness.root, "proj-revive");
      await mkdir(folder);
      const first = await register({ cwd: folder });
      const project = JSON.parse(first.text) as { project: { id: string } };
      await connection.dispatch({ type: "project.remove", projectId: project.project.id });

      // The dry run previews the revival with the row's original id, not a synthesized one.
      const dry = await register({ cwd: folder, dryRun: true });
      expect(JSON.parse(dry.text)).toMatchObject({ dryRun: true, revived: true, created: false, project: { id: project.project.id, workspaceRoot: real(folder) } });
      expect(dry.text).toContain("would revive its original project");
      expect((await registered(connection)).some((entry) => entry.id === project.project.id)).toBe(false);

      const revived = await register({ cwd: folder });
      expect(JSON.parse(revived.text)).toMatchObject({ revived: true, created: false, project: { id: project.project.id } });
      expect(revived.text).toContain("Revived");
      expect(revived.text).not.toContain("nothing was changed");
      // The revival is in the registry with its threads' id, and the parent's own folder still resolves.
      expect((await registered(connection)).some((entry) => entry.id === project.project.id)).toBe(true);
      // The parent's own folder still resolves as already registered — a revival is not it.
      const existing = await register({ cwd: harness.work });
      expect(JSON.parse(existing.text)).toMatchObject({ created: false });
      expect(existing.text).toContain("already has a project");
    } finally {
      await connection.close();
    }
  });
});

describe("project_register: the server authorizes the calling thread, live", () => {
  it("registers from a thread running in Auto or Full access, and refuses the lower modes", async () => {
    for (const [mode, allowed] of [
      ["full-access", true],
      ["auto", true],
      ["auto-accept-edits", false],
      ["approval-required", false],
    ] as const) {
      const { harness, connection, register } = await setup({}, mode);
      try {
        const folder = path.join(harness.root, `mode-${mode}`);
        await mkdir(folder);
        const result = await register({ cwd: folder });
        if (allowed) {
          expect(result.isError).toBe(false);
          expect((JSON.parse(result.text) as { created: boolean }).created).toBe(true);
        } else {
          expect(result.isError).toBe(true);
          expect(result.text).toContain(`runs in ${mode}`);
          expect(result.text).toContain("Auto or Full access");
          expect(result.text).toContain("moxen projects ensure");
          expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(false);
        }
      } finally {
        await connection.close();
      }
    }
  });

  it("lets a lower-mode thread preview with dryRun, and refuses a thread that cannot be read", async () => {
    const { harness, connection, register } = await setup({}, "approval-required");
    try {
      const folder = path.join(harness.root, "preview");
      await mkdir(folder);
      const dry = await register({ cwd: folder, dryRun: true });
      expect(dry.isError).toBe(false);
      expect(JSON.parse(dry.text)).toMatchObject({ dryRun: true, created: true });
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(false);
    } finally {
      await connection.close();
    }
    // No thread to read: the registration refuses rather than answering as anyone.
    const { connection: refusedConnection, register: refusedRegister } = await setup();
    try {
      const refused = await refusedRegister({ cwd: harness.root }, "no-such-thread");
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("could not be read");
      expect(refused.text).toContain("refused rather than answered as anyone");
    } finally {
      await refusedConnection.close();
    }
  });

  it("fails closed when an authorization lookup throws, refusing the registration", async () => {
    const { harness, connection, register } = await setup();
    try {
      const folder = path.join(harness.root, "lookup-error");
      await mkdir(folder);
      // A lookup the server cannot complete: the delegations ledger cannot be read at all.
      const delegations = path.join(harness.root, "delegations.jsonl");
      await rm(delegations, { force: true });
      await mkdir(delegations);
      const refused = await register({ cwd: folder });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("could not be read");
      expect(refused.text).toContain("refused rather than answered as anyone");
      // Nothing was written behind the failed lookup.
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("cannot sneak a write past a mode tightening: the change serializes with the registration", async () => {
    const { harness, connection, register, parentThreadId } = await setup({}, "auto");
    try {
      // A git repository folder: resolving it runs git, a real async gap a
      // concurrent mode change would land in when the gate reads outside the
      // mutation. Here the gate and the write share the mode changes' chain,
      // so the tightening waits for the registration to finish.
      const folder = path.join(harness.root, "repo-gap");
      await mkdir(folder);
      await runProcess("git", ["init", "-b", "main"], { cwd: folder });
      const registration = connection.dispatch({ type: "project.register", threadId: parentThreadId, cwd: folder });
      const tightened = connection.dispatch({ type: "thread.runtime-mode.set", threadId: parentThreadId, runtimeMode: "approval-required" });
      let registrationDone = false;
      void registration.then(() => {
        registrationDone = true;
      }, () => {
        registrationDone = true;
      });
      await tightened;
      // The registration ran inside the mutation's chain link, so it had
      // already finished — read and write both — before the tightening landed.
      expect(registrationDone).toBe(true);
      const result = await registration;
      expect(result.created).toBe(true);
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(true);
      // And the tightened mode is what the next registration sees: refused.
      const after = path.join(harness.root, "after-tighten");
      await mkdir(after);
      const refused = await register({ cwd: after }, parentThreadId);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("runs in approval-required");
    } finally {
      await connection.close();
    }
  });

  it("refuses a delegated task however stale or missing its session flags are", async () => {
    const { harness, connection, register, parentThreadId } = await setup();
    try {
      // A real delegated task, with a real delegation row and a thread of its own.
      const delegated = await callMoxenTool(connection, parentThreadId, "delegate", { task: "Write the changelog", title: "changelog" });
      expect(delegated.isError).toBe(false);
      const taskId = (JSON.parse(delegated.text) as { taskId: string }).taskId;
      const folder = path.join(harness.root, "from-delegated");
      await mkdir(folder);
      // The transport flags say a plain orchestrator session (stale or spoofed):
      // the server answers for the thread as it sees it, and refuses.
      const refused = await register({ cwd: folder }, taskId);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("not available in a delegated task");
      expect(refused.text).toContain("Say what needs registering in your report");
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("refuses an active research run's lead and its roles, stale session flags or not", async () => {
    const { harness, connection, register, work } = await setup();
    try {
      const now = new Date().toISOString();
      const projectId = (await registered(connection)).find((entry) => entry.workspaceRoot === work)!.id;
      // The lead: a thread whose research run is live, started after its session was.
      const lead = await connection.dispatch({ type: "thread.create", projectId, runtimeMode: "full-access" });
      const leadRecord = await harness.store.readThreadRecord(lead.threadId);
      await harness.store.writeThreadRecord({
        ...leadRecord!,
        researchRun: { leadThreadId: lead.threadId, roles: [{ threadId: "role-x", role: "researcher", question: "Survey" }], state: "running", createdAt: now, updatedAt: now },
      });
      // One of the run's roles: its own thread carries the role, not the run.
      const role = await connection.dispatch({ type: "thread.create", projectId, runtimeMode: "full-access" });
      const roleRecord = await harness.store.readThreadRecord(role.threadId);
      await harness.store.writeThreadRecord({ ...roleRecord!, researchRole: { leadThreadId: lead.threadId, role: "researcher" } });
      const folder = path.join(harness.root, "from-research");
      await mkdir(folder);
      // Both call as a plain orchestrator session (no research flags): the live records refuse.
      const leadRefused = await register({ cwd: folder }, lead.threadId);
      expect(leadRefused.isError).toBe(true);
      expect(leadRefused.text).toContain("not available while a research run is active");
      const roleRefused = await register({ cwd: folder }, role.threadId);
      expect(roleRefused.isError).toBe(true);
      expect(roleRefused.text).toContain("not available in a research run");
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("refuses a thread whose provider has orchestration switched off, reading the live config", async () => {
    const { harness, connection, register } = await setup({ providers: { opencode: { orchestration: false } } });
    try {
      const folder = path.join(harness.root, "no-orchestration");
      await mkdir(folder);
      const refused = await register({ cwd: folder });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("orchestration switched off");
      expect((await registered(connection)).some((entry) => entry.workspaceRoot === real(folder))).toBe(false);
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
