import { describe, expect, it } from "vitest";

import { linkNoticeText } from "../linkNotice.js";

const testvm = { name: "testvm", host: "192.168.1.236", port: 47317 };

describe("the server notice's words", () => {
  it("says this machine's server is restarting, then — still gone — how to start it", () => {
    const lost = { status: "reconnecting" as const, since: 0, attempts: 4, reason: "No moxen server is listening at /Users/me/.moxen/server.sock." };
    expect(linkNoticeText(lost, null, 5_000)).toEqual({ title: "Can't reach the moxen server", tone: "warn", detail: "It stopped or is restarting. Reconnecting as soon as it's back." });
    expect(linkNoticeText(lost, null, 60_000).detail).toBe("It isn't running. Start it (moxen server start) to reconnect.");
    expect(linkNoticeText(lost, null, 60_000).detail).not.toContain("/Users/me");
  });

  it("tells a frozen server from a gone one, and names a paired server by its address", () => {
    const frozen = { status: "reconnecting" as const, since: 0, attempts: 0, reason: "no reply for 15s" };
    expect(linkNoticeText(frozen, null, 1_000).detail).toMatch(/^It is running but not answering\./);
    const away = { status: "reconnecting" as const, since: 0, attempts: 2, reason: "No moxen server answered at 192.168.1.236:47317 (connect ETIMEDOUT)." };
    expect(linkNoticeText(away, testvm, 1_000)).toMatchObject({ title: "Can't reach testvm", detail: "No answer from 192.168.1.236:47317. Reconnecting as soon as it's back." });
  });

  it("says what a refusal means and what to do, never the raw message", () => {
    const refused = (code: string) => linkNoticeText({ status: "failed", reason: "raw message", code }, testvm);
    expect(refused("REMOTE_DEVICE_REFUSED")).toEqual({ title: "Disconnected from testvm", tone: "danger", detail: "This device is no longer paired there. Pair it again to reconnect." });
    expect(refused("REMOTE_KEY_MISMATCH").detail).toMatch(/key changed/);
    expect(refused("PROTOCOL_MISMATCH").detail).toMatch(/another moxen version/);
    expect(refused("SOMETHING_ELSE").detail).not.toContain("raw message");
  });
});
