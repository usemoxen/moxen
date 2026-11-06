/**
 * `moxen harness probe`: a fixed battery of tiny requests that finds out what a
 * server's chat template accepts, and `testProfile`, the single request behind
 * the editor's "test" action.
 *
 * Two rules shape it. First, a check only counts what the server *said*: a
 * template that refuses a message shape answers 4xx (or a 5xx naming the
 * template), while a timeout, a refused connection or a busy server (429/503)
 * says nothing about the template, so that check is "inconclusive" and writes
 * nothing. A probe run against a single-slot server that is busy therefore
 * cannot invent a quirk. Second, the requests are serial and tiny, each one
 * starting from a throwaway system prefix (a fresh nonce) so none of them
 * extends or matches anyone's cached conversation. On a one-slot server a
 * request still takes the slot, which replaces what it had cached; the probe
 * cannot avoid that, so it refuses to start while a slot reports itself busy
 * (`/slots`, where the server offers it) and says so in its notes.
 *
 * The findings are written to the model's `probed` block, never into the
 * profile's `quirks`, so a hand-made override and a measurement stay apart.
 * Nothing in this file reads, returns or logs the API key beyond sending it as
 * the bearer token.
 */
import { createHash, randomBytes } from "node:crypto";

import type { HarnessModelConfig, HarnessProbedConfig, HarnessProfileConfig } from "../../types.js";
import { readProfileApiKey, resolveProfileQuirks } from "./profiles.js";
import { parseQuirkOverrides, type ModelQuirks, type ReasoningField } from "./quirks.js";
import { ChatHttpError, type ChatRequest } from "./transport/chat.js";
import { streamModel } from "./transport/model.js";
import type { WireMessage } from "./normalize.js";
import type { ToolCall, ToolDefinition, TranscriptMessage } from "./types.js";

export type ProbeOutcome = "pass" | "fail" | "inconclusive" | "skipped";

export type ProbeCheckId =
  | "chat"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "empty-content"
  | "user-after-tool"
  | "system-after-first"
  | "consecutive-roles"
  | "image"
  | "server";

export interface ProbeCheck {
  readonly id: ProbeCheckId;
  readonly title: string;
  readonly outcome: ProbeOutcome;
  /** What was found and why it matters, in plain words. */
  readonly finding: string;
}

export interface ProbeServerFacts {
  contextWindow?: number;
  slots?: number;
  templateHash?: string;
  /** `/tokenize` answered, so exact token counts are available. */
  tokenize?: boolean;
  /** What the server says about image input, when it says. */
  vision?: boolean;
}

export interface ProbeReport {
  readonly profileId: string;
  readonly model: string;
  readonly at: string;
  readonly checks: readonly ProbeCheck[];
  /** The quirks the checks settled; the keys a check could not settle are absent. */
  readonly quirks: Partial<ModelQuirks>;
  readonly server: ProbeServerFacts;
  /** Things worth knowing that are not a check: a conflict with an override, a single-slot warning. */
  readonly notes: readonly string[];
  /** Why the battery stopped early, or null when it ran to the end. */
  readonly stopped: string | null;
}

export interface ProbeContext {
  readonly profile: HarnessProfileConfig;
  readonly model: HarnessModelConfig;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
  /** Per-request limit; a server that takes longer is treated as unreachable. */
  readonly requestTimeoutMs?: number | undefined;
}

// -- requests -----------------------------------------------------------------

/** What a failed request means for the battery. */
type Failure = {
  /** auth: credentials refused. missing: no such endpoint or model. rejected: the body or template was refused. busy: try later. down: unreachable. */
  readonly kind: "auth" | "missing" | "rejected" | "busy" | "down";
  readonly status: number | null;
  readonly detail: string;
};

/** A 5xx that is really the template or the input being refused (llama.cpp reports some of these as 500). */
const REFUSAL_HINT = /jinja|template|raise_exception|conversation roles|alternat|system message|image|mmproj|multimodal|vision|tool_choice|unsupported|not supported/i;

