/**
 * Antigravity catalog discovery: probes the official `agy` binary via ACP v1
 * `initialize` without creating an empty session or reading credentials.
 */
import fs from "node:fs";
import path from "node:path";

import type { ProviderSummary } from "../../catalog/summary.js";
import { CliError } from "../../errors.js";
import { binaryOnPath } from "../../infra/process.js";
import type { AntigravityProviderConfig } from "../../types.js";
import { AcpDriver } from "../acp/driver.js";
import type { AcpTransport } from "../acp/transport.js";
import { ANTIGRAVITY_DEFAULT_MODEL_SLUG, antigravityLaunchSpec } from "./config.js";

function isInstalled(command: string, env: NodeJS.ProcessEnv): boolean {
  if (path.isAbsolute(command)) {
    try {
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }
  return binaryOnPath(command, env);
}

export async function antigravityProvider(
  config: AntigravityProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  transport?: AcpTransport,
): Promise<ProviderSummary> {
  const spec = antigravityLaunchSpec(config);
  const installed = transport ? true : isInstalled(spec.command, env);
  const base: ProviderSummary = {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
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
    provider: "antigravity",
    agents: { antigravity: spec },
    env,
    ...(transport ? { transport } : {}),
    initializeTimeoutMs: 5_000,
  });
  try {
    const init = await driver.probeAgent("antigravity", cwd);
    const authStatus = init.authMethods.length > 0 ? init.authMethods[0]!.id : "ready";
    return {
      ...base,
      enabled: true,
      status: null,
      authStatus,
      models: [
        {
          slug: ANTIGRAVITY_DEFAULT_MODEL_SLUG,
          name: "Antigravity (default)",
          isCustom: false,
          isHidden: false,
          isDefault: true,
          efforts: [],
        },
      ],
    };
  } catch (cause) {
    if (cause instanceof CliError && cause.code === "ACP_PROTOCOL_VERSION_UNSUPPORTED") {
      return { ...base, status: cause.message };
    }
    return {
      ...base,
      status: "Could not query Antigravity; check `agy` login and the configured executable.",
    };
  }
}
