/**
 * Updating and rolling back. Every safety rule has a test that fails when the rule breaks: a failed update
 * leaves `current` and the running version folder as they were and removes its temp folder; nothing in use is
 * deleted; a source checkout or a release outside `versions/` is refused before anything is written.
 * The release is a real archive made with the platform's own tar, served by an injected fetch.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_MARKER, archiveFileName, checksumFileName, packCommand, releaseBaseName, releaseMarker, releaseTarget } from "../../release.js";
import { LATEST_RELEASE_URL } from "../check.js";
import { appLayout, type AppLayout } from "../installer.js";
import { escapingEntries, parseChecksum, rollbackRelease, unsafeEntries, updateRelease, type UpdateOptions } from "../update.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moxen-update test-"));
  roots.push(root);
  return root;
};

const platform = process.platform === "win32" ? "win32" : "darwin";
const arch = process.platform === "win32" ? "x64" : "arm64";
const target = releaseTarget(platform, arch);
/** A stand-in entry point: prints the version it was given, or misbehaves as told. */
const entry = (version: string, mode = "ok"): string =>
  mode === "crash" ? "process.exit(3);" : mode === "hang" ? "setInterval(() => {}, 1000);" : `process.stdout.write(${JSON.stringify(mode === "wrong" ? "9.9.9" : version)});`;

function writeRelease(folder: string, version: string, mode = "ok"): void {
  mkdirSync(path.join(folder, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(folder, RELEASE_MARKER), JSON.stringify(releaseMarker(version, target)));
  writeFileSync(path.join(folder, "dist", "cli", "index.js"), entry(version, mode));
}

/** A release archive for `version`, built with the platform's tar, and its checksum text. */
function buildArchive(version: string, mode = "ok", mutate?: (folder: string) => void): { file: string; bytes: Buffer; sum: string } {
  const parent = temp();
  const folder = path.join(parent, releaseBaseName(version, target));
  writeRelease(folder, version, mode);
  mutate?.(folder);
  const file = path.join(parent, archiveFileName(version, target));
  const pack = packCommand(target, file, parent, path.basename(folder));
  const result = spawnSync(pack.command, pack.args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not pack: ${result.stderr}`);
  const bytes = readFileSync(file);
  return { file, bytes, sum: createHash("sha256").update(bytes).digest("hex") };
}

interface World {
  readonly layout: AppLayout;
  readonly store: string;
  readonly running: string;
  /** Options that make the "running" release `runningVersion` and the network `serve`. */
  options(overrides?: Partial<UpdateOptions>): UpdateOptions;
}

/** An app folder with `versions` installed (each a working stand-in), `current` and optionally `previous`. */
function world(versions: string[], current: string | null, previous: string | null, runningVersion: string, serve: Record<string, () => Response>): World {
  const store = temp();
  const layout = appLayout({ MOXEN_STORE_ROOT: store } as NodeJS.ProcessEnv);
  for (const version of versions) writeRelease(path.join(layout.versions, version), version);
  if (current !== null) writeFileSync(layout.current, `${current}\n`);
  if (previous !== null) writeFileSync(layout.previous, `${previous}\n`);
  const running = path.join(layout.versions, runningVersion);
  const doFetch = (async (url: string | URL | Request): Promise<Response> => {
    const make = serve[String(url)];
    return make === undefined ? new Response("not found", { status: 404 }) : make();
  }) as typeof fetch;
  return {
    layout,
    store,
    running,
    options: (overrides = {}) => ({ from: running, version: runningVersion, platform, arch, layout, fetch: doFetch, ...overrides }),
  };
}

const ASSET = "https://example.test/download";
function releaseJson(version: string, assets: Array<"archive" | "checksum"> = ["archive", "checksum"], base = ASSET): string {
  const names = { archive: archiveFileName(version, target), checksum: checksumFileName(version, target) };
  return JSON.stringify({
    tag_name: `v${version}`,
    html_url: `https://example.test/releases/v${version}`,
    body: "notes",
    draft: false,
    prerelease: false,
    assets: assets.map((kind) => ({ name: names[kind], browser_download_url: `${base}/${names[kind]}`, state: "uploaded", size: 1 })),
  });
}

