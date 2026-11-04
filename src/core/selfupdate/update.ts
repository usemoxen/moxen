/**
 * Downloads, tests and switches to a new release, and goes back to the one before it:
 *
 *   <app>/versions/<version>/   every kept release
 *   <app>/current               the active version (what the launcher runs)
 *   <app>/previous              the version `current` replaced, which `--rollback` returns to
 *   <app>/update.lock           held while an update or rollback runs
 *
 * An update never leaves a person without a working Moxen: the archive is downloaded, checked against its
 * `.sha256`, unpacked into a temp folder inside `versions/`, and started with `--version` before the folder
 * takes its name and `current` changes. Any failure before that removes the temp folder and changes nothing.
 *
 * This acts on this machine's own files. It runs in the server (`app.update.apply`, `app.update.rollback`), and the
 * transport refuses both commands to a remote client, so a paired client can never reach it. Nothing here restarts
 * anything: running threads keep their version.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, readlink, lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { CliError } from "../errors.js";
import { renameReplacing, writeAtomic } from "../infra/atomic.js";
import { RELEASE_MARKER, listCommand, releaseBaseName, releaseMarker, releaseTargetOf, unpackCommand, type ReleaseTarget } from "../release.js";
import { checkForUpdate } from "./check.js";
import { readInstall, type ReadInstallOptions } from "./install.js";
import { appLayout, isInstalledFolder, SAFE_VERSION, TEMP_PREFIX, type AppLayout } from "./installer.js";
import type { InstallInfo, ReleaseAsset, RollbackResult, UpdateCheck, UpdateProgress, UpdateResult } from "./vocabulary.js";

export type { RollbackResult, UpdateAction, UpdateProgress, UpdateResult, UpdateStage } from "./vocabulary.js";

const execFileAsync = promisify(execFile);

export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const START_TIMEOUT_MS = 60_000;
const UNPACK_TIMEOUT_MS = 5 * 60_000;
/** A release archive is tens of megabytes; this only stops a download that never ends. */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
/** A download reports at most once per this many bytes. */
const PROGRESS_STEP_BYTES = 512 * 1024;
const ENTRY = ["dist", "cli", "index.js"];

export interface UpdateOptions extends ReadInstallOptions {
  readonly layout?: AppLayout;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected in tests; used for the check and the downloads. */
  readonly fetch?: typeof fetch;
  /** Replaces the GitHub check (tests). */
  readonly checkUpdate?: (install: InstallInfo) => Promise<UpdateCheck>;
  /** The runtime that starts the new version; the running one by default. */
  readonly execPath?: string;
  readonly downloadTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  /** More versions to keep besides the one running this code (the server's own, which is what this runs in). Null when that can't be told, which keeps every old version. */
  readonly runningVersions?: () => Promise<readonly string[] | null>;
  /** Deletes an old version folder (tests make it fail, as a folder in use does on Windows). */
  readonly removeFolder?: (folder: string) => Promise<void>;
  /** Told where the update is, stage by stage. A throw here never fails the update. */
  readonly onProgress?: (progress: UpdateProgress) => void;
}

/** Calls `onProgress`, which must never be able to fail the update. */
function reporter(options: UpdateOptions): (progress: UpdateProgress) => void {
  return (progress) => {
    try {
      options.onProgress?.(progress);
    } catch {
      // A broken listener is not the update's problem.
    }
  };
}

const fail = (code: string, message: string, cause?: unknown): CliError => new CliError(code, message, { exitCode: 1, ...(cause === undefined ? {} : { cause }) });

const removeFully = (folder: string): Promise<void> => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

function readVersionFile(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return SAFE_VERSION.test(text) ? text : null;
  } catch {
    return null;
  }
}

const entryOf = (folder: string): string => path.join(folder, ...ENTRY);

