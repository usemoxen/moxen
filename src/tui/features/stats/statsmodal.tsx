import { useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
import type { ClientApi } from "../../../server/api.js";
import { currentLanguage, t } from "../../i18n/index.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import {
  STATS_RANGES,
  WEEKDAY_ROWS,
  formatCost,
  formatCount,
  formatHour,
  formatPercent,
  heatmap,
  OTHER_KEY,
  stackedBars,
  tallestColumn,
  topModels,
  type StatsBucket,
  type StatsRange,
  type UsageStats,
} from "../../model/stats.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { ModalShell } from "../../ui/modalshell.js";
import { COLOR, SURFACE, lerpColor, truncate } from "../../theme.js";
import { useUsageStats } from "./useUsageStats.js";

type StatsTab = "overview" | "models";
const TABS: readonly StatsTab[] = ["overview", "models"];
const CHART_ROWS = 8;
/** Models given a colour of their own; the rest share one grey. */
const LISTED_MODELS = 7;
const LABEL_COLUMN = 6;

const RANGE_LABEL = (): Record<StatsRange, string> => ({ all: t("stats.range.all"), "30d": t("stats.range.30d"), "7d": t("stats.range.7d") });
const TAB_LABEL = (): Record<StatsTab, string> => ({ overview: t("stats.tab.overview"), models: t("stats.tab.models") });

/** One colour per model, in the order the legend lists them; neighbours are kept apart in hue. */
function modelColors(): readonly string[] {
  return [COLOR.accent, COLOR.user, COLOR.warn, COLOR.tool, COLOR.removed, COLOR.command, COLOR.agent, COLOR.added];
}

function modelName(key: string, otherCount = 0): string {
  if (key === OTHER_KEY) return t("stats.otherModels", { count: otherCount });
  return key === "unknown" ? t("stats.unknownModel") : key;
}

function shortDate(day: Date): string {
  return day.toLocaleDateString(currentLanguage(), { month: "short", day: "numeric" });
}

/** The cost of a bucket in words: a figure (with a plus where some turns reported none), or that nobody did. */
function costText(costUsd: number | null, unpricedTurns: number): string {
  if (costUsd === null) return t("stats.unpriced");
  return unpricedTurns > 0 ? `${formatCost(costUsd)}+` : formatCost(costUsd);
}

function monthName(month: number): string {
  return new Date(2000, month, 1).toLocaleString(currentLanguage(), { month: "short" });
}

function Tile({ label, value, width }: { label: string; value: string; width: number }) {
  return (
    <box style={{ flexDirection: "column", width, height: 2, flexShrink: 0 }}>
      <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(label, width - 1)}</text>
      <text fg={COLOR.bright} bg={SURFACE.raised}>{truncate(value, width - 1)}</text>
    </box>
  );
}

function Heatmap({ all, range, inner, now }: { all: UsageStats; range: StatsRange; inner: number; now: Date }) {
  const weeks = Math.max(4, Math.min(53, Math.floor((inner - 2) / 2)));
  const map = heatmap(all.daily, now, weeks, range);
  const header = Array.from({ length: LABEL_COLUMN / 2 + weeks * 2 }, () => " ");
  for (const { week, month } of map.monthStarts) {
    const name = monthName(month);
    const at = 2 + week * 2;
    // A month name that would run into the next one is left out.
    if (at + name.length <= header.length && header.slice(at, at + name.length + 1).every((cell) => cell === " ")) {
      name.split("").forEach((char, index) => (header[at + index] = char));
    }
  }
  // Active days before the range stay on screen, in grey.
  const muted = lerpColor(COLOR.faint, COLOR.dim, 0.5);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{header.join("")}</text>
      {map.rows.map((row, weekday) => (
        <box key={weekday} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{`${WEEKDAY_ROWS[weekday]} `}</text>
          {row.map((cell, week) =>
            cell === null ? (
              <text key={week} fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"  "}</text>
            ) : cell.muted ? (
              <text key={week} fg={muted} bg={SURFACE.raised} selectable={false}>{"■ "}</text>
            ) : cell.level === 0 ? (
              <text key={week} fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"· "}</text>
            ) : (
              <text key={week} fg={lerpColor(COLOR.faint, COLOR.accent, cell.level / 4)} bg={SURFACE.raised} selectable={false}>{"■ "}</text>
            ),
          )}
        </box>
      ))}
    </box>
  );
}

