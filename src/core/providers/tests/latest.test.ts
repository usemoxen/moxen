import { afterEach, describe, expect, it } from "vitest";

import { updateState } from "../../catalog/update.js";
import { claudeChannel, forgetLatestVersions, latestVersions, type LatestDeps } from "../latest.js";

afterEach(() => forgetLatestVersions());

const DOCTOR = (channel: string) => `Claude Code doctor\n\nRunning: native (2.1.293)\nAuto-updates: enabled\nAuto-update channel: ${channel}\n`;

function world(tags: Record<string, string | null>, channel = "latest") {
  const urls: string[] = [];
  const deps: LatestDeps = {
    fetchJson: async (url) => {
      urls.push(url);
      const key = url.replace("https://registry.npmjs.org/", "");
      const version = tags[key];
      if (version === undefined) throw new Error("404");
      return version === null ? {} : { version };
    },
    run: async () => ({ stdout: DOCTOR(channel), exitCode: 0 }),
  };
  return { deps, urls };
}

describe("claudeChannel", () => {
  it("reads the channel an install follows from its doctor, and assumes latest when it does not say", async () => {
    expect(await claudeChannel("claude", async () => ({ stdout: DOCTOR("stable"), exitCode: 0 }))).toBe("stable");
    expect(await claudeChannel("claude", async () => ({ stdout: DOCTOR("latest"), exitCode: 0 }))).toBe("latest");
    expect(await claudeChannel("claude", async () => ({ stdout: "nothing useful", exitCode: 0 }))).toBe("latest");
    expect(await claudeChannel("claude", async () => { throw new Error("spawn"); })).toBe("latest");
  });
});

describe("latestVersions", () => {
  const TAGS = {
    "@anthropic-ai%2Fclaude-code/latest": "2.1.293",
    "@anthropic-ai%2Fclaude-code/stable": "2.1.285",
    "@opencode%2Fcli/latest": "2.0.24",
    "@openai%2Fcodex/latest": "0.164.0",
  };

  it("asks the registry for the channel the install follows, and for OpenCode's newest", async () => {
    const latest = world(TAGS, "latest");
    expect(await latestVersions({}, latest.deps)).toEqual({
      claude: { latest: "2.1.293", channel: "latest" },
      opencode: { latest: "2.0.24", channel: null },
      codex: { latest: "0.164.0", channel: null },
    });
    forgetLatestVersions();
    const stable = world(TAGS, "stable");
    expect((await latestVersions({}, stable.deps)).claude).toEqual({ latest: "2.1.285", channel: "stable" });
  });

  it("answers null for what it could not read, never an error", async () => {
    const offline = world({});
    expect(await latestVersions({}, offline.deps)).toEqual({
      claude: { latest: null, channel: "latest" },
      opencode: { latest: null, channel: null },
      codex: { latest: null, channel: null },
    });
    const garbage = world({ "@opencode%2Fcli/latest": null, "@anthropic-ai%2Fclaude-code/latest": "not a version" });
    const result = await latestVersions({}, garbage.deps);
    expect(result.claude.latest).toBeNull();
    expect(result.opencode.latest).toBeNull();
  });

  it("keeps an answer for a few minutes, and asks again for one it could not get", async () => {
    let clock = 0;
    const first = world(TAGS);
    await latestVersions({}, { ...first.deps, now: () => clock });
    const asked = first.urls.length;
    clock += 5 * 60_000;
    await latestVersions({}, { ...first.deps, now: () => clock });
    expect(first.urls.length).toBe(asked);
    clock += 6 * 60_000;
    await latestVersions({}, { ...first.deps, now: () => clock });
    expect(first.urls.length).toBe(asked * 2);

    forgetLatestVersions();
    const flaky = world({});
    await latestVersions({}, flaky.deps);
    const failures = flaky.urls.length;
    await latestVersions({}, flaky.deps);
    expect(flaky.urls.length).toBe(failures * 2);
  });
});

describe("updateState", () => {
  it("is available only when the install is behind, and unknown without both versions", () => {
    expect(updateState("2.1.292", "2.1.293")).toBe("available");
    expect(updateState("2.1.293", "2.1.293")).toBe("current");
    // An install that took `latest` on a `stable` channel is ahead of it: nothing to update to.
    expect(updateState("2.1.293", "2.1.285")).toBe("current");
    expect(updateState(null, "2.1.293")).toBe("unknown");
    expect(updateState("2.1.293", null)).toBe("unknown");
  });
});
