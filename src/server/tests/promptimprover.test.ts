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

  it("rejects malformed wire input instead of dropping destination context or protected text", () => {
    const valid = { type: "prompt.improve", directory: path.resolve("project"), prompt: "Fix it" };
    expect(decodeCommand(valid)).toEqual(valid);
    for (const fields of [{ directory: "" }, { prompt: 42 }, { modelSelection: {} }, { protectedText: "file.ts" }, { protectedText: [42] }]) {
      expect(() => decodeCommand({ ...valid, ...fields })).toThrow();
    }
  });
});
