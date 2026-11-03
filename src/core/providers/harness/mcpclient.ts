/**
 * A small MCP client for the harness: JSON-RPC 2.0 over a spawned process's
 * stdio (newline-delimited) or over streamable HTTP, tools only (`initialize`,
 * `tools/list`, `tools/call`). Like the server in `server/mcp/`, it is written
 * here rather than pulled in as a dependency, since this is the whole surface
 * the harness uses.
 *
 * What it guarantees, because the servers are not ours:
 * - a message, a response body or a result larger than a fixed cap ends the
 *   connection or is cut, never held whole;
 * - a child gets a small, fixed environment plus what its spec lists, never
 *   the harness's own (which holds the model's API key);
 * - a child is stopped by the pid this client spawned, as a process group;
 * - nothing from a spec's `env` or `headers`, or the URL (which may carry a
 *   token), appears in an error message.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { OutOfProcessMcpServerSpec } from "../../mcp.js";
import { attachmentFromBytes, IMAGE_LIMITS, imageSetError } from "../../attachments.js";
import type { ProviderImage } from "../spi.js";
import { killGroup } from "./tools/bash.js";
import { MAX_IMAGE_BYTES } from "./tools/files.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_MESSAGE_BYTES = 8_000_000;
/** Text kept from one tool result; the tool adapter bounds what the model sees from it further. */
export const MAX_RESULT_CHARS = 2_000_000;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_LIST_PAGES = 10;
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

/** The server went away (exited, closed its output, or lost its session). */
export class McpClosedError extends Error {}

/** The server answered with a JSON-RPC error. */
export class McpRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface McpCallResult {
  readonly text: string;
  readonly isError: boolean;
  /** Ordered text and image positions; text remains the fallback for callers without vision. */
  readonly parts?: readonly { readonly text: string; readonly image?: ProviderImage }[];
}

interface Rpc {
  readonly alive: boolean;
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  /** Told once `initialize` is answered. */
  negotiated(version: string): void;
  close(): Promise<void>;
}

const SAFE_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "TMPDIR", "TMP", "TEMP",
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "WINDIR",
]);

/** What a server process starts with: the basics a program needs to run, then whatever its spec adds. */
export function childEnvironment(extra: Readonly<Record<string, string>>, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(from)) {
    if (value !== undefined && (SAFE_ENV.has(key.toUpperCase()) || key.startsWith("LC_") || key.startsWith("XDG_"))) env[key] = value;
  }
  return { ...env, ...extra };
}

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settle(waiter: Waiter, message: Record<string, unknown>): void {
  if (isRecord(message.error)) {
    const error = message.error;
    waiter.reject(new McpRpcError(typeof error.message === "string" ? error.message : "The server returned an error.", typeof error.code === "number" ? error.code : -32603));
  } else {
    waiter.resolve(message.result);
  }
}

class StdioRpc implements Rpc {
  alive = true;
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Waiter>();
  private nextId = 1;
  private buffer = "";
  private closing: Promise<void> | null = null;

  constructor(spec: Extract<OutOfProcessMcpServerSpec, { type: "stdio" }>, cwd: string) {
    this.child = spawn(spec.command, [...spec.args], {
      cwd,
      env: childEnvironment(spec.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const { stdout, stderr, stdin } = this.child;
    stdout?.setEncoding("utf8");
    stdout?.on("data", (chunk: string) => this.onData(chunk));
    // Drained and dropped: a server's log lines are where its own secrets tend to end up.
    stderr?.resume();
    stdin?.on("error", () => {});
    this.child.on("error", (error) => this.die(new McpClosedError(`could not be started (${(error as NodeJS.ErrnoException).code ?? "error"})`)));
    this.child.on("close", (code, signal) => this.die(new McpClosedError(`exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}`)));
  }

  private die(error: Error): void {
    if (!this.alive) return;
    this.alive = false;
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) waiter.reject(error);
    // A server that hung up but is still running (or whose children are) is stopped here, by the pid we spawned.
    killGroup(this.child.pid, "SIGTERM");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line === "") continue;
      if (line.length > MAX_MESSAGE_BYTES) return this.fail();
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(message)) this.onMessage(message);
    }
    if (this.buffer.length > MAX_MESSAGE_BYTES) this.fail();
  }

  private fail(): void {
    this.buffer = "";
    this.die(new McpClosedError("sent a message larger than the limit and was disconnected"));
  }

  private onMessage(message: Record<string, unknown>): void {
    const { id } = message;
    if (typeof message.method === "string") {
      // The server asking us something: only `ping` is answerable, since no capability was offered.
      if (id !== undefined) this.write(message.method === "ping" ? { jsonrpc: "2.0", id, result: {} } : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (typeof id !== "number") return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    settle(waiter, message);
  }

  private write(message: unknown): void {
    if (this.alive) this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (!this.alive) return Promise.reject(new McpClosedError("is not running"));
    if (signal.aborted) return Promise.reject(signal.reason);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pending.delete(id)) this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The caller gave up." } });
        reject(signal.reason);
      };
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  negotiated(): void {}

  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      const pid = this.child.pid;
      this.die(new McpClosedError("was closed"));
      this.child.stdin?.end();
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const done = (): void => {
        clearTimeout(force);
        clearTimeout(give);
        resolve();
      };
      const force = setTimeout(() => killGroup(pid, "SIGKILL"), 2000);
      const give = setTimeout(done, 2500);
      force.unref();
      give.unref();
      this.child.once("close", done);
    });
    return this.closing;
  }
}

