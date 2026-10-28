import type { ProviderImage } from "../../spi.js";
import type { BackgroundShells } from "../background.js";
import type { ToolDefinition } from "../types.js";

/** What running a tool gives back to the model. An error is still a result the model reads and acts on. */
export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  /** Pictures for the model to look at; only offered by a tool when the context says the model can see them. */
  readonly images?: readonly ProviderImage[];
  /** The turn ends after this round, with `answer` as its reply: the model has handed the floor to the user (a plan to review). */
  readonly endTurn?: { readonly answer: string };
}

/** What a call would do, for the permission check and for the activity row. */
export interface ToolIntent {
  readonly action: "read" | "edit" | "exec";
  /** Absolute paths the call reads or changes. */
  readonly paths: readonly string[];
  /** The shell command, for `exec`. */
  readonly command?: string;
  /** A tool from an MCP server: what it does is the server's business, so approval is per tool, not per command. */
  readonly mcp?: true;
  /** A call that reaches out to a web host (not a file or a command): approval is per host, and this machine needs none. */
  readonly web?: { readonly host: string };
}

/** Files the model has read, by the content they had. An edit is only accepted against what was read. */
export class ReadState {
  readonly #hashes = new Map<string, string>();

  remember(file: string, hash: string): void {
    this.#hashes.set(file, hash);
  }

  hashOf(file: string): string | undefined {
    return this.#hashes.get(file);
  }

  forget(file: string): void {
    this.#hashes.delete(file);
  }

  clear(): void {
    this.#hashes.clear();
  }
}

export interface ToolContext {
  /** The thread's working directory; relative paths in a call resolve against it. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly readState: ReadState;
  /** Where oversized output is saved in full, so the model can read the rest. */
  readonly artifactDir: string;
  /** Whether the model can be shown pictures. Absent means no. */
  readonly acceptsImages?: boolean;
  /** The id of the tool call being run; set by the loop for each call. */
  readonly callId?: string;
  /** Environment variable names a command must not inherit (the keys moxen itself uses). */
  readonly secretEnv?: readonly string[];
  /** The session's background commands. Absent where none may be started (inside a subagent). */
  readonly background?: BackgroundShells;
}

export interface HarnessTool<Args = Record<string, unknown>> {
  readonly definition: ToolDefinition;
  /** Safe to run next to other read-only tools. */
  readonly readOnly: boolean;
  /** Safe to run next to other calls of its kind in the same reply (several subagents at once), although it is not read-only. */
  readonly parallel?: boolean;
  intent(args: Args, context: ToolContext): ToolIntent;
  run(args: Args, context: ToolContext): Promise<ToolResult>;
}
