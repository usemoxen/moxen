/**
 * Fetching a page through a real browser, for sites that answer a plain
 * request with a challenge or an empty shell built by scripts. It drives the
 * user's own Chrome or Chromium headless over the DevTools protocol (a
 * hand-written client, no dependency), in a fresh throwaway profile: none of
 * the user's cookies or logins are visible to a page, and nothing is kept.
 *
 * Every request the page makes is held until it has been judged like any other
 * address (`netguard.ts`); pictures, media and fonts are not loaded at all.
 * One browser per call, always stopped afterwards by the pid that was spawned
 * (SIGTERM, then SIGKILL), never found by name.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandEnv, killGroup } from "../tools/shell.js";
import { BlockedAddressError, resolveAllowed, type NetworkPolicy } from "./netguard.js";
import { WebError } from "./http.js";

export interface BrowserSettings {
  readonly mode: "auto" | "off";
  /** The executable to use; found from the usual places when unset. */
  readonly path?: string | undefined;
}

const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/** The browser to drive: the configured one, or the first usual one that exists. Null when there is none (or the setting is off). */
export function findBrowser(settings: BrowserSettings, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (settings.mode === "off") return null;
  if (settings.path) return fs.existsSync(settings.path) ? settings.path : null;
  for (const candidate of CANDIDATES[platform] ?? CANDIDATES.linux!) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      const found = onPath(candidate, env);
      if (found) return found;
    }
  }
  return null;
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

/** The few DevTools calls the page fetch needs. */
class Cdp {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Map<string, Array<(params: Record<string, unknown>, sessionId: string | undefined) => void>>();
  #next = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (message) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof data.id === "number") {
        const pending = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        if (!pending) return;
        const error = data.error as { message?: string } | undefined;
        if (error) pending.reject(new Error(error.message ?? "DevTools error"));
        else pending.resolve((data.result as Record<string, unknown>) ?? {});
      } else if (typeof data.method === "string") {
        for (const handler of this.#handlers.get(data.method) ?? []) handler((data.params as Record<string, unknown>) ?? {}, data.sessionId as string | undefined);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("The browser closed."));
      this.#pending.clear();
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The browser did not accept a connection.")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("The browser did not accept a connection."));
      });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = (this.#next += 1);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: (params: Record<string, unknown>, sessionId: string | undefined) => void): void {
    this.#handlers.set(method, [...(this.#handlers.get(method) ?? []), handler]);
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Already gone.
    }
  }
}

const BLOCKED_RESOURCES = new Set(["Image", "Media", "Font"]);

export interface RenderedPage {
  readonly url: string;
  readonly html: string;
}

export interface RenderOptions {
  readonly executable: string;
  readonly policy: NetworkPolicy;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly resolve?: Parameters<typeof resolveAllowed>[2];
  /** How long the page may keep changing before what it shows is taken. */
  readonly settleMs?: number;
}

