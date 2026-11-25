import { describe, expect, it } from "vitest";

import { resolveCompactionSettings } from "../profiles.js";
import { chatCompletionsUrl, harnessProfileId, normalizeHarnessConfig, readProfileApiKey, resolveHarnessTarget } from "../profiles.js";

const profile = {
  id: "colab",
  baseUrl: "https://example.trycloudflare.com",
  apiKeyEnv: "COLAB_KEY",
  models: [{ id: "qwen3.8-flash-next", contextWindow: 262144, vision: true }],
};

describe("harness profiles", () => {
  it("rejects an apiKeyEnv that looks like a key, without echoing it", () => {
    const key = "sk-test-0000000000";
    let message = "";
    try {
      normalizeHarnessConfig({ profiles: [{ ...profile, apiKeyEnv: key }] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/NAME of an environment variable/);
    expect(message).not.toContain(key);
  });

  it("rejects a base URL with credentials in it and a profile id used twice", () => {
    expect(() => normalizeHarnessConfig({ profiles: [{ ...profile, baseUrl: "https://user:pw@host" }] })).toThrow(/without credentials/);
    expect(() => normalizeHarnessConfig({ profiles: [profile, profile] })).toThrow(/uses an id twice/);
  });

  it("keeps a model's effort levels and the guard switches, and rejects junk", () => {
    const config = normalizeHarnessConfig({ profiles: [{ ...profile, models: [{ id: "m", efforts: [" low ", "high", "low"] }], loopGuard: { text: false, calls: true } }] });
    expect(config?.profiles?.[0]?.models[0]?.efforts).toEqual(["low", "high"]);
    expect(config?.profiles?.[0]?.loopGuard).toEqual({ text: false, calls: true });
    expect(() => normalizeHarnessConfig({ profiles: [{ ...profile, models: [{ id: "m", efforts: [3] }] }] })).toThrow(/efforts/);
    expect(() => normalizeHarnessConfig({ profiles: [{ ...profile, loopGuard: { text: "no" } }] })).toThrow(/loopGuard\.text/);
  });

  it("loads a valid profile and keeps its model facts", () => {
    const config = normalizeHarnessConfig({ profiles: [{ ...profile, sampling: { temperature: 1, topK: 20 }, slots: 1 }] });
    expect(config?.profiles?.[0]).toMatchObject({ id: "colab", apiFormat: "chat", slots: 1, sampling: { temperature: 1, topK: 20 } });
  });

  it("sends a model the profile does not list as asked, with the quirks its name implies", () => {
    const config = normalizeHarnessConfig({ profiles: [profile] });
    const known = resolveHarnessTarget(config, "harness/colab", "qwen3.8-flash-next");
    expect(known.quirks.images).toBe("native");
    expect(known.quirks.chatTemplateKwargs).toEqual({ preserve_thinking: true });
    const unlisted = resolveHarnessTarget(config, "harness/colab", "mistral-small");
    expect(unlisted.model).toEqual({ id: "mistral-small" });
    expect(unlisted.quirks.assistantAfterToolResult).toBe(true);
    const anthropicConfig = normalizeHarnessConfig({ profiles: [{ ...profile, id: "ant", apiFormat: "anthropic" }] });
    expect(resolveHarnessTarget(anthropicConfig, "harness/ant", "my-proxy-model").quirks.images).toBe("native");
    expect(resolveHarnessTarget(anthropicConfig, "harness/ant", "qwen4-max-preview").quirks).toMatchObject({ effortParam: "reasoning_effort", images: "native" });
    expect(() => resolveHarnessTarget(config, "harness/other", "x")).toThrow(/No harness profile "other"/);
  });

  it("builds the endpoint URL with or without /v1 and reads the key only from the named variable", () => {
    expect(chatCompletionsUrl("https://h.example/")).toBe("https://h.example/v1/chat/completions");
    expect(chatCompletionsUrl("https://h.example/v1/")).toBe("https://h.example/v1/chat/completions");
    expect(harnessProfileId("harness/Colab")).toBe("colab");
    expect(harnessProfileId("opencode/openai")).toBeNull();
    const config = normalizeHarnessConfig({ profiles: [profile] })!.profiles![0]!;
    expect(readProfileApiKey(config, { COLAB_KEY: " abc " })).toBe("abc");
    expect(readProfileApiKey(config, {})).toBeUndefined();
  });

  it("resolves compaction settings from the profile, then the config-wide defaults, then ours, and rejects nonsense", () => {
    const own = normalizeHarnessConfig({ profiles: [{ ...profile, compaction: { fraction: 0.5, effort: "minimal" } }] })!;
    const defaults = { ...own, autoCompact: false, autoCompactPercent: 80, keepRecentTokens: 9000 };
    expect(resolveCompactionSettings(defaults, own.profiles![0]!)).toMatchObject({ auto: false, fraction: 0.5, keepRecentTokens: 9000, effort: "minimal" });
    expect(resolveCompactionSettings(undefined, normalizeHarnessConfig({ profiles: [profile] })!.profiles![0]!)).toMatchObject({ auto: true, fraction: null, keepRecentTokens: 16384, effort: "low" });
    expect(resolveCompactionSettings({ profiles: [], autoCompactPercent: 80 }, own.profiles![0]!).fraction).toBe(0.5);
    expect(() => normalizeHarnessConfig({ profiles: [{ ...profile, compaction: { fraction: 2 } }] })).toThrow(/compaction\.fraction/);
    expect(() => normalizeHarnessConfig({ profiles: [{ ...profile, compaction: { auto: "yes" } }] })).toThrow(/compaction\.auto/);
  });
});
