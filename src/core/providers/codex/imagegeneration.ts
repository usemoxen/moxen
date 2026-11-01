import type { JsonRpcPeer } from "../stdio.js";
import { asRecord, asString, CODEX_METHODS } from "./protocol.js";
import { codexImageUsageAllowed } from "./usage.js";
import type { ModelSummary } from "../../catalog/summary.js";

export interface ImageGenerationModel {
  readonly model: string;
  readonly thinkingEffort: string;
}

/** Resolve released Luna versions numerically; a rolling alias wins over its dated snapshots. */
export function imageGenerationModel(models: readonly ModelSummary[]): ImageGenerationModel | null {
  const candidates = models.flatMap((model) => {
    const match = /^gpt-(\d+(?:\.\d+)*)-luna(?:-(\d{4}-\d{2}-\d{2}))?$/.exec(model.slug);
    return model.isHidden || !match || Number.parseInt(match[1]!, 10) < 6 ? [] : [{ model, version: match[1]!.split(".").map(Number), snapshot: match[2] ?? "" }];
  });
  candidates.sort((left, right) => {
    for (let index = 0; index < Math.max(left.version.length, right.version.length); index++) {
      const delta = (right.version[index] ?? 0) - (left.version[index] ?? 0);
      if (delta !== 0) return delta;
    }
    if (left.snapshot === "" || right.snapshot === "") return Number(right.snapshot === "") - Number(left.snapshot === "");
    return right.snapshot.localeCompare(left.snapshot);
  });
  const latest = candidates[0]?.model;
  if (!latest) return null;
  const supported = new Set(latest.efforts.filter((descriptor) => descriptor.id === "effort").flatMap((descriptor) => descriptor.choices.map((choice) => choice.id)));
  const thinkingEffort = ["minimal", "low", "medium", "high", "xhigh", "max"].find((effort) => supported.has(effort));
  return thinkingEffort ? { model: latest.slug, thinkingEffort } : null;
}

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
