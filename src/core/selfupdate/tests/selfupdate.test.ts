import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveFileName, checksumFileName, RELEASE_MARKER, releaseMarker, releaseTarget } from "../../release.js";
import { checkForUpdate, compareVersions, type CheckOptions } from "../check.js";
import { readInstall } from "../install.js";
import type { InstallInfo } from "../vocabulary.js";
import real from "./github-latest-release.json" with { type: "json" };

/**
 * `github-latest-release.json` is a real answer of GET /repos/cli/cli/releases/latest (v2.103.3, fetched
 * 2026-11-04) with the author, reactions and most assets cut. The helper below keeps every field of a real
 * asset and changes only the names and URLs, so the shape under test is GitHub's, not one written by hand.
 */
const mac = releaseTarget("darwin", "arm64");
const win = releaseTarget("win32", "x64");

function releaseAnswer(version: string, names: string[], overrides: Record<string, unknown> = {}) {
  const template = real.assets.find((asset) => asset.name.endsWith(".zip"))!;
  return {
    ...real,
    tag_name: `v${version}`,
    html_url: `https://github.com/usemoxen/moxen/releases/tag/v${version}`,
    body: "## What's Changed\r\n* something",
    assets: names.map((name) => ({ ...template, name, browser_download_url: `https://github.com/usemoxen/moxen/releases/download/v${version}/${name}` })),
    ...overrides,
  };
}

const bothAssets = (version: string) => [archiveFileName(version, mac), checksumFileName(version, mac), archiveFileName(version, win), checksumFileName(version, win)];
const answer = (body: unknown, init: ResponseInit = { status: 200 }): typeof fetch => (async () => new Response(JSON.stringify(body), init)) as unknown as typeof fetch;
const install = (overrides: Partial<InstallInfo> = {}): InstallInfo => ({ version: "0.1.2", kind: "release", folder: "/x", target: { os: "macos", arch: "arm64" }, ...overrides });
const check = (fetchImpl: typeof fetch, info = install(), extra: Partial<CheckOptions> = {}) => checkForUpdate({ install: info, fetch: fetchImpl, ...extra });

describe("the fixture is GitHub's real shape", () => {
  it("has the fields the check reads", () => {
    expect(real).toMatchObject({ tag_name: expect.any(String), html_url: expect.any(String), draft: false, prerelease: false, body: expect.any(String) });
    expect(real.assets[0]).toMatchObject({ name: expect.any(String), browser_download_url: expect.any(String), size: expect.any(Number), state: "uploaded" });
  });
});

