/**
 * The mapper's contract is that the TUI renderer can read what core
 * writes, so each case asserts the payload *through* `describeActivity`
 * rather than field by field — a shape that only looks right is the bug
 * this whole path had.
 *
 * It lives on the client side deliberately: it is the reader asserting it
 * can read, which keeps `core/` free of any import of a client.
 */
import { describe, expect, it } from "vitest";

import { describeActivity, memoryLabel, memoryTitle, type MemoryView, type ThreadLookupView } from "../activity.js";
import type { ActivityEnvelope } from "../../../core/types.js";
import { toolActivityRow, type ToolRuntimeEvent } from "../../../core/threads/toolactivity.js";

function view(row: { payload: Record<string, unknown>; summary: string; kind: string }) {
  const activity: ActivityEnvelope = {
    id: "a1",
    tone: "info",
    kind: row.kind,
    summary: row.summary,
    turnId: "turn-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    payload: row.payload,
  };
  return describeActivity(activity);
}

function event(partial: Partial<ToolRuntimeEvent> & { provider: ToolRuntimeEvent["provider"] }): ToolRuntimeEvent {
  return {
    type: "tool.execute.started",
    threadId: "thread-1",
    turnId: "turn-1",
    tool: "tool",
    ...partial,
  } as ToolRuntimeEvent;
}

