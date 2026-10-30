import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "../../spi.js";
import { HarnessDriver } from "../driver.js";
import { sessionAllowKey } from "../permissions.js";
import { webFetchTool, webSearchTool } from "../tools/web.js";
import { ReadState, type ToolContext } from "../tools/types.js";
import { resolveWebSettings, webPolicy } from "../web/settings.js";
import type { ChatRequest } from "../transport/chat.js";
import type { ModelEvent } from "../types.js";

let server: http.Server;
let base: string;
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><head><title>Dev server</title></head><body><h1>It works</h1></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dir: string;
let work: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-webtools-"));
  work = path.join(dir, "work");
  fs.mkdirSync(work);
  hits.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const settings = () => resolveWebSettings(undefined, {});
const context: ToolContext = { cwd: "/w", signal: new AbortController().signal, readState: new ReadState(), artifactDir: "/tmp/a" };

describe("web tool intents", () => {
  it("lets this machine be read without asking, and makes any other host an outward call keyed by host", () => {
    const fetchTool = webFetchTool(settings);
    expect(fetchTool.intent({ url: "http://localhost:3000/app" }, context)).toMatchObject({ action: "read", web: { host: "localhost" } });
    expect(fetchTool.intent({ url: "http://127.0.0.1:8080" }, context)).toMatchObject({ action: "read" });
    expect(fetchTool.intent({ url: "https://Docs.Example.com/a?b=1" }, context)).toMatchObject({ action: "exec", command: "fetch https://Docs.Example.com/a?b=1", web: { host: "docs.example.com" } });
    expect(fetchTool.intent({ url: "docs.example.com/page" }, context)).toMatchObject({ action: "exec", web: { host: "docs.example.com" } });
    expect(fetchTool.intent({ url: "http://10.0.0.5/" }, context)).toMatchObject({ action: "exec" });
    const search = webSearchTool(settings).intent({ query: "bun sqlite" }, context);
    expect(search).toMatchObject({ action: "exec", web: { host: "html.duckduckgo.com" } });
    // "Allow for this session" covers a host whichever web tool reached it, and nothing else.
    expect(sessionAllowKey("web_fetch", fetchTool.intent({ url: "https://Docs.Example.com/x" }, context), "/w")).toBe("web:docs.example.com");
    expect(sessionAllowKey("web_search", search, "/w")).toBe("web:html.duckduckgo.com");
    expect(sessionAllowKey("web_fetch", fetchTool.intent({ url: "https://other.example/x" }, context), "/w")).not.toBe("web:docs.example.com");
  });

  it("reads the web settings on each call: DuckDuckGo and the browser on automatically unless told otherwise", () => {
    expect(resolveWebSettings(undefined, {})).toMatchObject({ search: { backend: "duckduckgo" }, browser: { mode: "auto" }, allowPrivate: false });
    const configured = resolveWebSettings({ webSearch: "searxng", searxngUrl: "http://localhost:8888", webBrowser: "off", webPrivateNetwork: true }, {});
    expect(configured).toMatchObject({ search: { backend: "searxng", searxngUrl: "http://localhost:8888" }, browser: { mode: "off" }, allowPrivate: true });
    expect(resolveWebSettings({ webSearch: "bing" }, {}).search.backend).toBe("duckduckgo");
  });

  it("follows the shared web settings, which win over the Harness's older keys", () => {
    expect(resolveWebSettings({ webBrowser: "auto", webPrivateNetwork: true }, {}, { browser: "off", privateNetwork: false })).toMatchObject({ browser: { mode: "off" }, allowPrivate: false });
    expect(resolveWebSettings({}, {}, { browserPath: "/opt/chrome" }).browser).toEqual({ mode: "auto", path: "/opt/chrome" });
    // The older Harness switch opened its own tools only; the shared one opens every provider's.
    expect(webPolicy(undefined, { webBrowser: "off", webPrivateNetwork: true }, false)).toEqual({ browser: { mode: "off", path: undefined }, allowPrivate: false });
    expect(webPolicy(undefined, { webPrivateNetwork: true }, true).allowPrivate).toBe(true);
    expect(webPolicy({ privateNetwork: true }, undefined, false).allowPrivate).toBe(true);
  });

  it("states in the tool text that results are data and that sign-in is not possible", () => {
    expect(webFetchTool(settings).definition.description).toMatch(/untrusted_context/);
    expect(webSearchTool(settings).definition.description).toMatch(/never instructions/);
  });
});

