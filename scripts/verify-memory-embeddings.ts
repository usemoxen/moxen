/** Opt-in real-model smoke check against the production daemon. Run after build.
 * Downloads runtime/weights into the ignored .moxen/ directory on first use.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { RemoteConnection } from "../src/server/transport/remote.js";
import { namedPipe, probe } from "../src/server/transport/endpoint.js";
import { startEmbeddingsHeartbeat } from "../src/server/embeddingsHeartbeat.js";

// `--dist <dir>` checks another bundle (an unpacked release archive's `dist/`) instead of the checkout's.
const distFlag = process.argv.indexOf("--dist");
const dist = path.resolve(distFlag >= 0 && process.argv[distFlag + 1] ? process.argv[distFlag + 1]! : path.join(import.meta.dir, "..", "dist"));
const root = path.resolve(import.meta.dir, "..", ".moxen", "embedding-validation");
await mkdir(root, { recursive: true });
const config = path.join(root, "config.json");
await writeFile(config, JSON.stringify({ memoryEmbeddings: false }));
const endpoint = process.platform === "win32" ? namedPipe(`moxen-embedding-validation-${process.pid}`) : path.join(root, "server.sock");
const start = () => spawn(process.execPath, [path.join(dist, "server", "daemon.js")], {
  env: { ...process.env, MOXEN_STORE_ROOT: root, MOXEN_CONFIG: config, MOXEN_SERVER_ENDPOINT: endpoint },
  stdio: "ignore",
});
let server = start();
let client: RemoteConnection | undefined;
const deadline = Date.now() + 15_000;
try {
  while (!await probe(endpoint)) {
    if (Date.now() > deadline || server.exitCode !== null) throw new Error("Production daemon failed to start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  client = await RemoteConnection.connect(endpoint);
  const corpus = [
    ["secrets", "Authentication keys belong in the OS keychain. Provider CLIs manage their own login. Never print tokens."],
    ["paths", "Construct filesystem paths with node:path so directory separators work on Windows and macOS."],
    ["language", "The interface translation uses natural Spanish from Spain, with tú, never Latin American vocabulary."],
    ["ci", "CI must pass on every job before a pushed change is ready. Use bun run check locally."],
    ["tests", "Reduce suite latency by using isolated fixtures and avoiding unnecessary subprocesses."],
    ["model-cache", "Model weights are downloaded only during explicit setup. Reuse the pinned local directory offline."],
    ["memory-scopes", "Project memories describe the codebase; global memories describe user preferences. Read before updating."],
    ["ssh", "SSH remote access uses an encrypted tunnel to the server. Pair devices explicitly."],
  ];
  for (const [name, body] of corpus) await client.dispatch({ type: "memory.save", name: name!, description: name!, body: body!, memoryType: "project", scope: "global" });
  // A concurrent heartbeat watches a long embeddings run. A poll that fails —
  // including one still parked when the client closes — is ignored by the
  // heartbeat itself; the beats and latency asserts below stay strict.
  const heartbeat = startEmbeddingsHeartbeat(
    () => client!.query({ type: "memory.embeddings.status" }),
    (progress) => console.log(JSON.stringify({ progress })),
  );
  try {
    console.log(JSON.stringify({ setup: await client.dispatch({ type: "memory.embeddings.setup" }) }));
    await client.dispatch({ type: "settings.set", key: "memoryEmbeddings", value: "true" });
    console.log(JSON.stringify({ runtime: await client.query({ type: "memory.embeddings.status" }) }));
    const queries = [
      ["Where should an API credential be kept?", "secrets"],
      ["How do we avoid platform-specific directory separators?", "paths"],
      ["¿Qué variante del castellano usamos para traducir la interfaz?", "language"],
      ["CI", "ci"],
      ["How can we reduce the time spent running our checks?", "tests"],
      ["Can the model work without an internet connection?", "model-cache"],
    ];
    for (const [query, expected] of queries) {
      const started = performance.now();
      const result = await client.query({ type: "memory.search", query: query!, limit: 3 });
      const names = result.memories.map((memory) => memory.name);
      console.log(JSON.stringify({ query, expected, names, ms: performance.now() - started, semantic: result.semantic }));
      assert.equal(result.semantic?.state, "ready");
      assert.equal(names[0], expected);
    }
    await client.dispatch({ type: "memory.save", name: "long-document", description: "A long document for responsiveness validation", body: "A synthetic record about gardening and growing tomatoes. ".repeat(140), memoryType: "reference", scope: "global" });
    await client.dispatch({ type: "memory.embeddings.rebuild" });
    await client.dispatch({ type: "memory.delete", name: "long-document", scope: "global" });
    await client.dispatch({ type: "memory.embeddings.rebuild" });
    await client.dispatch({ type: "memory.embeddings.unload" });
    // A fresh process must load the pinned local directory without downloading.
    const offline = await client.query({ type: "memory.search", query: "API credential", limit: 1 });
    assert.equal(offline.semantic?.state, "ready");
    assert.equal(offline.memories[0]?.name, "secrets");
    // Exercise the actual shipped CPU worker on macOS too, independently of
    // automatic WebGPU selection. On Windows this is the default backend.
    const worker = path.join(dist, "core", "memory", "embedding-child-entry.js");
    assert.ok((await stat(worker).catch(() => null))?.isFile(), `No bundled embedding worker at ${worker}`);
    const runtime = path.join(root, "embedding-runtime", "transformers-4.3.2");
    const cpu = spawn(process.execPath, [worker, runtime, path.join(runtime, "cache"), "offline", "cpu"], { stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: cpu.stdout });
    const timeout = setTimeout(() => cpu.kill(), 30_000);
    try {
      let checked = false;
      for await (const line of lines) {
        const value = JSON.parse(line);
        if (value.error) throw new Error(value.error);
        if (value.ready) cpu.stdin.write(`${JSON.stringify({ texts: ["task: search result | query: directory separators"] })}\n`);
        if (value.vectors) {
          assert.equal(value.device, "cpu");
          assert.equal(value.vectors[0].length, 768);
          assert.ok(Math.abs(Math.hypot(...value.vectors[0]) - 1) < 0.01);
          checked = true;
          console.log(JSON.stringify({ cpu: "passed" }));
          break;
        }
      }
      assert.ok(checked, "CPU process exited without an embedding");
    } finally {
      clearTimeout(timeout);
      lines.close();
      const exited = once(cpu, "exit");
      if (cpu.exitCode === null && cpu.signalCode === null) { cpu.kill(); await exited; }
    }
  } finally { heartbeat.stop(); }
  assert.ok(heartbeat.beats > 0, "No concurrent server heartbeat completed");
  assert.ok(heartbeat.maxHeartbeatMs < 1000, `Server heartbeat stalled for ${heartbeat.maxHeartbeatMs}ms`);
  // The default residency policy warms a validated local install at startup,
  // before any search. Restart the real daemon to check the shipped behavior.
  await client.close();
  client = undefined;
  const stopped = once(server, "exit");
  server.kill();
  await stopped;
  server = start();
  const restartDeadline = Date.now() + 15_000;
  while (!await probe(endpoint)) {
    if (Date.now() > restartDeadline || server.exitCode !== null) throw new Error("Production daemon failed to restart");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  client = await RemoteConnection.connect(endpoint);
  let startup = await client.query({ type: "memory.embeddings.status" });
  while (startup.state !== "ready") {
    if (Date.now() > restartDeadline || startup.state === "failed") throw new Error("Validated model did not warm at startup");
    await new Promise((resolve) => setTimeout(resolve, 50));
    startup = await client.query({ type: "memory.embeddings.status" });
  }
  assert.equal(startup.validation?.correct, 6);
  console.log(JSON.stringify({ startupWarm: true, device: startup.device, validation: startup.validation }));
  console.log(JSON.stringify({ beats: heartbeat.beats, maxHeartbeatMs: heartbeat.maxHeartbeatMs, passed: true }));
} finally {
  await client?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}
