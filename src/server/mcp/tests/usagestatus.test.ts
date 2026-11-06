/**
 * `usage_status` (MXN-299): an agent sees the user's current shared provider
 * usage — every set-up provider's windows with when each reading was taken
 * and whether it is stale — instead of routing by the hours-old figures the
 * `models` tool carries.
 */
import { describe, expect, it } from "vitest";

import type { ProviderSummary, ProviderUsageLimits } from "../../../core/catalog/summary.js";
import type { ClientApi } from "../../api.js";
import { callMoxenTool, moxenToolsFor, MOXEN_TOOLS } from "../tools.js";

const HOUR_MS = 3_600_000;

function provider(instanceId: string, overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    instanceId,
    driver: instanceId,
    displayName: instanceId.toUpperCase(),
    enabled: true,
    installed: true,
    status: "ready",
    authStatus: "authenticated",
    models: [],
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
    ...overrides,
  };
}

function limits(checkedAt: string, usedPercent: number, resetsAt: string | null = null): ProviderUsageLimits {
  return {
    checkedAt,
    windows: [{ id: "session", kind: "session", label: "Session", usedPercent, resetsAt }],
    unavailable: null,
  };
}

interface World {
  readonly providers: ProviderSummary[];
  /** Stored snapshot, keyed by usage account. */
  readonly stored: Record<string, ProviderUsageLimits>;
  readonly protection: { forecasts: unknown[]; queue: unknown[] };
  readonly callerProvider: string;
  /** What the refresh round answers; "hang" never answers. */
  readonly refresh: Record<string, ProviderUsageLimits> | "hang" | "fail";
}

function apiOf(world: World): ClientApi {
  return {
    query: async (query: { type: string }) => {
      switch (query.type) {
        case "providers.list":
          return { providers: world.providers };
        case "usage.limits":
          return { providers: world.stored };
        case "usage.protection":
          return world.protection;
        case "usage.refresh":
          if (world.refresh === "hang") return await new Promise<never>(() => undefined);
          if (world.refresh === "fail") throw new Error("probe refused");
          return { providers: world.refresh };
        case "thread.inspect":
          return {
            project: null,
            thread: { modelSelection: { instanceId: world.callerProvider, model: "m" } },
          };
        default:
          throw new Error(`unexpected query ${query.type}`);
      }
    },
  } as unknown as ClientApi;
}

const ask = (world: World, options: Parameters<typeof callMoxenTool>[4] = {}) =>
  callMoxenTool(apiOf(world), "caller", "usage_status", {}, { usageRefreshMs: 20, ...options });

interface Answer {
  readonly callerProvider: string | null;
  readonly providers: Array<{
    readonly provider: string;
    readonly displayName?: string | null;
    readonly enabled?: boolean;
    readonly checkedAt: string | null;
    readonly stale: boolean;
    readonly windows: Array<{ id: string; kind: string; label: string; usedPercent: number; resetsAt: string | null }>;
    readonly note?: string;
  }>;
  readonly protection: { forecasts: unknown[]; queue: unknown[] };
}

describe("usage_status", () => {
  it("flags a hours-old reading as stale, with its windows, reset and age", async () => {
    const checkedAt = new Date(Date.now() - 3 * HOUR_MS).toISOString();
    const world: World = {
      providers: [provider("codex")],
      stored: { codex: limits(checkedAt, 94, new Date(Date.now() + HOUR_MS).toISOString()) },
      protection: { forecasts: [], queue: [] },
      callerProvider: "codex",
      refresh: "hang",
    };
    const result = await ask(world);
    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.text) as Answer;
    expect(answer.callerProvider).toBe("codex");
    expect(answer.providers).toHaveLength(1);
    expect(answer.providers[0]).toMatchObject({
      provider: "codex",
      checkedAt,
      stale: true,
      windows: [{ label: "Session", usedPercent: 94 }],
    });
    expect(typeof answer.providers[0]!.windows[0]!.resetsAt).toBe("string");
  });

  it("says no data for a provider that reports none, which is not unlimited", async () => {
    const world: World = {
      providers: [provider("harness")],
      stored: {},
      protection: { forecasts: [], queue: [] },
      callerProvider: "harness",
      refresh: {},
    };
    const result = await ask(world);
    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.text) as Answer;
    expect(answer.providers).toEqual([
      {
        provider: "harness",
        displayName: "HARNESS",
        enabled: true,
        checkedAt: null,
        stale: false,
        windows: [],
        note: expect.stringMatching(/no data/i),
      },
    ]);
    expect(result.text).toMatch(/do not treat it as headroom/i);
  });

  it("reads a fresh refresh rather than the stored reading", async () => {
    const storedAt = new Date(Date.now() - 3 * HOUR_MS).toISOString();
    const freshAt = new Date().toISOString();
    const world: World = {
      providers: [provider("codex")],
      stored: { codex: limits(storedAt, 50) },
      protection: { forecasts: [], queue: [] },
      callerProvider: "codex",
      refresh: { codex: limits(freshAt, 94) },
    };
    const answer = JSON.parse((await ask(world)).text) as Answer;
    expect(answer.providers[0]).toMatchObject({ checkedAt: freshAt, stale: false, windows: [{ usedPercent: 94 }] });
  });

  it("falls back to the stored reading, with its age, when a refresh fails", async () => {
    const checkedAt = new Date(Date.now() - 3 * HOUR_MS).toISOString();
    const world: World = {
      providers: [provider("codex")],
      stored: { codex: limits(checkedAt, 50) },
      protection: { forecasts: [], queue: [] },
      callerProvider: "codex",
      refresh: "fail",
    };
    const answer = JSON.parse((await ask(world)).text) as Answer;
    expect(answer.providers[0]).toMatchObject({ checkedAt, stale: true, windows: [{ usedPercent: 50 }] });
  });

  it("passes through what usage protection holds or has queued", async () => {
    const queue = [{ threadId: "t1", title: "Big job", phase: "waiting", provider: "codex", windows: [], order: 1, handoff: false }];
    const world: World = {
      providers: [provider("codex")],
      stored: {},
      protection: { forecasts: [{ provider: "codex" }], queue },
      callerProvider: "codex",
      refresh: {},
    };
    const answer = JSON.parse((await ask(world)).text) as Answer;
    expect(answer.protection.queue).toEqual(queue);
    expect(answer.protection.forecasts).toHaveLength(1);
  });

  it("is offered to a delegated task as well as an ordinary thread", async () => {
    expect(MOXEN_TOOLS.map((tool) => tool.name)).toContain("usage_status");
    expect(moxenToolsFor({}).map((tool) => tool.name)).toContain("usage_status");
    expect(moxenToolsFor({ delegated: true, memory: "read" }).map((tool) => tool.name)).toContain("usage_status");
    const world: World = {
      providers: [provider("codex")],
      stored: {},
      protection: { forecasts: [], queue: [] },
      callerProvider: "codex",
      refresh: {},
    };
    const result = await callMoxenTool(apiOf(world), "caller", "usage_status", {}, { delegated: true, usageRefreshMs: 20 });
    expect(result.isError).toBe(false);
  });
});
