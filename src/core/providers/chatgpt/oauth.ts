/**
 * Official OpenAI "Sign in with ChatGPT" OAuth 2.0 + OIDC PKCE (`S256`) client.
 *
 * Security invariants:
 * - Tokens and issued `client_id` live exclusively in the OS keychain
 *   (`src/core/secrets.ts`), never in `config.json` or logs.
 * - `id_token` is verified cryptographically (RS256 against `jwks_uri`)
 *   including `iss`, `aud`, `exp`, and `nonce`.
 * - Direct ChatGPT plan usage is only enabled when the granted scopes include
 *   `chatgpt.tokens.use.direct`.
 */
import crypto from "node:crypto";

import { CliError } from "../../errors.js";
import { readSecret, secretRef, writeSecret } from "../../secrets.js";

export const OPENAI_OIDC_ISSUER = "https://auth.openai.com";
export const OPENAI_OIDC_DISCOVERY_URL = `${OPENAI_OIDC_ISSUER}/.well-known/openid-configuration`;
export const OPENAI_API_RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_AGENT_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME_HINT = "Moxen";
export const REQUIRED_DIRECT_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  REQUIRED_DIRECT_SCOPE,
] as const;

const DISCOVERY_TTL_MS = 30 * 60_000;
const JWKS_TTL_MS = 30 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 2 * 60_000;
const JWT_CLOCK_SKEW_SECONDS = 60;

export interface OpenIdConfiguration {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint?: string | undefined;
  readonly jwks_uri: string;
  readonly userinfo_endpoint?: string | undefined;
}

export interface ChatGptVerifiedIdentity {
  readonly userId: string;
  readonly email?: string | undefined;
  readonly emailVerified: boolean;
  readonly name?: string | undefined;
  readonly accountId?: string | undefined;
  readonly workspaceName?: string | undefined;
  readonly planType?: string | undefined;
}

export interface ChatGptAuthBundle {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scope: string;
  readonly grantedAt: string;
  readonly identity: ChatGptVerifiedIdentity;
}

export interface PkceSession {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly nonce: string;
}

export interface KeychainAdapter {
  readonly read: (name: string) => Promise<string | null>;
  readonly write: (name: string, value: string) => Promise<void>;
}

const DEFAULT_KEYCHAIN: KeychainAdapter = {
  read: readSecret,
  write: writeSecret,
};

export interface OAuthDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly discoveryUrl?: string | undefined;
  readonly secrets?: KeychainAdapter | undefined;
  readonly now?: (() => number) | undefined;
}

const discoveryCache = new Map<string, { readonly value: OpenIdConfiguration; readonly fetchedAt: number }>();
const jwksCache = new Map<string, { readonly keys: readonly Record<string, unknown>[]; readonly fetchedAt: number }>();
const inFlightRefreshes = new Map<string, Promise<ChatGptAuthBundle>>();

export function resetChatGptOAuthCachesForTests(): void {
  discoveryCache.clear();
  jwksCache.clear();
  inFlightRefreshes.clear();
}

export function chatgptAccountSecretName(accountId: string): string {
  return `chatgpt.account.${accountId.trim().toLowerCase()}`;
}

export function chatgptAccountAuthRef(accountId: string): string {
  return secretRef(chatgptAccountSecretName(accountId));
}

const HOST_ID_SECRET_NAME = "chatgpt.host_id";

/** Persistent per-host identifier for `dynamic_agent_client` registration. */
export async function getOrCreateAgentHostId(secrets: KeychainAdapter = DEFAULT_KEYCHAIN): Promise<string> {
  const existing = await secrets.read(HOST_ID_SECRET_NAME);
  if (existing && existing.trim().length > 0) return existing.trim();
  const created = crypto.randomUUID();
  await secrets.write(HOST_ID_SECRET_NAME, created);
  return created;
}

