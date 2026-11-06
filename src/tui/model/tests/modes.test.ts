import { describe, expect, it } from "vitest";

import { nextInteractionMode, parseModeCommand } from "../modes.js";

describe("parseModeCommand", () => {
  it("reads a command with text as that prompt's mode", () => {
    expect(parseModeCommand("/research what changed?")).toEqual({ mode: "research", rest: "what changed?" });
    expect(parseModeCommand("/orchestrate split it\nin two")).toEqual({ mode: "orchestrate", rest: "split it\nin two" });
    expect(parseModeCommand("/review PR 42, starting with auth")).toEqual({ mode: "review", rest: "PR 42, starting with auth" });
  });

  it("reads a command alone as one with nothing to send", () => {
    expect(parseModeCommand("/research")).toEqual({ mode: "research", rest: "" });
    expect(parseModeCommand("  /orchestrate  ")).toEqual({ mode: "orchestrate", rest: "" });
    expect(parseModeCommand("/review")).toEqual({ mode: "review", rest: "" });
  });

  it("leaves other drafts alone", () => {
    expect(parseModeCommand("research this")).toBeNull();
    expect(parseModeCommand("/researcher")).toBeNull();
    expect(parseModeCommand("/reviewer")).toBeNull();
    expect(parseModeCommand("/plan x")).toBeNull();
  });
});

describe("nextInteractionMode", () => {
  it("cycles Build, Research, Orchestrate, never stopping on Review", () => {
    expect(nextInteractionMode("default")).toBe("research");
    expect(nextInteractionMode("research")).toBe("orchestrate");
    expect(nextInteractionMode("orchestrate")).toBe("default");
  });
});