/** Only a release install running from inside `versions/` may be updated or rolled back; both are refused before anything is written. */
function requireInstalledRelease(install: InstallInfo, layout: AppLayout): void {
  if (install.kind !== "release" || install.folder === null || install.target === null) {
    throw fail("SELF_UPDATE_SOURCE_INSTALL", "This Moxen is a source checkout, which moxen never installs or updates. Update it with git and a rebuild.");
  }
  if (!isInstalledFolder(install.folder, layout)) {
    throw fail("SELF_UPDATE_NOT_INSTALLED", "This release is not installed under Moxen's app folder yet. Run moxen self-update --install first, then use the installed moxen.");
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One update or rollback at a time per app folder. A lock left by a process that died is taken over. */
async function withLock<T>(layout: AppLayout, work: () => Promise<T>): Promise<T> {
  await mkdir(layout.app, { recursive: true });
  const file = path.join(layout.app, "update.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        throw fail("SELF_UPDATE_BUSY", "Another moxen self-update is running. Wait for it to finish, then try again.");
      }
      await rm(file, { force: true });
    }
  }
  if (!acquired) throw fail("SELF_UPDATE_BUSY", "Another moxen self-update is running. Wait for it to finish, then try again.");
  try {
    return await work();
  } finally {
    await rm(file, { force: true });
  }
}

/** The entries of a listed archive that are absolute, climb out with `..`, or sit outside the one top-level folder. */
export function unsafeEntries(names: readonly string[], base: string): string[] {
  const bad: string[] = [];
  for (const name of names) {
    const normal = name.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
    if (normal === "" || normal === ".") continue;
    const parts = normal.split("/").filter((part) => part !== "");
    if (normal.startsWith("/") || /^[A-Za-z]:/.test(normal) || parts.includes("..") || parts[0] !== base) bad.push(name);
  }
  return bad;
}

/** What an unpacked tree holds that could land outside it: a link pointing out, or anything that is not a file, folder or link. */
export async function escapingEntries(root: string): Promise<string[]> {
  const bad: string[] = [];
  const inside = (target: string): boolean => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const walk = async (folder: string): Promise<void> => {
    for (const name of await readdir(folder)) {
      const full = path.join(folder, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        const link = await readlink(full);
        if (!inside(path.resolve(folder, link))) bad.push(full);
      } else if (stat.isDirectory()) await walk(full);
      else if (!stat.isFile()) bad.push(full);
    }
  };
  await walk(root);
  return bad;
}

function httpsUrl(asset: ReleaseAsset): string {
  let url: URL;
  try {
    url = new URL(asset.url);
  } catch {
    throw fail("SELF_UPDATE_BAD_URL", `The release's ${asset.name} has an address that is not a URL.`);
  }
  if (url.protocol !== "https:") throw fail("SELF_UPDATE_BAD_URL", `The release's ${asset.name} is not served over https, so it was not downloaded.`);
  return url.href;
}

