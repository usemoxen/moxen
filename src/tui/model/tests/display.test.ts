import { describe, expect, it } from "vitest";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
import {
  defaultEffortChoice,
  displayAccountLabel,
  displayEffort,
  displayModelName,
  findProviderForInstance,
  isEffortDescriptor,
  isTerminalTooSmall,
  describeEffort,
  modelRowDetail,
  prettifyModelSlug,
  turnModelSelection,
} from "../display.js";

function providers(): ProviderSummary[] {
  return [
    {
      instanceId: "opencode",
      driver: "opencode",
      displayName: "OpenCode Zen",
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [
        {
          slug: "opencode/muse-spark-1.3-contributor-free",
          name: "Muse Spark 1.3 Free",
          isCustom: false,
          isDefault: true,
          isHidden: false,
          efforts: [
            {
              id: "effort",
              label: "Effort",
              choices: [
                { id: "low", label: "Low", isDefault: false },
                { id: "xhigh", label: "xhigh", isDefault: true },
              ],
              currentValue: "xhigh",
            },
          ],
        },
      ],
      usageLimits: null,
      supportedRuntimeModes: null,
      skills: [],
    },
    {
      instanceId: "claudeAgent",
      driver: "claude",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [
        {
          slug: "claude-opus-5",
          name: "Claude Opus 5",
          isCustom: false,
          isDefault: null,
          isHidden: false,
          efforts: [
            {
              id: "effort",
              label: "Reasoning",
              // Claude's driver never populates `currentValue`; only the
              // per-choice `isDefault` flag says what the default is.
              choices: [
                { id: "low", label: "Low", isDefault: null },
                { id: "high", label: "High", isDefault: true },
              ],
              currentValue: null,
            },
          ],
        },
      ],
      usageLimits: null,
      supportedRuntimeModes: null,
      skills: [],
    },
  ];
}

describe("displayModelName", () => {
  it("prefers the catalog name over the raw slug", () => {
    expect(
      displayModelName(providers(), {
        instanceId: "opencode",
        model: "opencode/muse-spark-1.3-contributor-free",
      }),
    ).toBe("Muse Spark 1.3 Free");
  });

  it("prettifies the slug while the catalog is still loading", () => {
    expect(
      displayModelName(null, {
        instanceId: "opencode",
        model: "opencode/muse-spark-1.3-contributor-free",
      }),
    ).toBe("Muse Spark 1.3 Contributor Free");
  });

  it("renders a dash without a selection", () => {
    expect(displayModelName(providers(), undefined)).toBe("-");
  });
});

describe("displayAccountLabel", () => {
  it("shows the account qualifier only when multiple accounts of the same provider exist", () => {
    const base = {
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [],
      usageLimits: null,
      supportedRuntimeModes: null,
      skills: [],
    };
    const multi = [
      { ...base, instanceId: "chatgpt/default", driver: "chatgpt", displayName: "ChatGPT (Default)" },
      { ...base, instanceId: "chatgpt/trial", driver: "chatgpt", displayName: "ChatGPT (Trial)" },
      { ...base, instanceId: "claude/default", driver: "claude", displayName: "Claude Code (Default)" },
    ];
    expect(displayAccountLabel(multi, { instanceId: "chatgpt/trial", model: "gpt-6.2-astra" })).toBe("Trial");
    expect(displayAccountLabel(multi, { instanceId: "chatgpt/default", model: "gpt-6.2-astra" })).toBe("Default");
    expect(displayAccountLabel(multi, { instanceId: "claude/default", model: "claude-opus-5-5" })).toBeNull();
  });
});

describe("prettifyModelSlug", () => {
  it("keeps version tokens intact", () => {
    expect(prettifyModelSlug("claude-opus-5")).toBe("Claude Opus 5");
  });
});

describe("displayEffort", () => {
  it("resolves the effort choice label", () => {
    expect(
      displayEffort(providers(), {
        instanceId: "opencode",
        model: "opencode/muse-spark-1.3-contributor-free",
        options: [{ id: "effort", value: "xhigh" }],
      }),
    ).toBe("xhigh");
  });

  it("falls back to the raw value without a catalog", () => {
    expect(
      displayEffort(null, {
        instanceId: "opencode",
        model: "opencode/muse-spark-1.3-contributor-free",
        options: [{ id: "effort", value: "xhigh" }],
      }),
    ).toBe("xhigh");
  });

  it("falls back to the model's default effort without an explicit choice", () => {
    expect(
      displayEffort(providers(), { instanceId: "opencode", model: "opencode/muse-spark-1.3-contributor-free" }),
    ).toBe("xhigh");
  });

  it("returns null for a model with no effort descriptors and no options", () => {
    const noEffortProviders: ProviderSummary[] = [
      {
        ...providers()[0]!,
        models: [{ ...providers()[0]!.models[0]!, efforts: [] }],
      },
    ];
    expect(
      displayEffort(noEffortProviders, { instanceId: "opencode", model: "opencode/muse-spark-1.3-contributor-free" }),
    ).toBeNull();
  });

  it("falls back to the isDefault choice when currentValue is null (Claude's driver)", () => {
    expect(displayEffort(providers(), { instanceId: "claudeAgent", model: "claude-opus-5" })).toBe("High");
  });

  it("falls back to the enforced default when nothing is picked and no catalog default exists", () => {
    const unset: ProviderSummary[] = [
      {
        ...providers()[0]!,
        models: [
          {
            ...providers()[0]!.models[0]!,
            efforts: [
              {
                id: "effort",
                label: "Effort",
                choices: [
                  { id: "low", label: "Low", isDefault: null },
                  { id: "medium", label: "Medium", isDefault: null },
                  { id: "high", label: "High", isDefault: null },
                ],
                currentValue: null,
              },
            ],
          },
        ],
      },
    ];
    // Medium, not blank — the knob is always populated now.
    expect(
      displayEffort(unset, { instanceId: "opencode", model: "opencode/muse-spark-1.3-contributor-free" }),
    ).toBe("Medium");
  });
});

