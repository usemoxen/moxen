/**
 * Prints what Moxen sends a session — the system prompt for each provider, and
 * the tools — so either can be read in full without starting a thread.
 *
 *   bun scripts/system-prompt.ts --help
 *   bun scripts/system-prompt.ts                        Claude Code (the default provider)
 *   bun scripts/system-prompt.ts --provider harness     Moxen Harness
 *   bun scripts/system-prompt.ts --provider opencode --platform windows
 *   bun scripts/system-prompt.ts --instructions         only Moxen's runtime instructions
 *   bun scripts/system-prompt.ts --json                 prompt and tools as JSON
 *   bun scripts/system-prompt.ts --markdown             the tools as markdown tables
 *
 * Each provider gets a different prompt, and that is the point of the
 * argument: Claude Code's own preset goes ahead of the runtime instructions,
 * OpenCode takes Moxen's base prompt plus them as an instruction entry, and
 * the Moxen Harness builds its whole prompt around them. The builders are the
 * app's own (`buildRuntimeInstructions`, `buildOpencodeSystemPrompt`,
 * `buildSystemPrompt`, `moxenToolsFor`) with made-up inputs: a worktree, the
 * Moxen, Brave and Exa servers attached, delegation tools, writable memory, a
 * search order, and one line of user instructions. The shell section is the
 * one part that differs per machine, so `--platform` pins it; without one the
 * shells found here are used.
 *
 * Not shown, because they are not Moxen's: Claude Code's preset prompt,
 * OpenCode's own base prompt (replaced when `moxenPrompt` is on, which is what
 * this previews), the project's rule files (there are none at the made-up
 * worktree), and each harness's own built-in tools.
 */
import { APP_NAME } from "../src/core/config.js";
import type { McpServerSpec } from "../src/core/mcp.js";
import { buildOpencodeSystemPrompt } from "../src/core/providers/opencode/prompt.js";
import { buildSystemPrompt } from "../src/core/providers/harness/prompt.js";
import { availableShells, type AvailableShells } from "../src/core/providers/harness/tools/shell.js";
import { SESSION_TOOL_NAMES, builtinTools } from "../src/core/providers/harness/tools/index.js";
import { buildRuntimeInstructions, harnessName } from "../src/core/threads/instructions.js";
import { detectShells, type ShellDetection } from "../src/core/threads/shells.js";
import { moxenInstructions } from "../src/server/mcp/stdio.js";
import { moxenToolsFor } from "../src/server/mcp/tools.js";

const PROVIDERS = ["claude", "opencode", "harness"] as const;
type Provider = (typeof PROVIDERS)[number];

const WORKTREE = { mode: "worktree" as const, path: "/path/to/worktree", branch: "moxen/example" };

const USAGE = `Prints the system prompt Moxen sends a session, and its tools.

Usage: bun scripts/system-prompt.ts [options]

Options:
  --provider <name>   ${PROVIDERS.join(" | ")} (default: claude)
  --platform <os>     macos | linux | windows (default: this machine's)
  --instructions      only Moxen's runtime instructions, without the provider's base prompt
  --json              prompt and tools as JSON, with the shell detection
  --markdown          the tools as markdown tables
  --help, -h          this text

The prompt each provider gets:
  claude              Claude Code's preset prompt, then the runtime instructions appended to it
  opencode            Moxen's OpenCode base prompt, then the runtime instructions as an instruction entry
  harness             the whole Moxen Harness prompt, with the runtime instructions inside it

Examples:
  bun scripts/system-prompt.ts --provider harness --platform windows
  bun scripts/system-prompt.ts --provider opencode --json
  bun scripts/system-prompt.ts --markdown > tools.md

Not shown, because they are not Moxen's: Claude Code's preset prompt, the
project's rule files (there are none at the made-up worktree), and each
harness's own built-in tools.
`;

interface Options {
  readonly provider: Provider;
  readonly detection: ShellDetection;
  readonly instructionsOnly: boolean;
  readonly json: boolean;
  readonly markdown: boolean;
}