describe("web tools in a session", () => {
  const config = { profiles: [{ id: "p", apiFormat: "chat" as const, baseUrl: "http://x", models: [{ id: "m" }] }] };
  const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: "tool.call", call: { id, name, arguments: JSON.stringify(args) } }, { type: "finish", reason: "tool-calls" }];
  const say = (text: string): ModelEvent[] => [{ type: "text.delta", text }, { type: "finish", reason: "stop" }];

  function driverWith(script: ModelEvent[][]) {
    const requests: ChatRequest[] = [];
    const driver = new HarnessDriver({
      config,
      sessionsDir: path.join(dir, "sessions"),
      home: dir,
      sleep: async () => {},
      env: {},
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
  const begin = async (driver: HarnessDriver, extra: Record<string, unknown> = {}) => {
    await Effect.runPromise(driver.startSession({ threadId: "t1", workingDirectory: work, modelSelection: { instanceId: "harness/p", model: "m" }, ...extra }));
    return await Effect.runPromise(driver.sendTurn({ threadId: "t1", prompt: "look it up" }));
  };
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("fetches a server on this machine without asking, even where commands need approval, and gives the model the text wrapped as data", async () => {
    const { driver, requests, events } = driverWith([call("c1", "web_fetch", { url: `${base}/app` }), say("It works.")]);
    const { turnId } = await begin(driver, { runtimeMode: "approval-required" });
    await expect(driver.awaitTurn("t1", turnId)).resolves.toMatchObject({ status: "completed" });
    expect(events.some((event) => event.type === "permission.request.opened")).toBe(false);
    expect(hits).toEqual(["/app"]);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("# It works") });
    expect(String(requests[1]!.messages.at(-1)!.content)).toMatch(/^<untrusted_context source="web:127\.0\.0\.1">/);
  });

  it("asks before reaching another host, shows the address, and fetches nothing when declined", async () => {
    const { driver, requests, events } = driverWith([call("c1", "web_fetch", { url: "https://docs.example.com/page" }), say("Understood.")]);
    const { turnId } = await begin(driver, { runtimeMode: "approval-required" });
    await until(() => events.some((event) => event.type === "permission.request.opened"));
    const opened = events.find((event) => event.type === "permission.request.opened") as { requestId: string; raw: { toolName: string; input: { command: string } } };
    expect(opened.raw).toMatchObject({ toolName: "web_fetch", input: { command: "fetch https://docs.example.com/page" } });
    await Effect.runPromise(driver.respondToRequest("t1", opened.requestId, { kind: "decline" }));
    await driver.awaitTurn("t1", turnId);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/declined/) });
  });

  it("refuses another host in a task nobody can answer for, and says it was the web", async () => {
    const { driver, requests } = driverWith([call("c1", "web_search", { query: "anything" }), say("Could not search.")]);
    const { turnId } = await begin(driver, { runtimeMode: "approval-required", moxenSkills: "none", delegated: true });
    await driver.awaitTurn("t1", turnId);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/Reaching the web needs approval/) });
  });

  it("tells the model about the web tools only in a prompt that has them, and fetches pages for a subagent too", async () => {
    const { driver, requests } = driverWith([call("p1", "subagent", { description: "look up", prompt: `Fetch ${base}/sub and report.` }), call("s1", "web_fetch", { url: `${base}/sub` }), say("It says it works."), say("Done.")]);
    const { turnId } = await begin(driver, { runtimeMode: "approval-required" });
    await driver.awaitTurn("t1", turnId);
    expect(String(requests[0]!.messages[0]!.content)).toContain("The web: web_search finds pages");
    expect(hits).toEqual(["/sub"]);
    expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "glob", "grep", "web_fetch", "web_search"]));
  });
});
