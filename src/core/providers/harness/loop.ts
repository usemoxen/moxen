/**
 * The agent loop for one user turn: ask the model, run the tools it calls,
 * show it the results, repeat until it answers without a tool call.
 *
 * It keeps the transcript valid at every point an interrupt can land (every
 * tool call gets a result), retries what is worth retrying, and stops what is
 * not going anywhere (identical calls, empty replies, endless rounds). It
 * knows nothing about threads or the UI: it reports what happens through
 * `emit` and asks permission through `authorize`.
 */
import { randomUUID } from "node:crypto";

import { CONTINUE_AFTER_COMPACTION } from "./compactprompt.js";
import { isContextOverflow, type CompactReason } from "./compact.js";
import { estimateTokens, messagesTokens } from "./context.js";
import { EMPTY_REPLY_REMINDER, LOOP_WARNING, LoopGuard, OUTPUT_LIMIT_REMINDER, RepeatWatch, type LoopGuardSettings } from "./guards.js";
import type { ModelQuirks } from "./quirks.js";
import type { HarnessTranscript } from "./session.js";
import type { HarnessTool, ToolContext, ToolIntent, ToolResult } from "./tools/index.js";
import { validateToolArguments } from "./tools/index.js";
import { ChatHttpError, retryDelayMs, type ChatRequest } from "./transport/chat.js";
import { conversationFields, streamModel } from "./transport/model.js";
import type { HarnessApiFormat } from "../../types.js";
import type { ModelEvent, ModelUsage, ReasoningItem, ToolCall } from "./types.js";
import type { ProviderImage } from "../spi.js";

export type LoopEvent =
  | { readonly type: "text"; readonly messageId: string; readonly text: string }
  /** A message that turned out to be between tool calls, sent whole. */
  | { readonly type: "note"; readonly messageId: string; readonly text: string }
  | { readonly type: "reasoning.delta"; readonly reasoningId: string; readonly text: string }
  | { readonly type: "reasoning.done"; readonly reasoningId: string; readonly text: string; readonly startedAt: string; readonly durationMs: number }
  | { readonly type: "tool.started"; readonly call: ToolCall; readonly args: Record<string, unknown>; readonly intent: ToolIntent | null }
  | { readonly type: "tool.completed"; readonly call: ToolCall; readonly args: Record<string, unknown>; readonly result: ToolResult }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "retry"; readonly attempt: number; readonly reason: string; readonly delayMs: number }
  /** Text the user sent mid-turn was handed to the model. */
  | { readonly type: "steered"; readonly text: string };

export type Authorization = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** How a compaction went, as far as the loop needs to know. `message` is for the user when it ends the turn. */
export interface CompactionReport {
  /** `compacted`: room was made. `nothing`: too little to compact. `stalled`: it freed some room but not enough to keep going. `failed`: it could not run. */
  readonly status: "compacted" | "nothing" | "stalled" | "failed";
  readonly message: string;
}

/** What lets a turn compact its own conversation instead of ending when it fills up. */
export interface TurnCompaction {
  /** Tokens at which a long turn compacts before its next request; null when it should not on its own. */
  readonly threshold: number | null;
  readonly contextWindow: number | null;
  /** Compacts the transcript (and tells the session and the user); resolves when it is done. */
  readonly run: (reason: CompactReason) => Promise<CompactionReport>;
}

