/**
 * The harness profile list as a settings descriptor: which fields a profile
 * and its models have, how each is labelled and grouped. Only shapes live
 * here. What a value may be (ranges, URL form, the no-keys rule) is
 * `profiles.ts`, and `normalizeConfig` runs every edit through it.
 */
import type { ListField, SettingChoice, SettingDescriptor } from "../../configschema.js";
import { POSITIVE_PROFILE_INT_MIN, PROFILE_NUMBER_BOUNDS } from "./profiles.js";
import { QUIRK_FAMILIES } from "./quirks.js";

const choice = (value: string, label: string, description?: string): SettingChoice =>
  description === undefined ? { value, label } : { value, label, description };

const FAMILY_CHOICES: readonly SettingChoice[] = QUIRK_FAMILIES.map((family) =>
  family === "generic" ? choice(family, "Generic", "No known quirks beyond the safe defaults.") : choice(family, family),
);

const MODEL_FIELDS: readonly ListField[] = [
  {
    path: "contextWindow",
    label: "Context window",
    description: "Tokens the model can hold. Automatic compaction and the context meter need it.",
    unset: { text: "the server's, from a probe" },
    group: "Model",
    kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [8_192, 16_384, 32_768, 65_536, 98_304, 131_072, 196_608, 262_144, 524_288, 1_048_576] },
  },
  {
    path: "maxOutput",
    label: "Longest reply",
    description: "Most tokens one reply may run to.",
    unset: { text: "the server's" },
    group: "Model",
    kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [2_048, 4_096, 8_192, 12_288, 16_384, 24_576, 32_768, 65_536] },
  },
  {
    path: "vision",
    label: "Takes images",
    description: "Whether to send this model images, or a short note in their place. Set, this alone decides it.",
    unset: { text: "what a probe saw, else the family (every Claude model takes them), else not" },
    group: "Model",
    kind: { type: "boolean" },
  },
  {
    path: "family",
    label: "Model family",
    description: "Which model line this is, so Moxen starts from what is known about how it wants its prompts shaped (the 'Template quirks' further down). Set it when the model's name does not say, such as a fine-tune called `my-coder`. Generic is safe for anything.",
    group: "Model",
    kind: { type: "enum", choices: FAMILY_CHOICES },
  },
  {
    path: "efforts",
    label: "Reasoning efforts",
    description: "Levels the model picker offers, comma-separated (low, medium, high). A chat server gets the pick only if its family has an effort setting (Qwen does).",
    unset: { text: "none" },
    group: "Model",
    kind: { type: "words", separator: "comma" },
  },
];

/** The API formats a quirk is read for (unset `apiFormat` is Chat Completions); a quirk no format in force reads is not offered. */
const CHAT_ONLY = { path: "apiFormat", in: ["", "chat"] } as const;
const QUIRK_FORMATS: Readonly<Record<string, ListField["visibleWhen"]>> = {
  systemFirstOnly: CHAT_ONLY,
  mergeAdjacentRoles: CHAT_ONLY,
  assistantAfterToolResult: CHAT_ONLY,
  toolResultsAsUser: CHAT_ONLY,
  toolResultName: CHAT_ONLY,
  systemRole: CHAT_ONLY,
  emptyAssistantContent: CHAT_ONLY,
  reasoningField: CHAT_ONLY,
  cacheControl: { path: "apiFormat", in: ["anthropic"] },
  anthropicThinking: { path: "apiFormat", in: ["anthropic"] },
  sendReasoning: { path: "apiFormat", in: ["responses"] },
};

/** The quirk's field with its format gate, when it has one. */
const gated = (field: ListField): ListField => {
  const when = QUIRK_FORMATS[field.path.replace(/^quirks\./, "")];
  return when === undefined ? field : { ...field, visibleWhen: when };
};

/** Said once, under the group's heading, rather than after every quirk. */
const QUIRKS_GROUP = "Most servers need none of these: pick a Model family and leave the rest on Default. A quirk set here beats both the family and a probe; Default goes back to those. Each model's In force section lists what applies and why.";

