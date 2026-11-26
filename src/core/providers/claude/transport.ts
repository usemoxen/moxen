/**
 * Transport seam between the Claude driver and the Agent SDK. The driver
 * only ever talks to `ClaudeTransport` + `ClaudeSessionApi`, so tests
 * inject scripted message streams and no test spawns the real CLI.
 * This file and `subagents.ts` are the only runtime SDK importers; every
 * standalone session helper they call runs under `withClaudeConfigDir`.
 */
import { z } from "zod";
import {
  createSdkMcpServer,
  tool as sdkTool,
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  query as sdkQuery,
  renameSession as sdkRenameSession,
  type CanUseTool,
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type OnUserDialog,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type Settings,
  type ToolConfig,
} from "@anthropic-ai/claude-agent-sdk";

import type { InProcessMcpServerSpec } from "../../mcp.js";

export interface ClaudeQueryOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode: PermissionMode;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly resume?: string;
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Permission deny rules: tools the model is not offered (`mcp__…`, `TodoWrite`, `Skill(name)`). */
  readonly disallowedTools?: string[];
  /** SDK context filter: unlisted skills are hidden and cannot be invoked. */
  readonly skills?: string[];
  /** Local plugins to load for this session (the `agent-skills` mod). */
  readonly plugins?: Array<{ type: "local"; path: string }>;
  /** Claude Code's preset for agent sessions, or a focused custom prompt for text completion. */
  readonly systemPrompt?: string | { readonly type: "preset"; readonly preset: "claude_code"; readonly append?: string };
  /** Empty sources and strict MCP isolate tool-free text requests from local automation. */
  readonly settingSources?: [];
  readonly strictMcpConfig?: boolean;
  readonly env?: Record<string, string>;
  readonly pathToClaudeCodeExecutable?: string;
  readonly canUseTool?: CanUseTool;
  readonly abortController?: AbortController;
  readonly stderr?: (data: string) => void;
  /** The reasoning effort the session starts at. */
  readonly effort?: EffortLevel;
  /** Session-scoped flag settings (`ultracode`), above the user's own files. */
  readonly settings?: Settings;
  /** In-process hook callbacks, run alongside the user's own settings hooks. */
  readonly hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** One predicted next prompt after each turn (`prompt_suggestion`, after the `result`). */
  readonly promptSuggestions?: boolean;
  /** Per-tool settings for built-in tools (`askUserQuestion.previewFormat`). */
  readonly toolConfig?: ToolConfig;
  /** Token-level `stream_event`s alongside the complete messages. */
  readonly includePartialMessages?: boolean;
  /** Raw CLI flags (`--thinking-display`); `null` for a bare flag. */
  readonly extraArgs?: Record<string, string | null>;
  /** Built-in tools on offer; `[]` turns every one off (a side question). */
  readonly tools?: string[];
  /** Cap on model round trips; 1 for a one-shot answer. */
  readonly maxTurns?: number;
  /** With `resume`: continue on a copy under a new id, leaving the original alone. */
  readonly forkSession?: boolean;
  /** False keeps the session off disk: nothing to resume, nothing to clean up. */
  readonly persistSession?: boolean;
  /** Renders the CLI's blocking dialogs; only kinds in `supportedDialogKinds` are ever sent. */
  readonly onUserDialog?: OnUserDialog;
  readonly supportedDialogKinds?: string[];
}

/** What `applyFlagSettings` merges: settings keys, where `null` clears one (and `effortLevel` also takes `max`). */
export type FlagSettings = {
  [K in keyof Settings]?: K extends "effortLevel" ? EffortLevel | null : Settings[K] | null;
};

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  /** Merge session-scoped settings mid-session (`effortLevel`, `ultracode`); `null` clears a key. */
  applyFlagSettings?(settings: FlagSettings): Promise<void>;
  usageExperimental?(options?: { skipBehaviors?: boolean }): Promise<unknown>;
  /** What `/context` reports; `summary` answers from the last response without extra API calls. */
  getContextUsage?(options?: { detail?: "summary" | "full" }): Promise<unknown>;
  /** Every command and skill the CLI resolved for this session's cwd. */
  supportedCommands?(): Promise<ReadonlyArray<{ name: string; description: string; argumentHint: string; builtin?: boolean }>>;
  /** Every model Claude Code offers, with each one's effort levels. */
  supportedModels?(): Promise<ReadonlyArray<unknown>>;
  /** End the CLI process. */
  close?(): void;
  /** Stop a background task; a `task_notification` with status `stopped` follows. */
  stopTask?(taskId: string): Promise<void>;
  /**
   * Replace the servers moxen handed the session, mid-session: removed ones
   * disconnect, new ones connect. The user's own servers are not touched.
   */
  setMcpServers?(servers: Record<string, McpServerConfig>): Promise<unknown>;
}

export interface ClaudeTransport {
  query(
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: ClaudeQueryOptions,
  ): ClaudeQuery;
}

export class SdkTransport implements ClaudeTransport {
  query(
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: ClaudeQueryOptions,
  ): ClaudeQuery {
    const { env, ...rest } = options;
    const sdk = sdkQuery({
      prompt,
      options: { ...rest, ...(env === undefined ? {} : { env }) },
    });
    const usageExperimental =
      typeof (sdk as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ===
      "function"
        ? (sdk as unknown as {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (
              options?: { skipBehaviors?: boolean },
            ) => Promise<unknown>;
          }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.bind(sdk)
        : undefined;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        return sdk[Symbol.asyncIterator]();
      },
      interrupt: () => sdk.interrupt(),
      setPermissionMode: (mode) => sdk.setPermissionMode(mode),
      setModel: (model) => sdk.setModel(model),
      applyFlagSettings: (flagSettings) => sdk.applyFlagSettings(flagSettings),
      // Without this the driver's `contextUsage` found no method and every
      // Claude context reading came back null.
      getContextUsage: (contextOptions) => sdk.getContextUsage(contextOptions),
      supportedCommands: () => sdk.supportedCommands(),
      supportedModels: () => sdk.supportedModels(),
      close: () => sdk.close(),
      stopTask: (taskId) => sdk.stopTask(taskId),
      ...(usageExperimental ? { usageExperimental } : {}),
    };
  }
}

