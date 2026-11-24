import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../../config.js";
import { describeSettings, parseSettingValue, readSetting, settingDescriptor, writeSetting } from "../../configschema.js";
import { autoCompactThreshold, loopCompactThreshold } from "../../providers/harness/compactsettings.js";
import {
  recordChatGptContextWindows,
  resetChatGptContextWindowsForTests,
  resolveCompactionSettings,
} from "../../providers/harness/profiles.js";
import type { CliConfig, HarnessProfileConfig } from "../../types.js";
import {
  chatgptHarnessConfigFor,
  compactionModeFor,
  compactLineFor,
  driverProviders,
  handoffLineFor,
  handoffModeFor,
  lineText,
  longThreadPolicy,
  parseLine,
  planLongThreadAction,
  type LongThreadSnapshot,
} from "../longthreads.js";

type Config = Pick<CliConfig, "ui" | "providers" | "longThreads">;

const snapshot = (over: Partial<LongThreadSnapshot> = {}): LongThreadSnapshot => ({
  instanceId: "claudeAgent",
  model: "claude-opus-5",
  usedTokens: 120_000,
  maxTokens: 200_000,
  hasReply: true,
  turnRunning: false,
  runningSubthreads: 0,
  runningBackgroundTasks: 0,
  queuedMessages: 0,
  delegated: false,
  lastWasCompact: false,
  usedSinceCompact: null,
  continued: false,
  ...over,
});

describe("a line", () => {
  it("is a share or a size, in powers of two, and reads back as it is written", () => {
    expect(parseLine("70%")).toEqual({ percent: 70 });
    expect(parseLine("32K")).toEqual({ tokens: 32_768 });
    expect(parseLine("32k")).toEqual({ tokens: 32_768 });
    expect(parseLine("1M")).toEqual({ tokens: 1_048_576 });
    expect(parseLine(100_000)).toEqual({ tokens: 100_000 });
    expect(parseLine("100000")).toEqual({ tokens: 100_000 });
    for (const text of ["70%", "32K", "1M", "100000"]) expect(lineText(parseLine(text)!)).toBe(text);
  });

  it("refuses what no window could use", () => {
    for (const bad of ["5%", "99%", "70.5%", "2K", "3M", "soon", "", 1_000]) expect(parseLine(bad)).toBeNull();
  });
});

