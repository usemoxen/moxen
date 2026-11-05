import { describe, expect, it } from "vitest";

import { parseScheduledTime } from "../scheduledtime.js";

describe("parseScheduledTime: the one reading of --at and the agents' queue tool", () => {
  // Built in local time on purpose: HH:MM is the machine's clock, whatever zone it is in.
  const now = new Date(2026, 5, 10, 14, 30, 0, 0);

  it("reads HH:MM as today while it is ahead, and as tomorrow once it has passed", () => {
    expect(parseScheduledTime("15:45", now)).toBe(new Date(2026, 5, 10, 15, 45).toISOString());
    expect(parseScheduledTime("9:05", now)).toBe(new Date(2026, 5, 11, 9, 5).toISOString());
    expect(parseScheduledTime("14:30", now)).toBe(new Date(2026, 5, 11, 14, 30).toISOString());
  });

  it("takes an ISO date-time as given, normalised", () => {
    expect(parseScheduledTime("2026-07-01T10:00:00+02:00", now)).toBe("2026-07-01T08:00:00.000Z");
  });

  it("refuses anything else in the CLI's words, naming the option it was given as", () => {
    expect(() => parseScheduledTime("soon", now)).toThrow("--at takes an ISO date-time or HH:MM.");
    expect(() => parseScheduledTime("soon", now, "at")).toThrow("at takes an ISO date-time or HH:MM.");
  });
});
