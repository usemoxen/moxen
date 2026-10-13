import { DEFAULT_CONFIG, setConfigValue } from "../core/config.js";
import { describeSettings } from "../core/configschema.js";
import type { CliConfig } from "../core/types.js";
import type { ClientApi } from "../server/api.js";
import { client as fixtureClient } from "./render-check/fixtures.js";

/**
 * The client behind `bun run tui:mock` (`mock.tsx`): the render-check
 * fixtures' threads, transcript and diffs, plus a catalog offering Claude
 * and OpenAI models alike and settings that live in memory, so the
 * interface — per-model backdrops included — can be tried without a login
 * for every provider. Every other command is accepted and dropped.
 */

const model = (slug: string, name: string, isDefault = false) => ({ slug, name, isCustom: false, ...(isDefault ? { isDefault } : {}) });

const providers = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      // The fixture threads run on `claude-opus-5`; keep it so they label.
      model("claude-opus-5", "Claude Opus 5", true),
      model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
      model("claude-haiku-5-5", "Claude Haiku 5.5"),
      model("claude-fable-5-1", "Claude Fable 5.1"),
      model("claude-mythos-5-1", "Claude Mythos 5.1"),
    ],
    skills: [],
  },
  {
    instanceId: "opencode/openai",
    driver: "opencode",
    displayName: "OpenAI",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    // Names as the catalog would show them; the slugs are stand-ins.
    models: [
      model("gpt-6.1-sol", "GPT-6.1 Sol"),
      model("gpt-6-astra", "GPT-6 Astra"),
      model("gpt-6-terra", "GPT-6 Terra"),
      model("gpt-6-luna", "GPT-6 Luna"),
    ],
    skills: [],
  },
];

let config: CliConfig = DEFAULT_CONFIG;
const settingsSnapshot = () => ({ path: "(mock — in memory)", exists: false, settings: describeSettings(config) });

export const mockClient: ClientApi = {
  ...fixtureClient,
  async getConfig() {
    return { settings: {}, providers } as unknown as Awaited<ReturnType<ClientApi["getConfig"]>>;
  },
  query: (async (query: { type: string }) => {
    if (query.type === "settings.read") return settingsSnapshot();
    if (query.type === "providers.list") return { providers };
    return await (fixtureClient.query as (q: unknown) => Promise<unknown>)(query);
  }) as unknown as ClientApi["query"],
  dispatch: (async (command: { type: string; key?: string; value?: string }) => {
    if (command.type === "settings.set" && command.key !== undefined && command.value !== undefined) {
      config = setConfigValue(config, command.key as Parameters<typeof setConfigValue>[1], command.value);
      return { ...settingsSnapshot(), accepted: true };
    }
    return { accepted: true };
  }) as unknown as ClientApi["dispatch"],
};
