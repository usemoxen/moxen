import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../config.js";
import { improvePrompt } from "../../../threads/promptimprover.js";
import { HarnessDriver } from "../../harness/driver.js";
import { DEFAULT_QUIRKS } from "../../harness/quirks.js";
import {
  chatErrorToCliError,
  failureFrom,
  SUBSCRIPTION_SHARING_LIMIT_CODE,
  type ChatRequest,
} from "../../harness/transport/chat.js";
import { responsesRequestBody } from "../../harness/transport/responses.js";
import type { ModelEvent } from "../../harness/types.js";
import {
  chatgptOAuthQuirks,
  createChatGptHarnessDriver,
  discoverChatGptModels,
  synthesizeChatGptTarget,
} from "../catalog.js";
import { CHATGPT_OAUTH_SCOPES, saveChatGptAuthBundle, type KeychainAdapter } from "../oauth.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeMemoryKeychain(): KeychainAdapter {
  const map = new Map<string, string>();
  return {
    read: async (name) => map.get(name) ?? null,
    write: async (name, value) => {
      if (value === "") map.delete(name);
      else map.set(name, value);
    },
  };
}

describe("ChatGPT OAuth Responses transport & per-app cap errors (MXN-461)", () => {
  it("builds ChatGPT OAuth Responses body with store:false, stream:true, top-level instructions, and omits unsupported params", () => {
    const body = responsesRequestBody({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6.1-sol",
      messages: [],
      transcript: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Fix the bug" },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      quirks: chatgptOAuthQuirks(),
      sampling: { temperature: 0.7, topP: 0.9 },
      maxTokens: 4096,
      effort: "high",
    });

    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("You are helpful.");
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.reasoning).toEqual({ summary: "auto", effort: "high" });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        strict: false,
      },
    ]);
    // No role:"system" items inside input.
    const inputItems = body.input as Array<Record<string, unknown>>;
    expect(inputItems.some((item) => item.role === "system")).toBe(false);

    // Non-ChatGPT Responses keeps max_output_tokens/temperature/top_p intact.
    const standard = responsesRequestBody({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6.1-sol",
      messages: [],
      transcript: [{ role: "user", content: "Hi" }],
      tools: [],
      quirks: DEFAULT_QUIRKS,
      sampling: { temperature: 0.5, topP: 0.8 },
      maxTokens: 2048,
    });
    expect(standard.max_output_tokens).toBe(2048);
    expect(standard.temperature).toBe(0.5);
    expect(standard.top_p).toBe(0.8);
  });

  it("classifies HTTP 429 subscription_sharing_usage_limit_exceeded as non-retryable per-app cap error", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: SUBSCRIPTION_SHARING_LIMIT_CODE,
          message: "Per-app weekly cap exceeded",
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const err = await failureFrom(response);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(false);
    expect(err.errorCode).toBe(SUBSCRIPTION_SHARING_LIMIT_CODE);
    expect(err.message).toContain("Settings → Usage → App limits");

    const cliErr = chatErrorToCliError(err);
    expect(cliErr.code).toBe("CHATGPT_APP_LIMIT_EXCEEDED");
    expect(cliErr.message).toContain("Settings → Usage → App limits");
  });

  it("discovers chat/reasoning models from /v1/models and filters out non-chat models", async () => {
    const mockFetch: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      expect(auth).toBe("Bearer at_live_token");
      return new Response(
        JSON.stringify({
          data: [
            { id: "gpt-6.1-sol" },
            { id: "gpt-5.4-mini" },
            { id: "o4-mini" },
            { id: "whisper-1" },
            { id: "tts-1-hd" },
            { id: "text-embedding-3-large" },
            { id: "gpt-image-1" },
            { id: "dall-e-3" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const models = await discoverChatGptModels("at_live_token", { fetch: mockFetch });
    expect(models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-5.4-mini", "o4-mini"]);
    expect(models[0]?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]?.vision).toBe(true);
  });

  it("runs zero-tool completeText on HarnessDriver for both chatgpt/<id> and harness/<id> and unlocks improvePrompt", async () => {
    const secrets = makeMemoryKeychain();
    await saveChatGptAuthBundle(
      "personal",
      {
        clientId: "oaiapp_1",
        accessToken: "at_zero_tool_secret",
        refreshToken: "rt_1",
        expiresAt: Date.now() + 3_600_000,
        scope: CHATGPT_OAUTH_SCOPES.join(" "),
        grantedAt: new Date().toISOString(),
        identity: { userId: "usr_1", email: "dev@example.test", emailVerified: true },
      },
      secrets,
    );

    const seenRequests: ChatRequest[] = [];
    async function* fakeTransport(req: ChatRequest): AsyncGenerator<ModelEvent> {
      seenRequests.push(req);
      yield { type: "text.delta", text: "Improved draft with acceptance criteria." };
      yield { type: "finish", reason: "stop" };
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-chatgpt-impr-"));
    tempDirs.push(dir);

    const chatgptDriver = createChatGptHarnessDriver({
      sessionsDir: path.join(dir, "sessions"),
      transport: fakeTransport,
      oauth: { secrets },
    });

    const improved = await improvePrompt(
      {
        ...DEFAULT_CONFIG,
        promptImprover: { provider: "chatgpt/personal", model: "gpt-6.1-sol" },
      },
      { directory: dir, prompt: "fix login" },
      (input) => chatgptDriver.completeText(input),
    );
    expect(improved).toEqual({
      text: "Improved draft with acceptance criteria.",
      provider: "chatgpt",
      model: "gpt-6.1-sol",
    });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.tools).toEqual([]);
    expect(seenRequests[0]?.apiKey).toBe("at_zero_tool_secret");
    expect(seenRequests[0]?.quirks.chatgptOAuth).toBe(true);

    // Zero tools on wire in responsesRequestBody too.
    const wire = responsesRequestBody(seenRequests[0]!);
    expect(wire.tools).toBeUndefined();
    expect(wire.tool_choice).toBeUndefined();
    expect(wire.max_output_tokens).toBeUndefined();
    expect(wire.instructions).toContain("You have no tools");

    // Plain HarnessDriver profile also supports zero-tool completeText.
    const harnessDriver = new HarnessDriver({
      sessionsDir: path.join(dir, "sessions-h"),
      config: {
        profiles: [
          {
            id: "local",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiFormat: "chat",
            models: [{ id: "qwen3-coder" }],
          },
        ],
      },
      transport: fakeTransport,
    });
    const text = await harnessDriver.completeText({
      workingDirectory: dir,
      instanceId: "harness/local",
      model: "qwen3-coder",
      prompt: "hi",
      instructions: "edit",
    });
    expect(text).toBe("Improved draft with acceptance criteria.");
    expect(seenRequests[1]?.tools).toEqual([]);

    // Synthesizing non-chatgpt id returns null.
    expect(synthesizeChatGptTarget("claude/work", "gpt-6.1-sol")).toBeNull();
  });
});
