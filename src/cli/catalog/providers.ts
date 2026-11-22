import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";

import { selectModel, selectProvider, type ProviderSummary } from "../../core/catalog/summary.js";
import { CliError } from "../../core/errors.js";
import {
  ACCOUNT_PROVIDER_KINDS,
  type AccountProviderKind,
  type CliConfig,
  type ProviderAccountSaveInput,
} from "../../core/types.js";
import { activeRemoteServer, cliClient, serverCwd } from "../infra/client.js";
import { directAuth, directRuntime } from "../infra/direct.js";

export async function listProviders(config: CliConfig, options: { refresh?: boolean }) {
  void options;
  // Every call probes live sources; failures degrade into each entry's
  // `status`, so there is never a stale cache to refresh.
  const { providers } = await (await cliClient(config)).query({ type: "providers.list" });
  return { runtime: directRuntime(), auth: directAuth(), refreshed: true, providers: [...providers] };
}

/** Skills and slash commands one provider resolves for a directory (the cwd by default). */
export async function listSkills(config: CliConfig, options: { provider: string; cwd?: string }) {
  // A remote server resolves its own paths; only a local one is made absolute here.
  const cwd = activeRemoteServer() === null ? path.resolve(serverCwd(options.cwd)) : serverCwd(options.cwd);
  const inventory = await (await cliClient(config)).query({ type: "skills.list", instanceId: options.provider, cwd });
  return { runtime: directRuntime(), auth: directAuth(), provider: options.provider, cwd, ...inventory };
}

export async function listModels(
  config: CliConfig,
  options: { provider?: string; refresh?: boolean },
) {
  const { runtime, auth, refreshed, providers } = await listProviders(config, {
    ...(options.refresh === true ? { refresh: true } : {}),
  });
  const scoped: readonly ProviderSummary[] = options.provider === undefined
    ? providers
    : [selectProvider(providers, options.provider)];
  return {
    runtime,
    auth,
    refreshed,
    providers: scoped.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName,
      enabled: provider.enabled,
      models: provider.models,
    })),
  };
}

export async function listEfforts(
  config: CliConfig,
  options: { provider: string; model: string; refresh?: boolean },
) {
  const { runtime, auth, refreshed, providers } = await listProviders(config, {
    ...(options.refresh === true ? { refresh: true } : {}),
  });
  const provider = selectProvider(providers, options.provider);
  const model = selectModel(provider, options.model);
  return {
    runtime,
    auth,
    refreshed,
    provider: { instanceId: provider.instanceId, driver: provider.driver },
    model: { slug: model.slug, name: model.name, efforts: model.efforts },
  };
}

/**
 * Hide (or show) one model slug on one provider instance. Hidden models
 * stay selectable when named explicitly and stay visible when a thread
 * already runs on them — they only leave the pickers (`offerableModels`).
 * Writes `model-prefs.json` in the store root.
 */
export async function setModelHidden(
  config: CliConfig,
  options: { provider: string; model: string; hidden: boolean },
) {
  const client = await cliClient(config);
  const { providers } = await client.query({ type: "providers.list" });
  const provider = selectProvider([...providers], options.provider);
  const model = selectModel(provider, options.model);
  const { hidden } = await client.dispatch({
    type: "model.visibility.set",
    instanceId: provider.instanceId,
    model: model.slug,
    hidden: options.hidden,
  });
  return {
    provider: { instanceId: provider.instanceId },
    model: { slug: model.slug, name: model.name },
    hidden,
  };
}

export function parseAccountKind(value: string): AccountProviderKind {
  const normalized = value.trim().toLowerCase();
  const match = ACCOUNT_PROVIDER_KINDS.find((kind) => kind === normalized);
  if (!match) {
    throw new CliError(
      "INVALID_THREAD_OPTION",
      `Provider kind must be one of ${ACCOUNT_PROVIDER_KINDS.join(", ")} (got "${value}").`,
      { exitCode: 2 },
    );
  }
  return match;
}

export function parseEnvAssignments(entries: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of entries) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new CliError("INVALID_THREAD_OPTION", `Environment variable must be KEY=VALUE (got "${raw}").`, { exitCode: 2 });
    }
    const key = raw.slice(0, eq).trim();
    if (!key) {
      throw new CliError("INVALID_THREAD_OPTION", `Environment variable name cannot be empty (got "${raw}").`, { exitCode: 2 });
    }
    env[key] = raw.slice(eq + 1);
  }
  return env;
}

export async function listProviderAccounts(config: CliConfig) {
  const { accounts } = await (await cliClient(config)).query({ type: "providers.accounts" });
  return { accounts };
}