function Overview({ stats, all, range, inner, now }: { stats: UsageStats; all: UsageStats; range: StatsRange; inner: number; now: Date }) {
  const column = Math.floor(inner / 3);
  const row = (tiles: ReadonlyArray<readonly [string, string]>) => (
    <box style={{ flexDirection: "row", height: 2, flexShrink: 0, marginBottom: 1 }}>
      {tiles.map(([label, value]) => (
        <Tile key={label} label={label} value={value} width={column} />
      ))}
    </box>
  );
  return (
    <>
      {row([
        [t("stats.sessions"), String(stats.sessions)],
        [t("stats.messages"), stats.messages.toLocaleString(currentLanguage())],
        [t("stats.tokens"), formatCount(stats.totalTokens)],
      ])}
      {row([
        [t("stats.activeDays"), String(stats.activeDays)],
        [t("stats.peakHour"), stats.peakHour === null ? "—" : formatHour(stats.peakHour)],
        [t("stats.favoriteModel"), stats.favoriteModel === null ? "—" : modelName(stats.favoriteModel)],
      ])}
      {row([
        [t("stats.bestStreak"), t("stats.days", { count: stats.bestStreak })],
        [t("stats.cost"), costText(stats.costUsd, stats.unpricedTurns)],
        [t("stats.turns"), String(stats.turns)],
      ])}
      <Heatmap all={all} range={range} inner={inner} now={now} />
    </>
  );
}

/** Runs of one colour in a chart row, so a row is a few texts and not a cell each. */
function runs(cells: ReadonlyArray<string | null>): ReadonlyArray<{ readonly color: string | null; readonly width: number }> {
  const out: Array<{ color: string | null; width: number }> = [];
  for (const color of cells) {
    const last = out[out.length - 1];
    if (last && last.color === color) last.width += 1;
    else out.push({ color, width: 1 });
  }
  return out;
}

function usageLine(bucket: StatsBucket): string {
  return t("stats.usageLine", {
    cached: formatCount(bucket.usage.cacheRead + bucket.usage.cacheCreate),
    input: formatCount(bucket.usage.input),
    output: formatCount(bucket.usage.output + bucket.usage.thinking),
  });
}

function Models({
  stats,
  inner,
  now,
  providerNames,
}: {
  stats: UsageStats;
  inner: number;
  now: Date;
  providerNames: ReadonlyMap<string, string>;
}) {
  const colors = modelColors();
  const { buckets, otherCount } = topModels(stats.byModel, LISTED_MODELS);
  // The chart paints a model the list names in its colour, and everything else in the grey of the "other" row.
  const grey = COLOR.dim;
  const colorOf = (key: string): string => {
    const at = buckets.findIndex((bucket) => bucket.key === key);
    return at === -1 || buckets[at]!.key === OTHER_KEY ? grey : colors[at % colors.length]!;
  };
  const plot = Math.max(8, inner - LABEL_COLUMN);
  const first = stats.daily[0];
  const span =
    stats.range === "7d" ? 7 : stats.range === "30d" ? 30 : first === undefined ? 7 : Math.max(7, Math.round((now.getTime() - new Date(`${first.day}T00:00:00`).getTime()) / 86_400_000) + 1);
  // A column a day when they fit (two cells wide if there is room), else several days to a column.
  const perColumn = span <= plot ? 1 : Math.ceil(span / plot);
  const columns = Math.ceil(span / perColumn);
  const wide = perColumn === 1 && columns * 2 <= plot;
  const bars = stackedBars(stats.daily, now, columns, CHART_ROWS, perColumn);
  const busiest = Math.max(0, ...bars.map((segments) => segments.reduce((all, segment) => all + segment.rows, 0)));
  const peak = tallestColumn(stats.daily, now, columns, perColumn);
  const rowCells = (rowIndex: number): Array<string | null> =>
    bars.flatMap((segments) => {
      let floor = 0;
      let color: string | null = null;
      for (const segment of segments) {
        if (rowIndex >= floor && rowIndex < floor + segment.rows) color = colorOf(segment.key);
        floor += segment.rows;
      }
      return wide ? [color, color] : [color];
    });
  const nameWidth = Math.max(10, inner - 58);
  const chartWidth = columns * (wide ? 2 : 1);
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (columns * perColumn - 1));
  const axis = shortDate(startDay);
  const axisEnd = t("stats.today");
  const providers = stats.byProvider.filter((bucket) => bucket.tokens > 0);
  return (
    <>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("stats.chartTitle")}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{perColumn > 1 ? t("stats.chartDays", { count: perColumn }) : ""}</text>
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
        {Array.from({ length: CHART_ROWS }, (_, index) => CHART_ROWS - 1 - index).map((rowIndex) => (
          <box key={rowIndex} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
              {(rowIndex === CHART_ROWS - 1 && busiest > 0 ? formatCount(peak) : rowIndex === 0 ? "0" : "").padStart(LABEL_COLUMN - 1) + " "}
            </text>
            {runs(rowCells(rowIndex)).map((run, at) => (
              <text key={at} fg={run.color ?? SURFACE.raised} bg={SURFACE.raised} selectable={false}>
                {(run.color === null ? " " : "█").repeat(run.width)}
              </text>
            ))}
          </box>
        ))}
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
            {" ".repeat(LABEL_COLUMN) + axis + " ".repeat(Math.max(1, chartWidth - axis.length - axisEnd.length)) + axisEnd}
          </text>
        </box>
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
        {buckets.map((bucket) => (
          <box key={bucket.key} style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
            <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
              <text fg={colorOf(bucket.key)} bg={SURFACE.raised} selectable={false}>{"■ "}</text>
              <text fg={COLOR.text} bg={SURFACE.raised}>{truncate(modelName(bucket.key, otherCount), nameWidth)}</text>
            </box>
            <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
              {`${usageLine(bucket)}  ${costText(bucket.costUsd, bucket.unpricedTurns)}  ${formatPercent(bucket.share)}`}
            </text>
          </box>
        ))}
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{t("stats.byProvider")}</text>
        {providers.map((bucket) => (
          <box key={bucket.key} style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
            <text fg={COLOR.text} bg={SURFACE.raised}>{truncate(providerNames.get(bucket.key) ?? bucket.key, nameWidth)}</text>
            <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
              {`${t("stats.sessionsCount", { count: bucket.sessions })}  ${t("stats.tokensOf", { count: formatCount(bucket.tokens) })}  ${costText(bucket.costUsd, bucket.unpricedTurns)}  ${formatPercent(bucket.share)}`}
            </text>
          </box>
        ))}
      </box>
    </>
  );
}

