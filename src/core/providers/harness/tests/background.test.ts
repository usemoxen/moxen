import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "../../spi.js";
import { BackgroundShells, MAX_RUNNING, type BackgroundEvent } from "../background.js";
import { HarnessDriver } from "../driver.js";
import { bashTool } from "../tools/bash.js";
import { findPosixShell } from "../tools/shell.js";
import { taskOutputTool, taskStopTool } from "../tools/background.js";
import { ReadState, type ToolContext } from "../tools/types.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent } from "../types.js";
import { rmTemp } from "../../../testing/tmp.js";

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bg-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
});
afterEach(() => rmTemp(dir));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const signal = new AbortController().signal;

/** Prints the pid `process.kill` knows: Git Bash's `$$` is an MSYS pid, and its Windows one is in `/proc`. */
const PRINT_PID = process.platform === "win32" ? "cat /proc/$$/winpid" : "echo $$";

describe("BackgroundShells", () => {
  const make = () => {
    const events: BackgroundEvent[] = [];
    const shells = new BackgroundShells({ artifactDir: path.join(dir, "art"), onEvent: (event) => events.push(event) });
    return { shells, events };
  };
  const start = (shells: BackgroundShells, command: string) => shells.start({ command, cwd: work, shell: findPosixShell()!, description: command, toolUseId: "call_1" });

  it("hands over output once, waits for something to happen, and reports how the command ended", async () => {
    const { shells, events } = make();
    const task = start(shells, "echo first; sleep 0.3; echo second; exit 3");
    const first = await shells.read(task.id, { waitMs: 5000, signal });
    expect(first!.output).toBe("first\n");
    expect(first!.task.status).toBe("running");
    const rest = await shells.read(task.id, { waitMs: 5000, signal });
    expect(rest!.output).toBe("second\n");
    const end = await shells.read(task.id, { waitMs: 5000, signal });
    expect(end).toMatchObject({ output: "", task: { status: "failed", exitCode: 3 } });
    expect(events.map((event) => event.type)).toEqual(["started", "ended"]);
    expect(shells.endSeen(task.id)).toBe(true);
    expect(await shells.read("bg_nope", { waitMs: 0, signal })).toBeNull();
  });

  it("stops the process it spawned and its children, and does not signal anything once it has ended", async () => {
    const { shells } = make();
    const task = start(shells, `${PRINT_PID}; (sleep 60 &) ; exec sleep 60`);
    const pid = Number((await shells.read(task.id, { waitMs: 5000, signal }))!.output.trim());
    expect(alive(pid)).toBe(true);
    await expect(shells.stop(task.id)).resolves.toBe(true);
    expect(await gone(pid)).toBe(true);
    expect(shells.get(task.id)!.status).toBe("stopped");
    await expect(shells.stop(task.id)).resolves.toBe(false);
  });

  it("ends every running command with the session and starts nothing after, and caps how many run at once", async () => {
    const { shells } = make();
    const tasks = Array.from({ length: MAX_RUNNING }, () => start(shells, `${PRINT_PID}; exec sleep 60`));
    expect(() => start(shells, "true")).toThrow(/already running/);
    const pids = await Promise.all(tasks.map(async (task) => Number((await shells.read(task.id, { waitMs: 5000, signal }))!.output.trim())));
    shells.stopAll();
    expect(() => start(shells, "true")).toThrow(/closing/);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
  });
});

describe("the background tools", () => {
  const context = (shells?: BackgroundShells): ToolContext => ({ cwd: work, signal, readState: new ReadState(), artifactDir: path.join(dir, "art"), callId: "call_9", ...(shells ? { background: shells } : {}) });

  it("starts a command and returns its id at once, and says plainly when background commands are not available", async () => {
    const shells = new BackgroundShells({ artifactDir: path.join(dir, "art"), onEvent: () => {} });
    const started = await bashTool.run({ command: "sleep 60", description: "wait", run_in_background: true }, context(shells));
    const id = shells.running()[0]!.id;
    expect(started.content).toContain(id);
    expect(shells.running()[0]).toMatchObject({ toolUseId: "call_9", description: "wait" });
    const stopped = await taskStopTool.run({ task_id: id }, context(shells));
    expect(stopped.content).toMatch(/stopped/);
    expect((await taskStopTool.run({ task_id: id }, context(shells))).content).toMatch(/had already stopped/);
    expect(await bashTool.run({ command: "true", run_in_background: true }, context())).toMatchObject({ isError: true });
    expect(await taskOutputTool.run({ task_id: id }, context())).toMatchObject({ isError: true });
    expect(await taskOutputTool.run({ task_id: "bg_zzzz" }, context(shells))).toMatchObject({ isError: true, content: expect.stringContaining("no background task") });
  });
});

