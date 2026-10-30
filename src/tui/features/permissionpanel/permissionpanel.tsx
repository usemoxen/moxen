import { t } from "../../i18n/index.js";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";

import { PICK_BG, PICK_FG } from "../pickers/pickermodal.js";
import { HoverButton } from "../../ui/hoverbutton.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import type { PermissionDecision } from "../../../server/protocol.js";
import type { PendingPermissionRequest } from "../../model/thread.js";

/** A command is a glance, not a document: a long one clips rather than push the transcript away. */
const DETAIL_MAX_ROWS = 6;

function headline(request: PendingPermissionRequest): string {
  switch (request.classification) {
    case "command-execution":
      return t("perm.run_shell_command_5bd9");
    case "file-change":
      return t("perm.edit_file_178f");
    case "file-read":
      return t("perm.read_7a1a");
    default:
      return t("perm.use", { tool: request.toolName });
  }
}

/**
 * Inline tool-approval UI replacing the composer while the agent waits on a
 * permission (Claude-Code style): what the tool would do, then yes / yes for
 * the session / no. Owns its keys exactly like the answer panel — the app
 * swallows every other binding while this is mounted.
 */
export function PermissionPanel({
  request,
  width,
  suspended,
  onDecide,
}: {
  request: PendingPermissionRequest;
  /** Outer width, border included — same slot the composer fills. */
  width: number;
  /** A modal prompt is open above: ignore keys but keep rendering. */
  suspended: boolean;
  onDecide: (decision: PermissionDecision) => void;
}) {
  const [highlight, setHighlight] = useState(0);
  const rows: ReadonlyArray<{ key: PermissionDecision; label: string; meta?: string }> = [
    { key: "accept", label: t("perm.1_yes_d834") },
    { key: "accept-session", label: t("perm.yesAlways", { tool: request.toolName }), meta: t("perm.this_session_1855") },
    { key: "decline", label: "3. No" },
  ];

  useKeyboard((key) => {
    if (suspended) return;
    if (key.name === "up") {
      setHighlight((current) => (current - 1 + rows.length) % rows.length);
      return;
    }
    if (key.name === "down") {
      setHighlight((current) => (current + 1) % rows.length);
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      const row = rows[highlight];
      if (row !== undefined) onDecide(row.key);
      return;
    }
    if (key.ctrl === true || key.meta === true) return;
    const digit = /^([1-3])$/.exec(key.name);
    const row = digit?.[1] === undefined ? undefined : rows[Number.parseInt(digit[1], 10) - 1];
    if (row !== undefined) onDecide(row.key);
  });

  const inner = Math.max(10, width - 6);

  return (
    <box style={{ width, flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
      <box
        border={["left"]}
        borderStyle="heavy"
        borderColor={COLOR.warn}
        style={{
          flexDirection: "column",
          backgroundColor: SURFACE.raised,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
        selectable={false}
      >
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.warn} bg={SURFACE.raised} selectable={false}>
            {truncate(`◈ ${headline(request)}`, inner)}
          </text>
          <HoverButton label=" × " fg={COLOR.faint} hoverFg={COLOR.danger} bg={SURFACE.raised} onClick={() => onDecide("decline")} />
        </box>
        {request.description === null ? null : (
          <box style={{ flexShrink: 0 }} backgroundColor={SURFACE.raised}>
            <text fg={COLOR.dim} bg={SURFACE.raised}>
              {truncate(request.description, inner)}
            </text>
          </box>
        )}
        {request.detail === null ? null : (
          <box
            border
            borderStyle="rounded"
            borderColor={SURFACE.border}
            style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1, maxHeight: DETAIL_MAX_ROWS + 2 }}
            backgroundColor={SURFACE.raised}
          >
            <text fg={COLOR.bright} bg={SURFACE.raised}>
              {request.detail}
            </text>
          </box>
        )}
        <box style={{ flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.bright} bg={SURFACE.raised}>
            {t("perm.proceed")}
          </text>
        </box>
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          {rows.map((row, order) => {
            const active = order === highlight;
            return (
              <box
                key={row.key}
                style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}
                backgroundColor={active ? PICK_BG : SURFACE.raised}
                onMouseDown={() => onDecide(row.key)}
                onMouseOver={() => setHighlight(order)}
              >
                <text fg={active ? PICK_FG : COLOR.text} bg={active ? PICK_BG : SURFACE.raised} selectable={false}>
                  {`${active ? "❯ " : "  "}${truncate(row.label, Math.max(0, inner - (row.meta === undefined ? 4 : row.meta.length + 5)))}`}
                </text>
                {row.meta === undefined ? null : (
                  <text fg={active ? PICK_FG : COLOR.faint} bg={active ? PICK_BG : SURFACE.raised} selectable={false}>
                    {` ${row.meta}`}
                  </text>
                )}
              </box>
            );
          })}
        </box>
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "flex-end" }}>
        <text fg={COLOR.faint}>{truncate(t("perm.move_13_pick_enter_39e3"), Math.max(0, width))}</text>
      </box>
    </box>
  );
}
