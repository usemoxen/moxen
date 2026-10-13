import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { builtParserAssetPaths } from "../builtParsers.js";
import { defaultParserAssetPaths } from "../parsers.js";

const syntaxDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(syntaxDir, "..", "..", "..");
const configured = JSON.parse(readFileSync(path.join(repoRoot, "parsers-config.json"), "utf8")) as {
  parsers: Array<{ filetype: string }>;
};
const builtConfigured = JSON.parse(readFileSync(path.join(repoRoot, "parsers-build.json"), "utf8")) as {
  parsers: Array<{ filetype: string; repo: string; ref: string }>;
};

describe("vendored tree-sitter parsers", () => {
  it("ships a wasm grammar and query file per parser", () => {
    expect(defaultParserAssetPaths.length).toBeGreaterThan(0);
    expect(defaultParserAssetPaths.length % 2).toBe(0);
    for (const relative of defaultParserAssetPaths) {
      const absolute = path.join(syntaxDir, relative);
      const stat = statSync(absolute);
      expect(stat.isFile()).toBe(true);
      if (relative.endsWith(".wasm")) expect(stat.size).toBeGreaterThan(0);
    }
  });

  it("matches parsers-config.json so regeneration cannot drift silently", () => {
    const fromAssets = [...new Set(defaultParserAssetPaths.map((asset) => asset.split("/")[0]))].sort();
    const fromConfig = configured.parsers.map((parser) => parser.filetype).sort();
    expect(fromConfig.length).toBeGreaterThan(0);
    expect(fromAssets).toEqual(fromConfig);
  });

  it("ships every source-built grammar and matches parsers-build.json", () => {
    for (const relative of builtParserAssetPaths) {
      const stat = statSync(path.join(syntaxDir, relative));
      expect(stat.isFile(), relative).toBe(true);
      if (relative.endsWith(".wasm")) expect(stat.size, relative).toBeGreaterThan(0);
    }
    // A grammar may borrow a vendored parent's queries (`glsl` uses `c`'s), so compare the
    // grammars' own directories: every built filetype appears, and none is unconfigured.
    const own = new Set(builtConfigured.parsers.map((parser) => parser.filetype));
    const fromAssets = new Set(builtParserAssetPaths.filter((asset) => asset.endsWith(".wasm")).map((asset) => asset.split("/")[0]!));
    expect([...fromAssets].sort()).toEqual([...own].sort());
  });

  it("pins every built grammar to a tag or commit", () => {
    for (const parser of builtConfigured.parsers) {
      expect(parser.ref, parser.filetype).toMatch(/^(?:[0-9a-f]{40}|v?\d[\w.-]*)$/);
    }
  });

  it("keeps filetypes unique across both configs", () => {
    const all = [...configured.parsers, ...builtConfigured.parsers].map((parser) => parser.filetype);
    expect(new Set(all).size).toBe(all.length);
  });

  it("carries each grammar's license text and lists it in THIRD_PARTY_LICENSES.md", () => {
    const summary = readFileSync(path.join(repoRoot, "THIRD_PARTY_LICENSES.md"), "utf8");
    for (const { filetype } of [...configured.parsers, ...builtConfigured.parsers]) {
      const license = readFileSync(path.join(syntaxDir, filetype, "LICENSE"), "utf8");
      expect(license.length, `${filetype} LICENSE`).toBeGreaterThan(200);
      expect(summary, `${filetype} in THIRD_PARTY_LICENSES.md`).toContain(`| \`${filetype}\` |`);
    }
  });
});