const QUIRK_BOOLEANS: ReadonlyArray<readonly [string, string, string]> = [
  ["systemFirstOnly", "System message only first", "On: later reminders are sent as user messages. Off: sent as system messages."],
  ["mergeAdjacentRoles", "Merge same-side messages", "On: consecutive messages from the same role are joined (for templates that need strict alternation)."],
  ["assistantAfterToolResult", "Assistant between tool result and user", "On: a short assistant message is inserted after a tool result when the user speaks next."],
  ["toolResultsAsUser", "Tool results as user messages", "On: results go back as user messages in <tool_response> (the template has no tool role)."],
  ["toolResultName", "Name on tool results", "On: each tool result message also carries the tool's name."],
  ["omitToolChoice", "Leave out tool_choice", "On: never send `tool_choice` (the server rejects it). Compaction then relies on its instruction alone."],
  ["parallelToolCalls", "Parallel tool calls", "Off: ask the server for one tool call at a time."],
  ["cacheControl", "Prompt caching (Anthropic)", "On: ask Anthropic's API to cache the conversation prefix. Off for a proxy that rejects the field."],
  ["sendReasoning", "Send reasoning settings (Responses)", "On: send the `reasoning` field (effort, summaries, encrypted reasoning for replay). Off for a model that is not a reasoning model."],
];

const QUIRK_FIELDS: readonly ListField[] = ([
  ...QUIRK_BOOLEANS.map(([name, label, description], at): ListField => ({
    ...(at === 0 ? { groupDescription: QUIRKS_GROUP } : {}),
    path: `quirks.${name}`,
    label,
    description,
    group: "Template quirks",
    kind: { type: "boolean" },
  })),
  {
    path: "quirks.systemRole",
    label: "Role of the first prompt",
    description: "What the leading prompt is sent as. Beats the preset and the probe.",
    group: "Template quirks",
    kind: {
      type: "enum",
      choices: [
        choice("system", "system", "The usual: a system message."),
        choice("developer", "developer", "OpenAI's newer name for it, which some reasoning models require."),
        choice("user", "user", "For a template that has no system role: the prompt goes in as the first user message."),
      ],
    },
  },
  {
    path: "quirks.emptyAssistantContent",
    label: "Content of a tool-call-only reply",
    description: "When the model answers with only a tool call and no words, what to put in the text part of that message when it is sent back. Leave it unless the server errors on empty content.",
    group: "Template quirks",
    kind: {
      type: "enum",
      choices: [
        choice("empty", "Empty", "Send no text. What most servers expect."),
        choice("dot", "A dot (.)", "Send a single dot, for a server that rejects an empty message."),
      ],
    },
  },
  {
    path: "quirks.reasoningReplay",
    label: "Send earlier reasoning back",
    description: "Whether the model's earlier thinking is shown to it again on later turns, and how. Some models reason better when they see it, and it keeps the server's prompt cache valid; others get confused or the server refuses the extra field. Not at all also drops a template flag that asks to render it (Qwen's preserve_thinking).",
    group: "Template quirks",
    kind: {
      type: "enum",
      choices: [
        choice("field", "In its field", "Sent in the field below, as the server returned it."),
        choice("text", "As text", "Pasted into the message inside <thinking> tags, for servers with no such field."),
        choice("none", "Not at all", "Dropped: the model only sees its earlier answers."),
      ],
    },
  },
  {
    path: "quirks.reasoningField",
    label: "Reasoning field",
    description: "Which field carries reasoning in the server's replies and in what is sent back.",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("reasoning_content", "reasoning_content"), choice("reasoning", "reasoning"), choice("reasoning_text", "reasoning_text")] },
  },
  {
    path: "quirks.anthropicThinking",
    label: "Thinking (Anthropic)",
    description: "How thinking is turned on for an Anthropic server. Pick by model age: newer Claude models decide for themselves, older ones need a number of tokens set aside.",
    group: "Template quirks",
    kind: {
      type: "enum",
      choices: [
        choice("adaptive", "Adaptive", "The model decides how much to think. Claude 4.6 and newer."),
        choice("budget", "Token budget", "A fixed number of tokens set aside for thinking. Older Claude models."),
        choice("off", "Off", "Never ask for thinking."),
      ],
    },
  },
  {
    path: "quirks.images",
    label: "Image parts",
    description: "Kept so older profiles still load: how images were passed before 'Takes images' on each model decided it. Read only for a model whose 'Takes images' is unset.",
    group: "Template quirks",
    hidden: true,
    kind: {
      type: "enum",
      choices: [
        choice("native", "Native", "Sent as a real image, for a model that can see."),
        choice("none", "Text note instead", "Replaced by a short note saying an image was here, for a model or server that cannot take one."),
      ],
    },
  },
] as ListField[]).map(gated);

