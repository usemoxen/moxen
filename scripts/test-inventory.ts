/**
 * What the test suite is, generated from the suite itself — so it cannot go
 * stale the way a hand-kept list does.
 *
 *   bun scripts/test-inventory.ts              tests and time per area, plus what to look at
 *   bun scripts/test-inventory.ts <path-part>  every test title in matching files (what each one pins)
 *
 * Runs the whole suite once (`vitest --reporter=json`), so the times are real.
 * Read it before adding a test: if an area already pins the behavior, extend
 * that test instead of writing another (see "Tests" in AGENTS.md).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface Assertion {
  readonly ancestorTitles: readonly string[];
  readonly title: string;
  readonly duration?: number;
}
interface FileResult {
  readonly name: string;
  readonly assertionResults: readonly Assertion[];
}

const SLOW_TEST_MS = 1_500;
const BIG_FILE_TESTS = 40;

const out = mkdtempSync(path.join(tmpdir(), "moxen-inventory-"));
const report = path.join(out, "report.json");
try {
  spawnSync("bunx", ["vitest", "run", "--reporter=json", `--outputFile=${report}`], { stdio: "ignore" });
  const results: FileResult[] = (JSON.parse(readFileSync(report, "utf8")) as { testResults: FileResult[] }).testResults;
  const root = process.cwd() + path.sep;
  const files = results.map((file) => ({
    path: file.name.replace(root, ""),
    tests: file.assertionResults,
    ms: file.assertionResults.reduce((total, test) => total + (test.duration ?? 0), 0),
  }));

  const filter = process.argv[2];
  if (filter) {
    for (const file of files.filter((entry) => entry.path.includes(filter))) {
      console.log(`${file.path}  (${file.tests.length} tests, ${Math.round(file.ms)}ms)`);
      for (const test of file.tests) console.log(`  ${[...test.ancestorTitles, test.title].join(" › ")}`);
    }
  } else {
    const area = (file: string) => file.split("/").slice(0, file.startsWith("src/core/") ? 3 : 2).join("/");
    const areas = new Map<string, { files: number; tests: number; ms: number }>();
    for (const file of files) {
      const entry = areas.get(area(file.path)) ?? { files: 0, tests: 0, ms: 0 };
      areas.set(area(file.path), { files: entry.files + 1, tests: entry.tests + file.tests.length, ms: entry.ms + file.ms });
    }
    console.log("area".padEnd(28), "files".padStart(5), "tests".padStart(6), "test-time".padStart(10));
    for (const [name, entry] of [...areas].sort((a, b) => b[1].ms - a[1].ms)) {
      console.log(name.padEnd(28), String(entry.files).padStart(5), String(entry.tests).padStart(6), `${Math.round(entry.ms)}ms`.padStart(10));
    }
    const total = files.reduce((sum, file) => sum + file.tests.length, 0);
    console.log(`\n${files.length} files, ${total} tests`);
    const slow = files.flatMap((file) => file.tests.filter((test) => (test.duration ?? 0) >= SLOW_TEST_MS).map((test) => `${Math.round(test.duration!)}ms  ${file.path} › ${test.title}`));
    console.log(`\nSlow (>= ${SLOW_TEST_MS}ms) — find what each waits for before adding another like it:`);
    console.log(slow.length === 0 ? "  none" : slow.map((line) => `  ${line}`).join("\n"));
    const big = files.filter((file) => file.tests.length >= BIG_FILE_TESTS).map((file) => `${file.tests.length}  ${file.path}`);
    console.log(`\nFiles with >= ${BIG_FILE_TESTS} tests — extend a table before adding a case:`);
    console.log(big.length === 0 ? "  none" : big.map((line) => `  ${line}`).join("\n"));
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
