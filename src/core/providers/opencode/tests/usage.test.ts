import { describe, expect, it } from "vitest";

import { opencodeGoWindows, readOpencodeUsageLimits } from "../usage.js";

// The shape OpenCode 2.2.5 answers with (checked live), truncated to what matters.
const LIVE = {
  location: { directory: "/repo" },
  data: {
    workspace: { id: "wrk_1", name: "Personal", usageURL: "https://opencode.ai/console" },
    go: {
      rolling: { percent: 12, limited: false, resetsAt: 1_793_925_698_000 },
      weekly: { percent: 34, limited: false, resetsAt: 1_793_998_800_000 },
      monthly: { percent: 56, limited: false, resetsAt: 1_794_300_400_000 },
    },
    budgets: [],
  },
};

describe("opencodeGoWindows", () => {
  it("maps rolling, weekly and monthly to the session, weekly and monthly windows", () => {
    expect(opencodeGoWindows(LIVE)).toEqual([
      { id: "session", label: "Session", resetsAt: new Date(1_793_925_698_000).toISOString(), exhausted: false, usedPercent: 12 },
      { id: "weekly", label: "Weekly", resetsAt: new Date(1_793_998_800_000).toISOString(), exhausted: false, usedPercent: 34 },
      { id: "monthly", label: "Monthly", resetsAt: new Date(1_794_300_400_000).toISOString(), exhausted: false, usedPercent: 56 },
    ]);
  });

  it("counts limited as spent, whatever the percentage says", () => {
    const raw = { data: { go: { rolling: { percent: 40, limited: true, resetsAt: 1_793_925_698_000 }, weekly: { percent: 0, limited: true, resetsAt: 0 } } } };
    expect(opencodeGoWindows(raw)).toMatchObject([
      { id: "session", exhausted: true, usedPercent: 100, resetsAt: new Date(1_793_925_698_000).toISOString() },
      { id: "weekly", exhausted: true, usedPercent: 100, resetsAt: null },
    ]);
  });

  it("treats no data, no go, an empty go and a body of another shape as unknown", () => {
    expect(opencodeGoWindows({ location: {}, data: null })).toBeNull();
    expect(opencodeGoWindows({ data: { workspace: {}, budgets: [] } })).toBeNull();
    expect(opencodeGoWindows({ data: { go: {} } })).toBeNull();
    expect(opencodeGoWindows({ data: { go: { rolling: "12%" } } })).toBeNull();
    expect(opencodeGoWindows("not json")).toBeNull();
    expect(opencodeGoWindows(null)).toBeNull();
  });

  it("keeps the windows it could read when one meter is malformed", () => {
    const raw = { data: { go: { rolling: { percent: 7 }, weekly: { percent: null }, monthly: { limited: false } } } };
    expect(opencodeGoWindows(raw)).toEqual([
      { id: "session", label: "Session", resetsAt: null, exhausted: false, usedPercent: 7 },
    ]);
  });
});

describe("readOpencodeUsageLimits", () => {
  const headers = { authorization: "Basic test" };
  const respond = (answer: Partial<Response> & { json?: () => Promise<unknown> }) =>
    (async () => ({ ok: true, status: 200, json: async () => LIVE, ...answer }) as Response) as typeof fetch;
  const requested: string[] = [];
  const record = (response: typeof fetch): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      requested.push(String(url));
      expect(init?.headers).toMatchObject({ authorization: "Basic test" });
      return await response(url, init);
    }) as typeof fetch;

  it("asks the server it was given, scoped to the connection's directory", async () => {
    requested.length = 0;
    const windows = await readOpencodeUsageLimits("http://127.0.0.1:4100", "/repo", headers, record(respond({})));
    expect(windows).toHaveLength(3);
    const url = new URL(requested[0]!);
    expect(url.pathname).toBe("/api/experimental/usage/limits");
    expect(url.searchParams.get("location[directory]")).toBe("/repo");
  });

  it("answers unknown, without throwing, to a 404, a body that is not JSON, or no answer", async () => {
    expect(await readOpencodeUsageLimits("http://127.0.0.1:4100", "/repo", headers, record(respond({ ok: false, status: 404 })))).toBeNull();
    expect(await readOpencodeUsageLimits("http://127.0.0.1:4100", "/repo", headers, record(respond({ json: async () => { throw new Error("not json"); } })))).toBeNull();
    expect(await readOpencodeUsageLimits("http://127.0.0.1:4100", "/repo", headers, record((async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch))).toBeNull();
  });
});
