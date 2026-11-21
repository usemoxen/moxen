import { spawn } from "node:child_process";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
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
  type AccountProviderKind,
  type ProviderAccountSaveInput,
  type ProviderAccountSummary,
} from "../../../core/types.js";
import { useHover } from "../../hooks/useHover.js";
import { t } from "../../i18n/index.js";
import { providerVersionLine, type ProviderCheckView } from "../../model/settings.js";
import { COLOR, SURFACE } from "../../theme.js";
import { Chip } from "../../ui/chip.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { TextField } from "./textfield.js";

const KIND_NAME: Record<AccountProviderKind, string> = {
  claude: "Claude Code",
  chatgpt: "ChatGPT",
  antigravity: "Antigravity",
};

function cliDisplayName(cli: UpdatableProvider): string {
  if (cli === "claude") return "Claude Code";
  if (cli === "opencode") return "OpenCode";
  if (cli === "antigravity") return "Antigravity";
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
  const prefix = kind === "claude" ? "~/.claude-" : kind === "antigravity" ? "~/.agy-" : "~/.codex-";
  return `${prefix}${id}`;
}

function defaultIdPlaceholder(): string {
  return "personal";
}

function accountStatusLine(account: ProviderAccountSummary, catalog: readonly ProviderSummary[] | null): string {
  if (!account.enabled) return t("settings.providers.disabled");
  const parts: string[] = [];
  if (account.email) {
    parts.push(t("settings.providers.authenticatedAs", { email: account.email }));
  } else if (account.kind === "chatgpt") {
    parts.push(account.signedIn ? t("settings.providers.signedIn") : t("settings.providers.notSignedIn"));
  } else {
    const live = catalog?.find((entry) => entry.instanceId === account.instanceId);
    if (live?.status) parts.push(live.status);
    else if (live?.authStatus) parts.push(t("settings.providers.authenticated"));
    else if (account.homePath) parts.push(account.homePath);
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
    {
      id: "homePath",
      group: "runtime",
      label:
        account.kind === "antigravity"
          ? t("settings.providers.field.agyHomePath")
          : isChatGpt
            ? t("settings.providers.field.codexHomePath")
            : t("settings.providers.field.homePath"),
      value: (isChatGpt ? account.codexHomePath : account.homePath) ?? "",
    },
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

function AccountRowCard({
  id,
  account,
  version,
  status,
  active,
  width,
  onOpen,
  onToggle,
}: {
  id: string;
  account: ProviderAccountSummary;
  version: string | null;
  status: string;
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
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 2 }} backgroundColor={bg}>
        <OverflowText fg={COLOR.dim} bg={bg} width={Math.max(10, width - 5)} active={active || hovered} selectable={false}>
          {subText}
        </OverflowText>
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
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.panel;
  const installedVer = versionNumber(check?.version ?? null);
  const latestEntry = latest === null ? undefined : { enabled: latest.enabled, latest: null, channel: null, ...latest[cli] };
  const versionLine = providerVersionLine(check, latestEntry);
  const newest = latest?.enabled ? latest[cli]?.latest ?? null : null;
  const hasNewer = newest !== null && installedVer !== null && versionLine.tone === "update";

  const actionText = busy
    ? t("settings.providers.updatingLabel")
    : hasNewer
      ? t("settings.providers.updateToLabel", { version: newest })
      : t("settings.providers.updateLabel");

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
}: {
  id: string;
  field: DetailField;
  active: boolean;
  editing: boolean;
  width: number;
  onStartEdit: () => void;
  onSave: (value: string) => void;
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
          />
        </box>
      ) : null}
    </box>
  );
}

export interface ProvidersOverviewPanelProps {
  readonly accounts: readonly ProviderAccountSummary[];
  readonly selectedInstance: string | null;
  readonly onSelectAccount: (instanceId: string | null) => void;
  readonly providers: readonly ProviderSummary[] | null;
  readonly versions: {
    readonly codex?: ProviderCheckView;
    readonly claude: ProviderCheckView;
    readonly opencode: ProviderCheckView;
    readonly antigravity?: ProviderCheckView;
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
}

export function ProvidersOverviewPanel({
  accounts,
  selectedInstance,
  onSelectAccount,
  providers,
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
}: ProvidersOverviewPanelProps) {
  const [cursor, setCursor] = useState(0);
  const [detailCursor, setDetailCursor] = useState(0);
  const [editingField, setEditingField] = useState<DetailFieldId | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [authUrlPending, setAuthUrlPending] = useState<string | null>(null);
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

  // Unified focus stops on Overview: accounts -> "+ Add provider" -> installed CLIs.
  const addStop = accounts.length;
  const cliStart = accounts.length + 1;
  const totalStops = cliStart + UPDATABLE_PROVIDERS.length;
  const safeCursor = Math.min(cursor, Math.max(0, totalStops - 1));

  useEffect(() => {
    if (selected !== null || wizard !== null) return;
    const targetId =
      safeCursor < accounts.length
        ? `providers-account-${safeCursor}`
        : safeCursor === addStop
          ? "providers-add-row"
          : `providers-cli-${UPDATABLE_PROVIDERS[safeCursor - cliStart]}`;
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(targetId), 0);
    return () => clearTimeout(timer);
  }, [safeCursor, accounts.length, addStop, cliStart, selected, wizard]);

