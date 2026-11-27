import { spawn } from "node:child_process";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyLayer } from "../../hooks/useKeyLayer.js";

import type { ProviderSummary, ProviderUsageLimits } from "../../../core/catalog/summary.js";
import {
  summarizeUpdateStatus,
  UPDATABLE_PROVIDERS,
  versionNumber,
  type LatestVersions,
  type ProviderUpdateAllItem,
  type UpdatableProvider,
} from "../../../core/catalog/update.js";
import type { SettingSection } from "../../../core/configschema.js";
import {
  ACCOUNT_PROVIDER_KINDS,
  managedAccountHomeDisplayPath,
  type AccountProviderKind,
  type ProviderAccountSaveInput,
  type ProviderAccountSummary,
} from "../../../core/types.js";
import { useClipboard } from "../../hooks/useClipboard.js";
import { useHover } from "../../hooks/useHover.js";
import { t } from "../../i18n/index.js";
import { providerVersionLine, type ProviderCheckView } from "../../model/settings.js";
import { compactPlanUsage, planUsageGroups, providerUsageLimitsFor } from "../../model/sidepanel.js";
import { untilLabel } from "../../model/thread.js";
import { COLOR, SURFACE } from "../../theme.js";
import { Chip } from "../../ui/chip.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { TextField } from "./textfield.js";

const KIND_NAME: Record<AccountProviderKind, string> = {
  claude: "Claude Code",
  chatgpt: "ChatGPT",
  antigravity: "Antigravity",
};

const SHORT_KIND_NAME: Record<AccountProviderKind, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  antigravity: "Antigravity",
};

/** Compact top-level sidebar label for an independent configured provider profile. */
export function profileSidebarLabel(account: Pick<ProviderAccountSummary, "kind" | "label">): string {
  return `${SHORT_KIND_NAME[account.kind]} · ${account.label}`;
}

type AddableProviderKind = AccountProviderKind | "opencode" | "vibe";

function addableKindName(kind: AddableProviderKind): string {
  if (kind === "opencode") return "OpenCode";
  if (kind === "vibe") return "Mistral Vibe";
  return KIND_NAME[kind];
}

function addableKindDescription(kind: AddableProviderKind): string {
  if (kind === "opencode") return t("settings.providers.kindDesc.opencode");
  if (kind === "vibe") return t("settings.providers.kindDesc.vibe");
  return kindDescription(kind);
}

function cliDisplayName(cli: UpdatableProvider): string {
  if (cli === "claude") return "Claude Code";
  if (cli === "opencode") return "OpenCode";
  if (cli === "antigravity") return "Antigravity";
  if (cli === "vibe") return "Mistral Vibe";
  return t("settings.providers.codexCompanionName");
}

function kindDescription(kind: AccountProviderKind): string {
  if (kind === "claude") return t("settings.providers.kindDesc.claude");
  if (kind === "chatgpt") return t("settings.providers.kindDesc.chatgpt");
  return t("settings.providers.kindDesc.antigravity");
}

function kindToSection(kind: AccountProviderKind): SettingSection {
  return kind === "claude" ? "provider:claude" : kind === "chatgpt" ? "provider:chatgpt" : "provider:antigravity";
}

function defaultHomeHint(kind: AccountProviderKind, id: string): string {
  return managedAccountHomeDisplayPath(kind, id);
}

function defaultIdPlaceholder(): string {
  return "personal";
}

function isCliAuthenticated(account: ProviderAccountSummary, catalog: readonly ProviderSummary[] | null): boolean {
  if (account.email) return true;
  if (account.signedIn !== null) return account.signedIn;
  const live = catalog?.find((entry) => entry.instanceId === account.instanceId);
  return live?.authStatus !== null && live?.authStatus !== undefined && live.authStatus !== "unauthenticated";
}

function accountStatusLine(account: ProviderAccountSummary, catalog: readonly ProviderSummary[] | null): string {
  // A gated Antigravity account (multiple accounts off, the default) is
  // disabled with the reason, ahead of the user's own toggle and sign-in.
  if (account.disabledReason) return account.disabledReason;
  if (!account.enabled) return t("settings.providers.disabled");
  const parts: string[] = [];
  if (account.email) {
    parts.push(t("settings.providers.authenticatedAs", { email: account.email }));
  } else if (account.kind === "chatgpt") {
    parts.push(account.signedIn ? t("settings.providers.signedIn") : t("settings.providers.notSignedIn"));
  } else {
    const live = catalog?.find((entry) => entry.instanceId === account.instanceId);
    if (live?.status) parts.push(live.status);
    else if (account.signedIn === true || (live?.authStatus && live.authStatus !== "unauthenticated")) {
      parts.push(t("settings.providers.authenticated"));
    } else if (account.signedIn === false) {
      parts.push(t("settings.providers.notSignedIn"));
    } else if (account.homePath) {
      parts.push(account.homePath);
    }
  }
  if (account.planType) parts.push(account.planType);
  if (account.codexVerified) parts.push(t("settings.providers.codexVerified"));
  return parts.join(" · ");
}

function formatEnvMap(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function parseEnvText(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const out: Record<string, string> = {};
  for (const piece of trimmed.split(/[,\n]/u)) {
    const entry = piece.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    if (key) out[key] = entry.slice(eq + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

type DetailFieldId = "label" | "binaryPath" | "homePath" | "launchArgs" | "model" | "thinkingEffort" | "env";
type DetailGroup = "identity" | "runtime" | "defaults" | "env";

interface DetailField {
  readonly id: DetailFieldId;
  readonly group: DetailGroup;
  readonly label: string;
  readonly value: string;
}

function detailGroupTitle(group: DetailGroup): string {
  if (group === "identity") return t("settings.providers.group.identity");
  if (group === "runtime") return t("settings.providers.group.runtime");
  if (group === "defaults") return t("settings.providers.group.defaults");
  return t("settings.providers.group.env");
}

function fieldsForAccount(account: ProviderAccountSummary): readonly DetailField[] {
  const isChatGpt = account.kind === "chatgpt";
  return [
    { id: "label", group: "identity", label: t("settings.providers.field.label"), value: account.label },
    {
      id: "binaryPath",
      group: "runtime",
      label: t("settings.providers.field.binaryPath"),
      value: (isChatGpt ? account.codexBinaryPath : account.binaryPath) ?? "",
    },
    ...(account.kind === "antigravity"
      ? []
      : [{
          id: "homePath" as const,
          group: "runtime" as const,
          label: isChatGpt
            ? t("settings.providers.field.codexHomePath")
            : t("settings.providers.field.homePath"),
          value: (isChatGpt ? account.codexHomePath : account.homePath) ?? "",
        }]),
    {
      id: "launchArgs",
      group: "runtime",
      label: t("settings.providers.field.launchArgs"),
      value: (isChatGpt ? account.codexLaunchArgs : account.launchArgs) ?? "",
    },
    { id: "model", group: "defaults", label: t("settings.providers.field.model"), value: account.model ?? "" },
    {
      id: "thinkingEffort",
      group: "defaults",
      label: t("settings.providers.field.thinkingEffort"),
      value: account.thinkingEffort ?? "",
    },
    { id: "env", group: "env", label: t("settings.providers.field.env"), value: formatEnvMap(account.env) },
  ];
}

function toggleLabel(enabled: boolean): string {
  return enabled ? `● ${t("settings.providers.statusOn")}` : `○ ${t("settings.providers.statusOff")}`;
}

function ruledRule(label: string, width: number): string {
  return "─".repeat(Math.max(0, width - label.length - 4));
}

function openBrowserUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", parsed.toString()] : [parsed.toString()];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // URL is displayed on screen as fallback.
  }
}

function SectionHeading({ label, width, first }: { label: string; width: number; first?: boolean }) {
  return (
    <box
      style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: first ? 0 : 1, paddingLeft: 1 }}
      backgroundColor={SURFACE.raised}
      selectable={false}
    >
      <OverflowText fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false} width={Math.max(8, width - 3)}>
        {`${label} `}
      </OverflowText>
      <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
        {ruledRule(label, width)}
      </text>
    </box>
  );
}

function formatResetShort(resetsAt: string, now: number = Date.now()): string | null {
  const target = new Date(resetsAt);
  if (Number.isNaN(target.getTime())) return null;
  return `↻ ${untilLabel(target, now).replace(/^in /u, "")}`;
}

function usageToneColor(tone: "normal" | "warn" | "danger"): string {
  return tone === "danger" ? COLOR.danger : tone === "warn" ? COLOR.warn : COLOR.dim;
}