export const HARNESS_PROFILE_FIELDS: readonly ListField[] = [
  { path: "label", label: "Name", description: "How the profile is called in the model picker. Defaults to its id.", group: "Endpoint", kind: { type: "string" } },
  {
    path: "apiFormat",
    label: "API format",
    description: "Which API the server speaks. If you are not sure, it is Chat Completions: that is what a local server (llama.cpp, vLLM, Ollama) offers.",
    unset: { value: "chat" },
    group: "Endpoint",
    kind: { type: "enum", choices: [
        choice("chat", "Chat Completions", "The common one: llama.cpp, vLLM, Ollama, LM Studio, OpenRouter and most others."),
        choice("responses", "OpenAI Responses", "OpenAI's newer API; also what some gateways in front of OpenAI models offer."),
        choice("anthropic", "Anthropic Messages", "Anthropic's own API, or a proxy that speaks it."),
      ],
    },
  },
  {
    path: "baseUrl",
    label: "Base URL",
    description: "The server's address, such as http://localhost:8080. Type it with or without /v1: Moxen adds /v1 when it is missing, for every API format. If the server sits under another path (like /openai/v1), give the whole path ending in /v1. No username or password in it.",
    group: "Endpoint",
    kind: { type: "string", placeholder: "http://localhost:8080" },
  },
  {
    path: "apiKey",
    label: "API key",
    description: "Typed once and kept in the OS keychain (macOS Keychain, Windows Credential Manager); it never appears in the config file or on screen. A server that takes none needs nothing here.",
    group: "Endpoint",
    kind: { type: "secret" },
  },
  {
    path: "apiKeyEnv",
    label: "API key variable",
    description: "Instead of saving a key: the NAME of an environment variable that holds it, as the Moxen server sees it. A key saved in the keychain wins over this variable; Moxen's own MOXEN_* variables are the other way round and beat the config file.",
    group: "Endpoint",
    kind: { type: "string", placeholder: "MY_API_KEY" },
  },
  {
    path: "slots",
    label: "Requests at once",
    description: "Requests this server runs at the same time (llama.cpp `-np`). With 1, Moxen's own subagents wait their turn instead of starving you.",
    unset: { text: "the Moxen Harness's own Requests at once" },
    group: "Endpoint",
    kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [1, 2, 3, 4, 6, 8, 12, 16], ends: { low: "Fewer", high: "More" } },
  },
  {
    path: "models",
    label: "Models",
    description: "The models this endpoint serves. Any other model name can still be sent.",
    group: "Models",
    kind: { type: "list", noun: "model", fields: MODEL_FIELDS },
  },
  { path: "sampling.temperature", label: "Temperature", description: "Sampling temperature, 0 to 5.", unset: { text: "the server's" }, group: "Sampling", kind: { type: "number", ...PROFILE_NUMBER_BOUNDS.temperature, presets: [0, 0.1, 0.2, 0.4, 0.6, 0.7, 0.8, 1, 1.2], ends: { low: "Focused", high: "Creative" } } },
  { path: "sampling.topP", label: "Top P", description: "Nucleus sampling, 0 to 1.", unset: { text: "the server's" }, group: "Sampling", kind: { type: "number", ...PROFILE_NUMBER_BOUNDS.topP, presets: [0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 1], ends: { low: "Narrower", high: "Wider" } } },
  { path: "sampling.topK", label: "Top K", description: "Sampling pool size.", unset: { text: "the server's" }, group: "Sampling", kind: { type: "integer", ...PROFILE_NUMBER_BOUNDS.topK, presets: [10, 20, 30, 40, 50, 64, 100], ends: { low: "Narrower", high: "Wider" } } },
  { path: "sampling.minP", label: "Min P", description: "Smallest probability a token may have, 0 to 1.", unset: { text: "the server's" }, group: "Sampling", kind: { type: "number", ...PROFILE_NUMBER_BOUNDS.minP, presets: [0, 0.01, 0.02, 0.05, 0.08, 0.1, 0.2], ends: { low: "Looser", high: "Stricter" } } },
  {
    path: "preserveThinking",
    label: "Keep reasoning in history",
    description: "Kept so older profiles still load: off reads as 'Send earlier reasoning back' Not at all, while that is unset.",
    group: "Template quirks",
    hidden: true,
    kind: { type: "boolean" },
  },
  {
    path: "compaction.auto",
    label: "Compact automatically",
    description: "Overrides the Moxen Harness's 'Compaction' for this profile.",
    group: "Compaction",
    kind: { type: "boolean" },
  },
  {
    path: "compaction.fraction",
    label: "Compact at (share of window)",
    description: "Kept so older profiles still load: 0.3 to 0.95 of the window. 'Compact at' in tokens wins when it is set.",
    group: "Compaction",
    hidden: true,
    kind: { type: "number", ...PROFILE_NUMBER_BOUNDS.fraction, presets: [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9] },
  },
  {
    path: "compaction.tokens",
    label: "Compact at",
    description: "Tokens of context at which this profile compacts. Overrides the Moxen Harness's and the global 'Compact at', whatever their unit. Needs a context window on the model.",
    group: "Compaction",
    kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [8_192, 16_384, 24_576, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576], ends: { low: "Earlier", high: "Later" } },
  },
  {
    path: "compaction.keepRecentTokens",
    label: "Kept word for word",
    description: "How much of the newest conversation stays unsummarised. Overrides the Moxen Harness setting.",
    group: "Compaction",
    kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [4_096, 8_192, 12_288, 16_384, 24_576, 32_768, 49_152, 65_536], ends: { low: "Less", high: "More" } },
  },
  {
    path: "compaction.effort",
    label: "Summary effort",
    description: "Reasoning effort for the summary request, picked from the efforts this profile's models list (Models → Reasoning efforts).",
    unset: { value: "low" },
    group: "Compaction",
    kind: { type: "effort" },
  },
  {
    path: "titles",
    label: "Name threads",
    description: "Ask this model for a short title after its first answer. Turn it off for a reasoning model that spends the title's small budget thinking.",
    unset: { value: true },
    group: "Behaviour",
    kind: { type: "boolean" },
  },
  { path: "loopGuard.calls", label: "Catch repeated tool calls", description: "Warn, then end the turn, when the model makes the same tool call (or the same few calls in turn) again and again.", unset: { value: true }, group: "Behaviour", kind: { type: "boolean" } },
  { path: "loopGuard.repeatWarn", label: "Warn after identical calls", description: "The same tool call, getting the same answer, this many times in one turn gets a warning. A call that answers differently each time (a test run, a re-read after an edit) is progress and is not counted.", unset: { value: 4 }, group: "Behaviour", visibleWhen: { path: "loopGuard.calls", in: ["", "true"] }, kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [2, 3, 4, 5, 6, 8, 10], ends: { low: "Sooner", high: "Later" } } },
  { path: "loopGuard.repeatStop", label: "Stop after identical calls", description: "…and this many ends the turn. It is never earlier than the warning.", unset: { value: 6 }, group: "Behaviour", visibleWhen: { path: "loopGuard.calls", in: ["", "true"] }, kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [4, 5, 6, 8, 10, 12, 16], ends: { low: "Sooner", high: "Later" } } },
  { path: "loopGuard.text", label: "Catch repeated text", description: "Cut a reply off when it, or its reasoning, repeats one stretch of text over and over. Turn it off if it ends replies that were fine.", unset: { value: true }, group: "Behaviour", kind: { type: "boolean" } },
  { path: "loopGuard.textRepeats", label: "Stop repeated text after", description: "A reply repeating one stretch of text this many times is cut off.", unset: { value: 10 }, group: "Behaviour", visibleWhen: { path: "loopGuard.text", in: ["", "true"] }, kind: { type: "integer", min: POSITIVE_PROFILE_INT_MIN, presets: [4, 6, 8, 10, 15, 20, 30], ends: { low: "Sooner", high: "Later" } } },
  {
    path: "systemPromptAppend",
    label: "Profile instructions",
    description: "Added to the system prompt of threads on this profile, after Moxen's own, the global 'Extra instructions' (every provider) and the Moxen Harness's 'Provider instructions'. The two stack.",
    group: "Prompt",
    kind: { type: "string", multiline: true },
  },
  ...QUIRK_FIELDS,
];

export const HARNESS_PROFILES_SETTING: SettingDescriptor = {
  key: "providers.harness.profiles",
  label: "Profiles",
  description: "The endpoints the Moxen Harness talks to. Each is a server address, the models on it, and anything its chat template needs.",
  section: "provider:harness",
  group: "Model servers",
  kind: { type: "list", noun: "profile", lowercaseIds: true, add: "harness-profile", fields: HARNESS_PROFILE_FIELDS, actions: ["duplicate", "test", "probe", "transfer"] },
  defaultValue: undefined,
};