/** Reads a body up to a cap; `onChunk` may return true to stop early. */
async function readBody(response: Response, onChunk: (text: string) => boolean): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > MAX_MESSAGE_BYTES) throw new McpClosedError("sent a response larger than the limit");
      if (onChunk(decoder.decode(value, { stream: true }))) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

class HttpRpc implements Rpc {
  alive = true;
  private nextId = 1;
  private sessionId: string | null = null;
  private version: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  private post(body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      // A redirect would carry the headers (a token among them) somewhere the user never configured.
      redirect: "error",
      signal,
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId !== null ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.version !== null ? { "MCP-Protocol-Version": this.version } : {}),
      },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      if (signal.aborted) throw signal.reason;
      // The message is left out: it can hold the URL.
      throw new Error(`could not be reached (${error instanceof Error ? error.name : "error"})`);
    });
  }

  private check(response: Response): void {
    if (response.ok) return;
    if (response.status === 404 && this.sessionId !== null) {
      this.alive = false;
      throw new McpClosedError("ended the session");
    }
    throw new Error(`answered HTTP ${response.status}`);
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    this.check(response);
    this.sessionId ??= response.headers.get("mcp-session-id");
    const type = response.headers.get("content-type") ?? "";
    let found = null as Record<string, unknown> | null;
    const take = (value: unknown): boolean => {
      for (const item of Array.isArray(value) ? value : [value]) if (isRecord(item) && item.id === id && !("method" in item)) found = item;
      return found !== null;
    };
    try {
      if (type.includes("text/event-stream")) {
        let text = "";
        await readBody(response, (chunk) => {
          text += chunk;
          let at: number;
          while ((at = text.search(/\r?\n\r?\n/)) !== -1) {
            const event = text.slice(0, at);
            text = text.slice(at).replace(/^\r?\n\r?\n/, "");
            const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
            if (data === "") continue;
            try {
              if (take(JSON.parse(data))) return true;
            } catch {
              // Not JSON: not ours.
            }
          }
          return false;
        });
      } else {
        let text = "";
        await readBody(response, (chunk) => {
          text += chunk;
          return false;
        });
        if (text.trim() !== "") take(JSON.parse(text));
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof McpClosedError) throw error;
      throw new Error("sent an answer that could not be read");
    }
    if (found === null) throw new Error("ended its answer without replying to the request");
    return await new Promise((resolve, reject) => settle({ resolve, reject }, found!));
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }, AbortSignal.timeout(CONNECT_TIMEOUT_MS));
    await response.body?.cancel().catch(() => {});
  }

  negotiated(version: string): void {
    this.version = version;
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.sessionId === null) return;
    // Ending the session is courtesy; the server may not support it.
    await fetch(this.url, {
      method: "DELETE",
      redirect: "error",
      headers: { ...this.headers, "Mcp-Session-Id": this.sessionId },
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => response.body?.cancel())
      .catch(() => {});
  }
}

function toolInfo(raw: unknown): McpToolInfo | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") return null;
  const schema = isRecord(raw.inputSchema) ? { ...raw.inputSchema } : {};
  delete schema["$schema"];
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  return {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema: { ...schema, type: "object" },
    readOnly: annotations.readOnlyHint === true,
  };
}

