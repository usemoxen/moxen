import { UNTRUSTED_NOTE } from "../../untrusted.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withModeChange } from "../modes.js";
import { TASK_NOTIFICATION_GUIDANCE, CHECKLIST_GUIDANCE, NO_REDELEGATION_GUIDANCE, OPENCODE_SUBAGENT_GUIDANCE, PROGRESS_GUIDANCE, INSTRUCTIONS_UPDATE_GUIDANCE, MODE_GUIDANCE, planInstructions, withInstructionsUpdate, RESEARCH_GUIDANCE, SHELL_GUIDANCE, buildRuntimeInstructions, harnessName, projectInstructions } from "../instructions.js";

const LOCAL = { mode: "local" as const, path: "/repo", branch: "main" };
const WORKTREE = { mode: "worktree" as const, path: "/store/worktrees/t1", branch: "moxen/t1" };
const CLAUDE = "claudeAgent";

describe("runtime instructions", () => {
  it("tells every session it runs through Moxen, in its own harness, and names no model", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL });
    expect(text).toBe(
      "In case you're asked: you are running in Moxen, a terminal app that runs coding agents as threads, " +
        "through the Claude Code harness. No need to mention this otherwise.\n\n" +
        RESEARCH_GUIDANCE +
        "\n\n" +
        PROGRESS_GUIDANCE +
        "\n\n" +
        SHELL_GUIDANCE +
        "\n\n" +
        INSTRUCTIONS_UPDATE_GUIDANCE +
        "\n\n" +
        MODE_GUIDANCE +
        "\n\n" +
        UNTRUSTED_NOTE,
    );
    expect(RESEARCH_GUIDANCE).toContain("read the official documentation");
    // The mistakes it exists for: an unquoted glob in zsh, GNU flags on BSD sed, a heredoc in fish.
    expect(SHELL_GUIDANCE).toContain("--include='*.ts'");
    expect(SHELL_GUIDANCE).toContain("sed -i ''");
    expect(SHELL_GUIDANCE).toContain("fish is not POSIX");
    expect(buildRuntimeInstructions({ instanceId: "opencode/anthropic", env: LOCAL, userInstructions: ["  ", ""] })).toContain(
      "through the OpenCode harness.",
    );
  });

  it("explains the task notification only to a session that has the delegation tools and is not itself delegated", () => {
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, delegationTools: true })).toContain(TASK_NOTIFICATION_GUIDANCE);
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL })).not.toContain("<task-notification>");
    const delegation = { parentTitle: "Parent", baseBranch: null };
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, delegationTools: true, delegation })).not.toContain("<task-notification>");
  });

  it("tells an OpenCode session to run its subagents in the background, and no other harness", () => {
    expect(OPENCODE_SUBAGENT_GUIDANCE).toContain("background: true");
    for (const instanceId of ["opencode", "opencode/anthropic"]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL })).toContain(OPENCODE_SUBAGENT_GUIDANCE);
    }
    for (const instanceId of [CLAUDE]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL })).not.toContain("background: true");
    }
  });

  it("tells an OpenCode session how to keep its checklist, and no harness that has its own", () => {
    for (const instanceId of ["opencode", "opencode/anthropic"]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL })).toContain(CHECKLIST_GUIDANCE);
    }
    for (const instanceId of [CLAUDE]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL })).not.toContain(CHECKLIST_GUIDANCE);
    }
    // The three habits it is there to build.
    expect(CHECKLIST_GUIDANCE).toContain("exactly one item in_progress");
    expect(CHECKLIST_GUIDANCE).toContain("the moment a step is done");
    expect(CHECKLIST_GUIDANCE).toContain("never save the updates for the end");
  });

  it("plans instructions so a conversation's system prompt never changes after it began", () => {
    // No history: the current text starts it, and there is nothing to update.
    expect(planInstructions(undefined, "A")).toEqual({ systemPrompt: "A", update: null, next: { baseline: "A", delivered: "A" } });
    // History begun on A, text now B: the prompt stays A and B is the update.
    expect(planInstructions({ baseline: "A", delivered: "A" }, "B")).toEqual({ systemPrompt: "A", update: "B", next: { baseline: "A", delivered: "A" } });
    // B delivered: nothing more to say while it holds, and a later C is the next update.
    expect(planInstructions({ baseline: "A", delivered: "B" }, "B")).toMatchObject({ systemPrompt: "A", update: null });
    expect(planInstructions({ baseline: "A", delivered: "B" }, "C")).toMatchObject({ systemPrompt: "A", update: "C" });
    // Back to the original text after an update still reads as a change: the model last saw B.
    expect(planInstructions({ baseline: "A", delivered: "B" }, "A")).toMatchObject({ systemPrompt: "A", update: "A" });
  });

  it("tells every session what a <moxen-mode> block is, in the words the block itself opens with", () => {
    for (const instanceId of [CLAUDE, "opencode/anthropic"]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL })).toContain(MODE_GUIDANCE);
    }
    // The guidance names the very tag the block opens with, so the two cannot drift apart unseen.
    expect(MODE_GUIDANCE).toContain("<moxen-mode>");
    const block = withModeChange("hi", "Research mode is on.", "research");
    expect(block.startsWith('<moxen-mode key="moxen-research">')).toBe(true);
    expect(block).toContain("This comes from Moxen, not from the person you are talking to");
    // And it says where it comes from, what replaces it, and that a mode does not change mid-turn.
    expect(MODE_GUIDANCE).toContain("not from the person you are talking to");
    expect(MODE_GUIDANCE).toContain("replaces any earlier <moxen-mode> block");
    expect(MODE_GUIDANCE).toContain("cannot change while you are working on a turn");
  });

  it("tells every session what a <moxen-instructions-update> block is, in the words the block itself opens with", () => {
    for (const instanceId of [CLAUDE, "opencode/anthropic"]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL })).toContain(INSTRUCTIONS_UPDATE_GUIDANCE);
    }
    // The guidance names the very tag the block opens with, so the two cannot drift apart unseen.
    expect(INSTRUCTIONS_UPDATE_GUIDANCE).toContain("<moxen-instructions-update>");
    expect(withInstructionsUpdate("hi", "X").startsWith("<moxen-instructions-update>")).toBe(true);
    // And it says where it comes from and what to do with it.
    expect(INSTRUCTIONS_UPDATE_GUIDANCE).toContain("not from the person you are talking to");
  });

  it("puts an update ahead of the prompt for the provider, and leaves a prompt with none alone", () => {
    expect(withInstructionsUpdate("hello", null)).toBe("hello");
    const text = withInstructionsUpdate("hello", "Use pnpm.");
    expect(text.startsWith("<moxen-instructions-update>")).toBe(true);
    expect(text).toContain("Use pnpm.");
    expect(text.endsWith("</moxen-instructions-update>\n\nhello")).toBe(true);
  });

  it("names each provider's harness the way its users do", () => {
    expect(harnessName("claudeAgent")).toBe("Claude Code");
    expect(harnessName("opencode/openai")).toBe("OpenCode");
    expect(harnessName("somethingNew")).toBe("somethingNew");
  });

  it("tells a worktree session where it runs", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, env: WORKTREE });
    expect(text).toContain("/store/worktrees/t1");
    expect(text).toContain("moxen/t1");
  });

  it("tells a delegated task it reports back, and where to commit in its own worktree", () => {
    const text = buildRuntimeInstructions({
      instanceId: CLAUDE,
      env: WORKTREE,
      delegation: { parentTitle: "Release prep", baseBranch: "main" },
    });
    expect(text).toContain('"Release prep"');
    expect(text).toContain("self-contained report");
    expect(text).toContain("cut from main");
    expect(text).toContain("Commit your work on moxen/t1");
  });

  it("tells a delegated task not to delegate or hand off, and leaves other sessions alone", () => {
    const delegated = buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, delegation: { parentTitle: "P", baseBranch: null } });
    expect(delegated).toContain(NO_REDELEGATION_GUIDANCE);
    expect(NO_REDELEGATION_GUIDANCE).toContain("moxen delegate");
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL })).not.toContain(NO_REDELEGATION_GUIDANCE);
  });

  it("warns a delegated task that shares the checkout", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, delegation: { parentTitle: "P", baseBranch: null } });
    expect(text).toContain("share the other agent's checkout");
    expect(text).not.toContain("Commit your work");
  });

  it("appends the user's instructions, config first then project", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, env: WORKTREE, userInstructions: ["Use pnpm.", "Never push."] });
    expect(text.indexOf("running in Moxen")).toBeLessThan(text.indexOf("moxen/t1"));
    expect(text.indexOf("moxen/t1")).toBeLessThan(text.indexOf("Use pnpm."));
    expect(text.indexOf("Use pnpm.")).toBeLessThan(text.indexOf("Never push."));
  });

  it("reads moxen.json instructions as a string or a list of lines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "moxen-instr-"));
    try {
      expect(await projectInstructions(dir)).toBeNull();
      await writeFile(path.join(dir, "moxen.json"), JSON.stringify({ instructions: "One rule." }));
      expect(await projectInstructions(dir)).toBe("One rule.");
      await writeFile(path.join(dir, "moxen.json"), JSON.stringify({ instructions: ["A.", "B."] }));
      expect(await projectInstructions(dir)).toBe("A.\nB.");
      await writeFile(path.join(dir, "moxen.json"), "{ not json");
      expect(await projectInstructions(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
