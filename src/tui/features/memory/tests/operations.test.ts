import { describe, expect, it } from "vitest";

import type { ClientApi, QueryResult } from "../../../../server/api.js";
import { memoryChanged, renameMemory, type MemoryAddress, type MemoryBody } from "../operations.js";

type Memory = QueryResult<"memory.read">;

function entry(overrides: Partial<Memory> = {}): Memory {
  return {
    name: "deploy-notes",
    description: "How deploys go out",
    type: "project",
    body: "Ship on Fridays.",
    scope: "project",
    ...overrides,
  };
}

/** An in-memory `ClientApi` for the memory reads and writes the manager makes. */
function fakeApi(seeds: readonly Memory[] = [], failures: { delete?: boolean } = {}): { api: ClientApi; store: Map<string, Memory>; calls: string[] } {
  const store = new Map(seeds.map((memory) => [`${memory.scope}:${memory.name}`, memory]));
  const calls: string[] = [];
  const api = {
    query: (async (query: { type: string; name?: string; scope?: string }) => {
      if (query.type === "memory.read") {
        const found = store.get(`${query.scope}:${query.name}`);
        if (!found) {
          const error = new Error(`No memory named ${query.name}.`) as Error & { code: string };
          error.code = "MEMORY_NOT_FOUND";
          throw error;
        }
        return found;
      }
      throw new Error(`unexpected query ${query.type}`);
    }) as ClientApi["query"],
    dispatch: (async (command: { type: string; name: string; scope: "project" | "global"; description?: string; memoryType?: Memory["type"]; body?: string }) => {
      calls.push(command.type);
      if (command.type === "memory.save") {
        store.set(`${command.scope}:${command.name}`, entry({ name: command.name, scope: command.scope, description: command.description ?? "", type: command.memoryType ?? "project", body: command.body ?? "" }));
        return { name: command.name, scope: command.scope, replaced: false, total: store.size };
      }
      if (command.type === "memory.delete") {
        if (failures.delete) {
          const error = new Error("boom") as Error & { code: string };
          error.code = "DELETE_FAILED";
          throw error;
        }
        store.delete(`${command.scope}:${command.name}`);
        return { name: command.name, scope: command.scope, total: store.size, before: { description: "", type: "reference" as const, body: "" } };
      }
      throw new Error(`unexpected command ${command.type}`);
    }) as ClientApi["dispatch"],
  } as ClientApi;
  return { api, store, calls };
}

const address: MemoryAddress = { threadId: "thread-1" };

function body(overrides: Partial<MemoryBody> = {}): MemoryBody {
  return { name: "deploy-notes", description: "How deploys go out", type: "project", body: "Ship on Fridays.", scope: "project", ...overrides };
}

describe("memoryChanged", () => {
  it("is false for the same description, type and body", () => {
    expect(memoryChanged(entry(), entry())).toBe(false);
  });

  it.each([
    ["a changed body", entry({ body: "Ship on Thursdays." })],
    ["a changed description", entry({ description: "New hook" })],
    ["a changed type", entry({ type: "reference" })],
  ])("is true for %s", (_label, fresh) => {
    expect(memoryChanged(entry(), fresh)).toBe(true);
  });
});

describe("renameMemory", () => {
  it("saves under the same name without a delete when nothing was renamed", async () => {
    const { api, store, calls } = fakeApi([entry()]);
    const result = await renameMemory(api, address, { name: "deploy-notes", scope: "project" }, body({ body: "Ship on Thursdays." }), { replaceConfirmed: false });
    expect(result).toEqual({ saved: true });
    expect(calls).toEqual(["memory.save"]);
    expect(store.get("project:deploy-notes")?.body).toBe("Ship on Thursdays.");
  });

  it("asks to replace rather than overwriting when the new name already exists", async () => {
    const { api, calls } = fakeApi([entry(), entry({ name: "other-notes", description: "Other", body: "Other body." })]);
    const result = await renameMemory(api, address, { name: "deploy-notes", scope: "project" }, body({ name: "other-notes" }), { replaceConfirmed: false });
    expect(result).toEqual({ needsReplaceConfirm: true });
    expect(calls).toEqual([]);
  });

  it("saves plus deletes on a confirmed replace", async () => {
    const { api, store, calls } = fakeApi([entry(), entry({ name: "other-notes", description: "Other", body: "Other body." })]);
    const result = await renameMemory(api, address, { name: "deploy-notes", scope: "project" }, body({ name: "other-notes", body: "Merged body." }), { replaceConfirmed: true });
    expect(result).toEqual({ saved: true });
    expect(calls).toEqual(["memory.save", "memory.delete"]);
    expect(store.get("project:other-notes")?.body).toBe("Merged body.");
    expect(store.has("project:deploy-notes")).toBe(false);
  });

  it("does not lose the memory when the renamed save lands but the delete fails", async () => {
    const { api, store } = fakeApi([entry()], { delete: true });
    await expect(
      renameMemory(api, address, { name: "deploy-notes", scope: "project" }, body({ name: "renamed-notes" }), { replaceConfirmed: false }),
    ).rejects.toMatchObject({ code: "DELETE_FAILED" });
    expect(store.get("project:renamed-notes")?.body).toBe("Ship on Fridays.");
    expect(store.has("project:deploy-notes")).toBe(true);
  });
});