export function AccountUsageRows({
  limits,
  width,
  bg = SURFACE.panel,
  heading,
}: {
  limits: ProviderUsageLimits | null;
  width: number;
  bg?: string;
  heading?: string;
}) {
  if (!limits || (limits.windows.length === 0 && typeof limits.credits !== "number")) return null;
  const inner = Math.max(18, width - 4);
  const now = Date.now();
  const groups = planUsageGroups(limits.windows).map((group) => ({
    title: group.title,
    rows: group.rows.map(({ window, label }) => ({
      window,
      label,
      percent: `${Math.round(window.usedPercent)}%`,
      resetLabel: window.resetsAt ? formatResetShort(window.resetsAt, now) : null,
    })),
  }));
  const rows = groups.flatMap((group) => group.rows);
  const labelWidth = rows.length > 0 ? Math.min(Math.max(...rows.map((r) => r.label.length)), Math.max(6, Math.floor(inner * 0.3))) : 0;
  const percentWidth = rows.length > 0 ? Math.max(...rows.map((r) => r.percent.length)) : 0;
  const resetWidth = rows.length > 0 ? Math.max(0, ...rows.map((r) => r.resetLabel?.length ?? 0)) : 0;
  const valueWidth = percentWidth + (resetWidth > 0 ? resetWidth + 1 : 0);
  const barWidth = Math.max(4, inner - labelWidth - valueWidth - 2);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={bg} selectable={false}>
      {heading ? <text fg={COLOR.dim} bg={bg} selectable={false}>{heading}</text> : null}
      {groups.map((group, groupIndex) => (
        <box key={group.title ?? "default"} style={{ flexDirection: "column", flexShrink: 0, ...(groupIndex > 0 ? { marginTop: 1 } : {}) }} backgroundColor={bg}>
          {group.title === null ? null : <text fg={COLOR.dim} bg={bg} selectable={false}>{group.title}</text>}
          {group.rows.map(({ window, label, percent, resetLabel }) => {
            const fraction = Math.max(0, Math.min(1, window.usedPercent / 100));
            const filled = fraction <= 0 ? 0 : Math.max(1, Math.min(barWidth, Math.round(fraction * barWidth)));
            const empty = Math.max(0, barWidth - filled);
            const barColor = fraction >= 0.9 ? COLOR.danger : fraction >= 0.7 ? COLOR.warn : COLOR.accent;
            return (
              <box key={window.id} style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg}>
                <OverflowText fg={COLOR.text} bg={bg} width={labelWidth + 1} padToWidth suffix=" " selectable={false}>{label}</OverflowText>
                {/* An empty <text> still takes a cell: omit empty halves so 0% and 100% bars align identically. */}
                {filled > 0 ? <text fg={barColor} bg={bg} selectable={false}>{"█".repeat(filled)}</text> : null}
                {empty > 0 ? <text fg={COLOR.faint} bg={bg} selectable={false}>{"░".repeat(empty)}</text> : null}
                <text fg={COLOR.dim} bg={bg} selectable={false}>{` ${percent.padStart(percentWidth)}`}</text>
                {resetWidth > 0 ? <text fg={COLOR.faint} bg={bg} selectable={false}>{` ${(resetLabel ?? "").padEnd(resetWidth)}`}</text> : null}
              </box>
            );
          })}
        </box>
      ))}
      {typeof limits.credits === "number" ? (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between", ...(rows.length > 0 ? { marginTop: 1 } : {}) }} backgroundColor={bg}>
          <text fg={COLOR.dim} bg={bg} selectable={false}>{t("side.remaining_credits_9c4e")}</text>
          <text fg={COLOR.text} bg={bg} selectable={false}>{limits.credits.toLocaleString()}</text>
        </box>
      ) : null}
    </box>
  );
}

function AccountRowCard({
  id,
  account,
  version,
  status,
  usage,
  active,
  width,
  onOpen,
  onToggle,
}: {
  id: string;
  account: ProviderAccountSummary;
  version: string | null;
  status: string;
  usage: ProviderUsageLimits | null;
  active: boolean;
  width: number;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const toggleText = `${toggleLabel(account.enabled)}  ›`;
  const titleText = `${KIND_NAME[account.kind]} · ${account.label}`;
  const versionSuffix = version ? `  v${version}` : "";
  const leftWidth = Math.max(10, width - toggleText.length - 6);
  const subText = `${account.instanceId}${status ? ` · ${status}` : ""}`;
  const compact = compactPlanUsage(usage, formatResetShort);
  const subWidth = Math.max(10, width - 5 - (compact ? compact.text.length + 2 : 0));
  return (
    <box
      id={id}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      onMouseDown={onOpen}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", flexShrink: 1 }} backgroundColor={bg}>
          <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
            {active ? "▌ " : "  "}
          </text>
          <OverflowText fg={active ? COLOR.bright : COLOR.text} bg={bg} width={leftWidth} active={active || hovered} selectable={false}>
            {`${titleText}${versionSuffix}`}
          </OverflowText>
        </box>
        <box onMouseDown={onToggle} backgroundColor={bg}>
          <text fg={account.enabled ? COLOR.added : COLOR.dim} bg={bg} selectable={false}>
            {toggleText}
          </text>
        </box>
      </box>
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 2, justifyContent: "space-between" }} backgroundColor={bg}>
        <OverflowText fg={COLOR.dim} bg={bg} width={subWidth} active={active || hovered} selectable={false}>
          {subText}
        </OverflowText>
        {compact ? (
          <text fg={usageToneColor(compact.tone)} bg={bg} selectable={false}>{compact.text}</text>
        ) : null}
      </box>
    </box>
  );
}

function OpencodeOverviewRow({
  id,
  version,
  usage,
  active,
  width,
  onOpen,
  onDisable,
}: {
  id: string;
  version: string | null;
  usage: ProviderUsageLimits | null;
  active: boolean;
  width: number;
  onOpen: () => void;
  onDisable: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const toggleText = `${toggleLabel(true)}  ›`;
  const titleText = `OpenCode${version ? `  v${version}` : ""}`;
  const leftWidth = Math.max(10, width - toggleText.length - 6);
  const compact = compactPlanUsage(usage, formatResetShort);
  const subWidth = Math.max(10, width - 5 - (compact ? compact.text.length + 2 : 0));
  return (
    <box
      id={id}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      onMouseDown={onOpen}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", flexShrink: 1 }} backgroundColor={bg}>
          <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
            {active ? "▌ " : "  "}
          </text>
          <OverflowText fg={active ? COLOR.bright : COLOR.text} bg={bg} width={leftWidth} active={active || hovered} selectable={false}>
            {titleText}
          </OverflowText>
        </box>
        <box onMouseDown={onDisable} backgroundColor={bg}>
          <text fg={COLOR.added} bg={bg} selectable={false}>
            {toggleText}
          </text>
        </box>
      </box>
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 2, justifyContent: "space-between" }} backgroundColor={bg}>
        <OverflowText fg={COLOR.dim} bg={bg} width={subWidth} active={active || hovered} selectable={false}>
          {t("settings.providers.opencodeSubtitle")}
        </OverflowText>
        {compact ? (
          <text fg={usageToneColor(compact.tone)} bg={bg} selectable={false}>{compact.text}</text>
        ) : null}
      </box>
    </box>
  );
}

function VibeOverviewRow({
  id,
  version,
  usage,
  active,
  width,
  onOpen,
  onDisable,
}: {
  id: string;
  version: string | null;
  usage: ProviderUsageLimits | null;
  active: boolean;
  width: number;
  onOpen: () => void;
  onDisable: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const toggleText = `${toggleLabel(true)}  ›`;
  const titleText = `Mistral Vibe${version ? `  v${version}` : ""}`;
  const leftWidth = Math.max(10, width - toggleText.length - 6);
  const compact = compactPlanUsage(usage, formatResetShort);
  const subWidth = Math.max(10, width - 5 - (compact ? compact.text.length + 2 : 0));
  return (
    <box
      id={id}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      onMouseDown={onOpen}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", flexShrink: 1 }} backgroundColor={bg}>
          <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
            {active ? "▌ " : "  "}
          </text>
          <OverflowText fg={active ? COLOR.bright : COLOR.text} bg={bg} width={leftWidth} active={active || hovered} selectable={false}>
            {titleText}
          </OverflowText>
        </box>
        <box onMouseDown={onDisable} backgroundColor={bg}>
          <text fg={COLOR.added} bg={bg} selectable={false}>
            {toggleText}
          </text>
        </box>
      </box>
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 2, justifyContent: "space-between" }} backgroundColor={bg}>
        <OverflowText fg={COLOR.dim} bg={bg} width={subWidth} active={active || hovered} selectable={false}>
          {t("settings.providers.vibeSubtitle")}
        </OverflowText>
        {compact ? (
          <text fg={usageToneColor(compact.tone)} bg={bg} selectable={false}>{compact.text}</text>
        ) : null}
      </box>
    </box>
  );
}

