import { describe, expect, it } from "vitest";
import { MOXEN_MCP_SERVER_NAME, moxenMcpServerSpec } from "../main.js";
import { STANDALONE_MCP_ARG } from "../../../core/infra/standalone.js";

describe("moxenMcpServerSpec", () => {
  it("re-runs the standalone binary in its internal MCP mode", () => {
    expect(moxenMcpServerSpec("thread-1", true)).toEqual({
      name: MOXEN_MCP_SERVER_NAME,
      type: "stdio",
      command: process.execPath,
      args: [STANDALONE_MCP_ARG, "--thread", "thread-1"],
      env: {},
    });
  });

  it("runs the entry on this runtime otherwise", () => {
    const spec = moxenMcpServerSpec("thread-1", false);
    expect(spec.name).toBe(MOXEN_MCP_SERVER_NAME);
    expect(spec.type).toBe("stdio");
    expect(spec.args.slice(-2)).toEqual(["--thread", "thread-1"]);
    expect(spec.args).not.toContain(STANDALONE_MCP_ARG);
  });
});
