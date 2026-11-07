import { useCallback, useState } from "react";
import type { ClientApi } from "../../../server/api.js";
import { t } from "../../i18n/index.js";
import { COLOR, SURFACE } from "../../theme.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { ModalShell } from "../../ui/modalshell.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { ChoiceList, KeyHints } from "./parts.js";

/** Cancelling a delegated task's automatic continue, waiting on the user's choice. */
export interface AutoContinueCancelRequest {
  readonly threadId: string;
  readonly title: string;
  readonly cancel: (notifyParent: boolean) => void;
}

/**
 * The TUI side of cancelling an automatic continue: when the thread is a
 * delegated task that notifies its parent, the modal asks whether the parent
 * hears about it (default) or not. Anything else cancels straight through
 * with the server's default (notify), including a failed delegation read.
 */
export function useAutoContinueCancel(client: ClientApi): {
  readonly pending: AutoContinueCancelRequest | null;
  readonly request: (threadId: string, title: string, cancel: (notifyParent: boolean) => void) => void;
  readonly close: () => void;
} {
  const [pending, setPending] = useState<AutoContinueCancelRequest | null>(null);
  const close = useCallback(() => setPending(null), []);
  const request = useCallback(
    (threadId: string, title: string, cancel: (notifyParent: boolean) => void) => {
      void client.query({ type: "thread.delegation", threadId }).then(
        (info) => {
          if (info && info.notify) setPending({ threadId, title, cancel });
          else cancel(true);
        },
        () => cancel(true),
      );
    },
    [client],
  );
  return { pending, request, close };
}

/**
 * Cancel and notify parent (default), Cancel without notifying, Go back.
 * The first row starts focused, so enter takes the default.
 */
export function CancelAutoContinueModal({
  title,
  screenWidth,
  screenHeight,
  onNotify,
  onSilent,
  onBack,
}: {
  title: string;
  screenWidth: number;
  screenHeight: number;
  onNotify: () => void;
  onSilent: () => void;
  onBack: () => void;
}) {
  const width = Math.min(76, Math.max(48, screenWidth - 4));
  const height = 14;
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(0, Math.floor((screenHeight - height) / 2));
  const inner = Math.max(10, width - 4);
  const back = () => {
    markModalDismissed();
    onBack();
  };
  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={back}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <OverflowText fg={COLOR.bright} bg={SURFACE.raised} selectable={false} width={inner - 11}>
          {t("autocancel.title")}
        </OverflowText>
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
        <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
          {t("autocancel.detail", { title })}
        </text>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>
        <ChoiceList
          width={inner}
          height={3}
          onBack={back}
          choices={[
            { key: "notify", label: t("autocancel.notify"), onPick: onNotify },
            { key: "silent", label: t("autocancel.silent"), onPick: onSilent },
            { key: "back", label: t("autocancel.back"), onPick: back },
          ]}
        />
      </box>
      <box style={{ height: 1, flexShrink: 0, marginTop: 1 }}>
        <KeyHints hints={[{ key: "↑↓", label: t("queue.key.choose") }, { key: "enter", label: t("queue.key.pick") }, { key: "esc", label: t("queue.key.back"), onClick: back }]} />
      </box>
    </ModalShell>
  );
}
