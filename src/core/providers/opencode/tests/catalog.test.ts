import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  effortValuesOf,
  isFreeModel,
  isFreeOpencodeModel,
  loadModelsDevCatalog,
  parseModelsDevCatalog,
  presentApiKeyEnvs,
  AUTH_LIST_CACHE_TTL_MS,
  OPENCODE_AUTH_TRUST_MS,
  authForProvider,
  authTypesOf,
  clearStoredAuthCache,
  defaultAuthListRunner,
  readStoredAuth,
  readStoredAuthTypes,
  sameProviderId,
  storedAuthTypeFor,
  resolveModelsDevUrl,
  type AuthListRunner,
} from "../catalog.js";
import { tempDir } from "../../../testing/tmp.js";

const FIXTURE = {
  anthropic: {
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "anthropic/claude-opus-4-6": {
        name: "Claude Opus 4.6",
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }, { type: "toggle" }],
        cost: { input: 5, output: 25 },
      },
      "anthropic/plain": { name: "Plain", cost: { input: 0, output: 0 } },
    },
  },
  broken: null,
  noname: { env: [], models: {} },
};

describe("parseModelsDevCatalog", () => {
  it("parses providers defensively", () => {
    const catalog = parseModelsDevCatalog(FIXTURE);
    expect(catalog.map((provider) => provider.id).sort()).toEqual(["anthropic", "noname"]);
    const anthropic = catalog.find((provider) => provider.id === "anthropic");
    expect(anthropic?.name).toBe("Anthropic");
    expect(anthropic?.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(anthropic?.models.map((model) => model.id).sort()).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/plain",
    ]);
  });

  it("returns empty for non-objects", () => {
    expect(parseModelsDevCatalog(null)).toEqual([]);
    expect(parseModelsDevCatalog("nope")).toEqual([]);
    expect(parseModelsDevCatalog([])).toEqual([]);
  });
});

describe("effortValuesOf", () => {
  it("enumerates the first effort option only", () => {
    const catalog = parseModelsDevCatalog(FIXTURE);
    const opus = catalog.flatMap((provider) => provider.models).find((model) => model.id === "anthropic/claude-opus-4-6");
    expect(opus && effortValuesOf(opus)).toEqual(["low", "medium", "high"]);
    const plain = catalog.flatMap((provider) => provider.models).find((model) => model.id === "anthropic/plain");
    expect(plain && effortValuesOf(plain)).toEqual([]);
  });
});

describe("isFreeModel", () => {
  it("matches opencode's zero-input-cost rule and never missing data", () => {
    const catalog = parseModelsDevCatalog(FIXTURE);
    const models = catalog.flatMap((provider) => provider.models);
    expect(isFreeModel(models.find((model) => model.id === "anthropic/plain")!)).toBe(true);
    expect(isFreeModel(models.find((model) => model.id === "anthropic/claude-opus-4-6")!)).toBe(false);
    expect(isFreeModel({ id: "x", name: "X", reasoningOptions: [], cost: null })).toBe(false);
  });
});

describe("isFreeOpencodeModel", () => {
  it("bypasses only free models of the opencode provider (upstream public-key rule)", async () => {
    expect(await isFreeOpencodeModel("opencode", "muse-spark-1.3-contributor-free")).toBe(true);
    expect(await isFreeOpencodeModel("OpenCode", "muse-spark-1.3-contributor-free")).toBe(true);
    expect(await isFreeOpencodeModel("opencode", "claude-sonnet-4-6")).toBe(false);
    expect(await isFreeOpencodeModel("opencode", "no-such-model")).toBe(false);
    expect(await isFreeOpencodeModel("anthropic", "anything-free")).toBe(false);
  });
});

describe("presentApiKeyEnvs", () => {
  it("reports set env names only", () => {
    const catalog = parseModelsDevCatalog(FIXTURE);
    const anthropic = catalog.find((provider) => provider.id === "anthropic");
    expect(anthropic && presentApiKeyEnvs(anthropic, { ANTHROPIC_API_KEY: "k" })).toEqual(["ANTHROPIC_API_KEY"]);
    expect(anthropic && presentApiKeyEnvs(anthropic, {})).toEqual([]);
    expect(anthropic && presentApiKeyEnvs(anthropic, { ANTHROPIC_API_KEY: "  " })).toEqual([]);
  });
});