/** The network for releasing `version`: the GitHub answer plus the archive and its checksum text. */
function network(version: string, archive: { bytes: Buffer; sum: string }, extra: { checksumText?: string; assets?: Array<"archive" | "checksum">; archiveStatus?: number; base?: string } = {}): Record<string, () => Response> {
  const base = extra.base ?? ASSET;
  return {
    [LATEST_RELEASE_URL]: () => new Response(releaseJson(version, extra.assets, base), { headers: { "content-type": "application/json" } }),
    [`${base}/${archiveFileName(version, target)}`]: () => (extra.archiveStatus ? new Response("no", { status: extra.archiveStatus }) : new Response(new Uint8Array(archive.bytes))),
    [`${base}/${checksumFileName(version, target)}`]: () => new Response(extra.checksumText ?? `${archive.sum}  ${archiveFileName(version, target)}\n`),
  };
}

/** Every file under a folder with its content, to prove nothing moved. */
function snapshot(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else out.push(`${path.relative(folder, full)}:${readFileSync(full, "utf8")}`);
    }
  };
  if (existsSync(folder)) walk(folder);
  return out;
}

const text = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);

describe("updateRelease", () => {
  it("downloads, tests and switches: current names the new version, the old one is the previous, nothing is left over", async () => {
    const archive = buildArchive("1.1.0");
    const w = world(["1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
    const result = await updateRelease(w.options());
    expect(result).toMatchObject({ action: "updated", version: "1.1.0", from: "1.0.0", previous: "1.0.0", warnings: [] });
    expect(text(w.layout.current)).toBe("1.1.0\n");
    expect(text(w.layout.previous)).toBe("1.0.0\n");
    expect(readdirSync(w.layout.versions).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(readFileSync(path.join(w.layout.versions, "1.1.0", "dist", "cli", "index.js"), "utf8")).toBe(entry("1.1.0"));
    expect(existsSync(path.join(w.layout.app, "update.lock"))).toBe(false);
  });

  it("does nothing and succeeds when the install is already the latest", async () => {
    const archive = buildArchive("1.0.0");
    const w = world(["1.0.0"], "1.0.0", null, "1.0.0", network("1.0.0", archive));
    const before = snapshot(w.layout.app);
    const result = await updateRelease(w.options());
    expect(result).toMatchObject({ action: "already-current", version: "1.0.0" });
    expect(snapshot(w.layout.app)).toEqual(before);
  });

  it("does nothing when current already names the latest, though this process still runs the older one", async () => {
    const archive = buildArchive("1.1.0");
    const w = world(["1.0.0", "1.1.0"], "1.1.0", "1.0.0", "1.0.0", network("1.1.0", archive));
    const before = snapshot(w.layout.app);
    expect(await updateRelease(w.options())).toMatchObject({ action: "already-current", version: "1.1.0" });
    expect(snapshot(w.layout.app)).toEqual(before);
  });

  describe("leaves current and the running version untouched, and removes the temp folder, when", () => {
    const good = buildArchive("1.1.0");
    const cases: Array<[string, () => Record<string, () => Response>, Partial<UpdateOptions>?]> = [
      ["the checksum does not match the archive", () => network("1.1.0", good, { checksumText: `${"0".repeat(64)}  ${archiveFileName("1.1.0", target)}\n` })],
      ["the checksum file is malformed", () => network("1.1.0", good, { checksumText: "not a checksum\n" })],
      ["the checksum names another file", () => network("1.1.0", good, { checksumText: `${good.sum}  other.tar.gz\n` })],
      ["the download fails", () => network("1.1.0", good, { archiveStatus: 500 })],
      ["the archive is not an archive", () => network("1.1.0", { bytes: Buffer.from("garbage"), sum: createHash("sha256").update("garbage").digest("hex") })],
      [
        "the archive holds a different top-level folder",
        () => {
          const parent = temp();
          writeRelease(path.join(parent, "something-else"), "1.1.0");
          const file = path.join(parent, `x.${target.extension}`);
          const pack = packCommand(target, file, parent, "something-else");
          spawnSync(pack.command, pack.args);
          const bytes = readFileSync(file);
          return network("1.1.0", { bytes, sum: createHash("sha256").update(bytes).digest("hex") });
        },
      ],
      ["the new version exits with an error", () => { const a = buildArchive("1.1.0", "crash"); return network("1.1.0", a); }],
      ["the new version reports the wrong number", () => { const a = buildArchive("1.1.0", "wrong"); return network("1.1.0", a); }],
      ["the new version never starts (timeout)", () => { const a = buildArchive("1.1.0", "hang"); return network("1.1.0", a); }, { startTimeoutMs: 400 }],
      ["the archive's marker describes another version", () => { const a = buildArchive("1.1.0", "ok", (folder) => writeFileSync(path.join(folder, RELEASE_MARKER), JSON.stringify(releaseMarker("1.2.0", target)))); return network("1.1.0", a); }],
    ];
    it.each(cases)("%s", async (_title, serve, overrides = {}) => {
      const w = world(["1.0.0"], "1.0.0", null, "1.0.0", serve());
      const before = snapshot(w.layout.app);
      await expect(updateRelease(w.options(overrides))).rejects.toMatchObject({ exitCode: 1 });
      expect(snapshot(w.layout.app)).toEqual(before);
      expect(readdirSync(w.layout.versions)).toEqual(["1.0.0"]);
      expect(text(w.layout.current)).toBe("1.0.0\n");
      expect(existsSync(w.layout.previous)).toBe(false);
    });
  });

  it("refuses a release missing the archive or the .sha256, before downloading anything", async () => {
    const archive = buildArchive("1.1.0");
    for (const assets of [["archive"], ["checksum"]] as const) {
      let downloads = 0;
      const serve = network("1.1.0", archive, { assets: [...assets] });
      const counted = Object.fromEntries(Object.entries(serve).map(([url, make]) => [url, () => { if (url !== LATEST_RELEASE_URL) downloads += 1; return make(); }]));
      const w = world(["1.0.0"], "1.0.0", null, "1.0.0", counted);
      const before = snapshot(w.layout.app);
      await expect(updateRelease(w.options())).rejects.toMatchObject({ exitCode: 1 });
      expect(downloads).toBe(0);
      expect(snapshot(w.layout.app)).toEqual(before);
    }
  });

  it("downloads only over https and sends no credential", async () => {
    const archive = buildArchive("1.1.0");
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const served = network("1.1.0", archive, { base: "http://example.test/download" });
    const w = world(["1.0.0"], "1.0.0", null, "1.0.0", {});
    const fetchSpy = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(url), init });
      return served[String(url)]?.() ?? new Response("", { status: 404 });
    }) as typeof fetch;
    const before = snapshot(w.layout.app);
    await expect(updateRelease(w.options({ fetch: fetchSpy }))).rejects.toMatchObject({ code: "SELF_UPDATE_BAD_URL" });
    expect(requests.map((request) => request.url)).toEqual([LATEST_RELEASE_URL]);
    expect(snapshot(w.layout.app)).toEqual(before);

    // Over https, a download carries no authorization header or cookies.
    const ok = world(["1.0.0"], "1.0.0", null, "1.0.0", {});
    const sent: RequestInit[] = [];
    const served2 = network("1.1.0", archive);
    const spy2 = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url) !== LATEST_RELEASE_URL) sent.push(init ?? {});
      return served2[String(url)]?.() ?? new Response("", { status: 404 });
    }) as typeof fetch;
    await updateRelease(ok.options({ fetch: spy2 }));
    expect(sent.length).toBe(2);
    for (const init of sent) {
      expect(JSON.stringify(init.headers ?? {}).toLowerCase()).not.toContain("authorization");
      expect(JSON.stringify(init.headers ?? {}).toLowerCase()).not.toContain("cookie");
      expect(init.credentials).toBe("omit");
    }
  });

  it("refuses a release version that is not a safe folder name before it becomes a path", async () => {
    const w = world(["1.0.0"], "1.0.0", null, "1.0.0", {});
    const check = { install: { version: "1.0.0", kind: "release", folder: w.running, target: { os: target.os, arch: target.arch } }, status: "available", reason: null, updatable: true, latest: { version: "../evil", tag: "v../evil", url: "https://x", notes: "", archive: { name: "a.tar.gz", url: "https://x/a", size: 1 }, checksum: { name: "a.sha256", url: "https://x/b", size: 1 } } } as const;
    const before = snapshot(w.store);
    await expect(updateRelease(w.options({ checkUpdate: async () => check }))).rejects.toMatchObject({ code: "SELF_UPDATE_BAD_VERSION" });
    expect(snapshot(w.store)).toEqual(before);
    expect(readdirSync(w.store)).toEqual(["app"]);
  });

  it("refuses a source checkout, and a release outside versions with a pointer to --install, before writing anything", async () => {
    const archive = buildArchive("1.1.0");
    const source = world(["1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
    mkdirSync(path.join(source.running, "src"));
    const before = snapshot(source.layout.app);
    await expect(updateRelease(source.options())).rejects.toMatchObject({ code: "SELF_UPDATE_SOURCE_INSTALL" });
    expect(snapshot(source.layout.app)).toEqual(before);

    const store = temp();
    const layout = appLayout({ MOXEN_STORE_ROOT: store } as NodeJS.ProcessEnv);
    const unpacked = path.join(temp(), "moxen-release");
    writeRelease(unpacked, "1.0.0");
    const err = await updateRelease({ from: unpacked, version: "1.0.0", platform, arch, layout, fetch: (async () => new Response("", { status: 500 })) as typeof fetch }).catch((error: unknown) => error);
    expect(err).toMatchObject({ code: "SELF_UPDATE_NOT_INSTALLED" });
    expect((err as Error).message).toContain("--install");
    expect(readdirSync(store)).toEqual([]);
  });

  describe("pruning", () => {
    it("keeps the new current, the previous and the version this process runs from, and deletes the rest", async () => {
      const archive = buildArchive("1.1.0");
      // Running 1.0.0 although current already names 1.0.5 (an update the server has not restarted for).
      const w = world(["0.8.0", "1.0.0", "1.0.4", "1.0.5"], "1.0.5", "1.0.4", "1.0.0", network("1.1.0", archive));
      const result = await updateRelease(w.options());
      expect(result).toMatchObject({ version: "1.1.0", previous: "1.0.5" });
      expect(readdirSync(w.layout.versions).sort()).toEqual(["1.0.0", "1.0.5", "1.1.0"]);
    });

    it("never asks to delete a protected version, and a folder that cannot be deleted is a warning, not a failed update", async () => {
      const archive = buildArchive("1.1.0");
      const w = world(["0.8.0", "1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
      const asked: string[] = [];
      const result = await updateRelease(
        w.options({
          removeFolder: async (folder) => {
            asked.push(path.basename(folder));
            throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
          },
        }),
      );
      expect(asked).toEqual(["0.8.0"]);
      expect(result.action).toBe("updated");
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("0.8.0");
      expect(text(w.layout.current)).toBe("1.1.0\n");
    });

    it("keeps the version a server still runs, however many updates behind it is", async () => {
      const archive = buildArchive("1.1.0");
      const w = world(["0.8.0", "0.9.0", "1.0.0"], "1.0.0", "0.9.0", "1.0.0", network("1.1.0", archive));
      await updateRelease(w.options({ runningVersions: async () => ["0.8.0"] }));
      expect(readdirSync(w.layout.versions).sort()).toEqual(["0.8.0", "1.0.0", "1.1.0"]);
    });

    it("deletes no old version when it can't tell what the server runs, and the update still succeeds", async () => {
      const archive = buildArchive("1.1.0");
      const w = world(["0.8.0", "1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
      const result = await updateRelease(w.options({ runningVersions: async () => { throw new Error("no answer"); } }));
      expect(result.action).toBe("updated");
      expect(result.warnings).toHaveLength(1);
      expect(readdirSync(w.layout.versions).sort()).toEqual(["0.8.0", "1.0.0", "1.1.0"]);
    });
  });

  describe("concurrency", () => {
    it("refuses while another update holds the lock, and changes nothing", async () => {
      const archive = buildArchive("1.1.0");
      const w = world(["1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
      writeFileSync(path.join(w.layout.app, "update.lock"), `${process.pid}\n`);
      const before = snapshot(w.layout.app);
      await expect(updateRelease(w.options())).rejects.toMatchObject({ code: "SELF_UPDATE_BUSY" });
      expect(snapshot(w.layout.app)).toEqual(before);
    });

    it("takes over a lock left by a process that is gone", async () => {
      const archive = buildArchive("1.1.0");
      const w = world(["1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
      const gone = spawnSync(process.execPath, ["--eval", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      writeFileSync(path.join(w.layout.app, "update.lock"), `${gone.stdout.trim()}\n`);
      expect((await updateRelease(w.options())).action).toBe("updated");
    });

    it("two updates at once leave one consistent result", async () => {
      const archive = buildArchive("1.1.0");
      const w = world(["1.0.0"], "1.0.0", null, "1.0.0", network("1.1.0", archive));
      const settled = await Promise.allSettled([updateRelease(w.options()), updateRelease(w.options())]);
      expect(settled.some((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(text(w.layout.current)).toBe("1.1.0\n");
      expect(text(w.layout.previous)).toBe("1.0.0\n");
      expect(readdirSync(w.layout.versions).sort()).toEqual(["1.0.0", "1.1.0"]);
    });
  });
});

describe("rollbackRelease", () => {
  const noNetwork = {};

  it("exits non-zero and changes nothing with no recorded previous version", async () => {
    const w = world(["1.0.0"], "1.0.0", null, "1.0.0", noNetwork);
    const before = snapshot(w.layout.app);
    await expect(rollbackRelease(w.options())).rejects.toMatchObject({ code: "SELF_UPDATE_NO_PREVIOUS", exitCode: 1 });
    expect(snapshot(w.layout.app)).toEqual(before);
  });

  it("exits non-zero and changes nothing when the previous version's folder is gone", async () => {
    const w = world(["1.1.0"], "1.1.0", "1.0.0", "1.1.0", noNetwork);
    const before = snapshot(w.layout.app);
    await expect(rollbackRelease(w.options())).rejects.toMatchObject({ code: "SELF_UPDATE_NO_PREVIOUS", exitCode: 1 });
    expect(snapshot(w.layout.app)).toEqual(before);
  });

  it("changes nothing when the previous version no longer starts", async () => {
    const w = world(["1.0.0", "1.1.0"], "1.1.0", "1.0.0", "1.1.0", noNetwork);
    writeFileSync(path.join(w.layout.versions, "1.0.0", "dist", "cli", "index.js"), entry("1.0.0", "crash"));
    const before = snapshot(w.layout.app);
    await expect(rollbackRelease(w.options())).rejects.toMatchObject({ code: "SELF_UPDATE_START_FAILED" });
    expect(snapshot(w.layout.app)).toEqual(before);
  });

  it("goes back, and keeps the version it left as the new previous, so it can go forward again", async () => {
    const w = world(["1.0.0", "1.1.0"], "1.1.0", "1.0.0", "1.1.0", noNetwork);
    const back = await rollbackRelease(w.options());
    expect(back).toMatchObject({ action: "rolled-back", version: "1.0.0", from: "1.1.0", previous: "1.1.0" });
    expect(text(w.layout.current)).toBe("1.0.0\n");
    expect(text(w.layout.previous)).toBe("1.1.0\n");
    expect(readdirSync(w.layout.versions).sort()).toEqual(["1.0.0", "1.1.0"]);
    await rollbackRelease(w.options());
    expect(text(w.layout.current)).toBe("1.1.0\n");
    expect(text(w.layout.previous)).toBe("1.0.0\n");
  });

  it("is refused from a source checkout or a release outside versions, before anything is written", async () => {
    const store = temp();
    const layout = appLayout({ MOXEN_STORE_ROOT: store } as NodeJS.ProcessEnv);
    const unpacked = path.join(temp(), "moxen-release");
    writeRelease(unpacked, "1.0.0");
    await expect(rollbackRelease({ from: unpacked, version: "1.0.0", platform, arch, layout })).rejects.toMatchObject({ code: "SELF_UPDATE_NOT_INSTALLED" });
    mkdirSync(path.join(unpacked, "src"));
    await expect(rollbackRelease({ from: unpacked, version: "1.0.0", platform, arch, layout })).rejects.toMatchObject({ code: "SELF_UPDATE_SOURCE_INSTALL" });
    expect(readdirSync(store)).toEqual([]);
  });
});

describe("archive rules", () => {
  it("flags entries that are absolute, climb out, or sit outside the one top-level folder", () => {
    const base = "moxen-1.0.0-macos-arm64";
    expect(unsafeEntries([`${base}/`, `${base}/dist/cli/index.js`, `./${base}/package.json`, `${base}\\dist\\x.js`], base)).toEqual([]);
    expect(unsafeEntries(["/etc/passwd", `${base}/../evil`, "../evil", "other/file", "C:\\Windows\\x", `${base}\\..\\evil`], base)).toHaveLength(6);
  });

  it("flags a link that points out of the unpacked tree", async () => {
    const root = temp();
    mkdirSync(path.join(root, "inner"));
    writeFileSync(path.join(root, "inner", "file"), "x");
    expect(await escapingEntries(root)).toEqual([]);
    if (process.platform === "win32") return; // creating a symlink needs a privilege Windows runners may lack
    symlinkSync("inner/file", path.join(root, "ok"));
    symlinkSync(path.join(os.tmpdir()), path.join(root, "out"));
    symlinkSync("../../escape", path.join(root, "inner", "up"));
    expect((await escapingEntries(root)).map((entryPath) => path.relative(root, entryPath)).sort()).toEqual([path.join("inner", "up"), "out"]);
  });

  it.each([
    ["a bare hash", `${"a".repeat(64)}\n`, "a".repeat(64)],
    ["sha256sum format", `${"A".repeat(64)}  f.tar.gz\n`, "a".repeat(64)],
    ["binary marker", `${"a".repeat(64)} *f.tar.gz`, "a".repeat(64)],
    ["too short", "abc  f.tar.gz", null],
    ["another file", `${"a".repeat(64)}  g.tar.gz`, null],
    ["not hex", `${"z".repeat(64)}  f.tar.gz`, null],
    ["empty", "", null],
  ])("reads a checksum file: %s", (_title, body, expected) => {
    expect(parseChecksum(body, "f.tar.gz")).toBe(expected);
  });
});