/**
 * An in-process MCP server as the SDK hosts it (`createSdkMcpServer`): each
 * tool's handler calls the spec's `call` directly, in this process. The SDK
 * takes Zod shapes, so the tools' JSON schemas are converted — they only
 * use nested objects of strings, numbers, booleans and string enums.
 */
export function sdkMcpServer(spec: InProcessMcpServerSpec): McpServerConfig {
  return createSdkMcpServer({
    name: spec.name,
    ...(spec.instructions ? { instructions: spec.instructions } : {}),
    ...(spec.alwaysLoad === true ? { alwaysLoad: true } : {}),
    tools: spec.tools.map((definition) =>
      sdkTool(
        definition.name,
        definition.description,
        zodShape(definition.inputSchema),
        async (args: Record<string, unknown>) => {
          const result = await spec.call(definition.name, args);
          return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
        },
        definition.annotations?.readOnlyHint === true ? { annotations: { readOnlyHint: true } } : undefined,
      ),
    ),
  });
}

/** A JSON object schema as a Zod raw shape; anything it does not know accepts any value. */
export function zodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
  return Object.fromEntries(
    Object.entries(properties).map(([key, property]) => {
      let field: z.ZodType;
      const values = property["enum"];
      if (Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string")) {
        field = z.enum(values as [string, ...string[]]);
      } else if (property["type"] === "string") field = z.string();
      else if (property["type"] === "number" || property["type"] === "integer") field = z.number();
      else if (property["type"] === "boolean") field = z.boolean();
      else if (property["type"] === "object") field = z.object(zodShape(property));
      else field = z.unknown();
      if (typeof property["description"] === "string") field = field.describe(property["description"]);
      return [key, required.has(key) ? field : field.optional()];
    }),
  );
}

/**
 * The SDK's standalone session helpers (`getSessionInfo`,
 * `getSessionMessages`, `forkSession`, `renameSession`,
 * `getSubagentMessages`) take no env option: they read
 * `process.env.CLAUDE_CONFIG_DIR` as they run, at several points across
 * their awaits (the SDK docs say to set it in the host process). The
 * server hosts several accounts at once, each with its own folder, so a
 * bare set/restore around one call would leak one account's folder into
 * another's concurrent call. Instead every such call in the process runs
 * through this one queue: the caller's folder is set for the whole call
 * and restored after, and no two calls ever overlap. `undefined` clears
 * the variable, which is what an account without one inherits (the SDK
 * then uses `~/.claude`, exactly as the spawned CLI does).
 */
let configDirQueue: Promise<unknown> = Promise.resolve();
export function withClaudeConfigDir<T>(configDir: string | undefined, run: () => Promise<T>): Promise<T> {
  const call = configDirQueue.then(async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
  configDirQueue = call.then(
    () => undefined,
    () => undefined,
  );
  return call;
}

export interface ForkSessionResult {
  readonly sessionId: string;
}

export interface ClaudeSessionApi {
  getSessionMessages(sessionId: string): Promise<SessionMessage[]>;
  /** A copy of the session, through `upToMessageId` when given, else whole. */
  forkSession(sessionId: string, upToMessageId?: string): Promise<ForkSessionResult>;
  /**
   * Whether the CLI still has this session on disk. Resuming one it has
   * lost fails the first turn, so a persisted id is checked before use.
   */
  sessionExists(sessionId: string): Promise<boolean>;
  /**
   * The title Claude Code gave the session (its `ai-title`, or a `/rename`
   * name), null when it has none yet. The SDK's `summary` falls back to the
   * last or first prompt, so only `customTitle` — which is exactly the
   * custom-or-ai title — counts.
   */
  sessionTitle(sessionId: string, dir: string): Promise<string | null>;
  renameSession(sessionId: string, title: string, dir: string): Promise<void>;
}

/**
 * The SDK session helpers for one account: `configDir` is the
 * `CLAUDE_CONFIG_DIR` the account's spawned CLI gets (from
 * `makeClaudeEnv`), and every call looks in that folder — never in the
 * server process's own environment, which after a restart holds no
 * account's folder at all.
 */
export class SdkSessionApi implements ClaudeSessionApi {
  constructor(private readonly configDir?: string) {}

  async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    return await withClaudeConfigDir(this.configDir, () => sdkGetSessionMessages(sessionId));
  }

  async forkSession(sessionId: string, upToMessageId?: string): Promise<ForkSessionResult> {
    const result = await withClaudeConfigDir(this.configDir, () =>
      sdkForkSession(sessionId, upToMessageId === undefined ? {} : { upToMessageId }),
    );
    return { sessionId: result.sessionId };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return (await withClaudeConfigDir(this.configDir, () => sdkGetSessionInfo(sessionId))) !== undefined;
  }

  async sessionTitle(sessionId: string, dir: string): Promise<string | null> {
    return (await withClaudeConfigDir(this.configDir, () => sdkGetSessionInfo(sessionId, { dir })))?.customTitle?.trim() || null;
  }

  async renameSession(sessionId: string, title: string, dir: string): Promise<void> {
    await withClaudeConfigDir(this.configDir, () => sdkRenameSession(sessionId, title, { dir }));
  }
}

