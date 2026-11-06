import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import type { ClientApi } from "../../../server/api.js";
import { App, client } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { describeSettings, DEFAULTS_FOR_RENDER_CHECK } from "./settingsFixture.js";

interface Seed {
  readonly name: string;
  readonly description: string;
  readonly type: "user" | "feedback" | "project" | "reference";
  readonly body: string;
  readonly scope: "project" | "global";
}

const SEEDS: Seed[] = [
  { name: "deploy-notes", description: "How deploys go out", type: "project", body: "Ship on Fridays.\nCanary first, then the fleet.", scope: "project" },
  { name: "canary-watch", description: "What the canary checks", type: "feedback", body: "Watch error rate for an hour.", scope: "project" },
  { name: "editor-font", description: "Preferred font", type: "user", body: "JetBrains Mono.", scope: "global" },
];

/** The manager's server: an in-memory store behind the memory queries and writes it makes. */
function memoryClient(seeds: Seed[] = SEEDS): { api: ClientApi; dispatched: string[] } {
  const store = new Map(seeds.map((memory) => [`${memory.scope}:${memory.name}`, { ...memory }]));
  const dispatched: string[] = [];
  const api = {
    ...client,
    dispatch: (async (command: { type: string; name?: string; scope?: "project" | "global"; description?: string; memoryType?: Seed["type"]; body?: string }) => {
      dispatched.push(command.type);
      if (command.type === "memory.save") {
        const key = `${command.scope}:${command.name}`;
        const previous = store.get(key);
        store.set(key!, { name: command.name!, description: command.description ?? "", type: command.memoryType ?? "project", body: command.body ?? "", scope: command.scope! });
        return { name: command.name, scope: command.scope, replaced: previous !== undefined, total: store.size };
      }
      if (command.type === "memory.delete") {
        const key = `${command.scope}:${command.name}`;
        const previous = store.get(key);
        if (!previous) throw Object.assign(new Error(`No memory named ${command.name}.`), { code: "MEMORY_NOT_FOUND" });
        store.delete(key!);
        return { name: command.name, scope: command.scope, total: store.size, before: { description: previous.description, type: previous.type, body: previous.body } };
      }
      return { accepted: true };
    }) as ClientApi["dispatch"],
    query: (async (query: { type: string; name?: string; scope?: "project" | "global"; query?: string; limit?: number }) => {
      if (query.type === "memory.list") return { projectId: "p-cli", memories: [...store.values()], index: null };
      if (query.type === "memory.read") {
        const scopes = query.scope === undefined ? (["project", "global"] as const) : [query.scope];
        for (const scope of scopes) {
          const found = store.get(`${scope}:${query.name}`);
          if (found) return { ...found };
        }
        throw Object.assign(new Error(`No memory named ${query.name}.`), { code: "MEMORY_NOT_FOUND" });
      }
      if (query.type === "memory.search") {
        const terms = [...new Set(query.query!.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
        const ranked = [...store.values()]
          .filter((memory) => (query.scope === undefined || memory.scope === query.scope) && terms.some((term) => `${memory.name} ${memory.description} ${memory.body}`.toLowerCase().includes(term)))
          .map((memory) => {
            const flat = memory.body.replace(/\s+/gu, " ");
            const at = flat.toLowerCase().indexOf(terms[0]!);
            const from = Math.max(0, at - 20);
            return { name: memory.name, description: memory.description, type: memory.type, scope: memory.scope, excerpt: `${from > 0 ? "…" : ""}${flat.slice(from, from + 120)}` };
          });
        return { total: ranked.length, memories: ranked.slice(0, query.limit ?? 10) };
      }
      if (query.type === "settings.read") {
        return { path: "config.json", exists: true, settings: [{ descriptor: { key: "memory" }, value: true }] };
      }
      return (client.query as (query: unknown) => Promise<unknown>)(query);
    }) as ClientApi["query"],
  } as ClientApi;
  return { api, dispatched };
}

async function clickText(setup: TestRendererSetup, text: string): Promise<void> {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  if (y < 0) fail(`memory manager: missing ${text}`);
  await act(async () => setup.mockMouse.click(rows[y]!.indexOf(text), y));
  await setup.flush();
}

async function waitFor(setup: TestRendererSetup, text: string, what: string): Promise<string> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
    await setup.flush();
  }
  fail(`memory manager: ${what} never showed ${text}`);
}

