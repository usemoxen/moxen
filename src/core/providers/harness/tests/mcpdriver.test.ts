/**
 * What a harness session does with what it is given at start: MCP servers,
 * skills, instructions, isolation. The model is scripted; the MCP servers are
 * real child processes and a local server from `mcpfixtures.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InProcessMcpServerSpec, McpServerSpec } from "../../../mcp.js";
import { permissionActivityRow } from "../../../threads/requestactivity.js";
import type { ProviderRuntimeEvent } from "../../spi.js";
import { HarnessDriver } from "../driver.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent, TranscriptMessage } from "../types.js";
import { stdioSpec } from "./mcpfixtures.js";
import { rmTemp } from "../../../testing/tmp.js";

let dir: string;
let work: string;
const drivers: HarnessDriver[] = [];
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcpdriver-")));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => Effect.runPromise(driver.stopAll()).catch(() => {})));
  rmTemp(dir);
});

const selection = { instanceId: "harness/colab", model: "m" };
const config = { profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "m", contextWindow: 262_144 }] }] };
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

function driverWith(script: ModelEvent[][], extra: Partial<ConstructorParameters<typeof HarnessDriver>[0]> = {}) {
  const requests: ChatRequest[] = [];
  const driver = new HarnessDriver({
    config,
    sessionsDir: path.join(dir, "sessions"),
    home: path.join(dir, "home"),
    sleep: async () => {},
    transport: (request) => {
      requests.push(request);
      const step = script.shift();
      return (async function* () {
        if (!step) throw new Error("script exhausted");
        yield* step;
      })();
    },
    ...extra,
  });
  drivers.push(driver);
  const events: ProviderRuntimeEvent[] = [];
  void Effect.runPromise(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
  return { driver, requests, events };
}

const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } }, { type: "finish", reason: "tool-calls" }];
const answer = (text: string): ModelEvent[] => [{ type: "text.delta", text }, { type: "usage", usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0 } }, { type: "finish", reason: "stop" }];
const long = (tokens: number): string => "z".repeat(tokens * 4);

async function start(driver: HarnessDriver, extra: Record<string, unknown> = {}) {
  await run(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: selection, ...extra }));
}
async function send(driver: HarnessDriver, prompt: string) {
  const { turnId } = await run(driver.sendTurn({ threadId: "t1", prompt }));
  return await driver.awaitTurn("t1", turnId);
}
async function until(events: ProviderRuntimeEvent[], predicate: (event: ProviderRuntimeEvent) => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!events.some(predicate)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for an event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const toolNames = (request: ChatRequest) => request.tools.map((tool) => tool.name);
const systemOf = (request: ChatRequest) => String(request.messages[0]!.content);
const opened = (events: ProviderRuntimeEvent[]) => events.filter((event) => event.type === "permission.request.opened") as Array<{ requestId: string; raw: { toolName: string; classification?: string; input: Record<string, unknown> } }>;
const lastResult = (request: ChatRequest) => String(request.messages.at(-1)!.content);

const moxenTools: InProcessMcpServerSpec = {
  name: "moxen",
  type: "in-process",
  instructions: "Use delegate for side work.",
  tools: [
    { name: "delegate", description: "Hand off a task.", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
    { name: "task_status", description: "Where a task stands.", inputSchema: { type: "object", properties: { taskId: { type: "string" } } }, annotations: { readOnlyHint: true } },
  ],
  call: async (tool) => ({ text: `moxen ${tool} ok`, isError: false }),
  fallback: { name: "moxen", type: "stdio", command: "/never", args: [], env: {} },
};

describe("MCP tools in a session", () => {
  it("offers them after the built-in ones, sorted, tells the model how to treat their output, and sends the same set to a compaction", async () => {
    const { driver, requests } = driverWith([answer(long(3000)), answer(long(3000)), [{ type: "text.delta", text: "## Objective\nx" }, { type: "finish", reason: "stop" }]]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files"), moxenTools] });
    await send(driver, "first");
    await send(driver, "second");
    await send(driver, "/compact");
    const names = toolNames(requests[0]!);
    const mcp = names.filter((name) => name.startsWith("mcp__"));
    expect(mcp).toEqual([...mcp].sort());
    expect(mcp).toEqual(expect.arrayContaining(["mcp__files__echo", "mcp__moxen__delegate", "mcp__moxen__task_status"]));
    expect(names.slice(0, names.length - mcp.length).some((name) => name.startsWith("mcp__"))).toBe(false);
    expect(systemOf(requests[0]!)).toContain("# External tools (MCP)");
    expect(systemOf(requests[0]!)).toContain("<untrusted_context>");
    // moxen's own notes are trusted and passed on; a third-party server's are not.
    expect(systemOf(requests[0]!)).toContain("Use delegate for side work.");
    // The tool list does not move between turns, and the summary request carries it unchanged, with tools forbidden.
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    const ask = requests[2]!;
    expect(ask.tools).toEqual(requests[0]!.tools);
    expect(ask.toolChoice).toBe("none");
  });

  it("mentions no MCP and no skill tool in a session that has none", async () => {
    const { driver, requests } = driverWith([answer("hi")]);
    await start(driver);
    await send(driver, "go");
    expect(systemOf(requests[0]!)).not.toMatch(/MCP|mcp__|skill/);
    expect(toolNames(requests[0]!)).not.toContain("skill");
  });

  it("calls a tool and hands its result back marked as untrusted", async () => {
    const { driver, requests } = driverWith([call("c1", "mcp__files__evil", {}), answer("done")]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files")] });
    await send(driver, "go");
    const result = lastResult(requests[1]!);
    expect(result).toMatch(/^<untrusted_context source="mcp:files\/evil">/);
    expect(result.match(/<\/untrusted_context>/g)).toHaveLength(1);
  });

  it("calls the moxen tools in-process", async () => {
    const { driver, requests, events } = driverWith([call("c1", "mcp__moxen__delegate", { task: "look into x" }), answer("done")]);
    await start(driver, { mcpServers: [moxenTools], runtimeMode: "full-access" });
    await send(driver, "go");
    expect(lastResult(requests[1]!)).toContain("moxen delegate ok");
    // The activity ledger reads it like any tool row.
    expect(events.find((event) => event.type === "tool.execute.completed")).toMatchObject({ tool: "mcp__moxen__delegate" });
  });

  it("asks before a tool that changes things, shows the tool and its arguments, and remembers the answer per tool", async () => {
    const { driver, requests, events } = driverWith([call("c1", "mcp__files__write_thing", { path: "a" }), call("c2", "mcp__files__write_thing", { path: "b" }), answer("done")]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files")], runtimeMode: "approval-required" });
    const turn = await run(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await until(events, (event) => event.type === "permission.request.opened");
    expect(opened(events)[0]!.raw).toEqual({ toolName: "mcp__files__write_thing", input: { path: "a" } });
    expect(permissionActivityRow(events.find((event) => event.type === "permission.request.opened") as never).payload).toMatchObject({ toolName: "mcp__files__write_thing", detail: "a" });
    await run(driver.respondToRequest("t1", opened(events)[0]!.requestId, { kind: "acceptForSession" }));
    await expect(driver.awaitTurn("t1", turn.turnId)).resolves.toMatchObject({ status: "completed" });
    // The second call, with other arguments, did not ask again.
    expect(opened(events)).toHaveLength(1);
    expect(lastResult(requests[2]!)).toContain("done");
  });

  it("never asks about a tool the server marks read-only", async () => {
    const { driver, requests, events } = driverWith([call("c1", "mcp__files__echo", { text: "hi" }), answer("done")]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files")], runtimeMode: "approval-required" });
    await send(driver, "go");
    expect(opened(events)).toHaveLength(0);
    expect(lastResult(requests[1]!)).toContain("hi");
  });

  it("refuses, with the reason, a tool that needs approval in a session nobody can answer, and still runs a read-only one", async () => {
    const { driver, requests, events } = driverWith([call("c1", "mcp__files__write_thing", {}), call("c2", "mcp__files__echo", { text: "ok" }), answer("done")]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files")], runtimeMode: "approval-required", moxenSkills: "none", delegated: true });
    await send(driver, "go");
    expect(opened(events)).toHaveLength(0);
    expect(lastResult(requests[1]!)).toMatch(/Calling mcp__files__write_thing needs approval .* without anyone to ask/);
    expect(lastResult(requests[2]!)).toContain("ok");
  });

  it("tells the model a server is gone when it dies mid-call, and the user at the next turn when one never came up", async () => {
    const { driver, requests, events } = driverWith([call("c1", "mcp__files__die", {}), answer("done")]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files"), { name: "ghost", type: "stdio", command: "/no/such/program", args: [], env: {} }] });
    await send(driver, "go");
    expect(lastResult(requests[1]!)).toMatch(/files" stopped \(exited with code 3\)/);
    expect(events.filter((event) => event.type === "session.notice")).toEqual([
      expect.objectContaining({ notice: "mcp", title: "An MCP server or tool is unavailable", detail: expect.stringContaining('"ghost" is not available') }),
    ]);
  });

  it("holds the set of tools for the whole session: a change in the configured servers is said once and applies to the next session", async () => {
    const { driver, requests, events } = driverWith([answer("one"), answer("two"), answer("three")]);
    const first: McpServerSpec[] = [stdioSpec(dir, "files")];
    await start(driver, { mcpServers: first });
    await send(driver, "a");
    await driver.updateMcpServers("t1", [...first, stdioSpec(dir, "more")]);
    await driver.updateMcpServers("t1", [...first, stdioSpec(dir, "more")]);
    await send(driver, "b");
    await driver.updateMcpServers("t1", first);
    await send(driver, "c");
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(toolNames(requests[1]!).some((name) => name.startsWith("mcp__more__"))).toBe(false);
    expect(events.filter((event) => event.type === "session.notice")).toEqual([expect.objectContaining({ notice: "mcp", title: "MCP servers changed" })]);
  });

  it("starts a session once when two starts race, and ends its servers when it is stopped", async () => {
    const connects: string[] = [];
    const { driver } = driverWith([], { connectMcp: async (spec, cwd) => (connects.push(spec.name), (await import("../mcpclient.js")).McpClient.connect(spec, cwd)) });
    const input = { threadId: "t1", workingDirectory: work, modelSelection: selection, mcpServers: [stdioSpec(dir, "files")] };
    await Promise.all([run(driver.startSession(input)), run(driver.startSession(input))]);
    expect(connects).toEqual(["files"]);
    await run(driver.stopSession("t1"));
    await expect(run(driver.hasSession("t1"))).resolves.toBe(false);
  });
});

describe("isolation", () => {
  it("holds an MCP tool to it: a path or command in its arguments that reaches the main checkout is refused", async () => {
    const main = path.join(dir, "main");
    fs.mkdirSync(main);
    const isolation = { worktreeRoot: work, protectedRoots: [main] };
    const { driver, requests, events } = driverWith([
      call("c1", "mcp__files__write_thing", { path: path.join(main, "x.txt") }),
      call("c2", "mcp__files__write_thing", { command: `git -C ${main} reset --hard` }),
      call("c3", "mcp__files__write_thing", { path: path.join(work, "fine.txt") }),
      answer("done"),
    ]);
    await start(driver, { mcpServers: [stdioSpec(dir, "files")], runtimeMode: "full-access", isolation });
    await send(driver, "go");
    expect(lastResult(requests[1]!)).toMatch(/isolated in its own worktree/);
    expect(lastResult(requests[2]!)).toMatch(/isolated in its own worktree/);
    expect(lastResult(requests[3]!)).toContain("done");
    expect(opened(events)).toHaveLength(0);
  });

  it("sees through a symlink in the worktree for edits and for the shell alike", async () => {
    const main = path.join(dir, "main");
    fs.mkdirSync(main);
    fs.symlinkSync(main, path.join(work, "escape"));
    const { driver, requests } = driverWith([
      call("c1", "write", { file_path: path.join(work, "escape", "x.txt"), content: "y" }),
      call("c2", "bash", { command: "git -C escape status" }),
      answer("blocked"),
    ]);
    await start(driver, { runtimeMode: "full-access", isolation: { worktreeRoot: work, protectedRoots: [main] } });
    await send(driver, "go");
    expect(fs.existsSync(path.join(main, "x.txt"))).toBe(false);
    expect(lastResult(requests[1]!)).toMatch(/isolated in its own worktree/);
    expect(lastResult(requests[2]!)).toMatch(/isolated in its own worktree/);
  });
});

describe("skills", () => {
  const skill = (folder: string, name: string, description = `Does ${name}.`, extra = "") => {
    const where = path.join(folder, name);
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nStep one of ${name}.\n`);
    if (extra) fs.writeFileSync(path.join(where, extra), "{}");
  };
  const skillNames = (request: ChatRequest) => (request.tools.find((tool) => tool.name === "skill")?.parameters as { properties: { name: { enum: string[] } } } | undefined)?.properties.name.enum ?? null;

  beforeEach(() => {
    skill(path.join(work, ".claude", "skills"), "project-own");
    skill(path.join(work, ".claude", "skills"), "moxen-copy", "A copy moxen put here.", ".moxen-skill.json");
    skill(path.join(dir, "home", ".agents", "skills"), "user-own");
  });

  const firstRequest = async () => {
    const { driver, requests } = driverWith([answer("hi")]);
    await start(driver);
    await send(driver, "go");
    return requests[0]!;
  };

  it("offers the project's and the user's own skills, never a copy an older Moxen left", async () => {
    expect(skillNames(await firstRequest())).toEqual(["project-own", "user-own"]);
  });

  it("names the skill tool in the prompt only when it is offered, and loads a skill's text without its frontmatter", async () => {
    const { driver, requests } = driverWith([call("c1", "skill", { name: "project-own" }), answer("done")]);
    await start(driver);
    await send(driver, "go");
    expect(systemOf(requests[0]!)).toContain("The skill tool lists skills");
    expect(lastResult(requests[1]!)).toContain("Step one of project-own.");
    expect(lastResult(requests[1]!)).not.toContain("description:");
    expect(lastResult(requests[1]!)).toContain(path.join(work, ".claude", "skills", "project-own"));
  });

  it("does not name the skill tool when there are no skills", async () => {
    fs.rmSync(path.join(work, ".claude"), { recursive: true });
    fs.rmSync(path.join(dir, "home"), { recursive: true });
    const request = await firstRequest();
    expect(skillNames(request)).toBeNull();
    expect(systemOf(request)).not.toContain("skill");
  });
});

describe("instructions", () => {
  const rulesFile = () => fs.writeFileSync(path.join(work, "AGENTS.md"), "Always run the linter.\n");

  it("puts the project's rule file and moxen's instructions in the prompt, the rule file first", async () => {
    rulesFile();
    fs.writeFileSync(path.join(work, "CLAUDE.md"), "Claude-only rules.\n");
    const { driver, requests } = driverWith([answer("hi")]);
    await start(driver, { instructions: "You are isolated in a worktree." });
    await send(driver, "go");
    const prompt = systemOf(requests[0]!);
    expect(prompt).toContain("Always run the linter.");
    // AGENTS.md wins over CLAUDE.md in the same folder (`readProjectRules`).
    expect(prompt).not.toContain("Claude-only rules.");
    expect(prompt.indexOf("Always run the linter.")).toBeLessThan(prompt.indexOf("<moxen-instructions>"));
    expect(prompt).toContain("<moxen-instructions>\nYou are isolated in a worktree.\n</moxen-instructions>");
  });

  it("keeps the prompt it was started with across a resume and a compaction, and says only what changed", async () => {
    rulesFile();
    const first = driverWith([answer(long(3000)), answer(long(3000))]);
    await start(first.driver, { instructions: "Be brief.", mcpServers: [moxenTools] });
    await send(first.driver, "one");
    await send(first.driver, "two");
    const cursor = first.driver.resumeCursor("t1")!;
    const original = systemOf(first.requests[0]!);

    fs.writeFileSync(path.join(work, "AGENTS.md"), "Rules rewritten after the session began.\n");
    const second = driverWith([answer("ok"), [{ type: "text.delta", text: "## Objective\nx" }, { type: "finish", reason: "stop" }], answer("after")]);
    await start(second.driver, { resumeCursor: cursor, instructions: "Be brief.", mcpServers: [moxenTools] });
    await send(second.driver, "three");
    expect(systemOf(second.requests[0]!)).toBe(original);
    expect(JSON.stringify(second.requests[0]!.messages)).not.toContain("runtime instructions have changed");
    expect(JSON.stringify(second.requests[0]!.messages)).not.toContain("now has tools from MCP");

    await send(second.driver, "/compact");
    await send(second.driver, "four");
    const after = second.requests.at(-1)!;
    expect(systemOf(after)).toBe(original);
    const transcript = (second.driver as unknown as { sessions: Map<string, { transcript: { messages: readonly TranscriptMessage[] } }> }).sessions.get("t1")!.transcript.messages;
    expect(transcript[0]).toMatchObject({ role: "system" });
  });

  it("tells a resumed session that has gained MCP tools how to treat them, since its stored prompt does not", async () => {
    const first = driverWith([answer("hi")]);
    await start(first.driver);
    await send(first.driver, "one");
    const cursor = first.driver.resumeCursor("t1")!;
    const second = driverWith([answer("ok")]);
    await start(second.driver, { resumeCursor: cursor, mcpServers: [stdioSpec(dir, "files")] });
    await send(second.driver, "two");
    const sent = JSON.stringify(second.requests[0]!.messages);
    expect(sent).toContain("now has tools from MCP servers");
    expect(sent).toContain("untrusted_context");
  });
});
