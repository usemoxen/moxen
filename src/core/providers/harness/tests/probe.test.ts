import { describe, expect, it } from "vitest";

import { mergeProbed, runProbe, testProfile, type ProbeReport } from "../probe.js";
import { normalizeHarnessConfig, resolveHarnessTarget } from "../profiles.js";

/**
 * A fake chat server whose template behaviour is set per test, to prove each
 * probe check maps to the quirk it claims to. It answers the way llama.cpp and
 * vLLM do: a refused shape is a 400 with the template's complaint, a refused
 * image or role is sometimes a 500 naming the template.
 */
interface Server {
  strictSystem?: boolean;
  alternate?: boolean;
  noToolRole?: boolean;
  dotRequired?: boolean;
  assistantBetween?: boolean;
  toolNameRequired?: boolean;
  noImages?: boolean;
  noToolChoice?: boolean;
  noTools?: boolean;
  reasoning?: "reasoning_content" | "reasoning" | "inline" | "none";
  mangleArgs?: boolean;
  busySlot?: boolean;
  props?: Record<string, unknown>;
  /** Answer 503 to requests for which this returns true (a busy server tells us nothing about the template). */
  overloaded?: (messages: Array<Record<string, unknown>>) => boolean;
  unauthorized?: boolean;
}

type Message = Record<string, unknown> & { role: string };

function refusal(body: Record<string, unknown>, server: Server): Response | null {
  const messages = body.messages as Message[];
  const json = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
  if (server.noTools && body.tools) return json(400, "tools are not supported");
  if (server.noToolChoice && body.tool_choice !== undefined) return json(400, "Unsupported parameter: tool_choice");
  if (server.strictSystem && messages.some((m, i) => i > 0 && m.role === "system")) return json(400, "System message must be at the beginning.");
  if (server.alternate && messages.some((m, i) => i > 0 && (m.role === "user" || m.role === "assistant") && messages[i - 1]!.role === m.role)) {
    return json(400, "Conversation roles must alternate user/assistant/user/assistant/...");
  }
  if (server.assistantBetween && messages.some((m, i) => i > 0 && m.role === "user" && messages[i - 1]!.role === "tool")) {
    return json(400, "Conversation roles must alternate user/assistant/user/assistant/...");
  }
  if (server.noToolRole && messages.some((m) => m.role === "tool")) return json(500, "Jinja Exception: Unknown role: tool");
  if (server.dotRequired && messages.some((m) => m.role === "assistant" && m.tool_calls && m.content === "")) return json(400, "assistant content must not be empty");
  if (server.toolNameRequired && messages.some((m) => m.role === "tool" && m.name === undefined)) return json(400, "tool message requires a name");
  if (server.noImages && messages.some((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((part) => part.type === "image_url"))) {
    return json(400, "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj");
  }
  return null;
}

function sse(events: unknown[]): Response {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeServer(server: Server = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, body, auth });
    if (server.unauthorized) return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    if (url.endsWith("/slots")) return server.busySlot ? Response.json([{ id: 0, is_processing: true }]) : Response.json([{ id: 0, is_processing: false }]);
    if (url.endsWith("/props")) return server.props ? Response.json(server.props) : new Response("not found", { status: 404 });
    if (url.endsWith("/tokenize")) return server.props ? Response.json({ tokens: [1, 2] }) : new Response("not found", { status: 404 });
    if (!body) return new Response("?", { status: 404 });
    const messages = body.messages as Array<Record<string, unknown>>;
    if (server.overloaded?.(messages)) return new Response("busy", { status: 503 });
    const refused = refusal(body, server);
    if (refused) return refused;
    const prompt = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
    if (body.tools && prompt.includes("Call the echo tool")) {
      const text = [...prompt.matchAll(/<<<([^<>]*)>>>/g)].at(-1)![1]!;
      const args = server.mangleArgs ? `{"text": "${text}"}` : JSON.stringify({ text });
      return sse([delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: args } }] }, "tool_calls")]);
    }
    if (prompt.includes("17 times 23")) {
      const events: unknown[] = [];
      if (server.reasoning === "reasoning_content" || server.reasoning === "reasoning") events.push(delta({ [server.reasoning]: "17*20=340, 17*3=51" }));
      if (server.reasoning === "inline") events.push(delta({ content: "<think>340 plus 51</think>391" }));
      else events.push(delta({ content: "391" }, "stop"));
      return sse(events);
    }
    return sse([delta({ content: "ok" }, "stop")]);
  };
  return { fetch: impl as unknown as typeof fetch, requests };
}

