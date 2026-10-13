/**
 * Refreshes the local mirrors of the docs we check behavior against:
 *
 *   docs/external/claude-code/  — https://code.claude.com/docs/llms.txt and every page it
 *                                 lists (`en/…`), plus the translated indexes (`_llms/…`)
 *   docs/external/opencode-v2/  — https://opencode.ai/v2/llms.txt and every page it lists
 *
 * Usage:
 *
 *   bun scripts/update-docs.ts                 update both
 *   bun scripts/update-docs.ts claude          only the Claude Code docs
 *   bun scripts/update-docs.ts opencode        only the OpenCode docs
 *   bun scripts/update-docs.ts --dry-run       say what would change, write nothing
 *   bun scripts/update-docs.ts --prune         also delete mirrored pages the index no longer lists
 *
 * Only files whose content changed are written, so `git diff` after a run is the
 * changelog. A page the server refuses (403, as `en/claude-tag.md` is) is
 * reported and skipped, never written empty. Pruning is opt-in because a failed
 * index fetch must never read as "everything was removed".
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prune = args.includes("--prune");
const targets = args.filter((arg) => !arg.startsWith("--"));
const CONCURRENCY = 8;
const RETRIES = 3;

interface Page {
  /** Where the page is fetched from. */
  url: string;
  /** Path under the mirror's directory. */
  file: string;
  /** Sent as `Accept` (the OpenCode site serves markdown only when asked). */
  accept?: string;
  /** Text put before the body (OpenCode pages carry the same index header Claude's do). */
  header?: string;
}

interface Mirror {
  name: string;
  dir: string;
  indexUrl: string;
  pagesFrom(index: string): Page[];
}

async function get(url: string, accept?: string): Promise<{ status: number; text: string }> {
  let last = 0;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { headers: accept ? { Accept: accept } : {}, redirect: "follow" });
      last = response.status;
      if (response.ok) return { status: response.status, text: await response.text() };
      // A refusal or a missing page will not change on a retry.
      if (response.status === 403 || response.status === 404) break;
    } catch {
      last = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  return { status: last, text: "" };
}

const claude: Mirror = {
  name: "claude-code",
  dir: path.join(root, "docs", "external", "claude-code"),
  indexUrl: "https://code.claude.com/docs/llms.txt",
  pagesFrom(index) {
    const pages: Page[] = [];
    for (const match of index.matchAll(/https:\/\/code\.claude\.com\/docs\/((?:en\/|_llms\/)[^)\s]+\.md)/g)) {
      pages.push({ url: match[0], file: match[1]! });
    }
    return pages;
  },
};

const OPENCODE_INDEX = "https://opencode.ai/v2/llms.txt";
const opencode: Mirror = {
  name: "opencode-v2",
  dir: path.join(root, "docs", "external", "opencode-v2"),
  indexUrl: OPENCODE_INDEX,
  pagesFrom(index) {
    const pages: Page[] = [];
    for (const match of index.matchAll(/https:\/\/opencode\.ai\/v2\/docs\/([^)\s]*)/g)) {
      const slug = match[1]!.replace(/\/+$/, "");
      pages.push({
        url: match[0],
        // `docs/` is the intro (`index.md`); `a/b/` is `a/b.md`.
        file: slug === "" ? "index.md" : `${slug}.md`,
        accept: "text/markdown",
        header: `> ## Documentation Index\n> Fetch the complete documentation index at: ${OPENCODE_INDEX}\n> Source: ${match[0]}\n> Use this file to discover all available pages before exploring further.\n\n`,
      });
    }
    return pages;
  },
};

async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(full)).map((file) => path.join(entry.name, file)));
    else found.push(entry.name);
  }
  return found;
}

async function write(mirror: Mirror, file: string, content: string, counts: Counts): Promise<void> {
  const target = path.join(mirror.dir, file);
  const before = await readFile(target, "utf8").catch(() => null);
  if (before === content) return;
  (before === null ? counts.added : counts.updated).push(file);
  if (dryRun) return;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

interface Counts {
  added: string[];
  updated: string[];
  removed: string[];
  skipped: string[];
}

async function sync(mirror: Mirror): Promise<Counts> {
  const counts: Counts = { added: [], updated: [], removed: [], skipped: [] };
  const index = await get(mirror.indexUrl);
  if (index.status !== 200 || index.text.trim() === "") throw new Error(`${mirror.name}: could not read ${mirror.indexUrl} (status ${index.status}); nothing was changed.`);
  const pages = mirror.pagesFrom(index.text);
  if (pages.length === 0) throw new Error(`${mirror.name}: the index lists no pages; nothing was changed.`);

  await write(mirror, "llms.txt", index.text, counts);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pages.length) {
      const page = pages[next++]!;
      const response = await get(page.url, page.accept);
      if (response.status !== 200 || response.text.trim() === "") {
        counts.skipped.push(`${page.file} (${response.status || "no response"})`);
        continue;
      }
      const body = response.text.endsWith("\n") ? response.text : `${response.text}\n`;
      await write(mirror, page.file, `${page.header ?? ""}${body}`, counts);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (prune) {
    const listed = new Set(["llms.txt", ...pages.map((page) => page.file)]);
    for (const file of await listFiles(mirror.dir)) {
      const normalized = file.split(path.sep).join("/");
      if (listed.has(normalized)) continue;
      counts.removed.push(normalized);
      if (!dryRun) await rm(path.join(mirror.dir, file));
    }
  }
  return counts;
}

const mirrors = [claude, opencode].filter((mirror) => targets.length === 0 || targets.some((target) => mirror.name.startsWith(target)));
if (mirrors.length === 0) throw new Error(`Unknown target ${targets.join(", ")}; use claude or opencode.`);

let failed = false;
for (const mirror of mirrors) {
  try {
    const counts = await sync(mirror);
    console.log(`${mirror.name}${dryRun ? " (dry run)" : ""}: ${counts.added.length} added, ${counts.updated.length} updated, ${counts.removed.length} removed, ${counts.skipped.length} skipped`);
    for (const [label, files] of [["+", counts.added], ["~", counts.updated], ["-", counts.removed], ["!", counts.skipped]] as const) {
      for (const file of files) console.log(`  ${label} ${file}`);
    }
  } catch (error) {
    failed = true;
    console.error(String(error instanceof Error ? error.message : error));
  }
}
process.exit(failed ? 1 : 0);
