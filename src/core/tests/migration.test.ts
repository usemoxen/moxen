/**
 * Old config files, shaped as real ones were before the settings were reshaped
 * (MXN-91), loaded the way every build loads them and checked on what they
 * *do*: the line a thread hands off or compacts at, the browser web_fetch may
 * start, the tools and skills a session gets, the requests a profile sends.
 * Keychain references only, never a secret.
 *
 * The rule they all follow: an older key stays readable and hidden, a new key
 * wins once it is set, and nothing is rewritten on load (see `docs/cli.md`).
 */
import { describe, expect, it } from "vitest";

import { normalizeConfig, setConfigValue } from "../config.js";
import { describeSettings, readSetting, settingDescriptor } from "../configschema.js";
import { configuredModel } from "../catalog/selection.js";
import { moxenToolsOf } from "../mcp.js";
import { describeMcpServers } from "../mcpview.js";
import { resolveCompactionSettings, resolveHarnessTarget } from "../providers/harness/profiles.js";
import { searchKeyFor, webPolicy } from "../providers/harness/web/settings.js";
import { driverProviders, longThreadPolicy } from "../threads/longthreads.js";

/** A Claude Code user from before the reshaping, with a local server behind the Harness. */
const BEFORE = {
  threadEnvMode: "auto",
  model: "gpt-6",
  sessionTtl: "2m",
  installSkills: false,
  ui: { autoHandoff: "ask", autoHandoffPercent: 60 },
  mcpServers: {
    docs: { command: "docs-mcp", providers: ["claude"] },
    moxen: { type: "http", url: "http://127.0.0.1:9999/mcp" },
  },
  providers: {
    claude: { autoCompact: "auto", autoCompactPercent: 75, agentSkills: false, moxenTools: false, autoHandoffModels: { "claude-opus-5": 500_000 } },
    opencode: { compactBuffer: 16_384, bundledSkills: false },
    harness: {
      webBrowser: "off",
      webBrowserPath: "/opt/chrome/chrome",
      webPrivateNetwork: true,
      webSearch: "exa",
      webSearchKey: "keychain:harness.webSearchKey",
      autoCompactTokens: 65_536,
      profiles: [
        {
          id: "local",
          baseUrl: "http://localhost:8080",
          preserveThinking: false,
          quirks: { images: "native" },
          compaction: { fraction: 0.7 },
          models: [{ id: "qwen3.6-27b", contextWindow: 131_072 }],
        },
      ],
    },
  },
};

const config = normalizeConfig(BEFORE);

