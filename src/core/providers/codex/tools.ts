/** Codex's application-owned shell and questions, using the Harness implementations.
 * MCP also works on old rollouts: 0.166's thread/resume cannot install dynamic tools.
 * The endpoint belongs to one session and never accepts a call outside a live turn.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { CliError } from "../../errors.js";
import { isolationViolation, type WorktreeIsolation } from "../../threads/isolation.js";
import type { RuntimeMode } from "../../types.js";
import type { BackgroundTaskSummary, ProviderApprovalDecision, ProviderRuntimeEvent, ProviderUserInputAnswers } from "../spi.js";
import { BackgroundShells, type BackgroundEvent } from "../harness/background.js";
import { classificationOf, decidePermission, declinedMessage, sessionAllowKey } from "../harness/permissions.js";
import { askTool, type AskReply } from "../harness/tools/ask.js";
import { makeShellTool } from "../harness/tools/bash.js";
import { taskOutputTool, taskStopTool } from "../harness/tools/background.js";
import { availableShells } from "../harness/tools/shell.js";
import { ReadState, type HarnessTool, type ToolContext, type ToolResult } from "../harness/tools/types.js";
import { validateToolArguments } from "../harness/tools/validate.js";

export const CODEX_HARNESS_SERVER = "moxen_harness";
export const CODEX_HARNESS_CONFIG = {
  "features.shell_tool": false,
  "tools.experimental_request_user_input.enabled": false,
};

interface Options {
  readonly threadId: string;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly delegated: boolean;
  readonly shellDisabled: boolean;
  readonly isolation: WorktreeIsolation | null;
  readonly secretEnv: () => readonly string[];
  readonly mode: () => RuntimeMode;
  readonly publish: (event: ProviderRuntimeEvent) => void;
}

type Parked =
  | { readonly kind: "permission"; readonly resolve: (decision: ProviderApprovalDecision) => void }
  | { readonly kind: "input"; readonly resolve: (reply: AskReply) => void };

export class CodexHarnessTools {
  private readonly tools: readonly HarnessTool<never>[];
  private readonly background: BackgroundShells;
  private readonly allowed = new Set<string>();
  private readonly parked = new Map<string, Parked>();
  private readonly notes: string[] = [];
  private active: { readonly id: string; readonly controller: AbortController } | null = null;
  private server: Server | null = null;
  private closed = false;

  constructor(private readonly options: Options) {
    const shells = availableShells();
    this.tools = [
      ...(!options.shellDisabled ? [shells.bash, shells.powershell].filter((shell) => shell !== null).map((shell) => {
        const tool = makeShellTool(shell);
        return { ...tool, definition: { ...tool.definition, description: tool.definition.description.replace("- Do not use it to read, search, find or edit files; use read, grep, glob, edit and write, which are cheaper and safer to review.", "- Use this tool for file reading and search too. Use Codex's apply_patch for edits.") } };
      }) : []),
      taskOutputTool, taskStopTool,
      ...(!options.delegated ? [askTool((questions, signal) => this.wait("input", { toolName: "ask", input: { questions } }, signal))] : []),
    ] as unknown as readonly HarnessTool<never>[];
    this.background = new BackgroundShells({ artifactDir: options.artifactDir, onEvent: (event) => this.onBackground(event) });
  }

  /** Private loopback transport, with an in-memory capability unique to this session. */
  async start(): Promise<Record<string, unknown>> {
    const token = randomUUID();
    const server = createServer((request, response) => {
      void (async () => {
        const given = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${token}`);
        if (this.closed || request.url !== "/mcp" || given.length !== expected.length || !timingSafeEqual(given, expected)) {
          response.writeHead(401).end();
          return;
        }
        if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 200 : 405).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1_000_000) { response.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
        try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { response.writeHead(400).end(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { response.writeHead(400).end(); return; }
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        let result: unknown;
        switch (message.method) {
          case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: CODEX_HARNESS_SERVER, version: "1" } }; break;
          case "ping": result = {}; break;
          case "tools/list": result = { tools: this.tools.map(({ definition }) => ({ name: definition.name, description: definition.description, inputSchema: definition.parameters })) }; break;
          case "tools/call": {
            const controller = new AbortController();
            const disconnected = (): void => { if (!response.writableEnded) controller.abort(); };
            response.once("close", disconnected);
            const value = await this.call(message.params?.name ?? "", message.params?.arguments ?? {}, controller.signal);
            response.removeListener("close", disconnected);
            result = { content: [{ type: "text", text: value.content }], isError: value.isError === true };
            break;
          }
          default:
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
            return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind Codex tools.");
    return { url: `http://127.0.0.1:${address.port}/mcp`, http_headers: { Authorization: `Bearer ${token}` }, required: true, tool_timeout_sec: 86_400, default_tools_approval_mode: "approve" };
  }

  beginTurn(id: string): void { this.endTurn(); this.active = { id, controller: new AbortController() }; }
  endTurn(): void { this.active?.controller.abort(); this.active = null; }

  async close(): Promise<void> {
    this.closed = true;
    this.endTurn();
    this.background.stopAll();
    await Promise.all(this.background.running().map((task) => this.background.stop(task.id)));
    this.options.publish({ type: "background.tasks.changed", provider: "codex", threadId: this.options.threadId, tasks: [] });
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
  }

  takeNotes(): string { return this.notes.splice(0).join("\n\n"); }

  async call(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const turn = this.active;
    if (this.closed || !turn || turn.controller.signal.aborted) return { content: "There is no active turn for this session.", isError: true };
    const tool = this.tools.find((candidate) => candidate.definition.name === name);
    if (!tool) return { content: `Tool ${name} is not available in this session.`, isError: true };
    const parsed = validateToolArguments(JSON.stringify(input), tool.definition.parameters, name);
    if (!parsed.ok) return { content: parsed.error, isError: true };
    const context: ToolContext = { cwd: this.options.cwd, signal: signal ? AbortSignal.any([turn.controller.signal, signal]) : turn.controller.signal, readState: new ReadState(), artifactDir: this.options.artifactDir, callId: randomUUID(), background: this.background, secretEnv: this.options.secretEnv() };
    try {
      const intent = tool.intent(parsed.args as never, context);
      const reason = this.options.isolation ? isolationViolation(this.options.isolation, { tool: name === "bash" || name === "powershell" ? "Bash" : name, input: parsed.args, cwd: context.cwd }) : null;
      if (reason) return { content: reason, isError: true };
      const verdict = decidePermission({ mode: this.options.mode(), intent, cwd: context.cwd, interactive: !this.options.delegated, shell: name === "powershell" ? "powershell" : "posix" });
      if (verdict.kind === "deny") return { content: verdict.reason, isError: true };
      const key = sessionAllowKey(name, intent, context.cwd);
      if (verdict.kind === "ask" && !this.allowed.has(key)) {
        if (this.options.delegated) return { content: "This command needs approval and nobody is available to answer for this delegated task.", isError: true };
        const decision = await this.wait("permission", { toolName: name, classification: classificationOf(intent), input: parsed.args, ...(verdict.risk ? { risk: verdict.risk } : {}) }, context.signal);
        if (decision.kind === "acceptForSession") this.allowed.add(key);
        else if (decision.kind !== "accept") {
          if (decision.kind === "cancel") turn.controller.abort();
          return { content: declinedMessage(name), isError: true };
        }
      }
      if (context.signal.aborted) return { content: "The turn was stopped before this call ran.", isError: true };
      const result = await tool.run(parsed.args as never, context);
      const notes = this.takeNotes();
      return notes ? { ...result, content: `${result.content}\n\n${notes}` } : result;
    } catch (cause) {
      return { content: cause instanceof Error ? cause.message : "Tool execution failed.", isError: true };
    }
  }

  private wait(kind: "permission", raw: unknown, signal: AbortSignal): Promise<ProviderApprovalDecision>;
  private wait(kind: "input", raw: unknown, signal: AbortSignal): Promise<AskReply>;
  private wait(kind: "permission" | "input", raw: unknown, signal: AbortSignal): Promise<ProviderApprovalDecision | AskReply> {
    const requestId = randomUUID();
    const base = { provider: "codex" as const, threadId: this.options.threadId, requestId };
    return new Promise((resolve) => {
      const settle = (value: ProviderApprovalDecision | AskReply): void => {
        if (!this.parked.delete(requestId)) return;
        signal.removeEventListener("abort", abort);
        this.options.publish({ ...base, type: kind === "input" ? "user-input.request.resolved" : "permission.request.resolved", raw });
        resolve(value);
      };
      const abort = (): void => settle(kind === "input" ? { kind: "dismissed" } : { kind: "cancel" });
      this.parked.set(requestId, kind === "input" ? { kind, resolve: settle } : { kind, resolve: settle });
      signal.addEventListener("abort", abort, { once: true });
      this.options.publish({ ...base, type: kind === "input" ? "user-input.request.opened" : "permission.request.opened", raw });
      if (signal.aborted) abort();
    });
  }

  respond(requestId: string, decision: ProviderApprovalDecision): boolean {
    const parked = this.parked.get(requestId);
    if (!parked) return false;
    if (parked.kind === "permission") parked.resolve(decision);
    else {
      if (decision.kind !== "decline" && decision.kind !== "cancel") throw new CliError("REQUEST_MISMATCH", "This request needs user input.");
      if (decision.kind === "cancel") this.active?.controller.abort();
      parked.resolve({ kind: "dismissed" });
    }
    return true;
  }

  answer(requestId: string, answers: ProviderUserInputAnswers): boolean {
    const parked = this.parked.get(requestId);
    if (!parked) return false;
    if (parked.kind !== "input") throw new CliError("REQUEST_MISMATCH", "This request needs a permission decision.");
    parked.resolve({ kind: "answered", answers });
    return true;
  }

  backgroundTasks(): readonly BackgroundTaskSummary[] {
    return this.background.running().map((task) => ({ taskId: task.id, taskType: "local_bash", toolName: task.tool, description: task.description, command: task.command, startedAt: task.startedAt, stoppable: true }));
  }
  output(id: string): readonly string[] | null { return this.background.tail(id, 500); }
  stop(id: string): Promise<boolean> { return this.background.stop(id); }

  private onBackground({ type, task }: BackgroundEvent): void {
    if (this.closed) return;
    if (type === "ended") this.notes.push(`Background task ${task.id} (${task.description}) ${task.status}${task.exitCode === null ? "" : `, exit code ${task.exitCode}`}. Read its output with task_output.`);
    const base = { provider: "codex" as const, threadId: this.options.threadId };
    this.options.publish({ ...base, type: "background.task", turnId: this.active?.id ?? null, taskId: task.id, status: type === "started" ? "started" : task.status === "running" ? "stopped" : task.status, description: task.description, taskType: "local_bash", toolUseId: task.toolUseId, summary: task.exitCode === null ? null : `exit code ${task.exitCode}` });
    this.options.publish({ ...base, type: "background.tasks.changed", tasks: this.backgroundTasks() });
  }
}
