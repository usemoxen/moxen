import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { DEFAULT_CONFIG, setConfigValue } from "../../../core/config.js";
import type { CliConfig } from "../../../core/types.js";
import { SETTINGS, describeAllAccountSettings, describeSettings, type SettingDescriptor } from "../../../core/configschema.js";
import { summarizeProviderAccounts } from "../../../core/providers/accounts.js";
import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { AccountUsageRows, ProfileAccountHeader, ProvidersOverviewPanel } from "../../features/settings/providersoverview.js";
import { SkillsPanel } from "../../features/settings/skillspanel.js";
import { skillsClient } from "../skillsfixture.js";
import { tx } from "../../i18n/index.js";
import { Stage, type GalleryEntry } from "./registry.js";

/**
 * The settings page, one entry per page of its sidebar and one per kind of
 * setting editor. It renders the real schema through the real
 * `describeSettings`, so a setting added to `core/configschema.ts` shows up
 * here without this file changing; the kinds are read from the table too.
 * `runSettingsCoverage` (the render-check) fails when a setting never shows.
 */

/** One move toward a page: a sidebar row (the `nth` with that label), a row of the open page, or a key. */
export type Step =
  | { readonly kind: "sidebar"; readonly label: string; readonly nth: number }
  | { readonly kind: "row"; readonly label: string }
  | { readonly kind: "key"; readonly key: "pressEnter" | "pressEscape" | "pressTab" };

const side = (label: string, nth = 0): Step => ({ kind: "sidebar", label, nth });
const row = (label: string): Step => ({ kind: "row", label });
const enter: Step = { kind: "key", key: "pressEnter" };