describe("an older config", () => {
  // The fixtures the old resolver was tested with (`resolveHandoff`, before MXN-99): the same lines must come out.
  it("hands off where it did: model, provider size, provider share, global size, global share, half", () => {
    const config: Config = {
      ui: { autoHandoffTokens: 65_536, autoHandoffPercent: 25 },
      providers: { claude: { autoHandoffModels: { "claude-opus": 500_000 }, autoHandoffTokens: 100_000 }, opencode: { autoHandoffPercent: 75 } },
    };
    expect(handoffLineFor(config, "claude", "claude-opus").value).toEqual({ tokens: 500_000 });
    expect(handoffLineFor(config, "claude", "claude-haiku").value).toEqual({ tokens: 100_000 });
    // A provider's share beats the global size.
    expect(handoffLineFor(config, "opencode", "gpt").value).toEqual({ percent: 75 });
    expect(handoffLineFor({ ui: { autoHandoffTokens: 65_536, autoHandoffPercent: 25 } }, "claude").value).toEqual({ tokens: 65_536 });
    expect(handoffLineFor({ ui: { autoHandoffPercent: 25 } }, "claude").value).toEqual({ percent: 25 });
    expect(handoffLineFor({}, "claude").value).toEqual({ percent: 50 });
  });

  it("keeps each provider's hand-off mode over the global one", () => {
    const config: Config = { ui: { autoHandoff: "off" }, providers: { opencode: { autoHandoff: "auto" } } };
    expect(handoffModeFor(config, "opencode")).toEqual({ value: "auto", key: "providers.opencode.autoHandoff" });
    expect(handoffModeFor(config, "claude")).toEqual({ value: "off", key: "ui.autoHandoff" });
    expect(handoffModeFor({}, "claude")).toEqual({ value: "ask", key: null });
  });

  it("compacts as its old switches said", () => {
    expect(compactionModeFor({ providers: { claude: { autoCompact: "claude" } } }, "claude").value).toBe("provider");
    expect(compactionModeFor({ providers: { claude: { autoCompact: "auto" } } }, "claude").value).toBe("auto");
    expect(compactionModeFor({}, "claude").value).toBe("ask");
    expect(compactionModeFor({ providers: { opencode: { autoCompact: false } } }, "opencode").value).toBe("off");
    expect(compactionModeFor({ providers: { opencode: { autoCompact: true } } }, "opencode").value).toBe("provider");
    expect(compactionModeFor({}, "opencode").value).toBe("provider");
    expect(compactionModeFor({ providers: { harness: { autoCompact: false } } }, "harness").value).toBe("off");
    expect(compactionModeFor({}, "harness").value).toBe("auto");
  });

  it("compacts a Claude Code thread at its old share, and passes Claude Code its old window", () => {
    expect(longThreadPolicy({ providers: { claude: { autoCompact: "auto", autoCompactPercent: 70 } } }, "claudeAgent").compact).toEqual({ mode: "auto", line: { percent: 70 } });
    expect(longThreadPolicy({}, "claudeAgent").compact).toEqual({ mode: "ask", line: { percent: 80 } });
    const own = driverProviders({ providers: { claude: { autoCompact: "claude", autoCompactWindow: 400_000 } } });
    expect(own?.claude).toMatchObject({ autoCompact: "claude", autoCompactWindow: 400_000 });
    // While Moxen compacts, the window means nothing to Claude Code: it is not sent.
    expect(driverProviders({ providers: { claude: { autoCompact: "ask", autoCompactWindow: 400_000 } } })?.claude?.autoCompactWindow).toBeUndefined();
  });

  it("leaves OpenCode's own switch where it was", () => {
    expect(driverProviders({})?.opencode?.autoCompact).toBeUndefined();
    expect(driverProviders({ providers: { opencode: { autoCompact: true } } })?.opencode?.autoCompact).toBe(true);
    expect(driverProviders({ providers: { opencode: { autoCompact: false } } })?.opencode?.autoCompact).toBe(false);
  });

  it("loads from the file with every old key still there, and a bare token count read as a line", () => {
    const loaded = normalizeConfig({
      ui: { autoHandoff: "auto", autoHandoffPercent: 40 },
      providers: { claude: { autoCompact: "claude", autoCompactWindow: 300_000 }, harness: { autoCompactTokens: 24_576 } },
      longThreads: { compactAt: 65_536, handoffAt: "60%" },
    });
    expect(loaded.ui).toMatchObject({ autoHandoff: "auto", autoHandoffPercent: 40 });
    expect(loaded.providers?.claude).toMatchObject({ autoCompact: "claude", autoCompactWindow: 300_000 });
    expect(loaded.longThreads).toEqual({ compactAt: "64K", handoffAt: "60%" });
    // The global line is newer than the older global keys beside it.
    expect(handoffLineFor(loaded, "claude").value).toEqual({ percent: 60 });
    expect(handoffModeFor(loaded, "claude").value).toBe("auto");
  });
});

