import { describe, expect, it } from "vitest";

import type { ClientApi, QueryResult } from "../../../../server/api.js";
import {
  checkRenameTarget,
  commitRename,
  memoryChanged,
  verifyTargetSave,
  type MemoryAddress,
  type MemoryBody,
  type StoredMemory,
} from "../operations.js";

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

interface Fake {
  api: ClientApi;
  store: Map<string, Memory>;
  calls: string[];
  /** Next `memory.read` fails with this code instead of answering. */
  failNextReadWith?: string;
}

/** An in-memory `ClientApi` for the memory reads and writes the manager makes. */
function fakeApi(seeds: readonly Memory[] = [], failures: { delete?: boolean } = {}): Fake {
  const fake: Fake = {
    store: new Map(seeds.map((memory) => [`${memory.scope}:${memory.name}`, memory])),
    calls: [],
    api: undefined as unknown as ClientApi,
  };
  const api = {
    query: (async (query: { type: string; name?: string; scope?: string }) => {
      if (query.type === "memory.read") {
        if (fake.failNextReadWith !== undefined) {
          const code = fake.failNextReadWith;
          delete fake.failNextReadWith;
          throw Object.assign(new Error("transient failure"), { code });
        }
        const found = fake.store.get(`${query.scope}:${query.name}`);
        if (!found) throw Object.assign(new Error(`No memory named ${query.name}.`), { code: "MEMORY_NOT_FOUND" });
        return found;
      }
      throw new Error(`unexpected query ${query.type}`);
    }) as ClientApi["query"],
    dispatch: (async (command: { type: string; name: string; scope: "project" | "global"; description?: string; memoryType?: Memory["type"]; body?: string }) => {
      fake.calls.push(command.type);
      if (command.type === "memory.save") {
        fake.store.set(`${command.scope}:${command.name}`, entry({ name: command.name, scope: command.scope, description: command.description ?? "", type: command.memoryType ?? "project", body: command.body ?? "" }));
        return { name: command.name, scope: command.scope, replaced: false, total: fake.store.size };
      }
      if (command.type === "memory.delete") {
        if (failures.delete) throw Object.assign(new Error("boom"), { code: "DELETE_FAILED" });
        fake.store.delete(`${command.scope}:${command.name}`);
        return { name: command.name, scope: command.scope, total: fake.store.size, before: { description: "", type: "reference" as const, body: "" } };
      }
      throw new Error(`unexpected command ${command.type}`);
    }) as ClientApi["dispatch"],
  } as ClientApi;
  fake.api = api;
  return fake;
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

describe("checkRenameTarget", () => {
  it("asks to replace rather than overwriting a create whose name already exists", async () => {
    const fake = fakeApi([entry()]);
    const result = await checkRenameTarget(fake.api, address, null, body(), { replaceConfirmed: false });
    expect(result).toEqual({ needsReplaceConfirm: true, existing: entry() });
    expect(fake.calls).toEqual([]);
  });

  it("lets a create through when nothing holds the name", async () => {
    const fake = fakeApi([]);
    const result = await checkRenameTarget(fake.api, address, null, body(), { replaceConfirmed: false });
    expect(result).toEqual({ ok: true, existing: null });
  });

  it("lets a confirmed create through, carrying what it saw", async () => {
    const fake = fakeApi([entry()]);
    const result = await checkRenameTarget(fake.api, address, null, body(), { replaceConfirmed: true });
    expect(result).toEqual({ ok: true, existing: entry() });
  });

  it("asks to replace on renames, and passes an unchanged name without reading", async () => {
    const fake = fakeApi([entry(), entry({ name: "other-notes", description: "Other", body: "Other body." })]);
    const renamed = await checkRenameTarget(fake.api, address, { name: "deploy-notes", scope: "project" }, body({ name: "other-notes" }), { replaceConfirmed: false });
    expect(renamed).toEqual({ needsReplaceConfirm: true, existing: entry({ name: "other-notes", description: "Other", body: "Other body." }) });
    const same = await checkRenameTarget(fake.api, address, { name: "deploy-notes", scope: "project" }, body(), { replaceConfirmed: false });
    expect(same).toEqual({ ok: true, existing: null });
  });

  it("propagates a transient read failure instead of treating it as absent", async () => {
    const fake = fakeApi([entry()]);
    fake.failNextReadWith = "SERVER_UNAVAILABLE";
    await expect(checkRenameTarget(fake.api, address, null, body(), { replaceConfirmed: false })).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(fake.calls).toEqual([]);
  });
});

describe("verifyTargetSave", () => {
  const victim = entry({ name: "taken", description: "Victim", body: "Victim body." });
  const changedVictim = entry({ name: "taken", description: "Victim edited elsewhere", body: "Victim body." });

  it("saves a create or rename whose target stayed absent", () => {
    expect(verifyTargetSave({ isCreate: true, replaceEffective: false, basis: null, now: null })).toBe("save");
    expect(verifyTargetSave({ isCreate: false, replaceEffective: false, basis: null, now: null })).toBe("save");
  });

  it("routes a create over a taken name to replace consent", () => {
    expect(verifyTargetSave({ isCreate: true, replaceEffective: false, basis: null, now: victim })).toBe("replaceConfirm");
  });

  it("routes a rename over a concurrently created target to the conflict screen", () => {
    expect(verifyTargetSave({ isCreate: false, replaceEffective: false, basis: null, now: victim })).toBe("conflict");
  });

  it("saves a confirmed replace the victim still matches, and when it vanished", () => {
    expect(verifyTargetSave({ isCreate: false, replaceEffective: true, basis: victim, now: victim })).toBe("save");
    expect(verifyTargetSave({ isCreate: false, replaceEffective: true, basis: victim, now: null })).toBe("save");
  });

  it("routes a confirmed replace whose victim changed to the conflict screen", () => {
    expect(verifyTargetSave({ isCreate: false, replaceEffective: true, basis: victim, now: changedVictim })).toBe("conflict");
  });
});

describe("commitRename", () => {
  it("saves under the same name without a delete when nothing was renamed", async () => {
    const fake = fakeApi([entry()]);
    const result = await commitRename(fake.api, address, { name: "deploy-notes", scope: "project" }, body({ body: "Ship on Thursdays." }));
    expect(result).toEqual({ saved: true });
    expect(fake.calls).toEqual(["memory.save"]);
    expect(fake.store.get("project:deploy-notes")?.body).toBe("Ship on Thursdays.");
  });

  it("saves plus deletes on a confirmed rename", async () => {
    const fake = fakeApi([entry(), entry({ name: "other-notes", description: "Other", body: "Other body." })]);
    const result = await commitRename(fake.api, address, { name: "deploy-notes", scope: "project" }, body({ name: "other-notes", body: "Merged body." }));
    expect(result).toEqual({ saved: true });
    expect(fake.calls).toEqual(["memory.save", "memory.delete"]);
    expect(fake.store.get("project:other-notes")?.body).toBe("Merged body.");
    expect(fake.store.has("project:deploy-notes")).toBe(false);
  });

  it("does not lose the memory when the renamed save lands but the delete fails", async () => {
    const fake = fakeApi([entry()], { delete: true });
    await expect(
      commitRename(fake.api, address, { name: "deploy-notes", scope: "project" }, body({ name: "renamed-notes" })),
    ).rejects.toMatchObject({ code: "DELETE_FAILED" });
    expect(fake.store.get("project:renamed-notes")?.body).toBe("Ship on Fridays.");
    expect(fake.store.has("project:deploy-notes")).toBe(true);
  });
});
