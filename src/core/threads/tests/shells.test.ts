import { describe, expect, it } from "vitest";

import { buildShellGuidance, detectShells, type ShellKind } from "../shells.js";

const LINUX = { platform: "linux" as const, shells: ["bash", "sh"] as readonly ShellKind[], login: "bash" as const };
const MAC = { platform: "darwin" as const, shells: ["zsh", "bash", "sh"] as readonly ShellKind[], login: "zsh" as const };
const WINDOWS = { platform: "win32" as const, shells: ["pwsh", "powershell", "bash"] as readonly ShellKind[], login: null };

describe("shells", () => {
  it("lists the shells on the machine, the login shell first", () => {
    const onPath = new Set(["bash", "fish", "sh"]);
    const found = detectShells({ platform: "linux", env: { SHELL: "/usr/bin/fish" }, exists: (name) => onPath.has(name) });
    expect(found).toEqual({ platform: "linux", shells: ["fish", "bash", "sh"], login: "fish" });
    // No SHELL (a Windows process): PATH order decides, and nothing is called the login shell.
    expect(detectShells({ platform: "win32", env: {}, exists: (name) => name === "pwsh" || name === "cmd" })).toEqual({
      platform: "win32",
      shells: ["pwsh", "cmd"],
      login: null,
    });
    // A SHELL this never heard of is not a shell; a .exe path still names one.
    expect(detectShells({ env: { SHELL: "/opt/bin/elvish" }, exists: () => false })).toEqual({ platform: process.platform, shells: [], login: null });
    expect(detectShells({ env: { SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }, exists: () => true }).login).toBe("pwsh");
  });

  it("names the platform, its shells and what each one needs, and leaves the others out", () => {
    const mac = buildShellGuidance({ ...MAC, harness: "Claude Code" });
    expect(mac).toContain("This machine runs macOS");
    expect(mac).toContain("Its shells are zsh (the login shell), bash and sh.");
    expect(mac).toContain("zsh: a glob that matches nothing is an error");
    expect(mac).toContain("sh is POSIX only");
    expect(mac).not.toContain("fish");
    expect(mac).not.toContain("powershell");
    // macOS ships the BSD tools; Linux the GNU ones.
    expect(mac).toContain("The command-line tools are the BSD ones");
    expect(mac).toContain("sed -i '' 's/a/b/' file");
    const linux = buildShellGuidance({ ...LINUX, harness: "OpenCode" });
    expect(linux).toContain("This machine runs Linux");
    expect(linux).toContain("The command-line tools are GNU");
    expect(linux).not.toContain("sed -i ''");
  });

  it("tells a Windows session which shell its commands land in, per harness", () => {
    const claude = buildShellGuidance({ ...WINDOWS, harness: "Claude Code" });
    expect(claude).toContain("This machine runs Windows");
    expect(claude).toContain("Claude Code runs your commands in Git Bash");
    expect(claude).toContain("pwsh (PowerShell 7): `&&` and `||` work");
    expect(claude).toContain("powershell (Windows PowerShell 5.1) has no `&&` or `||`");
    expect(claude).toContain("Outside Git Bash, Windows has none of the POSIX tools");
    expect(claude).not.toContain("The command-line tools are the BSD ones");
    expect(buildShellGuidance({ ...WINDOWS, harness: "OpenCode" })).toContain("OpenCode runs your commands in PowerShell");
    // The Moxen Harness hands both shells to the model, so neither is the only one.
    expect(buildShellGuidance({ ...WINDOWS, harness: "harness" })).toContain("bash (Git Bash) and powershell as separate tools");
  });

  it("lets the shell do the job when it expresses it better than the tools do", () => {
    const linux = buildShellGuidance({ ...LINUX, harness: "OpenCode" });
    // The tools are the default, not a rule: a richer search, a pipeline or a bulk change is the shell's.
    expect(linux).toContain("those are the default, not a rule");
    expect(linux).toContain("When the shell expresses the job better");
    expect(linux).toContain("one pipeline answering across many files");
    expect(linux).toContain("one mechanical change across all of them");
  });

  it("offers the bash escape hatch only where bash is", () => {
    expect(buildShellGuidance({ ...MAC, harness: "Claude Code" })).toContain("hand it to bash explicitly");
    expect(buildShellGuidance({ platform: "win32", shells: ["powershell"], login: null, harness: "OpenCode" })).not.toContain("hand it to bash explicitly");
  });
});
