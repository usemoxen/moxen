/**
 * What the side panel's Agents and Context tabs show, read off state the
 * app already holds: the shell's threads (delegated tasks are threads with
 * a `parentThreadId`), the open thread's recorded `subagent` rows (a
 * provider's native subagents), and a context breakdown.
 */
import { t } from "../i18n/index.js";
import type { ActivityEnvelope, MessageEnvelope, ThreadEnvelope } from "../../core/types.js";
import type { QueryResult } from "../../server/api.js";

/** What fills the context window, as the `thread.context` query reports it. */
export type ContextBreakdown = NonNullable<QueryResult<"thread.context">["breakdown"]>;

/** What the thread has cost, by model, as `thread.context` reports it. */
export type ThreadCost = QueryResult<"thread.context">["cost"];
import { threadStatus, type ThreadStatus } from "./shell.js";
import type { ContextUsage } from "./thread.js";

export type SideTab = "diff" | "git" | "context" | "agents" | "background";

export interface AgentThreadRow {
  threadId: string;
  title: string;
  status: ThreadStatus;
  /** The model it runs on: its catalog name where known, else `instance/model`. */
  model: string | null;
  /** When its latest turn started, for the running clock. */
  startedAt: string | null;
  /** Its latest turn's outcome, once settled. */
  outcome: "completed" | "error" | "interrupted" | "unknown" | null;
}

/** The open thread's delegated tasks, newest first. */
export function agentThreads(
  threads: readonly ThreadEnvelope[],
  parentThreadId: string | null,
  now: number = Date.now(),
  modelName: (instanceId: string, model: string) => string | null = () => null,
): AgentThreadRow[] {
  if (parentThreadId === null) return [];
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId && thread.archivedAt == null && thread.deletedAt == null)
    .sort((left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""))
    .map((thread) => {
      const turn = thread.latestTurn ?? null;
      return {
        threadId: thread.id,
        title: String(thread.title ?? thread.id),
        status: threadStatus(thread, now),
        model: thread.modelSelection
          ? (modelName(thread.modelSelection.instanceId, thread.modelSelection.model) ?? `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`)
          : null,
        startedAt: turn?.startedAt ?? turn?.requestedAt ?? null,
        outcome: turn === null || turn.state === "running" ? null : turn.state,
      };
    });
}

export { nativeSubagents, type NativeSubagentRow } from "../../server/subagentrows.js";

export interface ContextShare {
  name: string;
  tokens: number;
  /** Of the whole window (or of what is used, when the window size is unknown). */
  percent: number;
  kind: "used" | "free" | "buffer";
}

/** Categories with their share of the window, largest used first, free space and buffer last. */
export function contextShares(
  categories: ReadonlyArray<{ name: string; tokens: number; kind: "used" | "free" | "buffer" }>,
  maxTokens: number | null,
  usedTokens: number,
): ContextShare[] {
  const whole = maxTokens !== null && maxTokens > 0 ? maxTokens : Math.max(1, usedTokens);
  const rank = { used: 0, buffer: 1, free: 2 } as const;
  return categories
    .filter((category) => category.tokens > 0)
    .map((category) => ({ ...category, percent: (category.tokens / whole) * 100 }))
    .sort((left, right) => rank[left.kind] - rank[right.kind] || right.tokens - left.tokens);
}

export interface PlanUsageGauge {
  short: string;
  percent: number;
}

const CHARS_PER_TOKEN = 4;

function charsOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * The tool a call row names, as the harness recorded it (`data.tool`).
 * MCP tools drop their `mcp__server__` prefix. Never guessed from the
 * summary: that is prose, and guessing made "This" and turn ids "tools".
 */
function activityToolName(payload: Record<string, unknown>): string {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const name = typeof data.tool === "string" ? data.tool : typeof data.toolName === "string" ? data.toolName : null;
  if (name === null || name.length === 0) return "Other";
  return /^mcp__[^_]+(?:_[^_]+)*__(.+)$/u.exec(name)?.[1] ?? name;
}

