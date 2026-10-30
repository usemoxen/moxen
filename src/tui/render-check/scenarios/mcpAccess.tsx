import { act, useState } from "react";
import { testRender } from "../testrender.js";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { describeSettings } from "./settingsFixture.js";
import { normalizeConfig, setConfigValue } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * A provider's page lists which MCP servers it gets, as a checklist opened
 * from its "MCP servers" row. Rendered from the real schema, so the row, its
 * value and the locked reasons are the server's words.
 */
export async function runMcpAccess(): Promise<void> {
  const initial = normalizeConfig({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "fs-mcp"] },
      fetch: { command: "uvx", args: ["mcp-server-fetch"] },
      github: { command: "npx", args: ["-y", "gh-mcp"], providers: ["claude"] },
      old: { command: "x", disabled: true },
    },
  });
  const written: Array<{ key: string; value: string }> = [];
  // The page redraws from the config the way the server's answer redraws it.
  const Host = () => {
    const [config, setConfig] = useState(initial);
    return (
    <SettingsModal
      snapshot={{ path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(config) }}
      loading={false}
      saving={null}
      error={null}
      onSet={(key, value) => {
        written.push({ key, value });
        setConfig((current) => setConfigValue(current, key as Parameters<typeof setConfigValue>[1], value));
        return Promise.resolve(true);
      }}
      onDuplicate={() => {}}
      run={null}
      onTest={() => {}}
      onTestMcp={() => {}}
      onProbe={() => {}}
      onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
      onExport={() => {}}
      onImport={() => {}}
      notice={null}
      versions={null}
      latest={null}
      updating={new Set()}
      onUpdate={() => {}}
      providers={[]}
      screenWidth={100}
      screenHeight={60}
      left={2}
      top={1}
      width={96}
      height={58}
      onClose={() => {}}
    />
    );
  };
  const setup = await testRender(<Host />, { width: 100, height: 60, exitOnCtrlC: false });
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await setup.flush();
  };
  await settle();

  // Claude Code's page: the MCP servers row says how many it gets.
  const side = setup.captureCharFrame().split("\n");
  const claudeRow = side.findIndex((row) => row.includes("Claude Code") && row.includes("│"));
  await act(async () => setup.mockMouse.click(side[claudeRow]!.indexOf("Claude Code") + 1, claudeRow));
  await settle();
  const page = setup.captureCharFrame();
  console.log("--- claude page ---");
  console.log(page);
  const rows = page.split("\n");
  const row = rows.findIndex((line) => line.includes("MCP servers") && line.includes("│") && line.indexOf("MCP servers") > 20);
  if (row < 0) fail("Claude Code's page has no MCP servers row");
  if (!rows[row]!.includes("All 3 servers") && !rows.slice(row, row + 3).join("\n").includes("All 3 servers")) fail("the MCP servers row does not say every server is on");
  await act(async () => setup.mockMouse.click(rows[row]!.indexOf("MCP servers", 20) + 1, row));
  await settle();
  const list = setup.captureCharFrame();
  console.log("--- claude mcp access ---");
  console.log(list);
  for (const expected of ["☑ filesystem", "☑ fetch", "☑ github", "☐ old", "switched off on its own entry"]) {
    if (!list.includes(expected)) fail(`the checklist is missing "${expected}"`);
  }

  // Switching one off writes the names switched off, nothing else.
  await act(async () => setup.mockInput.pressKey(" "));
  await settle();
  if (written.at(-1)?.key !== "providers.claude.mcpExclude" || written.at(-1)?.value !== "fetch") fail(`toggling wrote ${JSON.stringify(written.at(-1))}`);
  if (!setup.captureCharFrame().includes("☐ fetch")) fail("the checklist did not show the server switched off");
  // The locked server cannot be ticked here.
  for (let step = 0; step < 3; step += 1) await act(async () => setup.mockInput.pressArrow("down"));
  const before = written.length;
  await act(async () => setup.mockInput.pressKey(" "));
  await settle();
  if (written.length !== before) fail("a server limited elsewhere could be toggled here");
  // Back on: the setting is cleared rather than holding an empty list.
  await act(async () => setup.mockInput.pressKey("a"));
  await settle();
  if (written.at(-1)?.value !== "") fail(`"all on" wrote ${JSON.stringify(written.at(-1))}`);

  // Esc closes the checklist and nothing else.
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  await setup.flush();
  if (!setup.captureCharFrame().includes("MCP servers")) fail("esc left the settings page instead of only the checklist");

  // MCP servers is a page of two rows, the servers and the runner; the servers row opens the list, with the servers nested under it.
  const toMcp = setup.captureCharFrame().split("\n");
  const mcpEntry = toMcp.findIndex((row) => row.includes("MCP servers") && row.includes("│") && row.indexOf("MCP servers") < 28);
  await act(async () => setup.mockMouse.click(toMcp[mcpEntry]!.indexOf("MCP servers") + 1, mcpEntry));
  await settle();
  if (!setup.captureCharFrame().includes("Run packages with")) fail("the MCP servers page does not offer the runner");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const servers = setup.captureCharFrame();
  console.log("--- mcp servers ---");
  console.log(servers);
  if (!servers.includes("+ Add server") || servers.includes("Offered to")) fail("MCP servers did not open on the list of servers");
  for (const expected of ["├ fetch", "├ filesystem", "├ github", "└ old"]) {
    if (!servers.split("\n").some((row) => row.includes(expected) && row.indexOf(expected) < 28)) fail(`the sidebar does not nest "${expected}" under MCP servers`);
  }
  // A server opens on its first heading, and the sidebar narrows to the list of servers.
  const nested = servers.split("\n");
  const fsRow = nested.findIndex((row) => row.includes("├ filesystem") && row.indexOf("├ filesystem") < 28);
  await act(async () => setup.mockMouse.click(nested[fsRow]!.indexOf("filesystem") + 1, fsRow));
  await settle();
  const server = setup.captureCharFrame();
  console.log(server);
  if (!server.includes("← MCP servers") || !server.includes("Command")) fail("a server did not open with the sidebar narrowed to the MCP servers");
  // Who gets it, one row per provider, with where that is decided.
  const serverRows = server.split("\n");
  const inForce = serverRows.findIndex((row) => row.includes("In force") && row.indexOf("In force") < 28);
  if (inForce < 0) fail("a server's page has no In force section");
  await act(async () => setup.mockMouse.click(serverRows[inForce]!.indexOf("In force") + 1, inForce));
  await settle();
  const reach = setup.captureCharFrame();
  console.log(reach);
  for (const expected of ["Claude Code", "Gets it", "MCP servers on the OpenCode tab"]) {
    if (!reach.includes(expected)) fail(`a server's page does not say who gets it ("${expected}")`);
  }
  setup.renderer.destroy();
}
