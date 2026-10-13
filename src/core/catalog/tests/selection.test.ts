import { describe, expect, it } from "vitest";

import { CliError } from "../../errors.js";
import { parseClaudeModels } from "../../providers/claude/catalog.js";
import { defaultModelSelection } from "../selection.js";

const only = (...binaries: string[]) => (binary: string) => binaries.includes(binary);

describe("installation default model", () => {
  it("prefers Claude on its bundled catalog default", () => {
    const expected = parseClaudeModels().find((model) => model.isDefault === true)!.slug;
    expect(defaultModelSelection({ env: {}, installed: only("claude", "opencode") })).toEqual({
      instanceId: "claudeAgent",
      model: expected,
    });
  });

  it("never picks OpenCode, and says so when nothing else is installed", () => {
    let failure: unknown;
    try {
      defaultModelSelection({ env: {}, installed: only("opencode") });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("NO_DEFAULT_MODEL");
  });

  it("is pinned outright by MOXEN_DEFAULT_MODEL, whatever is installed", () => {
    const env = { MOXEN_DEFAULT_MODEL: "opencode/opencode/muse" };
    expect(defaultModelSelection({ env, installed: only() })).toEqual({ instanceId: "opencode", model: "opencode/muse" });
    expect(() => defaultModelSelection({ env: { MOXEN_DEFAULT_MODEL: "claudeAgent" }, installed: only() })).toThrow(
      /MOXEN_DEFAULT_MODEL/,
    );
  });
});
