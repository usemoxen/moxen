import { describe, expect, it } from "vitest";

import { describeProblems } from "../doctor.js";

describe("doctor problems", () => {
  it("lists store and config problems with their locations, never their values", () => {
    expect(
      describeProblems(
        "/home/user/.moxen/config.json",
        [{ path: "speedMode", message: "speedMode must be standard or fast." }],
        [{
          id: "ledger-line|/s/threads/t/messages.jsonl|2|t|",
          kind: "ledger-line",
          threadId: "t",
          file: "/s/threads/t/messages.jsonl",
          line: 2,
          message: "Line 2 is bad.",
        }],
      ),
    ).toEqual([
      { source: "config", id: "config:speedMode", file: "/home/user/.moxen/config.json", path: "speedMode", message: "speedMode must be standard or fast." },
      {
        source: "store",
        id: "ledger-line|/s/threads/t/messages.jsonl|2|t|",
        kind: "ledger-line",
        threadId: "t",
        file: "/s/threads/t/messages.jsonl",
        line: 2,
        message: "Line 2 is bad.",
      },
    ]);
  });
});
