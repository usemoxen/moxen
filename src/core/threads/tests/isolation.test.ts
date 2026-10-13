import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  isolationViolation,
  permissionEscapes,
  rawInputViolation,
  resolveIsolation,
  type WorktreeIsolation,
} from "../isolation.js";

const iso: WorktreeIsolation = { worktreeRoot: "/work/wt", protectedRoots: ["/work/main"] };
const call = (tool: string, input: unknown, cwd = "/work/wt") => isolationViolation(iso, { tool, input, cwd });

describe("isolation guard", () => {
  it("refuses what reaches the main checkout, allows the rest", () => {
    const refused: ReadonlyArray<readonly [string, unknown, string?]> = [
      ["Edit", { file_path: "/work/main/a.ts" }],
      ["Write", { file_path: "../main/a.ts" }],
      ["Bash", { command: "ls" }, "/work/main/src"],
      ["Bash", { command: "cd /work/main && git status" }],
      ["Bash", { command: "git -C /work/main reset --hard" }],
      ["Bash", { command: "GIT_DIR=/work/main/.git git log" }],
      ["Bash", { command: "git --work-tree=/work/main add ." }],
    ];
    for (const [tool, input, cwd] of refused) expect(call(tool, input, cwd), `${tool} ${JSON.stringify(input)}`).not.toBeNull();

    const allowed: ReadonlyArray<readonly [string, unknown]> = [
      ["Edit", { file_path: "/work/wt/a.ts" }],
      ["Edit", { file_path: "src/a.ts" }],
      ["Read", { file_path: "/work/main/a.ts" }],
      ["Bash", { command: "cd /work/wt/src && git status" }],
      ["Bash", { command: "echo /work/main is the other checkout" }],
    ];
    for (const [tool, input] of allowed) expect(call(tool, input), `${tool} ${JSON.stringify(input)}`).toBeNull();
  });

  it("allows a worktree that sits inside the checkout it was cut from", () => {
    const nested: WorktreeIsolation = { worktreeRoot: "/work/main/.claude/worktrees/a", protectedRoots: ["/work/main"] };
    const edit = (file: string) =>
      isolationViolation(nested, { tool: "Edit", input: { file_path: file }, cwd: nested.worktreeRoot });
    expect(edit("/work/main/.claude/worktrees/a/x.ts")).toBeNull();
    expect(edit("/work/main/x.ts")).not.toBeNull();
  });

  it("reads provider permission requests and unshaped tool input", () => {
    expect(permissionEscapes(iso, { action: "external_directory", resources: ["/work/main/*"] }, "/work/wt")).toBe(true);
    expect(permissionEscapes(iso, { action: "bash", resources: ["/work/main/*"] }, "/work/wt")).toBe(false);
    expect(rawInputViolation(iso, { path: "/work/main/a.ts", content: "cd /work/main" }, "/work/wt")).not.toBeNull();
    expect(rawInputViolation(iso, { path: "a.ts", content: "cd /work/main" }, "/work/wt")).toBeNull();
    expect(rawInputViolation(iso, { command: "git -C /work/main log" }, "/work/wt")).not.toBeNull();
  });
});

describe("resolveIsolation", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "moxen-iso-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the checkout a real worktree was cut from, and nothing for a shared one", async () => {
    const main = path.join(dir, "main");
    const wt = path.join(dir, "wt");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "task", wt);

    expect(await resolveIsolation({ mode: "worktree", path: wt, branch: "task" })).toEqual({
      worktreeRoot: wt,
      protectedRoots: [main],
    });
    expect(await resolveIsolation({ mode: "local", path: main, branch: "main" })).toBeNull();
  });
});
