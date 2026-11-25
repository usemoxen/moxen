import { describe, expect, it } from "vitest";

import { duplicateListItem, readListValue } from "../configlist.js";
import { DEFAULT_CONFIG, normalizeConfig, setConfigValue } from "../config.js";
import { describeSettings, isSettingKey, listTarget, readSetting, settingDescriptor } from "../configschema.js";

const PROFILES = "providers.harness.profiles";
const profile = { baseUrl: "http://localhost:8080", models: [{ id: "qwen3:8b" }] };
const withProfile = () => setConfigValue(DEFAULT_CONFIG, `${PROFILES}[Local]`, JSON.stringify(profile));

describe("list settings", () => {
  it("round-trips a profile and its fields by id, ids with dots and colons included, and flat keys still work", () => {
    let config = withProfile();
    expect(config.providers?.harness?.profiles?.[0]).toMatchObject({ id: "local", apiFormat: "chat", baseUrl: "http://localhost:8080" });
    config = setConfigValue(config, `${PROFILES}[local].sampling.topK`, "20");
    config = setConfigValue(config, `${PROFILES}[local].models[qwen3:8b].contextWindow`, "262144");
    config = setConfigValue(config, `${PROFILES}[local].quirks.systemFirstOnly`, "false");
    config = setConfigValue(config, "providers.harness.autoCompactPercent", "80");
    expect(readSetting(config, `${PROFILES}[local].sampling.topK`)).toBe(20);
    expect(readSetting(config, `${PROFILES}[local].models[qwen3:8b].contextWindow`)).toBe(262144);
    expect(readSetting(config, `${PROFILES}[local].quirks.systemFirstOnly`)).toBe(false);
    expect(readSetting(config, "providers.harness.autoCompactPercent")).toBe(80);
    expect(readListValue(config, listTarget(`${PROFILES}[local]`)!)).toMatchObject({ id: "local", sampling: { topK: 20 } });
    // Clearing the last field of an object removes the object; clearing a model's field leaves the model.
    config = setConfigValue(config, `${PROFILES}[local].sampling.topK`, "");
    expect(config.providers?.harness?.profiles?.[0]).not.toHaveProperty("sampling");
    // A list entry adds to the model list and removes by id.
    config = setConfigValue(config, `${PROFILES}[local].models[other]`, "{}");
    expect(config.providers?.harness?.profiles?.[0]?.models.map((model) => model.id)).toEqual(["qwen3:8b", "other"]);
    config = setConfigValue(config, `${PROFILES}[local].models[other]`, "");
    expect(config.providers?.harness?.profiles?.[0]?.models).toHaveLength(1);
    config = setConfigValue(config, `${PROFILES}[local]`, "");
    expect(config.providers?.harness?.profiles).toBeUndefined();
  });

  it("accepts list keys alongside the flat ones and says what is wrong with a bad one", () => {
    expect(isSettingKey(PROFILES)).toBe(true);
    expect(isSettingKey(`${PROFILES}[x].baseUrl`)).toBe(true);
    expect(isSettingKey(`${PROFILES}[x`)).toBe(false);
    expect(isSettingKey("nonsense")).toBe(false);
    expect(settingDescriptor("sessionTtl")?.kind.type).toBe("duration");
    expect(() => setConfigValue(withProfile(), `${PROFILES}[local].bogus`, "1")).toThrow(/profile has no field "bogus"/);
    expect(() => setConfigValue(DEFAULT_CONFIG, `${PROFILES}[ghost].baseUrl`, "http://h")).toThrow(/No profile "ghost"/);
    expect(() => setConfigValue(DEFAULT_CONFIG, PROFILES, "{}")).toThrow(/JSON list/);
    expect(setConfigValue(withProfile(), PROFILES, "[]").providers).toBeUndefined();
  });

  it("names the field and never echoes a key-shaped value", () => {
    const secret = "sk-ant-0123456789abcdef";
    for (const [key, value] of [[`${PROFILES}[local].apiKeyEnv`, secret], [`${PROFILES}[local].baseUrl`, `https://user:${secret}@host`], [`${PROFILES}[local].sampling.topK`, secret]] as const) {
      let message = "";
      try {
        setConfigValue(withProfile(), key, value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(key.split("].")[1]!.split(".").pop()!);
      expect(message).not.toContain(secret);
    }
    expect(() => setConfigValue(DEFAULT_CONFIG, `${PROFILES}[a]`, JSON.stringify({ ...profile, apiKey: secret }))).toThrow(/apiKey.*OS keychain/);
  });

  it("describes each profile with where its values come from", () => {
    let config = setConfigValue(withProfile(), "providers.harness.autoCompactPercent", "80");
    config = setConfigValue(config, `${PROFILES}[local].compaction.keepRecentTokens`, "9000");
    const view = describeSettings(config).find((entry) => entry.descriptor.key === PROFILES)!;
    const item = view.items![0]!;
    const field = (path: string) => item.fields.find((entry) => entry.path === path)!;
    expect(field("compaction.keepRecentTokens")).toMatchObject({ value: 9000, explicit: true });
    // The share in force is said on the one row the page shows; the hidden older field has no row of its own.
    expect(field("compaction.tokens").effective).toEqual({ value: undefined, origin: "80% of the window, the Moxen Harness setting" });
    expect(field("compaction.fraction").effective).toBeUndefined();
    expect(field("compaction.effort").effective).toEqual({ value: "low", origin: "the default" });
    const model = field("models").items![0]!;
    expect(model.fields.find((entry) => entry.path === "family")?.effective).toEqual({ value: "qwen3", origin: "the model's name" });
    // Every other kind has no items.
    expect(describeSettings(config).filter((entry) => entry.items).map((entry) => entry.descriptor.key)).toEqual(["providers.acp.agents", PROFILES, "mcpServers"]);
  });

  it("lets the summary effort be only one its models list, and offers those", () => {
    const efforts = JSON.stringify({ ...profile, models: [{ id: "a", efforts: ["low", "high"] }, { id: "b", efforts: ["high", "max"] }] });
    const config = setConfigValue(DEFAULT_CONFIG, `${PROFILES}[local]`, efforts);
    expect(() => setConfigValue(config, `${PROFILES}[local].compaction.effort`, "medum")).toThrow(/one of the efforts its models list: low, high, max/);
    const set = setConfigValue(config, `${PROFILES}[local].compaction.effort`, "max");
    const item = describeSettings(set).find((entry) => entry.descriptor.key === PROFILES)!.items![0]!;
    expect(item.fields.find((entry) => entry.path === "compaction.effort")).toMatchObject({ value: "max", choices: [{ value: "low" }, { value: "high" }, { value: "max" }] });
    expect(() => setConfigValue(withProfile(), `${PROFILES}[local].compaction.effort`, "low")).toThrow(/none of this entry's models lists reasoning efforts/);
  });

  it("copies a profile without its probe results, under a lower-cased new id, and refuses a taken one", () => {
    const probed = { at: "2026-10-14T10:00:00.000Z", quirks: { images: "native" } };
    let config = setConfigValue(DEFAULT_CONFIG, `${PROFILES}[local]`, JSON.stringify({ ...profile, label: "Home", models: [{ id: "m", probed }] }));
    const list = listTarget(`${PROFILES}[local]`)!.list;
    config = normalizeConfig(duplicateListItem(config, listTarget(`${PROFILES}[local]`)!, "Copy", PROFILES));
    const copy = config.providers!.harness!.profiles!.find((entry) => entry.id === "copy")!;
    expect(copy.label).toBe("Home copy");
    expect(copy.models[0]).toEqual({ id: "m" });
    expect(config.providers!.harness!.profiles!.find((entry) => entry.id === "local")!.models[0]!.probed).toEqual(probed);
    expect(() => duplicateListItem(config, listTarget(`${PROFILES}[local]`)!, "copy", PROFILES)).toThrow(/already exists/);
    expect(list.kind.noun).toBe("profile");
  });
});
