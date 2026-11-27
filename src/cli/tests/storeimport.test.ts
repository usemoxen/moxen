/**
 * `moxen store import` (MXN-393), through the real command, in-process and
 * over the wire. It writes `store.db`, so it needs `bun:sqlite`: under Node
 * it skips, and `bun run test:sqlite` runs it.
 */
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testHarness } from "../../core/testing/harness.js";
import { createThread } from "../../core/threads/threads.js";
import { underBun, openForTest } from "../../core/threads/sqlite/tests/support.js";
import { DirectConnection } from "../../server/connection.js";
import { serve } from "../../server/transport/serve.js";
import { RemoteConnection } from "../../server/transport/remote.js";
import { testEndpoint } from "../../server/transport/tests/endpoint.js";
import { setClientFactory } from "../infra/client.js";
import { program } from "../program.js";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  setClientFactory(null);
  for (const step of teardown.splice(0).reverse()) await step();
});

/** What the command printed to stdout and stderr. */
async function run(args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const captured = { stdout: "", stderr: "" };
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  const config = process.env.MOXEN_CONFIG;
  for (const stream of ["stdout", "stderr"] as const) {
    process[stream].write = ((chunk: string | Uint8Array) => {
      captured[stream] += String(chunk);
      return true;
    }) as typeof process.stdout.write;
  }
  try {
    process.exitCode = 0;
    await program.parseAsync(["node", "moxen", ...args]);
    return { ...captured, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
    process.exitCode = 0;
    if (config === undefined) delete process.env.MOXEN_CONFIG;
    else process.env.MOXEN_CONFIG = config;
  }
}

/** A store with one finished turn and one torn line, served the way the mode says. */
async function seeded(mode: "direct" | "remote") {
  const harness = await testHarness();
  await createThread(harness.store, {
    id: "thread-existing",
    projectId: "project-existing",
    title: "Existing thread",
    modelSelection: { instanceId: "opencode", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    env: { mode: "local", path: harness.work, branch: "main" },
  });
  await harness.store.appendLedger("thread-existing", "turns", {
    id: "turn-1", threadId: "thread-existing", messageId: "msg-1", status: "completed", delivery: "started",
    runtimeMode: "full-access", interactionMode: "default", modelSelection: null, parentTurnId: null, error: null, usage: null,
    createdAt: "2026-11-19T10:20:30.000Z", updatedAt: "2026-11-19T10:20:30.000Z", completedAt: "2026-11-19T10:20:30.000Z",
  });
  appendFileSync(path.join(harness.root, "threads", "thread-existing", "turns.jsonl"), "torn");
  const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
  if (mode === "direct") {
    setClientFactory(async () => api);
    teardown.push(() => api.close());
  } else {
    const endpoint = testEndpoint();
    const server = await serve({ endpoint, api, onClose: () => api.close() });
    const connections: RemoteConnection[] = [];
    setClientFactory(async () => {
      const connection = await RemoteConnection.connect(endpoint);
      connections.push(connection);
      return connection;
    });
    teardown.push(async () => {
      expect(connections.length).toBeGreaterThan(0);
      for (const connection of connections) await connection.close();
      await server.close();
    });
  }
  return { harness, api };
}

const golden = path.join(__dirname, "envelopes", "store-import.json");

/** The run-specific values: the temporary root, the times and the host's separator. */
function normalize(text: string, root: string): string {
  const envelope = JSON.parse(text) as { ok: boolean; data: Record<string, unknown> };
  for (const key of ["storeRoot", "database"]) {
    envelope.data[key] = String(envelope.data[key]).replace(realpathSync(root), "<root>").replace(path.resolve(root), "<root>").replaceAll("\\", "/");
  }
  expect(envelope.data.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  expect(envelope.data.durationMs).toEqual(expect.any(Number));
  envelope.data.importedAt = "<time>";
  envelope.data.durationMs = "<ms>";
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

describe.skipIf(!underBun)("moxen store import", () => {
  it.each(["direct", "remote"] as const)("prints the pinned --json envelope (%s)", async (mode) => {
    const { harness } = await seeded(mode);
    const result = await run(["--json", "store", "import"]);
    expect(result).toMatchObject({ stderr: "", exitCode: 0 });
    await expect(normalize(result.stdout, harness.root)).toMatchFileSnapshot(golden);
    const db = openForTest(harness.root);
    expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'import_state'").get()).toEqual({ value: "complete" });
  });

  it("says in plain words what was imported and what was quarantined", async () => {
    const { harness } = await seeded("direct");
    const result = await run(["store", "import"]);
    expect(result).toMatchObject({ stderr: "", exitCode: 0 });
    expect(result.stdout).toContain("turns\t1 of 2 (1 quarantined)");
    expect(result.stdout).toContain("1 record could not be imported");
    expect(result.stdout).toContain("The JSONL store is unchanged");
    expect(readFileSync(path.join(harness.root, "threads", "thread-existing", "turns.jsonl"), "utf8")).toMatch(/torn$/u);
  });

  it("reports a refusal as a --json error", async () => {
    const { harness } = await seeded("direct");
    // Opened by the first request, then made newer than this build, as a later build's cut-over would.
    await run(["--json", "store", "import"]);
    writeFileSync(path.join(harness.root, "store.json"), '{"formatVersion":2}\n');
    const result = await run(["--json", "store", "import"]);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "FORMAT_TOO_NEW" } });
    expect(result.exitCode).not.toBe(0);
  });

  it("gives a request that arrives during an import that run's report", async () => {
    const { api } = await seeded("direct");
    const [first, second] = await Promise.all([api.dispatch({ type: "store.import" }), api.dispatch({ type: "store.import" })]);
    expect(second).toBe(first);
    expect(await api.dispatch({ type: "store.import" })).not.toBe(first);
  });
});
