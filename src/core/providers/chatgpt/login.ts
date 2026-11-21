/**
 * Cross-platform localhost OAuth 2.0 loopback callback server for Sign in with ChatGPT.
 *
 * Binds strictly to `127.0.0.1` on an ephemeral OS-assigned port (`0`) so it
 * works identically on macOS, Linux, and Windows without requiring elevated
 * privileges or a fixed port. Also supports manual callback URL completion for
 * headless/SSH sessions and unit tests.
 */
import crypto from "node:crypto";
import http from "node:http";

import { CliError } from "../../errors.js";
import {
  buildAuthorizationUrl,
  createPkceSession,
  discoverOpenIdConfig,
  exchangeAuthorizationCode,
  getOrCreateAgentHostId,
  loadChatGptAuthBundle,
  parseAuthorizationCallback,
  saveChatGptAuthBundle,
  type ChatGptAuthBundle,
  type OAuthDeps,
  type OpenIdConfiguration,
  type PkceSession,
} from "./oauth.js";

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface ChatGptLoginCompletion {
  readonly accountId: string;
  readonly authRef: string;
  readonly bundle: ChatGptAuthBundle;
}

export interface ChatGptLoginSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  /** Wait for the browser loopback callback (or resolve if completed manually). */
  waitForCallback(timeoutMs?: number): Promise<ChatGptLoginCompletion>;
  /** Complete using a pasted callback URL (for headless/remote flows or tests). */
  completeFromUrl(callbackUrl: string): Promise<ChatGptLoginCompletion>;
  /** Cancel and close the loopback listener. */
  cancel(): Promise<void>;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signed in to Moxen</title></head>
<body style="font-family:system-ui,sans-serif;max-width:460px;margin:64px auto;padding:0 20px;line-height:1.5">
<h2>Signed in with ChatGPT</h2>
<p>You can close this browser tab and return to Moxen.</p>
</body></html>`;

function errorHtml(message: string): string {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Moxen Sign-in Error</title></head>
<body style="font-family:system-ui,sans-serif;max-width:460px;margin:64px auto;padding:0 20px;line-height:1.5">
<h2>Sign in with ChatGPT failed</h2>
<p>${safe}</p>
<p>Return to Moxen and try again.</p>
</body></html>`;
}

export async function startChatGptLoginSession(
  accountId: string,
  deps: OAuthDeps & { readonly bindLoopback?: boolean | undefined } = {},
): Promise<ChatGptLoginSession> {
  const normalizedId = accountId.trim().toLowerCase();
  if (!normalizedId) {
    throw new CliError("INVALID_CONFIG", "Account id is required to sign in with ChatGPT.");
  }
  const discovery: OpenIdConfiguration = await discoverOpenIdConfig(deps);
  const existing = await loadChatGptAuthBundle(normalizedId, deps.secrets);
  const hostId = await getOrCreateAgentHostId(deps.secrets);
  const pkce: PkceSession = createPkceSession();
  const sessionId = crypto.randomUUID();

  let server: http.Server | null = null;
  let port = 0;
  let settled = false;
  let resolveDone!: (value: ChatGptLoginCompletion) => void;
  let rejectDone!: (error: unknown) => void;
  const donePromise = new Promise<ChatGptLoginCompletion>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Avoid unhandled rejection if caller cancels before awaiting.
  donePromise.catch(() => undefined);

  const closeServer = async (force = false): Promise<void> => {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
      if (force) {
        current.closeAllConnections?.();
      } else {
        current.closeIdleConnections?.();
      }
    });
  };

  const finishFromUrl = async (
    rawUrl: string,
    closeAfter = true,
  ): Promise<ChatGptLoginCompletion> => {
    if (settled) return await donePromise;
    settled = true;
    try {
      const parsed = parseAuthorizationCallback(rawUrl, pkce.state);
      const clientId = parsed.clientId ?? existing?.clientId;
      if (!clientId) {
        throw new CliError(
          "CHATGPT_AUTH_FAILED",
          "OpenAI did not return a client_id for dynamic_agent_client registration.",
        );
      }
      const bundle = await exchangeAuthorizationCode(
        {
          discovery,
          code: parsed.code,
          redirectUri,
          clientId,
          codeVerifier: pkce.codeVerifier,
          expectedNonce: pkce.nonce,
        },
        deps,
      );
      const authRef = await saveChatGptAuthBundle(normalizedId, bundle, deps.secrets);
      const result: ChatGptLoginCompletion = { accountId: normalizedId, authRef, bundle };
      resolveDone(result);
      if (closeAfter) await closeServer(true);
      return result;
    } catch (error) {
      rejectDone(error);
      if (closeAfter) await closeServer(true);
      throw error;
    }
  };

  if (deps.bindLoopback !== false) {
    server = http.createServer((req, res) => {
      const reqUrl = req.url ?? "/";
      if (!reqUrl.startsWith("/callback")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        res.end("Not found");
        return;
      }
      const sendAndClose = (status: number, html: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
        res.end(html, () => {
          void closeServer();
        });
      };
      const fullUrl = `http://127.0.0.1:${port}${reqUrl}`;
      void finishFromUrl(fullUrl, false).then(
        () => sendAndClose(200, SUCCESS_HTML),
        (error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          sendAndClose(400, errorHtml(msg));
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  } else {
    port = 1455;
  }

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizationUrl = buildAuthorizationUrl({
    discovery,
    pkce,
    redirectUri,
    clientId: existing?.clientId,
    hostId,
  });

  return {
    sessionId,
    accountId: normalizedId,
    authorizationUrl,
    redirectUri,
    async waitForCallback(timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS): Promise<ChatGptLoginCompletion> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          donePromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void closeServer(true);
              reject(new CliError("CHATGPT_AUTH_TIMEOUT", "Timed out waiting for Sign in with ChatGPT callback."));
            }, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    completeFromUrl: (callbackUrl: string) => finishFromUrl(callbackUrl, true),
    async cancel(): Promise<void> {
      if (!settled) {
        settled = true;
        rejectDone(new CliError("CHATGPT_AUTH_CANCELLED", "Sign in with ChatGPT was cancelled."));
      }
      await closeServer(true);
    },
  };
}