/**
 * Usage across every thread and provider, opened from the sidebar's footer:
 * an overview (counts, activity heatmap) and a models tab (daily tokens by
 * model, and what each model and provider spent), over all time, 30 days or 7.
 */
export function StatsModal({
  client,
  providers,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
  onCopyCard,
  now = new Date(),
}: {
  client: Pick<ClientApi, "query">;
  providers: readonly ProviderSummary[] | null | undefined;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
  /** Copies the shareable card for the range on screen. */
  onCopyCard: (range: StatsRange) => void;
  /** The clock the heatmap and chart end on; tests pin it. */
  now?: Date;
}) {
  const [tab, setTab] = useState<StatsTab>("overview");
  const [range, setRange] = useState<StatsRange>("all");
  const { stats, all, loading, error } = useUsageStats(client, true, range);
  const providerNames = new Map((providers ?? []).map((provider) => [provider.instanceId, provider.displayName ?? provider.instanceId] as const));
  const inner = Math.max(20, width - 4);

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "esc") {
      markModalDismissed();
      onClose();
    } else if (key.name === "tab" || key.name === "right" || key.name === "left") {
      setTab((current) => (current === "overview" ? "models" : "overview"));
    } else if (key.sequence === "s") {
      onCopyCard(range);
    } else if (key.sequence === "r") {
      setRange((current) => STATS_RANGES[(STATS_RANGES.indexOf(current) + 1) % STATS_RANGES.length]!);
    }
  });

  let body: ReactNode;
  if (stats === null || all === null) {
    body = (
      <text fg={error === null ? COLOR.faint : COLOR.danger} bg={SURFACE.raised} selectable={false}>
        {error === null ? t("stats.loading") : t("stats.error", { message: error })}
      </text>
    );
  } else if (stats.turns === 0) {
    body = <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{t("stats.empty")}</text>;
  } else {
    body = tab === "overview" ? <Overview stats={stats} all={all} range={range} inner={inner} now={now} /> : <Models stats={stats} inner={inner} now={now} providerNames={providerNames} />;
  }

  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          {TABS.map((name) => (
            <HoverButton
              key={name}
              label={` ${TAB_LABEL()[name]} `}
              fg={name === tab ? COLOR.bright : COLOR.dim}
              hoverFg={COLOR.bright}
              {...(name === tab ? { bg: SURFACE.hover } : {})}
              onClick={() => setTab(name)}
            />
          ))}
        </box>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          {STATS_RANGES.map((name) => (
            <HoverButton
              key={name}
              label={` ${RANGE_LABEL()[name]} `}
              fg={name === range ? COLOR.bright : COLOR.dim}
              hoverFg={COLOR.bright}
              {...(name === range ? { bg: SURFACE.hover } : {})}
              onClick={() => setRange(name)}
            />
          ))}
          <HoverButton label=" esc" fg={COLOR.faint} hoverFg={COLOR.text} onClick={onClose} />
        </box>
      </box>
      <scrollbox style={{ flexGrow: 1, marginTop: 1 }}>{body}</scrollbox>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between", marginTop: 1 }}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <HoverButton label={t("stats.copyCard")} fg={COLOR.dim} hoverFg={COLOR.bright} onClick={() => onCopyCard(range)} />
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(` · ${t("stats.hint")}`, Math.max(0, inner - 40))}</text>
        </box>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{loading ? t("stats.updating") : stats !== null && stats.unpricedTurns > 0 && stats.costUsd !== null ? t("stats.costNote") : ""}</text>
      </box>
    </ModalShell>
  );
}
