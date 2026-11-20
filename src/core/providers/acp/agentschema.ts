/**
 * The ACP agent profile list as a settings descriptor (`providers.acp.agents`),
 * mirroring `providers/harness/profileschema.ts`. Each entry becomes an
 * `acp/<id>` provider in the model picker. Validation lives in `acp/config.ts`
 * and runs on every edit through `normalizeConfig`.
 */
import type { ListField, SettingDescriptor } from "../../configschema.js";

export const ACP_AGENT_FIELDS: readonly ListField[] = [
  {
    path: "name",
    label: "Name",
    description: "How this ACP agent is named in the model picker.",
    unset: { text: "its id" },
    group: "Agent",
    kind: { type: "string", placeholder: "Cline" },
  },
  {
    path: "command",
    label: "Executable",
    description: "The ACP agent executable or runner (for example `npx`, `uvx`, or a local binary).",
    group: "Agent",
    kind: { type: "string", placeholder: "npx" },
  },
  {
    path: "launchArgs",
    label: "Launch arguments",
    description: "Arguments passed to the executable (tokenized as argv, never run through a shell).",
    unset: { text: "none" },
    group: "Agent",
    kind: { type: "string", placeholder: "-y @example/agent-acp" },
  },
  {
    path: "defaultModel",
    label: "Default model",
    description: "Optional model identifier to request from this ACP agent when starting a thread.",
    unset: { text: "the agent's own default" },
    group: "Defaults",
    kind: { type: "string", placeholder: "agent default" },
  },
  {
    path: "defaultMode",
    label: "Default mode",
    description: "Optional ACP mode identifier to request when starting a session.",
    unset: { text: "the agent's own default" },
    group: "Defaults",
    kind: { type: "string" },
  },
  {
    path: "enabled",
    label: "Enabled",
    description: "Switch this ACP agent off without removing its profile.",
    unset: { value: true },
    group: "Agent",
    kind: { type: "boolean" },
  },
];

export const ACP_AGENTS_SETTING: SettingDescriptor = {
  key: "providers.acp.agents",
  label: "ACP agents",
  description: "ACP-compatible coding agents (added from the ACP Registry or manually). Each profile appears as its own provider in the model picker.",
  section: "provider:acp",
  group: "ACP agents",
  kind: {
    type: "list",
    noun: "agent",
    lowercaseIds: true,
    add: "acp-agent",
    fields: ACP_AGENT_FIELDS,
    actions: ["duplicate"],
  },
  defaultValue: undefined,
};