function classify(error: unknown): Failure {
  if (error instanceof ChatHttpError) {
    const detail = error.message.replace(/^The model endpoint answered \d+:?\s*/, "").trim().slice(0, 240);
    const status = error.status;
    if (status === 401 || status === 403) return { kind: "auth", status, detail };
    if (status === 404) return { kind: "missing", status, detail };
    if (status === 408 || status === 429 || status === 503) return { kind: "busy", status, detail };
    if (status === null) return error.retryable ? { kind: "down", status, detail } : { kind: "rejected", status, detail };
    if (status >= 500) return REFUSAL_HINT.test(detail) ? { kind: "rejected", status, detail } : { kind: "busy", status, detail };
    return { kind: "rejected", status, detail };
  }
  return { kind: "down", status: null, detail: (error as Error)?.message ?? String(error) };
}

interface Reply {
  readonly text: string;
  readonly reasoning: string;
  readonly calls: readonly ToolCall[];
  readonly finish: string;
}

type Attempt = { readonly ok: true; readonly reply: Reply } | { readonly ok: false; readonly failure: Failure };

const ECHO_TOOL: ToolDefinition = {
  name: "echo",
  description: "Returns the text it is given.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** Quotes, a newline and backslashes: the escapes a template's argument rendering most often mangles. */
const AWKWARD_TEXT = 'She said "hi",\nthen left C:\\temp\\x.';

/** A 1x1 PNG, the smallest valid image there is. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class Probe {
  readonly checks: ProbeCheck[] = [];
  readonly quirks: Record<string, unknown> = {};
  readonly server: ProbeServerFacts = {};
  readonly notes: string[] = [];
  stopped: string | null = null;
  readonly nonce = randomBytes(6).toString("hex");
  readonly #bodyQuirks: ModelQuirks;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(readonly context: ProbeContext) {
    // The body-shaping quirks only (template kwargs, parallel calls); what is being measured is sent raw below.
    this.#bodyQuirks = { ...resolveProfileQuirks(context.profile, context.model, { ignoreProbed: true }), omitToolChoice: false };
    this.#apiKey = readProfileApiKey(context.profile, context.env ?? process.env);
    this.#fetch = context.fetch ?? fetch;
  }

  get halted(): boolean {
    return this.stopped !== null;
  }

  add(id: ProbeCheckId, title: string, outcome: ProbeOutcome, finding: string, quirks: Partial<ModelQuirks> = {}): void {
    this.checks.push({ id, title, outcome, finding });
    Object.assign(this.quirks, quirks);
  }

  skip(id: ProbeCheckId, title: string, why: string): void {
    this.add(id, title, "skipped", why);
  }

  /** The system prompt every request starts with: a nonce first, so no request shares a prefix with a real conversation. */
  system(extra = "You are a test harness endpoint check. Keep answers to a few words."): WireMessage {
    return { role: "system", content: `[probe ${this.nonce}] ${extra}` };
  }

  signal(): AbortSignal {
    const limit = AbortSignal.timeout(this.context.requestTimeoutMs ?? 60_000);
    return this.context.signal ? AbortSignal.any([this.context.signal, limit]) : limit;
  }

  async send(messages: readonly WireMessage[], options: { tools?: readonly ToolDefinition[]; maxTokens?: number; omitToolChoice?: boolean; onDelta?: ChatRequest["onDelta"] } = {}): Promise<Attempt> {
    const quirks = options.omitToolChoice === false ? this.#bodyQuirks : { ...this.#bodyQuirks, omitToolChoice: true };
    let text = "";
    let reasoning = "";
    const calls: ToolCall[] = [];
    let finish = "stop";
    try {
      const format = this.context.profile.apiFormat;
      for await (const event of streamModel({
        baseUrl: this.context.profile.baseUrl,
        apiKey: this.#apiKey,
        model: this.context.model.id,
        messages,
        ...(format !== "chat" ? { format, transcript: messages.map(plainTranscriptMessage) } : {}),
        tools: options.tools ?? [],
        quirks,
        maxTokens: options.maxTokens ?? 16,
        signal: this.signal(),
        fetch: this.#fetch,
        onDelta: options.onDelta,
      })) {
        if (event.type === "text.delta") text += event.text;
        else if (event.type === "reasoning.delta") reasoning += event.text;
        else if (event.type === "tool.call") calls.push(event.call);
        else if (event.type === "finish") finish = event.reason;
      }
    } catch (error) {
      return { ok: false, failure: classify(error) };
    }
    return { ok: true, reply: { text, reasoning, calls, finish } };
  }

  /** A failure that makes every later check meaningless: stop and say why. */
  halt(failure: Failure): boolean {
    const key = this.context.profile.apiKeyEnv;
    if (failure.kind === "auth") {
      this.stopped = `The server refused the credentials${key ? ` (the key comes from ${key}, which is ${readProfileApiKey(this.context.profile, this.context.env ?? process.env) ? "set" : "not set"} where Moxen's server runs)` : " (the profile names no apiKeyEnv)"}.`;
    } else if (failure.kind === "missing") {
      this.stopped = `The server has no chat endpoint at ${this.context.profile.baseUrl} or does not know the model "${this.context.model.id}"${failure.detail ? `: ${failure.detail}` : "."}`;
    } else if (failure.kind === "down") {
      this.stopped = `Could not reach ${this.context.profile.baseUrl}: ${failure.detail}`;
    } else {
      return false;
    }
    return true;
  }

  rootUrl(): string {
    return this.context.profile.baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
  }

  async getJson(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<{ status: number; json: unknown } | null> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await this.#fetch(`${this.rootUrl()}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: this.signal(),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        // Not JSON; the status is the answer.
      }
      return { status: response.status, json };
    } catch {
      return null;
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function shorten(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Why a request that came back rejected is worth quoting: the server's own words, trimmed. */
function said(failure: Failure): string {
  return failure.detail ? ` It said: "${shorten(failure.detail)}"` : "";
}

// -- the battery --------------------------------------------------------------

interface ToolShape {
  /** Send `.` as the content of an assistant message that only made a tool call. */
  readonly dot: boolean;
  /** Put `name` on the tool message. */
  readonly name: boolean;
  /** Send the result as a user message instead of a tool message. */
  readonly asUser: boolean;
}

const SHAPES: readonly ToolShape[] = [
  { dot: false, name: false, asUser: false },
  { dot: true, name: false, asUser: false },
  { dot: false, name: true, asUser: false },
  { dot: true, name: true, asUser: false },
  { dot: false, name: false, asUser: true },
  { dot: true, name: false, asUser: true },
];

function toolHistory(probe: Probe, shape: ToolShape): WireMessage[] {
  const call = { id: "call_probe1", type: "function", function: { name: "echo", arguments: JSON.stringify({ text: AWKWARD_TEXT }) } };
  const result: WireMessage = shape.asUser
    ? { role: "user", content: `<tool_response>\n${AWKWARD_TEXT}\n</tool_response>` }
    : { role: "tool", tool_call_id: "call_probe1", content: AWKWARD_TEXT, ...(shape.name ? { name: "echo" } : {}) };
  return [probe.system(), { role: "user", content: "Use the echo tool." }, { role: "assistant", content: shape.dot ? "." : "", tool_calls: [call] }, result];
}

async function checkChat(probe: Probe): Promise<void> {
  const title = "Plain chat, streamed";
  const attempt = await probe.send([probe.system(), { role: "user", content: "Reply with the single word: ready" }], { maxTokens: 24 });
  if (attempt.ok) {
    probe.add("chat", title, "pass", "The server answered a short chat request over a stream.");
    return;
  }
  if (probe.halt(attempt.failure)) {
    probe.add("chat", title, "fail", probe.stopped ?? "");
    return;
  }
  const { failure } = attempt;
  if (failure.kind === "rejected") {
    probe.stopped = `The server refused even a two-message chat request.${said(failure)}`;
    probe.add("chat", title, "fail", probe.stopped);
    return;
  }
  probe.add("chat", title, "inconclusive", `The server was busy or slow (HTTP ${failure.status ?? "no status"}), so nothing could be checked. Try again when it is idle.`);
  probe.stopped = "The server did not answer the first request.";
}

async function checkReasoning(probe: Probe): Promise<void> {
  const title = "Where reasoning arrives";
  const seen = new Set<string>();
  let inline = false;
  const attempt = await probe.send([probe.system("Think the problem through before you answer."), { role: "user", content: "What is 17 times 23?" }], {
    maxTokens: 200,
    onDelta: (delta) => {
      for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
        if (typeof delta[key] === "string" && delta[key] !== "") seen.add(key);
      }
      if (typeof delta.content === "string" && delta.content.includes("<think>")) inline = true;
    },
  });
  if (!attempt.ok) {
    if (!probe.halt(attempt.failure)) probe.add("reasoning", title, "inconclusive", `The request failed (HTTP ${attempt.failure.status ?? "no status"}), so reasoning could not be observed.`);
    else probe.add("reasoning", title, "fail", probe.stopped ?? "");
    return;
  }
  const field = ["reasoning_content", "reasoning", "reasoning_text"].find((key) => seen.has(key)) as ReasoningField | undefined;
  if (field !== undefined) {
    probe.add("reasoning", title, "pass", `The model's reasoning arrives in the "${field}" field, so that is the one Moxen reads and sends back.`, { reasoningField: field });
  } else if (inline) {
    probe.add(
      "reasoning",
      title,
      "pass",
      "The model's reasoning arrives inside the answer as <think> tags. There is no field to send it back in, so earlier reasoning is left out of later requests.",
      { reasoningReplay: "none" },
    );
  } else {
    probe.add("reasoning", title, "inconclusive", "This model produced no reasoning for the test question (it may not think, or thinking is switched off), so the field could not be seen.");
  }
}

async function checkToolCall(probe: Probe): Promise<void> {
  const title = "Tool call with quotes and newlines";
  const messages: WireMessage[] = [
    probe.system("When asked to call a tool, call it and say nothing else."),
    { role: "user", content: `Call the echo tool. Its text argument must be exactly the characters between <<< and >>> (the quotes, the line break and the backslashes are part of it):\n<<<${AWKWARD_TEXT}>>>` },
  ];
  let attempt = await probe.send(messages, { tools: [ECHO_TOOL], maxTokens: 300, omitToolChoice: false });
  let omitted = false;
  if (!attempt.ok && attempt.failure.kind === "rejected") {
    const retry = await probe.send(messages, { tools: [ECHO_TOOL], maxTokens: 300, omitToolChoice: true });
    if (retry.ok) {
      omitted = true;
      attempt = retry;
    }
  }
  if (!attempt.ok) {
    if (probe.halt(attempt.failure)) probe.add("tool-call", title, "fail", probe.stopped ?? "");
    else if (attempt.failure.kind === "rejected") {
      probe.add("tool-call", title, "fail", `The server refused a request that carries tool definitions, so the agent cannot work on it.${said(attempt.failure)}`);
    } else probe.add("tool-call", title, "inconclusive", `The request failed (HTTP ${attempt.failure.status ?? "no status"}), so tool calling could not be checked.`);
    return;
  }
  const choiceQuirk: Partial<ModelQuirks> = { omitToolChoice: omitted };
  const note = omitted ? " The server rejects the `tool_choice` field, so Moxen leaves it out." : "";
  const call = attempt.reply.calls[0];
  if (call === undefined) {
    // The tool_choice finding stands even when the model chose not to call.
    probe.add("tool-call", title, "inconclusive", `The model answered in text instead of calling the tool, so argument escaping was not observed.${note}`, choiceQuirk);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    probe.add("tool-call", title, "fail", `The model's tool call came back with arguments that are not valid JSON. The model or its template is mangling escapes; Moxen cannot repair that.${note}`, choiceQuirk);
    return;
  }
  if (record(parsed)?.text === AWKWARD_TEXT) {
    probe.add("tool-call", title, "pass", `A tool call came back whole, with the quotes, line break and backslashes intact.${note}`, choiceQuirk);
  } else {
    probe.add("tool-call", title, "fail", `A tool call came back, but its text argument was altered on the way (escapes were lost or doubled).${note}`, choiceQuirk);
  }
}

/** Walks the tool-result shapes in order and reports which one the template takes. */
async function checkToolShapes(probe: Probe): Promise<ToolShape | null> {
  const results = { result: "Tool result message", content: "Empty content on a tool-call message" } as const;
  let working: ToolShape | null = null;
  let blocked: Failure | null = null;
  for (const shape of SHAPES) {
    const attempt = await probe.send(toolHistory(probe, shape), { tools: [ECHO_TOOL] });
    if (attempt.ok) {
      working = shape;
      break;
    }
    if (attempt.failure.kind !== "rejected") {
      blocked = attempt.failure;
      break;
    }
  }
  if (working === null) {
    const reason = blocked
      ? `The server could not be asked (HTTP ${blocked.status ?? "no status"}).`
      : "The template rejected every way of returning a tool result that Moxen can send (tool message, tool message with a name, result as a user message, each with and without placeholder content).";
    const outcome: ProbeOutcome = blocked ? "inconclusive" : "fail";
    probe.add("tool-result", results.result, outcome, reason);
    probe.add("empty-content", results.content, outcome === "fail" ? "inconclusive" : outcome, "Not settled, because no tool result shape was accepted.");
    if (blocked) probe.halt(blocked);
    return null;
  }
  const resultQuirks = { toolResultsAsUser: working.asUser, toolResultName: working.name };
  const resultFinding = working.asUser
    ? "This template has no tool role that accepts results: Moxen sends each result as a user message wrapped in <tool_response>."
    : working.name
      ? "The template wants a `name` on each tool result, and Moxen adds it."
      : "The server accepted a normal tool result message.";
  probe.add("tool-result", results.result, working.asUser || working.name ? "fail" : "pass", resultFinding, resultQuirks);
  probe.add(
    "empty-content",
    results.content,
    working.dot ? "fail" : "pass",
    working.dot
      ? 'This server rejects an assistant message that has a tool call and no text. Moxen sends "." as its content.'
      : "An assistant message with a tool call and no text was accepted.",
    { emptyAssistantContent: working.dot ? "dot" : "empty" },
  );
  return working;
}

async function checkUserAfterTool(probe: Probe, shape: ToolShape | null): Promise<void> {
  const title = "User message right after a tool result";
  if (shape === null) return probe.skip("user-after-tool", title, "Skipped: no tool result shape was accepted.");
  if (shape.asUser) return probe.skip("user-after-tool", title, "Not applicable: tool results already travel as user messages, which Moxen merges with what follows.");
  const base = toolHistory(probe, shape);
  const follow: WireMessage = { role: "user", content: "Thanks. Now say ok." };
  const direct = await probe.send([...base, follow], { tools: [ECHO_TOOL] });
  if (direct.ok) {
    return probe.add("user-after-tool", title, "pass", "A user message straight after a tool result was accepted.", { assistantAfterToolResult: false });
  }
  if (direct.failure.kind !== "rejected") {
    return probe.add("user-after-tool", title, "inconclusive", `The request failed (HTTP ${direct.failure.status ?? "no status"}), so this could not be checked.`);
  }
  const padded = await probe.send([...base, { role: "assistant", content: "Done." }, follow], { tools: [ECHO_TOOL] });
  if (padded.ok) {
    return probe.add("user-after-tool", title, "fail", "This template insists an assistant message sit between a tool result and the next user message. Moxen inserts a short one.", { assistantAfterToolResult: true });
  }
  probe.add("user-after-tool", title, "fail", `The server refused a user message after a tool result, with or without an assistant message between.${said(direct.failure)}`);
}

async function checkSystemAfterFirst(probe: Probe): Promise<void> {
  const title = "System message after the first";
  const attempt = await probe.send([
    probe.system(),
    { role: "user", content: "Hello." },
    { role: "assistant", content: "Hi." },
    { role: "system", content: "Reminder: keep it short." },
    { role: "user", content: "Say ok." },
  ]);
  if (attempt.ok) {
    return probe.add("system-after-first", title, "pass", "A system message in the middle of the conversation was accepted, so Moxen sends reminders as system messages.", { systemFirstOnly: false });
  }
  if (attempt.failure.kind === "rejected") {
    return probe.add(
      "system-after-first",
      title,
      "fail",
      `This server rejects system messages after the first. Moxen sends later reminders as user messages wrapped in <system-reminder>.${said(attempt.failure)}`,
      { systemFirstOnly: true },
    );
  }
  probe.add("system-after-first", title, "inconclusive", `The request failed (HTTP ${attempt.failure.status ?? "no status"}), so this could not be checked.`);
}

async function checkConsecutiveRoles(probe: Probe): Promise<void> {
  const title = "Two user messages in a row";
  const attempt = await probe.send([probe.system(), { role: "user", content: "First part." }, { role: "user", content: "Second part. Say ok." }]);
  if (attempt.ok) {
    return probe.add("consecutive-roles", title, "pass", "Two user messages in a row were accepted, so Moxen leaves them separate.", { mergeAdjacentRoles: false });
  }
  if (attempt.failure.kind === "rejected") {
    return probe.add("consecutive-roles", title, "fail", `This template needs user and assistant messages to alternate. Moxen merges messages from the same side.${said(attempt.failure)}`, { mergeAdjacentRoles: true });
  }
  probe.add("consecutive-roles", title, "inconclusive", `The request failed (HTTP ${attempt.failure.status ?? "no status"}), so this could not be checked.`);
}

async function checkImage(probe: Probe): Promise<void> {
  const title = "Image input";
  const attempt = await probe.send([
    probe.system(),
    { role: "user", content: [{ type: "text", text: "Describe this image in one word." }, { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL_PNG}` } }] },
  ]);
  if (attempt.ok) {
    const stated = probe.context.model.vision;
    const note = stated === false ? ' The model is marked `vision: false` in the profile, which wins; set it to true to send images.' : "";
    return probe.add("image", title, "pass", `The server accepted an image.${note}`, { images: "native" });
  }
  if (attempt.failure.kind === "rejected") {
    const note = probe.context.model.vision === true ? " The model is marked `vision: true` in the profile, and that setting still wins." : "";
    return probe.add("image", title, "fail", `This server does not take images (on llama.cpp that means it was started without --mmproj). Moxen sends a text note instead.${note}${said(attempt.failure)}`, { images: "none" });
  }
  probe.add("image", title, "inconclusive", `The request failed (HTTP ${attempt.failure.status ?? "no status"}), so image input could not be checked.`);
}

/** llama.cpp's own endpoints: the real context size, slot count and template. Other servers answer 404 and this check is skipped. */
async function checkServer(probe: Probe): Promise<void> {
  const title = "Server facts (llama.cpp)";
  const props = await probe.getJson("/props");
  const body = record(props?.json);
  if (props === null || props.status !== 200 || body === null) {
    return probe.skip("server", title, "This server has no /props endpoint, so it is probably not llama.cpp. Set the model's contextWindow by hand.");
  }
  const found: string[] = [];
  const settings = record(body.default_generation_settings);
  const window = typeof settings?.n_ctx === "number" ? settings.n_ctx : typeof body.n_ctx === "number" ? body.n_ctx : undefined;
  if (window !== undefined && Number.isInteger(window) && window > 0) {
    probe.server.contextWindow = window;
    found.push(`${window.toLocaleString("en-US")} tokens of context per slot`);
  }
  if (typeof body.total_slots === "number" && Number.isInteger(body.total_slots) && body.total_slots > 0) {
    probe.server.slots = body.total_slots;
    found.push(`${body.total_slots} slot${body.total_slots === 1 ? "" : "s"}`);
  }
  if (typeof body.chat_template === "string" && body.chat_template !== "") {
    probe.server.templateHash = createHash("sha256").update(body.chat_template).digest("hex").slice(0, 12);
    found.push(`a ${body.chat_template.length.toLocaleString("en-US")}-character chat template`);
  }
  const modalities = record(body.modalities);
  if (typeof modalities?.vision === "boolean") probe.server.vision = modalities.vision;
  const tokenize = await probe.getJson("/tokenize", { method: "POST", body: { content: "probe" } });
  if (tokenize !== null && tokenize.status === 200 && Array.isArray(record(tokenize.json)?.tokens)) {
    probe.server.tokenize = true;
    found.push("exact token counts (/tokenize)");
  }
  probe.add("server", title, "pass", found.length > 0 ? `The server reports ${found.join(", ")}.` : "The server answered /props but reported nothing Moxen uses.");
}

/** A slot already working means someone else is mid-request; the probe would queue behind it and then push its prompt out. */
async function busyReason(probe: Probe): Promise<string | null> {
  const slots = await probe.getJson("/slots");
  if (slots === null || slots.status !== 200 || !Array.isArray(slots.json)) return null;
  const busy = slots.json.some((slot) => record(slot)?.is_processing === true);
  return busy ? "The server is working on another request right now. Run the probe when it is idle, so it does not queue behind that work or push its prompt out of the cache." : null;
}

/**
 * Run the battery against one model of a profile. Never throws for a server
 * problem: it comes back in the report. Aborting the signal stops it between
 * requests with whatever was found so far.
 */
/** The text of a simple chat wire message as a transcript entry, for the formats that build their own wire messages. */
function plainTranscriptMessage(message: WireMessage): TranscriptMessage {
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
  return message.role === "assistant" ? { role: "assistant", content } : message.role === "system" || message.role === "developer" ? { role: "system", content } : { role: "user", content };
}

export async function runProbe(context: ProbeContext): Promise<ProbeReport> {
  const probe = new Probe(context);
  const stop = (): boolean => probe.halted || context.signal?.aborted === true;

  if (context.profile.apiFormat !== "chat") {
    // The battery looks for chat-template quirks (roles, ids, reasoning fields); these formats are defined by their API, not a template.
    probe.stopped = `The probe checks the quirks of chat-completions servers, which a "${context.profile.apiFormat}" endpoint does not have. Use Test to see whether the endpoint answers, and set "Takes images" on the model by hand.`;
    return { profileId: context.profile.id, model: context.model.id, at: (context.now ?? (() => new Date()))().toISOString(), checks: [], quirks: {}, server: {}, notes: [], stopped: probe.stopped };
  }
  const busy = await busyReason(probe);
  if (busy !== null) {
    probe.stopped = busy;
  } else {
    await checkChat(probe);
    if (!stop()) await checkReasoning(probe);
    if (!stop()) await checkToolCall(probe);
    let shape: ToolShape | null = null;
    if (!stop()) shape = await checkToolShapes(probe);
    if (!stop()) await checkUserAfterTool(probe, shape);
    if (!stop()) await checkSystemAfterFirst(probe);
    if (!stop()) await checkConsecutiveRoles(probe);
    if (!stop()) await checkImage(probe);
    if (!stop()) await checkServer(probe);
    if (context.signal?.aborted === true && probe.stopped === null) probe.stopped = "The probe was cancelled.";
  }

  const slots = probe.server.slots ?? context.profile.slots;
  if (slots === 1 && probe.checks.length > 0) {
    probe.notes.push("This server has one slot. The probe's requests used it, so the next conversation turn has to read its whole prompt again.");
  }
  if (probe.server.slots !== undefined && context.profile.slots === undefined) {
    probe.notes.push(`The server has ${probe.server.slots} slot${probe.server.slots === 1 ? "" : "s"}; set the profile's slots to match so Moxen's own subagents do not starve it.`);
  }
  if (probe.server.contextWindow !== undefined && context.model.contextWindow === undefined) {
    probe.notes.push(`The model has no contextWindow; until one is set the server's ${probe.server.contextWindow.toLocaleString("en-US")} is used, which is what automatic compaction needs.`);
  } else if (probe.server.contextWindow !== undefined && context.model.contextWindow !== undefined && probe.server.contextWindow !== context.model.contextWindow) {
    probe.notes.push(`The profile says ${context.model.contextWindow.toLocaleString("en-US")} tokens of context but the server reports ${probe.server.contextWindow.toLocaleString("en-US")} per slot. The profile's number is used.`);
  }
  if (probe.server.vision !== undefined && probe.checks.some((check) => check.id === "image" && check.outcome === "pass") && probe.server.vision === false) {
    probe.notes.push("The server accepted an image but reports no vision support, so it may be ignoring images.");
  }
  const overrides = context.profile.quirks ? parseQuirkOverrides(context.profile.quirks, "quirks") : {};
  for (const [key, found] of Object.entries(probe.quirks)) {
    const set = (overrides as Record<string, unknown>)[key];
    if (set !== undefined && JSON.stringify(set) !== JSON.stringify(found)) {
      probe.notes.push(`The profile sets quirks.${key} to ${JSON.stringify(set)} but the probe found ${JSON.stringify(found)}. Your setting wins.`);
    }
  }

  return {
    profileId: context.profile.id,
    model: context.model.id,
    at: (context.now ?? (() => new Date()))().toISOString(),
    checks: probe.checks,
    quirks: probe.quirks as Partial<ModelQuirks>,
    server: probe.server,
    notes: probe.notes,
    stopped: probe.stopped,
  };
}

/**
 * The model's `probed` block after a run: what the report settled is replaced,
 * what it could not settle is kept from before, unless the server's template
 * changed, in which case the old findings no longer describe it.
 */
export function mergeProbed(previous: HarnessProbedConfig | undefined, report: ProbeReport): HarnessProbedConfig {
  const changed = previous?.templateHash !== undefined && report.server.templateHash !== undefined && previous.templateHash !== report.server.templateHash;
  const kept = previous && !changed ? previous : undefined;
  const merged: HarnessProbedConfig = { at: report.at, quirks: { ...kept?.quirks, ...report.quirks } };
  const contextWindow = report.server.contextWindow ?? kept?.contextWindow;
  if (contextWindow !== undefined) merged.contextWindow = contextWindow;
  const slots = report.server.slots ?? kept?.slots;
  if (slots !== undefined) merged.slots = slots;
  const templateHash = report.server.templateHash ?? kept?.templateHash;
  if (templateHash !== undefined) merged.templateHash = templateHash;
  // A newer build's extra probed fields survive a probe save, the way a
  // plain settings.set keeps them; a changed template still starts fresh.
  if (kept) {
    const known = new Set(["at", "quirks", "contextWindow", "slots", "templateHash"]);
    for (const [key, value] of Object.entries(kept)) if (!known.has(key)) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** Whether a report settled anything worth writing. */
export function probeSettledSomething(report: ProbeReport): boolean {
  return Object.keys(report.quirks).length > 0 || Object.keys(report.server).length > 0;
}

// -- the test action -----------------------------------------------------------

export interface HarnessTestResult {
  readonly ok: boolean;
  readonly profileId: string;
  readonly model: string;
  readonly latencyMs: number;
  /** One or two sentences a person can act on. */
  readonly message: string;
}

/** One tiny request, to answer "does this profile work at all". Separate from the probe so it is cheap and safe to press. */
export async function testProfile(context: ProbeContext): Promise<HarnessTestResult> {
  const probe = new Probe(context);
  const started = Date.now();
  const attempt = await probe.send([probe.system("Answer with one word."), { role: "user", content: "Reply with the single word: ok" }], { maxTokens: 16 });
  const latencyMs = Date.now() - started;
  const base = { profileId: context.profile.id, model: context.model.id, latencyMs };
  if (attempt.ok) {
    return { ...base, ok: true, message: `${new URL(context.profile.baseUrl).host} answered for "${context.model.id}" in ${(latencyMs / 1000).toFixed(1)}s.` };
  }
  const { failure } = attempt;
  if (probe.halt(failure)) return { ...base, ok: false, message: probe.stopped ?? "The request failed." };
  if (failure.kind === "busy") {
    return { ...base, ok: false, message: `The server is busy or overloaded (HTTP ${failure.status ?? "no status"}). Try again in a moment.` };
  }
  return { ...base, ok: false, message: `The server refused the request.${said(failure)}` };
}
