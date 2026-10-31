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

describe("Moxen's own tools, switched per provider", () => {
  const moxenTools = async (providerConfig: Record<string, unknown>, global: Record<string, unknown> = {}) => {
    // The harness's installation default is OpenCode, so its section is the one in force.
    const { harness, connection, startOf } = await connected({ ...global, providers: { opencode: providerConfig } });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local" });
      const servers = (startOf(created.threadId)?.mcpServers ?? []) as Array<{ name: string; tools?: Array<{ name: string }> }>;
      const moxen = servers.find((server) => server.name === "moxen");
      return moxen === undefined ? null : (moxen.tools ?? []).map((tool) => tool.name).sort();
    } finally {
      await connection.close();
    }
  };

  it("keeps web_fetch with orchestration off, and the delegation tools with web_fetch off", async () => {
    const memory = ["memory_append", "memory_delete", "memory_edit", "memory_read", "memory_save"];
    const threads = ["thread_read", "thread_search"];
    expect(await moxenTools({})).toEqual(["delegate", ...memory, "models", "task_cancel", "task_status", ...threads, "web_fetch"]);
    expect(await moxenTools({ orchestration: false })).toEqual([...memory, "web_fetch"]);
    expect(await moxenTools({ webFetch: false })).toEqual(["delegate", ...memory, "models", "task_cancel", "task_status", ...threads]);
  });

  it("drops the server with both off and memory off, and reads the older all-at-once switch as both", async () => {
    const noMemory = { memory: false };
    expect(await moxenTools({ orchestration: false, webFetch: false }, noMemory)).toBeNull();
    expect(await moxenTools({ moxenTools: false }, noMemory)).toBeNull();
    expect(await moxenTools({ moxenTools: false, webFetch: true }, noMemory)).toEqual(["web_fetch"]);
    // Memory alone keeps the server, with its tools only.
    expect(await moxenTools({ moxenTools: false })).toEqual(["memory_append", "memory_delete", "memory_edit", "memory_read", "memory_save"]);
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

describe("Research and Orchestrate modes", () => {
  // OpenCode keeps the mode as an instruction entry (its driver's tests); the others hear of it in the prompt.
  const CLAUDE = { provider: "claudeAgent", model: "claude-opus-5" } as const;
  async function world() {
    const prompts: string[] = [];
    const harness = await testHarness({ onSendTurn: (input) => prompts.push(input.prompt) });
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => ({ ...harness.config }) });
    return { harness, prompts, connection };
  }
  const send = (connection: DirectConnection, threadId: string, text: string) =>
    connection.dispatch({ type: "thread.turn.start", threadId, message: { text }, wait: true });
  const setMode = (connection: DirectConnection, threadId: string, interactionMode: "default" | "research" | "orchestrate") =>
    connection.dispatch({ type: "thread.interaction-mode.set", threadId, interactionMode });

  it("tells the conversation of each switch once, ahead of the next prompt, and that a mode is off on the way back to Build", async () => {
    const { harness, prompts, connection } = await world();
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", ...CLAUDE });
      const id = created.threadId;
      expect(prompts).toEqual(["one"]);

      await setMode(connection, id, "research");
      await send(connection, id, "two");
      expect(prompts[1]).toContain('<moxen-mode key="moxen-research">');
      expect(prompts[1]).toContain("Research mode is on");
      expect(prompts[1]!.endsWith("two")).toBe(true);
      // The transcript keeps what was typed.
      expect((await harness.store.readMessages(id)).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["one", "two"]);

      // It lasts: the next prompt carries nothing more.
      await send(connection, id, "three");
      expect(prompts[2]).toBe("three");

      await setMode(connection, id, "default");
      await send(connection, id, "four");
      expect(prompts[3]).toContain("Research mode is off");
      expect(prompts[3]).not.toContain("Research mode is on");
    } finally {
      await connection.close();
    }
  });

  it("says it again after the turn that carried it is reverted", async () => {
    const { harness, prompts, connection } = await world();
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", ...CLAUDE });
      const id = created.threadId;
      await setMode(connection, id, "orchestrate");
      await send(connection, id, "two");
      expect(prompts[1]).toContain('<moxen-mode key="moxen-orchestrate">');
      await connection.dispatch({ type: "thread.conversation.revert", threadId: id, turnCount: 1 });
      await send(connection, id, "again");
      expect(prompts[2]).toContain('<moxen-mode key="moxen-orchestrate">');
    } finally {
      await connection.close();
    }
  });

  it("runs one prompt in a mode without changing the thread's, and tells the conversation when it is over", async () => {
    const { harness, prompts, connection } = await world();
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", ...CLAUDE });
      const id = created.threadId;
      await connection.dispatch({ type: "thread.turn.start", threadId: id, message: { text: "two" }, interactionMode: "research", wait: true });
      expect(prompts[1]).toContain('<moxen-mode key="moxen-research">');
      expect((await harness.store.readThreadRecord(id))?.interactionMode).toBe("default");
      expect((await harness.store.readTurns(id)).map((turn) => turn.interactionMode)).toEqual(["default", "research"]);

      // The next prompt is Build again, and the conversation is told so.
      await send(connection, id, "three");
      expect(prompts[2]).toContain("Research mode is off");
      await send(connection, id, "four");
      expect(prompts[3]).toBe("four");

      // Orchestrate is not a one-off to refuse: it works the same way.
      await connection.dispatch({ type: "thread.turn.start", threadId: id, message: { text: "five" }, interactionMode: "orchestrate", wait: true });
      expect(prompts[4]).toContain('<moxen-mode key="moxen-orchestrate">');
      expect((await harness.store.readThreadRecord(id))?.interactionMode).toBe("default");
    } finally {
      await connection.close();
    }
  });

  it("runs a delegated task in Research when its parent asks, and refuses Orchestrate", async () => {
    const { harness, connection } = await world();
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local", ...CLAUDE });
      const delegated = await connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Look into it", isolation: "shared", interactionMode: "research" });
      expect(delegated.interactionMode).toBe("research");
      await expect(
        connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Plan it", isolation: "shared", interactionMode: "orchestrate" }),
      ).rejects.toThrow(/never Orchestrate/u);
    } finally {
      await connection.close();
    }
  });

  it("runs a delegated task in Build whatever its parent's mode", async () => {
    const { harness, prompts, connection } = await world();
    try {
      const parent = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local", interactionMode: "orchestrate", ...CLAUDE });
      expect(prompts[0]).toContain('<moxen-mode key="moxen-orchestrate">');
      const delegated = await connection.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Sub task", isolation: "shared" });
      expect(delegated.interactionMode).toBe("default");
      expect(prompts.at(-1)).not.toContain("<moxen-mode");
    } finally {
      await connection.close();
    }
  });
});

