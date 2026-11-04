/**
 * `web_fetch`: read one address as text, reaching as many sites as it can.
 * A plain request with browser-like headers first; if the site answers with a
 * block, a challenge page or an empty shell built by scripts, the same page
 * through a real browser (`browser.ts`) when one is installed. Everything that
 * comes back is bounded, cut to what a model should read, saved whole beside
 * the conversation when it is long, and handed over as untrusted data.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ProviderImage } from "../../spi.js";
import { untrustedContext } from "../mcp.js";
import type { ToolResult } from "../tools/types.js";
import { findBrowser, renderPage, type BrowserSettings } from "./browser.js";
import { extractText } from "./htmltext.js";
import { httpRequest, WebError, type HttpResponse } from "./http.js";
import type { NetworkPolicy } from "./netguard.js";

export const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": BROWSER_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
};

const MAX_DOWNLOAD_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
/** What one call shows; the rest of a long page is in a saved file. */
export const MAX_SHOWN_CHARS = 30_000;
const FETCH_TIMEOUT_MS = 25_000;
const BROWSER_TIMEOUT_MS = 45_000;

export interface FetchContext {
  readonly policy: NetworkPolicy;
  readonly browser: BrowserSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly artifactDir: string;
  readonly signal: AbortSignal;
  readonly acceptsImages: boolean;
  /** Swapped out in tests. */
  readonly resolve?: Parameters<typeof httpRequest>[1]["resolve"];
}

const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|x-yaml|yaml|toml|javascript|x-javascript|ld\+json|rss\+xml|atom\+xml)|[^;]*\+(?:json|xml))/i;
const CHALLENGE = /just a moment|attention required|checking your browser|enable javascript and cookies|captcha|are you a robot|unusual traffic|access denied|verify you are human/i;

