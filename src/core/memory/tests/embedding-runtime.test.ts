import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EmbeddingRuntime } from "../embedding-runtime.js";
import { EMBEDDING_VERSION } from "../embedding-cache.js";

let root: string | undefined;
let runtime: EmbeddingRuntime | undefined;
afterEach(async () => { vi.useRealTimers(); runtime?.close(); if (root) await rm(root, { recursive: true, force: true }); });

it("warms only a validated install, honors its CPU selection and keeps it resident until on-demand idle release", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "moxen-residency-"));
  const file = path.join(root, "resident.mjs");
  await writeFile(file, `import {createInterface} from 'node:readline';console.log(JSON.stringify({ready:true,device:process.argv[5]}));for await(const line of createInterface({input:process.stdin})){const {texts}=JSON.parse(line);console.log(JSON.stringify({vectors:texts.map(()=>[1,...Array(767).fill(0)])}));}`);
  runtime = new EmbeddingRuntime(root, file);
  await runtime.warm();
  expect(runtime.status.state).toBe("stopped");
  const dir = path.join(root, "embedding-runtime", "transformers-4.3.2");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "validation.json"), JSON.stringify({ version: EMBEDDING_VERSION, platform: process.platform, arch: process.arch, device: "cpu", correct: 6, total: 6, queryP95Ms: 20, documentMs: 100, checkedAt: "2026-11-01" }));
  vi.useFakeTimers();
  runtime.setKeepLoaded(true);
  await runtime.warm();
  expect(runtime.status.device).toBe("cpu");
  await vi.advanceTimersByTimeAsync(61_000);
  expect(runtime.status.state).toBe("ready");
  runtime.setKeepLoaded(false);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(runtime.status.state).toBe("stopped");
  // A fresh on-demand runtime must use the saved CPU choice too, even though
  // warm() was never called on it.
  runtime = new EmbeddingRuntime(root, file);
  await runtime.encode(["first on-demand query"]);
  expect(runtime.status.device).toBe("cpu");
});

it("keeps the parent responsive, cancels native work and recovers after process failure", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "moxen-encoder-"));
  const file = path.join(root, "fake.mjs");
  await writeFile(file, `
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ready:true,device:'cpu'}));
for await (const line of createInterface({input:process.stdin})) {
  const {texts} = JSON.parse(line);
  if (texts[0] === 'crash') process.exit(1);
  if (texts[0] === 'blocked') { while (true) {} }
  console.log(JSON.stringify({vectors:texts.map(()=>[1,...Array(767).fill(0)])}));
}
`);
  runtime = new EmbeddingRuntime(root, file);
  expect((await runtime.encode(["first"]))[0]?.length).toBe(768);
  const abort = new AbortController();
  const blocked = runtime.encode(["blocked"], abort.signal);
  const rejected = expect(blocked).rejects.toThrow("cancelled");
  await new Promise((resolve) => setImmediate(resolve));
  const queuedAbort = new AbortController();
  const queued = runtime.encode(["queued"], queuedAbort.signal);
  queuedAbort.abort();
  // The blocked request is still running: cancellation must leave its queue
  // immediately, rather than waiting for the native call to finish.
  await expect(queued).rejects.toThrow("cancelled");
  abort.abort();
  await rejected;
  expect((await runtime.encode(["recovered"]))[0]?.[0]).toBe(1);
  await expect(runtime.encode(["crash"])).rejects.toThrow("stopped");
  expect((await runtime.encode(["restarted"]))[0]?.[0]).toBe(1);
  runtime.close();
  expect(runtime.status.state).toBe("stopped");
});
