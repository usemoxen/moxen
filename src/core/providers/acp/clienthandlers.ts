/**
 * Client-side ACP v1 reverse-RPC handlers (`fs/*` and `terminal/*`).
 *
 * When an ACP agent delegates file reads/writes or shell commands to the
 * client, Moxen enforces `WorktreeIsolation` (refusing writes or shell
 * redirects into the protected main checkout) and spawns processes with
 * `shell: false` (never concatenating shell strings).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliError } from "../../errors.js";
import { killProcessTree } from "../../infra/process.js";
import { escapes, isolationViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import { asNonEmptyString, asNumber, asRecord, asString } from "./protocol.js";

const DEFAULT_OUTPUT_BYTE_LIMIT = 256 * 1024;

interface ManagedTerminal {
  readonly id: string;
  readonly child: ChildProcess;
  readonly maxBytes: number;
  output: string;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  readonly exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
}

export interface AcpClientContext {
  readonly workingDirectory: string;
  readonly isolation: WorktreeIsolation | null;
  readonly env: NodeJS.ProcessEnv;
}

export class AcpClientHandlers {
  private readonly terminals = new Map<string, ManagedTerminal>();

  async readTextFile(params: unknown, ctx: AcpClientContext): Promise<{ content: string }> {
    const record = asRecord(params);
    const rawPath = asNonEmptyString(record?.["path"]);
    if (!rawPath) {
      throw new CliError("ACP_INVALID_PARAMS", "fs/read_text_file requires a non-empty path.");
    }
    const target = path.resolve(ctx.workingDirectory, rawPath);
    const content = await readFile(target, "utf8");
    const line = asNumber(record?.["line"]);
    const limit = asNumber(record?.["limit"]);
    if (line === null && limit === null) {
      return { content };
    }
    const lines = content.split("\n");
    const startIdx = line !== null && line > 1 ? Math.floor(line) - 1 : 0;
    const endIdx = limit !== null && limit >= 0 ? startIdx + Math.floor(limit) : lines.length;
    return { content: lines.slice(startIdx, endIdx).join("\n") };
  }

  async writeTextFile(params: unknown, ctx: AcpClientContext): Promise<Record<string, never>> {
    const record = asRecord(params);
    const rawPath = asNonEmptyString(record?.["path"]);
    const content = asString(record?.["content"]);
    if (!rawPath || content === null) {
      throw new CliError("ACP_INVALID_PARAMS", "fs/write_text_file requires path and content.");
    }
    const target = path.resolve(ctx.workingDirectory, rawPath);
    if (ctx.isolation && escapes(ctx.isolation, target, ctx.workingDirectory)) {
      throw new CliError(
        "WORKTREE_ISOLATION_VIOLATION",
        `This session is isolated in its own worktree at ${ctx.isolation.worktreeRoot}; the main checkout is off limits. ${target} is outside it.`,
      );
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return {};
  }

  createTerminal(params: unknown, ctx: AcpClientContext): { terminalId: string } {
    const record = asRecord(params);
    const command = asNonEmptyString(record?.["command"]);
    if (!command) {
      throw new CliError("ACP_INVALID_PARAMS", "terminal/create requires a non-empty command.");
    }
    const rawArgs = Array.isArray(record?.["args"])
      ? record!["args"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const rawCwd = asNonEmptyString(record?.["cwd"]);
    const cwd = rawCwd ? path.resolve(ctx.workingDirectory, rawCwd) : ctx.workingDirectory;

    if (ctx.isolation) {
      const fullCommand = [command, ...rawArgs].join(" ");
      const violation = isolationViolation(ctx.isolation, {
        tool: "Bash",
        input: { command: fullCommand },
        cwd,
      });
      if (violation) {
        throw new CliError("WORKTREE_ISOLATION_VIOLATION", violation);
      }
    }

    const extraEnv: Record<string, string> = {};
    if (Array.isArray(record?.["env"])) {
      for (const entry of record!["env"]) {
        const item = asRecord(entry);
        const name = asNonEmptyString(item?.["name"]);
        const value = asString(item?.["value"]);
        if (name && value !== null) extraEnv[name] = value;
      }
    }

    const maxBytes = asNumber(record?.["outputByteLimit"]) ?? DEFAULT_OUTPUT_BYTE_LIMIT;
    const child = nodeSpawn(command, rawArgs, {
      cwd,
      env: { ...ctx.env, ...extraEnv },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const id = `term-${randomUUID()}`;
    let resolveExit!: (value: { exitCode: number | null; signal: string | null }) => void;
    const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve;
    });

    const terminal: ManagedTerminal = {
      id,
      child,
      maxBytes: Math.max(1024, Math.floor(maxBytes)),
      output: "",
      truncated: false,
      exited: false,
      exitCode: null,
      signal: null,
      exitPromise,
    };

    const appendOutput = (chunk: string): void => {
      const combined = terminal.output + chunk;
      const bytes = Buffer.byteLength(combined, "utf8");
      if (bytes <= terminal.maxBytes) {
        terminal.output = combined;
        return;
      }
      terminal.truncated = true;
      const buf = Buffer.from(combined, "utf8");
      terminal.output = buf.subarray(buf.length - terminal.maxBytes).toString("utf8");
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (terminal.exited) return;
      terminal.exited = true;
      terminal.exitCode = code;
      terminal.signal = signal;
      resolveExit({ exitCode: code, signal });
    };

    child.on("error", (err) => {
      appendOutput(`\n${err.message}`);
      finalize(1, null);
    });
    child.on("exit", (code, signal) => finalize(code, signal));

    this.terminals.set(id, terminal);
    return { terminalId: id };
  }

  terminalOutput(params: unknown): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  } {
    const terminal = this.requireTerminal(params);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exited
        ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } }
        : {}),
    };
  }

  async waitForTerminalExit(params: unknown): Promise<{ exitCode: number | null; signal: string | null }> {
    const terminal = this.requireTerminal(params);
    return terminal.exitPromise;
  }

  killTerminal(params: unknown): Record<string, never> {
    const terminal = this.requireTerminal(params);
    if (!terminal.exited) {
      killProcessTree(terminal.child, "SIGTERM");
    }
    return {};
  }

  releaseTerminal(params: unknown): Record<string, never> {
    const record = asRecord(params);
    const id = asNonEmptyString(record?.["terminalId"]);
    if (!id) return {};
    const terminal = this.terminals.get(id);
    if (!terminal) return {};
    if (!terminal.exited) {
      killProcessTree(terminal.child, "SIGTERM");
    }
    this.terminals.delete(id);
    return {};
  }

  hasTerminal(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  readTerminalOutput(terminalId: string): string | null {
    const terminal = this.terminals.get(terminalId);
    return terminal ? terminal.output : null;
  }

  stopTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;
    if (!terminal.exited) {
      killProcessTree(terminal.child, "SIGTERM");
    }
    return true;
  }

  closeAll(): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.exited) {
        try {
          killProcessTree(terminal.child, "SIGTERM");
        } catch {
          // Process already exited.
        }
      }
    }
    this.terminals.clear();
  }

  private requireTerminal(params: unknown): ManagedTerminal {
    const record = asRecord(params);
    const id = asNonEmptyString(record?.["terminalId"]);
    const terminal = id ? this.terminals.get(id) : undefined;
    if (!terminal) {
      throw new CliError("ACP_TERMINAL_NOT_FOUND", `Unknown ACP terminal id: ${String(id)}`);
    }
    return terminal;
  }
}