/** A screen of the settings page and how to reach it from a fresh one. */
export interface PageRef {
  /** What it is called in the image's title and the sidebar check. */
  readonly label: string;
  /** The image's file name, without the variant. */
  readonly name: string;
  readonly steps: readonly Step[];
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ref = (name: string, label: string, ...steps: Step[]): PageRef => ({ name: slug(name), label, steps });
const page = (label: string): PageRef => ref(label, label, side(label));

/** The sidebar, top to bottom, as the page lists it with no profiles or servers set (zero default providers). */
export const DEFAULT_PAGES: readonly PageRef[] = ["General", "Defaults", "Sessions", "Long threads", "Agent context", "Memory", "Interface", "Git and forges", "Overview", "ACP agents", "Model servers", "MCP servers", "Skills"].map(page);

const PROFILE_PAGES = ["Endpoint", "Models", "Sampling", "Compaction", "Behaviour", "Prompt", "Template quirks"];
const SERVER_PAGES = ["Connection", "Who gets it", "In force"];

/**
 * With things set the page grows: configured provider profiles appear directly
 * under Providers (`Claude · Personal`, `ChatGPT · Personal`, `Antigravity · Personal`,
 * plus opt-in `OpenCode`), the Harness gets pages of its own (its Defaults,
 * Long threads and Sessions are the second rows of those labels), and every
 * profile and MCP server gets pages, wizards and editors.
 */
export const CONFIGURED_PAGES: readonly PageRef[] = [
  ...["General", "Defaults", "Sessions", "Long threads", "Agent context", "Interface", "Git and forges", "Overview", "Antigravity · Main", "ChatGPT · Personal", "Claude · Personal", "Mistral Vibe", "OpenCode"].map(page),
  ref("Harness Defaults", "Defaults (Harness)", side("Defaults", 1)),
  page("Tools"),
  ref("Harness Long threads", "Long threads (Harness)", side("Long threads", 1)),
  ref("Harness Sessions", "Sessions (Harness)", side("Sessions", 1)),
  page("Web search"),
  page("Model servers"),
  page("MCP servers"),
  // A profile, its pages, and its models.
  ...["Local llama.cpp", "Cloud endpoint"].map(page),
  ...PROFILE_PAGES.map((sub) => ref(`Profile ${sub}`, `Profile: ${sub}`, side("Local llama.cpp"), side(sub))),
  ...["qwen3-coder", "gemma-4"].map((model) => ref(`Model ${model}`, `Model: ${model}`, side("Local llama.cpp"), side("Models"), row(model))),
  ref("Model qwen3-coder in force", "Model: qwen3-coder, in force", side("Local llama.cpp"), side("Models"), row("qwen3-coder"), side("In force")),
  // Adding a profile, step by step: the kind of server, its address, the model.
  ref("Add profile kind", "Add a profile: kind", side("Model servers"), row("+ Add profile")),
  ref("Add profile address", "Add a profile: address", side("Model servers"), row("+ Add profile"), enter),
  ref("Add profile model", "Add a profile: model", side("Model servers"), row("+ Add profile"), enter, enter),
  // MCP servers: the list, each server's pages, and adding one step by step.
  ref("Servers list", "MCP servers: list", side("MCP servers"), row("Servers")),
  ...["brave-search", "exa", "filesystem", "github"].map(page),
  ...SERVER_PAGES.map((sub) => ref(`Server brave-search ${sub}`, `brave-search: ${sub}`, side("brave-search"), side(sub))),
  ref("Server github Connection", "github: Connection", side("github"), side("Connection")),
  ref("Server github Who gets it", "github: Who gets it", side("github"), side("Who gets it")),
  ref("Add server kind", "Add an MCP server: kind", side("MCP servers"), row("Servers"), row("+ Add server")),
  ref("Add server command", "Add an MCP server: command", side("MCP servers"), row("Servers"), row("+ Add server"), enter),
  ref("Add server name", "Add an MCP server: name", side("MCP servers"), row("Servers"), row("+ Add server"), enter, enter),
];

const WIDTH = 100;
const PAGE_HEIGHT = 260;

const models = (names: readonly string[]): ProviderSummary["models"] =>
  names.map((name, index) => ({ slug: name.toLowerCase().replace(/\s+/g, "-"), name, isCustom: false, isDefault: index === 0, isHidden: false, efforts: [] }));

export const SETTINGS_PROVIDERS: ProviderSummary[] = [
  { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: null, authStatus: "chatgpt", models: models(["Codex model"]), supportedRuntimeModes: null, usageLimits: null, skills: [] },
  { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, installed: true, status: null, authStatus: null, models: models(["Claude Opus 5", "Claude Sonnet 5.5"]), supportedRuntimeModes: null, usageLimits: null, skills: [] },
  { instanceId: "opencode", driver: "opencode", displayName: "OpenCode", enabled: true, installed: true, status: null, authStatus: null, models: models(["GPT-5.5", "Kimi K3"]), supportedRuntimeModes: null, usageLimits: null, skills: [] },
  { instanceId: "vibe", driver: "vibe", displayName: "Mistral Vibe", enabled: true, installed: true, status: null, authStatus: "os_keyring", models: models(["Mistral Large 4", "Mistral Medium"]), supportedRuntimeModes: null, usageLimits: null, skills: [] },
  {
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    enabled: true,
    installed: true,
    status: null,
    authStatus: "oauth",
    models: [
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        isCustom: false,
        isDefault: true,
        isHidden: false,
        efforts: [
          {
            id: "effort",
            label: "Effort",
            currentValue: "high",
            choices: [
              { id: "low", label: "Low", isDefault: false },
              { id: "medium", label: "Medium", isDefault: false },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra", isDefault: false },
            ],
          },
        ],
      },
      {
        slug: "gemini-4-argon",
        name: "Gemini 4 Argon",
        isCustom: false,
        isDefault: false,
        isHidden: false,
        efforts: [
          {
            id: "effort",
            label: "Effort",
            currentValue: "medium",
            choices: [
              { id: "low", label: "Low", isDefault: false },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High", isDefault: false },
            ],
          },
        ],
      },
    ],
    supportedRuntimeModes: null,
    usageLimits: null,
    skills: [],
  },
];

const noop = (): void => {};

/**
 * A config with things set: the MCP servers (Brave and Exa among them, which
 * is what unlocks the web-search order), a Harness profile, and values pinned
 * where the default would show. The default config shows every empty state;
 * this one shows the lists and the explicit values.
 */