describe("defaultEffortChoice", () => {
  it("prefers medium, else the middle choice", () => {
    const ids = (values: string[]) => ({
      id: "effort",
      label: "Effort",
      choices: values.map((id) => ({ id, label: id, isDefault: null })),
      currentValue: null,
    });
    expect(defaultEffortChoice(ids(["low", "medium", "high"]))).toBe("medium");
    expect(defaultEffortChoice(ids(["low", "high", "max"]))).toBe("high");
    expect(defaultEffortChoice(ids(["only"]))).toBe("only");
    expect(defaultEffortChoice(ids([]))).toBeNull();
  });

  it("recognizes effort descriptor ids only", () => {
    expect(isEffortDescriptor("reasoningEffort")).toBe(true);
    expect(isEffortDescriptor("effort")).toBe(true);
    expect(isEffortDescriptor("thinking")).toBe(true);
    expect(isEffortDescriptor("contextWindow")).toBe(false);
  });
});

describe("isTerminalTooSmall", () => {
  it.each([
    [180, 47, false],
    [300, 60, false],
    [179, 47, true],
    [180, 46, true],
    [140, 26, true],
    [0, 0, true],
  ])("maps %ix%i to too-small=%s", (width, height, expected) => {
    expect(isTerminalTooSmall(width, height)).toBe(expected);
  });
});

describe("turnModelSelection", () => {
  const current = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const earlier = { instanceId: "claudeAgent", model: "claude-opus-5" };
  const thread = { modelSelection: current, turnModelSelections: { "turn-1": earlier } };

  it("labels a turn with the model it ran on, not the thread's current one", () => {
    expect(turnModelSelection(thread, "turn-1")).toEqual(earlier);
  });

  it("falls back to the thread's model for unrecorded and live turns", () => {
    expect(turnModelSelection(thread, "turn-legacy")).toEqual(current);
    expect(turnModelSelection(thread, null)).toEqual(current);
    expect(turnModelSelection({ modelSelection: current }, "turn-1")).toEqual(current);
    expect(turnModelSelection(null, "turn-1")).toBeUndefined();
  });
});

describe("modelRowDetail", () => {
  const effort = (...ids: string[]) => [{ id: "effort", label: "Effort", currentValue: null, choices: ids.map((id) => ({ id, label: id, isDefault: null })) }];
  it("tags the default and gives the range of reasoning levels", () => {
    expect(modelRowDetail({ isDefault: true, efforts: effort("low", "medium", "max") })).toEqual({ badge: "default", meta: "low–max" });
    expect(modelRowDetail({ isDefault: false, efforts: effort("low") })).toEqual({ meta: "low" });
    expect(modelRowDetail({ isDefault: null, efforts: [] })).toEqual({});
  });
  it("leaves out knobs that are not reasoning levels", () => {
    expect(modelRowDetail({ isDefault: null, efforts: [{ id: "fastMode", label: "Fast", currentValue: null, choices: [{ id: "on", label: "on", isDefault: null }] }] })).toEqual({});
  });
});

describe("describeEffort", () => {
  it("says what a level means, and that it is the default when it is", () => {
    expect(describeEffort("medium", false)).toBe("Balanced speed and depth");
    expect(describeEffort("medium", true)).toBe("Balanced speed and depth · default for this model");
    expect(describeEffort("HIGH", false)).toBe("Deeper reasoning for harder tasks");
    expect(describeEffort("ultra", false)).toBe("Maximum reasoning with automatic task delegation");
  });
  it("has nothing to say about a level it does not know, except that it is the default", () => {
    expect(describeEffort("turbo", false)).toBeUndefined();
    expect(describeEffort("turbo", true)).toBe("The default effort for this model");
  });
});

describe("findProviderForInstance", () => {
  const catalog: ProviderSummary[] = [
    {
      ...providers()[0]!,
      instanceId: "antigravity/default",
      driver: "antigravity",
      displayName: "Antigravity (Default)",
    },
    {
      ...providers()[0]!,
      instanceId: "antigravity/work",
      driver: "antigravity",
      displayName: "Antigravity (Work)",
    },
    {
      ...providers()[1]!,
      instanceId: "claude/default",
      driver: "claude",
      displayName: "Claude Code (Default)",
    },
  ];

  it("matches explicit account instanceIds strictly and resolves legacy bare IDs to <driver>/default", () => {
    expect(findProviderForInstance(catalog, "antigravity/work")?.instanceId).toBe("antigravity/work");
    expect(findProviderForInstance(catalog, "antigravity/missing")).toBeUndefined();
    expect(findProviderForInstance(catalog, "antigravity")?.instanceId).toBe("antigravity/default");
    expect(findProviderForInstance(catalog, "claudeAgent")?.instanceId).toBe("claude/default");
    expect(findProviderForInstance(catalog, "claude")?.instanceId).toBe("claude/default");
  });
});
