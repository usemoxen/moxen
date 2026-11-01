import type { JsonRpcPeer } from "../stdio.js";
import { asRecord, asString, CODEX_METHODS } from "./protocol.js";
import { codexImageUsageAllowed } from "./usage.js";

export interface ImageGenerationAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

/** Read through Codex itself: never inspect its credentials or infer a reset. */
export async function imageGenerationAvailability(peer: JsonRpcPeer): Promise<ImageGenerationAvailability> {
  const account = asRecord(asRecord(await peer.request(CODEX_METHODS.accountRead, {}, 10_000))?.account);
  const plan = asString(account?.planType)?.toLowerCase();
  if (account?.type !== "chatgpt" || !plan || !["plus", "pro", "team", "business", "enterprise", "edu"].includes(plan)) {
    return { available: false, reason: "Image generation requires Codex signed in with a supported paid ChatGPT subscription." };
  }
  const limits = asRecord(await peer.request(CODEX_METHODS.rateLimitsRead, {}, 10_000));
  const buckets = asRecord(limits?.rateLimitsByLimitId);
  const snapshot = asRecord(buckets?.codex) ?? asRecord(limits?.rateLimits);
  const allowed = snapshot !== null && codexImageUsageAllowed({
    limitId: asString(snapshot.limitId) ?? undefined,
    primary: snapshot.primary,
    secondary: snapshot.secondary,
  });
  return { available: allowed, reason: allowed ? null : "Image generation requires fresh Codex limits with at least 3% remaining in the five-hour window and 1% in the weekly window." };
}
