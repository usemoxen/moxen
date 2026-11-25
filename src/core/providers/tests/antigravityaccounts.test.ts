/**
 * Multiple Antigravity accounts behind `providers.antigravity.
 * allowUnsupportedUse` (LOCAL-011): while it is off (the default) Moxen runs
 * at most one Antigravity account — the one that shares the host `agy` login
 * with its environment untouched — and never launches, probes or routes to
 * any account that has an isolated `homePath`, or any account beyond that
 * one. Config is never deleted or rewritten, and the account's folders are
 * never read on this path.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, normalizeFileConfig } from "../../config.js";
import { describeSettings } from "../../configschema.js";
import { FakeAcpTransport } from "../acp/tests/fakes.js";
import { antigravityProvider } from "../antigravity/catalog.js";
import { ANTIGRAVITY_FILE_STORAGE_SSH_MARKER } from "../antigravity/config.js";
import {
  resolveAntigravityAccount,
  summarizeProviderAccounts,
  type ResolvedAntigravityAccount,
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

function catchReason(error: unknown): string {
  return (error as { message?: string }).message ?? "";
}

describe("Antigravity accounts while allowUnsupportedUse is off", () => {
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

    // The legacy host instance ids share the host `agy` login too.
    for (const instanceId of ["antigravity", "agy"]) {
      const host = resolveAntigravityAccount(config, instanceId, baseEnv);
      expect(host.env).toBe(baseEnv);
      expect(host.spec.args).toEqual(["acp"]);
      expect("SSH_CONNECTION" in host.env).toBe(false);
    }
  });

  it("refuses an account with a homePath before launch, naming the setting and how to fix it", () => {
    const config: AntigravityProviderConfig = {
      accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", homePath: "~/agy-alt" }],
    };
    const refusal = gated(() => resolveAntigravityAccount(config, "antigravity/alt", baseEnv));
    expect(refusal.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(refusal.message).toContain(SETTING);
    expect(refusal.message).toContain("homePath");
    expect(refusal.message).toContain("Remove");
    expect(refusal.message).toContain("turn " + SETTING);
  });

  it("disables the only account when even it has a homePath, rather than silently switching to the host login", () => {
    // The owner's real shape: a single `default` account with an isolated home.
    const config: AntigravityProviderConfig = { accounts: [{ id: "default", homePath: "~/agy-default" }] };
    const refusal = gated(() => resolveAntigravityAccount(config, "antigravity/default", baseEnv));
    expect(refusal.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(refusal.message).toContain(SETTING);
    expect(refusal.message).toContain("homePath");
    // The base host instance still runs: only the isolated account is refused.
    const host = resolveAntigravityAccount(config, "antigravity", baseEnv);
    expect(host.env).toBe(baseEnv);
  });

  it("leaves only the first host-login account when several are configured", () => {
    const twoHostLogins: AntigravityProviderConfig = {
      accounts: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
    };
    expect(resolveAntigravityAccount(twoHostLogins, "antigravity/first", baseEnv).env).toBe(baseEnv);
    const refusal = gated(() => resolveAntigravityAccount(twoHostLogins, "antigravity/second", baseEnv));
    expect(refusal.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(refusal.message).toContain(SETTING);

    // An isolated account first does not promote a later one: the first
    // account without a homePath is the one survivor, and it keeps the host env.
    const mixed: AntigravityProviderConfig = {
      accounts: [{ id: "isolated", homePath: "~/agy-a" }, { id: "plain" }, { id: "extra", homePath: "~/agy-b" }],
    };
    expect(gated(() => resolveAntigravityAccount(mixed, "antigravity/isolated", baseEnv)).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    expect(resolveAntigravityAccount(mixed, "antigravity/plain", baseEnv).env).toBe(baseEnv);
    expect(gated(() => resolveAntigravityAccount(mixed, "antigravity/extra", baseEnv)).code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    // A dangling account id (no configured entry) is not a second account: it
    // runs on the host agy login, with no folder and no isolation.
    expect(resolveAntigravityAccount({ accounts: [] }, "antigravity/ghost", baseEnv).env).toBe(baseEnv);
  });

  it("keeps today's per-account isolation environment exactly while the setting is on", () => {
    const altHome = path.resolve(path.join(os.tmpdir(), "moxen-agy-iso"));
    const config: AntigravityProviderConfig = {
      allowUnsupportedUse: true,
      accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", homePath: altHome }],
    };
    let alt: ResolvedAntigravityAccount;
    try {
      alt = resolveAntigravityAccount(config, "antigravity/alt", baseEnv);
    } catch (error) {
      throw new Error(`expected the isolated account to run while on: ${catchReason(error)}`);
    }
    expect(alt.env).toMatchObject({ HOME: altHome, USERPROFILE: altHome, SSH_CONNECTION: ANTIGRAVITY_FILE_STORAGE_SSH_MARKER });
    expect(alt.spec.args).toEqual(["acp", "--gemini-dir", path.join(altHome, ".gemini")]);
    expect(alt.spec.env).toMatchObject({ HOME: altHome, USERPROFILE: altHome, SSH_CONNECTION: ANTIGRAVITY_FILE_STORAGE_SSH_MARKER });
    // An explicit SSH_CONNECTION from the host environment is never overwritten.
    const kept = resolveAntigravityAccount(config, "antigravity/alt", { ...baseEnv, SSH_CONNECTION: "real 1 2 3" });
    expect(kept.env.SSH_CONNECTION).toBe("real 1 2 3");
    // The default account keeps the host environment untouched.
    const host = resolveAntigravityAccount(config, "antigravity/default", baseEnv);
    expect(host.env).toBe(baseEnv);
    expect(host.spec.args).toEqual(["acp"]);
    expect("SSH_CONNECTION" in host.env).toBe(false);
  });

  it("marks the gated accounts in config output with the reason, and other kinds never carry it", () => {
    const providers = {
      claude: { accounts: [{ id: "personal" }] },
      antigravity: {
        accounts: [{ id: "default" }, { id: "alt", homePath: "~/agy-alt" }, { id: "extra" }],
      },
    } as unknown as ProvidersConfig;
    const rows = summarizeProviderAccounts(providers);
    // The user's own toggle is untouched; the gate's reason is what says it is off.
    expect(rows.find((row) => row.instanceId === "antigravity/default")).toMatchObject({ enabled: true, disabledReason: null });
    expect(rows.find((row) => row.instanceId === "antigravity/alt")).toMatchObject({
      enabled: true,
      disabledReason: expect.stringContaining(SETTING) as unknown as string,
    });
    expect(rows.find((row) => row.instanceId === "antigravity/extra")).toMatchObject({
      enabled: true,
      disabledReason: expect.stringContaining(SETTING) as unknown as string,
    });
    const claude = rows.find((row) => row.instanceId === "claude/personal")!;
    expect("disabledReason" in claude).toBe(false);
    // On: no reason anywhere.
    const on = summarizeProviderAccounts({
      ...providers,
      antigravity: { ...providers.antigravity, allowUnsupportedUse: true },
    } as unknown as ProvidersConfig);
    expect(on.filter((row) => row.instanceId.startsWith("antigravity/")).every((row) => row.disabledReason == null)).toBe(true);
  });

  it("lists a gated account in the provider catalog as disabled with the reason and never starts its agent", async () => {
    const transport = new FakeAcpTransport({ authMethods: [{ id: "oauth", name: "Google login" }] });
    const config: AntigravityProviderConfig = {
      accounts: [{ id: "alt", homePath: "~/agy-alt" }],
    };
    const summary = await antigravityProvider(config, baseEnv, process.cwd(), transport, {
      account: { id: "alt", homePath: "~/agy-alt" },
    });
    expect(summary.instanceId).toBe("antigravity/alt");
    expect(summary.enabled).toBe(false);
    expect(summary.models).toEqual([]);
    expect(summary.status).toContain(SETTING);
    expect(transport.sessions).toHaveLength(0);

    const allowed = await antigravityProvider(
      { ...config, allowUnsupportedUse: true },
      baseEnv,
      process.cwd(),
      transport,
      { account: { id: "alt", homePath: "~/agy-alt" } },
    );
    expect(allowed.enabled).toBe(true);
    expect(transport.sessions.length).toBeGreaterThan(0);
  });

  it("defaults the setting to false and never writes it into the config file on its own", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      providers: { antigravity: { accounts: [{ id: "default", homePath: "~/agy-default" }] } },
    });
    // Unset in config, off in the settings table, and absent from what a save writes.
    expect(config.providers?.antigravity?.allowUnsupportedUse).toBeUndefined();
    const view = describeSettings(config).find((setting) => setting.descriptor.key === SETTING);
    expect(view?.descriptor.defaultValue).toBe(false);
    expect(view?.value).toBe(false);
    const written = normalizeFileConfig(config);
    expect(JSON.stringify(written)).not.toContain("allowUnsupportedUse");
    // The file on disk is never rewritten by loading it, gated account or not.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-agy-config-"));
    const file = path.join(home, "config.json");
    fs.writeFileSync(file, JSON.stringify({ providers: { antigravity: { accounts: [{ id: "default", homePath: "~/agy-default" }] } } }));
    const loaded = normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>);
    expect(loaded.providers?.antigravity?.allowUnsupportedUse).toBeUndefined();
    expect(JSON.stringify(normalizeFileConfig(loaded))).not.toContain("allowUnsupportedUse");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses profile env overrides that select a non-host login environment while off, and keeps them once on", () => {
    // A no-homePath profile still moves the login off the host through env:
    // the gate names each refused key and never strips to fall back quietly.
    for (const env of [{ HOME: "/ag/alt-home" }, { home: "/ag/alt-home" }, { USERPROFILE: "C:\\ag\\alt" }, { SSH_CONNECTION: ANTIGRAVITY_FILE_STORAGE_SSH_MARKER }] as Array<Record<string, string>>) {
      const config: AntigravityProviderConfig = { accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", env }] };
      const refused = gated(() => resolveAntigravityAccount(config, "antigravity/alt", baseEnv));
      expect(refused.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
      expect(refused.message).toContain(SETTING);
      expect(Object.keys(env).every((key) => refused.message.includes(key))).toBe(true);
    }
    // The account summary reports the same single reason.
    const summary = summarizeProviderAccounts({
      antigravity: { accounts: [{ id: "default" }, { id: "alt", env: { HOME: "/ag/alt-home" } }] },
    } as unknown as ProvidersConfig);
    expect(summary.find((row) => row.instanceId === "antigravity/alt")?.disabledReason ?? "").toContain("HOME");

    // Once on, the same overrides do today's isolation exactly.
    const on = resolveAntigravityAccount(
      { allowUnsupportedUse: true, accounts: [{ id: "default" }, { id: "alt", env: { HOME: "/ag/alt-home", SSH_CONNECTION: ANTIGRAVITY_FILE_STORAGE_SSH_MARKER } }] },
      "antigravity/alt",
      baseEnv,
    );
    expect(on.env.HOME).toBe("/ag/alt-home");
    expect(on.env.SSH_CONNECTION).toBe(ANTIGRAVITY_FILE_STORAGE_SSH_MARKER);
  });

  it("refuses --gemini-dir launch args while off — on the account and on the base config — and keeps them once on", () => {
    for (const launchArgs of ["--gemini-dir /ag/alt/.gemini", "--gemini-dir=/ag/alt/.gemini", "--verbose --gemini-dir /ag/alt/.gemini"]) {
      const config: AntigravityProviderConfig = { accounts: [{ id: "default", label: "Default" }, { id: "alt", label: "Alt", launchArgs }] };
      const refused = gated(() => resolveAntigravityAccount(config, "antigravity/alt", baseEnv));
      expect(refused.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
      expect(refused.message).toContain(SETTING);
      expect(refused.message).toContain("--gemini-dir");
    }
    // The host login's own launch config answers the same question: an
    // argument that moves the host `agy` login off the host home is refused.
    const host = gated(() => resolveAntigravityAccount({ launchArgs: "--gemini-dir /elsewhere/.gemini" }, "antigravity", baseEnv));
    expect(host.code).toBe("ANTIGRAVITY_ACCOUNT_OFF");
    // Once on, the same launch args do today's work.
    const on = resolveAntigravityAccount(
      { allowUnsupportedUse: true, accounts: [{ id: "default" }, { id: "alt", launchArgs: "--gemini-dir /ag/alt/.gemini" }] },
      "antigravity/alt",
      baseEnv,
    );
    expect(on.spec.args).toContain("--gemini-dir");
    expect(on.spec.args).toContain("/ag/alt/.gemini");
  });

  it("checks the gate before the gated home's filesystem: the reason stands even when the configured binary does not exist", async () => {
    const gatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-agy-closed-"));
    const binaryInGatedHome = path.join(gatedHome, "agy");
    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const account = { id: "alt", label: "Alt", homePath: gatedHome, binaryPath: binaryInGatedHome };
      const config: AntigravityProviderConfig = { accounts: [{ id: "default" }, account] };
      const summary = await antigravityProvider(config, baseEnv, process.cwd(), undefined, { account });
      // Discovery never stats inside the gated home — not even to call the
      // configured binary "not installed": the reason stands on its own.
      for (const call of statSpy.mock.calls) {
        expect(String(call[0])).not.toContain(gatedHome);
      }
      expect(summary.instanceId).toBe("antigravity/alt");
      expect(summary.enabled).toBe(false);
      expect(summary.status ?? "").toContain(SETTING);
      expect(summary.status).not.toBe("not installed");
      expect(summary.disabledReason ?? "").toContain(SETTING);
      // Once on, the same account is discovered again as today.
      const transport = new FakeAcpTransport({ authMethods: [{ id: "oauth", name: "Google login" }] });
      const allowed = await antigravityProvider({ ...config, allowUnsupportedUse: true }, baseEnv, process.cwd(), transport, { account });
      expect(allowed.enabled).toBe(true);
    } finally {
      statSpy.mockRestore();
      fs.rmSync(gatedHome, { recursive: true, force: true });
    }
  });
});
