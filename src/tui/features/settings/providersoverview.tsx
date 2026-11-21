import { spawn } from "node:child_process";
import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import type { ProviderSummary } from "../../../core/catalog/summary.js";
import {
  describeUpdate,
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
import { t, tx } from "../../i18n/index.js";
import type { ProviderCheckView } from "../../model/settings.js";
import { COLOR, SURFACE } from "../../theme.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { TextField } from "./textfield.js";

const KIND_NAME: Record<AccountProviderKind, string> = {
  claude: "Claude Code",
  chatgpt: "ChatGPT",
  antigravity: "Antigravity",
};

const CLI_NAME: Record<UpdatableProvider, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  antigravity: "Antigravity",
};

function kindToSection(kind: AccountProviderKind): SettingSection {
  return kind === "claude" ? "provider:claude" : kind === "chatgpt" ? "provider:chatgpt" : "provider:antigravity";
}

function defaultHomeHint(kind: AccountProviderKind, id: string): string {
  const prefix = kind === "claude" ? "~/.claude-" : kind === "antigravity" ? "~/.agy-" : "~/.codex-";
  return `${prefix}${id}`;
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

interface DetailField {
  readonly id: DetailFieldId;
  readonly label: string;
  readonly value: string;
}

function fieldsForAccount(account: ProviderAccountSummary): readonly DetailField[] {
  const isChatGpt = account.kind === "chatgpt";
  return [
    { id: "label", label: t("settings.providers.field.label"), value: account.label },
    {
      id: "binaryPath",
      label: t("settings.providers.field.binaryPath"),
      value: (isChatGpt ? account.codexBinaryPath : account.binaryPath) ?? "",
    },
    {
      id: "homePath",
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
      label: t("settings.providers.field.launchArgs"),
      value: (isChatGpt ? account.codexLaunchArgs : account.launchArgs) ?? "",
    },
    { id: "model", label: t("settings.providers.field.model"), value: account.model ?? "" },
    { id: "thinkingEffort", label: t("settings.providers.field.thinkingEffort"), value: account.thinkingEffort ?? "" },
    { id: "env", label: t("settings.providers.field.env"), value: formatEnvMap(account.env) },
  ];
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

  const selected = selectedInstance === null
    ? null
    : (accounts.find((entry) => entry.instanceId === selectedInstance) ?? null);
  const detailFields = selected ? fieldsForAccount(selected) : [];

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
        if (enter) {
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
      setCursor((at) => Math.min(at + 1, Math.max(0, accounts.length - 1)));
    } else if (key.name === "up" || key.name === "k") {
      setCursor((at) => Math.max(at - 1, 0));
    } else if (enter && accounts.length > 0) {
      const target = accounts[Math.min(cursor, accounts.length - 1)];
      if (target) {
        setDetailCursor(0);
        setConfirmRemove(false);
        onSelectAccount(target.instanceId);
      }
    } else if (key.name === "space" && accounts.length > 0) {
      const target = accounts[Math.min(cursor, accounts.length - 1)];
      if (target) void onToggleAccount(target.kind, target.id, !target.enabled);
    } else if (key.name === "a" && !key.ctrl && !key.meta) {
      setWizard({ step: "kind", kindIndex: 0 });
    } else if (key.sequence === "U" && !key.ctrl && !key.meta) {
      onUpdateAll();
    }
  });

  if (wizard !== null) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} onMouseDown={() => setWizard(null)}>
          <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("ui.back")}</text>
        </box>
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD}>{t("settings.providers.addTitle")}</text>
          {wizard.step === "kind" ? (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.providers.addKind")}</text>
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                {ACCOUNT_PROVIDER_KINDS.map((kind, at) => (
                  <box
                    key={kind}
                    style={{ flexDirection: "row", height: 1 }}
                    backgroundColor={at === wizard.kindIndex ? SURFACE.border : SURFACE.raised}
                    onMouseDown={() => setWizard({ step: "id", kind })}
                  >
                    <text fg={at === wizard.kindIndex ? COLOR.bright : COLOR.text} bg={at === wizard.kindIndex ? SURFACE.border : SURFACE.raised}>
                      {`${at === wizard.kindIndex ? "▌ " : "  "}${KIND_NAME[kind]}`}
                    </text>
                  </box>
                ))}
              </box>
            </>
          ) : wizard.step === "id" ? (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.providers.addId")}</text>
              <TextField
                initial=""
                placeholder="personal"
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
              <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.providers.addLabel")}</text>
              <TextField
                initial=""
                placeholder={wizard.id}
                width={Math.max(20, width - 4)}
                onSubmit={(value) => setWizard({ step: "home", kind: wizard.kind, id: wizard.id, label: value.trim() })}
              />
            </>
          ) : (
            <>
              <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.providers.addHome")}</text>
              <TextField
                initial=""
                placeholder={defaultHomeHint(wizard.kind, wizard.id)}
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
    const cliKind: UpdatableProvider | null = selected.kind === "claude" ? "claude" : selected.kind === "antigravity" ? "antigravity" : "codex";
    const ver = cliKind ? versionNumber(versions?.[cliKind]?.version ?? null) : null;
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
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
          <box style={{ flexDirection: "row" }} onMouseDown={() => onSelectAccount(null)}>
            <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("ui.back")}</text>
          </box>
          <box style={{ flexDirection: "row", gap: 2 }}>
            <box onMouseDown={() => void onToggleAccount(selected.kind, selected.id, !selected.enabled)}>
              <text fg={selected.enabled ? COLOR.accent : COLOR.dim} bg={SURFACE.raised} selectable={false}>
                {`[ ${selected.enabled ? t("settings.providers.statusOn") : t("settings.providers.statusOff")} ]`}
              </text>
            </box>
            <box onMouseDown={() => onOpenSection(kindToSection(selected.kind))}>
              <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("settings.providers.openProvider")}</text>
            </box>
          </box>
        </box>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, justifyContent: "space-between" }}>
          <OverflowText fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} width={Math.max(12, width - 14)}>
            {`${KIND_NAME[selected.kind]} · ${selected.label} (${selected.instanceId})`}
          </OverflowText>
          {ver ? <text fg={COLOR.dim} bg={SURFACE.raised}>{`v${ver}`}</text> : null}
        </box>
        {status ? (
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <OverflowText fg={COLOR.dim} bg={SURFACE.raised} width={width}>{status}</OverflowText>
          </box>
        ) : null}
        {selected.kind === "chatgpt" ? (
          <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
            <box style={{ flexDirection: "row", gap: 2 }}>
              {selected.signedIn ? (
                <box
                  onMouseDown={() => {
                    setPairFeedback(null);
                    void onChatGptLogout?.(selected.id);
                  }}
                >
                  <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{t("settings.providers.signOut")}</text>
                </box>
              ) : (
                <box
                  onMouseDown={() => {
                    if (authUrlPending !== null || !onChatGptLogin) return;
                    setPairFeedback(null);
                    void onChatGptLogin(selected.id, selected.label).then((started) => {
                      if (!started) return;
                      setAuthUrlPending(started.authorizationUrl);
                      openBrowserUrl(started.authorizationUrl);
                      void started.done.finally(() => setAuthUrlPending(null));
                    });
                  }}
                >
                  <text fg={authUrlPending ? COLOR.dim : COLOR.accent} bg={SURFACE.raised} selectable={false}>
                    {authUrlPending ? t("settings.providers.signingIn") : t("settings.providers.signInChatGpt")}
                  </text>
                </box>
              )}
              {selected.signedIn ? (
                <box
                  onMouseDown={() => {
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
                >
                  <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false}>
                    {pairFeedback?.needsConfirmation ? t("settings.providers.confirmPairCodex") : t("settings.providers.pairCodex")}
                  </text>
                </box>
              ) : null}
            </box>
            {authUrlPending ? (
              <OverflowText fg={COLOR.dim} bg={SURFACE.raised} width={width}>
                {t("settings.providers.openAuthUrl", { url: authUrlPending })}
              </OverflowText>
            ) : !selected.codexVerified ? (
              <OverflowText fg={COLOR.dim} bg={SURFACE.raised} width={width}>
                {t("settings.providers.unpairedHint")}
              </OverflowText>
            ) : null}
            {pairFeedback?.text ? (
              <OverflowText fg={COLOR.danger} bg={SURFACE.raised} width={width}>{pairFeedback.text}</OverflowText>
            ) : null}
          </box>
        ) : null}
        <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
          {detailFields.map((field, at) => {
            const focused = at === activeField;
            const isEditing = editingField === field.id;
            return (
              <box
                key={field.id}
                style={{ flexDirection: "column", marginBottom: 1 }}
                backgroundColor={focused ? SURFACE.border : SURFACE.raised}
                onMouseDown={() => {
                  setDetailCursor(at);
                  setEditingField(field.id);
                }}
              >
                <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
                  <text fg={focused ? COLOR.bright : COLOR.text} bg={focused ? SURFACE.border : SURFACE.raised}>
                    {field.label}
                  </text>
                  <text fg={field.value ? COLOR.text : COLOR.faint} bg={focused ? SURFACE.border : SURFACE.raised}>
                    {field.value || t("settings.default")}
                  </text>
                </box>
                {isEditing ? (
                  <box style={{ paddingLeft: 1, paddingRight: 1 }}>
                    <TextField
                      initial={field.value}
                      width={Math.max(18, width - 6)}
                      onSubmit={(next) => saveField(field.id, next)}
                    />
                  </box>
                ) : null}
              </box>
            );
          })}
          <box style={{ flexDirection: "row", marginTop: 1, gap: 2 }}>
            <box onMouseDown={() => setConfirmRemove(true)}>
              <text fg={COLOR.danger} bg={SURFACE.raised} selectable={false}>{t("settings.providers.remove")}</text>
            </box>
            {saving ? <text fg={COLOR.dim} bg={SURFACE.raised}>{t("settings.reading")}</text> : null}
          </box>
          {confirmRemove ? (
            <text fg={COLOR.danger} bg={SURFACE.raised}>
              {t("settings.providers.confirmRemove", { id: selected.instanceId })}
            </text>
          ) : null}
          {error ? <text fg={COLOR.danger} bg={SURFACE.raised}>{error}</text> : null}
        </scrollbox>
      </box>
    );
  }

  const safeCursor = accounts.length === 0 ? -1 : Math.min(cursor, accounts.length - 1);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>
          {t("settings.providers.heading")}
        </text>
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, gap: 2 }}>
        <box onMouseDown={() => setWizard({ step: "kind", kindIndex: 0 })}>
          <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("settings.providers.addButton")}</text>
        </box>
        <box onMouseDown={onUpdateAll}>
          <text fg={updatingAll ? COLOR.dim : COLOR.accent} bg={SURFACE.raised} selectable={false}>
            {updatingAll ? t("settings.providers.updatingAll") : t("settings.providers.updateAllButton")}
          </text>
        </box>
      </box>

      <scrollbox style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
        {accounts.length === 0 ? (
          <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word">{t("settings.providers.empty")}</text>
        ) : (
          accounts.map((account, at) => {
            const active = at === safeCursor;
            const bg = active ? SURFACE.border : SURFACE.raised;
            const cliKind: UpdatableProvider = account.kind === "claude" ? "claude" : account.kind === "antigravity" ? "antigravity" : "codex";
            const ver = versionNumber(versions?.[cliKind]?.version ?? null);
            const status = accountStatusLine(account, providers);
            return (
              <box
                key={account.instanceId}
                style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}
                backgroundColor={bg}
                onMouseDown={() => {
                  setCursor(at);
                  setDetailCursor(0);
                  onSelectAccount(account.instanceId);
                }}
              >
                <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <OverflowText fg={active ? COLOR.bright : COLOR.text} bg={bg} width={Math.max(12, width - 16)}>
                    {`${KIND_NAME[account.kind]} · ${account.label}${ver ? ` v${ver}` : ""}`}
                  </OverflowText>
                  <box onMouseDown={() => void onToggleAccount(account.kind, account.id, !account.enabled)}>
                    <text fg={account.enabled ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>
                      {`[ ${account.enabled ? t("settings.providers.statusOn") : t("settings.providers.statusOff")} ]`}
                    </text>
                  </box>
                </box>
                <OverflowText fg={COLOR.dim} bg={bg} width={Math.max(12, width - 4)}>
                  {`${account.instanceId}${status ? ` · ${status}` : ""}`}
                </OverflowText>
              </box>
            );
          })
        )}

        <box style={{ flexDirection: "row", height: 1, marginTop: 1 }}>
          <text fg={COLOR.bright} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>
            {t("settings.providers.clisHeading")}
          </text>
        </box>
        {UPDATABLE_PROVIDERS.map((cli) => {
          const check = versions?.[cli];
          const installedVer = versionNumber(check?.version ?? null);
          const newest = latest?.enabled ? latest[cli]?.latest ?? null : null;
          const busy = updating.has(cli) || updatingAll;
          const buttonLabel = busy
            ? t("settings.update.updating")
            : newest && installedVer && newest !== installedVer
              ? t("settings.update.buttonTo", { version: newest })
              : t("settings.update.button");
          return (
            <box key={cli} style={{ flexDirection: "row", justifyContent: "space-between", height: 1, paddingLeft: 1, paddingRight: 1 }}>
              <OverflowText fg={COLOR.text} bg={SURFACE.raised} width={Math.max(12, width - 22)}>
                {`${CLI_NAME[cli]} ${installedVer ? `v${installedVer}` : check?.installed === false ? "—" : ""}`}
              </OverflowText>
              <box onMouseDown={() => onUpdate(cli)}>
                <text fg={busy ? COLOR.dim : COLOR.accent} bg={SURFACE.raised} selectable={false}>{buttonLabel}</text>
              </box>
            </box>
          );
        })}

        {updateAllResults && updateAllResults.length > 0 ? (
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            {updateAllResults.map((item) => (
              <OverflowText
                key={item.provider}
                fg={item.ok ? COLOR.dim : COLOR.danger}
                bg={SURFACE.raised}
                width={width}
              >
                {item.ok ? tx(describeUpdate(item.update)) : `${CLI_NAME[item.provider]}: ${item.error}`}
              </OverflowText>
            ))}
          </box>
        ) : null}
        {error ? <text fg={COLOR.danger} bg={SURFACE.raised}>{error}</text> : null}
      </scrollbox>
    </box>
  );
}
