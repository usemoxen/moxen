/** Read paginated Codex history through its public protocol, never its private database. */
import type { JsonRpcPeer } from "../stdio.js";
import type { SubagentHistoryItem } from "../spi.js";
import { asRecord, asString } from "./protocol.js";
import { CliError } from "../../errors.js";

/** Some released runtimes advertise paginated methods before implementing them. */
export function codexMethodUnavailable(error: unknown): boolean {
  return error instanceof CliError && (asRecord(error.details)?.["code"] === -32601 || /not supported yet|method not found|unknown method/i.test(error.message));
}

async function legacyTurns(peer: JsonRpcPeer, threadId: string): Promise<Record<string, unknown>[]> {
  const result = asRecord(await peer.request("thread/read", { threadId, includeTurns: true }));
  const thread = asRecord(result?.["thread"]) ?? result;
  return (Array.isArray(thread?.["turns"]) ? thread["turns"] : []).map(asRecord).filter((turn): turn is Record<string, unknown> => turn !== null);
}

/** Newest first; legacy hydrated history is oldest first. */
export async function readCodexTurns(peer: JsonRpcPeer, threadId: string, limit: number): Promise<Record<string, unknown>[]> {
  const turns: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    let page: Record<string, unknown> | null;
    try { page = asRecord(await peer.request("thread/turns/list", { threadId, sortDirection: "desc", limit: Math.min(limit - turns.length, 100), ...(cursor ? { cursor } : {}) })); }
    catch (cause) { if (!codexMethodUnavailable(cause)) throw cause; return (await legacyTurns(peer, threadId)).reverse().slice(0, limit); }
    for (const raw of Array.isArray(page?.["data"]) ? page["data"] : []) { const turn = asRecord(raw); if (turn && asString(turn["id"])) turns.push(turn); }
    cursor = asString(page?.["nextCursor"]);
    if (cursor && seen.has(cursor)) throw new Error("Codex repeated a turn-history cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor && turns.length < limit);
  return turns.slice(0, limit);
}

export async function readCodexHistory(peer: JsonRpcPeer, threadId: string): Promise<SubagentHistoryItem[]> {
  const history: SubagentHistoryItem[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    let page: Record<string, unknown> | null;
    try { page = asRecord(await peer.request("thread/items/list", { threadId, sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) })); }
    catch (cause) {
      if (!codexMethodUnavailable(cause)) throw cause;
      const turns = await legacyTurns(peer, threadId);
      page = { data: turns.flatMap((turn) => (Array.isArray(turn["items"]) ? turn["items"] : []).map((item) => ({ item }))), nextCursor: null };
    }
    for (const raw of Array.isArray(page?.data) ? page.data : []) {
      const entry = asRecord(raw);
      const item = asRecord(entry?.item);
      const id = asString(item?.id);
      if (!item || !id) continue;
      const millis = entry?.startedAtMs;
      const at = typeof millis === "number" && Number.isFinite(millis) ? new Date(millis).toISOString() : null;
      if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        history.push({ kind: "prompt", id, at, text: content.map((part) => asString(asRecord(part)?.text) ?? "").join("\n") });
      } else if (item.type === "agentMessage") {
        history.push({ kind: "text", id, at, text: asString(item.text) ?? "" });
      } else if (item.type === "reasoning") {
        history.push({ kind: "reasoning", id, at, text: Array.isArray(item.summary) ? item.summary.join("\n") : "" });
      } else {
        history.push({ kind: "tool", id, at, tool: asString(item.tool) ?? asString(item.type) ?? "tool", raw: { item } });
      }
    }
    cursor = asString(page?.nextCursor);
    if (cursor && seen.has(cursor)) throw new Error("Codex repeated a history cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return history;
}
