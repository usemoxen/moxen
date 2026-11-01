import { describe, expect, it, vi } from "vitest";
import type { JsonRpcPeer } from "../../stdio.js";
import { imageGenerationAvailability } from "../imagegeneration.js";

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
