import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import { en } from "../en.js";

/**
 * Pins the rule that the TUI says nothing in a fixed language: a word a person
 * reads goes through `t()` (or `tx()` for text core builds), never inline.
 * It reads the source rather than the screen, so a string in a branch no test
 * reaches is caught too.
 */
const TUI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Properties whose string value is shown to a person. */
const SHOWN = new Set(["label", "title", "meta", "header", "description", "placeholder", "hint", "detail", "subtitle", "text", "message", "caption", "badge", "summary", "status"]);
/** JSX attributes that are shown. */
const SHOWN_ATTRIBUTES = new Set(["label", "title", "placeholder", "hint", "text", "description", "subtitle", "caption", "meta"]);
/** Calls whose argument at the index is shown: `setError(text)`, `toasts.push(id, tone, text)`. */
const SHOWN_CALLS: Readonly<Record<string, number>> = { setError: 0, push: 2, pushToast: 2 };

/**
 * Files that are not the app's own words: the dev mock, the render harness,
 * the decorative scenes, the thread export (a document for the next agent) and
 * the prompts and commands sent to a model or a shell.
 */
const SKIP_FILES = new Set(["model/activity.ts", "mock.tsx", "mockclient.ts", "render-check.tsx", "model/export.ts", "model/gitpanel.ts", "themes.ts", "model/filecache.ts", "model/gitdiff.ts", "model/patch.ts", "model/hostClipboard.ts"]);
const SKIP_DIRS = new Set(["tests", "render-check", "scenes", "i18n"]);

/** Words a screen shows that are the same in every language, or names. */
const ALLOWED = new Set(["Moxen", "Diff", "Git", "Plan", "Bash", "Monitor", "Shell", "Task", "Agent", "Claude Code", "OpenCode", "Moxen Harness", "Commits", "claude update", "opencode upgrade", "Ask", "Automatic", "Off"]);

function files(dir: string, everything = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (everything ? entry !== "tests" : !SKIP_DIRS.has(entry)) out.push(...files(full, everything));
    } else if (/\.tsx?$/u.test(entry) && (everything || !SKIP_FILES.has(path.relative(TUI, full).split(path.sep).join("/")))) out.push(full);
  }
  return out;
}

const readable = (text: string): boolean => /[A-Za-z]{3,}/u.test(text) && !ALLOWED.has(text.trim()) && !/^[a-z]+(\.[A-Za-z0-9_]+)+$/u.test(text) && !/^[a-z0-9_.:/#@\-[\]${}()*+?|\\]+$/u.test(text.trim());

describe("the TUI's words", () => {
  test("none is written inline where a person reads it", () => {
    const found: string[] = [];
    for (const file of files(TUI)) {
      const text0 = readFileSync(file, "utf8");
      const lines = text0.split("\n");
      const source = ts.createSourceFile(file, text0, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const flag = (node: ts.Node, text: string): void => {
        if (!readable(text)) return;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        // A line that says why its words stay as they are: a command, a stored title, a tool's own name.
        if (lines[line]?.includes("i18n-exempt") === true || lines[line - 1]?.includes("i18n-exempt") === true) return;
        found.push(`${path.relative(TUI, file)}:${line + 1}  ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)}`);
      };
      /** The words written inline in an expression shown as it is: a literal, a template's fixed parts, either side of a `?:` / `??` / `||`. */
      const literals = (node: ts.Node | undefined): string[] => {
        if (node === undefined) return [];
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
        if (ts.isTemplateExpression(node)) return [[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")];
        if (ts.isParenthesizedExpression(node)) return literals(node.expression);
        if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return [...literals(node.left), ...literals(node.right)];
        return [];
      };
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && SHOWN.has(node.name.text)) {
          for (const text of literals(node.initializer)) flag(node, text);
        }
        if (ts.isJsxAttribute(node) && SHOWN_ATTRIBUTES.has(node.name.getText()) && node.initializer !== undefined) {
          if (ts.isStringLiteral(node.initializer)) flag(node, node.initializer.text);
          else if (ts.isJsxExpression(node.initializer)) for (const text of literals(node.initializer.expression)) flag(node, text);
        }
        if (ts.isJsxText(node)) {
          const text = node.text.trim();
          if (text !== "") flag(node, text);
        }
        if (ts.isJsxExpression(node) && ts.isJsxElement(node.parent)) {
          for (const text of literals(node.expression)) flag(node, text);
        }
        if (ts.isCallExpression(node)) {
          const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
          const at = name === null ? undefined : SHOWN_CALLS[name];
          if (at !== undefined) {
            for (const text of literals(node.arguments[at])) flag(node, text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(found).toEqual([]);
  });

  test("a message nobody uses is not kept in the catalog", () => {
    const sources = files(TUI, true).map((file) => readFileSync(file, "utf8")).join("\n");
    const used = new Set([...sources.matchAll(/\btr?\(\s*"([A-Za-z0-9_.]+)"/gu)].map((match) => match[1]!));
    // A key chosen at run time (a status word, a tab name) is named whole in a table the code reads.
    const named = new Set([...sources.matchAll(/"([a-z]+(?:\.[A-Za-z0-9_]+)+)"/gu)].map((match) => match[1]!));
    const unused = Object.keys(en).filter((key) => {
      const base = key.replace(/\.(zero|one|two|few|many|other)$/u, "");
      return !used.has(base) && !used.has(key) && !named.has(base) && !named.has(key);
    });
    expect(unused).toEqual([]);
  });
});
