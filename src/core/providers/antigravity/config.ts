/**
 * First-class Antigravity CLI (`agy`) provider configuration.
 *
 * Uses the official `agy` binary unmodified (`agy acp` over pinned ACP v1).
 * Launch arguments are tokenized into argv arrays and never shell-joined.
 */
import { expandHome } from "../../config.js";
import type { AntigravityProviderConfig } from "../../types.js";
import { tokenizeLaunchArgs } from "../codex/config.js";
import type { AcpAgentLaunchSpec } from "../acp/transport.js";

export const ANTIGRAVITY_DEFAULT_MODEL_SLUG = "antigravity-default";

export function antigravityLaunchSpec(
  config: AntigravityProviderConfig | undefined,
): AcpAgentLaunchSpec {
  const command = expandHome(config?.binaryPath?.trim() || "agy");
  const extra = config?.launchArgs?.trim() ? tokenizeLaunchArgs(config.launchArgs.trim()) : [];
  return {
    id: "antigravity",
    name: "Antigravity",
    command,
    args: ["acp", ...extra],
  };
}