export const CONFIGURED: CliConfig = (() => {
  let config: CliConfig = {
    ...DEFAULT_CONFIG,
    mcpServers: {
      "brave-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "placeholder" } },
      exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/", providers: ["claude"] },
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], disabled: true },
    },
    providers: {
      claude: {
        accounts: [{ id: "personal", label: "Personal" }],
      },
      chatgpt: {
        accounts: [{ id: "personal", label: "Personal", email: "dev@example.test", planType: "plus" }],
      },
      antigravity: {
        accounts: [{ id: "main", label: "Main" }],
      },
      opencode: {
        enabled: true,
      },
      vibe: {
        enabled: true,
      },
      harness: {
        profiles: [
          { id: "local", label: "Local llama.cpp", apiFormat: "chat", baseUrl: "http://localhost:8080/v1", models: [{ id: "qwen3-coder", contextWindow: 131_072, vision: false }, { id: "gemma-4", contextWindow: 262_144, vision: true }] },
          { id: "cloud", label: "Cloud endpoint", apiFormat: "responses", baseUrl: "https://api.example.test/v1", apiKeyEnv: "EXAMPLE_API_KEY", models: [{ id: "big-model" }] },
        ],
      },
    },
  };
  const pins: Array<[string, string]> = [
    ["ui.theme", "catppuccin-mocha"],
    ["ui.backdrop", "static"],
    ["instructions", "Prefer small commits and say what you did not run."],
    ["providers.claude.accounts[personal].compactAtModels", "claude-opus-5=400k"],
    ["providers.claude.accounts[personal].webSearchOrder", "brave,native"],
    ["longThreads.handoff", "auto"],
    ["git.historyLimit", "200"],
  ];
  // A setting that shows only while another holds a value ("Listen on" under Remote access): hold it.
  const pinned = new Set(pins.map(([key]) => key));
  for (const descriptor of SETTINGS) {
    const when = descriptor.visibleWhen;
    if (when === undefined || pinned.has(when.key) || when.in.includes("")) continue;
    pinned.add(when.key);
    pins.push([when.key, when.in[0]!]);
  }
  for (const [key, value] of pins) {
    try {
      config = setConfigValue(config, key as Parameters<typeof setConfigValue>[1], value);
    } catch {
      // A key the schema renamed: the page then shows its default, which is still a valid page to look at.
    }
  }
  return config;
})();

/** The settings page at `height`, taking up the whole stage. */
export function settingsPage(height: number, config: CliConfig = DEFAULT_CONFIG) {
  const snapshot = {
    path: "/home/dev/.moxen/config.json",
    exists: true,
    settings: describeSettings(config),
    accountSettings: describeAllAccountSettings(config),
  };
  const accounts = summarizeProviderAccounts(config.providers);
  return (
    <Stage width={WIDTH} height={height}>
      <SettingsModal
        client={skillsClient().api}
        snapshot={snapshot}
        accounts={accounts}
        loading={false}
        saving={null}
        error={null}
        onSet={noop}
        onDuplicate={noop}
        run={null}
        onTest={noop}
        onTestMcp={noop}
        onProbe={noop}
        onDiscover={async () => ({ ok: true, host: "localhost:11434", models: [{ id: "qwen3-coder:30b", contextWindow: 131_072 }, { id: "gemma-4:27b", contextWindow: 262_144 }, { id: "nomic-embed-text" }] })}
        onExport={noop}
        onImport={noop}
        notice={null}
        versions={{
          codex: { ok: true, installed: true, version: "codex-cli 0.164.0", login: "inherit", minVersion: "0.164.0" },
          claude: { ok: true, installed: true, version: "2.1.293 (Claude Code)", login: "inherit", minVersion: "2.1.292" },
          opencode: { ok: true, installed: true, version: "opencode v2.0.22", login: "inherit", minVersion: "2.0.0" },
          antigravity: { ok: true, installed: true, version: "1.5.13", login: "inherit" },
          vibe: { ok: true, installed: true, version: "3.1.4", login: "inherit" },
        }}
        latest={{ enabled: true, claude: { latest: "2.1.293", channel: "latest" }, opencode: { latest: "2.0.24", channel: null }, antigravity: { latest: "1.5.14", channel: null }, vibe: { latest: "3.1.4", channel: null } }}
        updating={new Set()}
        onUpdate={noop}
        providers={SETTINGS_PROVIDERS}
        screenWidth={WIDTH}
        screenHeight={height}
        left={0}
        top={0}
        width={WIDTH}
        height={height}
        onClose={noop}
      />
    </Stage>
  );
}

