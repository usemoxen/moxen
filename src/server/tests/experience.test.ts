import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, setConfigValue } from "../../core/config.js";
import { tempDir } from "../../core/testing/tmp.js";
import { DirectConnection } from "../connection.js";
import { decodeCommand, decodeQuery } from "../protocol.js";

describe("onboarding and release state through the server", () => {
  it("reads without creating state and merges acknowledgements from simultaneous clients", async () => {
    const storeRoot = tempDir("moxen-experience-");
    const first = new DirectConnection({ storeRoot });
    const second = new DirectConnection({ storeRoot });
    expect(decodeQuery({ type: "experience.read" })).toEqual({ type: "experience.read" });
    const initial = await first.query({ type: "experience.read" });
    expect(initial).toMatchObject({ onboardingCompleted: false, seenReleases: [] });
    await expect(readFile(path.join(storeRoot, "experience.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const release = initial.releases[0]!.version;
    await Promise.all([
      first.dispatch(decodeCommand({ type: "experience.update", completeOnboarding: true })),
      second.dispatch(decodeCommand({ type: "experience.update", seenRelease: release })),
    ]);
    const reopened = new DirectConnection({ storeRoot });
    expect(await reopened.query({ type: "experience.read" })).toMatchObject({ onboardingCompleted: true, seenReleases: [release] });
    await reopened.dispatch({ type: "experience.update", completeOnboarding: false, seenRelease: release });
    expect(await second.query({ type: "experience.read" })).toMatchObject({ onboardingCompleted: true, seenReleases: [release] });
    await expect(first.dispatch({ type: "experience.update", seenRelease: "unshipped" })).rejects.toThrow(/not included/);
    await Promise.all([first.close(), second.close(), reopened.close()]);
  });

  it("recovers malformed state without reading another store", async () => {
    const storeRoot = tempDir("moxen-experience-corrupt-");
    await writeFile(path.join(storeRoot, "experience.json"), "{broken");
    const connection = new DirectConnection({ storeRoot });
    expect(await connection.query({ type: "experience.read" })).toMatchObject({ onboardingCompleted: false, seenReleases: [] });
    await connection.dispatch({ type: "experience.update", completeOnboarding: true });
    const other = new DirectConnection({ storeRoot: tempDir("moxen-experience-other-") });
    expect(await other.query({ type: "experience.read" })).toMatchObject({ onboardingCompleted: false, seenReleases: [] });
    await Promise.all([connection.close(), other.close()]);
  });
});

describe("embedding preference is independent of model provisioning", () => {
  it("round trips through the shared setting without replacing the memory switch", () => {
    const selected = setConfigValue(DEFAULT_CONFIG, "memoryEmbeddings", "true");
    expect(normalizeConfig(selected)).toMatchObject({ memoryEmbeddings: true });
    const disabled = setConfigValue(selected, "memory", "false");
    expect(normalizeConfig(disabled)).toMatchObject({ memory: false, memoryEmbeddings: true });
    expect(normalizeConfig(setConfigValue(disabled, "memoryEmbeddings", "false"))).toMatchObject({ memory: false, memoryEmbeddings: false });
    expect(() => normalizeConfig({ memoryEmbeddings: "automatic" })).toThrow(/true or false/);
  });
});
