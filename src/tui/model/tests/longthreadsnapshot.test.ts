import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../../core/config.js";
import { describeSettings } from "../../../core/configschema.js";
import { autoHandoffState, lineInput, longThreadPolicy } from "../../../core/threads/longthreads.js";
import { longThreadConfigFromSnapshot } from "../../features/settings/useSettings.js";

describe("the long-thread config the TUI rebuilds from settings", () => {
  it("does not offer Codex handoff at 50% after its tab sets 80%", () => {
    const config = normalizeConfig({ providers: { codex: { handoff: "ask", handoffAt: "80%" } } });
    const rebuilt = longThreadConfigFromSnapshot({ path: "config.json", exists: true, settings: describeSettings(config) })!;
    const policy = longThreadPolicy(rebuilt, "codex", "gpt-test");
    expect(policy).toEqual(longThreadPolicy(config, "codex", "gpt-test"));
    const input = { mode: policy.handoff.mode, ...lineInput(policy.handoff.line), maxTokens: 100_000, hasReply: true, turnRunning: false, runningSubthreads: 0, runningBackgroundTasks: 0, queuedMessages: 0 };
    expect(autoHandoffState({ ...input, usedTokens: 50_000 })).toBeNull();
    expect(autoHandoffState({ ...input, usedTokens: 80_000 })).not.toBeNull();
  });

  it.each(["claude", "codex", "opencode", "harness"] as const)("keeps %s per-model handoff and compaction choices consistent with the server", (kind) => {
    const config = normalizeConfig({ providers: { [kind]: { handoff: "ask", handoffAt: "80%", handoffModels: { special: "off" }, compaction: "off", compactionModels: { special: "ask" }, compactAt: "90%" } } });
    const rebuilt = longThreadConfigFromSnapshot({ path: "config.json", exists: true, settings: describeSettings(config) })!;
    const instance = kind === "harness" ? "harness/local" : kind;
    for (const model of ["ordinary", "special"]) {
      expect(longThreadPolicy(rebuilt, instance, model)).toEqual(longThreadPolicy(config, instance, model));
    }
  });

  const config = normalizeConfig({
    longThreads: { compaction: "ask" },
    providers: { harness: { profiles: [{ id: "local", baseUrl: "http://localhost:1234/v1", models: [{ id: "m", contextWindow: 200_000 }] }] } },
  });
  const snapshot = { path: "/tmp/config.json", exists: true, settings: describeSettings(config) };

  it("carries the global Compaction, and the Harness profiles it is given, so a Harness card sits where the server's does", () => {
    const rebuilt = longThreadConfigFromSnapshot(snapshot, config.providers?.harness?.profiles);
    expect(rebuilt?.longThreads?.compaction).toBe("ask");
    expect(longThreadPolicy(rebuilt!, "harness/local", "m").compact).toEqual(longThreadPolicy(config, "harness/local", "m").compact);
    expect(longThreadPolicy(rebuilt!, "harness/local", "m").compact).toEqual({ mode: "ask", line: { tokens: 140_000 } });
  });
});
