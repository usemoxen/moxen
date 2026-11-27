/**
 * Single-account Antigravity enforcement and `allowUnsupportedUse` scoping (LOCAL-037):
 * Moxen supports at most one Antigravity account — sharing the host `agy` login
 * with its environment untouched — and never launches, probes, or routes to
 * any isolated `homePath`, non-host env/`--gemini-dir` override, or second
 * Antigravity account, regardless of `providers.antigravity.allowUnsupportedUse`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, normalizeFileConfig } from "../../config.js";
import { describeAccountSettings, describeSettings } from "../../configschema.js";
import { FakeAcpTransport } from "../acp/tests/fakes.js";
import { antigravityProvider } from "../antigravity/catalog.js";
import { ANTIGRAVITY_FILE_STORAGE_SSH_MARKER } from "../antigravity/config.js";
import {
  resolveAntigravityAccount,
  summarizeProviderAccounts,
  upsertProviderAccount,
} from "../accounts.js";
import type { AntigravityProviderConfig, ProvidersConfig } from "../../types.js";

const SETTING = "providers.antigravity.allowUnsupportedUse";
const realHome = path.resolve(path.join(os.tmpdir(), "moxen-agy-host-home"));

function gated(call: () => unknown): { readonly code: string; readonly message: string } {
  try {
    call();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code && e.message) return { code: e.code, message: e.message };
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("Antigravity single-account enforcement and allowUnsupportedUse scoping", () => {
  const baseEnv: NodeJS.ProcessEnv = { HOME: realHome, USERPROFILE: realHome, PATH: process.env.PATH };

  it("runs the one host-login account and the base instance with the environment untouched", () => {
    const config: AntigravityProviderConfig = {
      accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", homePath: "~/agy-alt" }],
    };
    const survivor = resolveAntigravityAccount(config, "antigravity/default", baseEnv);
    expect(survivor.instanceId).toBe("antigravity/default");
    expect(survivor.env).toBe(baseEnv);
    expect(survivor.spec.args).toEqual(["acp"]);
    expect(survivor.spec.env).toBeUndefined();

    for (const instanceId of ["antigravity", "agy"]) {
      const host = resolveAntigravityAccount(config, instanceId, baseEnv);
      expect(host.env).toBe(baseEnv);
      expect(host.spec.args).toEqual(["acp"]);
      expect("SSH_CONNECTION" in host.env).toBe(false);
    }
  });

  it("refuses an account with a homePath before launch, even when allowUnsupportedUse is on", () => {
    for (const allowUnsupportedUse of [false, true]) {
      const config: AntigravityProviderConfig = {
        ...(allowUnsupportedUse ? { allowUnsupportedUse: true } : {}),
        accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", homePath: "~/agy-alt" }],
      };
      const refusal = gated(() => resolveAntigravityAccount(config, "antigravity/alt", baseEnv));
      expect(refusal.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
      expect(refusal.message).toContain("homePath");
      expect(refusal.message).toContain("Remove");
    }
  });

  it("disables the only account when even it has a homePath, rather than silently switching to the host login", () => {
    const config: AntigravityProviderConfig = { accounts: [{ id: "default", homePath: "~/agy-default" }] };
    const refusal = gated(() => resolveAntigravityAccount(config, "antigravity/default", baseEnv));
    expect(refusal.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(refusal.message).toContain("homePath");
    const host = resolveAntigravityAccount(config, "antigravity", baseEnv);
    expect(host.env).toBe(baseEnv);
  });

  it("leaves only the first host-login account when several are configured, even when allowUnsupportedUse is on", () => {
    for (const allowUnsupportedUse of [false, true]) {
      const twoHostLogins: AntigravityProviderConfig = {
        ...(allowUnsupportedUse ? { allowUnsupportedUse: true } : {}),
        accounts: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
      };
      expect(resolveAntigravityAccount(twoHostLogins, "antigravity/first", baseEnv).env).toBe(baseEnv);
      const refusal = gated(() => resolveAntigravityAccount(twoHostLogins, "antigravity/second", baseEnv));
      expect(refusal.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    }

    const mixed: AntigravityProviderConfig = {
      accounts: [{ id: "isolated", homePath: "~/agy-a" }, { id: "plain" }, { id: "extra", homePath: "~/agy-b" }],
    };
    expect(gated(() => resolveAntigravityAccount(mixed, "antigravity/isolated", baseEnv)).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(resolveAntigravityAccount(mixed, "antigravity/plain", baseEnv).env).toBe(baseEnv);
    expect(gated(() => resolveAntigravityAccount(mixed, "antigravity/extra", baseEnv)).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(resolveAntigravityAccount({ accounts: [] }, "antigravity/ghost", baseEnv).env).toBe(baseEnv);
  });

  it("refuses adding a second Antigravity account or an isolated homePath via upsertProviderAccount", () => {
    const base = normalizeConfig({
      ...DEFAULT_CONFIG,
      providers: { antigravity: { accounts: [{ id: "default", label: "Default" }] } },
    });
    expect(gated(() => upsertProviderAccount(base, { kind: "antigravity", id: "second", label: "Second" })).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(gated(() => upsertProviderAccount(base, { kind: "antigravity", id: "default", homePath: "~/agy-iso" })).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    // Updating the existing host-login account without homePath still succeeds.
    const updated = upsertProviderAccount(base, { kind: "antigravity", id: "default", label: "Host Antigravity" });
    expect(updated.created).toBe(false);
    expect(updated.account.label).toBe("Host Antigravity");

    // A legacy profile that already has a homePath still allows unrelated edits
    // (e.g. label) and clearing its homePath, while refusing new non-empty paths.
    const legacy = normalizeConfig({
      ...DEFAULT_CONFIG,
      providers: { antigravity: { accounts: [{ id: "default", label: "Default", homePath: "~/agy-legacy" }] } },
    });
    const renamed = upsertProviderAccount(legacy, { kind: "antigravity", id: "default", label: "Renamed" });
    expect(renamed.account.label).toBe("Renamed");
    expect(renamed.account.homePath).toBe("~/agy-legacy");
    expect(summarizeProviderAccounts(renamed.config.providers).find((row) => row.instanceId === "antigravity/default")?.disabledReason).toContain(
      "moxen config set 'providers.antigravity.accounts[default].homePath' ''",
    );
    const repaired = upsertProviderAccount(legacy, { kind: "antigravity", id: "default", homePath: null });
    expect(repaired.account.homePath).toBeNull();
    expect(summarizeProviderAccounts(repaired.config.providers).find((row) => row.instanceId === "antigravity/default")?.disabledReason).toBeNull();
  });

  it("keeps allowUnsupportedUse at the provider-level key in account profile settings and strips stray account copies", () => {
    const brokenRaw = {
      providers: {
        antigravity: {
          accounts: [{ id: "default", label: "Default", allowUnsupportedUse: true }],
        },
      },
    };
    const normalized = normalizeConfig(brokenRaw);
    expect(normalized.providers?.antigravity?.allowUnsupportedUse).toBeUndefined();
    expect("allowUnsupportedUse" in (normalized.providers?.antigravity?.accounts?.[0] ?? {})).toBe(false);

    const offViews = describeAccountSettings(normalized, "antigravity", "default");
    const offToggle = offViews.find((v) => v.descriptor.key === SETTING);
    expect(offToggle).toBeDefined();
    expect(offToggle?.value).toBe(false);
    expect(offToggle?.explicit).toBe(false);
    expect(offViews.some((v) => v.descriptor.key.includes("accounts[default].allowUnsupportedUse"))).toBe(false);

    const enabled = normalizeConfig({
      providers: {
        antigravity: {
          allowUnsupportedUse: true,
          accounts: [{ id: "default", label: "Default" }],
        },
      },
    });
    const onToggle = describeAccountSettings(enabled, "antigravity", "default").find((v) => v.descriptor.key === SETTING);
    expect(onToggle?.value).toBe(true);
    expect(onToggle?.explicit).toBe(true);
  });

  it("marks blocked accounts in config output with the reason even when allowUnsupportedUse is on, and other kinds never carry it", () => {
    const providers = {
      claude: { accounts: [{ id: "personal" }] },
      antigravity: {
        allowUnsupportedUse: true,
        accounts: [{ id: "default" }, { id: "alt", homePath: "~/agy-alt" }, { id: "extra" }],
      },
    } as unknown as ProvidersConfig;
    const rows = summarizeProviderAccounts(providers);
    expect(rows.find((row) => row.instanceId === "antigravity/default")).toMatchObject({ enabled: true, disabledReason: null });
    expect(rows.find((row) => row.instanceId === "antigravity/alt")?.disabledReason).toContain("homePath");
    expect(rows.find((row) => row.instanceId === "antigravity/extra")?.disabledReason).toContain("at most one Antigravity account");
    const claude = rows.find((row) => row.instanceId === "claude/personal")!;
    expect("disabledReason" in claude).toBe(false);
  });

  it("lists an isolated Antigravity account in the provider catalog as disabled and never starts its agent", async () => {
    const transport = new FakeAcpTransport({ authMethods: [{ id: "oauth", name: "Google login" }] });
    const config: AntigravityProviderConfig = {
      allowUnsupportedUse: true,
      accounts: [{ id: "alt", homePath: "~/agy-alt" }],
    };
    const summary = await antigravityProvider(config, baseEnv, process.cwd(), transport, {
      account: { id: "alt", homePath: "~/agy-alt" },
    });
    expect(summary.instanceId).toBe("antigravity/alt");
    expect(summary.enabled).toBe(false);
    expect(summary.models).toEqual([]);
    expect(summary.status).toContain("homePath");
    expect(transport.sessions).toHaveLength(0);
  });

  it("defaults the setting to false and never writes it into the config file on its own", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      providers: { antigravity: { accounts: [{ id: "default", homePath: "~/agy-default" }] } },
    });
    expect(config.providers?.antigravity?.allowUnsupportedUse).toBeUndefined();
    const view = describeSettings(config).find((setting) => setting.descriptor.key === SETTING);
    expect(view?.descriptor.defaultValue).toBe(false);
    expect(view?.value).toBe(false);
    const written = normalizeFileConfig(config);
    expect(JSON.stringify(written)).not.toContain("allowUnsupportedUse");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-agy-config-"));
    const file = path.join(home, "config.json");
    fs.writeFileSync(file, JSON.stringify({ providers: { antigravity: { accounts: [{ id: "default", homePath: "~/agy-default" }] } } }));
    const loaded = normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>);
    expect(loaded.providers?.antigravity?.allowUnsupportedUse).toBeUndefined();
    expect(JSON.stringify(normalizeFileConfig(loaded))).not.toContain("allowUnsupportedUse");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses profile env overrides that select a non-host login environment regardless of allowUnsupportedUse", () => {
    for (const allowUnsupportedUse of [false, true]) {
      for (const env of [{ HOME: "/ag/alt-home" }, { home: "/ag/alt-home" }, { USERPROFILE: "C:\\ag\\alt" }, { SSH_CONNECTION: ANTIGRAVITY_FILE_STORAGE_SSH_MARKER }] as Array<Record<string, string>>) {
        const config: AntigravityProviderConfig = {
          ...(allowUnsupportedUse ? { allowUnsupportedUse: true } : {}),
          accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", env }],
        };
        const refused = gated(() => resolveAntigravityAccount(config, "antigravity/alt", baseEnv));
        expect(refusalCode(refused)).toBe("ANTIGRAVITY_ACCOUNT_OFF");
        expect(Object.keys(env).every((key) => refused.message.includes(key))).toBe(true);
      }
    }
    const summary = summarizeProviderAccounts({
      antigravity: { allowUnsupportedUse: true, accounts: [{ id: "default" }, { id: "alt", env: { HOME: "/ag/alt-home" } }] },
    } as unknown as ProvidersConfig);
    expect(summary.find((row) => row.instanceId === "antigravity/alt")?.disabledReason ?? "").toContain("HOME");
  });

  it("refuses --gemini-dir launch args on the account and on the base config regardless of allowUnsupportedUse", () => {
    for (const allowUnsupportedUse of [false, true]) {
      for (const launchArgs of ["--gemini-dir /ag/alt/.gemini", "--gemini-dir=/ag/alt/.gemini", "--verbose --gemini-dir /ag/alt/.gemini"]) {
        const config: AntigravityProviderConfig = {
          ...(allowUnsupportedUse ? { allowUnsupportedUse: true } : {}),
          accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", launchArgs }],
        };
        const refused = gated(() => resolveAntigravityAccount(config, "antigravity/alt", baseEnv));
        expect(refused.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
        expect(refused.message).toContain("--gemini-dir");
      }
      const host = gated(() => resolveAntigravityAccount({ ...(allowUnsupportedUse ? { allowUnsupportedUse: true } : {}), launchArgs: "--gemini-dir /elsewhere/.gemini" }, "antigravity", baseEnv));
      expect(host.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    }
  });

  it("refuses provider-level --gemini-dir launch args a configured account inherits, quoted or not", () => {
    for (const launchArgs of ["--gemini-dir /other/.gemini", '--verbose "--gemini-dir" /other/.gemini', "other --gemini-dir=/other/.gemini"]) {
      const config: AntigravityProviderConfig = { allowUnsupportedUse: true, launchArgs, accounts: [{ id: "default", label: "Default" }] };
      const refused = gated(() => resolveAntigravityAccount(config, "antigravity/default", baseEnv));
      expect(refused.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
      expect(refused.message).toContain("--gemini-dir");
      const summary = summarizeProviderAccounts({ antigravity: config } as unknown as ProvidersConfig);
      expect(summary.find((row) => row.instanceId === "antigravity/default")?.disabledReason ?? "").toContain("--gemini-dir");
    }
  });

  it("counts only a host-login-eligible account as the one that stays: an env-overridden first account does not hold the slot", () => {
    const config: AntigravityProviderConfig = {
      accounts: [{ id: "noisy", label: "Noisy", env: { HOME: "/ag/noisy" } }, { id: "clean", label: "Clean" }],
    };
    expect(gated(() => resolveAntigravityAccount(config, "antigravity/noisy", baseEnv)).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    const clean = resolveAntigravityAccount(config, "antigravity/clean", baseEnv);
    expect(clean.instanceId).toBe("antigravity/clean");
    expect(clean.env).toBe(baseEnv);
  });

  it("checks the gate before the gated home's filesystem: the reason stands even when the configured binary does not exist", async () => {
    const gatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-agy-closed-"));
    const binaryInGatedHome = path.join(gatedHome, "agy");
    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const account = { id: "alt", label: "Alt", homePath: gatedHome, binaryPath: binaryInGatedHome };
      const config: AntigravityProviderConfig = { allowUnsupportedUse: true, accounts: [{ id: "default" }, account] };
      const summary = await antigravityProvider(config, baseEnv, process.cwd(), undefined, { account });
      for (const call of statSpy.mock.calls) {
        expect(String(call[0])).not.toContain(gatedHome);
      }
      expect(summary.instanceId).toBe("antigravity/alt");
      expect(summary.enabled).toBe(false);
      expect(summary.status ?? "").toContain("homePath");
      expect(summary.status).not.toBe("not installed");
      expect(summary.disabledReason ?? "").toContain("homePath");
    } finally {
      statSpy.mockRestore();
      fs.rmSync(gatedHome, { recursive: true, force: true });
    }
  });
});

function refusalCode(refusal: { readonly code: string }): string {
  return refusal.code;
}