/**
 * What fills the window when the provider only reports the total (Claude's
 * `/context` summary without categories, or no live session at all).
 * Estimated from the transcript itself — text size at ~4 chars/token per
 * role — scaled to the real total, exactly like the OpenCode breakdown.
 * Whatever the messages do not account for is the system prompt and tools.
 * Null when there is no reading to scale against.
 */
export function estimateContextBreakdown(
  usage: ContextUsage | null | undefined,
  messages: readonly MessageEnvelope[],
  activities: readonly ActivityEnvelope[],
): ContextBreakdown | null {
  if (usage === null || usage === undefined) return null;
  const chars = { user: 0, assistant: 0, reasoning: 0, tools: 0 };
  const perTool = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "user") chars.user += charsOf(message.text);
    else if (message.role === "assistant") chars.assistant += charsOf(message.text);
    else chars.user += charsOf(message.text);
  }
  // Only tool and reasoning rows are context: both carry `toolCallId`, and
  // each call writes a row as it starts and again as it ends, so the
  // newest row per id stands for the call. Everything else in the ledger
  // (turn bookkeeping, notices, plans) is our own record, never sent back
  // to the model — `turn.started` carries the prompt, which the messages
  // already count.
  const calls = new Map<string, Record<string, unknown>>();
  for (const activity of activities) {
    if (activity.kind === "subagent") continue;
    const payload = (activity.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.toolCallId === "string") calls.set(payload.toolCallId, payload);
  }
  for (const payload of calls.values()) {
    if (payload.itemType === "reasoning") {
      chars.reasoning += charsOf(payload.text);
      continue;
    }
    const toolChars = charsOf(payload);
    if (toolChars === 0) continue;
    chars.tools += toolChars;
    const name = activityToolName(payload);
    perTool.set(name, (perTool.get(name) ?? 0) + toolChars);
  }
  const estimated = {
    user: chars.user / CHARS_PER_TOKEN,
    assistant: chars.assistant / CHARS_PER_TOKEN,
    reasoning: chars.reasoning / CHARS_PER_TOKEN,
    tools: chars.tools / CHARS_PER_TOKEN,
  };
  const messageTotal = estimated.user + estimated.assistant + estimated.reasoning + estimated.tools;
  const scale = messageTotal > usage.usedTokens && messageTotal > 0 ? usage.usedTokens / messageTotal : 1;
  const round = (value: number): number => Math.round(value * scale);
  const used = [
    { name: t("context.userMessages"), tokens: round(estimated.user) },
    { name: t("context.assistantMessages"), tokens: round(estimated.assistant) },
    { name: t("context.reasoning"), tokens: round(estimated.reasoning) },
    { name: t("context.toolCalls"), tokens: round(estimated.tools) },
  ];
  const accounted = used.reduce((sum, row) => sum + row.tokens, 0);
  const categories: ContextBreakdown["categories"] = [
    { name: t("context.systemPrompt"), tokens: Math.max(0, usage.usedTokens - accounted), kind: "used" },
    ...used.filter((row) => row.tokens > 0).map((row) => ({ ...row, kind: "used" as const })),
    ...(usage.maxTokens !== null ? [{ name: t("context.freeSpace"), tokens: Math.max(0, usage.maxTokens - usage.usedTokens), kind: "free" as const }] : []),
  ];
  const tools = [...perTool.entries()]
    .map(([name, toolChars]) => ({ name, tokens: Math.round((toolChars / CHARS_PER_TOKEN) * scale) }))
    .filter((row) => row.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);
  return {
    usedTokens: usage.usedTokens,
    maxTokens: usage.maxTokens,
    cachedInputTokens: usage.cachedInputTokens,
    autoCompactThreshold: usage.autoCompactThreshold,
    compactsAutomatically: usage.compactsAutomatically,
    ...(usage.costUsd === null ? {} : { costUsd: usage.costUsd }),
    categories,
    estimated: true,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * The live provider breakdown when it names what fills the window,
 * otherwise the transcript estimate above — so a total-only reading still
 * shows user/assistant/reasoning/tools shares instead of "reports the total
 * only". Null when neither exists.
 */
export function effectiveContextBreakdown(
  live: ContextBreakdown | null | undefined,
  fallback: ContextUsage | null | undefined,
  messages: readonly MessageEnvelope[],
  activities: readonly ActivityEnvelope[],
): ContextBreakdown | null {
  if (live !== null && live !== undefined && live.categories.length > 0) return live;
  return estimateContextBreakdown(fallback, messages, activities);
}

const SHORT_BY_KIND: Record<string, string> = { session: "5h", weekly: "wk", monthly: "mo" };

function isClaudeGptWindow(window: { id: string; label: string }): boolean {
  return window.id.startsWith("claude-gpt") || window.id.startsWith("3p-") || /\bClaude\s*&\s*GPT\b/iu.test(window.label);
}

function windowSuffix(label: string): string | null {
  const parts = label.split(/\s+[–-]\s+/u);
  if (parts.length < 2) return null;
  const suffix = parts.at(-1)?.trim() ?? "";
  return suffix.length > 0 ? suffix : null;
}

export interface PlanUsageGroup<W extends { id: string; kind: string; label: string }> {
  title: string | null;
  rows: Array<{ window: W; label: string }>;
}

/**
 * Group plan-usage windows into subcategories when a provider reports
 * multiple model-family pools (Antigravity's `Gemini` and `Claude & GPT`),
 * shortening inner row labels to `5h`, `Weekly` and per-model names (`Argon`).
 * Single-pool providers keep a single untitled group with their original labels.
 */
export function planUsageGroups<W extends { id: string; kind: string; label: string }>(
  windows: ReadonlyArray<W>,
): PlanUsageGroup<W>[] {
  if (windows.length === 0) return [];
  const families: string[] = [];
  const addFamily = (name: string): void => {
    if (!families.includes(name)) families.push(name);
  };
  for (const window of windows) {
    if (window.kind === "session") {
      const suffix = windowSuffix(window.label);
      if (suffix !== null) addFamily(suffix);
    }
    if (window.id.startsWith("gemini-")) addFamily("Gemini");
    if (window.id.startsWith("claude-gpt-") || window.id.startsWith("3p-")) addFamily("Claude & GPT");
  }
  if (families.length === 0) {
    return [{ title: null, rows: windows.map((window) => ({ window, label: window.label })) }];
  }
  const byFamily = new Map<string, Array<{ window: W; label: string }>>(families.map((family) => [family, []]));
  for (const window of windows) {
    const suffix = windowSuffix(window.label);
    const family =
      window.id.startsWith("gemini-") && byFamily.has("Gemini")
        ? "Gemini"
        : (window.id.startsWith("claude-gpt-") || window.id.startsWith("3p-")) && byFamily.has("Claude & GPT")
          ? "Claude & GPT"
          : suffix !== null && byFamily.has(suffix)
            ? suffix
            : families[0]!;
    const label =
      suffix !== null && suffix !== family
        ? suffix
        : window.kind === "session"
          ? "5h"
          : window.kind === "weekly"
            ? "Weekly"
            : window.kind === "monthly"
              ? "Monthly"
              : window.label;
    byFamily.get(family)!.push({ window, label });
  }
  return [...byFamily.entries()]
    .filter(([, rows]) => rows.length > 0)
    .map(([title, rows]) => ({ title, rows }));
}

/**
 * The footer's compact reading of a provider's plan usage: the session
 * window and the main weekly one always, any other window (a per-model
 * weekly limit) only once it is past 70% — the point where it can bite.
 * Antigravity's secondary `Claude & GPT` pool is omitted here and shown
 * only in the extended Context panel.
 */
export function planUsageGauges(
  limits: { windows: ReadonlyArray<{ id: string; kind: string; label: string; usedPercent: number }> } | null | undefined,
): PlanUsageGauge[] {
  if (limits === null || limits === undefined) return [];
  const gauges: PlanUsageGauge[] = [];
  const seenKinds = new Set<string>();
  for (const window of limits.windows) {
    if (isClaudeGptWindow(window)) continue;
    const main = !seenKinds.has(window.kind) && SHORT_BY_KIND[window.kind] !== undefined;
    if (main) {
      seenKinds.add(window.kind);
      gauges.push({ short: SHORT_BY_KIND[window.kind]!, percent: window.usedPercent });
    } else if (window.usedPercent >= 70) {
      // "Weekly – Opus" → "Opus".
      const name = window.label.split(/[–-]/u).pop()?.trim() || window.label;
      gauges.push({ short: name, percent: window.usedPercent });
    }
  }
  return gauges;
}

export interface CompactPlanUsageSummary {
  readonly text: string;
  readonly tone: "normal" | "warn" | "danger";
}

/**
 * Resolve the live usage limits for a specific provider instance, without
 * bleeding driver-level legacy buckets across multi-account instances
 * (`claude/work`, `chatgpt/personal`, `antigravity/work`).
 */
export function providerUsageLimitsFor<
  L extends { windows: ReadonlyArray<{ id: string; kind: string; label: string; usedPercent: number; resetsAt?: string | null }>; credits?: number | null },
>(
  planUsage: Readonly<Record<string, L>> | null | undefined,
  provider: { readonly instanceId: string; readonly driver?: string; readonly usageLimits?: L | null } | null | undefined,
): L | null {
  if (!provider) return null;
  const exact = planUsage?.[provider.instanceId];
  if (exact !== undefined) return exact;
  const lower = provider.instanceId.trim().toLowerCase();
  const isMultiAccount =
    lower.startsWith("claude/") ||
    lower.startsWith("chatgpt/") ||
    lower.startsWith("antigravity/") ||
    lower.startsWith("codex/");
  if (!isMultiAccount && provider.driver) {
    const byDriver = planUsage?.[provider.driver];
    if (byDriver !== undefined) return byDriver;
  }
  return provider.usageLimits ?? null;
}

/**
 * Single-line compact usage summary for model picker headers and account rows
 * (e.g. `5h 18% · wk 42%` or `5h 100% ↻ 45m`). Returns null when no usage
 * windows or credits have been reported.
 */
export function compactPlanUsage(
  limits: {
    readonly windows: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly label: string; readonly usedPercent: number; readonly resetsAt?: string | null }>;
    readonly credits?: number | null;
  } | null | undefined,
  formatReset?: (resetsAt: string) => string | null,
): CompactPlanUsageSummary | null {
  if (!limits) return null;
  const gauges = planUsageGauges(limits);
  if (gauges.length === 0) {
    if (typeof limits.credits === "number") {
      return { text: `${limits.credits.toLocaleString()} cr`, tone: "normal" };
    }
    return null;
  }
  const maxPct = Math.max(...gauges.map((g) => g.percent));
  const tone: "normal" | "warn" | "danger" = maxPct >= 90 ? "danger" : maxPct >= 70 ? "warn" : "normal";
  const parts = gauges.slice(0, 2).map((g) => `${g.short} ${Math.round(g.percent)}%`);
  if (maxPct >= 90 && formatReset) {
    const hot = limits.windows.find((w) => w.usedPercent >= 90 && w.resetsAt);
    const reset = hot?.resetsAt ? formatReset(hot.resetsAt) : null;
    if (reset) parts.push(reset);
  }
  return { text: parts.join(" · "), tone };
}

/**
 * A subagent's last message as a short preview: the report is markdown
 * (`---` rules, `# headings`, `**bold**`), which reads as noise squeezed into
 * two panel lines. Strip the marks and run the lines together.
 */
export function subagentPreview(text: string): string {
  return text
    .replace(/^\s*(?:[-*_]{3,}|={3,})\s*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