describe("precedence", () => {
  // Specificity only: model, provider, global, built-in, whatever unit each level is written in.
  const cases: ReadonlyArray<{ name: string; config: Config; model?: string; line: unknown }> = [
    { name: "built-in", config: {}, line: { percent: 50 } },
    { name: "global share", config: { longThreads: { handoffAt: "40%" } }, line: { percent: 40 } },
    { name: "global size", config: { longThreads: { handoffAt: "64K" } }, line: { tokens: 65_536 } },
    { name: "provider share over global size", config: { longThreads: { handoffAt: "64K" }, providers: { claude: { handoffAt: "70%" } } }, line: { percent: 70 } },
    { name: "provider size over global share", config: { longThreads: { handoffAt: "40%" }, providers: { claude: { handoffAt: "128K" } } }, line: { tokens: 131_072 } },
    { name: "older provider share over global size", config: { longThreads: { handoffAt: "64K" }, providers: { claude: { autoHandoffPercent: 30 } } }, line: { percent: 30 } },
    { name: "provider over older provider", config: { providers: { claude: { handoffAt: "70%", autoHandoffTokens: 100_000 } } }, line: { percent: 70 } },
    { name: "model over provider share", config: { providers: { claude: { handoffAt: "70%", autoHandoffModels: { m: 300_000 } } } }, model: "m", line: { tokens: 300_000 } },
    { name: "another model follows the provider", config: { providers: { claude: { handoffAt: "70%", autoHandoffModels: { m: 300_000 } } } }, model: "n", line: { percent: 70 } },
  ];
  it.each(cases)("hand off at: $name", ({ config, model, line }) => {
    expect(handoffLineFor(config, "claude", model).value).toEqual(line);
  });

  it("compact at goes provider, global, 80%; the Harness keeps its own rule when nothing is set", () => {
    expect(compactLineFor({}, "claude")?.value).toEqual({ percent: 80 });
    expect(compactLineFor({ longThreads: { compactAt: "32K" } }, "claude")?.value).toEqual({ tokens: 32_768 });
    expect(compactLineFor({ longThreads: { compactAt: "32K" }, providers: { claude: { compactAt: "60%" } } }, "claude")?.value).toEqual({ percent: 60 });
    expect(compactLineFor({}, "harness")).toBeNull();
    expect(compactLineFor({ longThreads: { compactAt: "24K" } }, "harness")?.value).toEqual({ tokens: 24_576 });
    expect(compactLineFor({ longThreads: { compactAt: "24K" }, providers: { harness: { autoCompactPercent: 50 } } }, "harness")).toEqual({ value: { percent: 50 }, key: "providers.harness.autoCompactPercent" });
    // The provider's own compaction draws its own line; off has none.
    expect(compactLineFor({ longThreads: { compactAt: "60%" }, providers: { opencode: { compaction: "provider" } } }, "opencode")).toBeNull();
    expect(compactLineFor({ providers: { claude: { compaction: "off", compactAt: "60%" } } }, "claude")).toBeNull();
  });

  it("compact at, per model: that model compacts at its size, the others keep the provider's or the global line", () => {
    const config: Config = { longThreads: { compactAt: "70%" }, providers: { opencode: { compaction: "auto", compactAtModels: { big: 400_000 } }, claude: { compaction: "auto", compactAt: "60%", compactAtModels: { big: 400_000 } } } };
    expect(compactLineFor(config, "opencode", "big")).toEqual({ value: { tokens: 400_000 }, key: "providers.opencode.compactAtModels" });
    expect(compactLineFor(config, "opencode", "small")?.value).toEqual({ percent: 70 });
    expect(compactLineFor(config, "claude", "small")?.value).toEqual({ percent: 60 });
    expect(longThreadPolicy(config, "opencode", "big").compact).toEqual({ mode: "auto", line: { tokens: 400_000 } });
    expect(longThreadPolicy(config, "opencode", "small").compact).toEqual({ mode: "auto", line: { percent: 70 } });
    // Off stays off for every model; OpenCode compacting by itself draws no line of Moxen's.
    expect(compactLineFor({ providers: { claude: { compaction: "off", compactAtModels: { big: 400_000 } } } }, "claude", "big")).toBeNull();
    expect(compactLineFor({ providers: { opencode: { compaction: "provider", compactAtModels: { big: 400_000 } } } }, "opencode", "big")).toBeNull();
  });

  it("a model's own compaction line below its hand-off line still acts first", () => {
    const config: Config = { longThreads: { handoffAt: "60%" }, providers: { claude: { compaction: "auto", compactAt: "90%", compactAtModels: { "claude-opus-5": 100_000 } } } };
    expect(planLongThreadAction(config, snapshot({ usedTokens: 125_000 }))).toEqual({ kind: "compact", reason: "auto" });
    expect(planLongThreadAction(config, snapshot({ model: "other", usedTokens: 125_000 }))).toBeNull();
  });

  it("Claude Code compacting by itself gets each model's size as that model's window, kept between 100K and 1M", () => {
    const providers = driverProviders({ providers: { claude: { compaction: "provider", compactAt: "300K", compactAtModels: { big: 2_000_000, small: 40_000, mid: 500_000 } } } });
    expect(providers?.claude).toMatchObject({ autoCompact: "claude", autoCompactWindow: 307_200, autoCompactWindowModels: { big: 1_000_000, small: 100_000, mid: 500_000 } });
    // While Moxen compacts, the model's line goes through the policy instead.
    expect(driverProviders({ providers: { claude: { compaction: "auto", compactAtModels: { big: 500_000 } } } })?.claude?.autoCompactWindowModels).toBeUndefined();
  });
});