/** The shells each platform usually has, for `--platform`; without one, this machine's. */
const PLATFORMS: Readonly<Record<string, ShellDetection>> = {
  macos: { platform: "darwin", shells: ["zsh", "bash", "sh"], login: "zsh" },
  darwin: { platform: "darwin", shells: ["zsh", "bash", "sh"], login: "zsh" },
  linux: { platform: "linux", shells: ["bash", "sh"], login: "bash" },
  windows: { platform: "win32", shells: ["pwsh", "powershell", "bash"], login: null },
  win32: { platform: "win32", shells: ["pwsh", "powershell", "bash"], login: null },
};

class UsageError extends Error {}

/** `--name value` and `--name=value`, the two shapes a flag is written in. */
function flagValue(args: readonly string[], index: number, name: string): { value: string | null; next: number } {
  const arg = args[index]!;
  const inline = arg.slice(name.length);
  if (inline.startsWith("=")) return { value: inline.slice(1), next: index + 1 };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw new UsageError(`${name} needs a value.`);
  return { value, next: index + 2 };
}

function parse(args: readonly string[]): Options | null {
  let provider: string | null = null;
  let platform: string | null = null;
  let instructionsOnly = false;
  let json = false;
  let markdown = false;
  for (let index = 0; index < args.length; ) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--json" || arg === "--markdown" || arg === "--instructions") {
      if (arg === "--json") json = true;
      else if (arg === "--markdown") markdown = true;
      else instructionsOnly = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider")) {
      const read = flagValue(args, index, "--provider");
      provider = read.value!.toLowerCase();
      index = read.next;
      continue;
    }
    if (arg.startsWith("--platform")) {
      const read = flagValue(args, index, "--platform");
      platform = read.value!.toLowerCase();
      index = read.next;
      continue;
    }
    throw new UsageError(`Unknown argument "${arg}".`);
  }
  if (json && markdown) throw new UsageError("--json and --markdown print different things: pick one.");
  if (provider !== null && !(PROVIDERS as readonly string[]).includes(provider)) {
    throw new UsageError(`Unknown provider "${provider}": use ${PROVIDERS.join(", ")}.`);
  }
  if (platform !== null && PLATFORMS[platform] === undefined) {
    throw new UsageError(`Unknown platform "${platform}": use macos, linux or windows.`);
  }
  return {
    provider: (provider ?? "claude") as Provider,
    detection: platform === null ? detectShells() : PLATFORMS[platform]!,
    instructionsOnly,
    json,
    markdown,
  };
}

function fail(error: unknown): never {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }
  throw error;
}

let options: Options | null = null;
try {
  options = parse(process.argv.slice(2));
} catch (error) {
  fail(error);
}
if (options === null) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { provider, detection, instructionsOnly, json, markdown } = options;
const instanceId = provider === "claude" ? "claudeAgent" : provider;
const harness = harnessName(instanceId);

const moxenServer: McpServerSpec = {
  name: APP_NAME,
  type: "in-process",
  tools: [],
  call: async () => ({ text: "", isError: false }),
  fallback: { name: APP_NAME, type: "stdio", command: APP_NAME, args: [], env: {} },
};
const braveServer: McpServerSpec = { name: "brave-search", type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: {} };
const exaServer: McpServerSpec = { name: "exa", type: "http", url: "https://mcp.exa.ai/mcp", headers: {} };

const instructions = buildRuntimeInstructions({
  instanceId,
  env: WORKTREE,
  userInstructions: ["(Your `instructions` from the config and the project's moxen.json go here.)"],
  checklist: true,
  delegationTools: true,
  memory: "write",
  shell: detection,
  // The Moxen Harness has its own web tools; Claude and OpenCode get Moxen's, with tips.
  ...(provider === "harness"
    ? {}
    : {
        web: {
          provider,
          searchOrder: ["exa", "brave", "native"],
          fetchOrder: ["moxen", "native", "exa"],
          servers: [moxenServer, braveServer, exaServer],
        },
      }),
});

// What a top-level thread on this provider is offered from Moxen's own server: the checklist
// is OpenCode's alone (Claude Code and the Harness keep their own), and the web tools are on.
const tools = moxenToolsFor({ checklist: provider === "opencode", delegated: false, webFetch: true, memory: "write" });