export async function renderPage(url: string, options: RenderOptions): Promise<RenderedPage> {
  if (options.signal?.aborted) throw new WebError("The request was cancelled.", "aborted");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-web-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--hide-scrollbars",
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(options.executable, args, { stdio: ["ignore", "ignore", "pipe"], detached: true, env: commandEnv() });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
  });
  const stop = (): void => {
    if (exited) return;
    killGroup(child.pid, "SIGTERM");
    // Only this pid's group, and only while it has not been seen to exit.
    setTimeout(() => {
      if (!exited) killGroup(child.pid, "SIGKILL");
    }, 2000).unref();
  };

  let cdp: Cdp | null = null;
  const deadline = Date.now() + options.timeoutMs;
  const left = (): number => Math.max(1000, deadline - Date.now());
  const onAbort = (): void => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let log = "";
      // Cold starts on Windows can exceed 15s; readiness shares the request's deadline.
      const timer = setTimeout(() => reject(new WebError("The browser did not start.", "network")), left());
      child.stderr.on("data", (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-4000);
        const found = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]!);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new WebError("The browser exited before it was ready.", "network"));
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new WebError("The browser could not be started.", "network"));
      });
    });
    cdp = await Cdp.connect(endpoint, Math.min(10_000, left()));
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => cdp!.send(method, params, sessionId);

    // A page should not announce itself as headless.
    const version = (await cdp.send("Browser.getVersion")) as { userAgent?: string };
    if (version.userAgent) await send("Emulation.setUserAgentOverride", { userAgent: version.userAgent.replace("HeadlessChrome", "Chrome") });

    let mainFrame = "";
    let blockedMain: string | null = null;
    const verdicts = new Map<string, Promise<string | null>>();
    const judge = (target: string): Promise<string | null> => {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return Promise.resolve("not a valid address");
      }
      if (parsed.protocol === "about:" || parsed.protocol === "data:" || parsed.protocol === "blob:") return Promise.resolve(null);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Promise.resolve(`${parsed.protocol.replace(":", "")} addresses are not fetched`);
      let verdict = verdicts.get(parsed.hostname);
      if (!verdict) {
        verdict = resolveAllowed(parsed.hostname, options.policy, options.resolve).then(
          () => null,
          (error: unknown) => (error instanceof BlockedAddressError ? error.message : `could not find ${parsed.hostname}`),
        );
        verdicts.set(parsed.hostname, verdict);
      }
      return verdict;
    };
    cdp.on("Fetch.requestPaused", (params, from) => {
      if (from !== sessionId) return;
      const requestId = params.requestId as string;
      const target = (params.request as { url?: string } | undefined)?.url ?? "";
      const type = String(params.resourceType ?? "");
      const frame = String(params.frameId ?? "");
      const fail = (reason: string): void => {
        void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
        // Until navigation has answered the main frame is not known yet, and the first document asked for is the main one.
        if (type === "Document" && reason !== "" && (mainFrame === "" || frame === mainFrame) && blockedMain === null) blockedMain = reason;
      };
      if (BLOCKED_RESOURCES.has(type)) return fail("");
      // A page inside a page is not read, and its navigation is not something to follow.
      if (type === "Document" && mainFrame !== "" && frame !== mainFrame) return fail("");
      void judge(target).then((reason) => {
        if (reason !== null) return fail(reason);
        void send("Fetch.continueRequest", { requestId }).catch(() => undefined);
      });
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await send("Page.enable");

    let loaded: () => void = () => undefined;
    const loadEvent = new Promise<void>((resolve) => (loaded = resolve));
    cdp.on("Page.loadEventFired", (_params, from) => {
      if (from === sessionId) loaded();
    });
    const navigated = (await send("Page.navigate", { url })) as { frameId?: string; errorText?: string };
    mainFrame = navigated.frameId ?? "";
    if (navigated.errorText) throw new WebError(blockedMain ? `The browser was not allowed to load that page: ${blockedMain}` : `The browser could not load that page (${navigated.errorText.replace(/^net::/, "")}).`, blockedMain ? "blocked" : "network");
    await Promise.race([loadEvent, new Promise<void>((resolve) => setTimeout(resolve, Math.min(20_000, left())))]);

    // Scripts keep building the page after the load event: wait until the text stops changing.
    const settleUntil = Date.now() + Math.min(options.settleMs ?? 6000, left());
    let last = -1;
    let steady = 0;
    while (Date.now() < settleUntil && steady < 2) {
      const measured = (await send("Runtime.evaluate", { expression: "document.body ? document.body.innerText.length : 0", returnByValue: true })) as { result?: { value?: number } };
      const size = measured.result?.value ?? 0;
      steady = size === last ? steady + 1 : 0;
      last = size;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (blockedMain !== null) throw new WebError(`The browser was not allowed to load that page: ${blockedMain}`, "blocked");
    const html = (await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true })) as { result?: { value?: string } };
    const where = (await send("Runtime.evaluate", { expression: "location.href", returnByValue: true })) as { result?: { value?: string } };
    return { url: where.result?.value ?? url, html: html.result?.value ?? "" };
  } catch (error) {
    if (options.signal?.aborted) throw new WebError("The request was cancelled.", "aborted");
    if (error instanceof WebError) throw error;
    throw new WebError(`The browser could not load the page (${(error as Error).message.slice(0, 120)}).`, "network");
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    cdp?.close();
    stop();
    // The profile folder goes once the browser has had a moment to let go of it.
    setTimeout(() => removeProfile(profile, 12), exited ? 0 : 2500).unref();
  }
}

/** On Windows the folder can stay locked a little longer: retry, and never let a failed cleanup throw from a timer. */
function removeProfile(profile: string, retries: number): void {
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    if (retries > 0) setTimeout(() => removeProfile(profile, retries - 1), 500).unref();
  }
}