describe("the Harness", () => {
  const profile: HarnessProfileConfig = { id: "local", baseUrl: "http://localhost:1234/v1", models: [{ id: "m", contextWindow: 32_768 }] } as HarnessProfileConfig;

  it("lets a 32K model compact at a share or a size from the global line", () => {
    const share = resolveCompactionSettings(driverProviders({ longThreads: { compactAt: "60%" } })?.harness, profile);
    // 60% is 19,660 tokens, but 16K always stays free under the line.
    expect(autoCompactThreshold(32_768, share)).toBe(16_768);
    const size = resolveCompactionSettings(driverProviders({ longThreads: { compactAt: "24K" } })?.harness, profile);
    expect(autoCompactThreshold(32_768, size)).toBe(24_576);
  });

  it("puts a profile's own line first, then the tab's, whatever their units", () => {
    const tab = driverProviders({ providers: { harness: { compactAt: "16K" } } })?.harness;
    expect(resolveCompactionSettings(tab, { ...profile, compaction: { fraction: 0.5 } })).toMatchObject({ fraction: 0.5, tokens: null });
    expect(resolveCompactionSettings(tab, profile)).toMatchObject({ fraction: null, tokens: 16_384 });
    expect(resolveCompactionSettings(driverProviders({ providers: { harness: { compaction: "off" } } })?.harness, profile).auto).toBe(false);
  });

  it("puts the model's own size between the profile's and the tab's line", () => {
    const tab = driverProviders({ providers: { harness: { compactAt: "50%", compactAtModels: { m: 20_000 } } } })?.harness;
    expect(resolveCompactionSettings(tab, profile, "m")).toMatchObject({ fraction: null, tokens: 20_000 });
    expect(resolveCompactionSettings(tab, profile, "other")).toMatchObject({ fraction: 0.5, tokens: null });
    expect(resolveCompactionSettings(tab, { ...profile, compaction: { tokens: 12_000 } }, "m")).toMatchObject({ tokens: 12_000 });
  });
});

describe("the global Compaction", () => {
  it("applies where a provider's tab leaves it unset, below the provider's own and its older key", () => {
    const global: Config = { longThreads: { compaction: "auto" } };
    expect(compactionModeFor(global, "claude")).toEqual({ value: "auto", key: "longThreads.compaction" });
    expect(compactionModeFor(global, "opencode").value).toBe("auto");
    expect(compactionModeFor({ ...global, providers: { opencode: { compaction: "provider" } } }, "opencode")).toEqual({ value: "provider", key: "providers.opencode.compaction" });
    expect(compactionModeFor({ ...global, providers: { claude: { autoCompact: "claude" } } }, "claude")).toEqual({ value: "provider", key: "providers.claude.autoCompact" });
    // Unset everywhere: each provider's own default, as before.
    expect(["claude", "opencode", "harness"].map((kind) => compactionModeFor({}, kind as "claude").value)).toEqual(["ask", "provider", "auto"]);
  });

  it("is the Harness's automatic compaction when it says the provider's own", () => {
    expect(compactionModeFor({ longThreads: { compaction: "provider" } }, "harness").value).toBe("auto");
    expect(compactionModeFor({ longThreads: { compaction: "ask" } }, "harness").value).toBe("ask");
    expect(driverProviders({ longThreads: { compaction: "ask" } })?.harness?.compaction).toBe("ask");
  });
});

