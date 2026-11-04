/**
 * `moxen self-update --check`: the `--json` data is pinned byte for byte (goldens in `envelopes/`), over the wire
 * and in-process, and the text says what a person needs. The server's answer is injected; the check itself is
 * pinned in `core/selfupdate/tests`.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../core/config.js";
import type { UpdateCheck } from "../../core/selfupdate/vocabulary.js";
import { DirectConnection } from "../../server/connection.js";
import { RemoteConnection } from "../../server/transport/remote.js";
import { serve } from "../../server/transport/serve.js";
import { testEndpoint } from "../../server/transport/tests/endpoint.js";
import { setClientFactory, useRemoteServer } from "../infra/client.js";
import { describeProgress, describeRollback, describeSelfUpdate, describeUpdate, selfUpdateCheck, selfUpdateInstall, selfUpdateMode, selfUpdateRollback, selfUpdateRun } from "../selfupdate.js";

const golden = (name: string): string => path.join(__dirname, "envelopes", `${name}.json`);
const json = (data: unknown): string => `${JSON.stringify({ ok: true, data }, null, 2)}\n`;

const install = { version: "0.1.2", kind: "release", folder: "/opt/moxen-0.1.2-macos-arm64", target: { os: "macos", arch: "arm64" } } as const;
const available: UpdateCheck = {
  install,
  status: "available",
  reason: null,
  updatable: true,
  latest: {
    version: "0.2.0",
    tag: "v0.2.0",
    url: "https://github.com/usemoxen/moxen/releases/tag/v0.2.0",
    notes: "## What's Changed",
    archive: { name: "moxen-0.2.0-macos-arm64.tar.gz", url: "https://github.com/usemoxen/moxen/releases/download/v0.2.0/moxen-0.2.0-macos-arm64.tar.gz", size: 1234 },
    checksum: { name: "moxen-0.2.0-macos-arm64.tar.gz.sha256", url: "https://github.com/usemoxen/moxen/releases/download/v0.2.0/moxen-0.2.0-macos-arm64.tar.gz.sha256", size: 90 },
  },
};
const noRelease: UpdateCheck = { install: { ...install, kind: "source", folder: "/work/moxen" }, status: "no-release", reason: null, latest: null, updatable: false };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  setClientFactory(null);
  useRemoteServer(null);
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function overTheWire(answer: UpdateCheck, extra: Partial<ConstructorParameters<typeof DirectConnection>[0]> = {}): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "moxen-selfupdate-"));
  const endpoint = testEndpoint();
  const api = new DirectConnection({ storeRoot: root, checkAppUpdate: async () => answer, ...extra });
  const server = await serve({ endpoint, api, onClose: () => api.close() });
  const connections: RemoteConnection[] = [];
  setClientFactory(async () => {
    const connection = await RemoteConnection.connect(endpoint);
    connections.push(connection);
    return connection;
  });
  cleanup.push(async () => {
    for (const connection of connections) await connection.close();
    await server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
}

describe("moxen self-update", () => {
  it("--json: an available update on a release install", async () => {
    await overTheWire(available);
    const report = await selfUpdateCheck(DEFAULT_CONFIG);
    await expect(json(report)).toMatchFileSnapshot(golden("self-update-check-available"));
  });

  it("--json: no release yet, on a source checkout", async () => {
    await overTheWire(noRelease);
    await expect(json(await selfUpdateCheck(DEFAULT_CONFIG))).toMatchFileSnapshot(golden("self-update-check-no-release"));
  });

  it("labels a paired server's answer as remote", async () => {
    await overTheWire(available);
    useRemoteServer("winbox");
    const report = await selfUpdateCheck(DEFAULT_CONFIG);
    expect(report.remote).toBe("winbox");
    expect(describeSelfUpdate(report)).toMatch(/^Remote server winbox: Moxen 0\.1\.2, release install/);
  });

  it("the plain command and --rollback run in the server: its stages reach only the caller, and the result is unchanged", async () => {
    const result = { action: "updated", version: "0.2.0", from: "0.1.2", previous: "0.1.2", folder: "/app/versions/0.2.0", current: "/app/current", warnings: [] } as const;
    const rolled = { action: "rolled-back", version: "0.1.2", from: "0.2.0", previous: "0.2.0", folder: "/app/versions/0.1.2", current: "/app/current", warnings: [] } as const;
    const kept: Array<readonly string[] | null> = [];
    await overTheWire(available, {
      updateApp: async (options) => {
        kept.push((await options.runningVersions?.()) ?? null);
        options.onProgress?.({ stage: "checking" });
        options.onProgress?.({ stage: "downloading", version: "0.2.0", bytes: 5, total: 10 });
        options.onProgress?.({ stage: "done", version: "0.2.0" });
        return result;
      },
      rollbackApp: async (options) => {
        options.onProgress?.({ stage: "switching", version: "0.1.2" });
        return rolled;
      },
    });
    const stages: Array<{ stage: string; bytes?: number }> = [];
    expect(await selfUpdateRun(DEFAULT_CONFIG, (progress) => stages.push({ stage: progress.stage, ...(progress.bytes === undefined ? {} : { bytes: progress.bytes }) }))).toEqual(result);
    expect(stages).toEqual([{ stage: "checking" }, { stage: "downloading", bytes: 5 }, { stage: "done" }]);
    // The server names the version it runs itself, so pruning never needs a question from the CLI.
    expect(kept).toEqual([[expect.stringMatching(/^\d+\.\d+\.\d+/)]]);
    // With no listener there is no subscription at all, and the result is the same.
    expect(await selfUpdateRollback(DEFAULT_CONFIG)).toEqual(rolled);
  });

  it("describes each stage in a line, and a download with its size", () => {
    expect(describeProgress({ stage: "checking" })).toBe("Checking for the latest release...");
    expect(describeProgress({ stage: "downloading", version: "0.2.0", bytes: 1024 * 1024, total: 4 * 1024 * 1024 })).toBe("Downloading Moxen 0.2.0: 1.0 MiB of 4.0 MiB");
    expect(describeProgress({ stage: "downloading", bytes: 2 * 1024 * 1024, total: null })).toBe("Downloading Moxen: 2.0 MiB");
  });

  it("says what each answer means in text", () => {
    const text = (check: UpdateCheck) => describeSelfUpdate({ remote: null, ...check });
    expect(text(available)).toContain("Update available: 0.2.0");
    expect(text({ ...available, install: { ...install, kind: "source" }, updatable: false })).toContain("source checkout (never updated by moxen)");
    expect(text({ ...available, install: { ...install, kind: "source" }, updatable: false })).toContain("not updated by moxen");
    expect(text(noRelease)).toContain("No release has been published yet.");
    expect(text({ ...noRelease, status: "unavailable", reason: "could not reach GitHub" })).toContain("Could not check: could not reach GitHub.");
  });

  it("the plain command updates now: it no longer exits 1 with SELF_UPDATE_UNAVAILABLE", () => {
    expect(selfUpdateMode({})).toBe("update");
    expect(selfUpdateMode({ check: true })).toBe("check");
    expect(selfUpdateMode({ install: true })).toBe("install");
    expect(selfUpdateMode({ rollback: true })).toBe("rollback");
  });

  it("flags that do not go together exit 2 with INVALID_ARGUMENT", () => {
    for (const options of [{ check: true, install: true }, { check: true, rollback: true }, { install: true, rollback: true }]) {
      expect(() => selfUpdateMode(options)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }));
    }
  });

  it("says that running threads keep their version and that nothing was restarted", () => {
    const base = { version: "1.1.0", from: "1.0.0", previous: "1.0.0", folder: "/app/versions/1.1.0", current: "/app/current", warnings: ["Could not delete old version 0.9.0: busy"] } as const;
    const updated = describeUpdate({ action: "updated", ...base });
    expect(updated).toContain("1.0.0 -> 1.1.0");
    expect(updated).toContain("keep the version they started on until the moxen server restarts");
    expect(updated).toContain("Warning: Could not delete old version 0.9.0");
    expect(describeUpdate({ action: "already-current", ...base, warnings: [] })).toContain("already the current version");
    expect(describeRollback({ action: "rolled-back", version: "1.0.0", from: "1.1.0", previous: "1.1.0", folder: "/app/versions/1.0.0", current: "/app/current", warnings: [] })).toContain("until the moxen server restarts");
  });

  it("--install, the plain update and --rollback are refused on a paired server, and from this source checkout before anything is written", async () => {
    const store = mkdtempSync(path.join(os.tmpdir(), "moxen-selfupdate-install-"));
    const previous = process.env.MOXEN_STORE_ROOT;
    process.env.MOXEN_STORE_ROOT = store;
    try {
      useRemoteServer("winbox");
      for (const run of [() => selfUpdateInstall(), () => selfUpdateRun(DEFAULT_CONFIG), () => selfUpdateRollback(DEFAULT_CONFIG)]) await expect(run()).rejects.toMatchObject({ code: "SELF_UPDATE_REMOTE", exitCode: 2 });
      useRemoteServer(null);
      await expect(selfUpdateInstall()).rejects.toMatchObject({ code: "SELF_UPDATE_SOURCE_INSTALL", exitCode: 1 });
      await expect(selfUpdateRun(DEFAULT_CONFIG)).rejects.toMatchObject({ code: "SELF_UPDATE_SOURCE_INSTALL", exitCode: 1 });
      await expect(selfUpdateRollback(DEFAULT_CONFIG)).rejects.toMatchObject({ code: "SELF_UPDATE_SOURCE_INSTALL", exitCode: 1 });
      expect(readdirSync(store)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MOXEN_STORE_ROOT;
      else process.env.MOXEN_STORE_ROOT = previous;
      rmSync(store, { recursive: true, force: true });
    }
  });
});
