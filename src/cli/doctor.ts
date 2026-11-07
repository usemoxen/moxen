/**
 * `moxen doctor`: the server's diagnosis of the machine that runs provider
 * sessions (`core/diagnostics/doctor.ts`, via the `doctor` query), plus
 * the config file that server runs on and how this invocation reached it,
 * plus the bad records readers skipped (corrupt thread records and ledger
 * lines, stuck turns, config entries that failed to parse) with their
 * locations. `checks.problems` carries them additively for `--json`.
 *
 * Envelope: `{ ok, checks }`, with `checks` keeping its keys and their
 * order (node, git, providers, store, auth, config); `problems` and
 * `server` are added after them. Against a paired server on another
 * machine (`--server`), `server` says so — mode `remote`, its address,
 * name and key pin — and every other check describes that machine.
 */
import type { CliConfig } from "../core/types.js";
import { connectPairedServer, serverMode } from "../server/client.js";
import { defaultEndpoint, probe } from "../server/transport/endpoint.js";
import { activeRemoteServer, cliClient } from "./infra/client.js";

/**
 * Bad records as one list for the envelope: where each one is, never what
 * it holds (a config value may be a secret, a ledger line someone's text).
 */
export function describeProblems(configPath: string, configProblems: ReadonlyArray<{ path: string; message: string }>, storeProblems: ReadonlyArray<{ id: string; kind: string; threadId?: string; turnId?: string; file: string; line?: number; message: string }>) {
  return [
    ...configProblems.map((problem) => ({ source: "config" as const, id: `config:${problem.path}`, file: configPath, path: problem.path, message: problem.message })),
    ...storeProblems.map((problem) => ({ source: "store" as const, ...problem })),
  ];
}

export async function doctor(config: CliConfig) {
  const remote = activeRemoteServer();
  if (remote !== null) {
    const connection = await connectPairedServer(remote);
    try {
      const [diagnosis, read, store] = await Promise.all([
        connection.query({ type: "doctor" }),
        connection.query({ type: "config.read" }),
        connection.query({ type: "store.problems" }),
      ]);
      const { pairedServer: paired } = connection;
      const problems = describeProblems(read.path, read.problems, store.problems);
      const checks = {
        ...diagnosis,
        config: { ok: true, path: read.path, exists: read.exists },
        problems,
        server: { ok: true, mode: "remote" as const, endpoint: connection.endpoint, running: true, name: paired.name, fingerprint: paired.fingerprint },
      };
      return { ok: checks.git.ok && checks.store.ok && (checks.providers.codex?.ok || checks.providers.claude.ok || checks.providers.opencode.ok), checks };
    } finally {
      await connection.close();
    }
  }
  const endpoint = defaultEndpoint();
  const client = await cliClient(config);
  const [diagnosis, read, store, running] = await Promise.all([
    client.query({ type: "doctor" }),
    client.query({ type: "config.read" }),
    client.query({ type: "store.problems" }),
    probe(endpoint),
  ]);
  const problems = describeProblems(read.path, read.problems, store.problems);
  const checks = {
    ...diagnosis,
    config: { ok: true, path: read.path, exists: read.exists },
    problems,
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
