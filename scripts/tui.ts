/**
 * `bun run tui` (after `scripts/build.ts`): replace the moxen server with one
 * from the fresh build, then open the TUI on it.
 *
 * 1. Stop the server at this machine's endpoint, if any: ask it to shut down,
 *    and kill it by the pid it reported if it does not stop in time. Its
 *    turns end with it.
 * 2. Start a new server from `dist/server/daemon.js`, detached, and wait
 *    until it answers.
 * 3. Run the TUI on it. `MOXEN_SERVER=daemon` keeps the TUI on a server —
 *    never in-process — including after Switch server › This machine.
 *
 * Arguments are passed to `moxen tui` (`bun run tui --server <name>`).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { defaultEndpoint, probe } from "../src/server/transport/endpoint.js";
import { RemoteConnection } from "../src/server/transport/remote.js";

const dist = join(import.meta.dir, "..", "dist");
const endpoint = defaultEndpoint();

async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(150);
  }
  return false;
}

/** Who holds the socket, for a server too stuck to say (macOS/Linux; a Windows pipe has no `lsof`). */
function socketHolder(): number | null {
  if (process.platform === "win32") return null;
  const found = Bun.spawnSync(["lsof", "-t", endpoint]).stdout.toString().trim().split("\n")[0];
  const pid = Number(found);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : null;
}

async function askToStop(): Promise<number | null> {
  const connection = await RemoteConnection.connect(endpoint, { reconnect: false });
  const pid = connection.helloResult?.pid ?? null;
  await connection.shutdownServer().catch(() => undefined);
  await connection.close().catch(() => undefined);
  return pid;
}

async function stopServer(): Promise<void> {
  if (!(await probe(endpoint))) return;
  let pid: number | null = null;
  try {
    // A hung server can accept the connection and never answer the handshake.
    pid = await Promise.race([askToStop(), Bun.sleep(3_000).then(() => null)]);
  } catch {
    // Not answering properly: killed below.
  }
  pid ??= socketHolder();
  if (await until(async () => !(await probe(endpoint)), 5_000)) {
    console.log(`Stopped the moxen server${pid ? ` (pid ${pid})` : ""}.`);
    return;
  }
  if (pid === null) throw new Error(`The moxen server at ${endpoint} would not stop and did not say its pid; stop it by hand.`);
  process.kill(pid, "SIGKILL");
  if (!(await until(async () => !(await probe(endpoint)), 5_000))) {
    throw new Error(`Killed pid ${pid}, but something still answers at ${endpoint}.`);
  }
  console.log(`Killed the moxen server (pid ${pid}); it did not stop when asked.`);
}

async function startServer(): Promise<void> {
  const child = spawn(process.execPath, [join(dist, "server", "daemon.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, MOXEN_SERVER_ENDPOINT: endpoint },
  });
  child.unref();
  if (!(await until(() => probe(endpoint), 10_000))) {
    throw new Error(`Started a moxen server (pid ${child.pid}) but it never listened at ${endpoint}.`);
  }
  console.log(`Started a new moxen server (pid ${child.pid}).`);
}

await stopServer();
await startServer();
const tui = spawn(process.execPath, [join(dist, "cli", "index.js"), "tui", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, MOXEN_SERVER: "daemon" },
});
tui.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
