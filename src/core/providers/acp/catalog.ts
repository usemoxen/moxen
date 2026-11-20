/**
 * ACP catalog discovery: probes configured ACP agents (built-in `agy` preset
 * plus custom `providers.acp.agents`) via `initialize` without creating an
 * empty session or reading provider credentials.
 */
import fs from "node:fs";
import path from "node:path";

import type { ProviderSummary } from "../../catalog/summary.js";
import { CliError } from "../../errors.js";
import { binaryOnPath } from "../../infra/process.js";
import type { AcpProviderConfig } from "../../types.js";
import { ACP_DEFAULT_MODEL_SLUG, resolveAcpAgents, type ResolvedAcpAgent } from "./config.js";
import { AcpDriver } from "./driver.js";
import type { AcpTransport } from "./transport.js";

function isCommandInstalled(command: string, env: NodeJS.ProcessEnv): boolean {
  if (path.isAbsolute(command)) {
    try {
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  return binaryOnPath(command, env);
}

function defaultModelsFor(agent: ResolvedAcpAgent): ProviderSummary["models"] {
  const displayName = agent.name ?? agent.id;
  const models: ProviderSummary["models"] = [
    {
      slug: ACP_DEFAULT_MODEL_SLUG,
      name: `${displayName} (default)`,
      isCustom: false,
      isHidden: false,
      isDefault: !agent.defaultModel,
      efforts: [],
    },
  ];
  if (agent.defaultModel && agent.defaultModel !== ACP_DEFAULT_MODEL_SLUG) {
    models.push({
      slug: agent.defaultModel,
      name: agent.defaultModel,
      isCustom: true,
      isHidden: false,
      isDefault: true,
      efforts: [],
    });
  }
  return models;
}

export async function acpProviderFor(
  agent: ResolvedAcpAgent,
  env: NodeJS.ProcessEnv,
  cwd: string,
  transport?: AcpTransport,
): Promise<ProviderSummary> {
  const instanceId = `acp/${agent.id}`;
  const displayName = agent.name ?? agent.id;
  const installed = transport ? true : isCommandInstalled(agent.command, env);
  const base: ProviderSummary = {
    instanceId,
    driver: "acp",
    displayName,
    installed,
    enabled: false,
    status: installed ? null : "not installed",
    authStatus: null,
    models: [],
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  };
  if (!installed) return base;

  const driver = new AcpDriver({
    agents: { [agent.id]: agent },
    env,
    ...(transport ? { transport } : {}),
    initializeTimeoutMs: 5_000,
  });
  try {
    const init = await driver.probeAgent(instanceId, cwd);
    const title = init.agentInfo.title ?? init.agentInfo.name ?? displayName;
    const authStatus = init.authMethods.length > 0 ? init.authMethods[0]!.id : "ready";
    return {
      ...base,
      displayName: title,
      enabled: true,
      status: null,
      authStatus,
      models: defaultModelsFor(agent),
    };
  } catch (cause) {
    if (cause instanceof CliError && cause.code === "ACP_PROTOCOL_VERSION_UNSUPPORTED") {
      return { ...base, status: cause.message };
    }
    return {
      ...base,
      status: `Could not query ${displayName}; check its executable and login.`,
    };
  }
}

export async function acpProviders(
  config: AcpProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  transport?: AcpTransport,
): Promise<ProviderSummary[]> {
  const agents = resolveAcpAgents(config);
  return Promise.all(agents.map((agent) => acpProviderFor(agent, env, cwd, transport)));
}
