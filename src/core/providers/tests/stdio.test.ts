import { describe, expect, it } from "vitest";

import { createLinkedPair, JsonRpcPeer } from "../stdio.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("stdio JSON-RPC peer", () => {
  it("routes requests, notifications, and server requests over a linked pair", async () => {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const serverPeer = new JsonRpcPeer(server, { forceKillAfterMs: 0 });

    const notifications: Array<{ method: string; params: unknown }> = [];
    serverPeer.onNotification((method, params) => {
      notifications.push({ method, params });
    });
    serverPeer.onRequest(async (method, params) => {
      if (method === "add") {
        const { a, b } = params as { a: number; b: number };
        return a + b;
      }
      throw new Error(`unknown ${method}`);
    });

    const serverRequests: Array<{ method: string; params: unknown }> = [];
    clientPeer.onRequest(async (method, params) => {
      serverRequests.push({ method, params });
      return { ok: true };
    });

    await expect(clientPeer.request("add", { a: 2, b: 3 })).resolves.toBe(5);
    clientPeer.notify("event/happened", { n: 1 });
    await expect.poll(() => notifications.length).toBe(1);
    expect(notifications).toEqual([{ method: "event/happened", params: { n: 1 } }]);

    await expect(serverPeer.request("client/ping", {})).resolves.toEqual({ ok: true });
    expect(serverRequests).toEqual([{ method: "client/ping", params: {} }]);

    await expect(clientPeer.request("nope", {}, 50)).rejects.toMatchObject({
      code: "PEER_REQUEST_FAILED",
    });
  });

  it("idle timeout restarts on peer traffic and fires only when the peer goes silent", async () => {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const serverPeer = new JsonRpcPeer(server, { forceKillAfterMs: 0 });
    serverPeer.onRequest(async () => {
      for (let i = 0; i < 5; i++) {
        await sleep(30);
        serverPeer.notify("progress", { i });
      }
      return "done";
    });
    // 150ms of work total, but never more than ~30ms silent against a 80ms idle limit.
    await expect(clientPeer.request("busy", {}, 80, { idle: true })).resolves.toBe("done");

    serverPeer.onRequest(async () => {
      await sleep(500);
      return null;
    });
    await expect(clientPeer.request("silent", {}, 30, { idle: true })).rejects.toMatchObject({
      code: "PEER_REQUEST_TIMEOUT",
    });
    clientPeer.close();
    serverPeer.close();
  });

  it("idle timeout restarts only on valid JSON-RPC messages and still honors a hard deadline (LOCAL-009)", async () => {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const serverPeer = new JsonRpcPeer(server, { forceKillAfterMs: 0 });
    // The server takes requests but never answers them.
    serverPeer.onRequest(() => new Promise(() => {}));

    // Malformed / non-JSON-RPC lines are not attributable to the session: they never restart the idle timer.
    const garbage = setInterval(() => server.writeLine("agy: warning -- some non-JSON log line"), 20);
    const outcome = await Promise.race([
      clientPeer.request("hung", {}, 80, { idle: true }).then(
        () => "answered",
        (error: unknown) => (error as { code: string }).code,
      ),
      sleep(400).then(() => "still-pending"),
    ]);
    clearInterval(garbage);
    expect(outcome).toBe("PEER_REQUEST_TIMEOUT");

    // Valid session traffic restarts the idle timer, but the hard deadline still fires.
    const ticks = setInterval(() => serverPeer.notify("session/update", { n: 1 }), 30);
    const startedAt = Date.now();
    await expect(clientPeer.request("long", {}, 80, { idle: true, deadlineMs: 250 })).rejects.toMatchObject({
      code: "PEER_REQUEST_TIMEOUT",
    });
    clearInterval(ticks);
    // It outlived several 80ms idle windows thanks to the traffic, then died at the deadline.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(240);
    clientPeer.close();
    serverPeer.close();
  });

  it("idle timeout restarts only on messages the caller attributes to the session, and clamps timer values above 2^31-1 ms (LOCAL-009)", async () => {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const serverPeer = new JsonRpcPeer(server, { forceKillAfterMs: 0 });
    // The server takes requests but never answers them.
    serverPeer.onRequest(() => new Promise(() => {}));

    const match = (message: Record<string, unknown>): boolean => {
      const params = message["params"];
      return (
        params !== null &&
        typeof params === "object" &&
        !Array.isArray(params) &&
        (params as Record<string, unknown>)["sessionId"] === "s1"
      );
    };

    // Valid frames for ANOTHER session, a bare unrelated id, and garbage never restart this request's idle timer.
    const noise = setInterval(() => {
      serverPeer.notify("session/update", { sessionId: "s2", update: { sessionUpdate: "agent_message_chunk" } });
      server.writeLine("not json at all");
      server.writeLine(JSON.stringify({ jsonrpc: "2.0", id: "req-999", result: null }));
    }, 20);
    const outcome = await Promise.race([
      clientPeer
        .request("prompt", {}, 120, { idle: true, activityMatch: match })
        .then(
          () => "answered",
          (error: unknown) => (error as { code: string }).code,
        ),
      sleep(500).then(() => "still-pending"),
    ]);
    clearInterval(noise);
    expect(outcome).toBe("PEER_REQUEST_TIMEOUT");

    // Same-session traffic does restart the idle timer, and a deadline above
    // 2147483647 ms must not fire immediately (the platform clamps it to 1ms).
    const ticks = setInterval(() => serverPeer.notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } }), 30);
    const clamped = await Promise.race([
      clientPeer
        .request("prompt2", {}, 80, { idle: true, deadlineMs: 2 ** 31, activityMatch: match })
        .then(
          () => "answered",
          (error: unknown) => (error as { code: string }).code,
        ),
      sleep(400).then(() => "still-pending"),
    ]);
    clearInterval(ticks);
    expect(clamped).toBe("still-pending");
    clientPeer.close();
    serverPeer.close();
  });

  it("times out and closes cleanly", async () => {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const serverPeer = new JsonRpcPeer(server, { forceKillAfterMs: 0 });
    serverPeer.onRequest(async () => {
      await sleep(500);
      return null;
    });
    await expect(clientPeer.request("slow", {}, 30)).rejects.toMatchObject({
      code: "PEER_REQUEST_TIMEOUT",
    });

    let exitCode: number | null | undefined;
    clientPeer.onExit((code) => {
      exitCode = code;
    });
    clientPeer.close();
    expect(clientPeer.closed).toBe(true);
    await expect(clientPeer.request("late", {})).rejects.toMatchObject({ code: "PEER_CLOSED" });
    expect(exitCode).toBeUndefined();
  });

  it("delivers bursts of notifications in order", async () => {
    const { client, server } = createLinkedPair();
    const clientPeer = new JsonRpcPeer(client, { forceKillAfterMs: 0 });
    const serverPeer = new JsonRpcPeer(server, { forceKillAfterMs: 0 });
    const received: unknown[] = [];
    serverPeer.onNotification((_method, params) => {
      received.push(params);
    });
    clientPeer.notify("m", { v: 1 });
    clientPeer.notify("m", { v: 2 });
    clientPeer.notify("m", { v: 3 });
    await expect.poll(() => received.length).toBe(3);
    expect(received).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
    clientPeer.close();
    serverPeer.close();
  });
});
