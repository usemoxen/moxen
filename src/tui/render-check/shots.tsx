import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { act } from "react";
import { TextAttributes } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";

import { registerSyntaxParsers } from "../../core/syntax/register.js";
import { applyTheme, SURFACE } from "../theme.js";
import { THEME_NAMES } from "../themes.js";
import { App, client, harnessTheme } from "./fixtures.js";
import { frameSink, listenForLabels, testRender } from "./testrender.js";
import { GALLERY } from "./gallery/index.js";
import { runWalkthrough } from "./walkthrough.js";

/**
 * The visual harness: renders screens through the test renderer and paints
 * them as PNGs (`scripts/render-shots.py`), so colour can be judged by eye.
 *
 *   bun src/tui/render-check/shots.tsx [--mode overview|frames|gallery] [--theme a,b|all]
 *                                      [--filter text] [--out dir]
 *
 * `overview` (the default) is a thread and its diff, per theme. `frames`
 * runs the whole render-check walkthrough and keeps every frame it
 * captures, named by the `--- label ---` the scenario logged, so anything the
 * scenarios draw can be seen. Identical frames are kept once. `gallery`
 * draws each component of `gallery/` on its own, in every theme by default,
 * and builds one sheet per component comparing the themes.
 */
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const mode = option("mode") ?? "overview";
const outDir = option("out") ?? "shots";
const filter = option("filter")?.toLowerCase();
const themeArg = option("theme");
const themes = themeArg === undefined ? (mode === "frames" ? ["moxen"] : THEME_NAMES) : themeArg === "all" ? THEME_NAMES : themeArg.split(",");
for (const theme of themes) if (!(THEME_NAMES as string[]).includes(theme)) throw new Error(`unknown theme "${theme}" (one of: ${THEME_NAMES.join(", ")})`);

const hex = (color: { r: number; g: number; b: number }): string =>
  `#${[color.r, color.g, color.b].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;

/** A row that is only the stage's own surface: nothing drawn on it. */
const isBlank = (line: { text: string; bg: string }[]): boolean => line.every((cell) => cell.text.trim() === "" && cell.bg === SURFACE.base);

/** Shrinks every long blank stretch (a tall page's gap above its footer, an editor's short list) to one row. */
function squeezeBlanks(lines: { text: string; bg: string }[][]): void {
  // The sidebar rule and the scrollbar run the whole height, so they do not make a row non-blank.
  const blank = (line: { text: string }[]): boolean => line.every((cell) => /^[\s│┃▌█▐]*$/.test(cell.text));
  let row = 0;
  while (row < lines.length) {
    if (!blank(lines[row]!)) {
      row += 1;
      continue;
    }
    let end = row;
    while (end < lines.length && blank(lines[end]!)) end += 1;
    if (end - row > 3) lines.splice(row + 1, end - row - 1);
    row += 2;
  }
}

function frameJson(setup: TestRendererSetup, trim = false, squeeze = false): string {
  const frame = setup.captureSpans();
  const lines = frame.lines.map((line) => {
    let x = 0;
    return line.spans.map((span) => {
      const cell = { x, text: span.text, width: span.width, fg: hex(span.fg), bg: hex(span.bg), bold: (span.attributes & TextAttributes.BOLD) !== 0, italic: (span.attributes & TextAttributes.ITALIC) !== 0, underline: (span.attributes & TextAttributes.UNDERLINE) !== 0, dim: (span.attributes & TextAttributes.DIM) !== 0 };
      x += span.width;
      return cell;
    });
  });
  if (squeeze) squeezeBlanks(lines);
  if (trim) while (lines.length > 1 && isBlank(lines[lines.length - 1]!)) lines.pop();
  return JSON.stringify({ cols: frame.cols, rows: lines.length, lines });
}

function write(file: string, json: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, json);
}

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "frame";

await registerSyntaxParsers();
const target = path.join(outDir, mode);
rmSync(target, { recursive: true, force: true });

for (const theme of themes) {
  applyTheme(theme);
  harnessTheme.current = theme;
  if (mode === "gallery") {
    for (const entry of GALLERY) {
      if (filter !== undefined && !`${entry.id} ${entry.title}`.toLowerCase().includes(filter)) continue;
      const setup = await testRender(<>{entry.element()}</>, { width: entry.width, height: entry.height, exitOnCtrlC: false });
      await new Promise((resolve) => setTimeout(resolve, entry.settleMs ?? 50));
      await setup.flush();
      if (entry.drive) await entry.drive(setup);
      write(path.join(target, theme, `${entry.id}.json`), frameJson(setup, true, entry.squeeze === true));
      // Free the native buffers: hundreds of tall pages exhaust them otherwise.
      setup.renderer.destroy();
    }
  } else if (mode === "frames") {
    const dir = path.join(outDir, "frames", theme);
    const seen = new Set<string>();
    let count = 0;
    frameSink.current = (setup, label) => {
      if (filter !== undefined && !label.toLowerCase().includes(filter)) return;
      const json = frameJson(setup);
      const hash = createHash("sha1").update(json).digest("hex");
      if (seen.has(hash)) return;
      seen.add(hash);
      count += 1;
      write(path.join(dir, `${String(count).padStart(3, "0")}-${slug(label)}.json`), json);
    };
    const restore = listenForLabels();
    try {
      await runWalkthrough();
    } finally {
      restore();
      frameSink.current = null;
    }
    console.log(`${theme}: ${count} frames`);
  } else {
    const dir = path.join(outDir, "overview", theme);
    const setup = await testRender(<App client={client} onQuit={() => {}} launchView="thread" />, { width: 188, height: 53, exitOnCtrlC: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await setup.flush();
    write(path.join(dir, "thread.json"), frameJson(setup));
    // The timeline's diff row, found by its text since the layout moves it.
    const rows = setup.captureCharFrame().split("\n");
    const y = rows.findIndex((line) => /diff \d+ files?/.test(line));
    const x = y === -1 ? -1 : (rows[y]?.search(/diff \d+ files?/) ?? -1);
    if (y !== -1 && x !== -1) await act(async () => setup.mockMouse.click(x + 1, y));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await setup.flush();
    write(path.join(dir, "diff.json"), frameJson(setup));
    // No destroy(), as in the render-check scenarios: a second teardown breaks the shared renderer.
  }
}
harnessTheme.current = undefined;
applyTheme("moxen");

// Paint with Pillow; `python3` is `python` on Windows.
const painter = fileURLToPath(new URL("../../../scripts/render-shots.py", import.meta.url));
for (const python of ["python3", "python"]) {
  const run = spawnSync(python, ["-I", painter, target, ...(mode === "gallery" ? ["--sheets"] : [])], { stdio: "inherit" });
  if (run.error === undefined) process.exit(run.status ?? 1);
  // This interpreter is not installed; try the next name.
}
console.error("no python interpreter (python3 or python) with Pillow found; the frame JSON is in", target);
process.exit(1);
