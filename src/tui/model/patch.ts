import { basenameToFiletype, extensionToFiletype } from "@opentui/core";

import { builtParserAssetPaths } from "../../core/syntax/builtParsers.js";
import { defaultParserAssetPaths } from "../../core/syntax/parsers.js";

export interface PatchFile {
  path: string;
  filetype: string | undefined;
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

const FILETYPES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  zig: "zig",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  css: "css",
  html: "html",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ksh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

/**
 * Extensions OpenTUI's own table leaves out (or that we read differently):
 * `.m` is Objective-C here, not MATLAB, which has no grammar in the bundle.
 */
const EXTRA_FILETYPES: Record<string, string> = {
  m: "objc",
  mm: "objc",
  mk: "make",
  cu: "cuda",
  cuh: "cuda",
  kdl: "kdl",
  bzl: "starlark",
  bazel: "starlark",
  star: "starlark",
  bicep: "bicep",
  odin: "odin",
  graphql: "graphql",
  gql: "graphql",
  cmake: "cmake",
  nix: "nix",
  proto: "proto",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  prisma: "prisma",
  templ: "templ",
  just: "just",
  mmd: "mermaid",
  mermaid: "mermaid",
  sol: "solidity",
  res: "rescript",
  resi: "rescript",
  gleam: "gleam",
  fish: "fish",
  typ: "typst",
  f90: "fortran",
  f95: "fortran",
  f03: "fortran",
  f08: "fortran",
  pas: "pascal",
  pp: "pascal",
  rkt: "racket",
  tcl: "tcl",
  d: "d",
  adb: "ada",
  ads: "ada",
  wgsl: "wgsl",
  ejs: "ejs",
  erb: "ejs",
  properties: "properties",
};

/** Whole file names with no useful extension. */
const EXTRA_BASENAMES: Record<string, string> = {
  "cmakelists.txt": "cmake",
  justfile: "just",
  kconfig: "kconfig",
};

/** Grammars OpenTUI can actually load: its own plus every vendored one (directory name = filetype). */
const SUPPORTED_FILETYPES: ReadonlySet<string> = new Set([
  "javascript",
  "typescript",
  "markdown",
  "markdown_inline",
  "zig",
  ...defaultParserAssetPaths.map((asset) => asset.split("/")[0]!),
  ...builtParserAssetPaths.map((asset) => asset.split("/")[0]!),
]);

/**
 * Grammar name for a path, matching the identifiers OpenTUI's tree-sitter client expects.
 * Our own table wins (it folds `js`/`tsx` into the TypeScript grammar), then the
 * extras above, then OpenTUI's full extension and file-name tables — but only for
 * a grammar that is really loaded, so an unsupported language reads as plain text
 * rather than naming a parser that is not there.
 */
export function detectFiletype(filePath: string): string | undefined {
  const name = filePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() : undefined;
  const own = extension === undefined ? undefined : (FILETYPES[extension] ?? EXTRA_FILETYPES[extension]);
  if (own !== undefined) return own;
  const byName = EXTRA_BASENAMES[name];
  if (byName !== undefined) return byName;
  const known = EXTRA_BASENAMES[name] ?? basenameToFiletype.get(name) ?? (extension === undefined ? undefined : extensionToFiletype.get(extension));
  return known !== undefined && SUPPORTED_FILETYPES.has(known) ? known : undefined;
}

function pathFromHeader(line: string): string | null {
  // `diff --git a/<path> b/<path>`; the b-side is authoritative for renames.
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (match === null) return null;
  return match[2] ?? match[1] ?? null;
}

/**
 * Splits a multi-file git patch into per-file patches. Each file needs its own
 * `<diff>` so the renderer can pick the right grammar for highlighting.
 */
export function splitPatchByFile(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: { path: string; lines: string[] } | null = null;

  const flush = () => {
    if (current === null) return;
    const body = current.lines.join("\n");
    files.push({
      path: current.path,
      filetype: detectFiletype(current.path),
      patch: body,
      additions: current.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: current.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      binary: current.lines.some((line) => line.startsWith("Binary files ")),
    });
    current = null;
  };

  for (const line of patch.split("\n")) {
    const path = pathFromHeader(line);
    if (path !== null) {
      flush();
      current = { path, lines: [line] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  flush();
  return files;
}

export function shortPath(value: string, width: number): string {
  if (value.length <= width) return value;
  return `…${value.slice(value.length - width + 1)}`;
}

/**
 * Matches an activity row's (possibly shortened) path against a turn patch's
 * file list. Row paths come shortened (`src/tui/app.tsx`, sometimes
 * `tui/app.tsx`) while patch headers carry the full repo-relative path, so
 * this matches by suffix in either direction — the same rule the
 * checkpoint-stats matcher uses.
 */
export function findPatchFile(files: readonly PatchFile[], path: string): PatchFile | null {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  if (norm.length === 0 || norm === "…") return null;
  for (const file of files) {
    const candidate = file.path.toLowerCase();
    if (candidate.length > 0 && (candidate.endsWith(norm) || norm.endsWith(candidate))) return file;
  }
  return null;
}