async function typeText(setup: TestRendererSetup, text: string): Promise<void> {
  // One round trip per letter: a burst reuses a stale filter closure and only the last letter survives.
  for (const char of text) {
    await act(async () => setup.mockInput.pressKey(char));
    await setup.flush();
  }
}

/** Type into the visible filter and check every letter landed; a press lost to scheduling is retyped. */
async function typeFilter(setup: TestRendererSetup, text: string, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await typeText(setup, text);
    for (let poll = 0; poll < 20; poll += 1) {
      if (setup.captureCharFrame().includes(`${text}▏`)) return;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      await setup.flush();
    }
    for (const _char of text) {
      await act(async () => setup.mockInput.pressBackspace());
      await setup.flush();
    }
  }
  fail(`memory manager: ${what} never landed its filter`);
}

/** Let the modal fade arrive: captures mid-fade blend with the thread beneath. */
async function settle(setup: TestRendererSetup): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  await setup.flush();
}

/** Open the manager from the palette: ctrl+p, filter to the row, enter. */
async function openFromPalette(setup: TestRendererSetup): Promise<void> {
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await setup.flush();
  await typeFilter(setup, "manage m", "the palette");
  const filtered = setup.captureCharFrame();
  if (!filtered.includes("Manage memories")) fail("the palette offers no Manage memories row");
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
}

