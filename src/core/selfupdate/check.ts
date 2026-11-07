/**
 * Whether a newer Moxen release exists, read from GitHub Releases. Read-only: it downloads nothing but the
 * release's description, sends no credential, and says "unavailable" instead of throwing when it cannot ask.
 * The check is the user's explicit request; nothing here runs in the background.
 */
import { archiveFileName, checksumFileName, RELEASES_REPOSITORY, releaseTargetOf } from "../release.js";
import { compareVersions, isPrerelease, parseVersion, type InstallInfo, type LatestRelease, type ReleaseAsset, type UpdateCheck, type UpdateStatus } from "./vocabulary.js";

export { compareVersions, isPrerelease, parseVersion, RELEASES_REPOSITORY };

export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases/latest`;
export const CHECK_TIMEOUT_MS = 8_000;

export interface CheckOptions {
  readonly install: InstallInfo;
  /** Injected in tests. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly url?: string;
}

const result = (install: InstallInfo, status: UpdateStatus, extra: { reason?: string; latest?: LatestRelease | null } = {}): UpdateCheck => {
  const latest = extra.latest ?? null;
  return {
    install,
    status,
    reason: extra.reason ?? null,
    latest,
    updatable: install.kind === "release" && status === "available" && latest?.archive != null && latest.checksum != null,
  };
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findAsset(assets: readonly unknown[], name: string): ReleaseAsset | null {
  for (const asset of assets) {
    if (asset === null || typeof asset !== "object") continue;
    const record = asset as Record<string, unknown>;
    const url = text(record.browser_download_url);
    if (record.name === name && url !== null && (record.state === undefined || record.state === "uploaded")) {
      return { name, url, size: typeof record.size === "number" ? record.size : null };
    }
  }
  return null;
}

export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheck> {
  const { install } = options;
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(options.url ?? LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": `moxen/${install.version}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return result(install, "unavailable", { reason: timedOut ? "GitHub did not answer in time" : "could not reach GitHub" });
  }
  // GitHub answers 404 for a repository with no published release.
  if (response.status === 404) return result(install, "no-release");
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    return result(install, "unavailable", { reason: "GitHub rate limit reached; try again later" });
  }
  if (!response.ok) return result(install, "unavailable", { reason: `GitHub answered ${response.status}` });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return result(install, "unavailable", { reason: "GitHub sent an answer that is not JSON" });
  }
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const tag = text(record.tag_name);
  const version = tag === null ? null : (parseVersion(tag) === null ? null : tag.replace(/^v/, ""));
  if (tag === null || version === null || !Array.isArray(record.assets)) {
    return result(install, "unavailable", { reason: "GitHub sent a release Moxen cannot read" });
  }
  // Prereleases and drafts are never offered.
  if (record.draft === true || record.prerelease === true || isPrerelease(version)) return result(install, "no-release");

  const target = install.target === null ? null : releaseTargetOf(install.target.os, install.target.arch);
  const latest: LatestRelease = {
    version,
    tag,
    url: text(record.html_url) ?? `https://github.com/${RELEASES_REPOSITORY}/releases/tag/${tag}`,
    notes: typeof record.body === "string" ? record.body : "",
    archive: target === null ? null : findAsset(record.assets, archiveFileName(version, target)),
    checksum: target === null ? null : findAsset(record.assets, checksumFileName(version, target)),
  };

  const order = compareVersions(install.version, version);
  if (order === null) return result(install, "unavailable", { reason: "the installed version is not a release version", latest });
  if (order >= 0) return result(install, "up-to-date", { latest });
  if (target === null) return result(install, "unavailable", { reason: "this platform has no Moxen release", latest });
  if (latest.archive === null || latest.checksum === null) {
    const missing = latest.archive === null ? archiveFileName(version, target) : checksumFileName(version, target);
    return result(install, "unavailable", { reason: `release ${tag} has no ${missing} for this platform`, latest });
  }
  return result(install, "available", { latest });
}
