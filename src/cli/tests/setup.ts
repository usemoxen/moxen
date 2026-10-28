/**
 * Every test file, before anything else runs:
 *
 * - Never the developer's server. `MOXEN_SERVER_ENDPOINT` (which a moxen
 *   thread's own shell carries) and `MOXEN_SERVER` are replaced by an
 *   endpoint of this file's own, so a test — or a CLI subprocess it spawns,
 *   which inherits the environment — can only reach a server it started.
 *   One started there is stopped when the file is done.
 * - A CLI command a test runs in-process goes in-process on the test's own
 *   store, not to a server it would start (real drivers, a detached
 *   process). A test that wants the wire sets its own (`setClientFactory`).
 */
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

import { setTestClientDefault } from "../infra/client.js";
import { stopTestServer } from "./testserver.js";

const name = `moxen-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
process.env.MOXEN_SERVER_ENDPOINT = endpoint;
delete process.env.MOXEN_SERVER;

afterAll(() => stopTestServer(endpoint));

// Loaded on first use: most test files never run a CLI command, and the
// server side is too heavy to load into each of them for nothing.
setTestClientDefault(async (config, configPath, drivers) => {
  const { openClient } = await import("../../server/client.js");
  return await openClient({ mode: "direct", ...(drivers ? { drivers } : {}), ...(configPath ? { configPath } : { config }) });
});
