import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStandaloneExecutable, resolveAppRoot, standaloneMode, STANDALONE_DAEMON_ARG, STANDALONE_EMBEDDING_ARG, STANDALONE_MCP_ARG } from "../standalone.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moxen-standalone-"));
  roots.push(root);
  return root;
};

describe("standaloneMode", () => {
  it("maps each internal first argument to its mode and nothing else to the CLI", () => {
    expect(standaloneMode(["bun", "entry", STANDALONE_DAEMON_ARG])).toBe("daemon");
    expect(standaloneMode(["bun", "entry", STANDALONE_MCP_ARG])).toBe("mcp");
    expect(standaloneMode(["bun", "entry", STANDALONE_EMBEDDING_ARG])).toBe("embedding");
    expect(standaloneMode(["bun", "entry", "--version"])).toBeNull();
    expect(standaloneMode(["bun", "entry"])).toBeNull();
  });

  it("reads the user flags where a compiled binary puts them", () => {
    expect(standaloneMode(["bun", "/$bunfs/root/moxen", STANDALONE_DAEMON_ARG])).toBe("daemon");
  });
});

describe("isStandaloneExecutable", () => {
  it("is false for a test running under Bun", () => {
    expect(isStandaloneExecutable()).toBe(false);
  });
});

describe("resolveAppRoot", () => {
  it("walks up from a module to the folder holding package.json", () => {
    const root = temp();
    writeFileSync(path.join(root, "package.json"), "{}");
    expect(resolveAppRoot(path.join(root, "dist", "server"), "/nope", false)).toBe(root);
  });

  it("is null when no folder holds package.json", () => {
    expect(resolveAppRoot(path.parse(temp()).root, "/nope", false)).toBeNull();
  });

  it("is the executable's folder when standalone, and null without a package.json there", () => {
    const root = temp();
    expect(resolveAppRoot("/$bunfs/root/x", root, true)).toBeNull();
    writeFileSync(path.join(root, "package.json"), "{}");
    expect(resolveAppRoot("/$bunfs/root/x", root, true)).toBe(root);
  });
});