describe("a model's own choices", () => {
  it("hand off: the model's choice wins, other models follow the provider", () => {
    const config: Config = { longThreads: { handoff: "auto" }, providers: { claude: { handoffModels: { big: "off" } } } };
    expect(handoffModeFor(config, "claude", "big")).toEqual({ value: "off", key: "providers.claude.handoffModels" });
    expect(handoffModeFor(config, "claude", "small").value).toBe("auto");
    expect(longThreadPolicy(config, "claudeAgent", "big").handoff.mode).toBe("off");
    expect(planLongThreadAction({ ...config, longThreads: { handoff: "auto", handoffAt: "50%" } }, snapshot({ model: "big", usedTokens: 150_000 }))).toBeNull();
  });

  it("compaction: the model's choice wins, with its own line; Claude Code's sessions get it when they start", () => {
    const config: Config = { providers: { claude: { compaction: "ask", compactionModels: { big: "provider" }, compactAtModels: { big: 600_000 } } } };
    expect(compactionModeFor(config, "claude", "big")).toEqual({ value: "provider", key: "providers.claude.compactionModels" });
    expect(longThreadPolicy(config, "claudeAgent", "big").compact).toBeNull();
    expect(longThreadPolicy(config, "claudeAgent", "small").compact?.mode).toBe("ask");
    expect(driverProviders(config)?.claude).toMatchObject({ autoCompact: "ask", autoCompactModels: { big: "claude" }, autoCompactWindowModels: { big: 600_000 } });
  });

  it("OpenCode: a model chooses only while OpenCode's own compaction is off, and cannot turn it on", () => {
    const own: Config = { providers: { opencode: { compaction: "provider", compactionModels: { big: "auto" } } } };
    expect(compactionModeFor(own, "opencode", "big").value).toBe("provider");
    const moxen: Config = { providers: { opencode: { compaction: "ask", compactionModels: { big: "auto", small: "provider" } } } };
    expect(compactionModeFor(moxen, "opencode", "big").value).toBe("auto");
    expect(compactionModeFor(moxen, "opencode", "small").value).toBe("ask");
  });

  it("the Moxen Harness: a model's choice reaches its loop, and its own compaction is its automatic one", () => {
    const profile = { id: "local", baseUrl: "http://x/v1", models: [{ id: "big", contextWindow: 200_000 }, { id: "small", contextWindow: 200_000 }] } as HarnessProfileConfig;
    const tab = driverProviders({ providers: { harness: { compaction: "auto", compactionModels: { big: "ask", small: "off" } } } })?.harness;
    expect(resolveCompactionSettings(tab, profile, "big")).toMatchObject({ auto: true, ask: true });
    expect(resolveCompactionSettings(tab, profile, "small")).toMatchObject({ auto: false });
    expect(resolveCompactionSettings(tab, profile, "other")).toMatchObject({ auto: true, ask: false });
    expect(compactionModeFor({ providers: { harness: { compactionModels: { big: "provider" } } } }, "harness", "big").value).toBe("auto");
  });

  it("takes model=choice text through `config set`, and refuses a choice that is not one", () => {
    const descriptor = settingDescriptor("providers.claude.handoffModels")!;
    const config = normalizeConfig(writeSetting(normalizeConfig({}), descriptor.key, parseSettingValue(descriptor, "big=off, small=ask")));
    expect(config.providers?.claude?.handoffModels).toEqual({ big: "off", small: "ask" });
    expect(readSetting(config, descriptor.key)).toBe("big=off, small=ask");
    expect(() => normalizeConfig({ providers: { claude: { handoffModels: { big: "never" } } } })).toThrow(/ask, auto, off/);
  });
});

