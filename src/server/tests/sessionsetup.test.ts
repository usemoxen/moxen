/**
 * What a provider session starts with beyond its model — runtime
 * instructions — and delegation into a worktree of its own, observed
 * through the same `ClientApi` every client uses.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runProcess } from "../../core/infra/process.js";
import { testHarness } from "../../core/testing/harness.js";
import { DirectConnection } from "../connection.js";

async function connected(config: Record<string, unknown> = {}) {
  const starts: Array<Record<string, unknown>> = [];
  const harness = await testHarness({ onStartSession: (input) => starts.push(input) });
  const connection = new DirectConnection({
    storeRoot: harness.root,
    drivers: harness.drivers,
    config: async () => ({ ...harness.config, ...config }),
  });
  const startOf = (threadId: string) => starts.find((input) => input.threadId === threadId);
  return { harness, connection, startOf };
}

describe("MCP servers changed while a session lives", () => {
  it("gives the running session the servers of the day at each send, built-in tools included", async () => {
    const seen: string[][] = [];
    const harness = await testHarness({ onUpdateMcpServers: (_threadId, servers) => seen.push(servers.map((server) => server.name).sort()) });
    let extra: Record<string, { command: string }> = {};
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      config: async () => ({ ...harness.config, mcpServers: extra }),
    });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local" });
      // Config gains a server mid-session: the next send carries the new set (moxen's own tools stay in it).
      extra = { docs: { command: "docs-mcp" } };
      await connection.dispatch({ type: "thread.turn.start", threadId: created.threadId, message: { text: "two" }, wait: true });
      expect(seen.at(-1)).toEqual(["docs", "moxen"]);
    } finally {
      await connection.close();
    }
  });
});

describe("project rule files edited while a Claude session lives", () => {
  const UPDATE = "<moxen-context-update>";

  async function claudeWorld() {
    const starts: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];
    const harness = await testHarness({ onStartSession: (input) => starts.push(input), onSendTurn: (input) => prompts.push(input.prompt) });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => ({ ...harness.config }) });
    return { harness, starts, prompts, connection };
  }
  const send = (connection: DirectConnection, threadId: string, text: string) =>
    connection.dispatch({ type: "thread.turn.start", threadId, message: { text }, wait: true });

  it("sends the edit as a patch ahead of the next prompt, once, and never the whole file", async () => {
    const { harness, prompts, connection } = await claudeWorld();
    try {
      const filler = Array.from({ length: 40 }, (_, index) => `- standing rule ${index}`).join("\n");
      await writeFile(path.join(harness.work, "CLAUDE.md"), `# Rules\n${filler}\n- Use bun.\n`);
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const id = created.threadId;
      expect(prompts).toEqual(["one"]);

      // Edited while the session is live.
      await writeFile(path.join(harness.work, "CLAUDE.md"), `# Rules\n${filler}\n- Use bun.\n- Run bun run check before you finish.\n`);
      await send(connection, id, "two");
      expect(prompts[1]).toContain(UPDATE);
      expect(prompts[1]).toContain("+- Run bun run check before you finish.");
      expect(prompts[1]).not.toContain("standing rule 20");
      expect(prompts[1]?.endsWith("two")).toBe(true);

      // Delivered: the next prompt carries nothing more.
      await send(connection, id, "three");
      expect(prompts[2]).toBe("three");
    } finally {
      await connection.close();
    }
  });

  it("says nothing when the rules did not change", async () => {
    const { harness, prompts, connection } = await claudeWorld();
    try {
      await writeFile(path.join(harness.work, "CLAUDE.md"), "- Use bun.\n");
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      await send(connection, created.threadId, "two");
      expect(prompts).toEqual(["one", "two"]);
    } finally {
      await connection.close();
    }
  });

  it("leaves other providers' prompts alone", async () => {
    const { harness, prompts, connection } = await claudeWorld();
    try {
      await writeFile(path.join(harness.work, "AGENTS.md"), "- Use bun.\n");
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", provider: "opencode", model: "anthropic/claude-opus-5" });
      await writeFile(path.join(harness.work, "AGENTS.md"), "- Use bun.\n- Be brief.\n");
      await send(connection, created.threadId, "two");
      // OpenCode notices an AGENTS.md edit itself; a second notice from here would say it twice.
      expect(prompts.at(-1)).toBe("two");
    } finally {
      await connection.close();
    }
  });
});

describe("a change of instructions on a thread with history", () => {
  /**
   * Instructions the user can change between turns, a store that outlives each "process", and every start and
   * prompt the provider sees. A provider caches a conversation by its prefix, which starts at the system prompt.
   */
  async function world() {
    const starts: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];
    const harness = await testHarness({ onStartSession: (input) => starts.push(input), onSendTurn: (input) => prompts.push(input.prompt) });
    let instructions = "Rule A.";
    const open = () =>
      new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => ({ ...harness.config, instructions }) });
    return { harness, starts, prompts, open, setInstructions: (value: string) => (instructions = value) };
  }
  const UPDATE = "<moxen-instructions-update>";
  const send = (connection: DirectConnection, threadId: string, text: string) =>
    connection.dispatch({ type: "thread.turn.start", threadId, message: { text }, wait: true });

  it("keeps the system prompt it began with on every resume, and appends the change once, ahead of the next prompt", async () => {
    const { harness, starts, prompts, open, setInstructions } = await world();
    const first = open();
    try {
      const created = await first.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local" });
      const id = created.threadId;
      expect(String(starts.at(-1)?.instructions)).toContain("Rule A.");
      expect(prompts).toEqual(["one"]);

      // Changed while the session is live: the model hears of it with the next prompt, and the session is not restarted.
      setInstructions("Rule B.");
      await send(first, id, "two");
      expect(starts).toHaveLength(1);
      expect(prompts[1]).toContain(UPDATE);
      expect(prompts[1]).toContain("Rule B.");
      expect(prompts[1]!.endsWith("two")).toBe(true);
      // The transcript keeps what was typed.
      expect((await harness.store.readMessages(id)).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["one", "two"]);

      // Once: the model has it now.
      await send(first, id, "three");
      expect(prompts[2]).toBe("three");
      await first.close();

      // A restart (a new process: no live session) with another change: the session starts with the prompt the
      // conversation began with — never the new text — and the change rides ahead of the prompt.
      setInstructions("Rule C.");
      const second = open();
      try {
        await send(second, id, "four");
        expect(starts).toHaveLength(2);
        expect(String(starts[1]?.instructions)).toContain("Rule A.");
        expect(String(starts[1]?.instructions)).not.toContain("Rule C.");
        expect(starts[1]?.resumeCursor).toBeTruthy();
        expect(prompts[3]).toContain(UPDATE);
        expect(prompts[3]).toContain("Rule C.");
      } finally {
        await second.close();
      }

      // Unchanged since: a resume starts the same prompt and sends nothing extra.
      const third = open();
      try {
        await send(third, id, "five");
        expect(String(starts[2]?.instructions)).toContain("Rule A.");
        expect(prompts[4]).toBe("five");
      } finally {
        await third.close();
      }
    } finally {
      await first.close().catch(() => undefined);
    }
  });

  it("sends the update again after the turn that carried it is reverted", async () => {
    const { harness, prompts, open, setInstructions } = await world();
    const connection = open();
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local" });
      const id = created.threadId;
      setInstructions("Rule B.");
      await send(connection, id, "two");
      expect(prompts[1]).toContain(UPDATE);
      // Turn two is dropped, and the provider forgets it — update and all.
      await connection.dispatch({ type: "thread.conversation.revert", threadId: id, turnCount: 1 });
      await send(connection, id, "again");
      expect(prompts[2]).toContain(UPDATE);
      expect(prompts[2]).toContain("Rule B.");
      expect(prompts[2]!.endsWith("again")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("starts a conversation with no history on the current text", async () => {
    const { harness, starts, prompts, open, setInstructions } = await world();
    const connection = open();
    try {
      setInstructions("Rule B.");
      await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local" });
      expect(String(starts.at(-1)?.instructions)).toContain("Rule B.");
      expect(prompts).toEqual(["one"]);
    } finally {
      await connection.close();
    }
  });
});

describe("skills.list", () => {
  it("answers with the provider's inventory, or an empty one for a driver without one", async () => {
    const { harness, connection } = await connected();
    try {
      // The harness driver has no inventory of its own.
      expect(await connection.query({ type: "skills.list", instanceId: "opencode", cwd: harness.work })).toEqual({
        trigger: "/",
        skills: [],
        commands: [],
      });
      await expect(
        connection.query({ type: "skills.list", instanceId: "opencode" } as unknown as { type: "skills.list"; instanceId: string; cwd: string }),
      ).rejects.toMatchObject({ code: expect.any(String) });
    } finally {
      await connection.close();
    }
  });
});

describe("session setup", () => {
  it("tells a plain local thread only that it runs through Moxen, to research, and to report progress in short notes", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      const done = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const instructions = startOf(done.threadId)?.instructions ?? "";
      expect(instructions).toMatch(/^In case you're asked: you are running in Moxen, .* No need to mention this otherwise\.\n\nWhen the work depends on [^\n]*\n\nWhile you work, keep your messages to short progress notes[^\n]*\n\nA message may begin with a <moxen-instructions-update> block[^\n]*$/);
    } finally {
      await connection.close();
    }
  });

  it("appends config instructions, then the project's moxen.json", async () => {
    const { harness, connection, startOf } = await connected({ instructions: "Config rule." });
    try {
      await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify({ instructions: "Project rule." }));
      const done = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      expect(startOf(done.threadId)?.instructions).toMatch(/do not mention or quote it\.\n\nConfig rule\.\n\nProject rule\.$/);
    } finally {
      await connection.close();
    }
  });

  it("delegates into the child's own worktree and tells the child it is a delegated task", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const delegated = await connection.dispatch({
        type: "thread.delegate",
        parentThreadId: parent.threadId,
        task: "Sub task",
        isolation: "worktree",
      });
      expect(delegated.task).toMatchObject({ status: "completed" });
      const worktree = delegated.worktree!;
      expect(worktree.baseBranch).toBe("main");
      expect(worktree.branch).toMatch(/^moxen\//);
      expect(existsSync(worktree.path!)).toBe(true);
      // A real branch in the parent's repository, cut from its branch.
      const branches = await runProcess("git", ["branch", "--list", worktree.branch!], { cwd: harness.work });
      expect(branches.stdout).toContain(worktree.branch!);

      const child = startOf(delegated.child.id)!;
      expect(child.workingDirectory).toBe(worktree.path);
      expect(child.instructions).toContain("subagent");
      expect(child.instructions).toContain(`Commit your work on ${worktree.branch}`);
    } finally {
      await connection.close();
    }
  });

  it("dry-runs worktree isolation as a plan, provisioning nothing", async () => {
    const { harness, connection } = await connected();
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
      const plan = await connection.dispatch({
        type: "thread.delegate",
        parentThreadId: parent.threadId,
        task: "Sub task",
        isolation: "worktree",
        dryRun: true,
      });
      expect(plan.worktree).toEqual({ path: null, branch: null, baseBranch: "main" });
      const branches = await runProcess("git", ["branch", "--list", "moxen/*"], { cwd: harness.work });
      expect(branches.stdout.trim()).toBe("");
    } finally {
      await connection.close();
    }
  });
});

