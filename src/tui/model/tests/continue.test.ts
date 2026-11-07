import { describe, expect, it } from "vitest";

import { continueScheduledFor, continueSelectionsEqual, rebaseContinueSelection } from "../continue.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import type { ModelSelection } from "../../../core/types.js";

const GRACE_MS = 15_000;

function provider(instanceId: string, models: ProviderSummary["models"]): ProviderSummary {
  return {
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    authStatus: "authenticated",
    models,
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };
}

function efforts(id: string, choices: string[], isDefault: string | null = null) {
  return [{
    id,
    label: id,
    currentValue: null,
    choices: choices.map((choice) => ({ id: choice, label: choice, isDefault: choice === isDefault })),
  }];
}

const providers: ProviderSummary[] = [
  provider("claude", [
    { slug: "opus", name: "Opus", isCustom: false, isDefault: true, isHidden: false, efforts: efforts("effort", ["low", "medium", "high"], "medium") },
    { slug: "sonnet", name: "Sonnet", isCustom: false, isDefault: false, isHidden: false, efforts: efforts("effort", ["minimal", "low", "medium"], "low") },
  ]),
  provider("other", [
    { slug: "remote", name: "Remote", isCustom: false, isDefault: true, isHidden: false, efforts: efforts("reasoningEffort", ["low", "high"], "low") },
  ]),
];

describe("rebaseContinueSelection", () => {
  it("keeps an effort choice the new model also offers", () => {
    const base: ModelSelection = { instanceId: "claude", model: "opus", options: [{ id: "effort", value: "low" }] };
    expect(rebaseContinueSelection(base, providers, { instanceId: "claude", model: "sonnet" })).toEqual({
      instanceId: "claude",
      model: "sonnet",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("drops an effort choice the new model does not offer and falls back to its enforced default", () => {
    const base: ModelSelection = { instanceId: "claude", model: "opus", options: [{ id: "effort", value: "high" }] };
    expect(rebaseContinueSelection(base, providers, { instanceId: "claude", model: "sonnet" })).toEqual({
      instanceId: "claude",
      model: "sonnet",
      options: [{ id: "effort", value: "medium" }],
    });
  });

  it("drops effort descriptors the new model has none of and fills its own defaults", () => {
    const base: ModelSelection = { instanceId: "claude", model: "opus", options: [{ id: "effort", value: "medium" }] };
    expect(rebaseContinueSelection(base, providers, { instanceId: "other", model: "remote" })).toEqual({
      instanceId: "other",
      model: "remote",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("keeps boolean flags across models", () => {
    const base: ModelSelection = { instanceId: "claude", model: "opus", options: [{ id: "fastMode", value: true }] };
    expect(rebaseContinueSelection(base, providers, { instanceId: "other", model: "remote" }).options).toContainEqual({ id: "fastMode", value: true });
  });
});

describe("continueSelectionsEqual", () => {
  it("ignores option order but not values", () => {
    const selection: ModelSelection = {
      instanceId: "claude",
      model: "opus",
      options: [{ id: "effort", value: "low" }, { id: "fastMode", value: true }],
    };
    const reordered: ModelSelection = {
      instanceId: "claude",
      model: "opus",
      options: [{ id: "fastMode", value: true }, { id: "effort", value: "low" }],
    };
    expect(continueSelectionsEqual(selection, reordered)).toBe(true);
    expect(continueSelectionsEqual(selection, { ...selection, model: "sonnet" })).toBe(false);
    expect(continueSelectionsEqual(selection, { instanceId: "claude", model: "opus" })).toBe(false);
  });
});

describe("continueScheduledFor", () => {
  const resetsAt = new Date("2026-11-06T12:00:00.000Z");
  const before = resetsAt.getTime() - 60_000;

  it("holds the same provider's continuation for the reset plus a grace", () => {
    expect(continueScheduledFor({ resetsAt, sameProvider: true, now: before, graceMs: GRACE_MS }))
      .toBe(new Date(resetsAt.getTime() + GRACE_MS).toISOString());
  });

  it("does not hold another provider's continuation for the old provider's reset", () => {
    expect(continueScheduledFor({ resetsAt, sameProvider: false, now: before, graceMs: GRACE_MS })).toBeUndefined();
  });

  it("does not hold anything once the reset has passed or when no limit stands", () => {
    expect(continueScheduledFor({ resetsAt, sameProvider: true, now: resetsAt.getTime() + 1, graceMs: GRACE_MS })).toBeUndefined();
    expect(continueScheduledFor({ resetsAt: null, sameProvider: true, now: before, graceMs: GRACE_MS })).toBeUndefined();
  });
});
