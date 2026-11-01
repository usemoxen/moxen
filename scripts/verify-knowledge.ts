/** Run after build. Only bundled JS is copied; no source docs or corpus files are available to the child processes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { RemoteConnection } from "../src/server/transport/remote.js";
import { namedPipe, probe } from "../src/server/transport/endpoint.js";

const root = await mkdtemp(path.join(os.tmpdir(), "moxen-kb-"));
const dist = path.join(root, "dist");
await cp(path.resolve(import.meta.dir, "..", "dist"), dist, {
  recursive: true,
  filter: (source) => path.basename(source) !== "assets" && !source.endsWith(".map"),
});
const store = path.join(root, "store");
await mkdir(store);
const config = path.join(root, "config.json");
await writeFile(config, JSON.stringify({ memory: false, memoryEmbeddings: false, remote: { enabled: false }, updates: { checkLatest: false } }));
const endpoint = process.platform === "win32" ? namedPipe(`moxen-kb-${process.pid}`) : path.join(root, "s.sock");
const env = { ...process.env, MOXEN_STORE_ROOT: store, MOXEN_CONFIG: config, MOXEN_SERVER_ENDPOINT: endpoint };
delete env.MOXEN_SERVER;
const server = spawn(process.execPath, [path.join(dist, "server", "daemon.js")], { cwd: root, env, stdio: "ignore" });
let client: RemoteConnection | undefined;
let mcp: ReturnType<typeof spawn> | undefined;
try {
  const deadline = Date.now() + 15_000;
  while (!await probe(endpoint)) {
    if (Date.now() > deadline || server.exitCode !== null) throw new Error("Bundled server failed to start");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  client = await RemoteConnection.connect(endpoint);
  const found = await client.query({ type: "knowledge.search", query: "moxen harness profile add" });
  assert.equal(found.matches[0]?.id, "cli-moxen-harness-profile-add");
  const page = await client.query({ type: "knowledge.read", id: "profiles", section: "setup" });
  assert.ok(page.text.includes("profile test"));
  mcp = spawn(process.execPath, [path.join(dist, "server", "mcp", "entry.js"), "--thread", "kb-smoke", "--delegated", "--no-web-fetch", "--memory=off"], { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: mcp.stdout! });
  const timer = setTimeout(() => mcp?.kill(), 15_000);
  try {
    mcp.stdin!.end([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "knowledge_read", arguments: { id: "profiles", section: "setup" } } },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n");
    const replies = new Map<number, any>();
    for await (const line of lines) {
      const reply = JSON.parse(line);
      replies.set(reply.id, reply);
    }
    assert.deepEqual(replies.get(1)?.result.tools.map((tool: { name: string }) => tool.name), ["knowledge_search", "knowledge_read"]);
    assert.equal(replies.get(2)?.result.isError, false);
    assert.deepEqual(JSON.parse(replies.get(2).result.content[0].text), page);
  } finally {
    clearTimeout(timer);
    lines.close();
  }
  console.log(JSON.stringify({ version: found.version, bundledServer: "passed", bundledMcp: "passed", sourceFilesRequired: false }));
} finally {
  if (mcp && mcp.exitCode === null) {
    const exited = once(mcp, "exit");
    mcp.kill();
    await exited;
  }
  await client?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
