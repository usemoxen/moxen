/**
 * `moxen update <claude|opencode|codex>`: runs that provider's own updater
 * (`claude update`, `opencode upgrade`, `codex update`) where the sessions run — on the shared
 * server when there is one, since that is the machine whose binary matters —
 * and reports the version before and after.
 */
import { CliError } from "../core/errors.js";
import { describeUpdate, UPDATABLE_PROVIDERS, type UpdatableProvider } from "../core/catalog/update.js";
import type { CliConfig } from "../core/types.js";
import { cliClient } from "./infra/client.js";

export function parseUpdatable(value: string): UpdatableProvider {
  const provider = UPDATABLE_PROVIDERS.find((candidate) => candidate === value);
  if (provider === undefined) {
    throw new CliError("INVALID_THREAD_OPTION", `Only ${UPDATABLE_PROVIDERS.join(" and ")} can be updated from moxen (got "${value}").`, { exitCode: 2 });
  }
  return provider;
}

export async function updateCommand(config: CliConfig, provider: UpdatableProvider) {
  const update = await (await cliClient(config)).dispatch({ type: "provider.update", provider });
  return { update, text: describeUpdate(update) };
}
