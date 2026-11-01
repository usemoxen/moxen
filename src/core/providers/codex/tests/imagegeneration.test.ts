import { describe, expect, it, vi } from "vitest";
import type { JsonRpcPeer } from "../../stdio.js";
import { imageGenerationAvailability, imageGenerationModel } from "../imagegeneration.js";
import type { ModelSummary } from "../../../catalog/summary.js";

function model(slug: string, efforts: string[] = ["high", "none", "low"], hidden = false): ModelSummary {
  return { slug, name: slug, isHidden: hidden, isCustom: false, isDefault: false, efforts: [{ id: "effort", label: "Effort", currentValue: null, choices: efforts.map((id) => ({ id, label: id, isDefault: id === "high" })) }] };
}

describe("image-generation model selection", () => {
  it.each([
    { models: [model("gpt-6-luna")], selected: "gpt-6-luna" },
    { models: [model("gpt-6-luna"), model("gpt-6.1-luna")], selected: "gpt-6.1-luna" },
    { models: [model("gpt-6.9-luna"), model("gpt-6.10-luna")], selected: "gpt-6.10-luna" },
    { models: [model("gpt-6.10-luna"), model("gpt-7-luna")], selected: "gpt-7-luna" },
    { models: [model("gpt-6-luna-2026-09-01"), model("gpt-6-luna-2026-10-01"), model("gpt-6-luna")], selected: "gpt-6-luna" },
    { models: [model("gpt-6-luna-2026-09-01"), model("gpt-6-luna-2026-10-01")], selected: "gpt-6-luna-2026-10-01" },
    { models: [model("gpt-6-luna"), model("gpt-7-luna-preview"), model("gpt-7-luna", ["low"], true), model("gpt-8-astra")], selected: "gpt-6-luna" },
  ])("automatically picks the newest released Luna, independent of catalog order: $selected", ({ models, selected }) => {
    expect(imageGenerationModel(models)).toEqual({ model: selected, thinkingEffort: "low" });
    expect(imageGenerationModel([...models].reverse())).toEqual({ model: selected, thinkingEffort: "low" });
  });

  it("uses the lowest supported reasoning effort, never none or an invented default", () => {
    expect(imageGenerationModel([model("gpt-6-luna", ["max", "low", "minimal", "none"])])).toEqual({ model: "gpt-6-luna", thinkingEffort: "minimal" });
    expect(imageGenerationModel([model("gpt-6-luna", ["high", "medium", "none"])])).toEqual({ model: "gpt-6-luna", thinkingEffort: "medium" });
    for (const efforts of [[], ["none"], ["unknown"]]) expect(imageGenerationModel([model("gpt-6-luna", efforts)])).toBeNull();
  });

  it("does not silently fall back to an older Luna or a different family when the newest is unusable", () => {
    expect(imageGenerationModel([model("gpt-6-luna"), model("gpt-6.1-luna", ["none"])])).toBeNull();
    expect(imageGenerationModel([model("gpt-5.6-luna"), model("gpt-6-astra")])).toBeNull();
  });
});

describe("image-generation eligibility", () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const limits = (session = 97, weekly = 99) => ({ limitId: "codex", primary: { usedPercent: session, windowDurationMins: 300, resetsAt: reset }, secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: reset } });
  const peer = (account: unknown, snapshot: unknown) => ({ request: vi.fn(async (method: string) => method === "account/read" ? { account } : snapshot) }) as unknown as JsonRpcPeer;

  it.each([null, { type: "apiKey" }, { type: "chatgpt", planType: "free" }, { type: "chatgpt" }, { type: "chatgpt", planType: "unknown" }])("does not enable generation without a known paid subscription: %j", async (account) => {
    const connection = peer(account, { rateLimits: limits() });
    expect((await imageGenerationAvailability(connection)).available).toBe(false);
    expect(connection.request).toHaveBeenCalledTimes(1);
  });

  it("uses the codex bucket, requires both reserves, and does not infer a missing allowance", async () => {
    const account = { type: "chatgpt", planType: "plus" };
    expect((await imageGenerationAvailability(peer(account, { rateLimitsByLimitId: { codex: limits() }, rateLimits: { limitId: "spark" } }))).available).toBe(true);
    for (const snapshot of [undefined, limits(97.1), limits(0, 99.1), { ...limits(), secondary: null }, { ...limits(), limitId: "spark" }]) {
      expect((await imageGenerationAvailability(peer(account, { rateLimits: snapshot }))).available).toBe(false);
    }
  });
});
