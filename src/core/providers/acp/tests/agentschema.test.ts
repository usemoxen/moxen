import { describe, expect, it } from "vitest";

import { normalizeConfig, setConfigValue } from "../../../config.js";
import { duplicateListItem } from "../../../configlist.js";
import { describeSettings, listTarget } from "../../../configschema.js";
import { toRegistryPreset } from "../registry.js";

const AGENTS = "providers.acp.agents";

describe("ACP agents list schema & CRUD", () => {
  it("supports creating, editing, duplicating, describing, and removing ACP agent profiles", () => {
    let config = normalizeConfig({});
    config = setConfigValue(
      config,
      `${AGENTS}[cline]`,
      JSON.stringify({ name: "Cline", command: "npx", args: ["-y", "@cline/acp"], enabled: true }),
    );
    expect(config.providers?.acp?.agents).toEqual([
      { id: "cline", name: "Cline", command: "npx", args: ["-y", "@cline/acp"], enabled: true },
    ]);

    config = setConfigValue(config, `${AGENTS}[cline].defaultModel`, "claude-sonnet");
    expect(config.providers?.acp?.agents?.[0]?.defaultModel).toBe("claude-sonnet");

    config = duplicateListItem(config, listTarget(`${AGENTS}[cline]`)!, "cline-work", `${AGENTS}[cline-work]`);
    expect(config.providers?.acp?.agents?.map((a) => a.id)).toEqual(["cline", "cline-work"]);

    const view = describeSettings(config).find((entry) => entry.descriptor.key === AGENTS);
    expect(view?.items?.map((item) => item.id)).toEqual(["cline", "cline-work"]);
    expect(view?.items?.[0]?.title).toBe("Cline");

    config = setConfigValue(config, `${AGENTS}[cline]`, "");
    expect(config.providers?.acp?.agents?.map((a) => a.id)).toEqual(["cline-work"]);
  });

  it("converts ACP Registry entries into platform launch presets even when npx is not yet installed", () => {
    const preset = toRegistryPreset(
      {
        id: "demo",
        name: "Demo Agent",
        version: "1.0.0",
        description: "Demo ACP agent",
        distribution: {
          npx: { package: "@demo/acp", args: ["--stdio"], env: { DEMO_MODE: "1" } },
        },
      },
      { hasCommand: () => false },
    );
    expect(preset).toEqual({
      id: "demo",
      name: "Demo Agent",
      description: "Demo ACP agent",
      version: "1.0.0",
      command: "npx",
      args: ["-y", "@demo/acp", "--stdio"],
      env: { DEMO_MODE: "1" },
      available: false,
      note: "Requires npx to launch Demo Agent.",
    });
  });
});