function base64UrlEncode(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function createPkceSession(): PkceSession {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64UrlEncode(crypto.randomBytes(24));
  const nonce = base64UrlEncode(crypto.randomBytes(24));
  return { codeVerifier, codeChallenge, state, nonce };
}

export async function discoverOpenIdConfig(deps: OAuthDeps = {}): Promise<OpenIdConfiguration> {
  const url = deps.discoveryUrl ?? OPENAI_OIDC_DISCOVERY_URL;
  const now = (deps.now ?? Date.now)();
  const cached = discoveryCache.get(url);
  if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.value;

  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new CliError(
      "CHATGPT_DISCOVERY_FAILED",
      `Could not reach OpenAI OpenID discovery (${url}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new CliError(
      "CHATGPT_DISCOVERY_FAILED",
      `OpenAI OpenID discovery failed (HTTP ${response.status}).`,
    );
  }
  const raw = asRecord(await response.json().catch(() => null));
  const issuer = nonEmptyString(raw?.issuer);
  const authorization_endpoint = nonEmptyString(raw?.authorization_endpoint);
  const token_endpoint = nonEmptyString(raw?.token_endpoint);
  const jwks_uri = nonEmptyString(raw?.jwks_uri);
  if (!issuer || !authorization_endpoint || !token_endpoint || !jwks_uri) {
    throw new CliError("CHATGPT_DISCOVERY_FAILED", "OpenAI OpenID discovery document is missing required endpoints.");
  }
  const config: OpenIdConfiguration = {
    issuer,
    authorization_endpoint,
    token_endpoint,
    jwks_uri,
    revocation_endpoint: nonEmptyString(raw?.revocation_endpoint),
    userinfo_endpoint: nonEmptyString(raw?.userinfo_endpoint),
  };
  discoveryCache.set(url, { value: config, fetchedAt: now });
  return config;
}

export interface BuildAuthUrlInput {
  readonly discovery: OpenIdConfiguration;
  readonly pkce: PkceSession;
  readonly redirectUri: string;
  readonly clientId?: string | undefined;
  readonly hostId: string;
  readonly agentNameHint?: string | undefined;
}

export function buildAuthorizationUrl(input: BuildAuthUrlInput): string {
  const url = new URL(input.discovery.authorization_endpoint);
  const clientId = input.clientId?.trim() || DYNAMIC_AGENT_CLIENT_ID;
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPES.join(" "));
  url.searchParams.set("resource", OPENAI_API_RESOURCE);
  url.searchParams.set("state", input.pkce.state);
  url.searchParams.set("nonce", input.pkce.nonce);
  url.searchParams.set("code_challenge", input.pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (clientId === DYNAMIC_AGENT_CLIENT_ID) {
    url.searchParams.set("ext_agent_host_id", input.hostId);
    url.searchParams.set("agent_name_hint", input.agentNameHint ?? AGENT_NAME_HINT);
  }
  return url.toString();
}

export interface ParsedCallback {
  readonly code: string;
  readonly clientId?: string | undefined;
}

export function parseAuthorizationCallback(callbackUrl: URL | string, expectedState: string): ParsedCallback {
  const url = typeof callbackUrl === "string" ? new URL(callbackUrl) : callbackUrl;
  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description");
    throw new CliError(
      "CHATGPT_AUTH_DENIED",
      desc ? `Sign in with ChatGPT failed (${error}): ${desc}` : `Sign in with ChatGPT failed (${error}).`,
    );
  }
  const returnedState = url.searchParams.get("state") ?? "";
  const left = Buffer.from(returnedState, "utf8");
  const right = Buffer.from(expectedState, "utf8");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new CliError("CHATGPT_AUTH_STATE_MISMATCH", "OAuth callback state did not match the pending login request.");
  }
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code) {
    throw new CliError("CHATGPT_AUTH_FAILED", "OAuth callback did not include an authorization code.");
  }
  const issuedClientId = nonEmptyString(url.searchParams.get("client_id"));
  return { code, ...(issuedClientId ? { clientId: issuedClientId } : {}) };
}

async function fetchJwks(jwksUri: string, forceRefresh: boolean, deps: OAuthDeps): Promise<readonly Record<string, unknown>[]> {
  const now = (deps.now ?? Date.now)();
  const cached = jwksCache.get(jwksUri);
  if (!forceRefresh && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(jwksUri, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new CliError("CHATGPT_JWKS_FAILED", `Could not fetch OpenAI signing keys (HTTP ${response.status}).`);
  }
  const json = asRecord(await response.json().catch(() => null));
  const rawKeys = Array.isArray(json?.keys) ? json.keys : [];
  const keys = rawKeys.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
  if (keys.length === 0) {
    throw new CliError("CHATGPT_JWKS_FAILED", "OpenAI JWKS response contained no keys.");
  }
  jwksCache.set(jwksUri, { keys, fetchedAt: now });
  return keys;
}

export interface VerifyIdTokenInput {
  readonly idToken: string;
  readonly discovery: OpenIdConfiguration;
  readonly expectedAudience: string;
  readonly expectedNonce?: string | undefined;
}

export async function verifyIdToken(
  input: VerifyIdTokenInput,
  deps: OAuthDeps = {},
): Promise<ChatGptVerifiedIdentity> {
  const parts = input.idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI returned a malformed ID token.");
  }
  const [headerB64, payloadB64, sigB64] = parts;
  let header: Record<string, unknown> | null;
  let payload: Record<string, unknown> | null;
  try {
    header = asRecord(JSON.parse(base64UrlDecode(headerB64).toString("utf8")));
    payload = asRecord(JSON.parse(base64UrlDecode(payloadB64).toString("utf8")));
  } catch {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "Could not decode OpenAI ID token.");
  }
  if (!header || !payload) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI ID token header or payload is not an object.");
  }
  if (header.alg !== "RS256") {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", `Unsupported ID token algorithm "${String(header.alg ?? "")}"; expected RS256.`);
  }

  const kid = nonEmptyString(header.kid);
  const selectKey = (keys: readonly Record<string, unknown>[]) =>
    keys.find(
      (k) =>
        k.kty === "RSA" &&
        (k.use === undefined || k.use === "sig") &&
        (kid === undefined || k.kid === kid),
    );

  let keys = await fetchJwks(input.discovery.jwks_uri, false, deps);
  let jwk = selectKey(keys);
  if (!jwk) {
    keys = await fetchJwks(input.discovery.jwks_uri, true, deps);
    jwk = selectKey(keys);
  }
  if (!jwk) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "No matching RSA signing key found in OpenAI JWKS.");
  }

  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
    const signature = base64UrlDecode(sigB64);
    verified = crypto.verify("RSA-SHA256", signingInput, publicKey, signature);
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI ID token signature verification failed.");
  }

  const iss = nonEmptyString(payload.iss);
  if (iss !== input.discovery.issuer) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", `Unexpected ID token issuer "${iss ?? ""}".`);
  }

  const aud = payload.aud;
  const audMatches =
    typeof aud === "string"
      ? aud === input.expectedAudience
      : Array.isArray(aud) && aud.includes(input.expectedAudience);
  if (!audMatches) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI ID token audience did not match this client.");
  }

  const exp = typeof payload.exp === "number" ? payload.exp : NaN;
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  if (!Number.isFinite(exp) || exp + JWT_CLOCK_SKEW_SECONDS < nowSec) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI ID token is expired.");
  }

  if (input.expectedNonce !== undefined) {
    const tokenNonce = nonEmptyString(payload.nonce);
    if (tokenNonce !== input.expectedNonce) {
      throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI ID token nonce did not match.");
    }
  }

  const sub = nonEmptyString(payload.sub);
  if (!sub) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "OpenAI ID token is missing subject (sub).");
  }

  const authClaims = asRecord(payload["https://api.openai.com/auth"]);
  const userId = nonEmptyString(authClaims?.chatgpt_user_id) ?? sub;
  const accountId =
    nonEmptyString(authClaims?.chatgpt_account_id) ??
    nonEmptyString(payload.account_id) ??
    nonEmptyString(authClaims?.organization_id);
  const workspaceName =
    nonEmptyString(authClaims?.workspace_name) ??
    nonEmptyString(payload.workspace_name) ??
    nonEmptyString(authClaims?.organization_title);
  const planType =
    nonEmptyString(authClaims?.chatgpt_plan_type) ??
    nonEmptyString(payload.plan_type);

  return {
    userId,
    email: nonEmptyString(payload.email),
    emailVerified: payload.email_verified === true,
    name: nonEmptyString(payload.name),
    accountId,
    workspaceName,
    planType,
  };
}

export function hasDirectUsageScope(scope: string): boolean {
  return scope
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .includes(REQUIRED_DIRECT_SCOPE);
}

export interface ExchangeCodeInput {
  readonly discovery: OpenIdConfiguration;
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly codeVerifier: string;
  readonly expectedNonce?: string | undefined;
}

export async function exchangeAuthorizationCode(
  input: ExchangeCodeInput,
  deps: OAuthDeps = {},
): Promise<ChatGptAuthBundle> {
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: OPENAI_API_RESOURCE,
  });
  const response = await doFetch(input.discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
  });
  const json = asRecord(await response.json().catch(() => null));
  if (!response.ok) {
    const err = nonEmptyString(json?.error_description) ?? nonEmptyString(json?.error) ?? `HTTP ${response.status}`;
    throw new CliError("CHATGPT_TOKEN_EXCHANGE_FAILED", `Could not exchange authorization code: ${err}`);
  }
  const accessToken = nonEmptyString(json?.access_token);
  const idToken = nonEmptyString(json?.id_token);
  const refreshToken = nonEmptyString(json?.refresh_token) ?? null;
  const scope = nonEmptyString(json?.scope) ?? "";
  const expiresIn = typeof json?.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
  const issuedClientId = nonEmptyString(json?.client_id) ?? input.clientId;

  if (!accessToken) {
    throw new CliError("CHATGPT_TOKEN_EXCHANGE_FAILED", "Token endpoint returned no access_token.");
  }
  if (!hasDirectUsageScope(scope)) {
    throw new CliError(
      "CHATGPT_SCOPE_MISSING",
      `Sign in with ChatGPT did not grant the required "${REQUIRED_DIRECT_SCOPE}" scope for direct plan usage. Check your ChatGPT app permissions and sign in again.`,
    );
  }
  if (!idToken) {
    throw new CliError("CHATGPT_ID_TOKEN_INVALID", "Token endpoint returned no id_token.");
  }
  const identity = await verifyIdToken(
    {
      idToken,
      discovery: input.discovery,
      expectedAudience: issuedClientId,
      expectedNonce: input.expectedNonce,
    },
    deps,
  );
  return {
    clientId: issuedClientId,
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    scope,
    grantedAt: new Date(now).toISOString(),
    identity,
  };
}

export async function refreshAccessToken(
  discovery: OpenIdConfiguration,
  current: ChatGptAuthBundle,
  deps: OAuthDeps = {},
): Promise<ChatGptAuthBundle> {
  if (!current.refreshToken) {
    throw new CliError(
      "CHATGPT_AUTH_REVOKED",
      "Your Sign in with ChatGPT session expired and has no refresh token. Sign in again.",
    );
  }
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: current.clientId,
    resource: OPENAI_API_RESOURCE,
  });
  const response = await doFetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
  });
  const json = asRecord(await response.json().catch(() => null));
  if (!response.ok) {
    const code = nonEmptyString(json?.error);
    if (response.status === 400 || response.status === 401 || code === "invalid_grant") {
      throw new CliError(
        "CHATGPT_AUTH_REVOKED",
        "Your Sign in with ChatGPT session expired or was revoked. Sign in again.",
      );
    }
    const err = nonEmptyString(json?.error_description) ?? code ?? `HTTP ${response.status}`;
    throw new CliError("CHATGPT_TOKEN_REFRESH_FAILED", `Could not refresh Sign in with ChatGPT token: ${err}`);
  }
  const accessToken = nonEmptyString(json?.access_token);
  if (!accessToken) {
    throw new CliError("CHATGPT_TOKEN_REFRESH_FAILED", "Token refresh returned no access_token.");
  }
  const refreshToken = nonEmptyString(json?.refresh_token) ?? current.refreshToken;
  const scope = nonEmptyString(json?.scope) ?? current.scope;
  if (!hasDirectUsageScope(scope)) {
    throw new CliError(
      "CHATGPT_SCOPE_MISSING",
      `Refreshed ChatGPT token no longer includes "${REQUIRED_DIRECT_SCOPE}". Sign in again.`,
    );
  }
  const expiresIn = typeof json?.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
  let identity = current.identity;
  const idToken = nonEmptyString(json?.id_token);
  if (idToken) {
    identity = await verifyIdToken(
      { idToken, discovery, expectedAudience: current.clientId },
      deps,
    );
  }
  return {
    clientId: current.clientId,
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    scope,
    grantedAt: new Date(now).toISOString(),
    identity,
  };
}

export async function revokeChatGptTokens(
  discovery: OpenIdConfiguration,
  bundle: ChatGptAuthBundle,
  deps: OAuthDeps = {},
): Promise<void> {
  if (!discovery.revocation_endpoint) return;
  const doFetch = deps.fetch ?? fetch;
  const targets = [bundle.refreshToken, bundle.accessToken].filter((token): token is string => Boolean(token));
  for (const token of targets) {
    const form = new URLSearchParams({ token, client_id: bundle.clientId });
    await doFetch(discovery.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }).catch(() => undefined);
  }
}

export async function saveChatGptAuthBundle(
  accountId: string,
  bundle: ChatGptAuthBundle,
  secrets: KeychainAdapter = DEFAULT_KEYCHAIN,
): Promise<string> {
  const keyName = chatgptAccountSecretName(accountId);
  await secrets.write(keyName, JSON.stringify(bundle));
  return secretRef(keyName);
}

export async function loadChatGptAuthBundle(
  accountId: string,
  secrets: KeychainAdapter = DEFAULT_KEYCHAIN,
): Promise<ChatGptAuthBundle | null> {
  const raw = await secrets.read(chatgptAccountSecretName(accountId));
  if (!raw) return null;
  try {
    const parsed = asRecord(JSON.parse(raw));
    const clientId = nonEmptyString(parsed?.clientId);
    const accessToken = nonEmptyString(parsed?.accessToken);
    const scope = nonEmptyString(parsed?.scope);
    const expiresAt = typeof parsed?.expiresAt === "number" ? parsed.expiresAt : NaN;
    const identityRec = asRecord(parsed?.identity);
    const userId = nonEmptyString(identityRec?.userId);
    if (!clientId || !accessToken || !scope || !Number.isFinite(expiresAt) || !userId) return null;
    return {
      clientId,
      accessToken,
      refreshToken: nonEmptyString(parsed?.refreshToken) ?? null,
      expiresAt,
      scope,
      grantedAt: nonEmptyString(parsed?.grantedAt) ?? new Date(0).toISOString(),
      identity: {
        userId,
        email: nonEmptyString(identityRec?.email),
        emailVerified: identityRec?.emailVerified === true,
        name: nonEmptyString(identityRec?.name),
        accountId: nonEmptyString(identityRec?.accountId),
        workspaceName: nonEmptyString(identityRec?.workspaceName),
        planType: nonEmptyString(identityRec?.planType),
      },
    };
  } catch {
    return null;
  }
}

export async function clearChatGptAuth(
  accountId: string,
  deps: OAuthDeps = {},
): Promise<void> {
  const secrets = deps.secrets ?? DEFAULT_KEYCHAIN;
  const existing = await loadChatGptAuthBundle(accountId, secrets);
  if (existing) {
    const discovery = await discoverOpenIdConfig(deps).catch(() => null);
    if (discovery) await revokeChatGptTokens(discovery, existing, deps);
  }
  await secrets.write(chatgptAccountSecretName(accountId), "");
}

/**
 * Return a valid bearer access token for `accountId`, refreshing and rotating
 * the OS keychain entry transparently (single-flight per account) when near expiry.
 */
export async function ensureFreshChatGptToken(
  accountId: string,
  deps: OAuthDeps = {},
): Promise<{ readonly accessToken: string; readonly bundle: ChatGptAuthBundle }> {
  const normalized = accountId.trim().toLowerCase();
  const secrets = deps.secrets ?? DEFAULT_KEYCHAIN;
  const now = (deps.now ?? Date.now)();
  const current = await loadChatGptAuthBundle(normalized, secrets);
  if (!current) {
    throw new CliError(
      "CHATGPT_NOT_SIGNED_IN",
      `ChatGPT account "${normalized}" is not signed in. Sign in with ChatGPT first.`,
    );
  }
  if (!hasDirectUsageScope(current.scope)) {
    throw new CliError(
      "CHATGPT_SCOPE_MISSING",
      `ChatGPT account "${normalized}" does not have "${REQUIRED_DIRECT_SCOPE}". Sign in again.`,
    );
  }
  if (current.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return { accessToken: current.accessToken, bundle: current };
  }

  let pending = inFlightRefreshes.get(normalized);
  if (!pending) {
    pending = (async () => {
      const discovery = await discoverOpenIdConfig(deps);
      const refreshed = await refreshAccessToken(discovery, current, deps);
      await saveChatGptAuthBundle(normalized, refreshed, secrets);
      return refreshed;
    })().finally(() => {
      inFlightRefreshes.delete(normalized);
    });
    inFlightRefreshes.set(normalized, pending);
  }
  const bundle = await pending;
  return { accessToken: bundle.accessToken, bundle };
}