describe("the Moxen Harness on ask", () => {
  const config = (over: Record<string, unknown> = {}): Config =>
    normalizeConfig({ providers: { harness: { compaction: "ask", profiles: [{ id: "local", baseUrl: "http://localhost:1234/v1", models: [{ id: "m", contextWindow: 200_000 }], ...over }] } } });
  const harnessSnapshot = (over: Partial<LongThreadSnapshot> = {}) => snapshot({ instanceId: "harness/local", model: "m", maxTokens: 200_000, ...over });

  it("offers the card at its own line: the one its loop would compact at", () => {
    expect(longThreadPolicy(config(), "harness/local", "m").compact).toEqual({ mode: "ask", line: { tokens: 140_000 } });
    // A profile that switches compaction on or off itself is not asked about.
    expect(longThreadPolicy(config({ compaction: { auto: true } }), "harness/local", "m").compact).toBeNull();
    // An unknown profile, or a window nobody knows, places no line.
    expect(longThreadPolicy(config(), "harness/gone", "m").compact).toBeNull();
    expect(longThreadPolicy(normalizeConfig({ providers: { harness: { compaction: "ask", profiles: [{ id: "local", baseUrl: "http://x/v1", models: [{ id: "m" }] }] } } }), "harness/local", "m").compact).toBeNull();
  });

  it("leaves a thread past the line to the card, but compacts a delegated one and one past the hard line", () => {
    expect(planLongThreadAction(config(), harnessSnapshot({ usedTokens: 150_000 }))).toBeNull();
    expect(planLongThreadAction(config(), harnessSnapshot({ usedTokens: 150_000, delegated: true }))).toEqual({ kind: "compact", reason: "delegated" });
    expect(planLongThreadAction(config(), harnessSnapshot({ usedTokens: 175_000 }))).toEqual({ kind: "compact", reason: "hard-line" });
  });

  it("has the loop compact by itself only at the hard line", () => {
    const tab = driverProviders(config())?.harness;
    const settings = resolveCompactionSettings(tab, tab!.profiles![0]!, "m");
    expect(settings).toMatchObject({ auto: true, ask: true });
    expect(autoCompactThreshold(200_000, settings)).toBe(140_000);
    expect(loopCompactThreshold(200_000, settings)).toBe(170_000);
    expect(loopCompactThreshold(200_000, { ...settings, ask: false })).toBe(140_000);
  });
});

