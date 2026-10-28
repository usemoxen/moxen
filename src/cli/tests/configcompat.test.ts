/**
 * `moxen --json config …` on a config file from before the settings were
 * reshaped (MXN-91), through the real CLI entry: the `get`, `set` and `list`
 * envelopes are built in `index.ts`, so only a subprocess sees them. Every
 * older key must still be accepted, and each envelope must keep every field
 * it had (new ones may be added).
 *
 * The CLI gets its own home folder (HOME, and USERPROFILE, which is what
 * Windows reads) and store, so nothing here touches the user's; no key
 * that holds a secret is set. Its config commands go through a server it
 * starts at this file's endpoint (`./setup.ts`), stopped before the folder
 * is removed: Windows will not delete files a live process holds.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CONFIG_KEYS, normalizeConfig, setConfigValue } from "../../core/config.js";
import { readSetting, secretKeyName, SETTINGS } from "../../core/configschema.js";
import { rmTempAsync } from "../../core/testing/tmp.js";
import { stopTestServer } from "./testserver.js";

const CLI = path.resolve("src/cli/index.ts");
// The CLI runs on Bun (TypeScript directly); vitest itself may run on Node.
const BUN = process.versions.bun ? process.execPath : "bun";

const OLD = {
  threadEnvMode: "auto",
  sessionTtl: "2m",
  installSkills: false,
  ui: { autoHandoff: "ask", autoHandoffPercent: 60 },
  providers: {
    claude: { autoCompact: "auto", autoCompactPercent: 75, agentSkills: false, moxenTools: false },
    opencode: { compactBuffer: 16_384, bundledSkills: false },
    harness: { webBrowser: "off", webPrivateNetwork: true, webSearch: "exa", autoCompactTokens: 65_536 },
  },
};

const home = mkdtempSync(path.join(os.tmpdir(), "moxen-configcompat-"));
const file = path.join(home, "config.json");
writeFileSync(file, JSON.stringify(OLD, null, 2));
afterAll(async () => {
  await stopTestServer();
  await rmTempAsync(home);
});
const env = { ...process.env, HOME: home, USERPROFILE: home, MOXEN_STORE_ROOT: path.join(home, "store"), MOXEN_NO_CONFIG_MIGRATION: "1" };

/** Runs the CLI with stdout to a file: a pipe cuts a long envelope (`config list`) at 64 KB. */
function cli(...args: string[]): { ok: boolean; data: Record<string, unknown> } {
  return cliOn(file, ...args);
}

function cliOn(config: string, ...args: string[]): { ok: boolean; data: Record<string, unknown> } {
  const out = path.join(home, "out.json");
  const fd = openSync(out, "w");
  try {
    const run = spawnSync(BUN, [CLI, "--config", config, "--json", ...args], { env, stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  } finally {
    closeSync(fd);
  }
  return JSON.parse(readFileSync(out, "utf8")) as { ok: boolean; data: Record<string, unknown> };
}

/** The older keys a file can hold: every hidden descriptor, plus the ones still shown under their own name. */
const OLDER_KEYS = [
  ...SETTINGS.filter((descriptor) => descriptor.hidden).map((descriptor) => descriptor.key),
  "threadEnvMode",
  "sessionTtl",
  "providers.claude.agentSkills",
  "providers.harness.webSearch",
];

describe("config on an older file", () => {
  it("accepts every older key", () => {
    for (const key of OLDER_KEYS) expect(CONFIG_KEYS, key).toContain(key);
  });

  it("sets every older key to the value it reads, and reads it back the same", () => {
    const config = normalizeConfig(OLD);
    for (const key of OLDER_KEYS) {
      if (secretKeyName(key) !== null) continue;
      const value = readSetting(config, key);
      if (value === undefined || value === "") continue;
      expect(readSetting(setConfigValue(config, key, String(value)), key), key).toEqual(value);
    }
  });

  it("`config get` keeps its fields", () => {
    const got = cli("config", "get", "ui.autoHandoffPercent");
    expect(got).toEqual({ ok: true, data: { key: "ui.autoHandoffPercent", value: 60, explicit: true } });
  });

  it("`config list` keeps its fields, and lists the older keys", () => {
    const listed = cli("config", "list").data as { path: string; exists: boolean; settings: Array<Record<string, unknown>> };
    expect(Object.keys(listed)).toEqual(expect.arrayContaining(["path", "exists", "settings"]));
    for (const setting of listed.settings) {
      expect(Object.keys(setting)).toEqual(expect.arrayContaining(["key", "section", "label", "description", "type", "value", "explicit"]));
    }
    const keys = listed.settings.map((setting) => setting.key);
    expect(keys).toEqual(expect.arrayContaining(["ui.autoHandoff", "providers.claude.autoCompact", "providers.opencode.compactBuffer"]));
  });

  it("`config set` on an older key keeps its fields, and leaves every other older key in the file", () => {
    const set = cli("config", "set", "providers.claude.autoCompactPercent", "80");
    expect(Object.keys(set.data)).toEqual(expect.arrayContaining(["path", "config"]));
    const saved = JSON.parse(readFileSync(file, "utf8")) as typeof OLD & { providers: { claude: Record<string, unknown> } };
    expect(saved.providers.claude.autoCompactPercent).toBe(80);
    expect(saved.ui).toEqual(OLD.ui);
    expect(saved.sessionTtl).toBe("2m");
    expect(saved.installSkills).toBe(false);
    expect(saved.providers.opencode).toMatchObject(OLD.providers.opencode);
    expect(saved.providers.harness).toMatchObject(OLD.providers.harness);
  });

  it("`--config ~/…` names the file in the home folder, as the server already running on it sees it", () => {
    // Not expanded by the shell here (as on Windows): the CLI expands it.
    for (const tilde of ["~/config.json", `~${path.sep}config.json`]) {
      expect(cliOn(tilde, "config", "path").data).toEqual({ path: file });
    }
  });
});
