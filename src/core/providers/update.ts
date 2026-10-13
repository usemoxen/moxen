/**
 * Updating a provider's CLI from Moxen. Neither tool needs an updater of ours:
 * Claude Code installs its own (`claude update`) and OpenCode has
 * `opencode upgrade`, each knowing how it was installed (native, Homebrew, npm…).
 * Moxen only runs that command where the sessions run, and reports the version
 * before and after — which is also how it learns the update did nothing (an
 * install the tool cannot update itself says so and exits).
 *
 * Moxen starts its OpenCode servers with `update: "disable"`, so an explicit
 * call like this one is the only way one of them changes under a running app.
 */
import { CliError } from "../errors.js";
import { runProcess } from "../infra/process.js";
import { describeUpdate, UPDATABLE_PROVIDERS, type ProviderUpdate, type UpdatableProvider } from "../catalog/update.js";
import { parseVersionNumber } from "./semver.js";

export { describeUpdate, UPDATABLE_PROVIDERS };
export type { ProviderUpdate, UpdatableProvider };

const COMMANDS: Record<UpdatableProvider, { readonly binary: string; readonly args: readonly string[]; readonly label: string }> = {
  claude: { binary: "claude", args: ["update"], label: "Claude Code" },
  opencode: { binary: "opencode", args: ["upgrade"], label: "OpenCode" },
};

/** A package-manager install can take a while; the tool prints progress and exits when done. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CHARS = 600;

export interface UpdateDeps {
  /** The configured executable (`providers.<name>.binaryPath`); the tool's own name when unset. */
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Runs a command to completion; replaced in tests so no real binary is touched. */
  readonly run?: (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const defaultRun: NonNullable<UpdateDeps["run"]> = (binary, args, env) =>
  runProcess(binary, args, { env, timeoutMs: UPDATE_TIMEOUT_MS, allowFailure: true });

async function versionOf(binary: string, env: NodeJS.ProcessEnv, run: NonNullable<UpdateDeps["run"]>): Promise<string | null> {
  try {
    const result = await run(binary, ["--version"], env);
    return result.exitCode === 0 ? parseVersionNumber(result.stdout.split("\n")[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** The tail of what the tool printed: progress comes first, the verdict last. */
function tail(text: string): string {
  const trimmed = text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "").trim();
  return trimmed.length <= OUTPUT_CHARS ? trimmed : `…${trimmed.slice(-OUTPUT_CHARS)}`;
}

export async function updateProvider(provider: UpdatableProvider, deps: UpdateDeps = {}): Promise<ProviderUpdate> {
  const { args, label } = COMMANDS[provider];
  const binary = deps.binaryPath?.trim() || COMMANDS[provider].binary;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const before = await versionOf(binary, env, run);
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await run(binary, args, env);
  } catch (cause) {
    throw new CliError("PROVIDER_UPDATE_FAILED", `Could not run \`${binary} ${args.join(" ")}\`: ${cause instanceof Error ? cause.message : String(cause)}`, {
      details: { provider, binary },
    });
  }
  const output = tail(`${result.stdout}\n${result.stderr}`);
  if (result.exitCode !== 0) {
    throw new CliError("PROVIDER_UPDATE_FAILED", `${label} could not update itself${output.length > 0 ? `: ${output}` : "."}`, {
      details: { provider, binary, exitCode: result.exitCode, before },
    });
  }
  const after = await versionOf(binary, env, run);
  return { provider, before, after, updated: before !== null && after !== null && before !== after, output };
}
