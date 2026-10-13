import { describe, expect, it } from "vitest";

import { subagentRun, subagentState, type SubagentTranscript } from "../useSubagentView.js";

const transcript = (agent: SubagentTranscript["agent"]): SubagentTranscript => ({
  available: true,
  agent,
  messages: [{ id: "m" } as never],
  activities: [],
});
const agent = (status: string, stoppedAt: string | null = null) =>
  ({ agentId: "a", agentType: "explore", description: null, status, startedAt: "2026-10-07T16:58:00.000Z", stoppedAt }) as never;

describe("subagentRun", () => {
  it("tells the timeline a running subagent is running, from its own start", () => {
    expect(subagentRun(transcript(agent("running")))).toEqual({ status: "running", startedAt: "2026-10-07T16:58:00.000Z" });
  });

  it("calls a finished, stopped or unknown subagent idle", () => {
    expect(subagentRun(transcript(agent("completed", "2026-10-07T16:58:20.000Z"))).status).toBe("idle");
    expect(subagentRun(transcript(agent("stopped"))).status).toBe("idle");
    expect(subagentRun(transcript(null))).toEqual({ status: "idle", startedAt: null });
    expect(subagentRun(null)).toEqual({ status: "idle", startedAt: null });
  });

  it("agrees with the bar under it", () => {
    const now = Date.parse("2026-10-07T16:58:09.000Z");
    expect(subagentState(transcript(agent("running")), now)).toBe("running 9s");
  });
});
