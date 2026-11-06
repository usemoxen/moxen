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

async function targetExists(api: Pick<ClientApi, "query">, address: MemoryAddress, key: MemoryKey): Promise<boolean> {
  try {
    await api.query({ type: "memory.read", name: key.name, scope: key.scope, ...(address.threadId === undefined ? {} : { threadId: address.threadId }) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Save the form's content for `from`. An unchanged name is one `memory.save`;
 * a rename is a save under the new name plus a delete of the old one — in
 * that order, so a failed delete leaves the saved copy behind rather than
 * losing the memory. A new name that already exists needs `replaceConfirmed`,
 * and reports back instead of overwriting.
 */
export async function renameMemory(
  api: Pick<ClientApi, "query" | "dispatch">,
  address: MemoryAddress,
  from: MemoryKey,
  input: MemoryBody,
  options: { replaceConfirmed: boolean },
): Promise<{ saved: true } | { needsReplaceConfirm: true }> {
  const renamed = input.name !== from.name || input.scope !== from.scope;
  if (renamed && !options.replaceConfirmed && (await targetExists(api, address, { name: input.name, scope: input.scope }))) {
    return { needsReplaceConfirm: true };
  }
  const via = address.threadId === undefined ? {} : { threadId: address.threadId };
  await api.dispatch({ type: "memory.save", name: input.name, description: input.description, memoryType: input.type, body: input.body, scope: input.scope, ...via });
  if (renamed) {
    await api.dispatch({ type: "memory.delete", name: from.name, scope: from.scope, ...via });
  }
  return { saved: true };
}
