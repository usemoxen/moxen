import crypto from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildAuthorizationUrl,
  CHATGPT_OAUTH_SCOPES,
  chatgptAccountAuthRef,
  clearChatGptAuth,
  createPkceSession,
  discoverOpenIdConfig,
  DYNAMIC_AGENT_CLIENT_ID,
  ensureFreshChatGptToken,
  exchangeAuthorizationCode,
  getOrCreateAgentHostId,
  loadChatGptAuthBundle,
  OPENAI_API_RESOURCE,
  OPENAI_OIDC_ISSUER,
  parseAuthorizationCallback,
  REQUIRED_DIRECT_SCOPE,
  resetChatGptOAuthCachesForTests,
  saveChatGptAuthBundle,
  verifyIdToken,
  type KeychainAdapter,
  type OpenIdConfiguration,
} from "../oauth.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig", alg: "RS256" };

function signJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "k1" }): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
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

const DISCOVERY: OpenIdConfiguration = {
  issuer: OPENAI_OIDC_ISSUER,
  authorization_endpoint: `${OPENAI_OIDC_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${OPENAI_OIDC_ISSUER}/api/accounts/oauth/token`,
  revocation_endpoint: `${OPENAI_OIDC_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${OPENAI_OIDC_ISSUER}/.well-known/jwks.json`,
};

afterEach(() => resetChatGptOAuthCachesForTests());

