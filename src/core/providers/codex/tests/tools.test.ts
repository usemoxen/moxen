import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rmTemp } from "../../../testing/tmp.js";
import { userInputActivityRow } from "../../../threads/requestactivity.js";
import { McpClient } from "../../harness/mcpclient.js";
import type { ProviderRuntimeEvent, ProviderSessionStartInput } from "../../spi.js";
import { CodexDriver } from "../driver.js";
import { CODEX_HARNESS_SERVER } from "../tools.js";
import { FakeCodexTransport } from "./fakes.js";

let dir: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tools-")); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); await rmTemp(dir); });
const shell = process.platform === "win32" ? "powershell" : "bash";
const waiting = process.platform === "win32" ? "Write-Output ready; Start-Sleep -Seconds 60" : "echo ready; sleep 60";
const signal = new AbortController().signal;

async function setup(options: Partial<ProviderSessionStartInput> = {}) {
  const transport = new FakeCodexTransport();
  const driver = new CodexDriver({ transport });
  const events: ProviderRuntimeEvent[] = [];
  const fiber = Effect.runFork(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => { events.push(event); })));
  cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
  cleanup.push(() => Effect.runPromise(driver.stopAll()));
  await Effect.runPromise(driver.startSession({ threadId: "thread", workingDirectory: dir, ...options }));
  const server = transport.sessions[0]!.server;
  const params = (server.requestsTo(options.resumeCursor ? "thread/resume" : "thread/start")[0]!.params as { config: Record<string, unknown> });
  const endpoint = params.config[`mcp_servers.${CODEX_HARNESS_SERVER}`] as { url: string; http_headers: Record<string, string> };
  const client = await McpClient.connect({ type: "http", name: CODEX_HARNESS_SERVER, url: endpoint.url, headers: endpoint.http_headers }, dir);
  cleanup.push(() => client.close());
  await Effect.runPromise(driver.sendTurn({ threadId: "thread", prompt: "Work" }));
  const opened = async (type: "permission.request.opened" | "user-input.request.opened", since = 0) => {
    await expect.poll(() => events.slice(since).some((event) => event.type === type)).toBe(true);
    return events.slice(since).find((event) => event.type === type)! as ProviderRuntimeEvent & { requestId: string };
  };
  return { driver, client, server, events, opened, endpoint };
}

