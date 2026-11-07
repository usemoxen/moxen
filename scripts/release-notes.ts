/**
 * Writes the GitHub release notes for a version: the install steps above the changelog.
 *
 *   bun scripts/release-notes.ts <version|tag> --changelog <file> [--out <file>]
 *
 * The release workflow generates the changelog with `gh api .../releases/generate-notes`, saves it to a
 * file, and calls this to compose the notes `gh release create --notes-file` publishes. The install steps
 * come from one source (`releaseInstallNotes` in `src/core/release.ts`, shared with the README); the
 * changelog is passed through verbatim. With no `--out`, the notes go to stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseVersion } from "../src/core/selfupdate/vocabulary.js";
import { releaseNotesBody, tagForVersion } from "./release-lib.js";

const args = process.argv.slice(2);
const usage = "Usage: bun scripts/release-notes.ts <version|tag> --changelog <file> [--out <file>]";
const positionals: string[] = [];
let changelogFile: string | undefined;
let out: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--changelog" || arg === "--out") {
    const value = args[index + 1];
    if (!value) {
      console.error(usage);
      process.exit(1);
    }
    if (arg === "--changelog") changelogFile = value;
    else out = value;
    index += 1;
  } else if (arg.startsWith("--")) {
    console.error(`${usage} (unknown flag ${JSON.stringify(arg)})`);
    process.exit(1);
  } else {
    positionals.push(arg);
  }
}

const version = (positionals[0] ?? "").replace(/^v/, "");
if (positionals.length !== 1 || parseVersion(version) === null) {
  console.error(`${usage} (got ${JSON.stringify(positionals[0] ?? "")})`);
  process.exit(1);
}
if (!changelogFile) {
  console.error(usage);
  process.exit(1);
}
let changelog: string;
try {
  changelog = readFileSync(changelogFile, "utf8");
} catch {
  console.error(`release-notes: cannot read ${changelogFile}\n${usage}`);
  process.exit(1);
}
const body = releaseNotesBody(version, changelog);
if (out) writeFileSync(out, body);
else process.stdout.write(body);
console.error(`release notes for ${tagForVersion(version)} (${body.length} chars)`);
