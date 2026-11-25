/**
 * The ACP agents list as a client draws it: each profile's title, command
 * summary, and editable fields. Built in core so CLI, TUI, and Desktop render
 * from one source.
 */
import type { ListFieldView, ListItemView } from "../../configschema.js";
import type { AcpAgentConfig, CliConfig } from "../../types.js";
import { ACP_AGENT_FIELDS } from "./agentschema.js";

function fieldValue(agent: AcpAgentConfig, path: string): string | number | boolean | undefined {
  const value = (agent as unknown as Record<string, unknown>)[path];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function agentView(agent: AcpAgentConfig): ListItemView {
  const fields: ListFieldView[] = ACP_AGENT_FIELDS.map((field) => {
    const value = fieldValue(agent, field.path);
    return {
      path: field.path,
      value,
      explicit: value !== undefined,
    };
  });
  const argPreview = [...(agent.args ?? []), ...(agent.launchArgs ? [agent.launchArgs] : [])].join(" ").trim();
  const cmdSummary = argPreview.length > 0 ? `${agent.command} ${argPreview}` : agent.command;
  return {
    id: agent.id,
    title: agent.name ?? agent.id,
    summary: cmdSummary,
    status: agent.enabled === false ? "Disabled" : null,
    fields,
    resolved: [],
  };
}

export function describeAcpAgents(config: CliConfig): readonly ListItemView[] {
  return (config.providers?.acp?.agents ?? []).map(agentView);
}
