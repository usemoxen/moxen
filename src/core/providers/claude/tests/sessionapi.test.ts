/**
 * LOCAL-036: the SDK's standalone session helpers read the host process's
 * `CLAUDE_CONFIG_DIR`, which after a server restart holds no account's
 * folder — every saved session read as lost and the thread silently began
 * blank. These pin the account-folder lookup against the REAL SDK on
 * temporary config folders with fake session files. Nothing here touches
 * the real `~/.claude`: HOME/USERPROFILE point at a temporary home, so even
 * the unfixed lookup searches only temporary ground.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeDriver } from "../driver.js";
import { SdkSessionApi } from "../transport.js";
import { FakeSessionApi, FakeTransport, initMessage } from "./fakes.js";

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const previous = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
};
let tempRoot = "";
let fakeHome = "";

beforeEach(() => {
  tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "moxen-claude-sessionapi-")));
  fakeHome = path.join(tempRoot, "home");
  mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  for (const [key, value] of [
    ["CLAUDE_CONFIG_DIR", previous.configDir],
    ["HOME", previous.home],
    ["USERPROFILE", previous.userprofile],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

/** One account: a config folder holding one fake session transcript for `cwd`. */
function account(name: string, sessionId: string, promptText: string): { configDir: string; cwd: string; sessionId: string } {
  const configDir = path.join(tempRoot, name);
  const cwd = path.join(tempRoot, `${name}-repo`);
  mkdirSync(cwd, { recursive: true });
  // The SDK encodes the realpath'd working directory into the project folder name.
  const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    { type: "user", uuid: `${sessionId}-u`, sessionId, cwd, timestamp: at, parentUuid: null, isSidechain: false, message: { role: "user", content: [{ type: "text", text: promptText }] } },
    { type: "assistant", uuid: `${sessionId}-a`, sessionId, cwd, timestamp: at, parentUuid: `${sessionId}-u`, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Noted." }] } },
  ];
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { configDir, cwd, sessionId };
}

describe("SdkSessionApi account folder", () => {
  it("resumes a saved session from the account's own folder, as after a server restart (LOCAL-036)", async () => {
    const a = account("account-a", UUID_A, "Remember the number 7.");
    // The server process's env carries no account's folder.
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(await new SdkSessionApi(a.configDir).sessionExists(a.sessionId)).toBe(true);

    const transport = new FakeTransport([[initMessage({ session_id: a.sessionId })]]);
    const driver = new ClaudeDriver({
      settings: { homePath: a.configDir },
      env: { HOME: fakeHome, USERPROFILE: fakeHome },
      transport,
    });
    await Effect.runPromise(driver.startSession({ threadId: "t1", workingDirectory: a.cwd, resumeCursor: a.sessionId }));
    expect(transport.created[0]!.options.resume).toBe(a.sessionId);
    await Effect.runPromise(driver.stopAll());
  });

  it("inherits CLAUDE_CONFIG_DIR from the account env when homePath is unset", async () => {
    const a = account("account-a", UUID_A, "Remember the number 7.");
    const transport = new FakeTransport([[initMessage({ session_id: a.sessionId })]]);
    const driver = new ClaudeDriver({
      env: { HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: a.configDir },
      transport,
    });
    await Effect.runPromise(driver.startSession({ threadId: "t1", workingDirectory: a.cwd, resumeCursor: a.sessionId }));
    expect(transport.created[0]!.options.resume).toBe(a.sessionId);
    await Effect.runPromise(driver.stopAll());
  });

  it("two accounts' concurrent session calls never see each other's folders", async () => {
    const a = account("account-a", UUID_A, "Alpha task.");
    const b = account("account-b", UUID_B, "Beta task.");
    const apiA = new SdkSessionApi(a.configDir);
    const apiB = new SdkSessionApi(b.configDir);
    const [aOwn, bOwn, aCross, bCross, aMessages, bMessages] = await Promise.all([
      apiA.sessionExists(a.sessionId),
      apiB.sessionExists(b.sessionId),
      apiA.sessionExists(b.sessionId),
      apiB.sessionExists(a.sessionId),
      apiA.getSessionMessages(a.sessionId),
      apiB.getSessionMessages(b.sessionId),
    ]);
    expect([aOwn, bOwn, aCross, bCross]).toEqual([true, true, false, false]);
    expect(aMessages.length).toBeGreaterThan(0);
    expect(bMessages.length).toBeGreaterThan(0);

    // The mutating helpers stay in their own account too.
    await apiA.renameSession(a.sessionId, "Alpha title", a.cwd);
    expect(await apiA.sessionTitle(a.sessionId, a.cwd)).toBe("Alpha title");
    expect(await apiB.sessionTitle(a.sessionId, a.cwd)).toBeNull();
    const forked = await apiA.forkSession(a.sessionId);
    expect(forked.sessionId).not.toBe(a.sessionId);
    await expect(apiB.forkSession(a.sessionId)).rejects.toThrow();
    // The host env is left as it was found.
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();

    // Two drivers resuming at once — two accounts active in one server —
    // each resume their own session.
    const transportA = new FakeTransport([[initMessage({ session_id: a.sessionId })]]);
    const transportB = new FakeTransport([[initMessage({ session_id: b.sessionId })]]);
    const driverA = new ClaudeDriver({ settings: { homePath: a.configDir }, env: { HOME: fakeHome, USERPROFILE: fakeHome }, transport: transportA });
    const driverB = new ClaudeDriver({ settings: { homePath: b.configDir }, env: { HOME: fakeHome, USERPROFILE: fakeHome }, transport: transportB });
    await Promise.all([
      Effect.runPromise(driverA.startSession({ threadId: "ta", workingDirectory: a.cwd, resumeCursor: a.sessionId })),
      Effect.runPromise(driverB.startSession({ threadId: "tb", workingDirectory: b.cwd, resumeCursor: b.sessionId })),
    ]);
    expect(transportA.created[0]!.options.resume).toBe(a.sessionId);
    expect(transportB.created[0]!.options.resume).toBe(b.sessionId);
    await Promise.all([Effect.runPromise(driverA.stopAll()), Effect.runPromise(driverB.stopAll())]);
  });

  it("a lookup that itself fails keeps the saved cursor; a confirmed loss starts fresh", async () => {
    const throwing = new FakeSessionApi();
    throwing.sessionExists = async () => {
      throw new Error("transient lookup failure");
    };
    const transport = new FakeTransport([[initMessage()], [initMessage()]]);
    const driver = new ClaudeDriver({ transport, sessionApi: throwing, env: { HOME: fakeHome, USERPROFILE: fakeHome } });
    await Effect.runPromise(driver.startSession({ threadId: "t1", workingDirectory: tempRoot, resumeCursor: "saved-session" }));
    // A transient error is not proof of loss: the resume attempt decides.
    expect(transport.created[0]!.options.resume).toBe("saved-session");
    await Effect.runPromise(driver.stopAll());

    const gone = new FakeSessionApi(); // reports nothing existing
    const freshTransport = new FakeTransport([[initMessage()]]);
    const fresh = new ClaudeDriver({ transport: freshTransport, sessionApi: gone, env: { HOME: fakeHome, USERPROFILE: fakeHome } });
    await Effect.runPromise(fresh.startSession({ threadId: "t2", workingDirectory: tempRoot, resumeCursor: "saved-session" }));
    expect(freshTransport.created[0]!.options.resume).toBeUndefined();
    await Effect.runPromise(fresh.stopAll());
  });
});
