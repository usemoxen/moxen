/**
 * A small HTTP client for the web tool. Written on `node:http` rather than
 * `fetch` because the tool has to decide, for every connection, where it may
 * go: the name is resolved here, judged (`netguard.ts`), and the socket is
 * opened to the address that was judged. Redirects are followed by hand, each
 * hop checked the same way; the body is capped as it is decompressed; and
 * nothing it says in an error includes more of a URL than the host.
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";

import { BlockedAddressError, resolveAllowed, type NetworkPolicy } from "./netguard.js";

export class WebError extends Error {
  constructor(message: string, readonly kind: "blocked" | "network" | "timeout" | "protocol" | "aborted") {
    super(message);
    this.name = "WebError";
  }
}

export interface HttpRequestOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Most decompressed bytes read; the rest is dropped and `truncated` says so. */
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly policy: NetworkPolicy;
  readonly maxRedirects?: number;
  /** Swapped out in tests. */
  readonly resolve?: Parameters<typeof resolveAllowed>[2];
}

export interface HttpResponse {
  /** Where the last hop ended up. */
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly redirects: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function decoderFor(encoding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch (encoding.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  return out;
}

/** One hop: connect to the judged address, send, and hand back the response with its body read (or, for a redirect, not read). */
async function hop(url: URL, options: HttpRequestOptions, method: "GET" | "POST", body: string | undefined, cookies: string): Promise<HttpResponse> {
  const { address, family } = await resolveAllowed(url.hostname, options.policy, options.resolve).catch((error: unknown) => {
    if (error instanceof BlockedAddressError) throw new WebError(error.message, "blocked");
    throw new WebError(`Could not find ${url.hostname}.`, "network");
  });
  const secure = url.protocol === "https:";
  const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br", ...options.headers, host: url.host };
  if (cookies !== "") headers.cookie = cookies;
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

  return await new Promise<HttpResponse>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new WebError(`${url.hostname} did not answer within ${Math.round(options.timeoutMs / 1000)}s.`, "timeout"));
    }, options.timeoutMs);
    const onAbort = (): void => {
      controller.abort();
      reject(new WebError("The request was cancelled.", "aborted"));
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (action: () => void): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const lib = secure ? https : http;
    const request = lib.request(
      {
        host: address,
        family,
        port: url.port !== "" ? Number(url.port) : secure ? 443 : 80,
        method,
        path: `${url.pathname}${url.search}`,
        headers,
        // A connection of this request's own, never one left in the process-wide
        // keep-alive pool by an earlier fetch: an idle socket in that pool can be
        // dropped by either side's idle timer while it waits (the server's
        // keep-alive timeout, the client's matching one), and a fetch handed that
        // socket dies as a reset instead of reading the page. A page fetch is one
        // request, or a handful of redirect hops, so reuse buys nothing here.
        agent: false,
        // The certificate is checked against the name the page was asked for, not the address it was reached at.
        ...(secure ? { servername: url.hostname } : {}),
        signal: controller.signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const responseHeaders = flatten(response.headers);
        if (REDIRECTS.has(status) && responseHeaders.location) {
          response.destroy();
          return finish(() => resolve({ url: url.toString(), status, headers: responseHeaders, body: Buffer.alloc(0), truncated: false, redirects: 0 }));
        }
        const decoder = decoderFor(responseHeaders["content-encoding"] ?? "");
        const source: Readable = decoder ? response.pipe(decoder) : response;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const settle = (): void => finish(() => resolve({ url: url.toString(), status, headers: responseHeaders, body: Buffer.concat(chunks), truncated, redirects: 0 }));
        source.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = options.maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, Math.max(0, room)));
            size = options.maxBytes;
            truncated = true;
            response.destroy();
            source.destroy();
            return settle();
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        source.on("end", () => {
          if (!truncated) settle();
        });
        source.on("error", (error) => {
          if (truncated) return;
          finish(() => reject(new WebError(`The response from ${url.hostname} could not be read (${(error as NodeJS.ErrnoException).code ?? "bad data"}).`, "network")));
        });
      },
    );
    request.on("error", (error) => {
      if (controller.signal.aborted) return;
      finish(() => reject(new WebError(`Could not reach ${url.hostname} (${(error as NodeJS.ErrnoException).code ?? error.message.slice(0, 80)}).`, "network")));
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** Only the name=value part of each Set-Cookie, kept for the hops of one request chain. */
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export async function httpRequest(rawUrl: string, options: HttpRequestOptions): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebError("That is not a valid URL.", "protocol");
  }
  const jar = new Map<string, string>();
  let method = options.method ?? "GET";
  let body = options.body;
  const limit = options.maxRedirects ?? 6;
  for (let redirects = 0; ; redirects += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebError(`Only http and https addresses can be fetched, not ${url.protocol.replace(":", "")}.`, "protocol");
    if (url.username !== "" || url.password !== "") throw new WebError("An address with a username or password in it is not fetched.", "protocol");
    const response = await hop(url, options, method, body, cookieHeader(jar));
    if (!REDIRECTS.has(response.status) || !response.headers.location) return { ...response, redirects };
    if (redirects >= limit) throw new WebError(`${url.hostname} redirected more than ${limit} times.`, "protocol");
    let next: URL;
    try {
      next = new URL(response.headers.location, url);
    } catch {
      throw new WebError(`${url.hostname} redirected to an address that is not valid.`, "protocol");
    }
    if (url.protocol === "https:" && next.protocol === "http:") throw new WebError(`${url.hostname} redirected from https to plain http, which is not followed.`, "protocol");
    for (const setCookie of (response.headers["set-cookie"] ?? "").split(/,(?=\s*[^;,=\s]+=)/)) {
      const pair = /^\s*([^=;\s]+)=([^;]*)/.exec(setCookie);
      if (pair && next.hostname === url.hostname) jar.set(pair[1]!, pair[2]!);
    }
    // A 301/302/303 after a POST is read with GET; 307/308 repeat the request.
    if (response.status !== 307 && response.status !== 308) {
      method = "GET";
      body = undefined;
    }
    url = next;
  }
}