describe("moxen's own skills in a project", () => {
  const handover = (connection: DirectConnection, cwd: string) =>
    connection.dispatch({ type: "thread.handover", cwd, prompt: "go", wait: true, threadEnvMode: "local" });

  it("installs them into the project's .claude/skills and tells the session nothing else should offer them", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      await mkdir(path.join(harness.work, ".claude"));
      const created = await handover(connection, harness.work);
      expect(startOf(created.threadId)?.moxenSkills).toBe("project");
      expect(existsSync(path.join(harness.work, ".claude", "skills", "moxen-threads", "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(harness.work, ".agents"))).toBe(false);
      // Out of git's sight, not committed with the user's work.
      const status = await runProcess("git", ["status", "--porcelain"], { cwd: harness.work });
      expect(status.stdout).not.toContain("moxen-threads");
    } finally {
      await connection.close();
    }
  });

  it("uses .agents/skills in a project that only has .agents", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      await mkdir(path.join(harness.work, ".agents"));
      const created = await handover(connection, harness.work);
      expect(startOf(created.threadId)?.moxenSkills).toBe("project");
      expect(existsSync(path.join(harness.work, ".agents", "skills", "moxen-threads", "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(harness.work, ".claude"))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("writes nothing and has the provider served the bundled folder when there is no .claude or .agents", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      const created = await handover(connection, harness.work);
      expect(startOf(created.threadId)?.moxenSkills).toBe("served");
      expect(existsSync(path.join(harness.work, ".claude"))).toBe(false);
      expect(existsSync(path.join(harness.work, ".agents"))).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("leaves the project alone when the setting is off", async () => {
    const { harness, connection, startOf } = await connected({ installSkills: false });
    try {
      await mkdir(path.join(harness.work, ".claude"));
      const created = await handover(connection, harness.work);
      expect(startOf(created.threadId)?.moxenSkills).toBe("served");
      expect(existsSync(path.join(harness.work, ".claude", "skills"))).toBe(false);
    } finally {
      await connection.close();
    }
  });
});
