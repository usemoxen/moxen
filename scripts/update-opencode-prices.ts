#!/usr/bin/env bun
/**
 * Regenerate Moxen's shipped OpenCode Go (`opencode-go/<id>`) and OpenCode Zen
 * (`opencode/<id>`) token price table (`src/core/usage/opencode-prices.generated.json`)
 * from models.dev at build/maintenance time — never at runtime.
 *
 * Existing generated rows and the bundled `models-snapshot.json` are preserved
 * as a base so retired models still price historical Stats turns; live
 * models.dev data overwrites matching slugs with the newest upstream rates.
 * Hand-edited rows live separately in `src/core/usage/prices.ts` and win over
 * this file, so regenerating never overwrites manual edits.
 *
 * Usage:
 *   bun scripts/update-opencode-prices.ts [--from <models-dev.json>] [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelPrice, ModelPriceTier } from "../src/core/usage/prices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GENERATED_PRICES_PATH = path.join(ROOT, "src/core/usage/opencode-prices.generated.json");
export const SNAPSHOT_PATH = path.join(ROOT, "src/core/providers/opencode/models-snapshot.json");
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENCODE_PRICE_PROVIDERS = ["opencode-go", "opencode"] as const;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTierEntry(raw: unknown, fallbackThreshold?: number): ModelPriceTier | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const tierMeta = asRecord(rec["tier"]);
  const threshold =
    tierMeta?.["type"] === "context" && typeof tierMeta["size"] === "number" && Number.isFinite(tierMeta["size"]) && tierMeta["size"] > 0
      ? tierMeta["size"]
      : fallbackThreshold;
  if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) return null;
  const input = finiteNonNegative(rec["input"]);
  const output = finiteNonNegative(rec["output"]);
  const cacheRead = finiteNonNegative(rec["cache_read"] ?? rec["cacheRead"]);
  const cacheWrite = finiteNonNegative(rec["cache_write"] ?? rec["cacheWrite"]);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return null;
  }
  return {
    afterTokens: threshold,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function parseModelsDevCost(raw: unknown): ModelPrice | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const input = finiteNonNegative(rec["input"]);
  const output = finiteNonNegative(rec["output"]);
  const cacheRead = finiteNonNegative(rec["cache_read"] ?? rec["cacheRead"]);
  const cacheWrite = finiteNonNegative(rec["cache_write"] ?? rec["cacheWrite"]);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return null;
  }
  const byThreshold = new Map<number, ModelPriceTier>();
  if (Array.isArray(rec["tiers"])) {
    for (const entry of rec["tiers"]) {
      const parsed = parseTierEntry(entry);
      if (parsed) byThreshold.set(parsed.afterTokens, parsed);
    }
  } else if (rec["context_over_200k"] !== undefined) {
    const parsed = parseTierEntry(rec["context_over_200k"], 200_000);
    if (parsed) byThreshold.set(parsed.afterTokens, parsed);
  }
  const tiers = [...byThreshold.values()]
    .sort((a, b) => a.afterTokens - b.afterTokens)
    .filter(
      (tier) =>
        tier.input !== input ||
        tier.output !== output ||
        tier.cacheRead !== cacheRead ||
        tier.cacheWrite !== cacheWrite,
    );
  return {
    ...(input === undefined ? {} : { input }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(output === undefined ? {} : { output }),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

/** Extract sorted `<provider>/<model-id>` -> `ModelPrice` rows from a models.dev `api.json` payload. */
export function extractOpencodePrices(
  payload: unknown,
  providers: readonly string[] = OPENCODE_PRICE_PROVIDERS,
): Record<string, ModelPrice> {
  const root = asRecord(payload);
  if (!root) throw new Error("models.dev payload must be a JSON object.");
  const entries: Array<[string, ModelPrice]> = [];
  for (const providerId of providers) {
    const provider = asRecord(root[providerId]);
    const models = asRecord(provider?.["models"]);
    if (!models) continue;
    for (const [modelId, rawModel] of Object.entries(models)) {
      const model = asRecord(rawModel);
      if (!model) continue;
      const price = parseModelsDevCost(model["cost"]);
      if (price) entries.push([`${providerId}/${modelId}`, price]);
    }
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

/** Merge layers in ascending precedence (existing -> snapshot -> live) with deterministic key order. */
export function mergeOpencodePrices(
  ...layers: ReadonlyArray<Readonly<Record<string, ModelPrice>>>
): Record<string, ModelPrice> {
  const merged = new Map<string, ModelPrice>();
  for (const layer of layers) {
    for (const [slug, price] of Object.entries(layer)) {
      merged.set(slug, price);
    }
  }
  return Object.fromEntries([...merged.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function readJsonIfPresent(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let fromPath: string | null = null;
  let checkOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--check") checkOnly = true;
    else if (args[i] === "--from" && args[i + 1]) {
      fromPath = args[i + 1]!;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  const existingRaw = await readJsonIfPresent(GENERATED_PRICES_PATH);
  const existing = (asRecord(existingRaw) ?? {}) as Record<string, ModelPrice>;

  const snapshotRaw = await readJsonIfPresent(SNAPSHOT_PATH);
  const snapshotPrices = snapshotRaw ? extractOpencodePrices(snapshotRaw) : {};

  let liveRaw: unknown;
  if (fromPath !== null) {
    liveRaw = JSON.parse(await readFile(fromPath, "utf8")) as unknown;
  } else {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "user-agent": "moxen-price-updater" },
    });
    if (!response.ok) throw new Error(`Failed to fetch ${MODELS_DEV_URL}: HTTP ${response.status}`);
    liveRaw = (await response.json()) as unknown;
  }
  const livePrices = extractOpencodePrices(liveRaw);
  const goCount = Object.keys(livePrices).filter((k) => k.startsWith("opencode-go/")).length;
  if (goCount === 0) {
    throw new Error("Upstream models.dev payload contained zero opencode-go prices; refusing to overwrite.");
  }

  const next = mergeOpencodePrices(existing, snapshotPrices, livePrices);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;

  if (checkOnly) {
    const current = await readFile(GENERATED_PRICES_PATH, "utf8").catch(() => "");
    if (current !== serialized) {
      console.error("src/core/usage/opencode-prices.generated.json is out of date. Run `bun run update:opencode-prices`.");
      process.exit(1);
    }
    console.log(`opencode-prices.generated.json is up to date (${Object.keys(next).length} models).`);
    return;
  }

  await writeFile(GENERATED_PRICES_PATH, serialized, "utf8");
  const total = Object.keys(next).length;
  const totalGo = Object.keys(next).filter((k) => k.startsWith("opencode-go/")).length;
  const totalZen = Object.keys(next).filter((k) => k.startsWith("opencode/")).length;
  console.log(`Wrote ${total} OpenCode price rows (${totalGo} opencode-go, ${totalZen} opencode) to ${path.relative(ROOT, GENERATED_PRICES_PATH)}`);
}

if (import.meta.main) {
  await main();
}