async function request(doFetch: typeof fetch, asset: ReleaseAsset, timeoutMs: number): Promise<Response> {
  const url = httpsUrl(asset);
  let response: Response;
  try {
    // No credential and no cookies: this is a public release asset.
    response = await doFetch(url, { headers: { "User-Agent": "moxen-self-update" }, redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw fail("SELF_UPDATE_DOWNLOAD_FAILED", timedOut ? `Downloading ${asset.name} timed out.` : `Could not download ${asset.name}.`, cause);
  }
  if (!response.ok) throw fail("SELF_UPDATE_DOWNLOAD_FAILED", `Downloading ${asset.name} failed: the server answered ${response.status}.`);
  // A redirect must not have left https behind.
  if (response.url !== "" && !response.url.startsWith("https://")) throw fail("SELF_UPDATE_BAD_URL", `Downloading ${asset.name} was redirected away from https.`);
  return response;
}

/** The SHA-256 a `.sha256` file states: `<hex>` or `<hex>  <file name>`. Null when it is anything else. */
export function parseChecksum(text: string, archiveName: string): string | null {
  const match = /^([0-9a-fA-F]{64})(?:[ \t]+\*?(.+?))?[ \t]*$/.exec(text.split(/\r?\n/, 1)[0] ?? "");
  if (match === null) return null;
  if (match[2] !== undefined && match[2] !== archiveName) return null;
  return match[1]!.toLowerCase();
}

async function readChecksum(doFetch: typeof fetch, asset: ReleaseAsset, archiveName: string, timeoutMs: number): Promise<string> {
  const response = await request(doFetch, asset, timeoutMs);
  let text: string;
  try {
    text = (await response.text()).slice(0, MAX_CHECKSUM_BYTES);
  } catch (cause) {
    throw fail("SELF_UPDATE_DOWNLOAD_FAILED", `Downloading ${asset.name} failed.`, cause);
  }
  const sum = parseChecksum(text, archiveName);
  if (sum === null) throw fail("SELF_UPDATE_BAD_CHECKSUM", `${asset.name} does not hold a SHA-256 for ${archiveName}.`);
  return sum;
}

/** Streams the archive to `file`, hashing as it goes. */
async function downloadArchive(doFetch: typeof fetch, asset: ReleaseAsset, file: string, timeoutMs: number, report: (progress: UpdateProgress) => void, version: string): Promise<string> {
  const response = await request(doFetch, asset, timeoutMs);
  if (response.body === null) throw fail("SELF_UPDATE_DOWNLOAD_FAILED", `${asset.name} arrived empty.`);
  const hash = createHash("sha256");
  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : asset.size;
  let bytes = 0;
  let reported = 0;
  report({ stage: "downloading", version, bytes: 0, total });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) return done(new Error("the archive is larger than any Moxen release"));
      hash.update(chunk);
      // By bytes, not by time: a report per chunk would flood a client, and a timer would make this depend on the clock.
      if (bytes - reported >= PROGRESS_STEP_BYTES) {
        reported = bytes;
        report({ stage: "downloading", version, bytes, total });
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(file), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw fail("SELF_UPDATE_DOWNLOAD_FAILED", `Downloading ${asset.name} failed.`, cause);
  }
  report({ stage: "downloading", version, bytes, total: bytes });
  return hash.digest("hex");
}

async function runTool(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: UNPACK_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

/** Lists, checks and unpacks the archive into `destination`, and returns the release folder inside it. */
async function unpackArchive(target: ReleaseTarget, archive: string, destination: string, version: string): Promise<string> {
  const base = releaseBaseName(version, target);
  try {
    const list = listCommand(target, archive);
    const names = (await runTool(list.command, list.args, path.dirname(archive))).split(/\r?\n/).filter((name) => name !== "");
    if (names.length === 0) throw fail("SELF_UPDATE_BAD_ARCHIVE", "The archive is empty.");
    const bad = unsafeEntries(names, base);
    if (bad.length > 0) throw fail("SELF_UPDATE_BAD_ARCHIVE", `The archive holds ${bad.length} entr${bad.length === 1 ? "y" : "ies"} outside its ${base} folder (first: ${bad[0]}), so it was not unpacked.`);
    await mkdir(destination, { recursive: true });
    const unpack = unpackCommand(target, archive, destination);
    await runTool(unpack.command, unpack.args, path.dirname(archive));
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    throw fail("SELF_UPDATE_BAD_ARCHIVE", "The archive could not be unpacked.", cause);
  }
  const top = await readdir(destination);
  if (top.length !== 1 || top[0] !== base) throw fail("SELF_UPDATE_BAD_ARCHIVE", `The archive must hold one folder named ${base}.`);
  const folder = path.join(destination, base);
  const escaping = await escapingEntries(folder);
  if (escaping.length > 0) throw fail("SELF_UPDATE_BAD_ARCHIVE", "The archive holds a link or special file that points outside it.");
  for (const required of [ENTRY, ["package.json"], [RELEASE_MARKER]]) {
    if (!existsSync(path.join(folder, ...required))) throw fail("SELF_UPDATE_BAD_ARCHIVE", `The archive has no ${required.join("/")}.`);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(path.join(folder, RELEASE_MARKER), "utf8"));
  } catch {
    marker = null;
  }
  if (JSON.stringify(marker) !== JSON.stringify(releaseMarker(version, target))) throw fail("SELF_UPDATE_BAD_ARCHIVE", `The archive's ${RELEASE_MARKER} does not describe ${version} for this platform.`);
  return folder;
}

/** Starts the release with `--version` and checks that it reports `version`, within a timeout. */
async function startTest(folder: string, version: string, options: UpdateOptions, scratch: string): Promise<void> {
  const probe = path.join(scratch, "probe");
  const env: NodeJS.ProcessEnv = { ...process.env, MOXEN_STORE_ROOT: probe, MOXEN_CONFIG: path.join(probe, "config.json") };
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(options.execPath ?? process.execPath, [entryOf(folder), "--version"], {
      cwd: folder,
      env,
      timeout: options.startTimeoutMs ?? START_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }));
  } catch (cause) {
    throw fail("SELF_UPDATE_START_FAILED", `Moxen ${version} did not start, so nothing was changed.`, cause);
  }
  const reported = stdout.trim();
  if (reported !== version) throw fail("SELF_UPDATE_WRONG_VERSION", `The new release reports ${JSON.stringify(reported.slice(0, 40))} instead of ${version}, so nothing was changed.`);
}