function AddProviderRow({
  id,
  active,
  width,
  onPress,
}: {
  id: string;
  active: boolean;
  width: number;
  onPress: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  return (
    <box
      id={id}
      style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }}
      backgroundColor={bg}
      onMouseDown={onPress}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row" }} backgroundColor={bg}>
        <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
          {active ? "▌ " : "  "}
        </text>
        <OverflowText fg={active || hovered ? COLOR.bright : COLOR.accent} bg={bg} width={Math.max(12, width - 8)} selectable={false}>
          {t("settings.providers.addButton")}
        </OverflowText>
      </box>
      <text fg={COLOR.faint} bg={bg} selectable={false}>{"a"}</text>
    </box>
  );
}

function CliRowCard({
  id,
  cli,
  check,
  latest,
  busy,
  result,
  active,
  width,
  onUpdate,
}: {
  id: string;
  cli: UpdatableProvider;
  check: ProviderCheckView | undefined;
  latest: LatestVersions | null;
  busy: boolean;
  result: ProviderUpdateAllItem | undefined;
  active: boolean;
  width: number;
  onUpdate: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const installedVer = versionNumber(check?.version ?? null);
  const latestEntry = latest === null ? undefined : { enabled: latest.enabled, latest: null, channel: null, ...latest[cli] };
  const versionLine = providerVersionLine(check, latestEntry);
  const newest = latest?.enabled ? latest[cli]?.latest ?? null : null;
  const hasNewer = newest !== null && installedVer !== null && versionLine.tone === "update";

  const actionLabel = busy
    ? t("settings.providers.updatingLabel")
    : hasNewer
      ? t("settings.providers.updateToLabel", { version: newest })
      : t("settings.providers.updateLabel");
  const actionText = `[ ${actionLabel} ]`;

  let statusText: string;
  let statusColor: string;
  if (busy) {
    statusText = t("settings.providers.updatingLabel");
    statusColor = COLOR.accent;
  } else if (result !== undefined) {
    const summary = summarizeUpdateStatus(result);
    statusText = summary.tone === "ok" ? `✓ ${summary.label}` : summary.tone === "error" ? `✗ ${summary.label}` : summary.label;
    statusColor = summary.tone === "ok" ? COLOR.added : summary.tone === "error" ? COLOR.danger : COLOR.warn;
  } else {
    statusText = versionLine.tone === "ok" ? `✓ ${versionLine.status}` : versionLine.status;
    statusColor =
      versionLine.tone === "warn"
        ? COLOR.warn
        : versionLine.tone === "update"
          ? COLOR.accent
          : versionLine.tone === "ok"
            ? COLOR.added
            : COLOR.dim;
  }

  const actionColor = busy
    ? COLOR.dim
    : hasNewer || active || hovered
      ? COLOR.accent
      : versionLine.settled || (result?.ok === true && !result.update.updated)
        ? COLOR.dim
        : COLOR.accent;
  const nameAndVer = `${cliDisplayName(cli)}${installedVer ? `  v${installedVer}` : ""}`;

  return (
    <box
      id={id}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      onMouseDown={() => {
        if (!busy) onUpdate();
      }}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", flexShrink: 1 }} backgroundColor={bg}>
          <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
            {active ? "▌ " : "  "}
          </text>
          <OverflowText fg={active || hovered ? COLOR.bright : COLOR.text} bg={bg} width={Math.max(12, width - actionText.length - 8)} active={active || hovered} selectable={false}>
            {nameAndVer}
          </OverflowText>
        </box>
        <text fg={actionColor} bg={bg} selectable={false}>{actionText}</text>
      </box>
      <box style={{ flexDirection: "row", paddingLeft: 2 }} backgroundColor={bg}>
        <text fg={statusColor} bg={bg} wrapMode="word" selectable={false}>
          {statusText}
        </text>
      </box>
    </box>
  );
}

function DetailFieldCard({
  id,
  field,
  active,
  editing,
  width,
  onStartEdit,
  onSave,
  onCancel,
}: {
  id: string;
  field: DetailField;
  active: boolean;
  editing: boolean;
  width: number;
  onStartEdit: () => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const shown = field.value || t("settings.default");
  return (
    <box
      id={id}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      {...(editing ? {} : { onMouseDown: onStartEdit })}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", flexShrink: 1 }} backgroundColor={bg}>
          <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
            {active ? "▌ " : "  "}
          </text>
          <text fg={active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>
            {field.label}
          </text>
        </box>
        {editing ? null : (
          <OverflowText
            fg={field.value ? COLOR.accent : COLOR.faint}
            bg={bg}
            width={Math.max(10, width - field.label.length - 8)}
            active={active || hovered}
            selectable={false}
          >
            {shown}
          </OverflowText>
        )}
      </box>
      {editing ? (
        <box style={{ paddingLeft: 2, paddingRight: 1 }} backgroundColor={bg}>
          <TextField
            initial={field.value}
            fallback={t("le.unset")}
            width={Math.max(18, width - 6)}
            onSubmit={onSave}
            onCancel={onCancel}
          />
        </box>
      ) : null}
    </box>
  );
}

export interface AccountLoginStartView {
  readonly authorizationUrl: string | null;
  readonly openBrowser: boolean;
  readonly needsCodeInput?: boolean;
  readonly message: string | null;
  readonly homePath: string | null;
  readonly submitCode?: (code: string) => Promise<{ readonly verified?: boolean; readonly needsConfirmation?: boolean; readonly reason?: string | null } | void>;
  readonly cancel?: () => Promise<void>;
  readonly done: Promise<{ readonly verified?: boolean; readonly needsConfirmation?: boolean; readonly reason?: string | null } | void>;
}

export interface ProfileAccountHeaderProps {
  readonly account: ProviderAccountSummary;
  readonly providers: readonly ProviderSummary[] | null;
  readonly usageByInstance?: Readonly<Record<string, ProviderUsageLimits>> | null;
  readonly versions: {
    readonly codex?: ProviderCheckView;
    readonly claude: ProviderCheckView;
    readonly opencode: ProviderCheckView;
    readonly antigravity?: ProviderCheckView;
    readonly vibe?: ProviderCheckView;
  } | null;
  readonly latest?: LatestVersions | null;
  readonly updating: ReadonlySet<UpdatableProvider>;
  readonly saving: boolean;
  readonly error: string | null;
  readonly width: number;
  readonly onSaveAccount: (input: ProviderAccountSaveInput) => Promise<boolean>;
  readonly onToggleAccount: (kind: AccountProviderKind, id: string, enabled: boolean) => Promise<void>;
  readonly onRemoveAccount: (kind: AccountProviderKind, id: string) => Promise<void>;
  readonly onUpdate: (provider: UpdatableProvider) => void;
  readonly onRemoved: () => void;
  readonly onChatGptLogin?: (accountId: string, label?: string) => Promise<{ readonly authorizationUrl: string; readonly done: Promise<void> } | null>;
  readonly onChatGptLogout?: (accountId: string) => Promise<void>;
  readonly onChatGptPairCodex?: (accountId: string, confirmWorkspace?: boolean) => Promise<{ readonly verified: boolean; readonly needsConfirmation: boolean; readonly reason: string | null } | null>;
  readonly onAccountLogin?: (kind: AccountProviderKind, id: string) => Promise<AccountLoginStartView | null>;
}

/**
 * Top identity, auth, CLI update, env, and removal card for an independent
 * provider profile settings page (`claude/<id>`, `chatgpt/<id>`, `antigravity/<id>`).
 */
export function ProfileAccountHeader({
  account,
  providers,
  usageByInstance,
  versions,
  latest,
  updating,
  saving,
  error,
  width,
  onSaveAccount,
  onToggleAccount,
  onRemoveAccount,
  onUpdate,
  onRemoved,
  onChatGptLogin,
  onChatGptLogout,
  onChatGptPairCodex,
  onAccountLogin,
}: ProfileAccountHeaderProps) {
  const clipboard = useClipboard();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editingEnv, setEditingEnv] = useState(false);
  const [authUrlPending, setAuthUrlPending] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [cliLoginPending, setCliLoginPending] = useState<{
    readonly message: string;
    readonly url: string | null;
    readonly needsCodeInput: boolean;
    readonly submitting?: boolean;
    readonly submitCode?: AccountLoginStartView["submitCode"];
    readonly cancel?: AccountLoginStartView["cancel"];
  } | null>(null);
  const [pairFeedback, setPairFeedback] = useState<{ readonly text: string; readonly needsConfirmation: boolean } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLoginUrl = (url: string) => {
    void clipboard.copyText(url).then((ok) => {
      if (!ok) return;
      setCopiedLink(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedLink(false), 2_000);
    });
  };
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  useEffect(() => {
    setConfirmRemove(false);
    setEditingEnv(false);
    setAuthUrlPending(null);
    setCopiedLink(false);
    setCliLoginPending(null);
    setPairFeedback(null);
  }, [account.instanceId]);

  const startCliLogin = () => {
    if (cliLoginPending !== null || !onAccountLogin) return;
    setPairFeedback(null);
    void onAccountLogin(account.kind, account.id).then((started) => {
      if (!started) return;
      setCliLoginPending({
        message: started.message ?? t("settings.providers.signingIn"),
        url: started.authorizationUrl,
        needsCodeInput: started.needsCodeInput === true,
        submitCode: started.submitCode,
        cancel: started.cancel,
      });
      if (started.openBrowser && started.authorizationUrl) {
        openBrowserUrl(started.authorizationUrl);
      }
      if (started.needsCodeInput !== true) {
        void started.done
          .then((res) => {
            if (res && res.verified === false && res.reason) {
              setPairFeedback({ text: res.reason, needsConfirmation: res.needsConfirmation === true });
            } else if (res?.verified === true) {
              setPairFeedback(null);
            }
          })
          .finally(() => setCliLoginPending(null));
      }
    });
  };

  const cliKind: UpdatableProvider = account.kind === "claude" ? "claude" : account.kind === "antigravity" ? "antigravity" : "codex";
  const check = versions?.[cliKind];
  const latestEntry = latest === null || latest === undefined ? undefined : { enabled: latest.enabled, latest: null, channel: null, ...latest[cliKind] };
  const versionLine = providerVersionLine(check, latestEntry);
  const versionTone = versionLine.tone === "warn" ? COLOR.warn : versionLine.tone === "update" ? COLOR.accent : versionLine.tone === "ok" ? COLOR.added : COLOR.dim;
  const ver = versionNumber(check?.version ?? null);
  const status = accountStatusLine(account, providers);
  const envStr = formatEnvMap(account.env);
  const busyUpdate = updating.has(cliKind);
  const catalogProvider = providers?.find((entry) => entry.instanceId === account.instanceId);
  const accountUsage = providerUsageLimitsFor(usageByInstance, {
    instanceId: account.instanceId,
    usageLimits: catalogProvider?.usageLimits ?? null,
  });

  return (
    <box
      style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, width }}
      backgroundColor={SURFACE.panel}
      selectable={false}
    >
      <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between" }} backgroundColor={SURFACE.panel}>
        <OverflowText fg={COLOR.bright} bg={SURFACE.panel} attributes={TextAttributes.BOLD} width={Math.max(12, width - 10)} selectable={false}>
          {`${KIND_NAME[account.kind]} · ${account.label}`}
        </OverflowText>
        <box onMouseDown={() => void onToggleAccount(account.kind, account.id, !account.enabled)} backgroundColor={SURFACE.panel}>
          <text fg={account.enabled ? COLOR.added : COLOR.dim} bg={SURFACE.panel} selectable={false}>
            {toggleLabel(account.enabled)}
          </text>
        </box>
      </box>
      <OverflowText fg={COLOR.dim} bg={SURFACE.panel} width={Math.max(12, width - 4)} selectable={false}>
        {`${account.instanceId}${ver ? ` · v${ver}` : ""}${status ? ` · ${status}` : ""}`}
      </OverflowText>
      {account.kind !== "chatgpt" && check !== undefined ? (
        <text fg={versionTone} bg={SURFACE.panel} wrapMode="word" selectable={false}>
          {versionLine.status}
        </text>
      ) : null}
      <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
        {account.kind === "chatgpt" ? (
          account.signedIn ? (
            <>
              <Chip
                bracketed
                surface={SURFACE.panel}
                label={t("settings.providers.signOut")}
                onPress={() => {
                  setPairFeedback(null);
                  void onChatGptLogout?.(account.id);
                }}
              />
              {!account.codexVerified && onAccountLogin ? (
                <Chip
                  bracketed
                  surface={SURFACE.panel}
                  label={cliLoginPending ? t("settings.providers.signingIn") : t("settings.providers.signInCodex")}
                  disabled={cliLoginPending !== null}
                  accent
                  onPress={startCliLogin}
                />
              ) : null}
              <Chip
                bracketed
                surface={SURFACE.panel}
                label={pairFeedback?.needsConfirmation ? t("settings.providers.confirmPairCodex") : t("settings.providers.pairCodex")}
                accent
                onPress={() => {
                  if (!onChatGptPairCodex) return;
                  const confirm = pairFeedback?.needsConfirmation === true;
                  void onChatGptPairCodex(account.id, confirm).then((res) => {
                    if (!res) return;
                    setPairFeedback(res.verified ? null : { text: res.reason ?? "", needsConfirmation: res.needsConfirmation });
                  });
                }}
              />
            </>
          ) : (
            <Chip
              bracketed
              surface={SURFACE.panel}
              label={authUrlPending ? t("settings.providers.signingIn") : t("settings.providers.signInChatGpt")}
              disabled={authUrlPending !== null || !onChatGptLogin}
              accent
              onPress={() => {
                if (authUrlPending !== null || !onChatGptLogin) return;
                setPairFeedback(null);
                void onChatGptLogin(account.id, account.label).then((started) => {
                  if (!started) return;
                  setAuthUrlPending(started.authorizationUrl);
                  openBrowserUrl(started.authorizationUrl);
                  void started.done.finally(() => setAuthUrlPending(null));
                });
              }}
            />
          )
        ) : (
          <>
            {onAccountLogin ? (() => {
              const authenticated = isCliAuthenticated(account, providers);
              return (
                <Chip
                  bracketed
                  surface={SURFACE.panel}
                  label={
                    cliLoginPending
                      ? t("settings.providers.signingIn")
                      : authenticated
                        ? t("settings.providers.switchAccount")
                        : t("settings.providers.signIn")
                  }
                  disabled={cliLoginPending !== null}
                  {...(!authenticated ? { accent: true } : {})}
                  onPress={startCliLogin}
                />
              );
            })() : null}
            <Chip
              bracketed
              surface={SURFACE.panel}
              label={busyUpdate ? t("settings.providers.updatingLabel") : t("settings.providers.updateLabel")}
              disabled={busyUpdate}
              accent
              onPress={() => {
                if (!busyUpdate) onUpdate(cliKind);
              }}
            />
          </>
        )}
        <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.editEnv")} onPress={() => setEditingEnv((open) => !open)} />
        <Chip
          bracketed
          surface={SURFACE.panel}
          label={confirmRemove ? t("settings.providers.removeAgain") : t("settings.providers.remove")}
          danger
          onPress={() => {
            if (confirmRemove) {
              setConfirmRemove(false);
              void onRemoveAccount(account.kind, account.id).then(onRemoved);
            } else {
              setConfirmRemove(true);
            }
          }}
        />
        {saving ? <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{t("settings.reading")}</text> : null}
      </box>
      <AccountUsageRows limits={accountUsage} width={width} bg={SURFACE.panel} />
      {editingEnv ? (
        <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
          <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{t("settings.providers.field.env")}</text>
          <TextField
            initial={envStr}
            fallback={t("le.unset")}
            width={Math.max(18, width - 6)}
            onSubmit={(raw) => {
              setEditingEnv(false);
              void onSaveAccount({ kind: account.kind, id: account.id, env: parseEnvText(raw) });
            }}
            onCancel={() => setEditingEnv(false)}
          />
        </box>
      ) : null}
      {authUrlPending ? (
        <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
          <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
            {t("settings.providers.openAuthPrompt")}
          </text>
          <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
            <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(authUrlPending)} />
            <Chip
              bracketed
              surface={SURFACE.panel}
              label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
              onPress={() => copyLoginUrl(authUrlPending)}
            />
          </box>
        </box>
      ) : cliLoginPending ? (
        <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
          <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
            {cliLoginPending.message}
          </text>
          {cliLoginPending.needsCodeInput && cliLoginPending.submitCode ? (
            <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
              <TextField
                key="account-login-code"
                initial=""
                placeholder={t("settings.providers.pasteCodePlaceholder")}
                width={Math.max(18, width - 6)}
                onSubmit={(code) => {
                  const trimmed = code.trim();
                  if (!trimmed || cliLoginPending.submitting) return;
                  setCliLoginPending((cur) => (cur ? { ...cur, submitting: true } : null));
                  void cliLoginPending
                    .submitCode?.(trimmed)
                    .finally(() => setCliLoginPending(null));
                }}
                onCancel={() => {
                  const doCancel = cliLoginPending.cancel;
                  setCliLoginPending(null);
                  void doCancel?.();
                }}
              />
              <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                {cliLoginPending.url ? (
                  <>
                    <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(cliLoginPending.url!)} />
                    <Chip
                      bracketed
                      surface={SURFACE.panel}
                      label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
                      onPress={() => copyLoginUrl(cliLoginPending.url!)}
                    />
                  </>
                ) : null}
                {cliLoginPending.cancel ? (
                  <Chip
                    bracketed
                    surface={SURFACE.panel}
                    label={t("settings.providers.cancelLogin")}
                    onPress={() => {
                      const doCancel = cliLoginPending.cancel;
                      setCliLoginPending(null);
                      void doCancel?.();
                    }}
                  />
                ) : null}
              </box>
            </box>
          ) : cliLoginPending.url ? (
            <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
              <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(cliLoginPending.url!)} />
              <Chip
                bracketed
                surface={SURFACE.panel}
                label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
                onPress={() => copyLoginUrl(cliLoginPending.url!)}
              />
            </box>
          ) : null}
        </box>
      ) : account.kind === "chatgpt" && !account.codexVerified ? (
        <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
          {t("settings.providers.unpairedHint")}
        </text>
      ) : null}
      {pairFeedback?.text ? (
        <text fg={pairFeedback.needsConfirmation ? COLOR.warn : COLOR.danger} bg={SURFACE.panel} wrapMode="word" selectable={false}>{pairFeedback.text}</text>
      ) : null}
      {confirmRemove ? (
        <text fg={COLOR.warn} bg={SURFACE.panel} wrapMode="word" selectable={false}>
          {t("settings.providers.confirmRemove", { id: account.instanceId })}
        </text>
      ) : null}
      {error ? (
        <text fg={COLOR.danger} bg={SURFACE.panel} wrapMode="word" selectable={false}>{error}</text>
      ) : null}
    </box>
  );
}