export interface TurnConfig {
  readonly baseUrl: string;
  /** Read per request, so a key set after the app started is still found and is never held longer than a call. */
  readonly apiKey: () => string | undefined;
  readonly model: string;
  /** The wire format the endpoint speaks; chat when absent. */
  readonly format?: HarnessApiFormat | undefined;
  readonly quirks: ModelQuirks;
  readonly sampling?: ChatRequest["sampling"];
  readonly effort?: string | undefined;
  readonly maxOutput?: number | undefined;
  /** The tools offered; a function when the set can change mid-turn. Read before every request. */
  readonly tools: readonly HarnessTool<never>[] | (() => readonly HarnessTool<never>[]);
  readonly toolContext: Omit<ToolContext, "signal">;
  readonly authorize: (call: ToolCall, intent: ToolIntent) => Promise<Authorization>;
  /** Takes the text the user sent while the turn ran; it reaches the model as a user message at the next step. */
  readonly takeSteering?: () => readonly { readonly text: string; readonly images: readonly ProviderImage[] }[];
  /** Things the model should know that happened outside the conversation (a background command ended); each reaches it as a system entry before the next request. */
  readonly takeNotes?: () => readonly string[];
  /** Swapped out in tests. */
  readonly transport?: (request: ChatRequest) => AsyncIterable<ModelEvent>;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A cap on model requests in one turn; absent: none, as with OpenCode and Claude Code. Stop a runaway turn with an interrupt. */
  readonly maxRounds?: number;
  readonly maxAttempts?: number;
  /** Thresholds of the repeat guards; absent: the defaults. */
  readonly loopGuard?: Partial<LoopGuardSettings>;
  /** Absent: a full context ends the turn. */
  readonly compaction?: TurnCompaction;
}