describe("an old config, loaded", () => {
  it("hands off where it did: the old ui share for every model, a per-model size for the one that had it (4/12)", () => {
    expect(longThreadPolicy(config, "claudeAgent", "claude-sonnet-5").handoff).toEqual({ mode: "ask", line: { percent: 60 } });
    expect(longThreadPolicy(config, "claudeAgent", "claude-opus-5").handoff).toEqual({ mode: "ask", line: { tokens: 500_000 } });
    expect(longThreadPolicy(config, "opencode/opencode", "big-pickle").handoff).toEqual({ mode: "ask", line: { percent: 60 } });
  });

  it("compacts where it did: Claude Code by Moxen at 75%, OpenCode by its own buffer, the Harness at its size and the profile's share (4/12)", () => {
    expect(longThreadPolicy(config, "claudeAgent", "claude-sonnet-5").compact).toEqual({ mode: "auto", line: { percent: 75 } });
    const drivers = driverProviders(config);
    expect(drivers?.claude?.autoCompact).toBe("auto");
    expect(drivers?.opencode?.compactBuffer).toBe(16_384);
    expect(longThreadPolicy(config, "opencode/opencode", "big-pickle").compact).toBeNull();
    expect(drivers?.harness?.compactAt).toBe("64K");
    const profile = config.providers!.harness!.profiles![0]!;
    expect(resolveCompactionSettings(drivers?.harness, profile)).toMatchObject({ fraction: 0.7, tokens: null });
  });

  it("keeps the browser off and its program, opens private networks for the Harness alone, and sends the old key to the service it was for (5/12)", () => {
    const harness = config.providers?.harness;
    expect(webPolicy(config.web, harness, false)).toEqual({ browser: { mode: "off", path: "/opt/chrome/chrome" }, allowPrivate: false });
    expect(webPolicy(config.web, harness, true).allowPrivate).toBe(true);
    expect(searchKeyFor(harness, "exa")).toEqual({ keyRef: "keychain:harness.webSearchKey" });
    // Switching services later never hands that key to the other one.
    const switched = setConfigValue(config, "providers.harness.webSearch", "brave");
    expect(searchKeyFor(switched.providers?.harness, "brave")).toEqual({});
    expect(searchKeyFor(switched.providers?.harness, "exa")).toEqual({ keyRef: "keychain:harness.webSearchKey" });
  });

  it("gives Claude Code none of Moxen's tools, keeps the older server list as each provider's checklist, and names what a `moxen` entry does (6/12)", () => {
    expect(moxenToolsOf(config.providers?.claude)).toEqual({ orchestration: false, webFetch: false });
    expect(moxenToolsOf(config.providers?.opencode)).toEqual({ orchestration: true, webFetch: true });
    expect(config.providers?.opencode?.mcpExclude).toBe("docs");
    expect(config.providers?.harness?.mcpExclude).toBe("docs");
    expect(config.providers?.claude?.mcpExclude ?? "").not.toContain("docs");
    expect(describeMcpServers(config).find((item) => item.id === "moxen")?.status).toMatch(/^Replaces Moxen's built-in tools/);
  });

  it("still loads the skills switches Moxen no longer has a use for, and offers none of them (7/12, MXN-138)", () => {
    expect(readSetting(config, "installSkills")).toBe(false);
    expect(readSetting(config, "providers.opencode.bundledSkills")).toBe(false);
    for (const key of ["skills.moxen", "installSkills", "providers.claude.moxenSkills", "providers.opencode.moxenSkills", "providers.harness.moxenSkills", "providers.opencode.bundledSkills"]) {
      expect(settingDescriptor(key)?.hidden, key).toBe(true);
    }
  });

  it("sends the profile's requests as before: no reasoning back, no template flag for it, images to the model (8/12)", () => {
    const { quirks } = resolveHarnessTarget(config.providers?.harness, "harness/local", "qwen3.6-27b");
    expect(quirks).toMatchObject({ reasoningReplay: "none", chatTemplateKwargs: {}, images: "native" });
  });

  it("reads `auto` as the project checkout, and leaves a global Model aimed at no provider unused (3/12)", () => {
    expect(config.threadEnvMode).toBe("local");
    expect(configuredModel(config, "claudeAgent")).toBeUndefined();
    expect(describeSettings(config).find((view) => view.descriptor.key === "model")?.unavailable).toMatch(/^Ignored: gpt-6/);
  });

  it("keeps every older key readable, so a file written now still means the same to an older build", () => {
    for (const key of ["installSkills", "providers.claude.agentSkills", "providers.claude.moxenTools", "providers.claude.autoCompact", "providers.claude.autoCompactPercent", "providers.opencode.bundledSkills", "providers.opencode.compactBuffer", "providers.harness.webBrowser", "providers.harness.webPrivateNetwork", "providers.harness.webSearchKey", "ui.autoHandoff", "ui.autoHandoffPercent"]) {
      expect(readSetting(config, key), key).not.toBeUndefined();
    }
    // Loading rewrote nothing it did not have to: the older keys are still there to be saved back.
    const reloaded = normalizeConfig(JSON.parse(JSON.stringify(config)));
    expect(reloaded).toEqual(config);
  });
});

describe("the other shapes old files came in", () => {
  it("Claude Code compacting by itself with a window, or Moxen asking (4/12)", () => {
    const own = normalizeConfig({ providers: { claude: { autoCompact: "claude", autoCompactWindow: 400_000 } } });
    expect(driverProviders(own)?.claude).toMatchObject({ autoCompact: "claude", autoCompactWindow: 400_000 });
    expect(longThreadPolicy(own, "claudeAgent").compact).toBeNull();
    const asking = normalizeConfig({ providers: { claude: { autoCompact: "ask", autoCompactPercent: 85 } } });
    expect(longThreadPolicy(asking, "claudeAgent").compact).toEqual({ mode: "ask", line: { percent: 85 } });
  });

  it("the Harness compacting at a share of the window (4/12)", () => {
    const share = normalizeConfig({ providers: { harness: { autoCompactPercent: 70 } } });
    expect(driverProviders(share)?.harness?.compactAt).toBe("70%");
  });

  it("the single search key on Brave goes to Brave only (5/12)", () => {
    const brave = normalizeConfig({ providers: { harness: { webSearch: "brave", webSearchKeyEnv: "BRAVE_API_KEY" } } });
    expect(searchKeyFor(brave.providers?.harness, "brave")).toEqual({ keyEnv: "BRAVE_API_KEY" });
    expect(searchKeyFor(brave.providers?.harness, "exa")).toEqual({});
  });
});