/** The memory manager: list grouped by scope, search, an open memory, edit, delete confirm, and a narrow window. */
export async function runMemoryManager(): Promise<void> {
  const { api, dispatched } = memoryClient();
  const setup = await testRender(<App client={api} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
  try {
    await setup.flush();
    await waitFor(setup, "Message delay and scheduling", "the thread view");
    await openFromPalette(setup);

    await waitFor(setup, "deploy-notes", "the memory list");
    await settle(setup);
    const list = setup.captureCharFrame();
    console.log("--- memory manager: list ---");
    console.log(list);
    for (const expected of ["Memories", "Global", "This project", "deploy-notes", "canary-watch", "editor-font", "How deploys go out"]) {
      if (!list.includes(expected)) fail(`the memory list is missing "${expected}"`);
    }
    // Grouped: the global scope reads before this project.
    if (list.indexOf("Global") > list.indexOf("This project")) fail("the memory list does not group global before this project");

    // Search uses the server search: the excerpt reads, and clearing returns to the grouped list.
    await typeFilter(setup, "canary", "the memory search");
    await waitFor(setup, "Watch error rate", "the memory search");
    await settle(setup);
    const search = setup.captureCharFrame();
    console.log("--- memory manager: search ---");
    console.log(search);
    if (!search.includes("canary-watch")) fail("the memory search lost the matching memory");
    for (let index = 0; index < "canary".length; index += 1) {
      await act(async () => setup.mockInput.pressBackspace());
      await setup.flush();
    }
    await waitFor(setup, "This project", "the grouped list after clearing search");

    // Open one in full: the whole body scrolls.
    await clickText(setup, "deploy-notes");
    await waitFor(setup, "Canary first", "the open memory");
    await settle(setup);
    const detail = setup.captureCharFrame();
    console.log("--- memory manager: open memory ---");
    console.log(detail);
    for (const expected of ["deploy-notes", "How deploys go out", "Ship on Fridays.", "Canary first, then the fleet."]) {
      if (!detail.includes(expected)) fail(`the open memory is missing "${expected}"`);
    }

    // Edit: the body takes more lines, and saving returns to the memory showing them.
    await act(async () => setup.mockInput.pressKey("e"));
    await setup.flush();
    await waitFor(setup, "Body:", "the edit form");
    await settle(setup);
    const edit = setup.captureCharFrame();
    console.log("--- memory manager: edit ---");
    console.log(edit);
    for (const expected of ["Name:", "Description:", "Type:", "Scope:", "Body:", "Save", "Cancel"]) {
      if (!edit.includes(expected)) fail(`the edit form is missing "${expected}"`);
    }
    for (let step = 0; step < 4; step += 1) {
      await act(async () => setup.mockInput.pressArrow("down"));
      await setup.flush();
    }
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    await act(async () => setup.mockInput.typeText(" Always canary first."));
    await setup.flush();
    await waitFor(setup, "Always canary first.", "the edited body");
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.flush();
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    await waitFor(setup, "Always canary first.", "the saved memory");
    await settle(setup);
    console.log("--- memory manager: edited ---");
    console.log(setup.captureCharFrame());
    if (!dispatched.includes("memory.save")) fail("editing did not dispatch a save");

    // Delete asks first: Delete, Go back.
    await act(async () => setup.mockInput.pressKey("x"));
    await setup.flush();
    await waitFor(setup, "Delete this memory?", "the delete confirm");
    await settle(setup);
    const confirm = setup.captureCharFrame();
    console.log("--- memory manager: delete confirm ---");
    console.log(confirm);
    for (const expected of ["Delete this memory?", "Delete", "Go back"]) {
      if (!confirm.includes(expected)) fail(`the delete confirm is missing "${expected}"`);
    }
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const afterDelete = await waitFor(setup, "Deleted deploy-notes.", "the list after delete");
    await settle(setup);
    console.log("--- memory manager: deleted ---");
    console.log(setup.captureCharFrame());
    if (afterDelete.includes("Ship on Fridays.")) fail("the deleted memory is still listed");
    if (!dispatched.includes("memory.delete")) fail("confirming did not dispatch a delete");

    await act(async () => setup.mockInput.pressEscape());
    await setup.flush();
  } finally {
    await act(async () => setup.renderer.destroy());
  }

  // A narrow window: the list still reads, rows intact.
  const narrowSetup = await testRender(<App client={memoryClient().api} onQuit={() => {}} launchView="thread" />, { width: 100, height: 26, exitOnCtrlC: false });
  try {
    await narrowSetup.flush();
    await waitFor(narrowSetup, "Message delay and scheduling", "the narrow thread view");
    await openFromPalette(narrowSetup);
    // The grouped headers carry spaces over live content: poll for the fade
    // to arrive rather than capturing mid-fade.
    const narrow = await waitFor(narrowSetup, "This project", "the narrow memory list");
    console.log("--- memory manager: narrow ---");
    console.log(narrow);
    for (const expected of ["Memories", "Global", "This project", "editor-font"]) {
      if (!narrow.includes(expected)) fail(`the narrow memory list is missing "${expected}"`);
    }
  } finally {
    await act(async () => narrowSetup.renderer.destroy());
  }

  // From Settings > Memory: the Manage memories button opens the same list.
  function SettingsHarness() {
    return (
      <SettingsModal
        client={api}
        threadId={null}
        initialSection="memory"
        snapshot={{ path: "config.json", exists: true, settings: describeSettings(DEFAULTS_FOR_RENDER_CHECK) }}
        loading={false}
        saving={null}
        error={null}
        onSet={() => true}
        onDuplicate={() => {}}
        run={null}
        onTest={() => {}}
        onTestMcp={() => {}}
        onProbe={() => {}}
        onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
        onExport={() => {}}
        onImport={() => {}}
        notice={null}
        versions={null}
        latest={null}
        updating={new Set()}
        onUpdate={() => {}}
        providers={null}
        screenWidth={100}
        screenHeight={34}
        left={2}
        top={1}
        width={96}
        height={32}
        onClose={() => {}}
      />
    );
  }
  const settingsSetup = await testRender(<SettingsHarness />, { width: 100, height: 34, exitOnCtrlC: false });
  try {
    await settingsSetup.flush();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    await settingsSetup.flush();
    const memory = await waitFor(settingsSetup, "Manage memories", "Settings > Memory");
    console.log("--- settings memory tab ---");
    console.log(memory);
    await clickText(settingsSetup, "Manage memories");
    await waitFor(settingsSetup, "canary-watch", "the manager from settings");
    await settle(settingsSetup);
    const fromSettings = settingsSetup.captureCharFrame();
    console.log("--- memory manager: from settings ---");
    console.log(fromSettings);
    if (!fromSettings.includes("Memories")) fail("Manage memories did not open the memory manager");
    await act(async () => settingsSetup.mockInput.pressEscape());
    await settingsSetup.flush();
  } finally {
    await act(async () => settingsSetup.renderer.destroy());
  }
}