describe("version order", () => {
  it.each([
    ["0.10.0", "0.9.0", 1],
    ["0.9.0", "0.10.0", -1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["v1.2.3", "1.2.3", 0],
  ])("%s against %s", (a, b, expected) => expect(compareVersions(a, b)).toBe(expected));
  it("is null for a string that is not a version", () => expect(compareVersions("dev", "1.0.0")).toBeNull());
});

describe("checkForUpdate", () => {
  it("offers a newer release with this platform's archive and checksum", async () => {
    const result = await check(answer(releaseAnswer("0.2.0", bothAssets("0.2.0"))));
    expect(result).toMatchObject({ status: "available", reason: null, updatable: true });
    expect(result.latest).toMatchObject({
      version: "0.2.0",
      tag: "v0.2.0",
      url: "https://github.com/usemoxen/moxen/releases/tag/v0.2.0",
      archive: { name: "moxen-0.2.0-macos-arm64.tar.gz", url: expect.stringContaining("/moxen-0.2.0-macos-arm64.tar.gz") },
      checksum: { name: "moxen-0.2.0-macos-arm64.tar.gz.sha256" },
    });
    expect(result.latest?.notes).toContain("What's Changed");
  });

  it("compares 0.10.0 as newer than 0.9.0, and a version ahead of the latest as up to date", async () => {
    expect((await check(answer(releaseAnswer("0.10.0", bothAssets("0.10.0"))), install({ version: "0.9.0" }))).status).toBe("available");
    expect((await check(answer(releaseAnswer("0.9.0", bothAssets("0.9.0"))), install({ version: "0.10.0" }))).status).toBe("up-to-date");
    expect((await check(answer(releaseAnswer("0.1.2", bothAssets("0.1.2"))))).status).toBe("up-to-date");
  });

  it("never marks a source install updatable, even with a release available", async () => {
    const result = await check(answer(releaseAnswer("0.2.0", bothAssets("0.2.0"))), install({ kind: "source" }));
    expect(result).toMatchObject({ status: "available", updatable: false });
  });

  it("is not available when the release has no asset for this platform", async () => {
    const onlyWindows = [archiveFileName("0.2.0", win), checksumFileName("0.2.0", win)];
    const result = await check(answer(releaseAnswer("0.2.0", onlyWindows)));
    expect(result).toMatchObject({ status: "unavailable", updatable: false, latest: { version: "0.2.0", archive: null } });
    expect(result.reason).toContain("moxen-0.2.0-macos-arm64.tar.gz");
    const noChecksum = await check(answer(releaseAnswer("0.2.0", [archiveFileName("0.2.0", mac)])));
    expect(noChecksum).toMatchObject({ status: "unavailable", updatable: false });
  });

  it("does not offer a prerelease or a draft", async () => {
    expect((await check(answer(releaseAnswer("0.3.0-rc.1", bothAssets("0.3.0-rc.1"))))).status).toBe("no-release");
    expect((await check(answer(releaseAnswer("0.3.0", bothAssets("0.3.0"), { prerelease: true })))).status).toBe("no-release");
    expect((await check(answer(releaseAnswer("0.3.0", bothAssets("0.3.0"), { draft: true })))).status).toBe("no-release");
  });

  it("calls GitHub's 404 for a repository with no release 'no-release', not an error", async () => {
    // The body is the real one GitHub sent for usemoxen/moxen on 2026-11-04.
    const body = { message: "Not Found", documentation_url: "https://docs.github.com/rest/releases/releases#get-the-latest-release", status: "404" };
    expect(await check(answer(body, { status: 404 }))).toMatchObject({ status: "no-release", reason: null, latest: null, updatable: false });
  });

  it("fails quietly: offline, a timeout, a rate limit, a server error, a bad answer", async () => {
    const offline = (async () => { throw new TypeError("fetch failed", { cause: new Error("ENOTFOUND api.github.com") }); }) as unknown as typeof fetch;
    const offlineResult = await check(offline);
    expect(offlineResult).toMatchObject({ status: "unavailable", reason: "could not reach GitHub", latest: null, updatable: false });
    expect(JSON.stringify(offlineResult)).not.toMatch(/ENOTFOUND|at .*\.ts/);

    const slow = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    expect((await check(slow, install(), { timeoutMs: 20 })).reason).toBe("GitHub did not answer in time");

    const limited = (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
    expect((await check(limited)).reason).toMatch(/rate limit/);
    expect((await check(answer({}, { status: 500 }))).reason).toBe("GitHub answered 500");
    expect((await check((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).reason).toMatch(/not JSON/);
    expect((await check(answer({ tag_name: "nightly", assets: [] }))).reason).toMatch(/cannot read/);
  });

  it("sends no credential", async () => {
    let seen: RequestInit | undefined;
    await check((async (_url: unknown, init: RequestInit) => { seen = init; return new Response("{}", { status: 404 }); }) as unknown as typeof fetch);
    const names = Object.keys(seen!.headers as Record<string, string>).map((name) => name.toLowerCase());
    expect(names).not.toContain("authorization");
    expect(seen!.signal).toBeDefined();
  });
});

describe("readInstall", () => {
  const folders: string[] = [];
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
  const folder = (files: Record<string, string>, dirs: string[] = []) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moxen-install-"));
    folders.push(root);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.2" }));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
    for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
    mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    return root;
  };
  const read = (root: string) => readInstall({ from: path.join(root, "dist", "server"), version: "0.1.2", platform: "darwin", arch: "arm64" });
  const marker = JSON.stringify(releaseMarker("0.1.2", mac));

  it("is a release only when the packaging's marker is there and matches", () => {
    expect(read(folder({ [RELEASE_MARKER]: marker }))).toMatchObject({ kind: "release", version: "0.1.2", target: { os: "macos", arch: "arm64" } });
  });

  it("is source without a marker, so a checkout, a worktree or a plain copy never looks updatable", () => {
    expect(read(folder({}, ["src"])).kind).toBe("source");
    expect(read(folder({ ".git": "gitdir: /elsewhere" }, ["src"])).kind).toBe("source");
    expect(read(folder({})).kind).toBe("source");
  });

  it("is source when the marker is wrong, or sits in a checkout", () => {
    expect(read(folder({ [RELEASE_MARKER]: "{not json" })).kind).toBe("source");
    expect(read(folder({ [RELEASE_MARKER]: JSON.stringify(releaseMarker("0.0.9", mac)) })).kind).toBe("source");
    expect(read(folder({ [RELEASE_MARKER]: JSON.stringify(releaseMarker("0.1.2", win)) })).kind).toBe("source");
    expect(read(folder({ [RELEASE_MARKER]: marker }, ["src"])).kind).toBe("source");
    expect(read(folder({ [RELEASE_MARKER]: marker, ".git": "gitdir: x" })).kind).toBe("source");
  });

  it("is source when run from this checkout's own src", () => {
    expect(readInstall().kind).toBe("source");
  });

  it("is the executable's folder when standalone, source without a package.json beside it", () => {
    const exe = mkdtempSync(path.join(os.tmpdir(), "moxen-install-exe-"));
    folders.push(exe);
    const install = () => readInstall({ from: "/$bunfs/root/x", version: "0.1.2", platform: "darwin", arch: "arm64", execDir: exe, standalone: true });
    expect(install().kind).toBe("source");
    writeFileSync(path.join(exe, "package.json"), JSON.stringify({ version: "0.1.2" }));
    expect(install().kind).toBe("source");
    writeFileSync(path.join(exe, RELEASE_MARKER), marker);
    expect(install()).toMatchObject({ kind: "release", folder: exe, target: { os: "macos", arch: "arm64" } });
    // Without the standalone flag the executable's folder is ignored and `from` is walked as always.
    expect(readInstall({ from: exe, version: "0.1.2", platform: "darwin", arch: "arm64", execDir: "/nope", standalone: false })).toMatchObject({ kind: "release", folder: exe });
  });
});
