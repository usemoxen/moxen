import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../../core/config.js";
import { describeSettings, type SettingDescriptor, type SettingView } from "../../../core/configschema.js";
import type { CliConfig } from "../../../core/types.js";
import { testHarness } from "../../../core/testing/harness.js";
import { DirectConnection } from "../../connection.js";
import { AGENT_SETTINGS_MAX_LIMIT, SETTINGS_READ_TOOL, agentSettingLiveAllowed, projectAgentSettings } from "../../settingsagent.js";
import { callMoxenTool, moxenToolsFor } from "../tools.js";
import { answerMcp, moxenInstructions } from "../stdio.js";

const SYNTHETIC = "synthetic";
const SYNTHETIC_SERVER = "synthetic-server-9f2c";
const SYNTHETIC_SECRET = "synthetic-env-value-9f2c";
const SYNTHETIC_HEADER = "Bearer synthetic-header-41ab";
const SYNTHETIC_ARG = "synthetic-arg-7d1e";
const SYNTHETIC_URL = "https://private.synthetic.example/v1";
const SYNTHETIC_PATH = "/private/synthetic/bin/claude";
const SYNTHETIC_PROFILE = "synthetic-profile";
const SYNTHETIC_ENV_NAME = "SYNTHETIC_ENV_NAME";

function syntheticConfig(base: Record<string, unknown>): Record<string, unknown> {
  const providers = (base.providers ?? {}) as Record<string, Record<string, unknown>>;
  return {
    ...base,
    runtimeMode: "auto",
    longThreads: { handoff: "auto", handoffAt: "70%", compaction: "auto", compactAt: "80%" },
    instructions: `INSTRUCTIONS ${SYNTHETIC_ARG}`,
    web: { browserPath: `/private/synthetic/chrome-${SYNTHETIC}` },
    providers: {
      ...providers,
      claude: { ...providers.claude, model: "synthetic-model", binaryPath: SYNTHETIC_PATH, homePath: "/private/synthetic/home" },
      harness: {
        ...providers.harness,
        searxngUrl: `https://private.synthetic.example/searx-${SYNTHETIC}`,
        profiles: [{
          id: SYNTHETIC_PROFILE,
          label: "Synthetic profile",
          apiFormat: "chat",
          baseUrl: SYNTHETIC_URL,
          apiKey: "keychain:synthetic-profile-key",
          models: [{ id: "synthetic-private-model" }],
        }],
      },
    },
    mcpServers: {
      [SYNTHETIC_SERVER]: {
        command: `/private/synthetic/${SYNTHETIC}`,
        args: [SYNTHETIC_ARG],
        env: { [SYNTHETIC_ENV_NAME]: SYNTHETIC_SECRET },
      },
      private: {
        type: "http",
        url: `https://private.synthetic.example/mcp-${SYNTHETIC}`,
        headers: { Authorization: SYNTHETIC_HEADER },
      },
    },
  };
}

async function world(
  configPatch: (base: Record<string, unknown>) => Record<string, unknown> = (base) => base,
  provider = "claudeAgent",
) {
  const harness = await testHarness();
  const config = configPatch(syntheticConfig(harness.config as unknown as Record<string, unknown>));
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => config as unknown as CliConfig });
  const created = await connection.dispatch({
    type: "thread.handover",
    cwd: harness.work,
    prompt: "one",
    wait: true,
    threadEnvMode: "local",
    provider,
    model: "synthetic-model",
  });
  return { harness, connection, threadId: created.threadId };
}

function textOf(result: { text: string; isError: boolean }): Record<string, unknown> {
  expect(result.isError).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown>;
}

function settingsOf(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return result.settings as Array<Record<string, unknown>>;
}

