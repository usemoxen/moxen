import { t } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import type { KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core";
import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";

import { COLOR, SURFACE } from "../../theme.js";

const ONE_LINE_BINDINGS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
] as never[];
const MULTI_LINE_BINDINGS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "linefeed", action: "newline" },
] as never[];

/**
 * The one text box every setting uses, on the page and in the list editor: it
 * wraps instead of scrolling sideways, grows with what is typed (a few rows for
 * prose, one for an address), takes a paste whole, and says under itself how to
 * save, how to clear it and what clearing falls back to. A secret is shown as asterisks
 * in the box, and as a count.
 */
export function TextField({
  id,
  initial,
  placeholder,
  multiline,
  secret,
  fallback,
  width,
  onGrow,
  onSubmit,
}: {
  /** Lets a scroll view bring the whole box into sight when it opens. */
  id?: string;
  initial: string;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  /** What an empty answer means, in words ("the default, claude", "removes the saved key"). */
  fallback?: string;
  width: number;
  /** The box got taller as text wrapped or lines were added: a chance to scroll it back into sight. */
  onGrow?: () => void;
  onSubmit: (text: string) => void;
}) {
  const ref = useRef<TextareaRenderable | null>(null);
  const [text, setText] = useState(initial);
  const clean = (raw: string) => (multiline ? raw.replace(/\r\n?/g, "\n").trim() : raw.replace(/\s*[\r\n]+\s*/g, " ").trim());
  const hidden = secret === true;
  const height = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(10, width - 4))), 0);
  useEffect(() => {
    if (onGrow === undefined) return;
    const timer = setTimeout(onGrow, 30);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);
  const rows = multiline ? { minHeight: 4, maxHeight: 10 } : { minHeight: 1, maxHeight: 3 };
  const lines = text.split("\n").length;
  const size = text.length === 0 ? "" : multiline ? t("tf.charsLines", { chars: text.length, count: lines }) : t("tf.chars", { count: text.length });
  // Each hint is a key and what it does, the key lit and the verb quiet.
  const hints: ReadonlyArray<readonly [string, string]> = [
    ["enter", t("tf.save")],
    ...(multiline ? ([["shift+enter", t("tf.newLine")]] as const) : []),
    ["esc", t("tf.cancel")],
    ["ctrl+u", t("tf.clear")],
  ];

  return (
    <box {...(id === undefined ? {} : { id })} style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
      <box
        style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1, borderStyle: "rounded" }}
        borderColor={COLOR.accent}
        backgroundColor={SURFACE.base}
      >
        <box style={{ flexDirection: "column", flexShrink: 0 }} backgroundColor={SURFACE.base}>
        <textarea
          ref={ref}
          focused
          initialValue={initial}
          placeholder={placeholder ?? ""}
          wrapMode={multiline ? "word" : "char"}
          textColor={hidden ? SURFACE.base : COLOR.text}
          backgroundColor={SURFACE.base}
          focusedBackgroundColor={SURFACE.base}
          focusedTextColor={hidden ? SURFACE.base : COLOR.bright}
          placeholderColor={COLOR.faint}
          keyBindings={multiline ? MULTI_LINE_BINDINGS : ONE_LINE_BINDINGS}
          style={{ ...rows, backgroundColor: SURFACE.base }}
          onContentChange={() => setText(ref.current?.plainText ?? "")}
          onPaste={(event: PasteEvent) => {
            const node = ref.current;
            if (node === null) return;
            // One line takes a pasted address or path whole, newlines and escape codes gone.
            event.preventDefault();
            node.insertText(clean(stripAnsiSequences(decodePasteBytes(event.bytes))));
          }}
          onKeyDown={(key: KeyEvent) => {
            if (key.ctrl && key.name === "u") {
              key.preventDefault();
              ref.current?.clear();
              setText("");
            }
          }}
          onSubmit={() => onSubmit(clean(ref.current?.plainText ?? text))}
        />
        {hidden && text !== "" ? (
          // The text itself is drawn in the box's own colour; asterisks stand over it, one for each character, wrapping where it does.
          <text style={{ position: "absolute", left: 0, top: 0, width: Math.max(10, width - 4) }} fg={COLOR.text} bg={SURFACE.base} wrapMode="char" selectable={false}>{"*".repeat(text.length)}</text>
        ) : null}
        </box>
      </box>
      <box style={{ flexDirection: "row", justifyContent: "space-between", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }} backgroundColor={SURFACE.raised}>
        <box style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 1 }} backgroundColor={SURFACE.raised}>
          {hints.map(([keyName, verb]) => (
            <box key={keyName} style={{ flexDirection: "row", flexShrink: 0, marginRight: 2 }} backgroundColor={SURFACE.raised}>
              <text fg={COLOR.text} bg={SURFACE.raised} selectable={false}>{keyName}</text>
              <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{` ${verb}`}</text>
            </box>
          ))}
        </box>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
          {hidden ? (text === "" ? "" : t("tf.charsHidden", { count: text.length })) : size}
        </text>
      </box>
      {fallback === undefined ? null : (
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("tf.leftEmpty", { what: fallback })}</text>
      )}
    </box>
  );
}