/** The shells the Harness would find on the previewed platform, without probing this machine for them. */
function harnessShells(): AvailableShells {
  const win = detection.platform === "win32";
  return availableShells({
    platform: detection.platform,
    env: win ? { ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0" } : { SHELL: "/bin/bash" },
    exists: () => true,
  });
}

/** The whole prompt for the provider: the base prompt it gets around Moxen's instructions. */
function promptFor(): string {
  if (provider === "claude") return instructions;
  if (provider === "opencode") return [buildOpencodeSystemPrompt(), instructions].join("\n\n");
  const shells = harnessShells();
  const names = [
    ...builtinTools(shells).map((tool) => tool.definition.name),
    ...SESSION_TOOL_NAMES,
    // A top-level interactive session, with skills and the Moxen server.
    "ask",
    "skill",
    ...tools.map((tool) => `mcp__${APP_NAME}__${tool.name}`),
  ];
  return buildSystemPrompt({
    cwd: WORKTREE.path,
    tools: new Set(names),
    instructions,
    mcpServers: [{ name: APP_NAME, instructions: moxenInstructions({ webFetch: true, memory: "write" }) }],
    platform: detection.platform,
  });
}

/** A schema's type in one cell: enums, arrays of them, object shapes, or a plain type. */
function typeName(schema: unknown): string {
  if (schema === null || typeof schema !== "object") return "any";
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.enum)) return node.enum.map((value) => `\`${String(value)}\``).join(" \\| ");
  if (node.type === "array") return `${typeName(node.items)}[]`;
  const properties = node.type === "object" ? node.properties : undefined;
  if (properties !== null && properties !== undefined && typeof properties === "object") {
    return `{ ${Object.keys(properties as object).join(", ")} }`;
  }
  return typeof node.type === "string" ? node.type : "any";
}

/** One line of prose, safe in a table cell: no newlines, no unescaped pipes. */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** A parameter's own description, plus the fields of the objects in an array (a `todos` entry, say). */
function parameterDescription(schema: Record<string, unknown>): string {
  const own = typeof schema.description === "string" ? cell(schema.description) : "";
  const items = schema.type === "array" && schema.items !== null && typeof schema.items === "object" ? (schema.items as Record<string, unknown>) : null;
  const properties = items?.properties;
  if (properties === null || properties === undefined || typeof properties !== "object") return own;
  const fields = Object.entries(properties as Readonly<Record<string, Record<string, unknown>>>)
    .map(([name, property]) => `${name}: ${(typeof property.description === "string" ? cell(property.description) : typeName(property)).replace(/\.$/u, "")}`)
    .join("; ");
  return [own, cell(fields)].filter((part) => part !== "").join(" ");
}

/** The tools as markdown, for reading in a review or pasting into a doc. */
function toolsMarkdown(): string {
  const lines = [
    "# Tools",
    "",
    `${tools.length} tools from Moxen's own \`${APP_NAME}\` server, as a top-level thread on ${harness} gets them. ` +
      "The harness's built-in tools are its own, not Moxen's; a read-only one can run alongside other read-only calls.",
  ];
  for (const tool of tools) {
    const properties = (tool.inputSchema.properties ?? {}) as Readonly<Record<string, Record<string, unknown>>>;
    const required = new Set(Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as readonly string[]) : []);
    lines.push("", `## \`${tool.name}\``, "", cell(tool.description));
    const names = Object.keys(properties);
    if (names.length === 0) {
      lines.push("", "No arguments.");
    } else {
      lines.push("", "| Parameter | Type | Required | What it is |", "|---|---|---|---|");
      for (const name of names) {
        const schema = properties[name]!;
        lines.push(`| \`${name}\` | ${typeName(schema)} | ${required.has(name) ? "yes" : "no"} | ${parameterDescription(schema)} |`);
      }
    }
    if (tool.annotations?.readOnlyHint === true) lines.push("", "Read-only.");
  }
  return lines.join("\n");
}

if (json) {
  const output = {
    provider,
    harness,
    shell: detection,
    prompt: promptFor(),
    instructions,
    tools: tools.map((tool) => ({
      server: APP_NAME,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else if (markdown) {
  process.stdout.write(`${toolsMarkdown()}\n`);
} else {
  process.stdout.write(`${instructionsOnly ? instructions : promptFor()}\n`);
}
