import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ClaudeDriver } from "../../core/providers/claude/driver.js";
import { FakeTransport, successResult } from "../../core/providers/claude/tests/fakes.js";
import { testHarness } from "../../core/testing/harness.js";
import { DirectConnection } from "../connection.js";
import { decodeCommand } from "../protocol.js";
import { RemoteConnection } from "../transport/remote.js";
import { serve } from "../transport/serve.js";
import { testEndpoint } from "../transport/tests/endpoint.js";

describe("prompt improvement through the server", () => {
  it.each([false, true])("improves a draft without creating a project, thread, or turn (wire=%s)", async (wire) => {
    const transport = new FakeTransport([[successResult("Fix the title. Verify leading and trailing whitespace is removed.")]]);
    const driver = new ClaudeDriver({ transport });
    const h = await testHarness({ drivers: { claude: () => driver } });
    await writeFile(path.join(h.work, "AGENTS.md"), "Use the existing tests.");
    const api = new DirectConnection({ storeRoot: h.root, drivers: h.drivers, config: async () => h.config });
    const server = wire ? await serve({ endpoint: testEndpoint(), api }) : null;
    const remote = server ? await RemoteConnection.connect(server.endpoint) : null;
    const client = remote ?? api;
    try {
      const result = await client.dispatch({ type: "prompt.improve", directory: h.work, prompt: "Fix the title.", modelSelection: { instanceId: "codex", model: "gpt-6.1-terra" } });
      expect(result).toEqual({ provider: "claude", model: "claude-haiku-5-5", text: "Fix the title. Verify leading and trailing whitespace is removed." });
      expect(JSON.parse(transport.created[0]!.prompts[0]!).projectRules).toEqual([{ file: "AGENTS.md", text: "Use the existing tests." }]);
      expect((await client.query({ type: "projects.list" })).projects).toEqual([]);
      expect((await client.query({ type: "threads.list" })).threads).toEqual([]);
      expect(transport.created[0]!.options).toMatchObject({ tools: [], strictMcpConfig: true, persistSession: false });
    } finally {
      await remote?.close();
      await server?.close();
      await api.close();
    }
  });

  it("routes the configured model to its own driver", async () => {
    const transport = new FakeTransport([[successResult("Use the configured model.")]]);
    const driver = new ClaudeDriver({ transport });
    const h = await testHarness({ drivers: { claude: () => driver } });
    const config = { ...h.config, promptImprover: { provider: "claudeAgent", model: "claude-opus-5" } };
    const api = new DirectConnection({ storeRoot: h.root, drivers: h.drivers, config: async () => config });
    try {
      const result = await api.dispatch({ type: "prompt.improve", directory: h.work, prompt: "Fix it." });
      expect(result).toEqual({ provider: "claude", model: "claude-opus-5", text: "Use the configured model." });
      expect(transport.created[0]!.options).toMatchObject({ model: "claude-opus-5", tools: [] });
    } finally {
      await api.close();
    }
  });

  it("routes an OpenCode model to the OpenCode driver", async () => {
    const h = await testHarness();
    let seen: { model: string } | null = null;
    const opencode = h.drivers.opencode!();
    opencode.completeText = async (input) => {
      seen = input;
      return "Use the OpenCode model.";
    };
    const config = { ...h.config, promptImprover: { provider: "opencode/opencode", model: "opencode/muse" } };
    const api = new DirectConnection({ storeRoot: h.root, drivers: { ...h.drivers, opencode: () => opencode }, config: async () => config });
    try {
      const result = await api.dispatch({ type: "prompt.improve", directory: h.work, prompt: "Fix it." });
      expect(result).toEqual({ provider: "opencode", model: "opencode/muse", text: "Use the OpenCode model." });
      expect(seen).toMatchObject({ model: "opencode/muse" });
    } finally {
      await api.close();
    }
  });

  it("refuses a provider with no tool-free completion, naming the model and the setting", async () => {
    const h = await testHarness();
    const config = { ...h.config, promptImprover: { provider: "codex", model: "gpt-6.1-terra" } };
    const api = new DirectConnection({ storeRoot: h.root, drivers: h.drivers, config: async () => config });
    try {
      const refused = api.dispatch({ type: "prompt.improve", directory: h.work, prompt: "Fix it." });
      await expect(refused).rejects.toThrow(/gpt-6\.1-terra.*promptImprover\.(model|provider)/s);
      await expect(refused).rejects.toMatchObject({ code: "PROMPT_IMPROVER_UNAVAILABLE" });
    } finally {
      await api.close();
    }
  });

  it("rejects malformed wire input instead of dropping destination context or protected text", () => {
    const valid = { type: "prompt.improve", directory: path.resolve("project"), prompt: "Fix it" };
    expect(decodeCommand(valid)).toEqual(valid);
    for (const fields of [{ directory: "" }, { prompt: 42 }, { modelSelection: {} }, { protectedText: "file.ts" }, { protectedText: [42] }]) {
      expect(() => decodeCommand({ ...valid, ...fields })).toThrow();
    }
  });
});
