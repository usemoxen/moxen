/**
 * Writes each vendored grammar's upstream LICENSE next to its wasm
 * (`src/core/syntax/<filetype>/LICENSE`) and regenerates the summary table in
 * `THIRD_PARTY_LICENSES.md`. Run after `bun run update:tree-sitter-assets`:
 *
 *   bun scripts/fetch-tree-sitter-licenses.ts
 *
 * Sources are read from `parsers-config.json` (the wasm and every query URL) and
 * `parsers-build.json` (the pinned repository), so
 * a grammar whose queries come from a second repo (`cpp` reuses `c`'s) gets both
 * licenses. The SPDX id comes from GitHub's license detection (`gh`), never a guess.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface Parser {
  filetype: string;
  wasm: string;
  queries: { highlights: string[] };
}

/** An entry of `parsers-build.json`: built from source at a pinned ref. */
interface BuiltParser {
  filetype: string;
  repo: string;
  ref: string;
}

const root = path.resolve(import.meta.dir, "..");
const syntaxDir = path.join(root, "src", "core", "syntax");
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "COPYING.txt", "UNLICENSE"];
/** Grammars fetched from npm rather than GitHub releases: the repo behind the package. */
const NPM_REPOS: Record<string, { repo: string; tag: string }> = {
  "tree-sitter-powershell": { repo: "airbus-cert/tree-sitter-powershell", tag: "v0.26.4" },
};

interface Source {
  repo: string;
  tag: string;
}

function sourcesOf(parser: Parser): Source[] {
  const found = new Map<string, Source>();
  for (const url of [parser.wasm, ...parser.queries.highlights]) {
    const raw = /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\//.exec(url);
    const release = /github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//.exec(url);
    const hit = raw ?? release ?? null;
    if (hit?.[1] && hit[2]) {
      found.set(hit[1], { repo: hit[1], tag: hit[2] });
      continue;
    }
    const npm = /unpkg\.com\/(tree-sitter-[a-z-]+)@/.exec(url);
    const mapped = npm?.[1] ? NPM_REPOS[npm[1]] : undefined;
    if (mapped) found.set(mapped.repo, mapped);
    else throw new Error(`Cannot tell which repository ${url} comes from; teach sourcesOf().`);
  }
  return [...found.values()];
}

function spdxOf(repo: string): string {
  const out = spawnSync("gh", ["api", `repos/${repo}/license`, "--jq", ".license.spdx_id"], { encoding: "utf8" });
  const id = out.stdout.trim();
  if (out.status !== 0 || id === "") throw new Error(`gh could not read the license of ${repo}: ${out.stderr.trim()}`);
  return id;
}

async function licenseText(source: Source): Promise<string> {
  for (const name of LICENSE_NAMES) {
    const response = await fetch(`https://raw.githubusercontent.com/${source.repo}/${source.tag}/${name}`);
    if (response.ok) return await response.text();
  }
  throw new Error(`${source.repo}@${source.tag} has no license file (${LICENSE_NAMES.join(", ")}).`);
}

/** A NOTICE file (Apache-2.0 asks for it to travel with the license), when the repository has one. */
async function noticeText(source: Source): Promise<string | null> {
  for (const name of ["NOTICE", "NOTICE.md", "NOTICE.txt"]) {
    const response = await fetch(`https://raw.githubusercontent.com/${source.repo}/${source.tag}/${name}`);
    if (response.ok) return (await response.text()).trimEnd();
  }
  return null;
}

const fetchedConfig = JSON.parse(await readFile(path.join(root, "parsers-config.json"), "utf8")) as { parsers: Parser[] };
const builtConfig = JSON.parse(await readFile(path.join(root, "parsers-build.json"), "utf8")) as { parsers: BuiltParser[] };
/** A built grammar's one source is its pinned repository; the queries it inherits come from `parsers-config.json`'s own entries. */
const config = {
  parsers: [
    ...fetchedConfig.parsers,
    ...builtConfig.parsers.map(
      (parser): Parser => ({
        filetype: parser.filetype,
        wasm: `https://github.com/${parser.repo}/releases/download/${parser.ref}/built-from-source.wasm`,
        queries: { highlights: [`https://raw.githubusercontent.com/${parser.repo}/${parser.ref}/queries/highlights.scm`] },
      }),
    ),
  ],
};
const spdxCache = new Map<string, string>();
const rows: string[] = [];

for (const parser of config.parsers) {
  const sources = sourcesOf(parser);
  const sections: string[] = [];
  const names: string[] = [];
  for (const source of sources) {
    const spdx = spdxCache.get(source.repo) ?? spdxOf(source.repo);
    spdxCache.set(source.repo, spdx);
    const text = (await licenseText(source)).trimEnd();
    const notice = await noticeText(source);
    sections.push(
      `${source.repo} @ ${source.tag} (${spdx})\n${"=".repeat(60)}\n\n${text}\n` +
        (notice === null ? "" : `\nNOTICE\n${"-".repeat(6)}\n\n${notice}\n`),
    );
    names.push(`[${source.repo}](https://github.com/${source.repo}/tree/${source.tag}) \`${source.tag}\` — ${spdx}`);
  }
  await mkdir(path.join(syntaxDir, parser.filetype), { recursive: true });
  await writeFile(path.join(syntaxDir, parser.filetype, "LICENSE"), sections.join("\n\n"));
  rows.push(`| \`${parser.filetype}\` | ${names.join("<br>")} |`);
  console.log(`${parser.filetype.padEnd(11)} ${sources.map((source) => `${source.repo}@${source.tag}`).join(" + ")}`);
}

const doc = `# Third-party licenses

Moxen vendors tree-sitter grammars (WebAssembly builds) and their highlight
queries under \`src/core/syntax/\`. Each grammar below is used under the license
listed; the full license text sits beside the grammar as
\`src/core/syntax/<filetype>/LICENSE\`.

This file and every \`LICENSE\` under \`src/core/syntax/\` are generated by
\`bun scripts/fetch-tree-sitter-licenses.ts\` — do not edit them by hand.

| Filetype | Source, version and license |
| --- | --- |
${rows.join("\n")}
`;
await writeFile(path.join(root, "THIRD_PARTY_LICENSES.md"), doc);
console.log(`\nwrote THIRD_PARTY_LICENSES.md (${config.parsers.length} grammars)`);
