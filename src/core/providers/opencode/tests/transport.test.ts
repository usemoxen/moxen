import { describe, expect, it } from "vitest";

import { newOpencodeMessageId, request } from "../transport.js";

describe("newOpencodeMessageId", () => {
  it("matches the server's msg_ + 12 hex + 14 base62 format", () => {
    for (let index = 0; index < 50; index += 1) {
      const id = newOpencodeMessageId();
      expect(id.startsWith("msg_")).toBe(true);
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    }
    const seen = new Set([newOpencodeMessageId(), newOpencodeMessageId(), newOpencodeMessageId()]);
    expect(seen.size).toBe(3);
  });
});

describe("request, when the server answers 503", () => {
  const unavailable = () => Object.assign(new Error("UnexpectedStatus"), { cause: { status: 503 } });

  it("tries a session setup call again, so the first message after the server was busy does not fail", async () => {
    let calls = 0;
    const result = await request(
      "session.create",
      async () => {
        calls += 1;
        if (calls < 3) throw unavailable();
        return "ses_1";
      },
      [0, 0, 0],
    );
    expect(result).toBe("ses_1");
    expect(calls).toBe(3);
  });

  it("gives up after its retries, with the 503 in the error", async () => {
    let calls = 0;
    await expect(
      request("session.create", async () => { calls += 1; throw unavailable(); }, [0, 0]),
    ).rejects.toThrow(/session\.create failed/);
    expect(calls).toBe(3);
  });

  it("never sends a prompt twice", async () => {
    let calls = 0;
    await expect(request("session.prompt", async () => { calls += 1; throw unavailable(); }, [0, 0])).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