describe("Moxen memory", () => {
  it("keeps the memory index out of the prompt, and points the rules at memory_read for it", async () => {
    const prompts: string[] = [];
    const starts: Array<Record<string, unknown>> = [];
    const harness = await testHarness({ onStartSession: (input) => starts.push(input), onSendTurn: (input) => prompts.push(input.prompt) });
    const open = () => new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => ({ ...harness.config }) });
    const first = open();
    try {
      const created = await first.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const id = created.threadId;
      // Memory on: its rules say where the index lives, and none of it is shipped in the prompt.
      expect(String(starts[0]?.instructions)).toContain("You have a persistent memory");
      expect(String(starts[0]?.instructions)).toContain("memory_read with no name returns the index");
      expect(starts[0]?.moxenMemory).toBe(true);

      await first.dispatch({ type: "memory.save", threadId: id, name: "bun-tests", description: "Tests run with bun", memoryType: "feedback", body: "Use bun test.", scope: "project" });
      await first.dispatch({ type: "thread.turn.start", threadId: id, message: { text: "two" }, wait: true });
      // The cached prompt is not rewritten, and no update rides along: the agent saved it, so it knows.
      expect(prompts[1]).toBe("two");
      await first.close();

      // A resume (a new process) starts the very same prompt, and a new thread gets no index either:
      // memory_read is the one place it is read, so it cannot go stale behind a cached prompt.
      const second = open();
      try {
        await second.dispatch({ type: "thread.turn.start", threadId: id, message: { text: "three" }, wait: true });
        expect(starts[1]?.instructions).toBe(starts[0]?.instructions);
        const other = await second.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "fresh", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
        const fresh = String(starts.find((input) => input.threadId === other.threadId)?.instructions);
        expect(fresh).not.toContain("bun-tests");
        expect(fresh).not.toContain("# Memory index");
      } finally {
        await second.close();
      }
    } finally {
      await first.close().catch(() => undefined);
    }
  });

  it("is off for a project whose moxen.json says so: no tools, no rules, Claude Code's memory left alone", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify({ memory: false }));
      const done = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const start = startOf(done.threadId)!;
      expect(String(start.instructions)).not.toContain("persistent memory");
      expect(start.moxenMemory).toBeUndefined();
      const moxen = (start.mcpServers as Array<{ name: string; tools?: Array<{ name: string }> }>).find((server) => server.name === "moxen");
      expect(moxen?.tools?.some((tool) => tool.name.startsWith("memory_"))).toBe(false);
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
  it("tells a plain local thread that it runs through Moxen, to research, and to report progress in short notes, then how to use its web tools", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      const done = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const instructions = String(startOf(done.threadId)?.instructions ?? "");
      expect(instructions.startsWith("# Environment\n\nIn case you're asked: you are running in Moxen,")).toBe(true);
      expect([...instructions.matchAll(/^# (.+)$/gm)].map((match) => match[1])).toEqual([
        "Environment",
        "Look it up",
        "Progress notes",
        "Showing images",
        "Layouts, charts and states",
        "Shell",
        "Messages from Moxen",
        "Memory",
        "Web",
      ]);
      // The layouts reach a session as it starts: the language the reply's block is tagged with, and a schema the parser reads.
      expect(instructions).toContain("```moxen-ui");
      // One provenance sentence for every block Moxen sends, and the web tips last.
      expect(instructions).toContain("Some messages come from Moxen, not from the person you are talking to.");
      expect(instructions).toContain("<task-notification>");
      expect(instructions).toContain("You have a persistent memory");
      expect(instructions).toContain("Using the web tools well:");
    } finally {
      await connection.close();
    }
  });

  it("hands a Claude session the tools the setting switches off, and drops their tips from its instructions", async () => {
    const { harness, connection, startOf } = await connected({ providers: { claude: { disabledNativeTools: "WebSearch, Bash" } } });
    try {
      const done = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const start = startOf(done.threadId);
      expect(start?.disabledNativeTools).toEqual(["WebSearch", "Bash"]);
      expect(start?.instructions).toContain("WebFetch:");
      expect(start?.instructions).not.toContain("WebSearch:");
    } finally {
      await connection.close();
    }
  });

  it("appends config instructions, then the project's moxen.json", async () => {
    const { harness, connection, startOf } = await connected({ instructions: "Config rule." });
    try {
      await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify({ instructions: "Project rule." }));
      const done = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      const text = String(startOf(done.threadId)?.instructions ?? "");
      expect(text.endsWith("Config rule.\n\nProject rule.")).toBe(true);
      expect(text.indexOf("Using the web tools well:")).toBeGreaterThan(text.indexOf("# Memory"));
      expect(text.indexOf("Using the web tools well:")).toBeLessThan(text.indexOf("Config rule."));
    } finally {
      await connection.close();
    }
  });

  it("routes native Codex through the server with its instructions and filtered MCP tools", async () => {
    const { harness, connection, startOf } = await connected({ instructions: "Global rule.", providers: { codex: { instructions: "Codex rule.", mcpExclude: "docs", disabledNativeTools: "web_search" } }, mcpServers: { docs: { command: "docs-mcp" } } });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "codex", model: "codex-default" });
      const start = startOf(created.threadId);
      expect(start?.instructions).toContain("Codex rule.");
      expect(start?.disabledNativeTools).toEqual(["web_search"]);
      expect((start?.mcpServers as Array<{ name: string }>).map((server) => server.name)).toEqual(["moxen"]);
      expect(start?.modelSelection).toMatchObject({ instanceId: "codex", model: "codex-default" });
    } finally { await connection.close(); }
  });

  it("puts a provider's own instructions between the global ones and the project's, for that provider only", async () => {
    const { harness, connection, startOf } = await connected({ instructions: "Config rule.", providers: { claude: { instructions: "Claude rule." } } });
    try {
      await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify({ instructions: "Project rule." }));
      const claude = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local", provider: "claudeAgent", model: "claude-opus-5" });
      expect(startOf(claude.threadId)?.instructions).toMatch(/\n\nConfig rule\.\n\nClaude rule\.\n\nProject rule\.$/);
      // The harness's installation default is OpenCode: it gets the global and the project's, not Claude's.
      const other = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Hi", wait: true, threadEnvMode: "local" });
      expect(startOf(other.threadId)?.instructions).toMatch(/\n\nConfig rule\.\n\nProject rule\.$/);
      expect(startOf(other.threadId)?.instructions).not.toContain("Claude rule.");
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
      // Nobody answers a delegated task's questions.
      expect(child.delegated).toBe(true);
      expect(startOf(parent.threadId)!.delegated).toBeUndefined();
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

describe("Moxen's skills, no longer shipped (MXN-138)", () => {
  const handover = (connection: DirectConnection, cwd: string) =>
    connection.dispatch({ type: "thread.handover", cwd, prompt: "go", wait: true, threadEnvMode: "local" });
  const copy = async (dir: string, name: string, marker: boolean) => {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "SKILL.md"), `---\ndescription: ${name}\n---\n`);
    if (marker) await writeFile(path.join(dir, name, ".moxen-skill.json"), JSON.stringify({ managedBy: "moxen", version: "old" }));
  };

  it("takes the copies an older Moxen made out of the project at session start, and leaves the user's own", async () => {
    const { harness, connection, startOf } = await connected();
    try {
      await copy(path.join(harness.work, ".claude", "skills"), "moxen-threads", true);
      await copy(path.join(harness.work, ".agents", "skills"), "moxen-handoff", true);
      await copy(path.join(harness.work, ".claude", "skills"), "mine", false);
      const created = await handover(connection, harness.work);
      expect(existsSync(path.join(harness.work, ".claude", "skills", "moxen-threads"))).toBe(false);
      expect(existsSync(path.join(harness.work, ".agents", "skills", "moxen-handoff"))).toBe(false);
      expect(existsSync(path.join(harness.work, ".claude", "skills", "mine", "SKILL.md"))).toBe(true);
      // Nothing about Moxen's skills reaches the driver any more.
      const start = startOf(created.threadId)!;
      for (const key of ["moxenSkills", "moxenSkillsFolder", "hiddenMoxenSkills"]) expect(start).not.toHaveProperty(key);
    } finally {
      await connection.close();
    }
  });

  it("still loads the older switches, which change nothing and write nothing into the project", async () => {
    for (const config of [{ skills: { moxen: "copy" } }, { installSkills: false }, { providers: { opencode: { moxenSkills: true } } }]) {
      const { harness, connection, startOf } = await connected(config);
      try {
        await mkdir(path.join(harness.work, ".claude"));
        const created = await handover(connection, harness.work);
        expect(startOf(created.threadId)).not.toHaveProperty("moxenSkills");
        expect(existsSync(path.join(harness.work, ".claude", "skills"))).toBe(false);
      } finally {
        await connection.close();
      }
    }
  });
});