describe("HarnessDriver background commands", () => {
  const config = { profiles: [{ id: "colab", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "m" }] }] };
  const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } }, { type: "finish", reason: "tool-calls" }];
  const say = (text: string): ModelEvent[] => [{ type: "text.delta", text }, { type: "finish", reason: "stop" }];

  function driverWith(script: ModelEvent[][]) {
    const requests: ChatRequest[] = [];
    const driver = new HarnessDriver({
      config,
      sessionsDir: path.join(dir, "sessions"),
      home: dir,
      sleep: async () => {},
      transport: (request) => {
        requests.push(request);
        const step = script.shift();
        return (async function* () {
          if (!step) throw new Error("script exhausted");
          yield* step;
        })();
      },
    });
    const events: ProviderRuntimeEvent[] = [];
    void Effect.runPromise(Stream.runForEach(driver.streamEvents, (event) => Effect.sync(() => void events.push(event))));
    return { driver, requests, events };
  }

  const until = async (check: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("publishes the task events the tasks panel reads, tells the model when a command ends, and kills what is left when the session stops", async () => {
    const { driver, requests, events } = driverWith([
      call("c1", "bash", { command: `${PRINT_PID}; exec sleep 60`, description: "sleeper", run_in_background: true }),
      call("c2", "bash", { command: "echo done", description: "quick", run_in_background: true }),
      say("Both started."),
      say("Noted."),
    ]);
    await Effect.runPromise(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: { instanceId: "harness/colab", model: "m" } }));
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await driver.awaitTurn("t1", turnId);
    await until(() => events.some((event) => event.type === "background.task" && event.status === "completed"));
    const started = events.filter((event) => event.type === "background.task") as Array<Extract<ProviderRuntimeEvent, { type: "background.task" }>>;
    expect(started[0]).toMatchObject({ status: "started", description: "sleeper", taskType: "local_bash", toolUseId: "c1" });
    expect(driver.backgroundTasks("t1").map((task) => [task.description, task.toolName, task.command])).toEqual([["sleeper", "bash", `${PRINT_PID}; exec sleep 60`]]);
    expect(events.some((event) => event.type === "background.tasks.changed" && event.tasks.length === 1 && event.tasks[0]!.taskId === driver.backgroundTasks("t1")[0]!.taskId)).toBe(true);
    // The quick one ended on its own; the model is told before its next request, once.
    const next = await Effect.runPromise(driver.sendTurn({ threadId: "t1", prompt: "again" }));
    await driver.awaitTurn("t1", next.turnId);
    const told = requests.at(-1)!.messages.filter((message) => String(message.content).includes("Background command") && String(message.content).includes("quick"));
    expect(told).toHaveLength(1);

    const sleeper = driver.backgroundTasks("t1")[0]!;
    // Git Bash takes a while to start on Windows, so the pid line may not be there yet.
    let output = await driver.backgroundTaskOutput("t1", sleeper.taskId);
    for (let waited = 0; output!.lines.length === 0 && waited < 10_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      output = await driver.backgroundTaskOutput("t1", sleeper.taskId);
    }
    const pid = Number(output!.lines[0]);
    expect(alive(pid)).toBe(true);
    await Effect.runPromise(driver.stopSession("t1"));
    expect(await gone(pid)).toBe(true);
  });

  it("stops one command on the client's request, and says so for one that is not running", async () => {
    const { driver, events } = driverWith([call("c1", "bash", { command: "exec sleep 60", run_in_background: true }), say("ok")]);
    await Effect.runPromise(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: { instanceId: "harness/colab", model: "m" } }));
    const { turnId } = await Effect.runPromise(driver.sendTurn({ threadId: "t1", prompt: "go" }));
    await driver.awaitTurn("t1", turnId);
    const [task] = driver.backgroundTasks("t1");
    await Effect.runPromise(driver.stopBackgroundTask("t1", task!.taskId));
    expect(driver.backgroundTasks("t1")).toEqual([]);
    expect(events.some((event) => event.type === "background.task" && event.status === "stopped")).toBe(true);
    await expect(Effect.runPromise(driver.stopBackgroundTask("t1", task!.taskId))).rejects.toThrow(/No background task/);
    await Effect.runPromise(driver.stopAll());
  });
});
