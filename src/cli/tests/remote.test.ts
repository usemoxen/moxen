import { afterEach, describe, expect, it } from "vitest";

import { serverCwd, useRemoteServer } from "../infra/client.js";

afterEach(() => useRemoteServer(null));

describe("serverCwd", () => {
  it("sends this folder to this machine's server", () => {
    expect(serverCwd(undefined)).toBe(process.cwd());
    expect(serverCwd("/somewhere")).toBe("/somewhere");
  });

  it("never sends this machine's folder to a remote server", () => {
    useRemoteServer("winbox");
    expect(() => serverCwd(undefined)).toThrow(expect.objectContaining({ code: "REMOTE_CWD_REQUIRED" }));
    expect(serverCwd("C:\\Users\\me\\code")).toBe("C:\\Users\\me\\code");
    expect(serverCwd(undefined, { scratch: true })).toBe(".");
  });
});