const profileOf = (extra: Record<string, unknown> = {}, model: Record<string, unknown> = {}) =>
  normalizeHarnessConfig({ profiles: [{ id: "local", baseUrl: "http://localhost:8080", apiKeyEnv: "PROBE_KEY", models: [{ id: "my-model", ...model }], ...extra }] })!.profiles![0]!;

async function probe(server: Server, extra: Record<string, unknown> = {}, model: Record<string, unknown> = {}): Promise<ProbeReport & { requests: ReturnType<typeof fakeServer>["requests"] }> {
  const fake = fakeServer(server);
  const profile = profileOf(extra, model);
  const report = await runProbe({ profile, model: profile.models[0]!, fetch: fake.fetch, env: { PROBE_KEY: "test-secret-value" }, requestTimeoutMs: 2000 });
  return { ...report, requests: fake.requests };
}

const outcome = (report: ProbeReport, id: string) => report.checks.find((check) => check.id === id)?.outcome;

describe("harness probe", () => {
  it("finds a plain, permissive server fine and settles every quirk it can see", async () => {
    const report = await probe({ reasoning: "reasoning_content" });
    expect(report.stopped).toBeNull();
    expect(report.checks.map((check) => check.id)).toEqual(["chat", "reasoning", "tool-call", "tool-result", "empty-content", "user-after-tool", "system-after-first", "consecutive-roles", "image", "server"]);
    expect(report.quirks).toMatchObject({
      reasoningField: "reasoning_content",
      omitToolChoice: false,
      toolResultsAsUser: false,
      toolResultName: false,
      emptyAssistantContent: "empty",
      assistantAfterToolResult: false,
      systemFirstOnly: false,
      mergeAdjacentRoles: false,
      images: "native",
    });
    expect(outcome(report, "tool-call")).toBe("pass");
  });

  it.each([
    ["rejects a system message after the first", { strictSystem: true }, "system-after-first", { systemFirstOnly: true }, /rejects system messages after the first/],
    ["needs alternating roles", { alternate: true }, "consecutive-roles", { mergeAdjacentRoles: true }, /alternate/],
    ["wants an assistant message between a tool result and a user message", { assistantBetween: true }, "user-after-tool", { assistantAfterToolResult: true }, /between/],
    ["rejects empty content on a tool-call message", { dotRequired: true }, "empty-content", { emptyAssistantContent: "dot" }, /"\."/],
    ["wants a name on tool results", { toolNameRequired: true }, "tool-result", { toolResultName: true }, /`name`/],
    ["has no tool role (a 500 naming the template)", { noToolRole: true }, "tool-result", { toolResultsAsUser: true }, /no tool role/],
    ["takes no images", { noImages: true }, "image", { images: "none" }, /does not take images/],
    ["rejects tool_choice", { noToolChoice: true }, "tool-call", { omitToolChoice: true }, /tool_choice/],
  ] satisfies Array<[string, Server, string, Record<string, unknown>, RegExp]>)("a server that %s maps to its quirk, in plain words", async (_name, server, check, quirks, words) => {
    const report = await probe({ reasoning: "reasoning_content", ...server });
    expect(report.stopped).toBeNull();
    expect(report.quirks).toMatchObject(quirks);
    expect(report.checks.find((entry) => entry.id === check)?.finding).toMatch(words);
  });

  it("reads which field carries reasoning, and what to do when it arrives inline", async () => {
    expect((await probe({ reasoning: "reasoning" })).quirks.reasoningField).toBe("reasoning");
    const inline = await probe({ reasoning: "inline" });
    expect(inline.quirks.reasoningReplay).toBe("none");
    const none = await probe({ reasoning: "none" });
    expect(outcome(none, "reasoning")).toBe("inconclusive");
    expect(none.quirks.reasoningField).toBeUndefined();
  });

  it("reports mangled tool-call arguments without inventing a quirk", async () => {
    const report = await probe({ mangleArgs: true });
    expect(outcome(report, "tool-call")).toBe("fail");
    expect(report.checks.find((check) => check.id === "tool-call")?.finding).toMatch(/not valid JSON/);
  });

  it("treats an overloaded server as no answer, so it writes no quirk for that check", async () => {
    const report = await probe({ overloaded: (messages) => messages.some((m, i) => i > 0 && m.role === "system") });
    expect(outcome(report, "system-after-first")).toBe("inconclusive");
    expect("systemFirstOnly" in report.quirks).toBe(false);
    expect(report.stopped).toBeNull();
  });

  it("refuses to start while a slot is busy, and stops on refused credentials without printing the key", async () => {
    const busy = await probe({ busySlot: true });
    expect(busy.checks).toEqual([]);
    expect(busy.stopped).toMatch(/another request/);
    expect(busy.requests.every((request) => !request.url.endsWith("/chat/completions"))).toBe(true);

    const refused = await probe({ unauthorized: true });
    expect(refused.stopped).toMatch(/refused the credentials.*PROBE_KEY/);
    expect(JSON.stringify({ ...refused, requests: undefined })).not.toContain("test-secret-value");
    expect(refused.checks).toHaveLength(1);
  });

  it("starts every request from a throwaway system prefix and sends the key only as the bearer token", async () => {
    const report = await probe({});
    const chats = report.requests.filter((request) => request.body !== null && "messages" in request.body);
    const prefixes = chats.map((request) => (request.body!.messages as Array<{ content: string }>)[0]!.content.slice(0, 20));
    expect(new Set(prefixes).size).toBe(1);
    expect(prefixes[0]).toMatch(/^\[probe [0-9a-f]{12}\]/);
    expect(chats.every((request) => request.auth === "Bearer test-secret-value")).toBe(true);
    expect(JSON.stringify(chats.map((request) => request.body))).not.toContain("test-secret-value");
  });

  it("reads llama.cpp's real context size, slots and template, and notes where the profile disagrees", async () => {
    const props = { default_generation_settings: { n_ctx: 65536 }, total_slots: 1, chat_template: "{{ messages }}", modalities: { vision: false } };
    const report = await probe({ props }, { quirks: { systemFirstOnly: true } }, { contextWindow: 131072 });
    expect(report.server).toMatchObject({ contextWindow: 65536, slots: 1, tokenize: true });
    expect(report.server.templateHash).toMatch(/^[0-9a-f]{12}$/);
    expect(report.notes.join("\n")).toMatch(/profile says 131,072.*65,536/);
    expect(report.notes.join("\n")).toMatch(/one slot/);
    const override = await probe({ strictSystem: false }, { quirks: { systemFirstOnly: true } });
    expect(override.notes.join("\n")).toMatch(/quirks\.systemFirstOnly to true but the probe found false. Your setting wins/);
  });

  it("test is one request and says what is wrong in plain words", async () => {
    const fake = fakeServer({});
    const profile = profileOf();
    const ok = await testProfile({ profile, model: profile.models[0]!, fetch: fake.fetch, env: {} });
    expect(ok.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const denied = await testProfile({ profile, model: profile.models[0]!, fetch: fakeServer({ unauthorized: true }).fetch, env: {} });
    expect(denied).toMatchObject({ ok: false });
    expect(denied.message).toMatch(/PROBE_KEY, which is not set/);
  });
});

describe("probe results in a profile", () => {
  const base = { at: "2026-10-14T10:00:00.000Z", quirks: {} };

  it("resolves preset, then the probe, then the profile's overrides, and a stated vision beats a probed images", () => {
    const mistral = (probed: unknown, rest: Record<string, unknown> = {}, model: Record<string, unknown> = {}) =>
      resolveHarnessTarget(
        normalizeHarnessConfig({ profiles: [{ id: "p", baseUrl: "http://h", models: [{ id: "mistral-small", probed, ...model }], ...rest }] }),
        "harness/p",
        "mistral-small",
      ).quirks;
    expect(mistral(undefined).assistantAfterToolResult).toBe(true); // preset
    expect(mistral({ ...base, quirks: { assistantAfterToolResult: false } }).assistantAfterToolResult).toBe(false); // probe over preset
    expect(mistral({ ...base, quirks: { assistantAfterToolResult: false } }, { quirks: { assistantAfterToolResult: true } }).assistantAfterToolResult).toBe(true); // override over probe
    expect(mistral({ ...base, quirks: { images: "native" } }).images).toBe("native");
    expect(mistral({ ...base, quirks: { images: "native" } }, {}, { vision: false }).images).toBe("none");
  });

  it("reads the older profile switches as fallbacks: the requests old profiles made, and the new control wins once set", () => {
    const qwen = (rest: Record<string, unknown> = {}, model: Record<string, unknown> = {}) =>
      resolveHarnessTarget(normalizeHarnessConfig({ profiles: [{ id: "p", baseUrl: "http://h", models: [{ id: "qwen3.6-27b", ...model }], ...rest }] }), "harness/p", "qwen3.6-27b").quirks;
    // preserveThinking off, as before: no reasoning sent back, and no template flag asking to render it.
    expect(qwen({ preserveThinking: false })).toMatchObject({ reasoningReplay: "none", chatTemplateKwargs: {} });
    expect(qwen()).toMatchObject({ reasoningReplay: "field", chatTemplateKwargs: { preserve_thinking: true } });
    // The quirk, once set, decides alone.
    expect(qwen({ preserveThinking: false, quirks: { reasoningReplay: "text" } })).toMatchObject({ reasoningReplay: "text", chatTemplateKwargs: { preserve_thinking: true } });
    // quirks.images, as before, while the model does not say; the model's own fact decides once it does.
    expect(qwen({ quirks: { images: "native" } }).images).toBe("native");
    expect(qwen({ quirks: { images: "native" } }, { vision: false }).images).toBe("none");
  });

  it("uses the server's window only while the model states none", () => {
    const target = (contextWindow?: number) =>
      resolveHarnessTarget(normalizeHarnessConfig({ profiles: [{ id: "p", baseUrl: "http://h", models: [{ id: "m", ...(contextWindow ? { contextWindow } : {}), probed: { ...base, contextWindow: 65536 } }] }] }), "harness/p", "m").model.contextWindow;
    expect(target()).toBe(65536);
    expect(target(131072)).toBe(131072);
  });

  it("keeps what an inconclusive re-run could not settle, and drops it all when the template changed", () => {
    const report = (quirks: Record<string, unknown>, templateHash?: string): ProbeReport => ({ profileId: "p", model: "m", at: "2026-10-15T00:00:00.000Z", checks: [], quirks, server: templateHash ? { templateHash } : {}, notes: [], stopped: null });
    const previous = { ...base, quirks: { systemFirstOnly: true, images: "none" }, templateHash: "aaa" };
    expect(mergeProbed(previous, report({ images: "native" })).quirks).toEqual({ systemFirstOnly: true, images: "native" });
    expect(mergeProbed(previous, report({ images: "native" }, "bbb")).quirks).toEqual({ images: "native" });
  });

  it("keeps a newer build's probed fields through a probe save, the way a plain settings.set does", () => {
    const report = (quirks: Record<string, unknown>): ProbeReport => ({ profileId: "p", model: "m", at: "2026-10-15T00:00:00.000Z", checks: [], quirks, server: {}, notes: [], stopped: null });
    const previous = { ...base, quirks: { systemFirstOnly: true, futureQuirk: 1 }, futureProbed: "keep" };
    const merged = mergeProbed(previous, report({ images: "native" })) as unknown as Record<string, unknown>;
    expect(merged.futureProbed).toBe("keep");
    expect((merged.quirks as Record<string, unknown>).futureQuirk).toBe(1);
    expect((merged.quirks as Record<string, unknown>).images).toBe("native");
  });

  it("refuses a profile field that is a key, by name and without looking at the value", () => {
    const secret = "sk-live-do-not-print";
    for (const field of ["apiKey", "token", "headers"]) {
      let message = "";
      try {
        normalizeHarnessConfig({ profiles: [{ id: "p", baseUrl: "http://h", models: [{ id: "m" }], [field]: field === "headers" ? { authorization: secret } : secret }] });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(new RegExp(`${field}.*(OS keychain|NAME of an environment variable)`));
      expect(message).not.toContain(secret);
    }
  });
});