export interface TurnUsageTotals {
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

export interface TurnResult {
  readonly status: "completed" | "failed" | "interrupted";
  /** The final answer: the text of the last round. */
  readonly text: string;
  readonly error: string | null;
  readonly usage: TurnUsageTotals;
  /** Tokens the last request held, which is what the context window holds now. */
  readonly contextTokens: number | null;
  /** The newest usage the server reported, whole, for the context reading. */
  readonly lastUsage: ModelUsage | null;
}

const DEFAULT_MAX_ROUNDS = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_ATTEMPTS = 4;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const isAbort = (error: unknown, signal: AbortSignal): boolean => signal.aborted || (error as Error)?.name === "AbortError";

const OVERFLOW_MESSAGE = "The conversation no longer fits the model's context window. Compact it with /compact, roll back some turns, or start a new thread.";

/** Compactions a turn may ask for to get past a full window or a cut-off reply. */
const MAX_RESCUES = 2;

export async function runTurn(
  transcript: HarnessTranscript,
  prompt: { readonly text: string; readonly images?: readonly ProviderImage[] | undefined },
  turnId: string,
  config: TurnConfig,
  emit: (event: LoopEvent) => void,
  signal: AbortSignal,
): Promise<TurnResult> {
  const transport = config.transport ?? streamModel;
  const sleep = config.sleep ?? defaultSleep;
  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const toolContext: ToolContext = { ...config.toolContext, signal };
  const guard = new LoopGuard(config.loopGuard);
  const usage: TurnUsageTotals = { input: 0, cacheRead: 0, output: 0, thinking: 0 };
  let contextTokens: number | null = null;
  let lastUsage: ModelUsage | null = null;
  let finalText = "";
  let emptyReplies = 0;
  let afterToolResults = false;
  let outputLimitStops = 0;
  let rescues = 0;
  // What the server last said the prompt held, and where in the transcript that was, so later entries can be added by estimate.
  let reportedTokens: number | null = null;
  let reportedAt = 0;
  let reportedFresh = false;
  let toolTokens = 0;
  const window = config.compaction?.contextWindow ?? null;
  const threshold = config.compaction?.threshold ?? null;
  const estimatedTokens = (): number => messagesTokens(transcript.messages) + toolTokens;
  const usedTokens = (): number => (reportedTokens !== null ? reportedTokens + messagesTokens(transcript.messages.slice(reportedAt)) : estimatedTokens());

  /** Compacts the transcript; what the loop remembered about its size no longer applies afterwards. */
  const compactNow = async (reason: CompactReason): Promise<CompactionReport | null> => {
    if (!config.compaction) return null;
    const report = await config.compaction.run(reason);
    if (report.status === "compacted") {
      reportedTokens = null;
      contextTokens = null;
      lastUsage = null;
    }
    return report;
  };

  transcript.append({ role: "user", content: prompt.text, ...(prompt.images && prompt.images.length > 0 ? { images: prompt.images } : {}) });

  const done = (status: TurnResult["status"], error: string | null = null): TurnResult => ({ status, text: finalText, error, usage, contextTokens, lastUsage });

  /** Steering goes in as ordinary user messages, so a model that already answered still reads it. Returns whether there was any. */
  const injectSteering = (): boolean => {
    const steers = config.takeSteering?.() ?? [];
    for (const { text, images } of steers) {
      transcript.append({ role: "user", content: text, ...(images.length > 0 ? { images } : {}) });
      emit({ type: "steered", text });
    }
    return steers.length > 0;
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    if (signal.aborted) return done("interrupted");
    if (round > 1) injectSteering();
    for (const note of config.takeNotes?.() ?? []) transcript.append({ role: "system", content: note });
    const offered = typeof config.tools === "function" ? config.tools() : config.tools;
    const toolByName = new Map(offered.map((tool) => [tool.definition.name, tool as HarnessTool<Record<string, unknown>>]));
    const definitions = offered.map((tool) => tool.definition);
    toolTokens = estimateTokens(JSON.stringify(definitions));
    // A long tool loop fills the window one result at a time: make room before asking, not after being refused.
    if (round > 1 && threshold !== null && usedTokens() >= threshold) {
      const report = await compactNow("mid-turn");
      if (signal.aborted) return done("interrupted");
      if (report && (report.status === "stalled" || report.status === "failed")) return done("failed", report.message);
    }
    const messageId = `${turnId}-m${round}`;
    const reasoningId = `${turnId}-r${round}`;
    let text = "";
    let reasoning = "";
    let reasoningStartedAt: number | null = null;
    const calls: ToolCall[] = [];
    const reasoningItems: ReasoningItem[] = [];
    let finish: string = "stop";
    let emitted = false;
    let repeated = false;
    // Reasoning ends where the answer starts: closing it then keeps its row above the text instead of "running" under it.
    let reasoningClosedAt = -1;
    const closeReasoning = () => {
      if (reasoningStartedAt === null || reasoningClosedAt === reasoning.length) return;
      reasoningClosedAt = reasoning.length;
      emit({ type: "reasoning.done", reasoningId, text: reasoning, startedAt: new Date(reasoningStartedAt).toISOString(), durationMs: Date.now() - reasoningStartedAt });
    };
    const watchText = config.loopGuard?.text !== false;
    const textWatch = new RepeatWatch(config.loopGuard?.textRepeats);
    const reasoningWatch = new RepeatWatch(config.loopGuard?.textRepeats);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      // Whatever a failed attempt got as far as is not part of the reply that finally comes.
      calls.length = 0;
      reasoningItems.length = 0;
      try {
        const request: ChatRequest = {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey(),
          model: config.model,
          ...conversationFields(config.format, transcript.messages, config.quirks),
          tools: definitions,
          quirks: config.quirks,
          sampling: config.sampling,
          maxTokens: config.maxOutput,
          effort: config.effort,
          signal,
        };
        for await (const event of transport(request)) {
          if (event.type === "reasoning.delta") {
            reasoningStartedAt ??= Date.now();
            reasoning += event.text;
            emitted = true;
            emit({ type: "reasoning.delta", reasoningId, text: event.text });
            if (watchText && reasoningWatch.push(event.text)) {
              repeated = true;
              break;
            }
          } else if (event.type === "text.delta") {
            if (event.text !== "") closeReasoning();
            text += event.text;
            emitted = true;
            emit({ type: "text", messageId, text: event.text });
            if (watchText && textWatch.push(event.text)) {
              repeated = true;
              break;
            }
          } else if (event.type === "tool.call") {
            calls.push(event.call);
          } else if (event.type === "reasoning.item") {
            reasoningItems.push(event.item);
          } else if (event.type === "usage") {
            usage.input += Math.max(0, event.usage.inputTokens - event.usage.cachedInputTokens);
            usage.cacheRead += event.usage.cachedInputTokens;
            usage.output += event.usage.outputTokens;
            usage.thinking += event.usage.reasoningTokens;
            contextTokens = event.usage.inputTokens + event.usage.outputTokens;
            lastUsage = event.usage;
            reportedTokens = event.usage.inputTokens + event.usage.outputTokens;
            reportedFresh = true;
            emit({ type: "usage", usage: event.usage });
          } else if (event.type === "finish") {
            finish = event.reason;
          }
        }
        break;
      } catch (error) {
        if (isAbort(error, signal)) return done("interrupted");
        if (error instanceof ChatHttpError) {
          if (isContextOverflow(error, estimatedTokens(), window)) {
            // Nothing was shown yet (the server refused the prompt), so the same request can go again once there is room.
            if (!config.compaction || emitted || rescues >= MAX_RESCUES) return done("failed", OVERFLOW_MESSAGE);
            rescues += 1;
            const report = await compactNow("overflow");
            if (signal.aborted) return done("interrupted");
            if (report?.status === "compacted") {
              attempt = 0;
              continue;
            }
            return done("failed", report?.status === "nothing" || !report ? OVERFLOW_MESSAGE : report.message);
          }
          // Output already shown cannot be taken back, so only a request that produced nothing is retried.
          if (error.retryable && !emitted && attempt < maxAttempts) {
            const delayMs = retryDelayMs(attempt, error.retryAfterMs);
            emit({ type: "retry", attempt, reason: error.message, delayMs });
            await sleep(delayMs, signal);
            if (signal.aborted) return done("interrupted");
            continue;
          }
          return done("failed", error.message);
        }
        return done("failed", (error as Error).message ?? String(error));
      }
    }

    closeReasoning();
    if (repeated) return done("failed", "Stopped: the model got stuck repeating the same text. Send another message to continue; rewording the request or compacting the conversation usually clears it.");
    transcript.append({ role: "assistant", content: text, ...(reasoning.trim() ? { reasoning } : {}), ...(reasoningItems.length > 0 ? { reasoningItems } : {}), ...(calls.length > 0 ? { toolCalls: calls } : {}) });
    if (reportedFresh) {
      reportedAt = transcript.messages.length;
      reportedFresh = false;
    }
    if (calls.length === 0) finalText = text;

    if (calls.length > 0) {
      if (text.trim() !== "") emit({ type: "note", messageId, text });
      emptyReplies = 0;
      outputLimitStops = 0;
      afterToolResults = true;
      const outcome = await runCalls(calls, toolByName, guard, toolContext, config, transcript, emit, signal);
      if (signal.aborted) return done("interrupted");
      if (outcome.stopReason) return done("failed", outcome.stopReason);
      if (outcome.endTurn) {
        finalText = outcome.endTurn.answer;
        return done("completed");
      }
      continue;
    }

    if (finish === "filter") return done("failed", "The model endpoint refused to answer (content filter).");
    if (finish === "error") return done("failed", "The model endpoint stopped with an error.");
    // Cut off by the output limit with the window nearly full: the reply may have been squeezed, so make room and let it finish.
    if (finish === "length" && threshold !== null && rescues < MAX_RESCUES && usedTokens() >= threshold) {
      rescues += 1;
      const report = await compactNow("length");
      if (signal.aborted) return done("interrupted");
      if (report?.status === "compacted") {
        transcript.append({ role: "system", content: CONTINUE_AFTER_COMPACTION });
        continue;
      }
      if (report && report.status !== "nothing") return done("failed", report.message);
    }
    if (finish === "length" && text.trim() === "") {
      // Reasoning used the whole output budget: say so once or twice, then give up rather than loop.
      outputLimitStops += 1;
      if (outputLimitStops > 2) return done("failed", "The model kept running out of output space before answering.");
      transcript.append({ role: "system", content: OUTPUT_LIMIT_REMINDER });
      continue;
    }
    if (text.trim() === "" && afterToolResults) {
      emptyReplies += 1;
      if (emptyReplies > 1) return done("failed", "The model replied with nothing after a tool result, twice.");
      transcript.append({ role: "system", content: EMPTY_REPLY_REMINDER });
      continue;
    }
    // The user spoke while the model was writing its last answer: it has not seen that yet.
    if (injectSteering()) {
      afterToolResults = false;
      emptyReplies = 0;
      continue;
    }
    return done("completed");
  }
  return done("failed", `Stopped after ${maxRounds} steps without a final answer.`);
}

