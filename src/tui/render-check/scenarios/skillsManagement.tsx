import path from "node:path";
import { act } from "react";
import { SkillsPanel } from "../../features/settings/skillspanel.js";
import { skillsClient } from "../skillsfixture.js";
import { testRender } from "../testrender.js";
import { fail } from "../helpers.js";

export async function runSkillsManagement(): Promise<void> {
  const { api, writes } = skillsClient();
  let closed = false;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<SkillsPanel client={api} width={88} onClose={() => { closed = true; }} />, { width: 90, height: 32, exitOnCtrlC: false, kittyKeyboard: true });
  });
  const settle = async () => { await act(async () => {}); await setup.flush(); };
  const key = async (name: string) => { await act(async () => setup.mockInput.pressKey(name)); await settle(); };
  await settle();
  let frame = setup.captureCharFrame();
  if (!frame.includes("diagrams") || !frame.includes("review") || !frame.includes("team-style")) fail("Skills management lost an origin or a disabled skill.");
  console.log("--- skills management ---"); console.log(frame);
  await key(" ");
  if (!writes.some((command) => command.type === "skills.enabled.set" && command.enabled === false)) fail("Space did not disable the selected skill.");
  await key("e");
  console.log("--- skills edit ---"); console.log(setup.captureCharFrame());
  if (!setup.captureCharFrame().includes("shift+enter")) fail("Editing did not load SKILL.md.");
  await act(async () => setup.mockInput.pressEscape()); await settle();
  if (closed) fail("Escape closed settings instead of cancelling a skill edit.");
  if (setup.captureCharFrame().includes("shift+enter")) fail("Escape did not cancel the skill edit.");
  await key("a");
  console.log("--- skills import ---"); console.log(setup.captureCharFrame());
  const from = path.resolve("incoming-skill");
  for (const char of from) await act(async () => setup.mockInput.pressKey(char));
  await act(async () => setup.mockInput.pressEnter()); await settle();
  if (!writes.some((command) => command.type === "skills.import" && command.from === from && command.source === "agents")) fail("Import did not send the selected folder to the server.");
  await key("d");
  await key("n");
  if (writes.some((command) => command.type === "skills.remove")) fail("Cancelling removal still removed a skill.");
  await key("d"); await key("y");
  if (!writes.some((command) => command.type === "skills.remove" && command.folder === "diagrams")) fail("Confirmed removal did not reach the server.");
  await key("s");
  frame = setup.captureCharFrame();
  const rows = frame.split("\n");
  const row = rows.findIndex((line) => line.includes("Demo project"));
  if (row < 0) fail("The skills scope picker did not list projects.");
  await act(async () => setup.mockMouse.click(rows[row]!.indexOf("Demo project") + 1, row)); await settle();
  if (!setup.captureCharFrame().includes("No skills in this scope")) fail("Project skills were not kept separate from user skills.");
  await act(async () => setup.renderer.destroy());
}
