import path from "node:path";
import type { ClientApi, Command, Query, QueryResult } from "../../server/api.js";
import { client } from "./fixtures.js";

export function skillsClient() {
  const roots = { agents: path.join("user", ".agents", "skills"), claude: path.join("user", ".claude", "skills") };
  let skills: QueryResult<"skills.manage.list">["skills"][number][] = [
    { source: "agents", folder: "diagrams", name: "diagrams", description: "Build readable architecture diagrams with the project's visual conventions.", path: path.join(roots.agents, "diagrams", "SKILL.md"), editable: true, enabled: true },
    { source: "claude", folder: "review", name: "review", description: "Review changes for regressions and safety boundaries.", path: path.join(roots.claude, "review", "SKILL.md.disabled"), editable: true, enabled: false, providers: ["claude", "codex"] },
    { source: "agents", folder: "team-style", name: "team-style", description: "Shared team instructions, linked from another checkout.", path: path.join(roots.agents, "team-style", "SKILL.md"), editable: false, enabled: true },
  ];
  const writes: Command[] = [];
  const text = "---\nname: diagrams\ndescription: Build readable architecture diagrams.\n---\n# Diagrams\n\nRead references/style.md before drawing.\nKeep labels short and show the direction of each connection.\n";
  const api: ClientApi = {
    ...client,
    query: (async (query: Query) => {
      if (query.type === "skills.manage.list") return { skills: query.projectId ? [] : skills, roots };
      if (query.type === "skills.manage.read") return { text };
      if (query.type === "projects.list") return { projects: [{ id: "demo", title: "Demo project", workspaceRoot: path.resolve("demo"), defaultModelSelection: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", deletedAt: null }] };
      return client.query(query);
    }) as ClientApi["query"],
    dispatch: (async (command: Command) => {
      writes.push(command);
      if (command.type === "skills.enabled.set") skills = skills.map((skill) => skill.source === command.source && skill.folder === command.folder ? { ...skill, enabled: command.enabled } : skill);
      if (command.type === "skills.providers.set") skills = skills.map((skill) => skill.source === command.source && skill.folder === command.folder ? { ...skill, providers: command.providers.length > 0 ? command.providers : undefined } : skill) as typeof skills;
      if (command.type === "skills.remove") {
        skills = skills.filter((skill) => skill.source !== command.source || skill.folder !== command.folder);
        return { movedTo: path.join("user", ".agents", "moxen-removed-skills", command.folder) };
      }
      if (command.type === "skills.import") return { source: command.source, folder: "imported" };
      return { accepted: true };
    }) as ClientApi["dispatch"],
  };
  return { api, writes };
}