describe("Codex Harness tools over MCP", () => {
  it("routes questions from a resumed conversation through the answer panel, including dismiss and interrupt", async () => {
    const { client, driver, opened, events } = await setup({ resumeCursor: "old-rollout" });
    const call = () => client.call("ask", { questions: [{ question: "Which layout?", options: [{ label: "Sidebar" }], multiSelect: true }] }, signal);
    const answer = call();
    const request = await opened("user-input.request.opened");
    if (request.type !== "user-input.request.opened") throw new Error("Expected user input");
    expect(userInputActivityRow(request)?.payload).toMatchObject({ questions: [{ id: "Which layout?", multiSelect: true, options: [{ label: "Sidebar" }] }] });
    await Effect.runPromise(driver.respondToUserInput("thread", request.requestId, { "Which layout?": "Sidebar" }));
    expect(await answer).toMatchObject({ text: expect.stringContaining('"Which layout?" = "Sidebar"'), isError: false });
    let since = events.length;
    const dismiss = call();
    await Effect.runPromise(driver.respondToRequest("thread", (await opened("user-input.request.opened", since)).requestId, { kind: "decline" }));
    expect((await dismiss).text).toContain("dismissed");
    since = events.length;
    const interrupt = call();
    await opened("user-input.request.opened", since);
    await Effect.runPromise(driver.interruptTurn("thread"));
    await interrupt;
    expect(events.filter((event) => event.type === "user-input.request.resolved")).toHaveLength(3);
  });

  it("checks commands before spawning and remembers approval only for the matching command pattern", async () => {
    const { client, driver, opened, events } = await setup({ runtimeMode: "approval-required" });
    const call = client.call(shell, { command: "echo approved > allowed.txt" }, signal);
    const request = await opened("permission.request.opened");
    expect(fs.existsSync(path.join(dir, "allowed.txt"))).toBe(false);
    await expect(Effect.runPromise(driver.respondToUserInput("thread", request.requestId, {}))).rejects.toThrow(/permission/);
    await Effect.runPromise(driver.respondToRequest("thread", request.requestId, { kind: "acceptForSession" }));
    expect((await call).isError).toBe(false);
    expect(fs.existsSync(path.join(dir, "allowed.txt"))).toBe(true);
    const since = events.length;
    expect((await client.call(shell, { command: "echo approved > allowed.txt" }, signal)).isError).toBe(false);
    const denied = client.call(shell, { command: "echo denied > denied.txt" }, signal);
    const second = await opened("permission.request.opened", since);
    await Effect.runPromise(driver.respondToRequest("thread", second.requestId, { kind: "decline" }));
    expect((await denied).isError).toBe(true);
    expect(fs.existsSync(path.join(dir, "denied.txt"))).toBe(false);
  });

  it("keeps background commands across turn interruption and stops only the selected process", async () => {
    const { client, driver, events } = await setup();
    await client.call(shell, { command: waiting, run_in_background: true }, signal);
    await client.call(shell, { command: waiting, run_in_background: true }, signal);
    const [first, second] = driver.backgroundTasks("thread");
    expect(first?.stoppable).toBe(true);
    await expect.poll(async () => (await driver.backgroundTaskOutput("thread", first!.taskId))?.lines.join("\n")).toContain("ready");
    await Effect.runPromise(driver.interruptTurn("thread"));
    expect(driver.backgroundTasks("thread")).toHaveLength(2);
    await Effect.runPromise(driver.stopBackgroundTask("thread", first!.taskId));
    expect(driver.backgroundTasks("thread").map((task) => task.taskId)).toEqual([second!.taskId]);
    expect(events.some((event) => event.type === "background.task" && event.taskId === first!.taskId && event.status === "stopped")).toBe(true);
    await Effect.runPromise(driver.sendTurn({ threadId: "thread", prompt: "Continue" }));
    expect((await client.call("task_output", { task_id: first!.taskId }, signal)).text).toContain("stopped");
    expect((await client.call("task_stop", { task_id: second!.taskId }, signal)).text).toContain("stopped");
    expect(driver.backgroundTasks("thread")).toEqual([]);
  });

  it("interrupts a foreground command and refuses stale or malformed calls", async () => {
    const { client, driver } = await setup();
    expect((await client.call(shell, { command: [] }, signal)).isError).toBe(true);
    const call = client.call(shell, { command: waiting }, signal);
    // A second read-only call completes after the server has accepted the first.
    await client.call("task_output", { task_id: "missing" }, signal);
    await Effect.runPromise(driver.interruptTurn("thread"));
    expect((await call).isError).toBe(true);
    expect((await client.call(shell, { command: "echo stale > stale.txt" }, signal)).isError).toBe(true);
    expect(fs.existsSync(path.join(dir, "stale.txt"))).toBe(false);
  });

  it("enforces worktree isolation before approval and refuses unattended approval requests", async () => {
    const main = path.join(dir, "main");
    fs.mkdirSync(main);
    const { client, events } = await setup({ delegated: true, runtimeMode: "approval-required", isolation: { worktreeRoot: path.join(dir, "work"), protectedRoots: [main] } });
    expect(client.tools.map((tool) => tool.name)).not.toContain("ask");
    expect((await client.call(shell, { command: `git -C "${main}" status` }, signal)).text).toContain("main checkout");
    expect((await client.call(shell, { command: "echo denied > denied.txt" }, signal)).isError).toBe(true);
    expect(fs.existsSync(path.join(dir, "denied.txt"))).toBe(false);
    expect(events.some((event) => event.type === "permission.request.opened")).toBe(false);
  });

  it("keeps disabled shells disabled and authenticates the per-session endpoint", async () => {
    const { client, endpoint } = await setup({ disabledNativeTools: ["shell"] });
    expect(client.tools.map((tool) => tool.name)).not.toContain(shell);
    expect((await client.call(shell, { command: "echo denied" }, signal)).isError).toBe(true);
    expect((await fetch(endpoint.url, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it.each(["ask", shell])("releases a parked %s call when its MCP connection is cancelled", async (tool) => {
    const { client, events, opened } = await setup({ runtimeMode: "approval-required" });
    const controller = new AbortController();
    const call = client.call(tool, tool === "ask" ? { questions: [{ question: "Continue?" }] } : { command: "echo denied > denied.txt" }, controller.signal);
    const outcome = call.catch(() => null);
    const type = tool === "ask" ? "user-input.request.opened" : "permission.request.opened";
    const request = await opened(type);
    controller.abort();
    await outcome;
    await expect.poll(() => events.some((event) => (event.type === "user-input.request.resolved" || event.type === "permission.request.resolved") && event.requestId === request.requestId)).toBe(true);
    expect(fs.existsSync(path.join(dir, "denied.txt"))).toBe(false);
  });

  it("removes configured profile key variables from foreground and background commands", async () => {
    vi.stubEnv("MXN207_PROFILE_KEY", "present");
    const { client, driver } = await setup();
    driver.setSecretEnv(["MXN207_PROFILE_KEY"]);
    const command = process.platform === "win32" ? "if ($env:MXN207_PROFILE_KEY) { exit 7 }" : 'test -z "$MXN207_PROFILE_KEY"';
    expect((await client.call(shell, { command }, signal)).isError).toBe(false);
    await client.call(shell, { command, run_in_background: true }, signal);
    const taskId = driver.backgroundTasks("thread")[0]!.taskId;
    await expect.poll(async () => (await client.call("task_output", { task_id: taskId, wait_ms: 500 }, signal)).text).toContain("exit code 0");
  });
});
