import { describe, expect, it, vi } from "vitest";

import type { ClientApi } from "../../api.js";
import { answerMcp, type McpSessionOptions } from "../stdio.js";

const CHILD_SESSION = "ses_child_is_shared";
const PARENT_THREAD = "thread-parent";

interface Routing {
  readonly threadId: string;
  readonly delegated: boolean;
  readonly webFetch: boolean;
  readonly memory: "write" | "read" | "off";
  readonly checklist: boolean;
}

/** A stub server: resolves one known OpenCode session, echoes which thread each tool ran for. */
function stubApi(
  resolved: Routing | null,
  seen: { toolQueries: string[] },
  liveSessions = 1,
): ClientApi {
  return {
    query: async (query: { readonly type: string } & Record<string, unknown>) => {
      switch (query.type) {
        case "opencode.session-thread":
          return resolved;
        case "thread.entry-sessions":
          return { count: liveSessions };
        case "research.run":
          return null;
        case "image-generation.availability":
          return { available: false, reason: null };
        case "handoff.pending":
          return { requestId: null };
        case "thread.agent-context": {
          // The reading the routed thread's own read answers with, so a mis-route shows.
          const threadId = query.callerThreadId as string;
          seen.toolQueries.push(threadId);
          return {
            threadId,
            provider: "claude",
            reading: { usedTokens: 1, maxTokens: 100, takenAt: `reading-for:${threadId}`, compactedSince: false },
            breakdown: null,
            cost: { totalUsd: null, pricedTurns: 0, unpricedTurns: 0, reported: false, estimated: false, byModel: [] },
          };
        }
        default:
          throw new Error(`unexpected query ${query.type}`);
      }
    },
  } as unknown as ClientApi;
}

function session(parentThreadId: string, resolved: Routing | null, seen: { toolQueries: string[] }, liveSessions = 1): McpSessionOptions {
  return { api: stubApi(resolved, seen, liveSessions), parentThreadId };
}

const childRouting: Routing = { threadId: "thread-child", delegated: true, webFetch: true, memory: "read", checklist: false };
const withSession = (name: string, args: Record<string, unknown>, nativeSessionId: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args, _meta: { "ai.opencode/sessionID": nativeSessionId } },
});

describe("routed moxen calls (one stable entry per OpenCode server)", () => {
  it("routes a call carrying the session's _meta to that thread, not the entry's", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen), withSession("context_usage", {}, CHILD_SESSION));
    const result = answer?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ reading: { takenAt: "reading-for:thread-child" } });
    expect(seen.toolQueries).toEqual(["thread-child"]);
  });

  it("fails a call carrying an unknown session id instead of serving another thread", async () => {
    const seen = { toolQueries: [] as string[] };
    const toolQuery = vi.spyOn(seen.toolQueries, "push");
    const answer = await answerMcp(session(PARENT_THREAD, null, seen), withSession("context_usage", {}, "ses-unknown"));
    expect(answer?.error).toMatchObject({ code: -32602 });
    expect(String((answer?.error as { message: string }).message)).toContain("ses-unknown");
    // Fail safe: the tool never ran for anyone.
    expect(toolQuery).not.toHaveBeenCalled();
  });

  it("serves a call without _meta as the entry's own thread when no other session could have placed it", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen, 1), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_usage", arguments: {} },
    });
    const result = answer?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ reading: { takenAt: `reading-for:${PARENT_THREAD}` } });
  });

  it("fails a call without _meta closed when sessions share the server instead of running it as the owner", async () => {
    const seen = { toolQueries: [] as string[] };
    const toolQuery = vi.spyOn(seen.toolQueries, "push");
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen, 3), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_usage", arguments: {} },
    });
    expect(answer?.error).toMatchObject({ code: -32602 });
    expect(String((answer?.error as { message: string }).message)).toContain("ai.opencode/sessionID");
    // Fail safe: the tool never ran for anyone.
    expect(toolQuery).not.toHaveBeenCalled();
  });

  it("enforces the routed thread's own gating on every call", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(
      session(PARENT_THREAD, { ...childRouting, webFetch: false }, seen),
      withSession("web_fetch", { url: "https://example.com" }, CHILD_SESSION),
    );
    const result = answer?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("web_fetch is switched off");
  });

  it("lists the routed thread's own catalog when _meta names a known session", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "ai.opencode/sessionID": CHILD_SESSION } },
    });
    const names = ((answer?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).not.toContain("delegate");
    expect(names).toContain("context_usage");
  });

  it("lists the entry's catalog when _meta is missing", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const names = ((answer?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toContain("delegate");
  });

  it("answers initialize with the routed session's instructions when _meta names a known session", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", _meta: { "ai.opencode/sessionID": CHILD_SESSION } },
    });
    const instructions = (answer?.result as { instructions: string }).instructions;
    expect(instructions).toContain("context_usage");
    expect(instructions).not.toContain("use delegate");
  });

  it("answers initialize with the entry owner's instructions when _meta is missing", async () => {
    const seen = { toolQueries: [] as string[] };
    const answer = await answerMcp(session(PARENT_THREAD, childRouting, seen), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect((answer?.result as { instructions: string }).instructions).toContain("use delegate");
  });
});

describe("routed moxen calls: a registry write never changes identity (LOCAL-035)", () => {
  /** A recording capability: the write must run for the entry's own thread or not at all. */
  const recording = (calls: string[]): { projectRegistration: NonNullable<McpSessionOptions["projectRegistration"]> } => ({
    projectRegistration: {
      register: async (callerThreadId) => {
        calls.push(callerThreadId);
        return {
          workspace: { inputPath: "/abs", mode: "folder", isGitRepository: false, branch: null, workspaceRoot: "/abs" },
          project: { id: "p-1", title: "abs", workspaceRoot: "/abs", defaultModelSelection: null, createdAt: "now", updatedAt: "now", deletedAt: null },
          created: true,
          command: null,
        } as never;
      },
    },
  });

  it("refuses a project_register that session metadata would move onto another thread", async () => {
    const seen = { toolQueries: [] as string[] };
    const calls: string[] = [];
    // The entry belongs to a delegated child; the request metadata names the
    // orchestrator's session, which routing would substitute before the call.
    const orchestrator: Routing = { threadId: "thread-orchestrator", delegated: false, webFetch: true, memory: "write", checklist: false };
    const answer = await answerMcp(
      { ...session(PARENT_THREAD, orchestrator, seen), ...recording(calls) },
      withSession("project_register", { cwd: "/abs" }, CHILD_SESSION),
    );
    const result = answer?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("never runs through session-metadata routing");
    // Fail safe: the write ran for no thread at all.
    expect(calls).toEqual([]);
  });

  it("runs a project_register for the entry's own thread when no metadata substitutes another", async () => {
    const seen = { toolQueries: [] as string[] };
    const calls: string[] = [];
    const answer = await answerMcp(
      { ...session(PARENT_THREAD, childRouting, seen), ...recording(calls) },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_register", arguments: { cwd: "/abs" } } },
    );
    const result = answer?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(calls).toEqual([PARENT_THREAD]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ created: true });
  });
});