describe("Sign in with ChatGPT compaction", () => {
  afterEach(() => {
    resetChatGptContextWindowsForTests();
  });

  const synthProfile: HarnessProfileConfig = {
    id: "default",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "responses",
    models: [{ id: "gpt-6.2-sol", contextWindow: 872_000 }],
  };

  it("uses its own per-account compaction settings instead of inheriting providers.harness", () => {
    const config: Config = {
      providers: {
        harness: {
          compaction: "off",
          compactAt: "50%",
          slots: 4,
          profiles: [{ id: "local", baseUrl: "http://localhost:1234/v1", apiFormat: "chat", apiKeyEnv: "LOCAL_KEY", models: [{ id: "m" }] }],
        },
        chatgpt: {
          accounts: [
            { id: "default", compaction: "ask", compactAt: "60%", compactAtModels: { "gpt-6.2-astra": 150_000 } },
            { id: "trial", compaction: "off" },
          ],
        },
      },
    };
    const resolved = driverProviders(config);
    const defaultCfg = chatgptHarnessConfigFor(resolved, "chatgpt/default");
    const trialCfg = chatgptHarnessConfigFor(resolved, "chatgpt/trial");

    // Keeps shared non-compaction fields (profiles for secret-env stripping, slots) while isolating compaction.
    expect(defaultCfg.profiles?.[0]?.apiKeyEnv).toBe("LOCAL_KEY");
    expect(defaultCfg.slots).toBe(4);

    const solSettings = resolveCompactionSettings(defaultCfg, synthProfile, "gpt-6.2-sol");
    expect(solSettings).toMatchObject({ auto: true, ask: true, fraction: 0.6, tokens: null });
    expect(autoCompactThreshold(872_000, solSettings)).toBe(523_200);

    const astraSettings = resolveCompactionSettings(defaultCfg, synthProfile, "gpt-6.2-astra");
    expect(astraSettings).toMatchObject({ auto: true, ask: true, tokens: 150_000 });

    const trialSettings = resolveCompactionSettings(trialCfg, synthProfile, "gpt-6.2-sol");
    expect(trialSettings.auto).toBe(false);
    expect(longThreadPolicy(config, "chatgpt/trial", "gpt-6.2-sol").compact).toBeNull();
    expect(longThreadPolicy(config, "chatgpt/default", "gpt-6.2-sol").compact).toEqual({ mode: "ask", line: { tokens: 523_200 } });
    expect(longThreadPolicy(config, "chatgpt/default", "gpt-6.2-astra").compact).toEqual({ mode: "ask", line: { tokens: 150_000 } });
  });

  it("defaults ChatGPT auto-compaction to 80% of the model's max context window and lets lower settings override it", () => {
    // Unset: 80% of the model's largest window inside HarnessDriver; external policy stays null on auto.
    expect(compactLineFor({}, "chatgpt")).toEqual({ value: { percent: 80 }, key: null });
    expect(longThreadPolicy({}, "chatgpt/default", "gpt-6.2-sol").compact).toBeNull();
    expect(planLongThreadAction({}, snapshot({ instanceId: "chatgpt/default", model: "gpt-6.2-sol", usedTokens: 700_000, maxTokens: 872_000 }))).toBeNull();

    const defaultCfg = chatgptHarnessConfigFor(driverProviders({ providers: { chatgpt: { accounts: [{ id: "default" }] } } }), "chatgpt/default");
    const defaultSettings = resolveCompactionSettings(defaultCfg, synthProfile, "gpt-6.2-sol");
    expect(defaultSettings).toMatchObject({ auto: true, ask: false, fraction: 0.8, tokens: null });
    expect(autoCompactThreshold(872_000, defaultSettings)).toBe(697_600);

    // Discovered max window (e.g. 1.05M) flows into ask-mode thresholds at 80% when compactAt is unset.
    recordChatGptContextWindows("default", [{ id: "gpt-6.2-sol", contextWindow: 1_050_000 }]);
    const askUnset: Config = { providers: { chatgpt: { accounts: [{ id: "default", compaction: "ask" }] } } };
    expect(longThreadPolicy(askUnset, "chatgpt/default", "gpt-6.2-sol").compact).toEqual({ mode: "ask", line: { tokens: 840_000 } });

    // Global longThreads settings reach ChatGPT accounts that don't override them.
    const globalAsk: Config = {
      longThreads: { compaction: "ask", compactAt: "55%" },
      providers: { chatgpt: { accounts: [{ id: "default" }] } },
    };
    const cfg = chatgptHarnessConfigFor(driverProviders(globalAsk), "chatgpt/default");
    const settings = resolveCompactionSettings(cfg, synthProfile, "gpt-6.2-sol");
    expect(settings).toMatchObject({ auto: true, ask: true, fraction: 0.55 });
    expect(longThreadPolicy(globalAsk, "chatgpt/default", "gpt-6.2-sol").compact).toEqual({ mode: "ask", line: { tokens: 577_500 } });
    // Settings label shows the 80% default when unset.
    const view = describeSettings(normalizeConfig({})).find((entry) => entry.descriptor.key === "providers.chatgpt.compactAt")!;
    expect(view.effective?.label).toBe("80% of the window");
  });
});

describe("hand-off and compaction together", () => {
  const both = (handoffAt: string, compactAt: string, handoff: "ask" | "auto" = "auto"): Config => ({
    providers: { claude: { compaction: "auto", compactAt, handoff, handoffAt } },
  });

  it("compacts first when compaction's line is lower, even with hand-off on Automatic", () => {
    expect(planLongThreadAction(both("80%", "60%"), snapshot({ usedTokens: 170_000 }))).toEqual({ kind: "compact", reason: "auto" });
  });

  it("hands off first when hand-off's line is lower", () => {
    expect(planLongThreadAction(both("60%", "80%"), snapshot({ usedTokens: 170_000 }))).toEqual({ kind: "handoff" });
  });

  it("hands off when a compaction did not bring the thread back below its line", () => {
    expect(planLongThreadAction(both("80%", "60%"), snapshot({ usedTokens: 170_000, lastWasCompact: true }))).toEqual({ kind: "handoff" });
  });

  it("compares a share and a size in tokens", () => {
    // 64K is below 50% of a 200K window, so compaction goes first.
    expect(planLongThreadAction(both("50%", "64K"), snapshot({ usedTokens: 110_000 }))).toEqual({ kind: "compact", reason: "auto" });
  });

  it("compacts an OpenCode thread too once Moxen does it", () => {
    const config: Config = { providers: { opencode: { compaction: "auto" } } };
    expect(planLongThreadAction(config, snapshot({ instanceId: "opencode/anthropic", usedTokens: 161_000 }))).toEqual({ kind: "compact", reason: "auto" });
    expect(driverProviders(config)?.opencode?.autoCompact).toBe(false);
  });
});

