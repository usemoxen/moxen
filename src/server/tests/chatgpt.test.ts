import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildDirectProviders } from "../../core/catalog/direct.js";
import { codexImageGenDisabledTools, verifyCodexCompanion } from "../../core/providers/chatgpt/companion.js";
import {
  CHATGPT_OAUTH_SCOPES,
  OPENAI_OIDC_ISSUER,
  resetChatGptOAuthCachesForTests,
  type KeychainAdapter,
  type OpenIdConfiguration,
} from "../../core/providers/chatgpt/oauth.js";
import { CodexDriver } from "../../core/providers/codex/driver.js";
import { FakeCodexTransport } from "../../core/providers/codex/tests/fakes.js";
import { resetUsageLimitsForTests, usageLimitsSnapshot } from "../../core/usage/limits.js";
import { DirectConnection } from "../connection.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig", alg: "RS256" };

function signJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

const DISCOVERY: OpenIdConfiguration = {
  issuer: OPENAI_OIDC_ISSUER,
  authorization_endpoint: `${OPENAI_OIDC_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${OPENAI_OIDC_ISSUER}/api/accounts/oauth/token`,
  revocation_endpoint: `${OPENAI_OIDC_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${OPENAI_OIDC_ISSUER}/.well-known/jwks.json`,
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMemoryKeychain(): KeychainAdapter & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    read: async (name) => map.get(name) ?? null,
    write: async (name, value) => {
      if (value === "") map.delete(name);
      else map.set(name, value);
    },
  };
}

