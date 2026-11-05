import type { QueryResults } from "../../server/protocol.js";
import type { Notice } from "../ui/noticebanner.js";
import { COLOR } from "../theme.js";
import { t } from "../i18n/index.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import { driverKindOfInstance, type ThreadEnvelope } from "../../core/types.js";
import { formatDuration } from "./turns.js";

type UsageQueueEntry = QueryResults["usage.protection"]["queue"][number];
export type UsageQueueAction = "first" | "last" | "cancel";

/**
 * What one recovering thread says about itself. `resuming` is written when the
 * recovery turn is promoted to running and cleared when it settles, so it is
 * the whole time the work is running again: no countdown, no waiting line, and
 * no Move/Cancel (cancelling would interrupt the turn the thread is running).
 * A reset time already passed is never counted down.
 */
export function usageQueueStatus(entry: UsageQueueEntry, now: number): { phase: string; detail: string; running: boolean; actions: readonly UsageQueueAction[] } {
  const running = entry.phase === "resuming" && !entry.error;
  const phase = entry.phase === "pending" ? t("protection.pending") : entry.phase === "wrapping" ? t("protection.wrapping")
    : entry.phase === "waiting" ? t("protection.waiting") : running ? t("protection.resumed") : t("protection.resuming");
  if (running) return { phase, detail: t("protection.resumedDetail"), running, actions: [] };
  const resetsAt = entry.resetsAt === null ? null : Date.parse(entry.resetsAt);
  const detail = entry.error ?? (resetsAt === null || Number.isNaN(resetsAt) ? t("protection.noReset")
    : resetsAt <= now ? t("protection.resetDone") : t("protection.reset", { time: formatDuration(resetsAt - now, "minutes") }));
  return { phase, detail, running, actions: ["first", "last", "cancel"] };
}

export function usageProtectionNotices(
  state: QueryResults["usage.protection"],
  act: (command: { type: "usage.wrap"; provider: string } | { type: "usage.queue"; threadId: string; direction: "first" | "last" | "cancel" }) => void,
  now: number,
  providers: readonly ProviderSummary[] | null = null,
): Notice[] {
  const providerName = (key: string): string =>
    providers?.find((provider) => provider.instanceId.toLowerCase() === key)?.displayName
    ?? providers?.find((provider) => driverKindOfInstance(provider.instanceId) === key)?.displayName
    ?? key;
  const notices: Notice[] = state.forecasts.filter((forecast) => forecast.shouldWrap).map((forecast) => ({
    key: `forecast:${forecast.provider}:${forecast.windowId}`,
    glyph: "◔", glyphColor: COLOR.warn,
    title: t("protection.forecast", {
      provider: providerName(forecast.provider),
      window: forecast.label, percent: Math.round(forecast.usedPercent),
    }),
    detail: <text fg={COLOR.dim} selectable={false}>{t("protection.detail", {
      work: forecast.remainingWorkMs === null ? t("protection.unknown") : formatDuration(forecast.remainingWorkMs, "minutes"),
      reset: forecast.resetsAt === null ? t("protection.unknown") : formatDuration(Date.parse(forecast.resetsAt) - now, "minutes"),
    })}</text>,
    actions: [{ label: t("protection.wrap"), fg: COLOR.accent, onClick: () => act({ type: "usage.wrap", provider: forecast.provider }) }],
  }));
  for (const [index, entry] of state.queue.entries()) {
    const status = usageQueueStatus(entry, now);
    const labels: Record<UsageQueueAction, { label: string; fg: string }> = {
      first: { label: t("protection.first"), fg: COLOR.accent },
      last: { label: t("protection.last"), fg: COLOR.accent },
      cancel: { label: t("protection.cancel"), fg: COLOR.dim },
    };
    notices.push({
      key: `usage-queue:${entry.threadId}`, glyph: status.running ? "▶" : "◷", glyphColor: entry.error ? COLOR.danger : status.running ? COLOR.accent : COLOR.warn,
      title: t("protection.queued", { position: index + 1, title: entry.title, phase: status.phase }),
      detail: <text fg={COLOR.dim} selectable={false}>{status.detail}</text>,
      actions: status.actions.map((direction) => ({ ...labels[direction], onClick: () => act({ type: "usage.queue", threadId: entry.threadId, direction }) })),
    });
  }
  return notices;
}

/**
 * The open thread's own hold, one line over the composer: that it is protected,
 * whether by the user, and how many automatic wake-ups wait. A forced hold
 * says what ends it, since no reset will.
 */
export function threadProtectionNotice(protection: NonNullable<ThreadEnvelope["protection"]>): Notice {
  const waiting = protection.waitingWakeUps;
  return {
    key: "thread-protected",
    glyph: "◔", glyphColor: COLOR.warn,
    title: t(protection.forced ? "protection.heldByYou" : "protection.held"),
    ...(waiting > 0 ? { tags: [{ text: t("protection.wakeUps", { count: waiting }), color: COLOR.dim }] } : {}),
    detail: <text fg={COLOR.dim} selectable={false}>{t(protection.forced ? "protection.heldByYouDetail" : "protection.heldDetail")}</text>,
    actions: [],
  };
}
