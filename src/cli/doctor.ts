/**
 * `moxen doctor`: the server's diagnosis of the machine that runs provider
 * sessions (`core/diagnostics/doctor.ts`, via the `doctor` query), plus
 * the config file that server runs on and how this invocation reached it.
 *
 * Envelope: `{ ok, checks }`, with `checks` keeping its keys and their
 * order (node, git, providers, store, auth, config); `server` is added
 * after them. Against a paired server on another machine (`--server`),
 * `server` says so — mode `remote`, its address, name and key pin — and
 * every other check describes that machine.
 */
import type { CliConfig } from "../core/types.js";
import { connectPairedServer, serverMode } from "../server/client.js";
import { defaultEndpoint, probe } from "../server/transport/endpoint.js";
import { activeRemoteServer, cliClient } from "./infra/client.js";

export async function doctor(config: CliConfig) {
  const remote = activeRemoteServer();
  if (remote !== null) {
    const connection = await connectPairedServer(remote);
    try {
      const [diagnosis, read] = await Promise.all([connection.query({ type: "doctor" }), connection.query({ type: "config.read" })]);
      const { pairedServer: paired } = connection;
      const checks = {
        ...diagnosis,
        config: { ok: true, path: read.path, exists: read.exists },
        server: { ok: true, mode: "remote" as const, endpoint: connection.endpoint, running: true, name: paired.name, fingerprint: paired.fingerprint },
      };
      return { ok: checks.git.ok && checks.store.ok && (checks.providers.codex?.ok || checks.providers.claude.ok || checks.providers.opencode.ok), checks };
    } finally {
      await connection.close();
    }
  }
  const endpoint = defaultEndpoint();
  const client = await cliClient(config);
  const [diagnosis, read, running] = await Promise.all([client.query({ type: "doctor" }), client.query({ type: "config.read" }), probe(endpoint)]);
  const checks = {
    ...diagnosis,
    config: { ok: true, path: read.path, exists: read.exists },
    server: { ok: true, mode: serverMode(), endpoint, running },
  };
  const { providers } = checks;
  return {
    ok:
      checks.git.ok &&
      checks.store.ok &&
      (providers.codex?.ok || providers.claude.ok || providers.opencode.ok),
    checks,
  };
}