function charsetOf(contentType: string, head: string): string {
  return (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8").toLowerCase();
}

function decode(body: Buffer, contentType: string): string {
  const label = charsetOf(contentType, body.subarray(0, 2048).toString("latin1"));
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** The text as the model gets it: the start of it, and where the rest is if there is more. */
export function boundPage(text: string, artifactDir: string): string {
  if (text.length <= MAX_SHOWN_CHARS) return text;
  let saved = "";
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    const file = path.join(artifactDir, `web-${Date.now()}-${randomBytes(3).toString("hex")}.txt`);
    fs.writeFileSync(file, text, "utf8");
    saved = ` The whole text is saved at ${file}; read it in pieces with offset and limit.`;
  } catch {
    // Without the file the start is all there is.
  }
  return `${text.slice(0, MAX_SHOWN_CHARS)}\n\n[… ${text.length - MAX_SHOWN_CHARS} more characters.${saved}]`;
}

function wrap(source: URL, finalUrl: string, title: string, note: string, text: string, artifactDir: string): ToolResult {
  const head = [`URL: ${finalUrl}`, title !== "" ? `Title: ${title}` : "", note].filter((line) => line !== "").join("\n");
  return { content: untrustedContext(`${head}\n\n${boundPage(text === "" ? "(the page has no readable text)" : text, artifactDir)}`, `web:${source.hostname}`) };
}

const failure = (content: string): ToolResult => ({ content, isError: true });

function normalizeUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

async function throughBrowser(url: URL, executable: string, context: FetchContext): Promise<ToolResult> {
  try {
    const page = await renderPage(url.toString(), { executable, policy: context.policy, timeoutMs: BROWSER_TIMEOUT_MS, signal: context.signal, ...(context.resolve ? { resolve: context.resolve } : {}) });
    const extracted = extractText(page.html, page.url);
    return wrap(url, page.url, extracted.title, "(read through a browser)", extracted.text, context.artifactDir);
  } catch (error) {
    return failure(error instanceof WebError ? error.message : `The browser could not load the page: ${(error as Error).message.slice(0, 120)}`);
  }
}

function textOf(response: HttpResponse): string {
  return decode(response.body, response.headers["content-type"] ?? "");
}

export async function fetchPage(rawUrl: string, options: { readonly render?: boolean | undefined }, context: FetchContext): Promise<ToolResult> {
  const url = normalizeUrl(rawUrl);
  if (!url) return failure("That is not a valid address. Give a full URL such as https://example.com/page.");
  const executable = findBrowser(context.browser, context.env);
  if (options.render === true) {
    return executable ? await throughBrowser(url, executable, context) : failure("No browser is available to render the page. Install Chrome or Chromium, or set Browser program (web.browserPath) in the settings; or fetch without render. If 'Browser for web pages' is Never, no browser is started.");
  }

  let response: HttpResponse;
  try {
    response = await httpRequest(url.toString(), { headers: PAGE_HEADERS, maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: FETCH_TIMEOUT_MS, signal: context.signal, policy: context.policy, ...(context.resolve ? { resolve: context.resolve } : {}) });
  } catch (error) {
    if (error instanceof WebError) return failure(error.message);
    return failure(`The request failed: ${(error as Error).message.slice(0, 120)}`);
  }

  const type = (response.headers["content-type"] ?? "").toLowerCase();
  const blocked = response.status === 401 || response.status === 403 || response.status === 429 || response.status === 503 || response.headers["cf-mitigated"] === "challenge";
  const challenged = response.status >= 400 || response.status === 202 ? CHALLENGE.test(textOf(response).slice(0, 20_000)) : false;
  if (response.status >= 400 || challenged || (response.status === 202 && /html/.test(type))) {
    if ((blocked || challenged) && executable) return await throughBrowser(url, executable, context);
    const hint = blocked || challenged ? " It may be turning away automated requests." : "";
    const nobrowser = (blocked || challenged) && !executable && context.browser.mode !== "off" ? " No browser was found to try the page through; install Chrome or Chromium, or set Browser program (web.browserPath) in the settings." : "";
    return failure(`${url.hostname} answered ${response.status}.${hint}${nobrowser}`);
  }

  const finalUrl = response.url;
  const note = [response.redirects > 0 ? `(redirected ${response.redirects} time${response.redirects === 1 ? "" : "s"})` : "", response.truncated ? `(the download was cut at ${MAX_DOWNLOAD_BYTES / 1_000_000} MB)` : ""].filter(Boolean).join(" ");

  if (/^image\/(?:png|jpeg|gif|webp)\b/.test(type)) {
    const size = `${Math.max(1, Math.round(response.body.length / 1024))} KB`;
    if (!context.acceptsImages) return { content: untrustedContext(`URL: ${finalUrl}\n\nThis is a ${type.split(";")[0]} image (${size}). The current model cannot be shown pictures.`, `web:${url.hostname}`) };
    if (response.truncated || response.body.length > MAX_IMAGE_BYTES) return failure(`The image at ${url.hostname} is over the ${MAX_IMAGE_BYTES / 1_000_000} MB limit for pictures.`);
    const image: ProviderImage = { name: path.basename(new URL(finalUrl).pathname) || "image", mimeType: type.split(";")[0]!.trim(), data: response.body.toString("base64") };
    return { content: untrustedContext(`URL: ${finalUrl}\n\nA ${image.mimeType} image (${size}); it is attached below.`, `web:${url.hostname}`), images: [image] };
  }
  if (type !== "" && !TEXTUAL.test(type)) {
    return failure(`${url.hostname} sent ${type.split(";")[0]} (${Math.max(1, Math.round(response.body.length / 1024))} KB), which is not text the web tool can read.`);
  }
  const body = textOf(response);
  if (/html/.test(type) || (type === "" && /^\s*<(?:!doctype|html)/i.test(body))) {
    const page = extractText(body, finalUrl);
    let browserFailed = "";
    if (page.looksScripted && executable) {
      const rendered = await throughBrowser(url, executable, context);
      if (!rendered.isError) return rendered;
      browserFailed = `\n(This page builds its content with scripts, and the browser could not read it: ${rendered.content})`;
    }
    const hint = page.looksScripted ? (executable ? browserFailed : "\n(This page builds its content with scripts and little is readable without a browser; install Chrome or Chromium to read it.)") : "";
    return wrap(url, finalUrl, page.title, `${note}${hint}`.trim(), page.text, context.artifactDir);
  }
  return wrap(url, finalUrl, "", note, body, context.artifactDir);
}
