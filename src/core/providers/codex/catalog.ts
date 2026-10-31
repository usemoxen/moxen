/** Catalog metadata comes from the installed CLI, without creating a thread or reading credentials. */
import fs from "node:fs";
import path from "node:path";
import { expandHome } from "../../config.js";
import type { CodexProviderConfig } from "../../types.js";
import type { ProviderSummary } from "../../catalog/summary.js";
import { binaryOnPath } from "../../infra/process.js";
import type { CodexTransport } from "./transport.js";
import { CodexDriver } from "./driver.js";
import { asRecord, asString } from "./protocol.js";
import { codexAccountTypeOf } from "./config.js";

export async function codexProvider(settings: CodexProviderConfig | undefined, env: NodeJS.ProcessEnv, cwd: string, transport?: CodexTransport): Promise<ProviderSummary> {
  const binary = expandHome(settings?.binaryPath || "codex");
  const installed = path.isAbsolute(binary) ? (() => { try { return fs.statSync(binary).isFile(); } catch { return false; } })() : binaryOnPath(binary, env);
  const base: ProviderSummary = { instanceId: "codex", driver: "codex", displayName: "Codex", installed, enabled: false, status: installed ? null : "not installed", authStatus: null, models: [], supportedRuntimeModes: null, usageLimits: null, skills: [] };
  if (!installed) return base;
  const driver = new CodexDriver({ env, ...(transport ? { transport } : {}), ...(settings ? { settings } : {}) });
  try {
    return await driver.withPeer(cwd, async (peer) => {
      const account = asRecord(await peer.request("account/read", {}, 10_000));
      if (account?.account === null && account.requiresOpenaiAuth !== false) return { ...base, status: "Run codex login", authStatus: "unauthenticated" };
      const models: ProviderSummary["models"] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = asRecord(await peer.request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) }, 10_000));
        const data = page?.data ?? page?.models;
        for (const raw of Array.isArray(data) ? data : []) {
          const item = asRecord(raw);
          const id = asString(item?.model) ?? asString(item?.id);
          if (!id || item?.hidden === true) continue;
          const efforts = Array.isArray(item?.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
          const choices = efforts.flatMap((rawEffort) => {
            const effort = asString(asRecord(rawEffort)?.reasoningEffort);
            return effort ? [{ id: effort, label: effort, isDefault: effort === item?.defaultReasoningEffort }] : [];
          });
          models.push({ slug: id, name: asString(item?.displayName) ?? id, isCustom: false, isHidden: false, isDefault: item?.isDefault === true, efforts: choices.length ? [{ id: "effort", label: "Effort", choices, currentValue: null }] : [] });
        }
        cursor = asString(page?.nextCursor);
        if (cursor && seen.has(cursor)) throw new Error("Codex repeated a model-list cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return { ...base, enabled: true, authStatus: codexAccountTypeOf(account), models };
    });
  } catch {
    // Provider errors can contain credentials. Report no raw diagnostics here.
    return { ...base, status: "Could not query Codex; check codex login and the configured executable." };
  }
}