  useKeyboard((key) => {
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
          setWizard({ step: "kind", kindIndex: Math.min(wizard.kindIndex + 1, ACCOUNT_PROVIDER_KINDS.length - 1) });
        } else if (key.name === "up" || key.name === "k") {
          setWizard({ step: "kind", kindIndex: Math.max(wizard.kindIndex - 1, 0) });
        } else if (enter) {
          setWizard({ step: "id", kind: ACCOUNT_PROVIDER_KINDS[wizard.kindIndex]! });
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
      } else if (safeCursor === addStop) {
        setWizard({ step: "kind", kindIndex: 0 });
      } else {
        const cli = UPDATABLE_PROVIDERS[safeCursor - cliStart];
        if (cli && !updating.has(cli) && !updatingAll) onUpdate(cli);
      }
    } else if (key.name === "space" && safeCursor < accounts.length) {
      const target = accounts[safeCursor];
      if (target) void onToggleAccount(target.kind, target.id, !target.enabled);
    } else if (key.name === "a" && !key.ctrl && !key.meta) {
      setWizard({ step: "kind", kindIndex: 0 });
    } else if (key.name === "u" && !key.shift && !key.ctrl && !key.meta && safeCursor >= cliStart) {
      const cli = UPDATABLE_PROVIDERS[safeCursor - cliStart];
      if (cli && !updating.has(cli) && !updatingAll) onUpdate(cli);
    } else if (key.sequence === "U" && !key.ctrl && !key.meta) {
      onUpdateAll();
    }
  });

  if (wizard !== null) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <Chip label={t("ui.back")} onPress={() => setWizard(null)} accent />
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
                {ACCOUNT_PROVIDER_KINDS.map((kind, at) => {
                  const focused = at === wizard.kindIndex;
                  const bg = focused ? SURFACE.hover : SURFACE.raised;
                  return (
                    <box
                      key={kind}
                      style={{ flexDirection: "column", marginBottom: 1, paddingLeft: 1, paddingRight: 1 }}
                      backgroundColor={bg}
                      onMouseDown={() => setWizard({ step: "id", kind })}
                      selectable={false}
                    >
                      <text fg={focused ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>
                        {`${focused ? "▌ " : "  "}${KIND_NAME[kind]}`}
                      </text>
                      <box style={{ paddingLeft: 2 }} backgroundColor={bg}>
                        <text fg={COLOR.dim} bg={bg} wrapMode="word" selectable={false}>
                          {kindDescription(kind)}
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
                initial=""
                placeholder={defaultIdPlaceholder()}
                width={Math.max(20, width - 4)}
                onSubmit={(value) => {
                  const id = value.trim().toLowerCase();
                  if (!id) return;
                  setWizard({ step: "label", kind: wizard.kind, id });
                }}
              />
            </>
          ) : wizard.step === "label" ? (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.addLabel")}
              </text>
              <TextField
                initial=""
                placeholder={wizard.id}
                fallback={wizard.id}
                width={Math.max(20, width - 4)}
                onSubmit={(value) => setWizard({ step: "home", kind: wizard.kind, id: wizard.id, label: value.trim() })}
              />
            </>
          ) : (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
                {t("settings.providers.addHome")}
              </text>
              <TextField
                initial=""
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
          <Chip label={t("ui.back")} onPress={() => onSelectAccount(null)} accent />
          <box style={{ flexDirection: "row", gap: 1 }} backgroundColor={SURFACE.raised}>
            <box onMouseDown={() => void onToggleAccount(selected.kind, selected.id, !selected.enabled)} backgroundColor={SURFACE.raised}>
              <text fg={selected.enabled ? COLOR.added : COLOR.dim} bg={SURFACE.raised} selectable={false}>
                {toggleLabel(selected.enabled)}
              </text>
            </box>
            <Chip label={t("settings.providers.openProvider")} onPress={() => onOpenSection(kindToSection(selected.kind))} accent />
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
              <box style={{ flexDirection: "row", gap: 1 }} backgroundColor={SURFACE.panel}>
                {selected.signedIn ? (
                  <Chip
                    label={t("settings.providers.signOut")}
                    onPress={() => {
                      setPairFeedback(null);
                      void onChatGptLogout?.(selected.id);
                    }}
                  />
                ) : (
                  <Chip
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
                {selected.signedIn ? (
                  <Chip
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
                <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                  {t("settings.providers.openAuthUrl", { url: authUrlPending })}
                </text>
              ) : !selected.codexVerified ? (
                <text fg={COLOR.dim} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                  {t("settings.providers.unpairedHint")}
                </text>
              ) : null}
              {pairFeedback?.text ? (
                <text fg={COLOR.danger} bg={SURFACE.panel} wrapMode="word" selectable={false}>
                  {pairFeedback.text}
                </text>
              ) : null}
            </box>
          ) : null}
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
                />
              </Fragment>
            );
          })}
          <box style={{ flexDirection: "row", marginTop: 2, paddingLeft: 1, gap: 2 }} backgroundColor={SURFACE.raised}>
            <Chip
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
            label={t("settings.providers.addButton")}
            keyHint="a"
            accent
            onPress={() => setWizard({ step: "kind", kindIndex: 0 })}
          />
          <Chip
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
        {accounts.length === 0 ? (
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
          accounts.map((account, at) => {
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
          })
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