/** Keep image positions alongside text, without making a non-vision caller hold a binary string in its text. */
function resultContent(result: Record<string, unknown>): Omit<McpCallResult, "isError"> {
  const parts: { text: string; image?: ProviderImage }[] = [];
  const images: { name: string; dataUrl: string }[] = [];
  const addText = (text: string) => parts.push({ text });
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") addText(block.text);
    else if (block.type === "image") {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown";
      const placeholder = (why: string) => `[image: ${mime}, ${why}]`;
      let why: string | null = null;
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) why = "unsupported type";
      else if (typeof block.data !== "string" || block.data.length === 0) why = "invalid data";
      // Match the built-in file reader's byte cap before allocating decoded bytes.
      else if (block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) why = "too large";
      else if (block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) why = "invalid data";
      else if (images.length >= IMAGE_LIMITS.imagesPerMessage) why = "too many images";
      if (why !== null) {
        addText(placeholder(why));
        continue;
      }
      const data = block.data as string;
      const bytes = Buffer.from(data, "base64");
      const name = `MCP image ${images.length + 1}`;
      const built = attachmentFromBytes(name, mime, bytes);
      if (bytes.length > MAX_IMAGE_BYTES || built.error !== null) {
        addText(placeholder("too large"));
        continue;
      }
      const candidate = { name, dataUrl: built.attachment.dataUrl };
      if (imageSetError([...images, candidate]) !== null) {
        addText(placeholder("image set limit exceeded"));
        continue;
      }
      images.push(candidate);
      parts.push({ text: placeholder("model does not support images"), image: { name, mimeType: mime, data } });
    } else if (block.type === "audio") addText(`[audio${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""}, not shown]`);
    else if (block.type === "resource_link" && typeof block.uri === "string") addText(`[link: ${block.uri}]`);
    else if (block.type === "resource" && isRecord(block.resource)) {
      const { text, uri } = block.resource;
      addText(typeof text === "string" ? text : `[resource${typeof uri === "string" ? `: ${uri}` : ""}, not shown]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) addText(JSON.stringify(result.structuredContent));
  const text = parts.map((part) => part.text).join("\n");
  const boundedText = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[… cut at ${MAX_RESULT_CHARS} characters]` : text;
  if (images.length === 0) return { text: boundedText };
  let remaining = MAX_RESULT_CHARS;
  const bounded = parts.flatMap((part) => {
    // A long text block must not erase the pictures that follow it.
    if (part.image) return [part];
    if (remaining <= 0) return [];
    const text = part.text.slice(0, remaining);
    remaining -= part.text.length + 1;
    return [{ ...part, text }];
  });
  if (remaining < 0) bounded.push({ text: `[… cut at ${MAX_RESULT_CHARS} characters]` });
  return { text: boundedText, parts: bounded };
}

export class McpClient {
  private constructor(
    private readonly rpc: Rpc,
    readonly tools: readonly McpToolInfo[],
    readonly dropped: number,
  ) {}

  get alive(): boolean {
    return this.rpc.alive;
  }

  /** Starts the server, negotiates, and lists its tools. The server is stopped again if any of that fails. */
  static async connect(spec: OutOfProcessMcpServerSpec, cwd: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<McpClient> {
    const rpc: Rpc = spec.type === "http" ? new HttpRpc(spec.url, spec.headers) : new StdioRpc(spec, cwd);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const init = await rpc.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "moxen-harness", version: "0" } }, signal);
      if (!isRecord(init)) throw new Error("answered initialize with something else");
      rpc.negotiated(typeof init.protocolVersion === "string" ? init.protocolVersion : MCP_PROTOCOL_VERSION);
      await rpc.notify("notifications/initialized");
      const infos: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listed = await rpc.request("tools/list", cursor === undefined ? {} : { cursor }, signal);
        if (!isRecord(listed) || !Array.isArray(listed.tools)) throw new Error("answered tools/list with something else");
        for (const raw of listed.tools) {
          const info = toolInfo(raw);
          if (info) infos.push(info);
        }
        cursor = typeof listed.nextCursor === "string" && listed.nextCursor !== "" ? listed.nextCursor : undefined;
        if (cursor === undefined) break;
      }
      infos.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      return new McpClient(rpc, infos.slice(0, MAX_TOOLS_PER_SERVER), Math.max(0, infos.length - MAX_TOOLS_PER_SERVER));
    } catch (error) {
      await rpc.close().catch(() => {});
      if (signal.aborted && !(error instanceof McpClosedError)) throw new Error(`did not answer within ${Math.round(timeoutMs / 1000)}s`);
      throw error;
    }
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<McpCallResult> {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let result: unknown;
    try {
      result = await this.rpc.request("tools/call", { name: tool, arguments: args }, limit);
    } catch (error) {
      if (signal.aborted) throw error;
      if (limit.aborted) return { text: `The call did not finish within ${Math.round(timeoutMs / 1000)}s and was given up on.`, isError: true };
      if (error instanceof McpRpcError) return { text: error.message, isError: true };
      throw error;
    }
    if (!isRecord(result)) return { text: "The server answered with something that is not a tool result.", isError: true };
    return { ...resultContent(result), isError: result.isError === true };
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}
