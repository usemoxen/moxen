import { UNTRUSTED_NOTE } from "../../untrusted.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withModeChange } from "../modes.js";
import { IMAGE_GUIDANCE, MESSAGES_GUIDANCE, TASK_NOTIFICATION_LINE, CHECKLIST_GUIDANCE, NO_REDELEGATION_GUIDANCE, OPENCODE_SUBAGENT_GUIDANCE, PROGRESS_GUIDANCE, MEMORY_GUIDANCE, planInstructions, withInstructionsUpdate, LOOKUP_GUIDANCE, buildRuntimeInstructions, harnessName, projectInstructions } from "../instructions.js";
import { buildShellGuidance, type ShellKind } from "../shells.js";

const LOCAL = { mode: "local" as const, path: "/repo", branch: "main" };
const WORKTREE = { mode: "worktree" as const, path: "/store/worktrees/t1", branch: "moxen/t1" };
const CLAUDE = "claudeAgent";
// Pinned so the expected text does not follow whatever machine runs the tests.
const LINUX = { platform: "linux" as const, shells: ["bash", "sh"] as readonly ShellKind[], login: "bash" as const };
const SHELL_TEXT = buildShellGuidance({ ...LINUX, harness: "Claude Code" });

describe("runtime instructions", () => {
  it("tells every session it runs in Moxen, leaves the harness to the provider's own prompt, and names no model", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, shell: LINUX });
    expect(text).toBe(
      "# Environment\n\n" +
        "In case you're asked: you are running in Moxen, a terminal app that runs coding agents as threads. " +
        "No need to mention this otherwise.\n\n" +
        "# Look it up\n\n" +
        LOOKUP_GUIDANCE +
        "\n\n" +
        "# Progress notes\n\n" +
        PROGRESS_GUIDANCE +
        "\n\n" +
        "# Showing images\n\n" +
        IMAGE_GUIDANCE +
        "\n\n" +
        "# Shell\n\n" +
        SHELL_TEXT +
        "\n\n" +
        "# Messages from Moxen\n\n" +
        MESSAGES_GUIDANCE +
        "\n\n" +
        UNTRUSTED_NOTE,
    );
    expect(LOOKUP_GUIDANCE).toContain("read the official documentation");
    // "Research" is a thread mode (`modes.ts`): this section is for every session, so it never says the word.
    expect(LOOKUP_GUIDANCE.toLowerCase()).not.toContain("research");
    // Each provider's own prompt names its harness, so the Environment section is the same for all
    // of them: it says the app and nothing that would repeat or contradict that.
    const opencode = buildRuntimeInstructions({ instanceId: "opencode/anthropic", env: LOCAL, shell: LINUX, userInstructions: ["  ", ""] });
    expect(opencode.startsWith("# Environment\n\nIn case you're asked: you are running in Moxen, a terminal app that runs coding agents as threads. No need to mention this otherwise.")).toBe(true);
    expect(opencode).not.toContain("OpenCode harness");
  });

  it("groups the instructions under headings, in the order a reader meets them", () => {
    const text = buildRuntimeInstructions({ instanceId: "opencode", env: LOCAL, shell: LINUX, memory: "write", checklist: true });
    const headings = [...text.matchAll(/^# (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(["Environment", "Look it up", "Progress notes", "Showing images", "Checklist", "Subagents", "Shell", "Messages from Moxen", "Memory"]);
    // Claude Code has its own checklist, so its sections are fewer.
    const claude = [...buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, shell: LINUX }).matchAll(/^# (.+)$/gm)].map((match) => match[1]);
    expect(claude).toEqual(["Environment", "Look it up", "Progress notes", "Showing images", "Shell", "Messages from Moxen"]);
  });

  it("keeps the memory rules as a lead line and one bullet per subject", () => {
    const [lead, ...bullets] = MEMORY_GUIDANCE.split("\n");
    expect(lead).toContain("persistent memory");
    expect(bullets.length).toBeGreaterThan(3);
    for (const bullet of bullets) expect(bullet.startsWith("- ")).toBe(true);
    expect(MEMORY_GUIDANCE).toContain("memory_read with no name returns the index");
  });

  it("says once where a message from Moxen comes from, and names every block it can carry", () => {
    // One provenance sentence for all three tags, not one per block.
    expect(MESSAGES_GUIDANCE.match(/not from the person you are talking to/g)).toHaveLength(1);
    expect(MESSAGES_GUIDANCE).toContain("<moxen-instructions-update>");
    expect(MESSAGES_GUIDANCE).toContain("<moxen-mode>");
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, shell: LINUX, delegationTools: true });
    expect(text).toContain("<task-notification>");
    // The tags the guidance names are the tags the blocks open with, so the two cannot drift apart unseen.
    expect(withInstructionsUpdate("hi", "X").startsWith("<moxen-instructions-update>")).toBe(true);
    expect(withModeChange("hi", "Research mode is on.", "research").startsWith('<moxen-mode key="moxen-research">')).toBe(true);
    expect(MESSAGES_GUIDANCE).toContain("replaces any earlier <moxen-mode> block");
    expect(MESSAGES_GUIDANCE).toContain("cannot change while you are working on a turn");
    expect(MESSAGES_GUIDANCE).toContain("it replaces the earlier version");
  });

  it("explains the task notification only to a session that has the delegation tools and is not itself delegated", () => {
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, shell: LINUX, delegationTools: true })).toContain(TASK_NOTIFICATION_LINE);
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, shell: LINUX })).not.toContain("<task-notification>");
    const delegation = { parentTitle: "Parent", baseBranch: null };
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, env: LOCAL, shell: LINUX, delegationTools: true, delegation })).not.toContain("<task-notification>");
  });

  it("tells an OpenCode session to run its subagents in the background, and no other harness", () => {
    expect(OPENCODE_SUBAGENT_GUIDANCE).toContain("background: true");
    for (const instanceId of ["opencode", "opencode/anthropic"]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL, shell: LINUX })).toContain(OPENCODE_SUBAGENT_GUIDANCE);
    }
    for (const instanceId of [CLAUDE]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL, shell: LINUX })).not.toContain("background: true");
    }
  });

  it("tells an OpenCode session how to keep its checklist, and no harness that has its own", () => {
    for (const instanceId of ["opencode", "opencode/anthropic"]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL, shell: LINUX })).toContain(CHECKLIST_GUIDANCE);
    }
    for (const instanceId of [CLAUDE]) {
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL, shell: LINUX })).not.toContain(CHECKLIST_GUIDANCE);
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
      expect(buildRuntimeInstructions({ instanceId, env: LOCAL, shell: LINUX })).toContain("<moxen-mode>: the user changed this thread's mode");
    }
    const block = withModeChange("hi", "Research mode is on.", "research");
    expect(block).toContain("This comes from Moxen, not from the person you are talking to");
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
    expect(harnessName("harness")).toBe("Moxen Harness");
    expect(harnessName("harness/local")).toBe("Moxen Harness");
    expect(harnessName("somethingNew")).toBe("somethingNew");
  });

  it("tells a worktree session where it runs", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, shell: LINUX, env: WORKTREE });
    expect(text).toContain("/store/worktrees/t1");
    expect(text).toContain("moxen/t1");
  });

  it("tells a delegated task it reports back, and where to commit in its own worktree", () => {
    const text = buildRuntimeInstructions({
      instanceId: CLAUDE,
      env: WORKTREE,
      shell: LINUX,
      delegation: { parentTitle: "Release prep", baseBranch: "main" },
    });
    expect(text).toContain('"Release prep"');
    expect(text).toContain("self-contained report");
    expect(text).toContain("cut from main");
    expect(text).toContain("Commit your work on moxen/t1");
  });

  it("tells a delegated task not to delegate or hand off, and leaves other sessions alone", () => {
    const delegated = buildRuntimeInstructions({ instanceId: CLAUDE, shell: LINUX, env: LOCAL, delegation: { parentTitle: "P", baseBranch: null } });
    expect(delegated).toContain(NO_REDELEGATION_GUIDANCE);
    expect(NO_REDELEGATION_GUIDANCE).toContain("moxen delegate");
    expect(buildRuntimeInstructions({ instanceId: CLAUDE, shell: LINUX, env: LOCAL })).not.toContain(NO_REDELEGATION_GUIDANCE);
  });

  it("warns a delegated task that shares the checkout", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, shell: LINUX, env: LOCAL, delegation: { parentTitle: "P", baseBranch: null } });
    expect(text).toContain("share the other agent's checkout");
    expect(text).not.toContain("Commit your work");
  });

  it("appends the user's instructions, config first then project", () => {
    const text = buildRuntimeInstructions({ instanceId: CLAUDE, shell: LINUX, env: WORKTREE, userInstructions: ["Use pnpm.", "Never push."] });
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