describe("settings_read", () => {
  it("stays available to delegated readers and with delegation, web and memory switched off", async () => {
    const names = moxenToolsFor({ delegated: true, webFetch: false, memory: "off" }).map((tool) => tool.name);
    expect(names).toContain(SETTINGS_READ_TOOL);
    expect(moxenToolsFor({}).find((tool) => tool.name === SETTINGS_READ_TOOL)?.annotations?.readOnlyHint).toBe(true);
    expect(moxenInstructions({ delegated: true, webFetch: false, memory: "off" })).toContain(SETTINGS_READ_TOOL);

    const { connection, threadId } = await world();
    try {
      const called = await answerMcp(
        { api: connection, parentThreadId: threadId, delegated: true, webFetch: false, memory: "off" },
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: SETTINGS_READ_TOOL, arguments: { key: "longThreads.handoff" } } },
      );
      const result = called!.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(false);
      expect(settingsOf(JSON.parse(result.content[0]!.text) as Record<string, unknown>)[0]).toMatchObject({
        key: "longThreads.handoff",
        redacted: false,
        value: "auto",
        explicit: true,
        source: "config",
      });
    } finally {
      await connection.close();
    }
  });

  it("returns reviewed live values, their source, timing and fallback, and leaves every other kind redacted", async () => {
    const { connection, threadId } = await world();
    try {
      const live = await callMoxenTool(connection, threadId, SETTINGS_READ_TOOL, { key: "longThreads.compaction" });
      expect(settingsOf(textOf(live))[0]).toMatchObject({ key: "longThreads.compaction", redacted: false, value: "auto", source: "config", appliesAt: "server-restart" });

      const fallback = await callMoxenTool(connection, threadId, SETTINGS_READ_TOOL, { key: "providers.claude.runtimeMode" });
      expect(settingsOf(textOf(fallback))[0]).toMatchObject({
        key: "providers.claude.runtimeMode",
        redacted: false,
        explicit: false,
        source: "fallback",
        effective: { value: "auto" },
      });

      for (const key of ["mcpServers", "providers.harness.profiles", "instructions", "web.browserPath", "providers.harness.searxngUrl", "providers.claude.binaryPath", "ui.autoHandoff"]) {
        const setting = settingsOf(textOf(await callMoxenTool(connection, threadId, SETTINGS_READ_TOOL, { key })))[0]!;
        expect(setting.redacted, key).toBeTruthy();
        expect(setting, key).not.toHaveProperty("value");
        expect(setting, key).not.toHaveProperty("explicit");
        expect(setting, key).not.toHaveProperty("effective");
      }
    } finally {
      await connection.close();
    }
  });

  it("never carries config secret values, endpoints, paths, MCP names or profile identities in the catalog or a lookup", async () => {
    const { connection, threadId } = await world();
    const forbidden = [SYNTHETIC_SERVER, SYNTHETIC_SECRET, SYNTHETIC_HEADER, SYNTHETIC_ARG, SYNTHETIC_URL, SYNTHETIC_PATH, SYNTHETIC_PROFILE, SYNTHETIC_ENV_NAME, "keychain:", "synthetic-private-model", "/private/synthetic"];
    try {
      const pages: unknown[] = [];
      for (let offset = 0; ; ) {
        const page = await connection.query({ type: "settings.agent-read", threadId, limit: AGENT_SETTINGS_MAX_LIMIT, offset });
        pages.push(page);
        const next = (page as { hasMore: boolean; nextOffset?: number }).nextOffset;
        if ((page as { hasMore: boolean }).hasMore !== true || next === undefined) break;
        offset = next;
      }
      for (const key of ["mcpServers", "providers.harness.profiles", "instructions", "web.browserPath", "providers.harness.searxngUrl", "providers.claude.binaryPath", "providers.claude.homePath", "forge.ghPath", "providers.codex.launchArgs"]) {
        pages.push(await connection.query({ type: "settings.agent-read", threadId, key }));
      }
      const text = JSON.stringify(pages);
      for (const value of forbidden) expect(text, value).not.toContain(value);
    } finally {
      await connection.close();
    }
  });

  it("accepts only exact schema keys: aliases stay redacted and nested or unknown keys are refused without echoing them", async () => {
    const { connection, threadId } = await world();
    try {
      const alias = settingsOf(textOf(await callMoxenTool(connection, threadId, SETTINGS_READ_TOOL, { key: "ui.autoHandoff" })))[0]!;
      expect(alias).toMatchObject({ key: "ui.autoHandoff", redacted: "not-allowlisted" });

      for (const key of ["providers.harness.profiles[synthetic-profile].apiKey", "mcpServers.synthetic-server-9f2c.env.SYNTHETIC_ENV_NAME", "LONGTHREADS.HANDOFF", "missing.setting"]) {
        const result = await callMoxenTool(connection, threadId, SETTINGS_READ_TOOL, { key });
        expect(result.isError).toBe(true);
        expect(result.text).not.toContain(SYNTHETIC_PROFILE);
        expect(result.text).not.toContain(SYNTHETIC_ENV_NAME);
        expect(result.text).not.toContain(key);
      }
    } finally {
      await connection.close();
    }
  });

  it("pages the catalog, filters by section and clamps the page size", async () => {
    const { connection, threadId } = await world();
    try {
      const first = await connection.query({ type: "settings.agent-read", threadId, limit: 5 });
      expect(first).toMatchObject({ offset: 0, limit: 5, hasMore: true, nextOffset: 5 });
      expect(first.settings).toHaveLength(5);
      expect(first.total).toBeGreaterThan(5);
      const second = await connection.query({ type: "settings.agent-read", threadId, limit: 5, offset: 5 });
      expect(second.settings[0]!.key).not.toBe(first.settings[0]!.key);

      const mcp = await connection.query({ type: "settings.agent-read", threadId, section: "mcp", limit: AGENT_SETTINGS_MAX_LIMIT });
      expect(mcp.settings.every((setting) => setting.section === "mcp")).toBe(true);
      expect(mcp.sections).toContain("mcp");

      const huge = await connection.query({ type: "settings.agent-read", threadId, limit: 10_000 });
      expect(huge.limit).toBe(AGENT_SETTINGS_MAX_LIMIT);
      const negative = await connection.query({ type: "settings.agent-read", threadId, offset: -10 });
      expect(negative.offset).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("refuses an unknown section without echoing it", async () => {
    const { connection, threadId } = await world();
    try {
      await expect(connection.query({ type: "settings.agent-read", threadId, section: "synthetic-section" })).rejects.toMatchObject({
        code: "SETTINGS_SECTION_UNKNOWN",
      });
    } finally {
      await connection.close();
    }
  });

  it("denies the tool when the moxen server is explicitly removed, excluded, switched off or hiding it", async () => {
    const denied = async (
      patch: (base: Record<string, unknown>) => Record<string, unknown>,
      project?: Record<string, unknown>,
      provider = "claudeAgent",
    ) => {
      const { harness, connection, threadId } = await world(patch, provider);
      try {
        if (project) await writeFile(path.join(harness.work, "moxen.json"), JSON.stringify(project));
        await expect(connection.query({ type: "settings.agent-read", threadId })).rejects.toMatchObject({ code: "SETTINGS_TOOL_DISABLED" });
      } finally {
        await connection.close();
      }
    };
    await denied((base) => ({ ...base, providers: { ...(base.providers as Record<string, unknown>), claude: { ...(base.providers as Record<string, Record<string, unknown>>).claude, mcpExclude: "moxen" } } }));
    await denied(
      (base) => ({
        ...base,
        providers: {
          ...(base.providers as Record<string, unknown>),
          claude: {
            ...(base.providers as Record<string, Record<string, unknown>>).claude,
            accounts: [{ id: "locked", label: "Locked", mcpExclude: "moxen" }],
          },
        },
      }),
      undefined,
      "claude/locked",
    );
    await denied((base) => ({ ...base, mcpServers: { ...(base.mcpServers as Record<string, unknown>), moxen: { command: "synthetic-moxen", disabled: true } } }));
    await denied((base) => ({ ...base, mcpServers: { ...(base.mcpServers as Record<string, unknown>), moxen: { command: "synthetic-moxen", disabledTools: [SETTINGS_READ_TOOL] } } }));
    await denied((base) => base, { mcpServers: { moxen: null } });
  });

  it("keeps the tool when a different server is excluded, a different tool is hidden, or an account profile does not inherit parent mcpExclude", async () => {
    const { connection, threadId } = await world((base) => ({
      ...base,
      providers: { ...(base.providers as Record<string, unknown>), claude: { ...(base.providers as Record<string, Record<string, unknown>>).claude, mcpExclude: "private" } },
      mcpServers: { ...(base.mcpServers as Record<string, unknown>), moxen: { command: "synthetic-moxen", disabledTools: ["delegate"] } },
    }));
    try {
      await expect(connection.query({ type: "settings.agent-read", threadId, limit: 1 })).resolves.toMatchObject({ limit: 1 });
    } finally {
      await connection.close();
    }

    const profileWorld = await world(
      (base) => ({
        ...base,
        providers: {
          ...(base.providers as Record<string, unknown>),
          claude: {
            ...(base.providers as Record<string, Record<string, unknown>>).claude,
            mcpExclude: "moxen",
            accounts: [{ id: "work", label: "Work" }],
          },
        },
      }),
      "claude/work",
    );
    try {
      await expect(profileWorld.connection.query({ type: "settings.agent-read", threadId: profileWorld.threadId, limit: 1 })).resolves.toMatchObject({ limit: 1 });
    } finally {
      await profileWorld.connection.close();
    }
  });

  it("redacts user-defined provider, profile, and model identifiers (even path-shaped ones)", async () => {
    const { connection, threadId } = await world((base) => ({
      ...base,
      provider: `harness/${SYNTHETIC_PROFILE}`,
      model: "/private/synthetic/model-path",
      promptImprover: { provider: `harness/${SYNTHETIC_PROFILE}`, model: "/private/synthetic/improver-model" },
      providers: {
        ...(base.providers as Record<string, unknown>),
        claude: { ...(base.providers as Record<string, Record<string, unknown>>).claude, model: "/private/synthetic/claude-model" },
      },
    }));
    try {
      for (const key of ["provider", "model", "promptImprover.provider", "promptImprover.model", "providers.claude.model"]) {
        const result = await connection.query({ type: "settings.agent-read", threadId, key });
        expect(result.settings[0]).toMatchObject({ key, redacted: "free-form" });
        expect(JSON.stringify(result)).not.toContain(SYNTHETIC_PROFILE);
        expect(JSON.stringify(result)).not.toContain("/private/synthetic/");
      }
    } finally {
      await connection.close();
    }
  });

  it("maps config read errors to a path-free SETTINGS_UNAVAILABLE response", async () => {
    const harness = await testHarness();
    let failLoad = false;
    const config = syntheticConfig(harness.config as unknown as Record<string, unknown>) as unknown as CliConfig;
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      config: async () => {
        if (failLoad) throw new Error("Could not parse config at /private/secret/config.json (backup /private/secret/config.json.bak.1)");
        return config;
      },
    });
    try {
      const created = await connection.dispatch({
        type: "thread.handover",
        cwd: harness.work,
        prompt: "one",
        wait: true,
        threadEnvMode: "local",
        provider: "claudeAgent",
        model: "synthetic-model",
      });
      failLoad = true;
      await expect(connection.query({ type: "settings.agent-read", threadId: created.threadId })).rejects.toMatchObject({
        code: "SETTINGS_UNAVAILABLE",
      });
      try {
        await connection.query({ type: "settings.agent-read", threadId: created.threadId });
      } catch (err) {
        expect(String(err)).not.toContain("/private/secret/");
      }
    } finally {
      await connection.close();
    }
  });

  it("authorizes against the active running turn's account even after next-turn model selection switches to an excluding account", async () => {
    const harness = await testHarness({ leaveTurnsRunning: true });
    const config = {
      ...syntheticConfig(harness.config as unknown as Record<string, unknown>),
      providers: {
        ...(syntheticConfig(harness.config as unknown as Record<string, unknown>).providers as Record<string, unknown>),
        claude: {
          ...((syntheticConfig(harness.config as unknown as Record<string, unknown>).providers as Record<string, Record<string, unknown>>).claude),
          accounts: [
            { id: "work", label: "Work" },
            { id: "locked", label: "Locked", mcpExclude: "moxen" },
          ],
        },
      },
    } as unknown as CliConfig;
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => config });
    try {
      const created = await connection.dispatch({
        type: "thread.handover",
        cwd: harness.work,
        prompt: "running on work",
        wait: false,
        threadEnvMode: "local",
        provider: "claude/work",
        model: "synthetic-model",
      });
      await expect(connection.query({ type: "settings.agent-read", threadId: created.threadId, limit: 1 })).resolves.toMatchObject({ limit: 1 });
      await connection.dispatch({
        type: "thread.model-selection.set",
        threadId: created.threadId,
        modelSelection: { instanceId: "claude/locked", model: "synthetic-model" },
      });
      // Still running on claude/work, so the active session remains authorized.
      await expect(connection.query({ type: "settings.agent-read", threadId: created.threadId, limit: 1 })).resolves.toMatchObject({ limit: 1 });
    } finally {
      await connection.close();
    }
  });
});