afterEach(() => {
  resetChatGptOAuthCachesForTests();
  resetUsageLimitsForTests();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Sign in with ChatGPT server flow, Codex companion verification, and standalone Codex retirement (MXN-462)", () => {
  it("keeps standalone codex companion-only (disabled in pickers) while discovering signed-in chatgpt/<id> models", async () => {
    const dir = makeTempDir("moxen-chatgpt-cat-");
    const providers = await buildDirectProviders({
      env: { PATH: "/nonexistent" },
      storeRoot: dir,
      modelsDev: async () => ({ catalog: [], source: "empty" }),
      fetchCodexProvider: async () => ({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: null,
        authStatus: "chatgpt",
        models: [],
        supportedRuntimeModes: null,
        usageLimits: null,
        skills: [],
      }),
      chatgpt: {
        accounts: [
          {
            id: "personal",
            label: "Personal",
            authRef: "keychain:chatgpt.account.personal",
            planType: "plus",
          },
        ],
      },
      fetchChatGptModels: async () => [
        { id: "gpt-6.1-sol", contextWindow: 400_000, maxOutput: 32_768, vision: true, efforts: ["low", "medium", "high"] },
      ],
    });

    // Standalone codex is omitted from user-facing provider catalogs (companion-only under the hood).
    const codex = providers.find((entry) => entry.instanceId === "codex");
    expect(codex).toBeUndefined();

    const chatgpt = providers.find((entry) => entry.instanceId === "chatgpt/personal");
    expect(chatgpt?.enabled).toBe(true);
    expect(chatgpt?.models.map((m) => m.slug)).toEqual(["gpt-6.1-sol"]);
  });

  it("verifies Codex companion identity strictly — never silently pairs by email alone and refuses mismatches", () => {
    const identity = {
      userId: "usr_1",
      email: "dev@example.test",
      emailVerified: true,
      accountId: "acct_work",
      workspaceName: "Acme",
    };

    // Email mismatch is always refused, even with confirmWorkspace.
    expect(
      verifyCodexCompanion(
        identity,
        { type: "chatgpt", email: "other@example.test", planType: "plus", workspaceName: "Acme", userId: "usr_1" },
        { accountId: "acct_work", windows: [] },
        { confirmWorkspace: true },
      ),
    ).toMatchObject({ verified: false, needsConfirmation: false });

    // Workspace/accountId mismatch is always refused, even with confirmWorkspace.
    expect(
      verifyCodexCompanion(
        identity,
        { type: "chatgpt", email: "dev@example.test", planType: "plus", workspaceName: "Personal", userId: "usr_1" },
        { accountId: "acct_personal", windows: [] },
        { confirmWorkspace: true },
      ),
    ).toMatchObject({ verified: false, needsConfirmation: false });

    // Email-only match (no shared accountId or userId) demands explicit confirmation.
    const emailOnlyIdentity = { userId: "auth0|opaque", email: "dev@example.test", emailVerified: true };
    const codexAccount = { type: "chatgpt", email: "dev@example.test", planType: "team", workspaceName: "Acme", userId: "usr_different_format" };
    expect(verifyCodexCompanion(emailOnlyIdentity, codexAccount, { accountId: null, windows: [] })).toMatchObject({
      verified: false,
      needsConfirmation: true,
    });
    expect(
      verifyCodexCompanion(emailOnlyIdentity, codexAccount, { accountId: null, windows: [] }, { confirmWorkspace: true }),
    ).toMatchObject({ verified: true, needsConfirmation: false });

    // Strong match (email + accountId) auto-verifies.
    expect(
      verifyCodexCompanion(
        identity,
        { type: "chatgpt", email: "dev@example.test", planType: "team", workspaceName: "Acme", userId: "usr_1" },
        { accountId: "acct_work", windows: [] },
      ),
    ).toMatchObject({ verified: true, needsConfirmation: false, reason: null });
  });

  it("runs chatgpt.login.start -> complete -> codex.pair -> logout through DirectConnection without leaking secrets", async () => {
    const dir = makeTempDir("moxen-chatgpt-srv-");
    const configPath = path.join(dir, "config.json");
    const secrets = makeMemoryKeychain();
    let expectedNonce = "";

    const mockFetch: typeof fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(DISCOVERY), { status: 200 });
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
      }
      if (url.endsWith("/oauth/token")) {
        const nowSec = Math.floor(Date.now() / 1000);
        return new Response(
          JSON.stringify({
            access_token: "at_secret_value",
            refresh_token: "rt_secret_value",
            scope: CHATGPT_OAUTH_SCOPES.join(" "),
            expires_in: 3600,
            id_token: signJwt({
              iss: OPENAI_OIDC_ISSUER,
              sub: "usr_chat_42",
              aud: "oaiapp_moxen",
              exp: nowSec + 3600,
              nonce: expectedNonce,
              email: "dev@example.test",
              email_verified: true,
              "https://api.openai.com/auth": {
                chatgpt_user_id: "usr_chat_42",
                chatgpt_account_id: "acct_42",
                workspace_name: "Personal",
                chatgpt_plan_type: "plus",
              },
            }),
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const resetIso = new Date(Date.now() + 3_600_000).toISOString();
    let probeEmail = "wrong@example.test";

    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath,
      builtinMcpServers: null,
      chatgptOAuth: { fetch: mockFetch, secrets, bindLoopback: false },
      probeCodexCompanion: async () => ({
        account: {
          type: "chatgpt",
          email: probeEmail,
          planType: "plus",
          workspaceName: "Personal",
          userId: "usr_chat_42",
        },
        rateLimits: {
          accountId: "acct_42",
          windows: [{ id: "primary", label: "Session", usedPercent: 22, exhausted: false, resetsAt: resetIso }],
        },
      }),
    });

    try {
      const started = await conn.dispatch({ type: "chatgpt.login.start", accountId: "personal", label: "Personal" });
      const authUrl = new URL(started.authorizationUrl);
      const state = authUrl.searchParams.get("state")!;
      expectedNonce = authUrl.searchParams.get("nonce")!;

      const completed = await conn.dispatch({
        type: "chatgpt.login.complete",
        sessionId: started.sessionId,
        callbackUrl: `${started.redirectUri}?code=code_1&state=${encodeURIComponent(state)}&client_id=oaiapp_moxen`,
      });
      expect(completed.account).toMatchObject({
        kind: "chatgpt",
        id: "personal",
        instanceId: "chatgpt/personal",
        email: "dev@example.test",
        planType: "plus",
        signedIn: true,
        codexVerified: false,
      });

      // Config file must NEVER contain access_token or refresh_token.
      const diskConfig = fs.readFileSync(configPath, "utf8");
      expect(diskConfig).not.toContain("at_secret_value");
      expect(diskConfig).not.toContain("rt_secret_value");
      expect(diskConfig).toContain("keychain:chatgpt.account.personal");

      // Mismatched Codex companion is refused.
      const mismatch = await conn.dispatch({
        type: "chatgpt.codex.pair",
        accountId: "personal",
        codexHomePath: "~/.codex-wrong",
      });
      expect(mismatch.verified).toBe(false);
      expect(mismatch.reason).toContain("Email mismatch");
      expect(mismatch.account.codexVerified).toBe(false);

      // Matching Codex companion verifies and publishes live usage under chatgpt/personal.
      probeEmail = "dev@example.test";
      const paired = await conn.dispatch({
        type: "chatgpt.codex.pair",
        accountId: "personal",
        codexHomePath: "~/.codex-personal",
      });
      expect(paired.verified).toBe(true);
      expect(paired.account.codexVerified).toBe(true);
      expect(paired.account.codexHomePath).toBe("~/.codex-personal");
      expect(usageLimitsSnapshot()["chatgpt/personal"]?.windows[0]).toMatchObject({
        id: "primary",
        usedPercent: 22,
      });

      // Logout clears keychain and resets signedIn/codexVerified.
      const loggedOut = await conn.dispatch({ type: "chatgpt.logout", accountId: "personal" });
      expect(loggedOut.account?.signedIn).toBe(false);
      expect(loggedOut.account?.codexVerified).toBe(false);
      expect(secrets.map.has("chatgpt.account.personal")).toBe(false);
    } finally {
      await conn.close();
    }
  });

  it("locks down hidden Codex image-generation sessions with codexDisabledToolConfig and enforces paired companion on chatgpt/<id>", async () => {
    expect(codexImageGenDisabledTools(false)).toContain("view_image");
    expect(codexImageGenDisabledTools(true)).not.toContain("view_image");
    expect(codexImageGenDisabledTools(true)).toEqual(
      expect.arrayContaining(["shell", "subagents", "web_search", "browser", "computer", "apps", "sleep", "goals"]),
    );

    // Verify CodexDriver sends locked-down features on thread/start when hidden image-gen runs.
    const dir = makeTempDir("moxen-chatgpt-imggen-");
    const transport = new FakeCodexTransport({
      account: { account: { type: "chatgpt", planType: "plus" } },
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
        },
      },
    });
    const codex = new CodexDriver({ transport });
    const conn = new DirectConnection({
      storeRoot: path.join(dir, "store"),
      configPath: path.join(dir, "config.json"),
      builtinMcpServers: null,
      drivers: { codex: () => codex },
      providers: async () => [
        {
          instanceId: "chatgpt/personal",
          driver: "chatgpt",
          displayName: "ChatGPT (Personal)",
          enabled: true,
          installed: true,
          status: null,
          authStatus: "plus",
          models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isCustom: false, isDefault: true, isHidden: false, efforts: [] }],
          supportedRuntimeModes: null,
          usageLimits: null,
          skills: [],
        },
      ],
    });
    try {
      const { projectId } = await conn.dispatch({ type: "project.create", workspaceRoot: dir });
      const { threadId } = await conn.dispatch({
        type: "thread.create",
        projectId,
        modelSelection: { instanceId: "chatgpt/personal", model: "gpt-6.1-sol" },
      });
      const avail = await conn.query({ type: "image-generation.availability", threadId });
      expect(avail.available).toBe(false);
      expect(avail.reason).toContain("Link a verified Codex companion");
    } finally {
      await conn.close();
    }
  });
});
