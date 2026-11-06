import type { ClientApi, QueryResult } from "../../../server/api.js";

export type StoredMemory = QueryResult<"memory.read">;
export type MemoryScope = StoredMemory["scope"];
export type MemoryType = StoredMemory["type"];

/** Where a memory request points: the open thread's project, or neither (global alone). */
export interface MemoryAddress {
  readonly threadId?: string;
}

/** The editable content of one memory: what the form saves. */
export interface MemoryBody {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly body: string;
  readonly scope: MemoryScope;
}

export interface MemoryKey {
  readonly name: string;
  readonly scope: MemoryScope;
}

/** True when what the server holds no longer matches what was opened: another agent may have saved over it. */
export function memoryChanged(opened: Pick<StoredMemory, "description" | "type" | "body">, fresh: Pick<StoredMemory, "description" | "type" | "body">): boolean {
  return opened.description !== fresh.description || opened.type !== fresh.type || opened.body !== fresh.body;
}

/** A `CliError` code, over any transport; null when the failure carries none. */
export function errorCodeOf(cause: unknown): string | null {
  return typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : null;
}

/** One memory, or null when the scope holds no such name. Any other failure propagates: never mistaken for absent. */
async function readTargetOrNull(
  api: Pick<ClientApi, "query">,
  address: MemoryAddress,
  key: MemoryKey,
): Promise<StoredMemory | null> {
  try {
    return await api.query({ type: "memory.read", name: key.name, scope: key.scope, ...(address.threadId === undefined ? {} : { threadId: address.threadId }) });
  } catch (cause) {
    if (errorCodeOf(cause) === "MEMORY_NOT_FOUND") return null;
    throw cause;
  }
}

/**
 * What a save may overwrite. `from` is the memory the form edits, null for a
 * new one; `input` is what it saves. A target that already exists needs
 * `replaceConfirmed`, and reports back with what it holds instead of
 * overwriting. Reads that fail for any reason but absence propagate, so a
 * transient failure never skips consent.
 */
export async function checkRenameTarget(
  api: Pick<ClientApi, "query">,
  address: MemoryAddress,
  from: MemoryKey | null,
  input: MemoryBody,
  options: { replaceConfirmed: boolean },
): Promise<
  | { readonly ok: true; readonly existing: StoredMemory | null }
  | { readonly needsReplaceConfirm: true; readonly existing: StoredMemory }
> {
  const key = { name: input.name, scope: input.scope };
  const renamed = from === null || input.name !== from.name || input.scope !== from.scope;
  // An unchanged name is governed by the source re-read, not by this check.
  if (!renamed) return { ok: true, existing: null };
  const existing = await readTargetOrNull(api, address, key);
  if (existing !== null && !options.replaceConfirmed) return { needsReplaceConfirm: true, existing };
  return { ok: true, existing };
}

/**
 * The last-instant verdict before a save, against what the check saw.
 * `basis` is the target as last seen (null when it was absent); `now` is
 * what a fresh read holds. A target that appeared or changed since routes
 * away from the save: consent for a name never agreed to, the conflict
 * screen for a victim that moved under an agreement.
 */
export function verifyTargetSave(options: {
  readonly isCreate: boolean;
  readonly replaceEffective: boolean;
  readonly basis: StoredMemory | null;
  readonly now: StoredMemory | null;
}): "save" | "replaceConfirm" | "conflict" {
  const { isCreate, replaceEffective, basis, now } = options;
  if (now === null) return "save";
  if (!replaceEffective) return isCreate ? "replaceConfirm" : "conflict";
  return basis !== null && memoryChanged(basis, now) ? "conflict" : "save";
}

/**
 * Write the form's content: a save under the new name, then — for a rename —
 * a delete of the old one, in that order, so a failed delete leaves the
 * saved copy behind rather than losing the memory. No checks: the caller
 * runs `checkRenameTarget` and the pre-save re-reads first.
 */
export async function commitRename(
  api: Pick<ClientApi, "dispatch">,
  address: MemoryAddress,
  from: MemoryKey | null,
  input: MemoryBody,
): Promise<{ readonly saved: true }> {
  const via = address.threadId === undefined ? {} : { threadId: address.threadId };
  await api.dispatch({ type: "memory.save", name: input.name, description: input.description, memoryType: input.type, body: input.body, scope: input.scope, ...via });
  if (from !== null && (input.name !== from.name || input.scope !== from.scope)) {
    await api.dispatch({ type: "memory.delete", name: from.name, scope: from.scope, ...via });
  }
  return { saved: true };
}