describe("the settings page", () => {
  const view = (config: CliConfig, key: string) => describeSettings(config).find((entry) => entry.descriptor.key === key)!;

  it("shows the same rows on every provider tab, one of them for every per-model override, and hides the older keys", () => {
    for (const kind of ["claude", "opencode", "harness"] as const) {
      const rows = describeSettings(normalizeConfig({}))
        .filter((entry) => entry.descriptor.section === `provider:${kind}` && entry.descriptor.group === "Long threads" && entry.descriptor.hidden !== true)
        .map((entry) => entry.descriptor.label);
      expect(rows).toEqual(["Compaction", "Compact at", ...(kind === "harness" ? ["Kept word for word"] : []), "Hand off", "Hand off at", "Per model"]);
    }
  });

  it("names what applies, and where it comes from", () => {
    const config = normalizeConfig({ ui: { autoHandoffTokens: 65_536 }, providers: { claude: { autoCompact: "claude" } } });
    expect(view(config, "providers.claude.handoffAt").effective).toEqual({ value: "64K", label: "64K tokens", origin: "from ui.autoHandoffTokens in the config file" });
    expect(view(config, "providers.claude.compaction").effective).toMatchObject({ value: "provider", label: "Claude Code" });
    expect(view(config, "providers.claude.compactAt").effective?.label).toBe("Claude Code's own, tuned per model");
    expect(view(normalizeConfig({ longThreads: { handoffAt: "40%" } }), "providers.opencode.handoffAt").effective).toEqual({ value: "40%", label: "40% of the window", origin: "from 'Hand off at' on the Long threads tab" });
  });

  it("takes per-model compaction sizes as model=tokens text and keeps them as a map", () => {
    const descriptor = settingDescriptor("providers.opencode.compactAtModels")!;
    const config = normalizeConfig(writeSetting(normalizeConfig({}), descriptor.key, parseSettingValue(descriptor, "big-model=400k, small=64k")));
    expect(config.providers?.opencode?.compactAtModels).toEqual({ "big-model": 400_000, small: 64_000 });
    expect(readSetting(config, descriptor.key)).toBe("big-model=400000, small=64000");
  });

  it("takes an older key through `config set` and writes the one that replaced it too", () => {
    let config = normalizeConfig({});
    config = writeSetting(config, "providers.claude.autoCompactPercent", 70);
    expect(readSetting(config, "providers.claude.autoCompactPercent")).toBe(70);
    expect(readSetting(config, "providers.claude.compactAt")).toBe("70%");
    config = writeSetting(config, "providers.claude.autoCompact", "claude");
    expect(readSetting(config, "providers.claude.compaction")).toBe("provider");
    config = writeSetting(config, "ui.autoHandoffTokens", 131_072);
    expect(readSetting(config, "longThreads.handoffAt")).toBe("128K");
    // Clearing the older key clears the newer one it wrote, while that still says the same.
    config = writeSetting(config, "providers.claude.autoCompactPercent", "");
    expect(readSetting(config, "providers.claude.compactAt")).toBeUndefined();
  });

  it("refuses a line no window could use", () => {
    const descriptor = settingDescriptor("longThreads.compactAt")!;
    for (const bad of ["5%", "2K", "soon"]) expect(() => parseSettingValue(descriptor, bad)).toThrow(/share of the window/);
    expect(parseSettingValue(descriptor, "24k")).toBe("24K");
  });
});
