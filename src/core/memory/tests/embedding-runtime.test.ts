import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { EmbeddingRuntime } from "../embedding-runtime.js";
import { EMBEDDING_VERSION } from "../embedding-cache.js";

let root: string | undefined;
let runtime: EmbeddingRuntime | undefined;
afterEach(async () => { vi.useRealTimers(); runtime?.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe("embedding child entry", () => {
  // The script runs on Bun (TypeScript directly); vitest itself may run on Node.
  const BUN = process.versions.bun ? process.execPath : "bun";
  const entry = fileURLToPath(new URL("../embedding-child-entry.ts", import.meta.url));

  it("reports a protocol error without arguments and exits non-zero", () => {
    const run = spawnSync(BUN, [entry], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: expect.any(String) });
  });
});

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

it("rejects only the aborted caller on cancel, never fails the runtime, and never mismatches a late reply", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "moxen-encoder-cancel-"));
  const file = path.join(root, "slow.mjs");
  await writeFile(file, `
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ready:true,device:'cpu'}));
for await (const line of createInterface({input:process.stdin})) {
  const {texts} = JSON.parse(line);
  if (texts[0] === 'slow') {
    console.log(JSON.stringify({progress:'slow-received',percent:10}));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(JSON.stringify({vectors:texts.map(()=>[9,...Array(767).fill(0)])}));
  } else {
    console.log(JSON.stringify({vectors:texts.map(()=>[1,...Array(767).fill(0)])}));
  }
}
`);
  runtime = new EmbeddingRuntime(root, file);
  const active = runtime;
  expect((await active.encode(["first"]))[0]?.[0]).toBe(1);
  const abort = new AbortController();
  const slow = active.encode(["slow"], abort.signal);
  // The request reached the child: its late reply would resolve the next
  // caller's receive, so cancelling must restart the child to stay correct.
  await vi.waitFor(() => expect(active.status.file).toBe("slow-received"), { timeout: 10_000 });
  abort.abort();
  await expect(slow).rejects.toThrow("cancelled");
  expect(active.status.state).not.toBe("failed");
  expect((await active.encode(["fresh"]))[0]).toEqual([1, ...Array(767).fill(0)]);
  expect(active.status.state).toBe("ready");
});
