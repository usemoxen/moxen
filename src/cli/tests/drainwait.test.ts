/** What a draining `server stop` says while it waits (MXN-377). */
import { describe, expect, it } from "vitest";

import { drainWaitLine } from "../server.js";

describe("the waiting line a draining stop prints", () => {
  it("names the running turns and --force when there is something to wait for", () => {
    expect(drainWaitLine({ running: 0 })).toBeNull();
    expect(drainWaitLine({ running: 1 })).toContain("1 running turn");
    expect(drainWaitLine({ running: 2 })).toContain("--force");
  });
});
