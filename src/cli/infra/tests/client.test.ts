/**
 * `awaitTurn` follows the ledger: a dropped socket ends the wait, never
 * the turn, so it retries the await on `SERVER_DISCONNECTED` — bounded,
 * so a server that never returns still ends with that error. Anything
 * else fails at once.
 */
import { describe, expect, it, vi } from "vitest";

import { CliError } from "../../../core/errors.js";
import type { ClientApi } from "../../../server/api.js";
import { awaitTurn } from "../client.js";

function disconnect(): CliError {
  return new CliError("SERVER_DISCONNECTED", "The moxen server went away before answering.", {
    details: { endpoint: "test" },
  });
}

function clientWith(query: (threadId: string, turnId: string) => Promise<unknown>): ClientApi {
  return { query: vi.fn(async () => await query("thread-1", "turn-1")) } as unknown as ClientApi;
}

describe("awaitTurn", () => {
  it("retries the await after a dropped connection and returns once the server answers", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      if (calls === 1) throw disconnect();
      return { status: "completed" };
    });
    await awaitTurn(client, "thread-1", "turn-1", { retryDelayMs: 5, maxRetries: 5 });
    expect(calls).toBe(2);
  });

  it("stops retrying and throws the disconnect when the server never returns", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw disconnect();
    });
    const error = await awaitTurn(client, "thread-1", "turn-1", { retryDelayMs: 5, maxRetries: 3 }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("SERVER_DISCONNECTED");
    expect(calls).toBe(4);
  });

  it("does not retry other failures", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw new CliError("TURN_NOT_FOUND", "No turn exists with id turn-1.", { exitCode: 3 });
    });
    const error = await awaitTurn(client, "thread-1", "turn-1", { retryDelayMs: 5, maxRetries: 3 }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ code: "TURN_NOT_FOUND" });
    expect(calls).toBe(1);
  });
});