describe("settings_read fail-closed projection", () => {
  const descriptor = (kind: SettingDescriptor["kind"], key = "future.setting", defaultValue: SettingDescriptor["defaultValue"] = undefined): SettingDescriptor => ({
    key,
    label: "Future setting",
    description: "A setting added after this tool was written.",
    section: "general",
    kind,
    defaultValue,
  });
  const view = (descriptor: SettingDescriptor, value: SettingView["value"], explicit = true): SettingView => ({ descriptor, value, explicit });

  it("redacts a new primitive setting until it is reviewed, and keeps secret, list and free-form kinds hidden", () => {
    const views = [
      view(descriptor({ type: "boolean" }, "future.flag", true), true),
      view(descriptor({ type: "secret" }, "future.secret"), "keychain:future"),
      view(descriptor({ type: "string" }, "future.path"), "/private/future"),
      view(descriptor({ type: "list", noun: "thing", add: "mcp-server", fields: [], actions: [] }, "future.list"), "future-id"),
    ];
    const result = projectAgentSettings(views, { limit: 10 });
    expect(result.settings.map((setting) => setting.redacted)).toEqual(["not-allowlisted", "secret", "free-form", "complex"]);
    for (const setting of result.settings) {
      expect(setting).not.toHaveProperty("value");
      expect(setting).not.toHaveProperty("explicit");
    }
  });

  it("allows only keys on the reviewed list and never a secret kind", () => {
    expect(agentSettingLiveAllowed("longThreads.handoff")).toBe(true);
    expect(agentSettingLiveAllowed("future.flag")).toBe(false);
    expect(agentSettingLiveAllowed("providers.harness.profiles")).toBe(false);
    expect(agentSettingLiveAllowed("providers.harness.profiles[future].apiKey")).toBe(false);
    const kinds = describeSettings(normalizeConfig({})).filter((setting) => setting.descriptor.kind.type === "secret" || setting.descriptor.kind.type === "list");
    expect(kinds.some((setting) => agentSettingLiveAllowed(setting.descriptor.key))).toBe(false);
  });
});