export interface ProvidersOverviewPanelProps {
  readonly accounts: readonly ProviderAccountSummary[];
  readonly opencodeEnabled?: boolean;
  readonly onToggleOpencode?: (enabled: boolean) => void;
  readonly onOpenOpencode?: () => void;
  readonly vibeEnabled?: boolean;
  readonly onToggleVibe?: (enabled: boolean) => void;
  readonly onOpenVibe?: () => void;
  readonly selectedInstance: string | null;
  readonly onSelectAccount: (instanceId: string | null) => void;
  readonly providers: readonly ProviderSummary[] | null;
  readonly usageByInstance?: Readonly<Record<string, ProviderUsageLimits>> | null;
  readonly versions: {
    readonly codex?: ProviderCheckView;
    readonly claude: ProviderCheckView;
    readonly opencode: ProviderCheckView;
    readonly antigravity?: ProviderCheckView;
    readonly vibe?: ProviderCheckView;
  } | null;
  readonly latest: LatestVersions | null;
  readonly updating: ReadonlySet<UpdatableProvider>;
  readonly updatingAll: boolean;
  readonly updateAllResults: readonly ProviderUpdateAllItem[] | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly width: number;
  readonly onSaveAccount: (input: ProviderAccountSaveInput) => Promise<boolean>;
  readonly onToggleAccount: (kind: AccountProviderKind, id: string, enabled: boolean) => Promise<void>;
  readonly onRemoveAccount: (kind: AccountProviderKind, id: string) => Promise<void>;
  readonly onUpdate: (provider: UpdatableProvider) => void;
  readonly onUpdateAll: () => void;
  readonly onOpenSection: (section: SettingSection) => void;
  readonly onClose: () => void;
  readonly onChatGptLogin?: (accountId: string, label?: string) => Promise<{ readonly authorizationUrl: string; readonly done: Promise<void> } | null>;
  readonly onChatGptLogout?: (accountId: string) => Promise<void>;
  readonly onChatGptPairCodex?: (accountId: string, confirmWorkspace?: boolean) => Promise<{ readonly verified: boolean; readonly needsConfirmation: boolean; readonly reason: string | null } | null>;
  readonly onAccountLogin?: (kind: AccountProviderKind, id: string) => Promise<AccountLoginStartView | null>;
}

