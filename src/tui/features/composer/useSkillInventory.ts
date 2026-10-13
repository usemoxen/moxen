import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillInventory } from "../../../core/catalog/summary.js";
import type { ClientApi } from "../../../server/api.js";

/**
 * The composer's skill picker source: the skills the open thread's provider
 * resolves in that thread's directory (`skills.list`), fetched once per
 * provider + directory and kept — a provider takes about a second to answer,
 * so switching threads back and forth must not re-ask.
 *
 * A kept answer goes stale: a skill added or removed while the app runs would
 * never show. So the picker asks `refresh` when it opens, and an answer older
 * than `STALE_MS` is asked for again, with the old list staying on screen until
 * the new one lands.
 *
 * Undefined until the first answer arrives, and when there is nothing to
 * ask about (no provider or no directory yet); a failed lookup reads as an
 * empty inventory rather than an error, since the picker is a convenience.
 */
interface Entry {
  readonly at: number;
  readonly pending: Promise<SkillInventory | null>;
}
const cache = new Map<string, Entry>();

/** How long an answer is trusted before opening the picker asks again. */
export const STALE_MS = 15_000;

/** Whether a kept answer is old enough to ask again. */
export function isStale(at: number, now: number): boolean {
  return now - at >= STALE_MS;
}

function load(client: ClientApi, instanceId: string, cwd: string, key: string): Entry {
  const asked = client.query({ type: "skills.list", instanceId, cwd }).catch(() => null);
  const entry: Entry = { at: Date.now(), pending: asked };
  cache.set(key, entry);
  // A failed lookup (a server still starting, a request that timed out) is not an answer:
  // forgetting it lets the next look ask again, instead of leaving the picker empty until restart.
  void asked.then((result) => {
    if (result === null && cache.get(key) === entry) cache.delete(key);
  });
  return entry;
}

export function useSkillInventory(
  client: ClientApi,
  instanceId: string | null | undefined,
  cwd: string | null | undefined,
): { inventory: SkillInventory | undefined; refresh: () => void } {
  const [inventory, setInventory] = useState<SkillInventory | undefined>(undefined);
  const current = useRef<string | null>(null);
  useEffect(() => {
    setInventory(undefined);
    if (!instanceId || !cwd) {
      current.current = null;
      return;
    }
    const key = `${instanceId}\u0000${cwd}`;
    current.current = key;
    const entry = cache.get(key) ?? load(client, instanceId, cwd, key);
    let live = true;
    void entry.pending.then((result) => {
      if (live) setInventory(result ?? { trigger: "/", skills: [], commands: [] });
    });
    return () => {
      live = false;
    };
  }, [client, instanceId, cwd]);

  /** Ask again if the kept answer is stale; what is shown now stays until the new answer replaces it. */
  const refresh = useCallback(() => {
    if (!instanceId || !cwd) return;
    const key = `${instanceId}\u0000${cwd}`;
    const kept = cache.get(key);
    if (kept !== undefined && !isStale(kept.at, Date.now())) return;
    void load(client, instanceId, cwd, key).pending.then((result) => {
      // A failed ask keeps the list already shown; so does a thread switch that happened meanwhile.
      if (result !== null && current.current === key) setInventory(result);
    });
  }, [client, instanceId, cwd]);

  return { inventory, refresh };
}
