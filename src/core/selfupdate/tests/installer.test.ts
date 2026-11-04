import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_MARKER, releaseMarker, releaseTarget } from "../../release.js";
import { appLayout, installRelease, launcherScripts, pathHint, type AppLayout } from "../installer.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moxen-installer test-"));
  roots.push(root);
  return root;
};

const target = releaseTarget(process.platform === "win32" ? "win32" : "darwin", process.platform === "win32" ? "x64" : "arm64");
const platform = process.platform === "win32" ? "win32" : "darwin";
const arch = process.platform === "win32" ? "x64" : "arm64";
const INDEX = `process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.EXIT_WITH ?? 0));`;

/** An unpacked release folder, like the archive's: package.json, the marker, and a stand-in entry point. */
function release(version = "1.2.3", extra: Record<string, string> = {}): { folder: string; options: { from: string; version: string; platform: string; arch: string } } {
  const folder = path.join(temp(), "moxen-release");
  mkdirSync(path.join(folder, "dist", "cli"), { recursive: true });
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(folder, RELEASE_MARKER), JSON.stringify(releaseMarker(version, target)));
  writeFileSync(path.join(folder, "dist", "cli", "index.js"), INDEX);
  for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(folder, name), text);
  return { folder, options: { from: folder, version, platform, arch } };
}

const layoutIn = (root: string): AppLayout => appLayout({ MOXEN_STORE_ROOT: root } as NodeJS.ProcessEnv);

describe("installRelease", () => {
  it("refuses a source checkout before writing anything", async () => {
    const { folder, options } = release();
    mkdirSync(path.join(folder, "src"));
    const store = temp();
    await expect(installRelease({ ...options, layout: layoutIn(store) })).rejects.toMatchObject({ code: "SELF_UPDATE_SOURCE_INSTALL" });
    expect(readdirSync(store)).toEqual([]);
  });

  it("puts the release under versions, sets current and writes the launcher; a repeat changes nothing", async () => {
    const { options } = release("1.2.3");
    const store = temp();
    const layout = layoutIn(store);
    const first = await installRelease({ ...options, layout });
    expect(first.alreadyInstalled).toBe(false);
    expect(first.folder).toBe(path.join(layout.versions, "1.2.3"));
    expect(readFileSync(path.join(first.folder, "dist", "cli", "index.js"), "utf8")).toBe(INDEX);
    expect(readFileSync(layout.current, "utf8")).toBe("1.2.3\n");
    expect(readdirSync(layout.bin)).toEqual([process.platform === "win32" ? "moxen.cmd" : "moxen"]);

    const snapshot = (): string[] => [layout.current, first.launcher].map((file) => `${file}:${readFileSync(file, "utf8")}`);
    const before = snapshot();
    writeFileSync(path.join(first.folder, "marker.txt"), "edited in place");
    const second = await installRelease({ ...options, layout });
    expect(second.alreadyInstalled).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(path.join(first.folder, "marker.txt"), "utf8")).toBe("edited in place");
    expect(readdirSync(layout.versions)).toEqual(["1.2.3"]);
  });

  it("does not count an interrupted copy as installed, and clears it", async () => {
    const { options } = release("1.2.3");
    const layout = layoutIn(temp());
    const leftover = path.join(layout.versions, ".tmp-1.2.3-999-1");
    mkdirSync(path.join(leftover, "dist"), { recursive: true });
    const result = await installRelease({ ...options, layout });
    expect(result.alreadyInstalled).toBe(false);
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(layout.versions)).toEqual(["1.2.3"]);
  });

  it("leaves current complete at every moment while it is replaced", async () => {
    const { options } = release("1.2.3");
    const layout = layoutIn(temp());
    mkdirSync(layout.app, { recursive: true });
    writeFileSync(layout.current, "0.9.0\n");
    const seen = new Set<string>();
    const watcher = setInterval(() => { try { seen.add(readFileSync(layout.current, "utf8")); } catch { /* mid-rename on Windows */ } }, 0);
    await installRelease({ ...options, layout });
    clearInterval(watcher);
    seen.add(readFileSync(layout.current, "utf8"));
    expect([...seen].every((text) => text === "0.9.0\n" || text === "1.2.3\n")).toBe(true);
    expect(readdirSync(layout.app).filter((name) => name.startsWith("current."))).toEqual([]);
  });

  it("from a version already inside versions, only sets current and rewrites the launcher", async () => {
    const { options } = release("1.2.3");
    const layout = layoutIn(temp());
    await installRelease({ ...options, layout });
    writeFileSync(layout.current, "0.9.0\n");
    const inside = path.join(layout.versions, "1.2.3");
    const result = await installRelease({ ...options, from: inside, layout });
    expect(result.alreadyInstalled).toBe(true);
    expect(readFileSync(layout.current, "utf8")).toBe("1.2.3\n");
    expect(readdirSync(layout.versions)).toEqual(["1.2.3"]);
  });

  it("puts the app folder under MOXEN_STORE_ROOT", () => {
    const root = temp();
    expect(appLayout({ MOXEN_STORE_ROOT: root } as NodeJS.ProcessEnv).app).toBe(path.join(path.resolve(root), "app"));
  });
});

describe("launcherScripts", () => {
  const { posix, windows } = launcherScripts();

  it("quotes every path and passes the arguments through", () => {
    expect(posix).toContain('exec bun "$entry" "$@"');
    expect(windows).toContain('bun "%APP%\\versions\\%VERSION%\\dist\\cli\\index.js" %*');
    expect(windows).toContain("exit /b %ERRORLEVEL%");
    expect(windows.split("\r\n").length).toBeGreaterThan(5);
    expect(windows.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("names a platform's way onto PATH", () => {
    expect(pathHint("macos", "/a b/bin")).toContain('export PATH="/a b/bin:$PATH"');
    expect(pathHint("windows", "C:\\a b\\bin")).toContain("SetEnvironmentVariable");
  });

  it.skipIf(process.platform === "win32")("sh launcher hands spaces and quotes to the program unchanged and returns its exit code", async () => {
    const { options } = release("1.2.3");
    const layout = layoutIn(temp());
    const { launcher } = await installRelease({ ...options, layout });
    // `bun` is whatever runs this test's JavaScript; the launcher only needs one on PATH.
    const shims = temp();
    writeFileSync(path.join(shims, "bun"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${shims}${path.delimiter}${process.env.PATH ?? ""}` };
    const args = ["--flag", "a b", `it's "quoted"`, "", "$HOME `x` \\n *"];
    const ran = spawnSync("sh", [launcher, ...args], { encoding: "utf8", env: { ...env, EXIT_WITH: "7" } });
    expect(JSON.parse(ran.stdout)).toEqual(args);
    expect(ran.status).toBe(7);

    writeFileSync(layout.current, "9.9.9\n");
    const missing = spawnSync("sh", [launcher, "--version"], { encoding: "utf8", env });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr.trim().split("\n")).toHaveLength(1);
    rmSync(layout.current);
    const none = spawnSync("sh", [launcher], { encoding: "utf8", env });
    expect(none.status).not.toBe(0);
    expect(none.stderr.trim().split("\n")).toHaveLength(1);
  });
});