export async function saveProviderAccount(config: CliConfig, input: ProviderAccountSaveInput) {
  const result = await (await cliClient(config)).dispatch({ type: "provider.account.save", ...input });
  return { account: result.account, created: result.created };
}

export async function toggleProviderAccount(
  config: CliConfig,
  kind: AccountProviderKind,
  id: string,
  enabled: boolean,
) {
  const result = await (await cliClient(config)).dispatch({ type: "provider.account.toggle", kind, id, enabled });
  return { account: result.account };
}

export async function removeProviderAccountCli(config: CliConfig, kind: AccountProviderKind, id: string) {
  const result = await (await cliClient(config)).dispatch({ type: "provider.account.remove", kind, id });
  return { removed: result.removed };
}

export async function loginProviderAccountCli(
  config: CliConfig,
  options: { kind: AccountProviderKind; id: string; homePath?: string; noOpen?: boolean },
) {
  const client = await cliClient(config);
  const started = await client.dispatch({
    type: "provider.account.login.start",
    kind: options.kind,
    id: options.id,
    ...(options.homePath !== undefined ? { homePath: options.homePath } : {}),
  });
  if (started.authorizationUrl && started.openBrowser && options.noOpen !== true) {
    openExternalUrl(started.authorizationUrl);
  }
  if (started.message) {
    process.stderr.write(`${started.message}\n`);
  }
  if (started.authorizationUrl) {
    process.stderr.write(`Authorization URL:\n${started.authorizationUrl}\n`);
  }
  let code: string | undefined;
  if (started.needsCodeInput) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      code = (await rl.question("Paste authorization code (or callback URL) and press Enter: ")).trim();
    } finally {
      rl.close();
    }
  }
  const completed = await client.dispatch({
    type: "provider.account.login.complete",
    sessionId: started.sessionId,
    ...(code !== undefined ? { code } : {}),
  });
  return {
    account: completed.account,
    homePath: started.homePath,
    ...(completed.verified !== undefined ? { verified: completed.verified } : {}),
    ...(completed.needsConfirmation !== undefined ? { needsConfirmation: completed.needsConfirmation } : {}),
    ...(completed.reason !== undefined ? { reason: completed.reason } : {}),
  };
}

/** Open an HTTPS URL in the user's default browser without shell-joining strings. */
export function openExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", parsed.toString()] : [parsed.toString()];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function chatgptLoginCli(
  config: CliConfig,
  options: { accountId: string; label?: string; noOpen?: boolean; callbackUrl?: string },
) {
  const client = await cliClient(config);
  const started = await client.dispatch({
    type: "chatgpt.login.start",
    accountId: options.accountId,
    ...(options.label ? { label: options.label } : {}),
  });
  if (!options.callbackUrl && options.noOpen !== true) {
    openExternalUrl(started.authorizationUrl);
  }
  if (!options.callbackUrl) {
    process.stderr.write(`Open this URL to sign in with ChatGPT:\n${started.authorizationUrl}\nWaiting for callback on ${started.redirectUri}…\n`);
  }
  const completed = await client.dispatch({
    type: "chatgpt.login.complete",
    sessionId: started.sessionId,
    ...(options.callbackUrl ? { callbackUrl: options.callbackUrl } : {}),
  });
  return { account: completed.account };
}

export async function chatgptLogoutCli(config: CliConfig, accountId: string) {
  const result = await (await cliClient(config)).dispatch({ type: "chatgpt.logout", accountId });
  return { account: result.account };
}

export async function chatgptPairCodexCli(
  config: CliConfig,
  options: {
    accountId: string;
    codexHomePath?: string;
    codexBinaryPath?: string;
    codexLaunchArgs?: string;
    confirmWorkspace?: boolean;
  },
) {
  const result = await (await cliClient(config)).dispatch({
    type: "chatgpt.codex.pair",
    accountId: options.accountId,
    ...(options.codexHomePath !== undefined ? { codexHomePath: options.codexHomePath } : {}),
    ...(options.codexBinaryPath !== undefined ? { codexBinaryPath: options.codexBinaryPath } : {}),
    ...(options.codexLaunchArgs !== undefined ? { codexLaunchArgs: options.codexLaunchArgs } : {}),
    ...(options.confirmWorkspace === true ? { confirmWorkspace: true } : {}),
  });
  return {
    verified: result.verified,
    needsConfirmation: result.needsConfirmation,
    reason: result.reason,
    account: result.account,
    codexEmail: result.codexEmail,
    codexPlanType: result.codexPlanType,
    codexWorkspaceName: result.codexWorkspaceName,
  };
}