describe("toolActivityRow", () => {
  it.each([
    ["linear", "list_issues", "Linear · List issues"],
    ["claude_ai_Linear", "get_issue", "Linear · Get issue"],
    ["plugin_linear_linear", "mcp__linear__get_issue", "Linear · Get issue"],
    ["docs", "read", "Docs · Read"],
  ])("retains the Codex MCP server %s for tool %s", (server, tool, label) => {
    const row = toolActivityRow(event({ provider: "codex", type: "tool.execute.completed", raw: { item: { id: "mcp", type: "mcpToolCall", server, tool, status: "completed", arguments: {}, result: { content: [{ type: "text", text: "RAW_MCP_RESPONSE" }], structuredContent: null } } } }))!;
    expect(view(row)).toMatchObject({ kind: "tool", tool: label, detail: "", running: false });
  });

  it.each([
    [null, "legacy query", { tool: "websearch", query: "legacy query" }],
    [{ type: "search", query: "full query", queries: null }, "short", { action: "search", query: "full query" }],
    [{ type: "search", query: "first", queries: ["first", "second"] }, "short", { query: "first · second" }],
    [{ type: "openPage", url: "https://example.org/visual" }, "ignored", { tool: "webfetch", action: "openPage", query: "https://example.org/visual", url: "https://example.org/visual" }],
    [{ type: "findInPage", url: "https://example.org/visual", pattern: "key visual" }, "ignored", { action: "findInPage", query: "key visual", pattern: "key visual", url: "https://example.org/visual" }],
    [{ type: "other" }, "", { action: "other", query: "" }],
  ])("preserves Codex web action %j and provider identity", (action, query, expected) => {
    const row = toolActivityRow(event({ provider: "codex", type: "tool.execute.completed", raw: { item: { type: "webSearch", id: "search", action, query } } }))!;
    expect(view(row)).toMatchObject({ kind: "web", provider: "codex", running: false, ...expected });
  });

  it("does not discard a web action update just because its status and output length stayed the same", () => {
    const search = (query: string) => toolActivityRow(event({ provider: "codex", raw: { item: { type: "webSearch", id: "search", query, action: { type: "search", query } } } }))!;
    expect(search("first").signature).not.toBe(search("second").signature);
  });

  it("distinguishes native image generation from viewing and never stores the image bytes", () => {
    const image = (status: string, extra: Record<string, unknown> = {}) => toolActivityRow(event({ provider: "codex", type: status === "inProgress" ? "tool.execute.started" : "tool.execute.completed", raw: { item: { id: "image", type: "imageGeneration", status, ...extra } } }))!;
    const started = image("inProgress");
    expect(view(started)).toMatchObject({ kind: "image", generated: true, running: true, failed: false });
    const completed = image("completed", { savedPath: "/work/image.png", result: "DO_NOT_STORE_IMAGE_BYTES" });
    expect(view(completed)).toMatchObject({ kind: "image", generated: true, running: false, path: "image.png", failed: false });
    expect(JSON.stringify(completed.payload)).not.toContain("DO_NOT_STORE_IMAGE_BYTES");
    expect(view(image("completed", { failure: { type: "usageLimitExceeded" } }))).toMatchObject({ generated: true, failed: true, error: "usageLimitExceeded" });
    const read = toolActivityRow(event({ provider: "codex", type: "tool.execute.completed", raw: { item: { id: "read", type: "imageView", path: "/work/image.png" } } }))!;
    expect(view(read)).toEqual({ kind: "image", path: "image.png" });
  });

  it("renders Codex command output and native patches from the provider item", () => {
    const command = toolActivityRow(event({ provider: "codex", type: "tool.execute.completed", tool: "commandExecution", raw: { item: { type: "commandExecution", id: "cmd", command: "git status", cwd: "/repo", aggregatedOutput: "clean", exitCode: 0, status: "completed" } } }));
    expect(view(command!)).toMatchObject({ kind: "command", command: "git status", running: false });
    const patch = toolActivityRow(event({ provider: "codex", type: "tool.execute.completed", tool: "fileChange", raw: { item: { type: "fileChange", id: "patch", status: "completed", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" }] } } }));
    expect(patch?.payload).toMatchObject({ itemType: "file_change", data: { files: [{ path: "a.ts" }] } });
    expect(toolActivityRow(event({ provider: "codex", raw: { item: { id: "m", type: "agentMessage", text: "answer" } } }))).toBeNull();
  });

  it("maps a Claude Bash call to a command row and settles it on the tool result", () => {
    const started = toolActivityRow(
      event({
        provider: "claude",
        tool: "Bash",
        raw: { toolUseId: "toolu_1", input: { command: "git status", workdir: "/repo" } },
      }),
    );
    expect(started?.callId).toBe("toolu_1");
    const startedView = view(started!);
    expect(startedView.kind).toBe("command");
    expect(startedView).toMatchObject({ command: "git status", workdir: "/repo", running: true });
    expect(started?.summary).toBe("$ git status");

    const done = toolActivityRow(
      event({
        provider: "claude",
        type: "tool.execute.completed",
        tool: "tool",
        raw: { toolUseId: "toolu_1", output: "on branch main", isError: false },
      }),
    );
    // Same call id, so the transcript folds both onto one card.
    expect(done?.callId).toBe("toolu_1");
    expect(view(done!)).toMatchObject({ running: false });
  });

  it("reads an OpenCode subagent call an interrupt aborted as stopped, and one that failed as failed", () => {
    const subagent = (errorType: string, error: string) =>
      toolActivityRow(
        event({
          provider: "opencode",
          type: "tool.execute.completed",
          tool: "subagent",
          raw: {
            callID: "call_sub",
            tool: "subagent",
            state: { status: "error", input: { agent: "general", description: "Sleep 30 seconds" }, error, errorType },
          },
        }),
      )!;
    const aborted = subagent("aborted", "Step interrupted");
    expect((aborted.payload.data as { state: { stopped?: boolean } }).state.stopped).toBe(true);
    expect(view(aborted)).toMatchObject({ kind: "agent", subject: "Sleep 30 seconds", state: "stopped", running: false });
    const failed = subagent("tool.execution", "Unable to start the subagent");
    expect((failed.payload.data as { state: { stopped?: boolean } }).state.stopped).toBeUndefined();
    expect(view(failed)).toMatchObject({ kind: "agent", state: "failed" });
    // The two differ in the ledger too: a stopped call is a different row from a failed one.
    expect(aborted.signature).not.toBe(failed.signature);
  });

  it("maps a Claude PowerShell call to the same command row as Bash", () => {
    const row = toolActivityRow(
      event({
        provider: "claude",
        tool: "PowerShell",
        raw: { toolUseId: "toolu_ps", input: { command: "Get-ChildItem -Recurse" } },
      }),
    );
    expect(view(row!)).toMatchObject({ kind: "command", tool: "PowerShell", command: "Get-ChildItem -Recurse" });
    expect(row?.summary).toBe("$ Get-ChildItem -Recurse");
  });

  it("maps a Claude Read call to a read row with its path", () => {
    const row = toolActivityRow(
      event({ provider: "claude", tool: "Read", raw: { toolUseId: "toolu_2", input: { file_path: "/repo/src/app.ts" } } }),
    );
    expect(view(row!)).toMatchObject({ kind: "read", path: "src/app.ts" });
  });

  it("maps an OpenCode tool part, reading status from the part's own state", () => {
    const running = toolActivityRow(
      event({
        provider: "opencode",
        tool: "bash",
        raw: {
          id: "prt_1",
          callID: "call_1",
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: "ls" }, time: { start: 1000 } },
        },
      }),
    );
    expect(view(running!)).toMatchObject({ kind: "command", command: "ls", running: true });

    const done = toolActivityRow(
      event({
        provider: "opencode",
        type: "tool.execute.completed",
        tool: "bash",
        raw: {
          id: "prt_1",
          callID: "call_1",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "README.md",
            metadata: { exit: 0 },
            time: { start: 1000, end: 2000 },
          },
        },
      }),
    );
    expect(done?.callId).toBe("call_1");
    expect(view(done!)).toMatchObject({ kind: "command", exit: 0, durationMs: 1000, running: false });
  });

  describe("OpenCode v2 tools (shapes captured from a live v2.0.19 server)", () => {
    const completed = (tool: string, input: Record<string, unknown>, output: string) =>
      view(
        toolActivityRow(
          event({
            provider: "opencode",
            type: "tool.execute.completed",
            tool,
            raw: { id: `call_${tool}`, callID: `call_${tool}`, type: "tool", tool, state: { status: "completed", input, output } },
          }),
        )!,
      );

    it("reads the file from `path`, and a directory read as a listing", () => {
      expect(completed("read", { path: "/repo/src/app.ts" }, "1\timport x")).toMatchObject({ kind: "read", path: "src/app.ts" });
      expect(completed("read", { path: "/repo/src/server/mcp" }, "Read directory /repo/src/server/mcp, entries 1-5\ntests/")).toMatchObject({
        kind: "list",
        path: "src/server/mcp",
      });
    });

    it("names the file `write` and `edit` change, from `path`", () => {
      expect(completed("write", { path: "/repo/notes.txt", content: "a\nb\n" }, "Created file successfully")).toMatchObject({
        kind: "file",
        verb: "Write",
        path: "repo/notes.txt",
        added: 2,
      });
      expect(
        completed("edit", { path: "/repo/notes.txt", oldString: "a\nb", newString: "a" }, "Edited notes.txt (1 replacement)"),
      ).toMatchObject({ kind: "file", verb: "Update", path: "repo/notes.txt", removed: 1 });
    });

    it("names every file a `patch` touches", () => {
      const row = toolActivityRow(
        event({
          provider: "opencode",
          type: "tool.execute.completed",
          tool: "patch",
          raw: {
            callID: "call_p",
            tool: "patch",
            state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch" } },
          },
        }),
      );
      expect((row!.payload.data as { files: unknown }).files).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
      expect(view(row!)).toMatchObject({ kind: "file", path: "src/a.ts", fileCount: 2 });
    });

    it("shows Code Mode's `execute` as the tools it called, not a shell command", () => {
      const code = 'const r1 = search({query: "moxen"});\nconst r2 = search({query: "browser"});\nawait tools.moxen.delegate({});\ntools.opencode.models({});';
      expect(completed("execute", { code }, "{}")).toEqual({ kind: "tool", tool: "Ran code", detail: "search ×2, moxen.delegate, models", running: false });
    });

    it("keeps moxen's lent checklist out of the transcript, called directly or from Code Mode", () => {
      expect(completed("moxen_todos", { todos: [{ content: "Write tests", status: "in_progress" }] }, '{"recorded":1}')).toMatchObject({
        kind: "todos",
        items: [{ content: "Write tests", status: "in_progress" }],
      });
      expect(completed("execute", { code: 'await tools.moxen.todos({todos: []});\nawait tools.moxen.todos({todos: []});' }, "{}")).toMatchObject({ kind: "todos" });
      expect(completed("execute", { code: "await tools.moxen.todos({todos: []}); search({query: 'x'})" }, "{}")).toMatchObject({ kind: "tool" });
    });

    it("shows Moxen's memory tools as sentences, with what changed", () => {
      const memory = (tool: string, input: Record<string, unknown>, output: string) => completed(`moxen_${tool}`, input, output) as MemoryView;
      // A new memory: its text, all additions.
      const created = memory(
        "memory_save",
        { name: "prefers-bun", scope: "global", description: "Uses bun", body: "Run bun, not npm." },
        '{"name":"prefers-bun","scope":"global","replaced":false,"total":3}',
      );
      expect(created).toMatchObject({ kind: "memory", action: "save", name: "prefers-bun", scope: "global", outcome: "created", removed: 0 });
      expect(created.diff).toContain("+Run bun, not npm.");
      expect(memoryTitle(created)).toBe("Saved memory");
      expect(memoryLabel(created)).toBe("prefers-bun (global)");

      // A replaced one: a diff against what it said before.
      const updated = memory(
        "memory_save",
        { name: "prefers-bun", scope: "global", description: "Uses bun", body: "Run bun, not npm.\nTests: bun test." },
        '{"name":"prefers-bun","scope":"global","replaced":true,"total":3,"before":{"description":"Uses bun","type":"user","body":"Run bun, not npm."}}',
      );
      expect(updated).toMatchObject({ outcome: "updated", added: 1, removed: 0 });
      expect(updated.diff).toContain("+Tests: bun test.");
      expect(updated.diff).not.toContain("-Run bun");
      expect(memoryTitle(updated)).toBe("Updated memory");

      // Saved again as it was.
      const same = memory(
        "memory_save",
        { name: "a", scope: "project", description: "About a", body: "Text." },
        '{"name":"a","scope":"project","replaced":true,"total":1,"before":{"description":"About a","type":"project","body":"Text."}}',
      );
      expect(same).toMatchObject({ outcome: "unchanged", diff: null });
      expect(memoryTitle(same)).toBe("Memory unchanged");

      // An edit shows the text it replaced and what replaced it; an append, the text it added.
      const edited = memory("memory_edit", { name: "a", scope: "project", old_string: "Why: pinned.", new_string: "Why: the repo pins it." }, '{"name":"a","scope":"project","total":2}');
      expect(edited).toMatchObject({ action: "edit", outcome: null, added: 1, removed: 1 });
      expect(edited.diff).toContain("-Why: pinned.");
      expect(edited.diff).toContain("+Why: the repo pins it.");
      expect(memoryTitle(edited)).toBe("Edited memory");
      const trimmed = memory("memory_edit", { name: "a", scope: "project", old_string: "Extra.", new_string: "" }, '{"name":"a","scope":"project","total":2}');
      expect(trimmed).toMatchObject({ added: 0, removed: 1 });
      const appended = memory("memory_append", { name: "a", scope: "project", text: "Also: CI runs it." }, '{"name":"a","scope":"project","total":2}');
      expect(appended).toMatchObject({ action: "append", added: 1, removed: 0 });
      expect(appended.diff).toContain("+Also: CI runs it.");
      expect(memoryTitle(appended)).toBe("Added to memory");
      const refusedEdit = memory("memory_edit", { name: "a", scope: "project", old_string: "x", new_string: "y" }, "MEMORY_EDIT_NOT_FOUND: old_string is not in the memory a.");
      expect(refusedEdit).toMatchObject({ outcome: "rejected", diff: null });
      expect(memoryTitle(refusedEdit)).toBe("Memory not edited");

      // A delete shows what was removed.
      const deleted = memory("memory_delete", { name: "old", scope: "project" }, '{"name":"old","scope":"project","total":2,"before":{"description":"Old","type":"reference","body":"Gone soon."}}');
      expect(deleted).toMatchObject({ outcome: null, removed: 3 });
      expect(deleted.diff).toContain("-Gone soon.");
      expect(memoryTitle(deleted)).toBe("Deleted memory");

      // Claude's harness wraps an MCP server's answer: the row is the same through it, and an answer without JSON is not a refusal.
      const wrap = (text: string) => `<untrusted_context source="mcp:moxen/memory_save">\n${text}\n</untrusted_context>`;
      const wrapped = memory(
        "memory_save",
        { name: "prefers-bun", scope: "global", description: "Uses bun", body: "Run bun, not npm.\nTests: bun test." },
        wrap('{"name":"prefers-bun","scope":"global","replaced":true,"total":3,"before":{"description":"Uses bun","type":"user","body":"Run bun, not npm."}}'),
      );
      expect(wrapped).toMatchObject({ outcome: "updated", note: null, added: 1 });
      expect(memory("memory_read", {}, wrap("- [a](a.md) — about a\n- [b](b.md) — about b"))).toMatchObject({ listed: 2 });
      // Cut off by the ledger's cap, the closing tag is gone but the short fields are not.
      expect(memory("memory_delete", { name: "old", scope: "project" }, `<untrusted_context source="mcp:moxen/memory_delete">\n{"name":"old","scope":"project","total":2`)).toMatchObject({ outcome: null });

      // A refused save or delete answers in words.
      const refused = memory("memory_save", { name: "x", scope: "project", description: "d", body: "b" }, "MEMORY_FULL: The project memory holds 200 memories already.");
      expect(refused).toMatchObject({ outcome: "rejected", note: "MEMORY_FULL: The project memory holds 200 memories already.", diff: null });
      expect(memoryTitle(refused)).toBe("Memory not saved");

      // Reads: the index says how many memories it listed.
      const index = memory("memory_read", {}, "- [a](a.md) — about a\n- [b](b.md) — about b");
      expect(index).toMatchObject({ action: "read", name: null, listed: 2 });
      expect(memoryTitle(index)).toBe("Read the memory index");
      expect(memoryLabel(index)).toBe("2 memories");
      const one = memory("memory_read", { name: "a", scope: "project" }, "a (project, user): About a\n\nText.");
      expect(memoryTitle(one)).toBe("Read memory");
      expect(memoryLabel(one)).toBe("a (project)");
    });

    it("shows the thread tools as what was searched for and which thread was read", () => {
      const lookup = (tool: string, input: Record<string, unknown>, output: string) => completed(`moxen_${tool}`, input, output) as ThreadLookupView;
      const wrap = (source: string, text: string) => `<untrusted_context source="${source}">\n${text}\n</untrusted_context>`;
      const found = lookup(
        "thread_search",
        { query: "composer layout", limit: 3 },
        [
          wrap(
            "moxen:thread_search",
            '- "Linear issue MXN-115 and sub-issues" · id 71de · project f267 · settled · last activity 2026-10-28 · 1 match\n    tool (Bash): $ sed -n 1,2p x\n- "Improve thread view message styling" · id 3640 · project f267 · settled · last activity 2026-10-28 · 3 matches',
          ),
          "",
          "[Moxen] 20 more threads matched: narrow the query, or raise limit (at most 25).",
          "[Moxen] Read one with thread_read(id): the outline first, then the turns you need.",
        ].join("\n"),
      );
      expect(found).toMatchObject({ kind: "threads", action: "search", query: "composer layout", scope: "project", total: 22, note: null });
      expect(found.titles).toEqual(["Linear issue MXN-115 and sub-issues", "Improve thread view message styling"]);
      expect(lookup("thread_search", { query: "zzz", scope: "all" }, 'No thread matches "zzz".')).toMatchObject({ scope: "all", total: 0, titles: [] });
      expect(lookup("thread_search", { query: "x" }, "INVALID_TOOL_INPUT: query is required.")).toMatchObject({ total: null, note: "INVALID_TOOL_INPUT: query is required." });

      const outline = lookup("thread_read", { id: "36406f5e-86c1-493e-be5e-558e4e2faf19" }, wrap("thread:36406f5e", 'Thread "Improve thread view message styling" (36406f5e-86c1-493e-be5e-558e4e2faf19), 1 turn, newest first:\n1. ...'));
      expect(outline).toMatchObject({ action: "read", threadId: "36406f5e-86c1-493e-be5e-558e4e2faf19", title: "Improve thread view message styling", part: "outline" });
      expect(lookup("thread_read", { id: "36406f5e", turns: "1-2" }, wrap("thread:36406f5e", 'Thread "T" (36406f5e), 3 turns.'))).toMatchObject({ title: "T", part: "turns 1-2" });
      expect(lookup("thread_read", { id: "36406f5e", item: "1.51" }, wrap("thread:36406f5e", "Tool call 1.51 in turn 1: edit, completed"))).toMatchObject({ title: null, part: "tool call 1.51" });
      expect(lookup("thread_read", { id: "nope" }, "THREAD_NOT_FOUND: No thread nope.")).toMatchObject({ note: "THREAD_NOT_FOUND: No thread nope." });
    });

    it("shows a `subagent` call as the native subagent it started", () => {
      expect(
        completed(
          "subagent",
          { agent: "general", description: "Report research guidance text", prompt: "Read-only task: …" },
          '<subagent sessionID="ses_1" state="completed">\nRESEARCH_GUIDANCE at line 51\n</subagent>',
        ),
      ).toMatchObject({ kind: "agent", source: "native", title: "general", subject: "Report research guidance text", state: null, running: false });
      expect(completed("subagent", { agent: "explore", description: "Map auth", prompt: "…", background: true }, '<subagent sessionID="ses_2" state="running">')).toMatchObject({
        kind: "agent",
        title: "explore",
        state: "sent to the background",
        running: false,
      });
    });
  });

  it("keeps a signature that changes only when the row says something new", () => {
    const base = {
      provider: "opencode" as const,
      tool: "bash",
      raw: {
        callID: "call_2",
        tool: "bash",
        state: { status: "running", input: { command: "ls" }, output: "a" },
      },
    };
    const first = toolActivityRow(event(base));
    const same = toolActivityRow(event(base));
    expect(same?.signature).toBe(first?.signature);
    const grown = toolActivityRow(
      event({
        ...base,
        raw: { callID: "call_2", tool: "bash", state: { status: "running", input: { command: "ls" }, output: "ab" } },
      }),
    );
    expect(grown?.signature).not.toBe(first?.signature);
  });

  it("returns null rather than throwing on a shape it cannot read", () => {
    expect(toolActivityRow(event({ provider: "claude", raw: undefined }))).toBeNull();
    expect(toolActivityRow(event({ provider: "claude", raw: { input: {} } }))).toBeNull();
    expect(toolActivityRow(event({ provider: "opencode", raw: { tool: "bash" } }))).toBeNull();
  });
});
