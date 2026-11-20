/**
 * Scripted ACP v1 agent double over an in-memory linked pair. Answers
 * `initialize`, `session/new`, `session/load`, `session/prompt`, and
 * `session/set_config_option`, and lets tests push `session/update`
 * notifications and server->client requests (`session/request_permission`,
 * `fs/*`, `terminal/*`) on demand.
 */
import { createLinkedPair, JsonRpcPeer, type SpawnedProcess } from "../../stdio.js";
import { ACP_PROTOCOL_VERSION } from "../protocol.js";
import type { AcpSpawnOptions, AcpTransport } from "../transport.js";

export interface FakeAcpScript {
  /** Override the negotiated protocolVersion returned from `initialize`. */
  readonly protocolVersion?: unknown;
  readonly loadSession?: boolean;
  readonly canCloseSession?: boolean;
  readonly version?: string;
  readonly imageCapability?: boolean;
  readonly mcpHttp?: boolean;
  readonly mcpSse?: boolean;
  readonly sessionId?: string;
  readonly lostSessions?: readonly string[];
  readonly modes?: unknown;
  readonly models?: unknown;
  readonly configOptions?: unknown[];
  readonly authMethods?: unknown[];
  readonly failRequests?: Record<string, string>;
  /** Custom handler for `session/prompt`; return `{ stopReason }` or hold until resolved. */
  readonly onPrompt?: (
    server: FakeAcpServer,
    params: unknown,
  ) => Promise<unknown> | unknown;
}

export class FakeAcpServer {
  readonly peer: JsonRpcPeer;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly spawnOptions: AcpSpawnOptions;
  private promptResolvers: Array<(result: unknown) => void> = [];

  constructor(
    serverProcess: SpawnedProcess,
    spawnOptions: AcpSpawnOptions,
    private readonly script: FakeAcpScript = {},
  ) {
    this.spawnOptions = spawnOptions;
    this.peer = new JsonRpcPeer(serverProcess, { forceKillAfterMs: 0 });
    this.peer.onRequest(async (method, params) => {
      this.requests.push({ method, params });
      return this.answer(method, params);
    });
    this.peer.onNotification((method, params) => {
      this.notifications.push({ method, params });
    });
  }

  private async answer(method: string, params: unknown): Promise<unknown> {
    const failure = this.script.failRequests?.[method];
    if (failure) throw new Error(failure);
    switch (method) {
      case "initialize":
        return {
          protocolVersion:
            "protocolVersion" in this.script ? this.script.protocolVersion : ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: this.script.loadSession ?? true,
            ...(this.script.canCloseSession ? { sessionCapabilities: { close: {} } } : {}),
            promptCapabilities: {
              image: this.script.imageCapability ?? true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: this.script.mcpHttp ?? true,
              sse: this.script.mcpSse ?? false,
            },
          },
          agentInfo: { name: this.spawnOptions.agent.id, title: this.spawnOptions.agent.name ?? this.spawnOptions.agent.id, version: this.script.version ?? "1.0.0" },
          authMethods: this.script.authMethods ?? [],
        };
      case "session/new":
        return {
          sessionId: this.script.sessionId ?? "acp-sess-1",
          ...(this.script.modes ? { modes: this.script.modes } : {}),
          ...(this.script.models ? { models: this.script.models } : {}),
          ...(this.script.configOptions ? { configOptions: this.script.configOptions } : {}),
        };
      case "session/close":
        return {};
      case "session/load": {
        const sessionId = (params as { sessionId?: string } | null)?.sessionId;
        if (!sessionId || this.script.lostSessions?.includes(sessionId)) {
          throw new Error(`session not found: ${String(sessionId)}`);
        }
        return {
          sessionId,
          ...(this.script.modes ? { modes: this.script.modes } : {}),
          ...(this.script.configOptions ? { configOptions: this.script.configOptions } : {}),
        };
      }
      case "session/set_config_option": {
        const p = params as { configId?: string; value?: string } | null;
        const updated = (this.script.configOptions ?? []).map((opt) => {
          const rec = opt as Record<string, unknown>;
          return rec["id"] === p?.configId ? { ...rec, currentValue: p?.value } : rec;
        });
        return { configOptions: updated };
      }
      case "session/prompt": {
        if (this.script.onPrompt) {
          return this.script.onPrompt(this, params);
        }
        return new Promise((resolve) => {
          this.promptResolvers.push(resolve);
        });
      }
      default:
        throw new Error(`unexpected ACP method ${method}`);
    }
  }

  /** Finish the oldest pending `session/prompt` request. */
  finishPrompt(stopReason = "end_turn"): void {
    const resolve = this.promptResolvers.shift();
    if (resolve) resolve({ stopReason });
  }

  notifyUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.peer.notify("session/update", { sessionId, update });
  }

  /** Agent -> client reverse-RPC request. */
  ask(method: string, params?: unknown): Promise<unknown> {
    return this.peer.request(method, params, 5000);
  }

  requestsTo(method: string): Array<{ method: string; params: unknown }> {
    return this.requests.filter((request) => request.method === method);
  }

  notificationsTo(method: string): Array<{ method: string; params: unknown }> {
    return this.notifications.filter((notification) => notification.method === method);
  }
}

export class FakeAcpTransport implements AcpTransport {
  readonly sessions: Array<{ client: JsonRpcPeer; server: FakeAcpServer }> = [];

  constructor(private readonly script: FakeAcpScript = {}) {}

  startPeer(options: AcpSpawnOptions): JsonRpcPeer {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const fake = new FakeAcpServer(server, options, this.script);
    this.sessions.push({ client: clientPeer, server: fake });
    return clientPeer;
  }
}