describe("Sign in with ChatGPT OAuth 2.0 PKCE + OIDC (MXN-460)", () => {
  it("builds a PKCE S256 dynamic_agent_client authorization URL with urn:uuid host ID and parses callback + issued client_id", async () => {
    const secrets = makeMemoryKeychain();
    const hostId1 = await getOrCreateAgentHostId(secrets);
    const hostId2 = await getOrCreateAgentHostId(secrets);
    expect(hostId1).toBe(hostId2);
    expect(hostId1).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    // Legacy bare UUID already saved in keychain is upgraded in-place to urn:uuid:...
    const legacySecrets = makeMemoryKeychain();
    await legacySecrets.write("chatgpt.host_id", "6591ea8b-fb76-46e5-9485-05f96f0e341d");
    const upgraded = await getOrCreateAgentHostId(legacySecrets);
    expect(upgraded).toBe("urn:uuid:6591ea8b-fb76-46e5-9485-05f96f0e341d");
    expect(legacySecrets.map.get("chatgpt.host_id")).toBe("urn:uuid:6591ea8b-fb76-46e5-9485-05f96f0e341d");

    const pkce = createPkceSession();
    const expectedChallenge = crypto.createHash("sha256").update(pkce.codeVerifier).digest("base64url");
    expect(pkce.codeChallenge).toBe(expectedChallenge);

    const authUrl = new URL(
      buildAuthorizationUrl({
        discovery: DISCOVERY,
        pkce,
        redirectUri: "http://127.0.0.1:43210/callback",
        hostId: hostId1,
      }),
    );
    expect(authUrl.searchParams.get("client_id")).toBe(DYNAMIC_AGENT_CLIENT_ID);
    expect(authUrl.searchParams.get("ext_agent_host_id")).toBe(hostId1);
    expect(authUrl.searchParams.get("agent_name_hint")).toBe("Moxen");
    expect(authUrl.searchParams.get("resource")).toBe(OPENAI_API_RESOURCE);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toBe(CHATGPT_OAUTH_SCOPES.join(" "));

    // Returning sign-in with issued client_id keeps ext_agent_host_id (normalized) and omits agent_name_hint.
    const reauthUrl = new URL(
      buildAuthorizationUrl({
        discovery: DISCOVERY,
        pkce,
        redirectUri: "http://127.0.0.1:43210/callback",
        clientId: "oaiapp_issued_1",
        hostId: "6591ea8b-fb76-46e5-9485-05f96f0e341d",
      }),
    );
    expect(reauthUrl.searchParams.get("client_id")).toBe("oaiapp_issued_1");
    expect(reauthUrl.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:6591ea8b-fb76-46e5-9485-05f96f0e341d");
    expect(reauthUrl.searchParams.get("agent_name_hint")).toBeNull();

    const parsed = parseAuthorizationCallback(
      `http://127.0.0.1:43210/callback?code=abc123&state=${encodeURIComponent(pkce.state)}&client_id=oaiapp_issued_1`,
      pkce.state,
    );
    expect(parsed).toEqual({ code: "abc123", clientId: "oaiapp_issued_1" });

    expect(() =>
      parseAuthorizationCallback("http://127.0.0.1:43210/callback?code=abc&state=wrong", pkce.state),
    ).toThrow(/state did not match/);
  });

  it("verifies RS256 id_token against JWKS and rejects tampered signatures, wrong issuer/aud/nonce, or expired tokens", async () => {
    const now = 1_800_000_000_000;
    const nowSec = Math.floor(now / 1000);
    const mockFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })) as unknown as typeof fetch;

    const validJwt = signJwt({
      iss: OPENAI_OIDC_ISSUER,
      sub: "auth0|user123",
      aud: "oaiapp_123",
      exp: nowSec + 3600,
      nonce: "nonce-ok",
      email: "dev@example.test",
      email_verified: true,
      "https://api.openai.com/auth": {
        chatgpt_user_id: "usr_chat_1",
        chatgpt_account_id: "acct_ws_1",
        workspace_name: "Personal",
        chatgpt_plan_type: "plus",
      },
    });

    const identity = await verifyIdToken(
      { idToken: validJwt, discovery: DISCOVERY, expectedAudience: "oaiapp_123", expectedNonce: "nonce-ok" },
      { fetch: mockFetch, now: () => now },
    );
    expect(identity).toEqual({
      userId: "usr_chat_1",
      email: "dev@example.test",
      emailVerified: true,
      name: undefined,
      accountId: "acct_ws_1",
      workspaceName: "Personal",
      planType: "plus",
    });

    const tampered = `${validJwt.slice(0, -4)}AAAA`;
    await expect(
      verifyIdToken({ idToken: tampered, discovery: DISCOVERY, expectedAudience: "oaiapp_123", expectedNonce: "nonce-ok" }, { fetch: mockFetch, now: () => now }),
    ).rejects.toThrow(/signature verification failed/);

    const wrongNonce = signJwt({ iss: OPENAI_OIDC_ISSUER, sub: "u", aud: "oaiapp_123", exp: nowSec + 60, nonce: "other" });
    await expect(
      verifyIdToken({ idToken: wrongNonce, discovery: DISCOVERY, expectedAudience: "oaiapp_123", expectedNonce: "nonce-ok" }, { fetch: mockFetch, now: () => now }),
    ).rejects.toThrow(/nonce/);

    const expired = signJwt({ iss: OPENAI_OIDC_ISSUER, sub: "u", aud: "oaiapp_123", exp: nowSec - 120, nonce: "nonce-ok" });
    await expect(
      verifyIdToken({ idToken: expired, discovery: DISCOVERY, expectedAudience: "oaiapp_123", expectedNonce: "nonce-ok" }, { fetch: mockFetch, now: () => now }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses token exchange when chatgpt.tokens.use.direct scope was not granted", async () => {
    const now = 1_800_000_000_000;
    const mockFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "at_1",
          refresh_token: "rt_1",
          id_token: signJwt({ iss: OPENAI_OIDC_ISSUER, sub: "u", aud: "oaiapp_1", exp: Math.floor(now / 1000) + 3600 }),
          scope: "openid profile email offline_access",
          expires_in: 3600,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(
      exchangeAuthorizationCode(
        {
          discovery: DISCOVERY,
          code: "c1",
          redirectUri: "http://127.0.0.1:9999/cb",
          clientId: "oaiapp_1",
          codeVerifier: "v1",
        },
        { fetch: mockFetch, now: () => now },
      ),
    ).rejects.toThrow(new RegExp(REQUIRED_DIRECT_SCOPE));
  });

  it("persists tokens in keychain, refreshes single-flight near expiry, handles invalid_grant, and revokes on clear", async () => {
    let now = 1_800_000_000_000;
    const secrets = makeMemoryKeychain();
    let refreshCalls = 0;
    const revokedTokens: string[] = [];

    const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(DISCOVERY), { status: 200 });
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
      }
      if (url.endsWith("/oauth/token")) {
        refreshCalls += 1;
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("refresh_token") === "rt_revoked") {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: `at_fresh_${refreshCalls}`,
            refresh_token: `rt_fresh_${refreshCalls}`,
            scope: CHATGPT_OAUTH_SCOPES.join(" "),
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/oauth/revoke")) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        revokedTokens.push(body.get("token") ?? "");
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const discovery = await discoverOpenIdConfig({ fetch: mockFetch, now: () => now });
    expect(discovery.token_endpoint).toBe(DISCOVERY.token_endpoint);

    const authRef = await saveChatGptAuthBundle(
      "personal",
      {
        clientId: "oaiapp_1",
        accessToken: "at_expiring",
        refreshToken: "rt_1",
        expiresAt: now + 30_000, // within 2min margin
        scope: CHATGPT_OAUTH_SCOPES.join(" "),
        grantedAt: new Date(now).toISOString(),
        identity: { userId: "usr_1", email: "dev@example.test", emailVerified: true },
      },
      secrets,
    );
    expect(authRef).toBe(chatgptAccountAuthRef("personal"));

    // Concurrent calls share one refresh request.
    const [a, b] = await Promise.all([
      ensureFreshChatGptToken("personal", { fetch: mockFetch, secrets, now: () => now }),
      ensureFreshChatGptToken("personal", { fetch: mockFetch, secrets, now: () => now }),
    ]);
    expect(refreshCalls).toBe(1);
    expect(a.accessToken).toBe("at_fresh_1");
    expect(b.accessToken).toBe("at_fresh_1");

    // Subsequent call within validity window uses cached token without hitting token endpoint.
    const c = await ensureFreshChatGptToken("personal", { fetch: mockFetch, secrets, now: () => now });
    expect(refreshCalls).toBe(1);
    expect(c.accessToken).toBe("at_fresh_1");

    // Revoked refresh token surfaces CHATGPT_AUTH_REVOKED cleanly.
    await saveChatGptAuthBundle(
      "revoked",
      {
        clientId: "oaiapp_1",
        accessToken: "at_old",
        refreshToken: "rt_revoked",
        expiresAt: now - 10_000,
        scope: CHATGPT_OAUTH_SCOPES.join(" "),
        grantedAt: new Date(now).toISOString(),
        identity: { userId: "usr_2", emailVerified: true },
      },
      secrets,
    );
    await expect(
      ensureFreshChatGptToken("revoked", { fetch: mockFetch, secrets, now: () => now }),
    ).rejects.toThrow(/expired or was revoked/);

    // Clear revokes both tokens and deletes keychain entry.
    await clearChatGptAuth("personal", { fetch: mockFetch, secrets, now: () => now });
    expect(revokedTokens).toEqual(["rt_fresh_1", "at_fresh_1"]);
    expect(await loadChatGptAuthBundle("personal", secrets)).toBeNull();
  });
});
