/** `bun scripts/check-release-tag.ts <tag>`: exits 1 unless the tag is `v` plus the version in package.json. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { tagMismatch } from "./release-lib.js";

const tag = process.argv[2] ?? "";
const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
const problem = tagMismatch(tag, manifest.version);
if (problem) {
  console.error(problem);
  process.exit(1);
}
console.log(`${tag} matches package.json`);
