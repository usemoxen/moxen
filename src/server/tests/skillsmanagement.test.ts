import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { testHarness } from "../../core/testing/harness.js";
import { DirectConnection } from "../connection.js";

it("keeps skill edits in the selected registered project and refuses a forged source or folder", async () => {
  const harness = await testHarness();
  const connection = new DirectConnection({ storeRoot: harness.root, config: async () => harness.config, drivers: harness.drivers, builtinMcpServers: null });
  try {
    const { projectId } = await connection.dispatch({ type: "project.create", workspaceRoot: harness.work });
    const from = path.join(harness.root, "incoming");
    await mkdir(from);
    const text = "---\nname: diagrams\ndescription: Draw diagrams.\n---\nDraw clearly.\n";
    await writeFile(path.join(from, "SKILL.md"), text);
    const address = await connection.dispatch({ type: "skills.import", projectId, source: "agents", from });
    const inventory = await connection.query({ type: "skills.manage.list", projectId });
    expect(inventory.skills).toMatchObject([{ folder: "diagrams", source: "agents", enabled: true }]);
    const file = path.join(harness.work, ".agents", "skills", "diagrams", "SKILL.md");
    expect(inventory.skills[0]?.path).toBe(file);
    await connection.dispatch({ type: "skills.providers.set", projectId, ...address, providers: ["harness"] });
    expect((await connection.query({ type: "skills.manage.list", projectId })).skills[0]?.providers).toEqual(["harness"]);
    await expect(connection.dispatch({ type: "skills.providers.set", projectId, ...address, providers: ["wrong" as "harness"] })).rejects.toThrow("providers must be a list");
    await expect(connection.dispatch({ type: "skills.providers.set", projectId, ...address } as never)).rejects.toThrow("requires providers");
    await connection.dispatch({ type: "skills.save", projectId, ...address, previous: text, text: text.replace("Draw clearly.", "Read the guide.") });
    expect(await readFile(file, "utf8")).toContain("Read the guide.");
    await writeFile(file, "");
    await connection.dispatch({ type: "skills.save", projectId, ...address, previous: "", text });
    expect(await readFile(file, "utf8")).toBe(text);
    await expect(connection.query({ type: "skills.manage.list", projectId: "missing" })).rejects.toThrow("existing project");
    await expect(connection.dispatch({ type: "skills.enabled.set", projectId, source: "agents", folder: "../escape", enabled: false })).rejects.toThrow("folder name");
    await expect(connection.dispatch({ type: "skills.enabled.set", projectId, source: "outside" as "agents", folder: "diagrams", enabled: false })).rejects.toThrow();
  } finally { await connection.close(); }
});
