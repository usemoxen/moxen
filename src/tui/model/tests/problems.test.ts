import { describe, expect, it } from "vitest";

import { configResetKey, problemRows } from "../problems.js";

describe("problem rows", () => {
  it("points ledger problems at their file and line, and config problems at their entry", () => {
    const rows = problemRows(
      [{
        id: "ledger-line|/s/threads/t/messages.jsonl|2||",
        kind: "ledger-line",
        threadId: "t",
        file: "/s/threads/t/messages.jsonl",
        line: 2,
        message: "Line 2 is bad.",
      }],
      "/s/config.json",
      [{ path: "speedMode", message: "speedMode must be standard or fast." }],
    );
    expect(rows).toMatchObject([
      { key: "ledger-line|/s/threads/t/messages.jsonl|2||", kind: "ledger-line", location: "/s/threads/t/messages.jsonl:2", quarantineId: "ledger-line|/s/threads/t/messages.jsonl|2||" },
      { key: "config:speedMode", kind: "config", location: "speedMode", resetKey: "speedMode", copyText: "/s/config.json" },
    ]);
  });

  it("stops stuck turns instead of quarantining them", () => {
    const [row] = problemRows(
      [{
        id: "turn-ownerless|/s/threads/t/turns.jsonl||t|u",
        kind: "turn-ownerless",
        threadId: "t",
        turnId: "u",
        file: "/s/threads/t/turns.jsonl",
        message: "Running with no owner.",
      }],
      "/s/config.json",
      [],
    );
    expect(row).toMatchObject({ stop: { threadId: "t", turnId: "u" } });
    expect(row).not.toHaveProperty("quarantineId");
  });

  it("addresses a reset only where a key reaches the bad entry", () => {
    expect(configResetKey("ui.theme")).toBe("ui.theme");
    expect(configResetKey("mcpServers.lab")).toBe("mcpServers[lab]");
    expect(configResetKey("providers.harness.profiles[broken]")).toBe("providers.harness.profiles[broken]");
    expect(configResetKey("providers.harness.profiles[1]")).toBeNull();
    expect(configResetKey("providers.harness")).toBeNull();
  });
});