describe("resolveModelsDevUrl", () => {
  it("prefers the env override", () => {
    expect(resolveModelsDevUrl({})).toBe("https://models.opencode.ai");
    expect(resolveModelsDevUrl({ OPENCODE_MODELS_URL: "https://mirror.example" })).toBe("https://mirror.example");
  });
});

describe("readStoredAuthTypes", () => {
  const LIST = JSON.stringify([
    { id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] },
    { id: "openai", name: "OpenAI", connections: [{ type: "env", name: "OPENAI_API_KEY" }, { type: "oauth" }] },
    { id: "xai", name: "xAI", connections: [{ type: "env", name: "XAI_API_KEY" }] },
    { id: "azure", name: "Azure", connections: [] },
  ]);
  const GO_LOGIN = JSON.stringify([{ id: "opencode-go", name: "OpenCode Go", connections: [{ type: "credential", method: "key" }] }]);
  const OTHER_LOGIN = JSON.stringify([{ id: "anthropic", name: "Anthropic", connections: [{ type: "key" }] }]);
  const LOGIN = GO_LOGIN;
  const GO_TYPES = { "opencode-go": "api" };
  const LOGOUT = "[]";
  const MALFORMED = "[null]";
  const duplicateRows = (first: { id: string; type: string }, second: { id: string; type: string }) =>
    JSON.stringify([first, second].map((row) => ({ id: row.id, name: row.id, connections: [{ type: row.type }] })));
  const DUPLICATES = [
    duplicateRows({ id: "opencode-go", type: "key" }, { id: "OpenCode-Go", type: "oauth" }),
    duplicateRows({ id: "OpenCode-Go", type: "oauth" }, { id: "opencode-go", type: "key" }),
  ];

  it("maps v2 connection types onto api / oauth / env", async () => {
    expect(await readStoredAuthTypes({}, { run: async () => LIST, fresh: true })).toEqual({
      anthropic: "api",
      openai: "oauth",
      xai: "env",
    });
  });

  it("reads the integration API's credential/env connections the same way", async () => {
    expect(
      authTypesOf([
        { id: "openai", name: "OpenAI", methods: [], connections: [{ type: "credential", id: "c1", label: "x", method: "oauth" }] },
        { id: "anthropic", name: "A", methods: [], connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }, { type: "credential", id: "c2", label: "y", method: "key" }] },
        { id: "none", name: "N", methods: [], connections: [] },
      ]),
    ).toEqual({ openai: "oauth", anthropic: "api" });
  });

  it("runs the CLI with --standalone, asynchronously, through the given binary", async () => {
    const dir = tempDir("moxen-auth-list-");
    const log = path.join(dir, "args.log");
    const bin = path.join(dir, process.platform === "win32" ? "fake-opencode.cmd" : "fake-opencode");
    if (process.platform === "win32") fs.writeFileSync(bin, `@echo off\r\necho %* > "${log}"\r\necho [{"id":"xai","connections":[{"type":"key"}]}]\r\n`);
    else fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${log}"\necho '[{"id":"xai","connections":[{"type":"key"}]}]'\n`, { mode: 0o755 });
    const pending = readStoredAuthTypes(process.env, { binaryPath: bin, fresh: true });
    // Not spawnSync: the promise is returned before the child has been read.
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual({ xai: "api" });
    expect(fs.readFileSync(log, "utf8").trim()).toBe("auth list --format json --standalone");
  });

  it("degrades to empty on failure, bad JSON, or a wrong shape", async () => {
    expect(await readStoredAuthTypes({}, { run: async () => null, fresh: true })).toEqual({});
    expect(await readStoredAuthTypes({}, { run: async () => "not json", fresh: true })).toEqual({});
    expect(await readStoredAuthTypes({}, { run: async () => "{}", fresh: true })).toEqual({});
  });

  it("no longer reads OPENCODE_AUTH_CONTENT", async () => {
    const env = { OPENCODE_AUTH_CONTENT: JSON.stringify({ xai: { type: "oauth" } }) };
    expect(await readStoredAuthTypes(env, { run: async () => "[]", fresh: true })).toEqual({});
  });

  it("passes the configured binary and caches per binary for the TTL", async () => {
    clearStoredAuthCache();
    const calls: string[] = [];
    let clock = 1_000;
    const options = {
      binaryPath: "/opt/oc",
      now: () => clock,
      monotonic: () => clock,
      run: async (binary: string) => {
        calls.push(binary);
        return LIST;
      },
    };
    await readStoredAuthTypes({}, options);
    await readStoredAuthTypes({}, options);
    expect(calls).toEqual(["/opt/oc"]);
    clock += AUTH_LIST_CACHE_TTL_MS + 1;
    await readStoredAuthTypes({}, options);
    expect(calls).toEqual(["/opt/oc", "/opt/oc"]);
    clearStoredAuthCache();
  });

  describe("attempts and snapshots", () => {
    let clock = 1_000;
    let mono = 1_000;
    const at = () => clock;
    const monotonic = () => mono;
    // Wall and monotonic advance together unless a test rolls the wall back.
    const paths = { binaryPath: "/opt/oc", monotonic } as const;

    /** Deferred probes: `release(i)` finishes the i-th started call with its reply. */
    function controlledRuns(replies: ReadonlyArray<string | null>): {
      readonly run: AuthListRunner;
      readonly release: (index: number) => void;
      readonly calls: () => number;
    } {
      const releases: Array<() => void> = [];
      let started = 0;
      const run: AuthListRunner = async () => {
        const index = started++;
        await new Promise<void>((resolve) => {
          releases[index] = resolve;
        });
        return replies[index] ?? null;
      };
      return {
        run,
        release: (index: number) => {
          const release = releases[index];
          if (release === undefined) throw new Error(`probe ${index} has not started`);
          release();
        },
        calls: () => started,
      };
    }

    beforeEach(() => {
      clearStoredAuthCache();
      clock = 1_000;
      mono = 1_000;
    });
    afterEach(() => clearStoredAuthCache());

    it("B logout -> A login: B's confirmed logout stays", async () => {
      const runs = controlledRuns([LOGIN, LOGOUT]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      expect(await b).toMatchObject({ attempt: { seq: 2, outcome: "valid", completedAt: 1_000 }, go: { seq: 2, verifiedAt: 1_000, value: {} } });
      runs.release(0);
      const after = await a;
      expect(after.go).toMatchObject({ seq: 2, verifiedAt: 1_000, value: {} });
      expect(after.attempt).toMatchObject({ seq: 2, outcome: "valid", completedAt: 1_000 });
      expect(authForProvider(after, "opencode-go")).toMatchObject({ types: {}, verifiedAt: 1_000, answered: true });
    });

    it("B fails -> A logout: A's logout lands, answered false", async () => {
      const runs = controlledRuns([LOGOUT, null]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      expect(await b).toMatchObject({ attempt: { seq: 2, outcome: "failed" }, go: null });
      runs.release(0);
      const after = await a;
      expect(after.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: {} });
      expect(after.attempt).toMatchObject({ seq: 2, outcome: "failed" });
      expect(authForProvider(after, "opencode-go")).toMatchObject({ types: {}, verifiedAt: 1_000, answered: false });
    });

    it("A login -> B fails: the TTL serves unconfirmed without probing, and a retry confirms", async () => {
      const runs = controlledRuns([LOGIN, null, LOGIN]);
      // A starts first and confirms a login; B starts while A is still pending
      // and fails. A's completion cannot confirm a login under a pending B.
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(0);
      const first = await a;
      expect(first.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: GO_TYPES });
      expect(authForProvider(first, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
      runs.release(1);
      expect(authForProvider(await b, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });

      // Settled a second ago: the next read inside 15s serves the projection
      // without a probe — and it must not report the login as freshly confirmed.
      clock += 1_000;
      mono += 1_000;
      const hit = await readStoredAuth({}, { ...paths, now: at, run: runs.run });
      expect(authForProvider(hit, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
      expect(runs.calls()).toBe(2);

      // At expiry the retry can confirm again.
      clock += AUTH_LIST_CACHE_TTL_MS;
      mono += AUTH_LIST_CACHE_TTL_MS;
      const retry = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      expect(runs.calls()).toBe(3);
      runs.release(2);
      expect(authForProvider(await retry, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: clock, answered: true });
    });

    it("B login -> C fails -> A logout: B's login stays, unconfirmed", async () => {
      const runs = controlledRuns([LOGOUT, LOGIN, null]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      const c = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      await b;
      runs.release(2);
      await c;
      runs.release(0);
      const after = await a;
      expect(after.go).toMatchObject({ seq: 2, verifiedAt: 1_000, value: GO_TYPES });
      expect(after.attempt).toMatchObject({ seq: 3, outcome: "failed" });
      expect(authForProvider(after, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
    });

    it("A login -> any unreadable reply keeps A's snapshot, and [] still clears it", async () => {
      const login = await readStoredAuth({}, { ...paths, now: at, run: async () => GO_LOGIN });
      expect(authForProvider(login, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: true });
      // A failed process (null), invalid JSON, the wrong outer shape, nested
      // arrays and entries with no id are all unanswered, not a logout.
      const unreadable: Array<string | null> = [null, "not JSON", "{}", "[[]]", "[{}]", "[null]"];
      for (const reply of unreadable) {
        clock += AUTH_LIST_CACHE_TTL_MS + 1;
        mono += AUTH_LIST_CACHE_TTL_MS + 1;
        const after = await readStoredAuth({}, { ...paths, now: at, run: async () => reply });
        expect(after.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: GO_TYPES });
        expect(after.attempt.outcome, reply ?? "null").toBe("failed");
        expect(authForProvider(after, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
      }
      clock += AUTH_LIST_CACHE_TTL_MS + 1;
      mono += AUTH_LIST_CACHE_TTL_MS + 1;
      const cleared = await readStoredAuth({}, { ...paths, now: at, run: async () => LOGOUT });
      expect(authForProvider(cleared, "opencode-go")).toMatchObject({ types: {}, verifiedAt: clock, answered: true });
    });

    it("A login -> B [null]: A's snapshot is unchanged, unconfirmed", async () => {
      const runs = controlledRuns([LOGIN, MALFORMED]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(0);
      await a;
      clock += AUTH_LIST_CACHE_TTL_MS;
      mono += AUTH_LIST_CACHE_TTL_MS;
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      const after = await b;
      expect(after.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: GO_TYPES });
      expect(after.attempt).toMatchObject({ seq: 2, outcome: "failed" });
      expect(authForProvider(after, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
    });

    it.each(DUPLICATES)("rejects a reply with duplicate Go rows, either order", async (duplicate) => {
      const runs = controlledRuns([LOGIN, duplicate]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(0);
      await a;
      clock += AUTH_LIST_CACHE_TTL_MS;
      mono += AUTH_LIST_CACHE_TTL_MS;
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      const after = await b;
      expect(after.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: GO_TYPES });
      expect(after.attempt).toMatchObject({ seq: 2, outcome: "failed" });
      expect(authForProvider(after, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
    });

    it("B nonempty without Go -> A Go login: keep B for others, Go lands unconfirmed", async () => {
      const runs = controlledRuns([GO_LOGIN, OTHER_LOGIN]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      await b;
      runs.release(0);
      const after = await a;
      expect(after.others).toMatchObject({ seq: 2, verifiedAt: 1_000, value: { anthropic: "api" } });
      expect(after.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: GO_TYPES });
      expect(after.attempt).toMatchObject({ seq: 2, outcome: "valid" });
      expect(authForProvider(after, "anthropic")).toMatchObject({ types: { anthropic: "api" }, verifiedAt: 1_000, answered: true });
      expect(authForProvider(after, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
    });

    it("a wall-clock rollback does not extend the retry window or revive a login", async () => {
      const runs = controlledRuns([LOGIN, null]);
      const first = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(0);
      expect(authForProvider(await first, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: true });

      // The wall moves back a minute while the monotonic clock passes the
      // trust bound. A negative wall age must not count as fresh: the read
      // probes, and it does not serve the login as confirmed.
      clock -= 60_000;
      mono += OPENCODE_AUTH_TRUST_MS + 1;
      const again = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      expect(runs.calls()).toBe(2);
      runs.release(1);
      expect(authForProvider(await again, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
    });

    it("treats a negative monotonic age as expired, never fresh", async () => {
      const runs = controlledRuns([LOGIN, LOGIN]);
      const first = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(0);
      expect(authForProvider(await first, "opencode-go")).toMatchObject({ answered: true });
      mono -= 1_000;
      const again = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      expect(runs.calls()).toBe(2);
      runs.release(1);
      expect(authForProvider(await again, "opencode-go")).toMatchObject({ types: GO_TYPES, answered: true });
    });

    it("a cache clear makes an in-flight probe answer from the replacement state", async () => {
      const runs = controlledRuns([LOGIN, LOGOUT, LOGIN]);
      const obsolete = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      clearStoredAuthCache();
      const logout = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      const afterLogout = await logout;
      expect(authForProvider(afterLogout, "opencode-go")).toMatchObject({ types: {}, answered: true });
      runs.release(0);
      const stale = await obsolete;
      // The old caller sees the current state, not its pre-clear login.
      expect(authForProvider(stale, "opencode-go")).toMatchObject({
        types: {},
        verifiedAt: afterLogout.go?.verifiedAt ?? null,
        answered: true,
      });

      // Cleared with no replacement: the caller gets unknown, not its login.
      clock += AUTH_LIST_CACHE_TTL_MS;
      mono += AUTH_LIST_CACHE_TTL_MS;
      const orphan = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      clearStoredAuthCache();
      runs.release(2);
      expect(authForProvider(await orphan, "opencode-go")).toMatchObject({ types: {}, verifiedAt: null, answered: false });
    });

    it("A login -> B fails, then past the trust bound: the login stays usable and unconfirmed", async () => {
      const runs = controlledRuns([LOGIN, null]);
      const a = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(0);
      await a;
      clock += AUTH_LIST_CACHE_TTL_MS;
      mono += AUTH_LIST_CACHE_TTL_MS;
      const b = readStoredAuth({}, { ...paths, now: at, run: runs.run });
      runs.release(1);
      await b;

      clock += OPENCODE_AUTH_TRUST_MS + 1;
      mono += OPENCODE_AUTH_TRUST_MS + 1;
      const aged = await readStoredAuth({}, { ...paths, now: at, run: async () => null });
      expect(aged.go).toMatchObject({ seq: 1, verifiedAt: 1_000, value: GO_TYPES });
      expect(authForProvider(aged, "opencode-go")).toMatchObject({ types: GO_TYPES, verifiedAt: 1_000, answered: false });
    });
  });
});

describe("defaultAuthListRunner", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // POSIX only: the test proves the process group dies with its leader. On
  // Windows the tree is reaped by `taskkill /T /F`, whose async launch is
  // covered by the deadline-ordering test; the descendant/group semantics here
  // are POSIX.
  it.skipIf(process.platform === "win32")("answers before the group it reaps has exited, and reaps its descendants", async () => {
    const dir = tempDir("moxen-hang-");
    const marker = (name: string) => path.join(dir, name);
    const bin = path.join(dir, "opencode");
    // The leader and its descendant both ignore SIGTERM, so only the SIGKILL
    // escalation on the group can end them. The sleep is bounded so a broken
    // reaper cannot leave an orphan forever, and the marker says the handlers
    // are in place and both pids are written.
    fs.writeFileSync(
      bin,
      `#!/bin/sh\ntrap '' TERM\nsh -c "trap '' TERM; sleep 5" &\necho $! > "${marker("descendant.pid")}"\necho $$ > "${marker("leader.pid")}"\n: > "${marker("ready")}"\nwait\n`,
      { mode: 0o755 },
    );
    const result = defaultAuthListRunner(bin, {}, { timeoutMs: 800, killGraceMs: 150 });
    let leader: number | null = null;
    let descendant: number | null = null;
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // Readiness first: the pids exist and the TERM handlers are installed.
      const readyBy = Date.now() + 3_000;
      while (!fs.existsSync(marker("ready"))) {
        if (Date.now() > readyBy) throw new Error("probe stub never became ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      leader = Number(fs.readFileSync(marker("leader.pid"), "utf8").trim());
      descendant = Number(fs.readFileSync(marker("descendant.pid"), "utf8").trim());
      expect(await result).toBeNull();
      // The answer is out while both are still alive: the deadline does not
      // wait for the reaper.
      expect(alive(leader)).toBe(true);
      expect(alive(descendant)).toBe(true);
      const goneBy = Date.now() + 3_000;
      while ((alive(leader) || alive(descendant)) && Date.now() < goneBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The SIGKILL escalation on the group reaps both.
      expect(alive(leader)).toBe(false);
      expect(alive(descendant)).toBe(false);
    } finally {
      // Whatever happened above, this test's processes must be gone: kill the
      // group and the descendant, then prove it.
      const kill = (pid: number, signal: NodeJS.Signals) => {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      };
      if (leader !== null) kill(-leader, "SIGKILL");
      if (leader !== null) kill(leader, "SIGKILL");
      if (descendant !== null) kill(descendant, "SIGKILL");
      const goneBy = Date.now() + 1_000;
      while (((leader !== null && alive(leader)) || (descendant !== null && alive(descendant))) && Date.now() < goneBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (leader !== null) expect(alive(leader)).toBe(false);
      if (descendant !== null) expect(alive(descendant)).toBe(false);
    }
  });
});

describe("provider id aliases", () => {
  it("treats the v1 and v2 spellings as one provider", () => {
    expect(sameProviderId("azure-cognitive-services", "azure")).toBe(true);
    expect(sameProviderId("google-vertex-anthropic", "Google-Vertex")).toBe(true);
    expect(sameProviderId("azure", "openai")).toBe(false);
    expect(storedAuthTypeFor({ azure: "api" }, "azure-cognitive-services")).toBe("api");
    expect(storedAuthTypeFor({ "google-vertex-anthropic": "oauth" }, "google-vertex")).toBe("oauth");
    expect(storedAuthTypeFor({}, "azure")).toBeUndefined();
  });
});

describe("loadModelsDevCatalog", () => {
  const text = JSON.stringify(FIXTURE);

  function tmpCache(): string {
    const dir = tempDir("moxen-models-");
    return path.join(dir, "models.json");
  }

  it("uses a fresh cache without fetching", async () => {
    const cachePath = tmpCache();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, text);
    const loaded = await loadModelsDevCatalog({
      cachePath,
      snapshotText: null,
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as typeof fetch,
    });
    expect(loaded.source).toBe("cache");
    expect(loaded.catalog.length).toBe(2);
  });

  it("fetches live when the cache is stale and caches the result", async () => {
    const cachePath = tmpCache();
    const loaded = await loadModelsDevCatalog({
      cachePath,
      snapshotText: null,
      fetchImpl: (async () => ({ ok: true, text: async () => text }) as Response) as typeof fetch,
    });
    expect(loaded.source).toBe("live");
    expect(loaded.catalog.length).toBe(2);
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it("falls back to the snapshot when live fails", async () => {
    const loaded = await loadModelsDevCatalog({
      cachePath: path.join(os.tmpdir(), "moxen-models-missing", "models.json"),
      snapshotText: text,
      fetchImpl: (async () => ({ ok: false, status: 500, text: async () => "" }) as Response) as typeof fetch,
    });
    expect(loaded.source).toBe("snapshot");
    expect(loaded.catalog.length).toBe(2);
  });

  it("reports empty when everything fails", async () => {
    const loaded = await loadModelsDevCatalog({
      cachePath: path.join(os.tmpdir(), "moxen-models-missing", "models.json"),
      snapshotText: "garbage",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(loaded).toEqual({ catalog: [], source: "empty" });
  });
});

/**
 * Finding 3 of the MXN-402 review: the escalation timer must outlive a
 * one-shot caller. Driven as a real child process, because the bug only shows
 * up when the caller exits — fake timers cannot reproduce an exit.
 */
describe("reaping survives a one-shot caller exiting (MXN-402)", () => {
  const BUN = process.versions.bun ? process.execPath : "bun";
  const alivePid = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return (cause as { code?: string }).code === "EPERM";
    }
  };
  const runner = fileURLToPath(new URL("../catalog.ts", import.meta.url));

  it.skipIf(process.platform === "win32")(
    "signals SIGKILL to a SIGTERM-ignoring probe after the caller has exited",
    { timeout: 30_000 },
    async () => {
      const dir = tempDir("moxen-oneshot-");
      const pidFile = path.join(dir, "probe.pid");
      const bin = path.join(dir, "opencode");
      // Ignores SIGTERM, so only the SIGKILL escalation can end it, and writes
      // its pid so the test can prove it died after the caller had exited.
      fs.writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nsleep 30\n`, { mode: 0o755 });
      const caller = path.join(dir, "caller.ts");
      fs.writeFileSync(
        caller,
        [
          `import { defaultAuthListRunner } from ${JSON.stringify(runner)};`,
          // A grace far longer than the caller's own work, so only a timer
          // that holds the loop open can carry the SIGKILL out.
          `const answer = await defaultAuthListRunner(${JSON.stringify(bin)}, {}, { timeoutMs: 200, killGraceMs: 1_200 });`,
          `console.log("answer", answer);`,
        ].join("\n"),
      );
      const exited = new Promise<number | null>((resolve) => {
        const proc = spawn(BUN, [caller], { stdio: ["ignore", "pipe", "inherit"] });
        proc.once("exit", (code) => resolve(code));
      });
      const code = await exited;
      expect(code).toBe(0);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      // The caller is gone; the probe must be too, within the grace.
      await vi.waitFor(() => expect(alivePid(pid)).toBe(false), { timeout: 5_000 });
    },
  );
});
