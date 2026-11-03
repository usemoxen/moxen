import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { ClaudeDriver } from "../../providers/claude/driver.js";
import { FakeTransport, initMessage } from "../../providers/claude/tests/fakes.js";
import { CodexDriver } from "../../providers/codex/driver.js";
import { FakeCodexTransport } from "../../providers/codex/tests/fakes.js";
import { OpenCodeDriver } from "../../providers/opencode/driver.js";
import { FakeOpencodeTransport } from "../../providers/opencode/tests/fakes.js";
import { discoverSkills } from "../../providers/harness/skills.js";
import { SKILL_ROUTING_FILE } from "../routing.js";

it.each(["claude", "codex", "opencode", "harness"] as const)("delivers a skill limited to %s only to that provider's sessions, leaving unrestricted skills alone", async (provider) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-skill-delivery-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const claudeTransport = new FakeTransport([[initMessage()], [initMessage()]]);
  claudeTransport.commands = [{ name: "restricted-display", description: "Only one provider.", argumentHint: "" }, { name: "unrestricted", description: "Every provider.", argumentHint: "" }];
  const inherited = { name: "already-disabled", enabled: false };
  const codexTransport = new FakeCodexTransport({ config: { skills: { config: [inherited] } } });
  const opencodeTransport = new FakeOpencodeTransport();
  const claudeHome = path.join(root, "claude-config");
  const claude = new ClaudeDriver({ transport: claudeTransport, settings: { homePath: claudeHome } });
  const codex = new CodexDriver({ transport: codexTransport });
  const opencode = new OpenCodeDriver({ transport: opencodeTransport });
  const input = { threadId: "routing-test", workingDirectory: cwd };
  try {
    // An ancestor package exercises the roots native providers discover above cwd too.
    for (const name of ["restricted", "unrestricted"]) {
      const dir = path.join(root, ".agents", "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name === "restricted" ? "restricted-display" : name}\ndescription: A procedure.\n---\nRead the guide.`);
    }
    const restricted = path.join(root, ".agents", "skills", "restricted");
    await writeFile(path.join(restricted, SKILL_ROUTING_FILE), JSON.stringify({ providers: [provider] }));
    await mkdir(cwd);
    await Effect.runPromise(claude.startSession(input));
    const options = claudeTransport.created.at(-1)!.options;
    const denies = options.disallowedTools ?? [];
    expect(denies.includes("Skill(restricted-display)")).toBe(provider !== "claude");
    expect(denies).not.toContain("Skill(unrestricted)");
    expect(options.skills).toEqual(provider === "claude" ? undefined : ["unrestricted"]);
    expect(claudeTransport.created[0]!.options.env?.["CLAUDE_CONFIG_DIR"]).toBe(claudeHome);
    await Effect.runPromise(codex.startSession(input));
    const config = (codexTransport.sessions[0]!.server.requestsTo("thread/start")[0]!.params as { config: Record<string, unknown> }).config;
    const disabled = config["skills.config"] ?? [];
    expect(disabled).toEqual(provider === "codex" ? [] : [inherited, { path: path.join(restricted, "SKILL.md"), enabled: false }]);
    await Effect.runPromise(opencode.startSession(input));
    const updates = opencodeTransport.servers[0]!.calls.filter((call) => call.method === "session.update");
    expect(updates.map((call) => call.args)).toEqual(provider === "opencode" ? [] : [{ sessionID: "opencode-session-1", permissions: [{ action: "skill", resource: "restricted", effect: "deny" }] }]);
    // Harness's own discovery is cwd-scoped, so use the package root for its session catalog.
    expect(discoverSkills({ cwd: root, home }).map((skill) => skill.name)).toEqual(provider === "harness" ? ["restricted-display", "unrestricted"] : ["unrestricted"]);
  } finally {
    await Effect.runPromise(claude.stopSession(input.threadId));
    await Effect.runPromise(codex.stopSession(input.threadId));
    await Effect.runPromise(opencode.stopSession(input.threadId));
    await rm(root, { recursive: true, force: true });
  }
});