/** The sidebar's width in columns: its labels sit left of it, the open page right of it. */
const SIDEBAR_COLUMNS = 26;

/** Where `text` first appears in the frame, searching only the columns `from` to `to` (the sidebar, or the open page). */
export function locate(setup: TestRendererSetup, text: string, from = 0, to = Infinity): { x: number; y: number } | null {
  const rows = setup.captureCharFrame().split("\n");
  for (const [y, row] of rows.entries()) {
    const x = row.slice(0, to).indexOf(text, from);
    if (x >= 0) return { x, y };
  }
  return null;
}

/** Selects a sidebar page by clicking its label: the `nth` row (from 0) whose text is exactly `label`. */
export async function openPage(setup: TestRendererSetup, label: string, nth = 0): Promise<void> {
  const rows = setup.captureCharFrame().split("\n");
  const at = rows
    .map((row, y) => ({ y, text: row.slice(0, SIDEBAR_COLUMNS).replace(/^[\s▌│├└]+/, "").replace(/│/g, "").trim() }))
    .filter((row) => row.text === label)[nth];
  if (at === undefined) throw new Error(`the settings sidebar has no "${label}" (${nth + 1})`);
  await act(async () => setup.mockMouse.click(rows[at.y]!.indexOf(label) + 1, at.y));
  await setup.flush();
}

/** Opens a setting's editor by clicking its row in the open page. */
export async function openSetting(setup: TestRendererSetup, label: string): Promise<void> {
  const at = locate(setup, label, SIDEBAR_COLUMNS);
  if (at === null) throw new Error(`the open page has no "${label}" row`);
  await act(async () => setup.mockMouse.click(at.x + 1, at.y));
  await setup.flush();
}

