import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acpProviders } from "../catalog.js";
import {
  acpRegistryPlatformKeys,
  loadAcpRegistryCatalog,
  parseAcpRegistry,
  resolveRegistryLaunchSpec,
} from "../registry.js";
import { FakeAcpTransport } from "./fakes.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const SAMPLE_REGISTRY = {
  agents: [
    {
      id: "cline",
      name: "Cline",
      version: "1.2.0",
      description: "Autonomous coding agent",
      distribution: {
        npx: { package: "@cline/acp", args: ["--stdio"] },
      },
    },
    {
      id: "pyagent",
      name: "PyAgent",
      version: "0.4.0",
      description: "Python ACP agent",
      distribution: {
        uvx: { package: "pyagent-acp" },
      },
    },
    {
      id: "native-bin",
      name: "NativeBin",
      version: "2.0.0",
      description: "Compiled ACP agent",
      distribution: {
        binary: {
          targets: {
            "darwin-aarch64": { url: "https://example.test/mac.tar.gz", cmd: "native-bin", args: ["acp"], sha256: "abc" },
            "windows-x86_64": { url: "https://example.test/win.zip", cmd: "native-bin.exe", args: ["acp"], sha256: "def" },
          },
        },
      },
    },
  ],
};

describe("ACP Registry parsing & platform launch resolution", () => {
  it("parses registry manifests and resolves safe argv specs for npx, uvx, and binaries", () => {
    const agents = parseAcpRegistry(SAMPLE_REGISTRY);
    expect(agents.map((a) => a.id)).toEqual(["cline", "pyagent", "native-bin"]);

    const npxSpec = resolveRegistryLaunchSpec(agents[0]!, {
      hasCommand: (cmd) => cmd === "npx",
    });
    expect(npxSpec).toEqual({
      ok: true,
      runtime: "npx",
      spec: { id: "cline", name: "Cline", command: "npx", args: ["-y", "@cline/acp", "--stdio"] },
    });

    const missingUvx = resolveRegistryLaunchSpec(agents[1]!, {
      hasCommand: () => false,
    });
    expect(missingUvx).toMatchObject({ ok: false, reason: "missing-runtime", runtime: "uvx" });

    const macBinInstalled = resolveRegistryLaunchSpec(agents[2]!, {
      platform: "darwin",
      arch: "arm64",
      hasCommand: (cmd) => cmd === "native-bin",
    });
    expect(macBinInstalled).toEqual({
      ok: true,
      runtime: "binary",
      spec: { id: "native-bin", name: "NativeBin", command: "native-bin", args: ["acp"] },
    });

    const winBinUninstalled = resolveRegistryLaunchSpec(agents[2]!, {
      platform: "win32",
      arch: "x64",
      hasCommand: () => false,
    });
    expect(winBinUninstalled).toMatchObject({ ok: false, reason: "uninstalled-binary" });

    const unsupportedPlatform = resolveRegistryLaunchSpec(agents[2]!, {
      platform: "linux",
      arch: "x64",
      hasCommand: () => false,
    });
    expect(unsupportedPlatform).toMatchObject({ ok: false, reason: "unsupported-platform" });
    expect(acpRegistryPlatformKeys("darwin", "arm64")).toContain("darwin-aarch64");
    expect(acpRegistryPlatformKeys("win32", "x64")).toContain("windows-x86_64");
  });

  it("caches fetched registry to disk and falls back to cache when offline", async () => {
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), "moxen-acp-reg-"));
    tempDirs.push(storeRoot);

    const net = await loadAcpRegistryCatalog({
      storeRoot,
      fetch: (async () =>
        new Response(JSON.stringify(SAMPLE_REGISTRY), { status: 200 })) as unknown as typeof fetch,
    });
    expect(net.source).toBe("network");
    expect(net.agents).toHaveLength(3);

    const offline = await loadAcpRegistryCatalog({
      storeRoot,
      forceRefresh: true,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(offline.source).toBe("cache");
    expect(offline.agents.map((a) => a.id)).toEqual(["cline", "pyagent", "native-bin"]);
  });

  it("merges registry agents into acpProviders while keeping user overrides authoritative", async () => {
    const registry = parseAcpRegistry(SAMPLE_REGISTRY);
    const transport = new FakeAcpTransport();
    const list = await acpProviders(
      {
        agents: [
          { id: "agy", command: "agy", enabled: false },
          { id: "cline", name: "Custom Cline", command: "/custom/cline", args: ["acp"] },
        ],
      },
      process.env,
      process.cwd(),
      transport,
      registry,
    );
    expect(list.map((p) => p.instanceId)).toEqual(["acp/cline", "acp/pyagent", "acp/native-bin"]);
    // User override for cline wins over registry entry.
    expect(list[0]!.enabled).toBe(true);
    // Registry entries are surfaced without spawning package downloads during catalog listing.
    expect(transport.sessions).toHaveLength(1);
  });
});