/** Run one round's tool calls; says why the turn must end (a stop reason, or a tool that handed over), if it must. Every call gets a result in the transcript. */
async function runCalls(
  calls: readonly ToolCall[],
  tools: ReadonlyMap<string, HarnessTool<Record<string, unknown>>>,
  guard: LoopGuard,
  context: ToolContext,
  config: TurnConfig,
  transcript: HarnessTranscript,
  emit: (event: LoopEvent) => void,
  signal: AbortSignal,
): Promise<{ stopReason: string | null; endTurn: ToolResult["endTurn"] }> {
  const results = new Map<string, ToolResult>();
  let stopReason: string | null = null;
  let endTurn: ToolResult["endTurn"];

  const runOne = async (call: ToolCall): Promise<void> => {
    try {
      await runChecked(call);
    } catch (error) {
      // Whatever went wrong, the transcript still needs a result for this call.
      results.set(call.id, { content: `${call.name} failed: ${(error as Error).message}`, isError: true });
    }
  };

  const runChecked = async (call: ToolCall): Promise<void> => {
    const tool = tools.get(call.name);
    const finishWith = (args: Record<string, unknown>, result: ToolResult): void => {
      results.set(call.id, result);
      emit({ type: "tool.completed", call, args, result });
    };
    if (!tool) {
      emit({ type: "tool.started", call, args: {}, intent: null });
      const names = [...tools.keys()].join(", ");
      return finishWith({}, { content: `There is no tool named "${call.name}". The tools you can call are: ${names}.`, isError: true });
    }
    const checked = validateToolArguments(call.arguments, tool.definition.parameters, call.name);
    if (!checked.ok) {
      emit({ type: "tool.started", call, args: {}, intent: null });
      return finishWith({}, { content: checked.error, isError: true });
    }
    const intent = tool.intent(checked.args, context);
    emit({ type: "tool.started", call, args: checked.args, intent });
    const verdict = guard.record(call.name, call.arguments);
    if (verdict === "stop") {
      stopReason = `Stopped: the model made the same ${call.name} call too many times in one turn.`;
      return finishWith(checked.args, { content: LOOP_WARNING, isError: true });
    }
    if (signal.aborted) return finishWith(checked.args, { content: "[Interrupted before it ran.]", isError: true });
    const allowed = await config.authorize(call, intent);
    if (!allowed.allow) return finishWith(checked.args, { content: allowed.reason, isError: true });
    if (signal.aborted) return finishWith(checked.args, { content: "[Interrupted before it ran.]", isError: true });
    let result: ToolResult;
    try {
      result = await tool.run(checked.args, { ...context, callId: call.id });
    } catch (error) {
      result = { content: `${call.name} failed: ${(error as Error).message}`, isError: true };
    }
    guard.observe(call.name, call.arguments, result.content);
    if (verdict === "warn") result = { ...result, content: `${result.content}\n\n[${LOOP_WARNING}]` };
    finishWith(checked.args, result);
  };

  let index = 0;
  while (index < calls.length) {
    const first = tools.get(calls[index]!.name);
    const batch = [calls[index]!];
    // Reads run together, and so do several calls of one tool that says it can (subagents).
    const together = (name: string): boolean => {
      const tool = tools.get(name);
      return tool !== undefined && (first?.readOnly === true ? tool.readOnly : first?.parallel === true && tool.parallel === true && name === calls[index]!.name);
    };
    if (first?.readOnly === true || first?.parallel === true) {
      while (index + batch.length < calls.length && together(calls[index + batch.length]!.name)) batch.push(calls[index + batch.length]!);
    }
    index += batch.length;
    await Promise.all(batch.map(runOne));
  }
  // The model sees results in the order it made the calls, however they finished.
  for (const call of calls) {
    const result = results.get(call.id) ?? { content: "[Interrupted before it ran.]", isError: true };
    transcript.append({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, ...(result.isError ? { isError: true } : {}), ...(result.images && result.images.length > 0 ? { images: result.images } : {}) });
  }
  for (const result of results.values()) endTurn ??= result.endTurn;
  return { stopReason, endTurn };
}

export function newTurnId(): string {
  return `turn_${randomUUID()}`;
}