/** Follows a page's steps from a fresh screen. */
export async function walk(setup: TestRendererSetup, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === "sidebar") await openPage(setup, step.label, step.nth);
    else if (step.kind === "row") await openSetting(setup, step.label);
    else {
      await act(async () => setup.mockInput[step.key]());
      await new Promise((resolve) => setTimeout(resolve, 150));
      await setup.flush();
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

/** The sidebar page a descriptor is on. */
function pageOf(descriptor: SettingDescriptor): string {
  const labels: Record<string, string> = {
    general: "General",
    defaults: "Defaults",
    sessions: "Sessions",
    "long-threads": "Long threads",
    agent: "Agent context",
    interface: "Interface",
    git: "Git and forges",
    "provider:codex": "Codex",
    "provider:claude": "Claude · Personal",
    "provider:opencode": "OpenCode",
    "provider:antigravity": "Antigravity · Main",
    "provider:vibe": "Mistral Vibe",
    "provider:chatgpt": "ChatGPT · Personal",
    "provider:acp": "ACP agents",
    "provider:harness": "Model servers",
    mcp: "MCP servers",
  };
  return labels[descriptor.section] ?? "General";
}

/** One representative setting per editor: its kind, plus what the kind is for. */
function editorKinds(): { id: string; descriptor: SettingDescriptor }[] {
  const seen = new Map<string, SettingDescriptor>();
  for (const descriptor of SETTINGS) {
    if (descriptor.hidden === true || descriptor.kind.type === "boolean") continue;
    const kind = descriptor.kind as { type: string; source?: string; multiline?: boolean };
    const key = [kind.type, kind.source ?? "", kind.multiline === true ? "multiline" : ""].filter(Boolean).join("-");
    if (!seen.has(key)) seen.set(key, descriptor);
  }
  return [...seen].map(([id, descriptor]) => ({ id, descriptor }));
}

const pageEntries: GalleryEntry[] = [
  { variant: "", pages: DEFAULT_PAGES, config: DEFAULT_CONFIG },
  { variant: "-configured", pages: CONFIGURED_PAGES, config: CONFIGURED },
].flatMap(({ variant, pages, config }) =>
  pages.map(
    (page): GalleryEntry => ({
      id: `settings-page-${page.name}${variant}`,
      group: "settings",
      title: `Settings: ${page.label}${variant === "" ? "" : ", configured"}`,
      width: WIDTH,
      height: PAGE_HEIGHT,
      settleMs: 250,
      squeeze: true,
      element: () => settingsPage(PAGE_HEIGHT, config),
      drive: async (setup) => {
        await walk(setup, page.steps);
        await settle();
      },
    }),
  ),
);

const editorEntries: GalleryEntry[] = editorKinds().map(({ id, descriptor }) => ({
  id: `settings-editor-${id}`,
  group: "settings",
  title: `Settings editor: ${descriptor.label} (${id})`,
  width: WIDTH,
  // As tall as a page: the row to open can sit anywhere down a provider's long page.
  height: PAGE_HEIGHT,
  settleMs: 250,
  squeeze: true,
  element: () => settingsPage(PAGE_HEIGHT, CONFIGURED),
  drive: async (setup) => {
    await openPage(setup, pageOf(descriptor));
    await openSetting(setup, descriptor.label);
    await settle();
  },
}));

/** The Skills page with a skill chosen (the restricted one, `review`) and, optionally, its provider choice open. */
const skillsEntry = (id: string, title: string, providers: boolean): GalleryEntry => ({
  id,
  group: "settings",
  title,
  width: WIDTH,
  height: PAGE_HEIGHT,
  settleMs: 250,
  squeeze: true,
  element: () => settingsPage(PAGE_HEIGHT, CONFIGURED),
  drive: async (setup) => {
    await openPage(setup, tx("Skills"));
    await settle();
    await act(async () => setup.mockInput.pressArrow("down"));
    await settle();
    if (providers) {
      await act(async () => setup.mockInput.pressKey("p"));
      await settle();
    }
  },
});

export const SETTINGS_GALLERY: GalleryEntry[] = [...pageEntries, ...editorEntries, skillsEntry("settings-page-skills-restricted", "Settings: Skills, a skill offered to some providers", false), skillsEntry("settings-page-skills-providers", "Settings: Skills, the provider choice open", true), {
  id: "skills-management",
  group: "settings",
  title: "User skills: shared, provider-specific and linked",
  width: 90,
  height: 32,
  element: () => <Stage width={90} height={32}><SkillsPanel client={skillsClient().api} width={88} /></Stage>,
}, {
  id: "providers-overview",
  group: "settings",
  title: "Providers overview: multi-account logins and CLI updaters",
  width: 90,
  height: 30,
  element: () => (
    <Stage width={90} height={30}>
      <ProvidersOverviewPanel
        accounts={[
          {
            kind: "claude",
            id: "personal",
            instanceId: "claude/personal",
            label: "Personal",
            enabled: true,
            homePath: "~/.claude-personal",
            binaryPath: null,
            launchArgs: null,
            env: {},
            model: null,
            thinkingEffort: null,
            email: null,
            workspaceName: null,
            planType: "Claude Pro",
            signedIn: null,
            codexHomePath: null,
            codexBinaryPath: null,
            codexLaunchArgs: null,
            codexVerified: false,
          },
          {
            kind: "chatgpt",
            id: "work",
            instanceId: "chatgpt/work",
            label: "Work",
            enabled: true,
            homePath: null,
            binaryPath: null,
            launchArgs: null,
            env: {},
            model: null,
            thinkingEffort: null,
            email: "dev@example.test",
            workspaceName: "Acme",
            planType: "ChatGPT Plus",
            signedIn: true,
            codexHomePath: "~/.codex-work",
            codexBinaryPath: null,
            codexLaunchArgs: null,
            codexVerified: true,
          },
        ]}
        selectedInstance={null}
        onSelectAccount={noop}
        providers={SETTINGS_PROVIDERS}
        usageByInstance={{
          "chatgpt/work": {
            checkedAt: "2026-11-22T02:00:00.000Z",
            windows: [
              { id: "session", kind: "session", label: "5h", usedPercent: 22, resetsAt: "2026-11-22T05:00:00.000Z" },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 45, resetsAt: null },
            ],
            unavailable: null,
          },
        }}
        versions={{
          claude: { ok: true, installed: true, version: "2.1.330 (Claude Code)", login: "inherit", minVersion: "2.1.292" },
          opencode: { ok: true, installed: true, version: "opencode v2.3.2", login: "inherit", minVersion: "2.0.0" },
          codex: { ok: true, installed: true, version: "codex-cli 0.171.0", login: "inherit", minVersion: "0.164.0" },
          antigravity: { ok: true, installed: true, version: "agy 1.5.14", login: "inherit", minVersion: "1.0.0" },
          vibe: { ok: true, installed: true, version: "3.1.4", login: "inherit" },
        }}
        latest={{ enabled: true, claude: { latest: "2.1.330", channel: "latest" }, opencode: { latest: "2.3.2", channel: null }, codex: { latest: "0.171.0", channel: null }, antigravity: { latest: "1.5.14", channel: null }, vibe: { latest: "3.1.4", channel: null } }}
        updating={new Set()}
        updatingAll={false}
        updateAllResults={null}
        saving={false}
        error={null}
        width={86}
        onSaveAccount={async () => true}
        onToggleAccount={async () => undefined}
        onRemoveAccount={async () => undefined}
        onUpdate={noop}
        onUpdateAll={noop}
        onOpenSection={noop}
        onClose={noop}
      />
    </Stage>
  ),
}, {
  id: "profile-account-header",
  group: "settings",
  title: "Provider profile header: identity, auth, env, and remove",
  width: 90,
  height: 14,
  element: () => (
    <Stage width={90} height={14}>
      <ProfileAccountHeader
        account={{
          kind: "chatgpt",
          id: "work",
          instanceId: "chatgpt/work",
          label: "Work",
          enabled: true,
          homePath: null,
          binaryPath: null,
          launchArgs: null,
          env: {},
          model: null,
          thinkingEffort: null,
          email: "dev@example.test",
          workspaceName: "Acme",
          planType: "ChatGPT Plus",
          signedIn: true,
          codexHomePath: "~/.codex-work",
          codexBinaryPath: null,
          codexLaunchArgs: null,
          codexVerified: true,
        }}
        providers={SETTINGS_PROVIDERS}
        usageByInstance={{
          "chatgpt/work": {
            checkedAt: "2026-11-22T02:00:00.000Z",
            windows: [
              { id: "session", kind: "session", label: "5h", usedPercent: 22, resetsAt: "2026-11-22T05:00:00.000Z" },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 45, resetsAt: null },
            ],
            unavailable: null,
          },
        }}
        versions={{
          claude: { ok: true, installed: true, version: "2.1.330 (Claude Code)", login: "inherit", minVersion: "2.1.292" },
          opencode: { ok: true, installed: true, version: "opencode v2.3.2", login: "inherit", minVersion: "2.0.0" },
          codex: { ok: true, installed: true, version: "codex-cli 0.171.0", login: "inherit", minVersion: "0.164.0" },
          antigravity: { ok: true, installed: true, version: "agy 1.5.14", login: "inherit", minVersion: "1.0.0" },
          vibe: { ok: true, installed: true, version: "3.1.4", login: "inherit" },
        }}
        latest={{ enabled: true, claude: { latest: "2.1.330", channel: "latest" }, opencode: { latest: "2.3.2", channel: null }, codex: { latest: "0.171.0", channel: null }, antigravity: { latest: "1.5.14", channel: null }, vibe: { latest: "3.1.4", channel: null } }}
        updating={new Set()}
        saving={false}
        error={null}
        width={86}
        onSaveAccount={async () => true}
        onToggleAccount={async () => undefined}
        onRemoveAccount={async () => undefined}
        onUpdate={noop}
        onRemoved={noop}
      />
    </Stage>
  ),
}, {
  id: "account-usage-rows",
  group: "settings",
  title: "Account usage rows: aligned 0%, partial, and 100% quota bars",
  width: 72,
  height: 10,
  element: () => (
    <Stage width={72} height={10}>
      <AccountUsageRows
        heading="OpenCode Go"
        width={68}
        limits={{
          checkedAt: "2026-11-22T02:00:00.000Z",
          windows: [
            { id: "session", kind: "session", label: "Session", usedPercent: 0, resetsAt: "2026-11-22T05:00:00.000Z" },
            { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 60, resetsAt: "2026-11-28T05:00:00.000Z" },
            { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 100, resetsAt: null },
          ],
          unavailable: null,
        }}
      />
    </Stage>
  ),
}];
