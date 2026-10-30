import type { HarnessProviderConfig, WebConfig } from "../../../types.js";
import type { BrowserSettings } from "./browser.js";
import { SEARCH_BACKENDS, type SearchBackend, type SearchSettings } from "./search.js";

/** What the web tools read, once per call, so a setting changed in the app applies to the next call. */
export interface WebSettings {
  readonly search: SearchSettings;
  readonly browser: BrowserSettings;
  readonly allowPrivate: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** How a web tool may reach the web: shared by the Harness's tools and the `web_fetch` Moxen offers every provider. */
export interface WebPolicy {
  readonly browser: BrowserSettings;
  readonly allowPrivate: boolean;
}

/**
 * The shared `web` settings, falling back to the Harness's older keys where
 * they are unset, so a file written before they were shared means what it
 * did. The older private-network switch opened the Harness's tools only, so
 * it still opens nothing else; `web.privateNetwork` is one switch for all.
 */
export function webPolicy(web: WebConfig | undefined, harness: HarnessProviderConfig | undefined, forHarness: boolean): WebPolicy {
  const mode = web?.browser ?? harness?.webBrowser;
  return {
    browser: { mode: mode === "off" ? "off" : "auto", path: (web?.browserPath ?? harness?.webBrowserPath) || undefined },
    allowPrivate: web?.privateNetwork ?? (forHarness && harness?.webPrivateNetwork === true),
  };
}

export function resolveWebSettings(config: HarnessProviderConfig | undefined, env: NodeJS.ProcessEnv, web?: WebConfig): WebSettings {
  const backend = SEARCH_BACKENDS.includes(config?.webSearch as SearchBackend) ? (config!.webSearch as SearchBackend) : "duckduckgo";
  return {
    search: { backend, searxngUrl: config?.searxngUrl },
    ...webPolicy(web, config, true),
    env,
  };
}
