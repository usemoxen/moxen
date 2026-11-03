import type { QueryResults } from "../../server/protocol.js";
import type { Notice } from "../ui/noticebanner.js";
import { COLOR } from "../theme.js";
import { t } from "../i18n/index.js";
import type { ProviderSummary } from "../../core/catalog/summary.js";
import { driverKindOfInstance } from "../../core/types.js";
import { formatDuration } from "./turns.js";

export function usageProtectionNotices(
  state: QueryResults["usage.protection"],
  act: (command: { type: "usage.wrap"; provider: string } | { type: "usage.queue"; threadId: string; direction: "first" | "last" | "cancel" }) => void,
  now: number,
  providers: readonly ProviderSummary[] | null = null,
): Notice[] {
  const notices: Notice[] = state.forecasts.filter((forecast) => forecast.shouldWrap).map((forecast) => ({
    key: `forecast:${forecast.provider}:${forecast.windowId}`,
    glyph: "◔", glyphColor: COLOR.warn,
    title: t("protection.forecast", {
      provider: providers?.find((provider) => driverKindOfInstance(provider.instanceId) === forecast.provider)?.displayName ?? forecast.provider,
      window: forecast.label, percent: Math.round(forecast.usedPercent),
    }),
    detail: <text fg={COLOR.dim} selectable={false}>{t("protection.detail", {
      work: forecast.remainingWorkMs === null ? t("protection.unknown") : formatDuration(forecast.remainingWorkMs, "minutes"),
      reset: forecast.resetsAt === null ? t("protection.unknown") : formatDuration(Date.parse(forecast.resetsAt) - now, "minutes"),
    })}</text>,
    actions: [{ label: t("protection.wrap"), fg: COLOR.accent, onClick: () => act({ type: "usage.wrap", provider: forecast.provider }) }],
  }));
  for (const [index, entry] of state.queue.entries()) {
    const phase = entry.phase === "pending" ? t("protection.pending") : entry.phase === "wrapping" ? t("protection.wrapping") : entry.phase === "waiting" ? t("protection.waiting") : t("protection.resuming");
    notices.push({
      key: `usage-queue:${entry.threadId}`, glyph: "◷", glyphColor: entry.error ? COLOR.danger : COLOR.warn,
      title: t("protection.queued", { position: index + 1, title: entry.title, phase }),
      detail: <text fg={COLOR.dim} selectable={false}>{entry.error ?? (entry.resetsAt === null
        ? t("protection.noReset") : t("protection.reset", { time: formatDuration(Date.parse(entry.resetsAt) - now, "minutes") }))}</text>,
      actions: [
        { label: t("protection.first"), fg: COLOR.accent, onClick: () => act({ type: "usage.queue", threadId: entry.threadId, direction: "first" }) },
        { label: t("protection.last"), fg: COLOR.accent, onClick: () => act({ type: "usage.queue", threadId: entry.threadId, direction: "last" }) },
        { label: t("protection.cancel"), fg: COLOR.dim, onClick: () => act({ type: "usage.queue", threadId: entry.threadId, direction: "cancel" }) },
      ],
    });
  }
  return notices;
}