async function clearStaleTemps(layout: AppLayout): Promise<void> {
  for (const entry of await readdir(layout.versions).catch(() => [] as string[])) {
    if (entry.startsWith(TEMP_PREFIX)) await removeFully(path.join(layout.versions, entry));
  }
}

/** Deletes every version folder except those kept. A folder that cannot be deleted is a warning, never a failure. */
async function prune(layout: AppLayout, keep: ReadonlySet<string>, remove: (folder: string) => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of await readdir(layout.versions, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !SAFE_VERSION.test(entry.name) || keep.has(entry.name)) continue;
    try {
      await remove(path.join(layout.versions, entry.name));
    } catch (error) {
      warnings.push(`Could not delete old version ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}

/** Records `version` as the one to roll back to, or clears the record when there is none worth keeping. */
async function recordPrevious(layout: AppLayout, version: string | null): Promise<void> {
  if (version === null) await rm(layout.previous, { force: true });
  else await writeAtomic(layout.previous, `${version}\n`);
}

function usable(layout: AppLayout, version: string | null): version is string {
  return version !== null && existsSync(entryOf(path.join(layout.versions, version)));
}

export async function updateRelease(options: UpdateOptions = {}): Promise<UpdateResult> {
  // Before any write or any network: only a release running from versions/ is updated.
  const install = readInstall(options);
  const layout = options.layout ?? appLayout(options.env);
  requireInstalledRelease(install, layout);
  const target = releaseTargetOf(install.target!.os, install.target!.arch);
  const doFetch = options.fetch ?? fetch;
  const report = reporter(options);

  report({ stage: "checking" });
  const check = await (options.checkUpdate ?? ((info) => checkForUpdate(options.fetch === undefined ? { install: info } : { install: info, fetch: options.fetch })))(install);
  const alreadyCurrent = (version: string): UpdateResult => {
    const current = readVersionFile(layout.current);
    return { action: "already-current", version, from: current, previous: readVersionFile(layout.previous), folder: path.join(layout.versions, current ?? version), current: layout.current, warnings: [] };
  };
  const finished = (result: UpdateResult): UpdateResult => {
    report({ stage: "done", version: result.version });
    return result;
  };
  if (check.status === "up-to-date") return finished(alreadyCurrent(check.latest?.version ?? install.version));
  if (check.status === "no-release") throw fail("SELF_UPDATE_NO_RELEASE", "No Moxen release has been published yet.");
  if (check.status !== "available" || check.latest === null) throw fail("SELF_UPDATE_CHECK_FAILED", `Could not check for an update: ${check.reason ?? "unknown reason"}.`);
  const { latest } = check;
  if (!SAFE_VERSION.test(latest.version)) throw fail("SELF_UPDATE_BAD_VERSION", `The release version "${latest.version}" is not a valid folder name.`);
  if (latest.archive === null || latest.checksum === null) {
    throw fail("SELF_UPDATE_INCOMPLETE_RELEASE", `Release ${latest.tag} is missing this platform's archive or its .sha256 file, so it was refused.`);
  }
  const version = latest.version;
  // `current` may already name the release (a server that has not restarted still runs the older one).
  if (readVersionFile(layout.current) === version && usable(layout, version)) return finished(alreadyCurrent(version));

  return await withLock(layout, async () => {
    await mkdir(layout.versions, { recursive: true });
    await clearStaleTemps(layout);
    const scratch = path.join(layout.versions, `${TEMP_PREFIX}update-${version}-${process.pid}-${Date.now()}`);
    await mkdir(scratch);
    try {
      const archiveFile = path.join(scratch, path.basename(latest.archive!.name));
      const expected = await readChecksum(doFetch, latest.checksum!, latest.archive!.name, options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
      const actual = await downloadArchive(doFetch, latest.archive!, archiveFile, options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS, report, version);
      report({ stage: "verifying", version });
      if (actual !== expected) throw fail("SELF_UPDATE_CHECKSUM_MISMATCH", `The downloaded ${latest.archive!.name} does not match its SHA-256, so it was discarded.`);
      report({ stage: "unpacking", version });
      const unpacked = await unpackArchive(target, archiveFile, path.join(scratch, "unpacked"), version);
      report({ stage: "testing", version });
      await startTest(unpacked, version, options, scratch);

      // It works. Give the folder its name, then record what it replaces, and only then change `current`.
      report({ stage: "switching", version });
      const finalFolder = path.join(layout.versions, version);
      const replaced = path.join(scratch, "replaced");
      const hadFolder = existsSync(finalFolder);
      if (hadFolder) await rename(finalFolder, replaced);
      try {
        await renameReplacing(unpacked, finalFolder);
      } catch (error) {
        if (hadFolder) await rename(replaced, finalFolder);
        throw error;
      }
      const from = readVersionFile(layout.current);
      const previous = usable(layout, from) ? from : null;
      await recordPrevious(layout, previous);
      await writeAtomic(layout.current, `${version}\n`);

      const keep = new Set<string>([version, install.version]);
      if (previous !== null) keep.add(previous);
      // A server that has not restarted can be several updates behind, and it still reads its own folder.
      const running = options.runningVersions === undefined ? [] : await options.runningVersions().catch(() => null);
      const warnings = running === null ? ["Could not tell which version the server runs, so old versions were kept."] : await prune(layout, new Set([...keep, ...running]), options.removeFolder ?? removeFully);
      return finished({ action: "updated", version, from, previous, folder: finalFolder, current: layout.current, warnings });
    } finally {
      await removeFully(scratch).catch(() => undefined);
    }
  });
}

export async function rollbackRelease(options: UpdateOptions = {}): Promise<RollbackResult> {
  const install = readInstall(options);
  const layout = options.layout ?? appLayout(options.env);
  requireInstalledRelease(install, layout);

  return await withLock(layout, async () => {
    const from = readVersionFile(layout.current);
    const previous = readVersionFile(layout.previous);
    if (previous === null || previous === from) throw fail("SELF_UPDATE_NO_PREVIOUS", "There is no previous version to go back to.");
    const folder = path.join(layout.versions, previous);
    if (!usable(layout, previous)) throw fail("SELF_UPDATE_NO_PREVIOUS", `The previous version ${previous} is no longer installed, so nothing was changed.`);
    if (from === null) throw fail("SELF_UPDATE_NO_PREVIOUS", "No current version is recorded, so there is nothing to roll back from.");
    const scratch = path.join(layout.versions, `${TEMP_PREFIX}rollback-${process.pid}-${Date.now()}`);
    await mkdir(scratch, { recursive: true });
    const report = reporter(options);
    try {
      // The version being returned to must still start.
      report({ stage: "testing", version: previous });
      await startTest(folder, previous, options, scratch);
    } finally {
      await removeFully(scratch).catch(() => undefined);
    }
    // The version left becomes the new previous, so a rollback can itself be rolled back.
    report({ stage: "switching", version: previous });
    await recordPrevious(layout, from);
    await writeAtomic(layout.current, `${previous}\n`);
    report({ stage: "done", version: previous });
    return { action: "rolled-back", version: previous, from, previous: from, folder, current: layout.current, warnings: [] } satisfies RollbackResult;
  });
}