export function ProvidersOverviewPanel({
  accounts,
  opencodeEnabled = false,
  onToggleOpencode,
  onOpenOpencode,
  vibeEnabled = false,
  onToggleVibe,
  onOpenVibe,
  selectedInstance,
  onSelectAccount,
  providers,
  usageByInstance,
  versions,
  latest,
  updating,
  updatingAll,
  updateAllResults,
  saving,
  error,
  width,
  onSaveAccount,
  onToggleAccount,
  onRemoveAccount,
  onUpdate,
  onUpdateAll,
  onOpenSection,
  onClose,
  onChatGptLogin,
  onChatGptLogout,
  onChatGptPairCodex,
  onAccountLogin,
}: ProvidersOverviewPanelProps) {
  const clipboard = useClipboard();
  const [cursor, setCursor] = useState(0);
  const [detailCursor, setDetailCursor] = useState(0);
  const [editingField, setEditingField] = useState<DetailFieldId | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [authUrlPending, setAuthUrlPending] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLoginUrl = (url: string) => {
    void clipboard.copyText(url).then((ok) => {
      if (!ok) return;
      setCopiedLink(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedLink(false), 2_000);
    });
  };
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const [cliLoginPending, setCliLoginPending] = useState<{
    readonly message: string;
    readonly url: string | null;
    readonly needsCodeInput: boolean;
    readonly submitting?: boolean;
    readonly submitCode?: AccountLoginStartView["submitCode"];
    readonly cancel?: AccountLoginStartView["cancel"];
  } | null>(null);
  const [pairFeedback, setPairFeedback] = useState<{ readonly text: string; readonly needsConfirmation: boolean } | null>(null);
  const [wizard, setWizard] = useState<
    | null
    | { step: "kind"; kindIndex: number }
    | { step: "id"; kind: AccountProviderKind }
    | { step: "label"; kind: AccountProviderKind; id: string }
    | { step: "home"; kind: AccountProviderKind; id: string; label: string }
  >(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const selected = selectedInstance === null
    ? null
    : (accounts.find((entry) => entry.instanceId === selectedInstance) ?? null);
  const detailFields = selected ? fieldsForAccount(selected) : [];
  const hasAntigravity = accounts.some((entry) => entry.kind === "antigravity");
  const addableKinds: readonly AddableProviderKind[] = [
    ...ACCOUNT_PROVIDER_KINDS.filter((kind) => kind !== "antigravity" || !hasAntigravity),
    ...(opencodeEnabled ? [] : (["opencode"] as const)),
    ...(vibeEnabled ? [] : (["vibe"] as const)),
  ];
  const pickAddKind = (picked: AddableProviderKind): void => {
    if (picked === "opencode") {
      setWizard(null);
      onToggleOpencode?.(true);
      onOpenOpencode?.();
    } else if (picked === "vibe") {
      setWizard(null);
      onToggleVibe?.(true);
      onOpenVibe?.();
    } else if (picked === "antigravity") {
      void onSaveAccount({ kind: "antigravity", id: "default" }).then((ok) => {
        if (ok) {
          setWizard(null);
          onSelectAccount("antigravity/default");
        }
      });
    } else {
      setWizard({ step: "id", kind: picked });
    }
  };

  // Unified focus stops on Overview: accounts -> optional OpenCode -> optional Mistral Vibe -> "+ Add provider" -> installed CLIs.
  const opencodeStop = opencodeEnabled ? accounts.length : -1;
  const vibeStop = vibeEnabled ? accounts.length + (opencodeEnabled ? 1 : 0) : -1;
  const configuredCount = accounts.length + (opencodeEnabled ? 1 : 0) + (vibeEnabled ? 1 : 0);
  const addStop = configuredCount;
  const cliStart = configuredCount + 1;
  const totalStops = cliStart + UPDATABLE_PROVIDERS.length;
  const safeCursor = Math.min(cursor, Math.max(0, totalStops - 1));

  useEffect(() => {
    if (selected !== null || wizard !== null) return;
    const targetId =
      safeCursor < accounts.length
        ? `providers-account-${safeCursor}`
        : safeCursor === opencodeStop
          ? "providers-opencode-row"
          : safeCursor === vibeStop
            ? "providers-vibe-row"
            : safeCursor === addStop
              ? "providers-add-row"
              : `providers-cli-${UPDATABLE_PROVIDERS[safeCursor - cliStart]}`;
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(targetId), 0);
    return () => clearTimeout(timer);
  }, [safeCursor, accounts.length, opencodeStop, vibeStop, addStop, cliStart, selected, wizard]);

  useKeyLayer((key) => {
    if (key.defaultPrevented) return;
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";

    if (editingField !== null) {
      if (escape) setEditingField(null);
      return;
    }

    if (wizard !== null) {
      if (escape) {
        setWizard(null);
        return;
      }
      if (wizard.step === "kind") {
        if (key.name === "down" || key.name === "j") {
          setWizard({ step: "kind", kindIndex: Math.min(wizard.kindIndex + 1, addableKinds.length - 1) });
        } else if (key.name === "up" || key.name === "k") {
          setWizard({ step: "kind", kindIndex: Math.max(wizard.kindIndex - 1, 0) });
        } else if (enter) {
          const picked = addableKinds[wizard.kindIndex];
          if (picked) pickAddKind(picked);
        }
      }
      return;
    }

    if (selected !== null) {
      if (escape) {
        if (confirmRemove) setConfirmRemove(false);
        else {
          setDetailCursor(0);
          onSelectAccount(null);
        }
        return;
      }
      if (confirmRemove) {
        if (enter || (key.name === "r" && !key.ctrl && !key.meta)) {
          setConfirmRemove(false);
          void onRemoveAccount(selected.kind, selected.id).then(() => onSelectAccount(null));
        }
        return;
      }
      if (key.name === "down" || key.name === "j") {
        setDetailCursor((at) => Math.min(at + 1, Math.max(0, detailFields.length - 1)));
      } else if (key.name === "up" || key.name === "k") {
        setDetailCursor((at) => Math.max(at - 1, 0));
      } else if (enter) {
        const field = detailFields[Math.min(detailCursor, detailFields.length - 1)];
        if (field) setEditingField(field.id);
      } else if (key.name === "space") {
        void onToggleAccount(selected.kind, selected.id, !selected.enabled);
      } else if (key.name === "r" && !key.ctrl && !key.meta) {
        setConfirmRemove(true);
      }
      return;
    }

    if (escape) {
      onClose();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setCursor((at) => Math.min(at + 1, Math.max(0, totalStops - 1)));
    } else if (key.name === "up" || key.name === "k") {
      setCursor((at) => Math.max(at - 1, 0));
    } else if (enter) {
      if (safeCursor < accounts.length) {
        const target = accounts[safeCursor];
        if (target) {
          setDetailCursor(0);
          setConfirmRemove(false);
          onSelectAccount(target.instanceId);
        }
      } else if (safeCursor === opencodeStop) {
        onOpenOpencode?.();
      } else if (safeCursor === vibeStop) {
        onOpenVibe?.();
      } else if (safeCursor === addStop) {
        setWizard({ step: "kind", kindIndex: 0 });
      } else {
        const cli = UPDATABLE_PROVIDERS[safeCursor - cliStart];
        if (cli && !updating.has(cli) && !updatingAll) onUpdate(cli);
      }
    } else if (key.name === "space" && safeCursor < accounts.length) {
      const target = accounts[safeCursor];
      if (target) void onToggleAccount(target.kind, target.id, !target.enabled);
    } else if (key.name === "space" && safeCursor === opencodeStop) {
      onToggleOpencode?.(false);
    } else if (key.name === "space" && safeCursor === vibeStop) {
      onToggleVibe?.(false);
    } else if (key.name === "a" && !key.ctrl && !key.meta) {
      setWizard({ step: "kind", kindIndex: 0 });
    } else if (key.name === "u" && !key.shift && !key.ctrl && !key.meta && safeCursor >= cliStart) {
      const cli = UPDATABLE_PROVIDERS[safeCursor - cliStart];
      if (cli && !updating.has(cli) && !updatingAll) onUpdate(cli);
    } else if (key.sequence === "U" && !key.ctrl && !key.meta) {
      onUpdateAll();
    }
  }, { capture: (key) => key.name !== "tab" });

  if (wizard !== null) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <Chip bracketed surface={SURFACE.raised} label={t("ui.back")} onPress={() => setWizard(null)} accent />
        </box>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>
            {t("settings.providers.addTitle")}
          </text>
          {wizard.step === "kind" ? (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.addKind")}
              </text>
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                {addableKinds.map((kind, at) => {
                  const focused = at === wizard.kindIndex;
                  const bg = focused ? SURFACE.hover : SURFACE.raised;
                  return (
                    <box
                      key={kind}
                      style={{ flexDirection: "column", marginBottom: 1, paddingLeft: 1, paddingRight: 1 }}
                      backgroundColor={bg}
                      onMouseDown={() => pickAddKind(kind)}
                      selectable={false}
                    >
                      <text fg={focused ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>
                        {`${focused ? "▌ " : "  "}${addableKindName(kind)}`}
                      </text>
                      <box style={{ paddingLeft: 2 }} backgroundColor={bg}>
                        <text fg={COLOR.dim} bg={bg} wrapMode="word" selectable={false}>
                          {addableKindDescription(kind)}
                        </text>
                      </box>
                    </box>
                  );
                })}
              </box>
            </>
          ) : wizard.step === "id" ? (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.addId")}
              </text>
              <TextField
                key={`wizard-id-${wizard.kind}`}
                initial=""
                placeholder={defaultIdPlaceholder()}
                width={Math.max(20, width - 4)}
                onSubmit={(value) => {
                  const id = value.trim().toLowerCase();
                  if (!id) return;
                  setWizard({ step: "label", kind: wizard.kind, id });
                }}
                onCancel={() => setWizard(null)}
              />
            </>
          ) : wizard.step === "label" ? (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.addLabel")}
              </text>
              <TextField
                key={`wizard-label-${wizard.kind}-${wizard.id}`}
                initial=""
                placeholder={wizard.id}
                fallback={wizard.id}
                width={Math.max(20, width - 4)}
                onSubmit={(value) => setWizard({ step: "home", kind: wizard.kind, id: wizard.id, label: value.trim() })}
                onCancel={() => setWizard(null)}
              />
            </>
          ) : (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.addHome", { path: defaultHomeHint(wizard.kind, wizard.id) })}
              </text>
              <TextField
                key={`wizard-home-${wizard.kind}-${wizard.id}`}
                initial={defaultHomeHint(wizard.kind, wizard.id)}
                placeholder={defaultHomeHint(wizard.kind, wizard.id)}
                fallback={t("settings.default")}
                width={Math.max(20, width - 4)}
                onSubmit={(value) => {
                  const dir = value.trim();
                  const input: ProviderAccountSaveInput = {
                    kind: wizard.kind,
                    id: wizard.id,
                    ...(wizard.label ? { label: wizard.label } : {}),
                    ...(dir
                      ? wizard.kind === "chatgpt"
                        ? { codexHomePath: dir }
                        : { homePath: dir }
                      : {}),
                  };
                  void onSaveAccount(input).then((ok) => {
                    if (ok) {
                      setWizard(null);
                      onSelectAccount(`${wizard.kind}/${wizard.id}`);
                    }
                  });
                }}
                onCancel={() => setWizard(null)}
              />
            </>
          )}
        </box>
      </box>
    );
  }

  if (selected !== null) {
    const cliKind: UpdatableProvider = selected.kind === "claude" ? "claude" : selected.kind === "antigravity" ? "antigravity" : "codex";
    const ver = versionNumber(versions?.[cliKind]?.version ?? null);
    const status = accountStatusLine(selected, providers);
    const activeField = Math.min(detailCursor, Math.max(0, detailFields.length - 1));
    const saveField = (field: DetailFieldId, raw: string) => {
      setEditingField(null);
      const isChatGpt = selected.kind === "chatgpt";
      const val = raw.trim() === "" ? null : raw.trim();
      const input: ProviderAccountSaveInput = {
        kind: selected.kind,
        id: selected.id,
        ...(field === "label" ? { label: val } : {}),
        ...(field === "binaryPath" ? (isChatGpt ? { codexBinaryPath: val } : { binaryPath: val }) : {}),
        ...(field === "homePath" ? (isChatGpt ? { codexHomePath: val } : { homePath: val }) : {}),
        ...(field === "launchArgs" ? (isChatGpt ? { codexLaunchArgs: val } : { launchArgs: val }) : {}),
        ...(field === "model" ? { model: val } : {}),
        ...(field === "thinkingEffort" ? { thinkingEffort: val } : {}),
        ...(field === "env" ? { env: parseEnvText(raw) } : {}),
      };
      void onSaveAccount(input);
    };

    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
          <Chip bracketed surface={SURFACE.raised} label={t("ui.back")} onPress={() => onSelectAccount(null)} accent />
          <box style={{ flexDirection: "row", gap: 1 }} backgroundColor={SURFACE.raised}>
            <box onMouseDown={() => void onToggleAccount(selected.kind, selected.id, !selected.enabled)} backgroundColor={SURFACE.raised}>
              <text fg={selected.enabled ? COLOR.added : COLOR.dim} bg={SURFACE.raised} selectable={false}>
                {toggleLabel(selected.enabled)}
              </text>
            </box>
            <Chip bracketed surface={SURFACE.raised} label={t("settings.providers.openProvider")} onPress={() => onOpenSection(kindToSection(selected.kind))} accent />
          </box>
        </box>

        <box
          style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1 }}
          backgroundColor={SURFACE.panel}
          selectable={false}
        >
          <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between" }} backgroundColor={SURFACE.panel}>
            <OverflowText fg={COLOR.bright} bg={SURFACE.panel} attributes={TextAttributes.BOLD} width={Math.max(12, width - 14)} selectable={false}>
              {`${KIND_NAME[selected.kind]} · ${selected.label}`}
            </OverflowText>
            {ver ? <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{`v${ver}`}</text> : null}
          </box>
          <OverflowText fg={COLOR.dim} bg={SURFACE.panel} width={Math.max(12, width - 4)} selectable={false}>
            {`${selected.instanceId}${status ? ` · ${status}` : ""}`}
          </OverflowText>
          {selected.kind === "chatgpt" ? (
            <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
              <box style={{ flexDirection: "row", flexWrap: "wrap" }} backgroundColor={SURFACE.panel}>
                {selected.signedIn ? (
                  <Chip
                    bracketed
                    surface={SURFACE.panel}
                    label={t("settings.providers.signOut")}
                    onPress={() => {
                      setPairFeedback(null);
                      void onChatGptLogout?.(selected.id);
                    }}
                  />
                ) : (
                  <Chip
                    bracketed
                    surface={SURFACE.panel}
                    label={authUrlPending ? t("settings.providers.signingIn") : t("settings.providers.signInChatGpt")}
                    disabled={authUrlPending !== null || !onChatGptLogin}
                    accent
                    onPress={() => {
                      if (authUrlPending !== null || !onChatGptLogin) return;
                      setPairFeedback(null);
                      void onChatGptLogin(selected.id, selected.label).then((started) => {
                        if (!started) return;
                        setAuthUrlPending(started.authorizationUrl);
                        openBrowserUrl(started.authorizationUrl);
                        void started.done.finally(() => setAuthUrlPending(null));
                      });
                    }}
                  />
                )}
                {selected.signedIn && !selected.codexVerified && onAccountLogin ? (
                  <Chip
                    bracketed
                    surface={SURFACE.panel}
                    label={cliLoginPending ? t("settings.providers.signingIn") : t("settings.providers.signInCodex")}
                    disabled={cliLoginPending !== null}
                    accent
                    onPress={() => {
                      if (cliLoginPending !== null) return;
                      setPairFeedback(null);
                      void onAccountLogin("chatgpt", selected.id).then((started) => {
                        if (!started) return;
                        setCliLoginPending({
                          message: started.message ?? t("settings.providers.signingIn"),
                          url: started.authorizationUrl,
                          needsCodeInput: started.needsCodeInput === true,
                          submitCode: started.submitCode,
                          cancel: started.cancel,
                        });
                        if (started.openBrowser && started.authorizationUrl) openBrowserUrl(started.authorizationUrl);
                        if (started.needsCodeInput !== true) {
                          void started.done
                            .then((res) => {
                              if (res && res.verified === false && res.reason) {
                                setPairFeedback({ text: res.reason, needsConfirmation: res.needsConfirmation === true });
                              } else if (res?.verified === true) {
                                setPairFeedback(null);
                              }
                            })
                            .finally(() => setCliLoginPending(null));
                        }
                      });
                    }}
                  />
                ) : null}
                {selected.signedIn ? (
                  <Chip
                    bracketed
                    surface={SURFACE.panel}
                    label={pairFeedback?.needsConfirmation ? t("settings.providers.confirmPairCodex") : t("settings.providers.pairCodex")}
                    accent
                    onPress={() => {
                      if (!onChatGptPairCodex) return;
                      const confirm = pairFeedback?.needsConfirmation === true;
                      void onChatGptPairCodex(selected.id, confirm).then((res) => {
                        if (!res) return;
                        setPairFeedback(
                          res.verified
                            ? null
                            : { text: res.reason ?? "", needsConfirmation: res.needsConfirmation },
                        );
                      });
                    }}
                  />
                ) : null}
              </box>
              {authUrlPending ? (
                <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                  <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                    {t("settings.providers.openAuthPrompt")}
                  </text>
                  <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                    <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(authUrlPending)} />
                    <Chip
                      bracketed
                      surface={SURFACE.panel}
                      label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
                      onPress={() => copyLoginUrl(authUrlPending)}
                    />
                  </box>
                </box>
              ) : cliLoginPending ? (
                <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                  <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                    {cliLoginPending.message}
                  </text>
                  {cliLoginPending.url ? (
                    <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                      <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(cliLoginPending.url!)} />
                      <Chip
                        bracketed
                        surface={SURFACE.panel}
                        label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
                        onPress={() => copyLoginUrl(cliLoginPending.url!)}
                      />
                    </box>
                  ) : null}
                </box>
              ) : !selected.codexVerified ? (
                <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                  {t("settings.providers.unpairedHint")}
                </text>
              ) : null}
              {pairFeedback?.text ? (
                <text fg={pairFeedback.needsConfirmation ? COLOR.warn : COLOR.danger} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                  {pairFeedback.text}
                </text>
              ) : null}
            </box>
          ) : onAccountLogin ? (() => {
            const authenticated = isCliAuthenticated(selected, providers);
            return (
            <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
              <box style={{ flexDirection: "row" }} backgroundColor={SURFACE.panel}>
                <Chip
                  bracketed
                  surface={SURFACE.panel}
                  label={
                    cliLoginPending
                      ? t("settings.providers.signingIn")
                      : authenticated
                        ? t("settings.providers.switchAccount")
                        : t("settings.providers.signIn")
                  }
                  disabled={cliLoginPending !== null}
                  {...(!authenticated ? { accent: true } : {})}
                  onPress={() => {
                    if (cliLoginPending !== null) return;
                    void onAccountLogin(selected.kind, selected.id).then((started) => {
                      if (!started) return;
                      setCliLoginPending({
                        message: started.message ?? t("settings.providers.signingIn"),
                        url: started.authorizationUrl,
                        needsCodeInput: started.needsCodeInput === true,
                        submitCode: started.submitCode,
                        cancel: started.cancel,
                      });
                      if (started.openBrowser && started.authorizationUrl) openBrowserUrl(started.authorizationUrl);
                      if (started.needsCodeInput !== true) {
                        void started.done.finally(() => setCliLoginPending(null));
                      }
                    });
                  }}
                />
              </box>
              {cliLoginPending ? (
                <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                  <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                    {cliLoginPending.message}
                  </text>
                  {cliLoginPending.needsCodeInput && cliLoginPending.submitCode ? (
                    <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                      <TextField
                        key="overview-account-login-code"
                        initial=""
                        placeholder={t("settings.providers.pasteCodePlaceholder")}
                        width={Math.max(18, width - 6)}
                        onSubmit={(code) => {
                          const trimmed = code.trim();
                          if (!trimmed || cliLoginPending.submitting) return;
                          setCliLoginPending((cur) => (cur ? { ...cur, submitting: true } : null));
                          void cliLoginPending
                            .submitCode?.(trimmed)
                            .finally(() => setCliLoginPending(null));
                        }}
                        onCancel={() => {
                          const doCancel = cliLoginPending.cancel;
                          setCliLoginPending(null);
                          void doCancel?.();
                        }}
                      />
                      <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                        {cliLoginPending.url ? (
                          <>
                            <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(cliLoginPending.url!)} />
                            <Chip
                              bracketed
                              surface={SURFACE.panel}
                              label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
                              onPress={() => copyLoginUrl(cliLoginPending.url!)}
                            />
                          </>
                        ) : null}
                        {cliLoginPending.cancel ? (
                          <Chip
                            bracketed
                            surface={SURFACE.panel}
                            label={t("settings.providers.cancelLogin")}
                            onPress={() => {
                              const doCancel = cliLoginPending.cancel;
                              setCliLoginPending(null);
                              void doCancel?.();
                            }}
                          />
                        ) : null}
                      </box>
                    </box>
                  ) : cliLoginPending.url ? (
                    <box style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 1 }} backgroundColor={SURFACE.panel}>
                      <Chip bracketed surface={SURFACE.panel} label={t("settings.providers.openBrowser")} accent onPress={() => openBrowserUrl(cliLoginPending.url!)} />
                      <Chip
                        bracketed
                        surface={SURFACE.panel}
                        label={copiedLink ? t("settings.providers.linkCopied") : t("settings.providers.copyLink")}
                        onPress={() => copyLoginUrl(cliLoginPending.url!)}
                      />
                    </box>
                  ) : null}
                </box>
              ) : null}
            </box>
            );
          })() : null}
          <AccountUsageRows
            limits={providerUsageLimitsFor(usageByInstance, {
              instanceId: selected.instanceId,
              usageLimits: providers?.find((entry) => entry.instanceId === selected.instanceId)?.usageLimits ?? null,
            })}
            width={width}
            bg={SURFACE.panel}
          />
        </box>

        <scrollbox
          style={{ flexGrow: 1, marginTop: 1 }}
          stickyStart="top"
          backgroundColor={SURFACE.raised}
          verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}
        >
          {detailFields.map((field, at) => {
            const startsGroup = at === 0 || detailFields[at - 1]?.group !== field.group;
            return (
              <Fragment key={field.id}>
                {startsGroup ? <SectionHeading label={detailGroupTitle(field.group)} width={width} first={at === 0} /> : null}
                <DetailFieldCard
                  id={`providers-detail-${field.id}`}
                  field={field}
                  active={at === activeField}
                  editing={editingField === field.id}
                  width={width}
                  onStartEdit={() => {
                    setDetailCursor(at);
                    setEditingField(field.id);
                  }}
                  onSave={(next) => saveField(field.id, next)}
                  onCancel={() => setEditingField(null)}
                />
              </Fragment>
            );
          })}
          <box style={{ flexDirection: "row", marginTop: 2, paddingLeft: 1, gap: 2 }} backgroundColor={SURFACE.raised}>
            <Chip
              bracketed
              surface={SURFACE.raised}
              label={confirmRemove ? t("settings.providers.removeAgain") : t("settings.providers.remove")}
              keyHint="r"
              danger
              onPress={() => {
                if (confirmRemove) {
                  setConfirmRemove(false);
                  void onRemoveAccount(selected.kind, selected.id).then(() => onSelectAccount(null));
                } else {
                  setConfirmRemove(true);
                }
              }}
            />
            {saving ? <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("settings.reading")}</text> : null}
          </box>
          {confirmRemove ? (
            <box style={{ paddingLeft: 1 }} backgroundColor={SURFACE.raised}>
              <text fg={COLOR.warn} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.confirmRemove", { id: selected.instanceId })}
              </text>
            </box>
          ) : null}
          {error ? (
            <box style={{ paddingLeft: 1 }} backgroundColor={SURFACE.raised}>
              <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word" selectable={false}>{error}</text>
            </box>
          ) : null}
        </scrollbox>
      </box>
    );
  }

  const resultByCli = new Map<UpdatableProvider, ProviderUpdateAllItem>();
  for (const item of updateAllResults ?? []) {
    resultByCli.set(item.provider, item);
  }
  const wideHeader = width >= 54;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <box
        style={{
          flexDirection: wideHeader ? "row" : "column",
          flexShrink: 0,
          justifyContent: "space-between",
          paddingLeft: 1,
        }}
        backgroundColor={SURFACE.raised}
      >
        <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>
          {t("settings.providers.heading")}
        </text>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
          <Chip
            bracketed
            surface={SURFACE.raised}
            label={t("settings.providers.addButton")}
            keyHint="a"
            accent
            onPress={() => setWizard({ step: "kind", kindIndex: 0 })}
          />
          <Chip
            bracketed
            surface={SURFACE.raised}
            label={updatingAll ? t("settings.providers.updatingAll") : t("settings.providers.updateAllButton")}
            keyHint="U"
            disabled={updatingAll}
            onPress={onUpdateAll}
          />
        </box>
      </box>

      <scrollbox
        ref={scrollRef}
        style={{ flexGrow: 1, marginTop: 1 }}
        stickyStart="top"
        backgroundColor={SURFACE.raised}
        verticalScrollbarOptions={{ showArrows: false, trackOptions: { foregroundColor: COLOR.dim, backgroundColor: SURFACE.border } }}
      >
        <SectionHeading label={t("settings.providers.accountsHeading")} width={width} first />
        {configuredCount === 0 ? (
          <box
            style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
            backgroundColor={SURFACE.panel}
            selectable={false}
          >
            <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
              {t("settings.providers.empty")}
            </text>
          </box>
        ) : (
          <>
            {accounts.map((account, at) => {
              const cliKind: UpdatableProvider =
                account.kind === "claude" ? "claude" : account.kind === "antigravity" ? "antigravity" : "codex";
              const ver = versionNumber(versions?.[cliKind]?.version ?? null);
              return (
                <AccountRowCard
                  key={account.instanceId}
                  id={`providers-account-${at}`}
                  account={account}
                  version={ver}
                  status={accountStatusLine(account, providers)}
                  usage={providerUsageLimitsFor(usageByInstance, {
                    instanceId: account.instanceId,
                    usageLimits: providers?.find((entry) => entry.instanceId === account.instanceId)?.usageLimits ?? null,
                  })}
                  active={at === safeCursor}
                  width={width}
                  onOpen={() => {
                    setCursor(at);
                    setDetailCursor(0);
                    setConfirmRemove(false);
                    onSelectAccount(account.instanceId);
                  }}
                  onToggle={() => void onToggleAccount(account.kind, account.id, !account.enabled)}
                />
              );
            })}
            {opencodeEnabled ? (
              <OpencodeOverviewRow
                id="providers-opencode-row"
                version={versionNumber(versions?.opencode?.version ?? null)}
                usage={providerUsageLimitsFor(usageByInstance, {
                  instanceId: "opencode/opencode-go",
                  usageLimits: providers?.find((entry) => entry.instanceId === "opencode/opencode-go")?.usageLimits ?? null,
                })}
                active={safeCursor === opencodeStop}
                width={width}
                onOpen={() => {
                  setCursor(opencodeStop);
                  onOpenOpencode?.();
                }}
                onDisable={() => onToggleOpencode?.(false)}
              />
            ) : null}
            {vibeEnabled ? (
              <VibeOverviewRow
                id="providers-vibe-row"
                version={versionNumber(versions?.vibe?.version ?? null)}
                usage={providerUsageLimitsFor(usageByInstance, {
                  instanceId: "vibe",
                  usageLimits: providers?.find((entry) => entry.instanceId === "vibe")?.usageLimits ?? null,
                })}
                active={safeCursor === vibeStop}
                width={width}
                onOpen={() => {
                  setCursor(vibeStop);
                  onOpenVibe?.();
                }}
                onDisable={() => onToggleVibe?.(false)}
              />
            ) : null}
          </>
        )}
        <AddProviderRow
          id="providers-add-row"
          active={safeCursor === addStop}
          width={width}
          onPress={() => setWizard({ step: "kind", kindIndex: 0 })}
        />

        <box style={{ height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} />
        <SectionHeading label={t("settings.providers.clisHeading")} width={width} />
        {UPDATABLE_PROVIDERS.map((cli, idx) => (
          <CliRowCard
            key={cli}
            id={`providers-cli-${cli}`}
            cli={cli}
            check={versions?.[cli]}
            latest={latest}
            busy={updating.has(cli) || updatingAll}
            result={resultByCli.get(cli)}
            active={safeCursor === cliStart + idx}
            width={width}
            onUpdate={() => onUpdate(cli)}
          />
        ))}

        {error ? (
          <box style={{ marginTop: 1, paddingLeft: 1 }} backgroundColor={SURFACE.raised}>
            <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word" selectable={false}>
              {error}
            </text>
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}
