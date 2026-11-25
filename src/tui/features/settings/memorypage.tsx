import type { ClientApi, QueryResult } from "../../../server/api.js";
import { t } from "../../i18n/index.js";
import { MemoryManager, type MemoryFooter, type MemoryFooterRow } from "../memory/memorymanager.js";
import { MemoryRuntimePanel, memoryActionLabel } from "../memory/memoryruntime.js";

/**
 * The Settings page's Memory tab: the memory manager itself, with the
 * runtime — the embedding setup, the keyword mode and this section's settings
 * — riding below the memories instead of above a hidden button. Everything it
 * shows and everything it writes goes through the server, like the modal the
 * command palette opens; nothing here touches the store or the config file.
 */

/** One of the memory section's settings, as the page's runtime rows show it. */
export interface MemorySettingRow {
  /** The row's id, stable per setting: scrolling and clicks key off it. */
  readonly id: string;
  readonly label: string;
  /** The value as it reads (`● On`, a choice's label), already localized. */
  readonly value: string;
  /** The schema's description, shown under the row. */
  readonly description: string;
  /** What a change waits for, localized (`next session`); absent applies now. */
  readonly appliesAt?: string | undefined;
  /** Enter or a click on the row: flip it, or take its next choice. Absent where the control offers no in-place next value. */
  readonly onActivate?: (() => void) | undefined;
}

export function MemoryPage({
  client,
  threadId,
  width,
  status,
  saving,
  memorySwitch,
  onSetup,
  onCancel,
  onKeyword,
  rows,
  onEscapeList,
}: {
  client: ClientApi;
  /** The open thread: its project is the page's project scope. */
  threadId: string | null;
  /** The pane's width; the manager sizes its rows and headers to it. */
  width: number;
  /** The embedding runtime, polled by the settings screen while this tab shows. */
  status: QueryResult<"memory.embeddings.status"> | null;
  /** The panel's buttons stand down while a setting it drives is being saved. */
  saving: boolean;
  /** The memory switch as the live settings snapshot has it, driving the writes the page stands down. */
  memorySwitch: boolean;
  onSetup: () => void;
  onCancel: () => void;
  onKeyword: () => void;
  rows: readonly MemorySettingRow[];
  /** Escape on the list (nothing is open): the settings screen closes. */
  onEscapeList: () => void;
}) {
  const busy = saving || status?.busy === true;
  /**
   * The runtime actions as rows, so the arrows and Enter reach what the page's
   * bare letter keys (r, c) gave up to the search: cancel while it is busy,
   * otherwise the setup or recheck and the keyword mode. A search pulls them
   * out of the walk (see the manager), the same as the setting rows.
   */
  const actionRows: readonly MemoryFooterRow[] = busy
    ? [{ id: "memory-runtime-cancel", label: memoryActionLabel("memory.cancel", false), value: "", onActivate: onCancel }]
    : [
        { id: "memory-runtime-action", label: memoryActionLabel(status?.validation ? "memory.recheck" : "memory.setup", false), value: "", onActivate: onSetup },
        { id: "memory-runtime-keyword", label: t("memory.keyword"), value: "", onActivate: onKeyword },
      ];
  const footer: MemoryFooter = {
    heading: t("mem.runtime"),
    node: (
      <MemoryRuntimePanel status={status} saving={saving} hotkeys={false} onSetup={onSetup} onCancel={onCancel} onKeyword={onKeyword} />
    ),
    rows: [
      ...actionRows,
      ...rows.map((row) => ({
        id: row.id,
        label: row.appliesAt === undefined ? row.label : `${row.label} (${row.appliesAt})`,
        value: row.value,
        description: row.description,
        onActivate: row.onActivate,
      })),
    ],
  };
  return (
    <MemoryManager
      client={client}
      threadId={threadId}
      width={width}
      onEscapeList={onEscapeList}
      footer={footer}
      memorySwitch={memorySwitch}
      tabLeavesList
      escClearsFilter
    />
  );
}
