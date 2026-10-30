import { t as tr, tx } from "../../i18n/index.js";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { KeyEvent, MouseEvent, PasteEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { SyntaxStyle, TextAttributes, bg, decodePasteBytes, fg, italic, stripAnsiSequences, t } from "@opentui/core";

import { useHover } from "../../hooks/useHover.js";
import { useAnimTick } from "../../hooks/useAnimTick.js";
import { PICK_BG, PICK_FG } from "../pickers/pickermodal.js";
import { COLOR, MODE_COLOR, MODE_PULSE, pulseColor, SURFACE, truncate } from "../../theme.js";
import { interactionModeLabel } from "../../model/modes.js";
import type { InteractionMode } from "../../../core/types.js";
import { thumbGeometry } from "../../model/scrollbar.js";
import { detectSkillTrigger, filterSkills, insertSkillMention, leadingCommandRange, type SkillTrigger } from "../../model/skills.js";
import { SkillPicker, SKILL_POPUP_ROWS } from "./skillpicker.js";
import type { SkillSummary } from "../../../core/catalog/summary.js";
import type { ContextUsageDisplay } from "../../model/turns.js";
import type { PlanUsageGauge } from "../../model/sidepanel.js";
import { nextImageLabel, pairImageTokens, relabelImageTokens } from "../../model/imagetokens.js";
import { imageFromDataUrl, type LoadedImage, type Rect } from "../../model/imagethumb.js";
import { openImageViewer } from "../timeline/imageviewer.js";
import { hideImagePreview, showImagePreview, useImagePreviewVisible } from "../timeline/imagepreview.js";

/** Marquee tick for the highlighted row's description, ms per column. */
const SKILL_MARQUEE_INTERVAL_MS = 350;

/** A footer label (model, effort, stop) that brightens on hover — clicking
    chrome, so never part of a text selection. */
function HoverText({
  text,
  color,
  hoverColor,
  onClick,
  surface = SURFACE.raised,
}: {
  text: string;
  color: string;
  hoverColor: string;
  onClick: () => void;
  /** What the label sits on: the card's surface by default, null outside it (the pane shows through). */
  surface?: string | null;
}) {
  const { hovered, handlers } = useHover();
  return (
    <text fg={hovered ? hoverColor : color} {...(surface === null ? {} : { bg: surface })} selectable={false} onMouseDown={onClick} {...handlers}>
      {text}
    </text>
  );
}

/**
 * The provider's guess at the next prompt, as the empty draft's placeholder:
 * the text itself in italics, then a key chip saying how to take it — one
 * line, cut short rather than wrapped under the chip. A narrow composer
 * (beside an open panel) sheds "to use it" before it cuts deep into the
 * suggestion, and the chip itself only when even that leaves no room.
 */
function suggestionPlaceholder(suggestion: string, width: number) {
  // The textarea's own width: the left border, padding 2 + 1, and the
  // scrollbar strip. Budgeting against more wrapped the tail onto a line
  // of its own — a lone "…" with the chip under it.
  const inner = Math.max(1, width - 5);
  const flat = suggestion.replace(/\s+/gu, " ").trim();
  const chip = bg(SURFACE.border)(fg(COLOR.bright)(" tab "));
  const MIN_TEXT = 24;
  if (inner - 18 >= Math.min(MIN_TEXT, flat.length)) {
    return t`${fg(COLOR.dim)(italic(truncate(flat, inner - 18)))}   ${chip}${fg(COLOR.faint)(tr("composer.to_use_it_e06b"))}`;
  }
  if (inner - 7 >= Math.min(12, flat.length)) return t`${fg(COLOR.dim)(italic(truncate(flat, inner - 7)))}  ${chip}`;
  return t`${fg(COLOR.dim)(italic(truncate(flat, inner)))}`;
}

/** The account's plan usage in the footer: one short gauge per window, coloured as it fills. */
function usageColor(percent: number): string {
  return percent >= 90 ? COLOR.danger : percent >= 70 ? COLOR.warn : COLOR.dim;
}

function PlanUsageSegment({ gauges, onClick, surface = SURFACE.raised }: { gauges: readonly PlanUsageGauge[]; onClick: () => void; surface?: string | null }) {
  const { hovered, handlers } = useHover();
  const on = surface === null ? {} : { bg: surface };
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} {...(surface === null ? {} : { backgroundColor: surface })} onMouseDown={onClick} selectable={false} {...handlers}>
      {gauges.map((gauge, index) => (
        <box key={gauge.short} style={{ flexDirection: "row", height: 1, flexShrink: 0 }} {...(surface === null ? {} : { backgroundColor: surface })}>
          <text fg={hovered ? COLOR.text : COLOR.faint} {...on} selectable={false}>{`${index === 0 ? "" : " "}${gauge.short} `}</text>
          <text fg={hovered ? COLOR.bright : usageColor(gauge.percent)} {...on} selectable={false}>{`${Math.round(gauge.percent)}%`}</text>
        </box>
      ))}
    </box>
  );
}

/** How an `[Image #N]` token reads in the draft: a filled chip, one unit to the cursor and to backspace. */
let tokenStyle: SyntaxStyle | null = null;
function imageTokenStyle(): SyntaxStyle {
  tokenStyle ??= SyntaxStyle.fromStyles({
    "extmark.image": { fg: PICK_FG, bg: PICK_BG, bold: true },
    // A leading /command the picker knows: coloured, but ordinary editable text.
    "extmark.command": { fg: COLOR.command, bold: true },
  });
  return tokenStyle;
}

/** The "⋯ more" control's width, its separator included. */
const MORE_WIDTH = 11;

/** OpenCode caps its prompt at ~10 rows before the box scrolls internally. */
const MAX_COMPOSER_LINES = 10;
/** Resting height so the composer reads as an input card, not a status line. */
const MIN_COMPOSER_LINES = 3;

/**
 * The textarea scrolls internally past `MAX_COMPOSER_LINES` with no native
 * bar (a `<scrollbox>` cannot wrap a textarea), so the composer draws its
 * own 1-column strip at the card's right edge, as tall as the draft's
 * visible rows: faint track, accent thumb, blank while the draft fits.
 *
 * The textarea wraps and scrolls while it renders — after React has already
 * drawn this strip — so reading its rows during React's render always lags
 * one frame (and a wheel scroll or a programmatic `setText` fires no React
 * event at all). A post-frame check re-renders the strip whenever the rows or
 * offset it last drew no longer match the textarea's.
 */
function ComposerScrollbar({ areaRef }: { areaRef: RefObject<TextareaRenderable | null> }) {
  const renderer = useRenderer();
  const [, bump] = useState(0);
  const drawn = useRef("");
  useEffect(() => {
    const check = (): void => {
      const node = areaRef.current;
      const seen = node === null ? "" : `${node.lineInfo.lineStartCols.length}:${node.scrollY}`;
      if (seen !== drawn.current) bump((tick) => tick + 1);
    };
    renderer.addPostProcessFn(check);
    return () => renderer.removePostProcessFn(check);
  }, [renderer, areaRef]);
  const area = areaRef.current;
  // The column is always reserved (blank while the draft fits): the draft's
  // wrap width must not change as the thumb comes and goes, or a draft right
  // at the cap would re-wrap under/over it and flip the strip every frame.
  const blank = <box style={{ width: 1, flexShrink: 0 }} selectable={false} />;
  if (area === null) {
    drawn.current = "";
    return blank;
  }
  drawn.current = `${area.lineInfo.lineStartCols.length}:${area.scrollY}`;
  // Total VISUAL rows come from lineInfo, not virtualLineCount (which caps
  // at the viewport height) or lineCount (which ignores word wrap).
  const total = area.lineInfo.lineStartCols.length;
  const viewRows = Math.min(MAX_COMPOSER_LINES, Math.max(MIN_COMPOSER_LINES, total));
  // The track is the textarea's own rows: the card's selector row and the
  // spacer under it sit above the draft and stay clear of the strip.
  const trackTop = 2;
  const thumb = thumbGeometry(total, viewRows, area.scrollY);
  if (thumb === null) return blank;
  return (
    <box style={{ width: 1, flexShrink: 0, flexDirection: "column" }} selectable={false}>
      <box style={{ height: trackTop, flexShrink: 0 }} backgroundColor={SURFACE.raised} />
      {Array.from({ length: viewRows }, (_, row) => {
        const onThumb = row >= thumb.start && row < thumb.start + thumb.size;
        return (
          <text key={row} fg={onThumb ? COLOR.accent : COLOR.faint} bg={COLOR.faint} selectable={false}>
            {onThumb ? "█" : " "}
          </text>
        );
      })}
    </box>
  );
}

/**
 * Enter sends; several chords insert a newline because terminals disagree on
 * what Shift+Enter emits. Legacy terminals send it as bare `linefeed` (the
 * same byte as Ctrl+J), Kitty-streamed ones report `return` with modifiers,
 * so both families — plus Ctrl/Meta+Enter fallbacks — must mean newline.
 * Bare `return` (the `\r` most terminals send for Enter) stays as submit.
 */
const COMPOSER_KEY_BINDINGS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "kpenter", ctrl: true, action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
  { name: "linefeed", ctrl: true, action: "newline" },
] as never[];

export function Composer({
  draft,
  resetKey,
  onInput,
  onSubmit,
  onEscape,
  onFocus,
  focused,
  placeholder,
  model,
  modelColor,
  effort,
  permission,
  flushTop,
  onModelClick,
  onEffortClick,
  onPermissionClick,
  onStopClick,
  onCopyClick,
  onExternalEditClick,
  onAttachClick,
  pathAttachments,
  onPathRemoved,
  editingExternally,
  submitVerb,
  running,
  waitingOutLimit,
  width,
  hideHint,
  skills,
  onSkillsOpen,
  contextUsage,
  onContextUsageClick,
  backgroundSummary,
  onBackgroundClick,
  planUsage,
  onPlanUsageClick,
  onQueue,
  attachments,
  attachmentDataUrl,
  onAttachmentRemoved,
  onClaimPaste,
  suggestion,
  notice,
  mode = "default",
  onCycleMode,
}: {
  draft: string;
  /**
   * Changes only on a genuine external reset (thread switch, post-send
   * clear) — never on ordinary typing. Driving the sync effect off this
   * instead of `draft` itself removes the race entirely: comparing draft
   * text against the textarea's own buffer could false-negative on any
   * normalization difference (trailing newline, CRLF) and stomp mid-typing
   * content with a stale value the moment the parent's state round-tripped.
   */
  resetKey: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onEscape: () => void;
  onFocus: () => void;
  focused: boolean;
  placeholder: string;
  /** Pretty model name — never the raw provider slug. */
  model: string;
  /** Provider-brand color for the model name (Claude/OpenCode); null/undefined falls back to the default text color. */
  modelColor?: string | null | undefined;
  /** Effort knob value (e.g. `xhigh`); null hides the segment. */
  effort?: string | null;
  /** Pretty permission level (e.g. `Full access`); null hides the segment. */
  permission?: string | null;
  /** Pending attachments sit directly above: drop the top margin to sit flush. */
  flushTop?: boolean;
  /** Footer segments open the model/effort/permission picker modals on click. */
  onModelClick?: () => void;
  onEffortClick?: () => void;
  onPermissionClick?: () => void;
  /** A running turn gets a clickable stop control in the footer instead of
      relying on a key. */
  onStopClick?: () => void;
  /** Copies the current draft text to the clipboard; omitted hides the segment. */
  onCopyClick?: () => void;
  /** Opens the draft in `$EDITOR`; omitted hides the segment. Alt+E also triggers it. */
  onExternalEditClick?: () => void;
  /** Opens the OS dialog to attach files and folders: their paths go in the prompt. First control of the bottom row. */
  onAttachClick?: () => void;
  /**
   * The files and folders attached to the draft. Each shows in the draft as a
   * chip (its label) where it was attached, like an image's token, and goes out
   * as its path in that place; deleting the chip detaches it.
   */
  pathAttachments?: readonly { id: string; label: string }[];
  onPathRemoved?: (id: string) => void;
  /** The draft is open in the external editor — textarea unfocuses and hints pause. */
  editingExternally?: boolean;
  submitVerb: "creates" | "sends";
  /** A turn is in flight, so escape stops it rather than just unfocusing. */
  running: boolean;
  /** A continue waits for a usage limit to reset: a send queues behind it. */
  waitingOutLimit?: boolean;
  /** Outer width of the composer, border included. */
  width: number;
  /** The "creating" view renders its own centered hint below the composer;
      suppress this one so it isn't shown twice. */
  hideHint?: boolean;
  /** Undefined hides `/` skill invocation entirely (no catalog loaded yet). */
  skills?: readonly SkillSummary[] | undefined;
  /** The picker just opened: a chance to ask the provider for a fresher list (a skill added since). */
  onSkillsOpen?: () => void;
  /** Null/undefined hides the segment — the driver never reported usage for this thread. */
  contextUsage?: ContextUsageDisplay | null;
  onContextUsageClick?: () => void;
  /** e.g. "2 shell, 1 monitor"; null/undefined hides the segment. */
  backgroundSummary?: string | null;
  onBackgroundClick?: () => void;
  /** The provider's plan usage windows; null/undefined/empty hides the segment. */
  planUsage?: readonly PlanUsageGauge[] | null;
  onPlanUsageClick?: () => void;
  /** Tab while a turn runs: queue the draft to run once the turn ends (Enter steers it instead). */
  onQueue?: () => void;
  /**
   * The pending images, by name, in order. Each shows in the draft as an
   * `[Image #N]` token where it was pasted; deleting the token detaches it.
   */
  attachments?: readonly string[];
  /** A pending image's bytes as a data URL, by name: what hovering its token shows. */
  attachmentDataUrl?: (name: string) => string | undefined;
  onAttachmentRemoved?: (name: string) => void;
  /**
   * A paste arriving: when it is moxen's own copy of a prompt with images,
   * the app attaches them again and returns their names (in token order);
   * null leaves the paste as plain text.
   */
  onClaimPaste?: (text: string) => string[] | null;
  /** The provider's guess at the next prompt: shown in an empty draft, Tab takes it. */
  suggestion?: string | null;
  /**
   * A notice docked into the card's own header, above a hairline rule and
   * the draft — the creating view's server notice, which over a backdrop
   * would otherwise need an opaque slab of its own. Omitted in a thread,
   * where the banner sits over the composer on the pane's own surface.
   */
  notice?: ReactNode;
  /** The thread's mode: colours the left edge and its running pulse; the footer always names it. */
  mode?: InteractionMode;
  /** Shift+Tab, or a click on the footer's mode: the next mode (Build → Research → Orchestrate). */
  onCycleMode?: () => void;
}) {
  const areaRef = useRef<TextareaRenderable | null>(null);
  /** Each pending image's token in the draft: its extmark and label, by attachment name. */
  const tokens = useRef(new Map<string, { id: number; label: string }>());
  const tokenType = useRef<number | null>(null);
  /** The same for each attached file or folder, by its id (the path). */
  const pathTokens = useRef(new Map<string, { id: number; label: string }>());
  const markPathToken = (node: TextareaRenderable, id: string, label: string, start: number) => {
    tokenType.current ??= node.extmarks.registerType("image-token");
    const styleId = imageTokenStyle().getStyleId("extmark.image");
    const mark = node.extmarks.create({
      start,
      end: start + label.length,
      virtual: true,
      typeId: tokenType.current,
      ...(styleId === null ? {} : { styleId }),
    });
    pathTokens.current.set(id, { id: mark, label });
  };
  const markToken = (node: TextareaRenderable, name: string, label: string, start: number) => {
    tokenType.current ??= node.extmarks.registerType("image-token");
    const styleId = imageTokenStyle().getStyleId("extmark.image");
    const id = node.extmarks.create({
      start,
      end: start + label.length,
      virtual: true,
      typeId: tokenType.current,
      ...(styleId === null ? {} : { styleId }),
    });
    tokens.current.set(name, { id, label });
  };
  /**
   * The image token under the pointer, with where it sits on screen. The
   * text area has no pointer-to-text lookup, so each token's start and end are
   * found by asking the editor where its cursor would be there (and putting
   * the cursor back); a token that wraps spans more than one row.
   */
  const tokenAt = (node: TextareaRenderable, x: number, y: number): { name: string; anchor: Rect } | null => {
    const keep = node.cursorOffset;
    try {
      const scroll = node.editorView.getViewport().offsetY;
      for (const [name, token] of tokens.current) {
        const mark = node.extmarks.get(token.id);
        if (mark === null) continue;
        node.cursorOffset = mark.start;
        const from = { ...node.visualCursor };
        node.cursorOffset = mark.end;
        const to = { ...node.visualCursor };
        for (let row = from.visualRow; row <= to.visualRow; row += 1) {
          const first = row === from.visualRow ? from.visualCol : 0;
          const last = row === to.visualRow ? to.visualCol : node.width;
          const screenRow = node.screenY + row - scroll;
          if (y === screenRow && x >= node.screenX + first && x < node.screenX + last) {
            return { name, anchor: { x: node.screenX + first, y: screenRow, width: Math.max(1, last - first), height: 1 } };
          }
        }
      }
      return null;
    } finally {
      node.cursorOffset = keep;
    }
  };
  /** The token whose image is showing, and the images already decoded for hovering. */
  const previewing = useRef<string | null>(null);
  const decodedImages = useRef(new Map<string, LoadedImage | null>());
  const hidePreview = () => {
    if (previewing.current === null) return;
    hideImagePreview(`composer:${previewing.current}`);
    previewing.current = null;
  };
  /** The decoded image of a pending attachment, null when it cannot be shown. */
  const decodedImage = (name: string): LoadedImage | null => {
    let image = decodedImages.current.get(name);
    if (image === undefined) {
      const dataUrl = attachmentDataUrl?.(name);
      image = dataUrl === undefined ? null : imageFromDataUrl(dataUrl);
      decodedImages.current.set(name, image);
    }
    return image;
  };
  /** A click on an image token opens the image full screen. */
  const openTokenAt = (x: number, y: number) => {
    const node = areaRef.current;
    const hit = node === null ? null : tokenAt(node, x, y);
    const image = hit === null ? null : decodedImage(hit.name);
    if (hit !== null && image !== null) openImageViewer({ ...image, label: hit.name, sizeBytes: image.bytes.length });
  };
  const previewTokenAt = (x: number, y: number) => {
    const node = areaRef.current;
    const hit = node === null ? null : tokenAt(node, x, y);
    if (hit === null) {
      hidePreview();
      return;
    }
    if (previewing.current === hit.name) return;
    hidePreview();
    previewing.current = hit.name;
    const image = decodedImage(hit.name);
    if (image !== null) showImagePreview({ id: `composer:${hit.name}`, bytes: image.bytes, size: image.size, anchor: hit.anchor });
  };
  useEffect(() => hidePreview, []);
  // The text cursor would blink over the preview image.
  const previewVisible = useImagePreviewVisible();
  /** The extmark colouring the draft's leading /command, when it names a known one. */
  const commandMark = useRef<number | null>(null);
  const commandType = useRef<number | null>(null);
  const knownCommands = useMemo(() => new Set((skills ?? []).map((skill) => skill.name)), [skills]);
  const markCommand = (node: TextareaRenderable) => {
    if (commandMark.current !== null) node.extmarks.delete(commandMark.current);
    commandMark.current = null;
    const range = leadingCommandRange(node.plainText, knownCommands);
    if (range === null) return;
    commandType.current ??= node.extmarks.registerType("command-token");
    const styleId = imageTokenStyle().getStyleId("extmark.command");
    commandMark.current = node.extmarks.create({
      start: range[0],
      end: range[1],
      virtual: false,
      typeId: commandType.current,
      ...(styleId === null ? {} : { styleId }),
    });
  };
  const attachmentKey = (attachments ?? []).join("\n");
  /** The "⋯ more" menu of footer controls a narrow composer cannot fit. */
  const [moreOpen, setMoreOpen] = useState(false);
  const localRef = useRef(draft);
  const external = editingExternally === true;
  // No height estimate here: the textarea shrink-wraps its content, so the
  // box always fits the text exactly. A parallel width calc drifted from the
  // real wrap width and left phantom empty rows behind.
  const fullHint =
    submitVerb === "creates"
      ? tr("composer.enter_creates_esc_cancels_817f")
      : waitingOutLimit === true
        ? tr("composer.enter_queues_after_the_1a27")
      : running
        ? tr("composer.enter_steers_tab_queues_300e")
        : tr("composer.enter_sends_shiftenter_newline_cf80");
  const midHint =
    submitVerb === "creates"
      ? fullHint
      : waitingOutLimit === true
        ? tr("composer.enter_queues_after_the_ade4")
      : running
        ? tr("composer.enter_steers_tab_queues_6b21")
        : tr("composer.enter_sends_shiftenter_newline_e724");
  const shortHint = submitVerb === "creates" ? tr("composer.enter_creates_6799") : waitingOutLimit === true ? tr("composer.enter_queues_dae1") : running ? tr("composer.enter_steers_a135") : tr("composer.enter_sends_c341");
  const externalHint = tr("composer.editing_in_external_editor_05b4");

  // The textarea owns its buffer; only an explicit external reset (thread
  // switch, post-send clear — signaled by `resetKey` changing) pushes a value
  // into it. Keystrokes flow the other way via onContentChange.
  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    localRef.current = draft;
    node.setText(draft);
    // A restored draft reads "[Image #1]" as plain text: give each pending
    // image its token back (the rest are placed at the next attach pass).
    node.extmarks.clear();
    tokens.current.clear();
    pathTokens.current.clear();
    commandMark.current = null;
    for (const span of pairImageTokens(draft, attachments ?? []).paired) markToken(node, span.name, span.label, span.start);
    // A restored draft reads a path chip as plain text too; one whose chip is no longer in it (the draft was cleared) is detached.
    for (const attached of pathAttachments ?? []) {
      const at = draft.indexOf(attached.label);
      if (at === -1) onPathRemoved?.(attached.id);
      else markPathToken(node, attached.id, attached.label, at);
    }
    markCommand(node);
    // `draft` is read at the moment `resetKey` changes, not tracked as its
    // own dependency — see the `resetKey` doc comment above. `external` is a
    // dependency because the textarea is unmounted while the editor is open:
    // a reset that lands then has no node to write to, and the textarea that
    // comes back is empty, so it must be filled again when it returns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, external]);

  // A newly pending image gets its token at the cursor; one no longer
  // pending (sent, or removed elsewhere) lets go of its token.
  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    const names = attachments ?? [];
    for (const [name, token] of [...tokens.current]) {
      if (names.includes(name)) continue;
      node.extmarks.delete(token.id);
      tokens.current.delete(name);
    }
    for (const name of names) {
      if (tokens.current.has(name)) continue;
      const label = nextImageLabel([...tokens.current.values()].map((token) => token.label));
      const start = node.cursorOffset;
      node.insertText(`${label} `);
      markToken(node, name, label, start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentKey]);

  // A newly attached file or folder gets its chip at the cursor; one no longer attached lets go of it.
  const pathKey = (pathAttachments ?? []).map((attached) => attached.id).join("\n");
  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    const wanted = pathAttachments ?? [];
    for (const [id, token] of [...pathTokens.current]) {
      if (wanted.some((attached) => attached.id === id)) continue;
      node.extmarks.delete(token.id);
      pathTokens.current.delete(id);
    }
    for (const attached of wanted) {
      if (pathTokens.current.has(attached.id)) continue;
      const start = node.cursorOffset;
      node.insertText(`${attached.label} `);
      markPathToken(node, attached.id, attached.label, start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey]);

  const [skillTrigger, setSkillTrigger] = useState<SkillTrigger | null>(null);
  const [skillIndex, setSkillIndex] = useState(0);
  const skillScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [skillMarqueeTick, setSkillMarqueeTick] = useState(0);
  // Only a keyboard-driven selection should auto-scroll the pane. Hover
  // updating the same index must NOT: OpenTUI recomputes hover from the
  // last known cursor position whenever layout shifts (no true mouse-move
  // events), so scrolling on a hover-driven change would move the rows
  // under a stationary cursor, fire hover again for whatever row landed
  // there, and fight the keyboard selection every time it crossed a page.
  const skillNavSourceRef = useRef<"keyboard" | "mouse">("keyboard");

  const skillMatches = useMemo(() => {
    if (skillTrigger === null || skills === undefined) return [];
    return filterSkills(skills, skillTrigger.query);
  }, [skillTrigger, skills]);
  const safeSkillIndex = skillMatches.length === 0 ? -1 : Math.min(Math.max(0, skillIndex), skillMatches.length - 1);
  const skillPopupRows = Math.min(SKILL_POPUP_ROWS, Math.max(1, skillMatches.length));

  useEffect(() => {
    const pane = skillScrollRef.current;
    if (pane === null || safeSkillIndex < 0 || skillNavSourceRef.current !== "keyboard") return;
    if (safeSkillIndex < pane.scrollTop) pane.scrollTo(safeSkillIndex);
    else if (safeSkillIndex >= pane.scrollTop + skillPopupRows) pane.scrollTo(safeSkillIndex - skillPopupRows + 1);
  }, [safeSkillIndex, skillPopupRows]);

  // Opening the picker is when a stale list gets asked for again (see `useSkillInventory`).
  useEffect(() => {
    if (skillTrigger !== null) onSkillsOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillTrigger !== null]);

  // The highlighted row's description auto-scrolls instead of sitting
  // truncated — ticks only while the picker is actually open.
  useEffect(() => {
    if (skillTrigger === null) return;
    const timer = setInterval(() => setSkillMarqueeTick((tick) => tick + 1), SKILL_MARQUEE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [skillTrigger !== null]);
  useEffect(() => {
    setSkillMarqueeTick(0);
  }, [safeSkillIndex]);

  const insertSkill = (skill: SkillSummary) => {
    if (skillTrigger === null) return;
    const text = areaRef.current?.plainText ?? localRef.current;
    const result = insertSkillMention(text, skillTrigger, skill.name);
    const node = areaRef.current;
    if (node !== null) {
      node.setText(result.text);
      node.cursorOffset = result.cursorOffset;
    }
    localRef.current = result.text;
    onInput(result.text);
    setSkillTrigger(null);
  };

  // Only an empty draft offers the suggestion — the same moment the textarea
  // shows its placeholder, which is where the suggestion appears. Anything
  // typed, even a space, is the user's own.
  const offeredSuggestion = suggestion !== undefined && suggestion !== null && draft.length === 0 && !external ? suggestion : null;

  // The inventory answers about a second after the composer opens, so a "/"
  // typed in that gap was never offered (the change handler skips detection
  // without a catalog) and nothing would re-read it once the catalog landed.
  // Re-read the draft when the catalog arrives, and drop the picker when it goes
  // (a model switch fetches a new one).
  useEffect(() => {
    if (skills === undefined) {
      setSkillTrigger(null);
      return;
    }
    const text = areaRef.current?.plainText ?? localRef.current;
    setSkillTrigger(detectSkillTrigger(text, areaRef.current?.cursorOffset ?? text.length));
    setSkillIndex(0);
    // Keyed on whether a catalog exists, not on its identity: a re-render must not reset the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills !== undefined]);

  // The catalog arrives after the first keystrokes: colour what was typed before it did.
  useEffect(() => {
    const node = areaRef.current;
    if (node !== null) markCommand(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownCommands]);

  const handleContentChange = () => {
    if (external) return;
    const text = areaRef.current?.plainText ?? "";
    localRef.current = text;
    onInput(text);
    // A token deleted (backspace takes it whole) detaches its image.
    const node = areaRef.current;
    if (node !== null) markCommand(node);
    if (node !== null) {
      for (const [name, token] of [...tokens.current]) {
        if (node.extmarks.get(token.id) !== null) continue;
        tokens.current.delete(name);
        onAttachmentRemoved?.(name);
      }
      for (const [id, token] of [...pathTokens.current]) {
        if (node.extmarks.get(token.id) !== null) continue;
        pathTokens.current.delete(id);
        onPathRemoved?.(id);
      }
    }
    if (skills === undefined) return;
    const cursor = areaRef.current?.cursorOffset ?? text.length;
    setSkillTrigger(detectSkillTrigger(text, cursor));
    skillNavSourceRef.current = "keyboard";
    setSkillIndex(0);
  };

  // Each segment carries its width and a drop rank: a narrow composer (a
  // side panel open) sheds the highest ranks first rather than letting the
  // right-hand group run over the model label. `metric` segments are status
  // (context, plan usage, shells); `action` ones are things to click.
  type Segment = { key: string; render: (surface: string | null) => ReactNode; width: number; drop: number; group: "metric" | "action" };
  const candidates: Segment[] = [];
  if (contextUsage !== undefined && contextUsage !== null) {
    const text =
      contextUsage.percent === null
        ? contextUsage.usedLabel
        : `${contextUsage.percent}% · ${contextUsage.usedLabel}${contextUsage.maxLabel === null ? "" : `/${contextUsage.maxLabel}`}`;
    candidates.push({
      key: "context",
      width: text.length,
      drop: 2,
      group: "metric",
      render: (surface) => <HoverText text={text} color={COLOR.dim} hoverColor={COLOR.bright} onClick={onContextUsageClick ?? (() => undefined)} surface={surface} />,
    });
  }
  if (planUsage !== undefined && planUsage !== null && planUsage.length > 0) {
    candidates.push({
      key: "plan",
      width: planUsage.reduce((total, gauge, index) => total + gauge.short.length + String(Math.round(gauge.percent)).length + 2 + (index === 0 ? 0 : 1), 0),
      drop: 3,
      group: "metric",
      render: (surface) => <PlanUsageSegment gauges={planUsage} onClick={onPlanUsageClick ?? (() => undefined)} surface={surface} />,
    });
  }
  if (backgroundSummary !== undefined && backgroundSummary !== null) {
    candidates.push({
      key: "background",
      width: backgroundSummary.length,
      drop: 1,
      group: "metric",
      render: (surface) => <HoverText text={backgroundSummary} color={COLOR.dim} hoverColor={COLOR.bright} onClick={onBackgroundClick ?? (() => undefined)} surface={surface} />,
    });
  }
  if (onCopyClick !== undefined) {
    candidates.push({
      key: "copy",
      width: 6,
      drop: 5,
      group: "action",
      render: (surface) => <HoverText text={tr("composer.copy_1b18")} color={COLOR.dim} hoverColor={COLOR.bright} onClick={onCopyClick} surface={surface} />,
    });
  }
  if (onExternalEditClick !== undefined) {
    candidates.push({
      key: "external",
      width: 10,
      drop: 4,
      group: "action",
      render: (surface) => <HoverText text={tr("composer.external_59fc")} color={COLOR.dim} hoverColor={COLOR.bright} onClick={onExternalEditClick} surface={surface} />,
    });
  }
  if (running && onStopClick !== undefined) {
    candidates.push({
      key: "stop",
      width: 6,
      drop: 0,
      group: "action",
      render: (surface) => <HoverText text={tr("composer.stop_6aae")} color={COLOR.danger} hoverColor={COLOR.bright} onClick={onStopClick} surface={surface} />,
    });
  }
  // Card chrome: border 1, left padding 2, the draft column's right padding
  // 1 and the scrollbar strip 1. The model group keeps two columns of air.
  const footerRoom = width - 5;
  const modeLabel = tx(interactionModeLabel(mode));
  const usedBy = (segments: readonly Segment[]) => segments.reduce((total, segment, index) => total + segment.width + (index === 0 ? 0 : 5), 0);
  /** What of `list` fits in `room`, shedding the highest drop rank first (a rank of 0 never goes). */
  const fitTo = (list: readonly Segment[], room: number, base = 0) => {
    const kept = [...list];
    while (kept.length > 0 && base + usedBy(kept) > room) {
      const victim = kept.reduce((worst, segment) => (segment.drop > worst.drop ? segment : worst));
      if (victim.drop === 0) break;
      kept.splice(kept.indexOf(victim), 1);
    }
    return kept;
  };

  // Every control has a fixed slot, whatever the provider reports, so nothing moves when the model or the
  // provider does. Top row: mode, model and effort on the left, plan usage and context on the right. Bottom
  // row: permission and background tasks on the left, copy, external and stop on the right. A control with
  // nothing to show leaves its slot blank.
  const permissionText = permission === null || permission === undefined ? "" : permission;
  const topSelectorsWidth = modeLabel.length + model.length + 3 + (effort === null || effort === undefined || effort.length === 0 ? 0 : effort.length + 3) + 2;
  const topRightAll = ["plan", "context"].flatMap((key) => candidates.filter((segment) => segment.key === key));
  const topRightKept = fitTo(topRightAll, footerRoom - topSelectorsWidth);
  const topHidden = topRightAll.filter((segment) => !topRightKept.includes(segment));
  const bottomAll = candidates.filter((segment) => segment.key === "background" || segment.group === "action");
  const attachText = onAttachClick === undefined ? "" : tr("composer.attach");
  // The attach control leads the bottom row and never goes behind "more".
  const bottomBase = permissionText.length + 2 + (attachText.length === 0 ? 0 : attachText.length + 5);
  let bottomKept = fitTo(bottomAll, footerRoom, bottomBase);
  // Whatever does not fit goes behind a "⋯ more" control (which takes room of its own); the menu lists only
  // the hidden segments, never the ones still visible (showing both is what duplicated `stop`).
  if (topHidden.length > 0 || bottomKept.length < bottomAll.length) bottomKept = fitTo(bottomAll, footerRoom - MORE_WIDTH, bottomBase);
  const overflow = [...topHidden, ...bottomAll.filter((segment) => !bottomKept.includes(segment))];
  const hidden = overflow.length > 0;
  const menuShown = moreOpen && hidden && skillTrigger === null;
  const bottomShown: Segment[] = hidden
    ? [
        ...bottomKept,
        {
          key: "more",
          width: MORE_WIDTH - 5,
          drop: 0,
          group: "action",
          render: (surface) => <HoverText text={menuShown ? tr("composer.more_379b") : tr("composer.more_6b09")} color={COLOR.dim} hoverColor={COLOR.bright} onClick={() => setMoreOpen((open) => !open)} surface={surface} />,
        },
      ]
    : bottomKept;
  // The permission is a slot of its own: a segment like the others.
  const permissionSegment: Segment | null =
    permissionText.length === 0
      ? null
      : {
          key: "permission",
          width: permissionText.length,
          drop: 0,
          group: "metric",
          render: (surface) => <HoverText text={permissionText} color={COLOR.dim} hoverColor={COLOR.bright} onClick={onPermissionClick ?? (() => undefined)} surface={surface} />,
        };
  const attachSegment: Segment | null =
    onAttachClick === undefined
      ? null
      : {
          key: "attach",
          width: attachText.length,
          drop: 0,
          group: "metric",
          render: (surface) => <HoverText text={attachText} color={COLOR.dim} hoverColor={COLOR.bright} onClick={onAttachClick} surface={surface} />,
        };
  // The key hint under the card, cut to the longest form that fits.
  const STATUS_INDENT = 3;
  const hintRoom = width - STATUS_INDENT;
  const statusHint = external ? externalHint : [fullHint, midHint, shortHint].find((candidate) => candidate.length <= hintRoom) ?? "";

  /** Segments in a row on the card's surface, a faint rule between them. */
  const segmentRow = (list: readonly Segment[]) => (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
      {list.map((segment, index) => (
        <box key={segment.key} style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
          {index === 0 ? null : (
            <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
              {"  │  "}
            </text>
          )}
          {segment.render(SURFACE.raised)}
        </box>
      ))}
    </box>
  );
  // Mode, model and effort.
  const selectorsRow = (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised}>
      {onCycleMode === undefined ? (
        <text fg={MODE_COLOR[mode]} bg={SURFACE.raised} selectable={false}>
          {modeLabel}
        </text>
      ) : (
        <HoverText text={modeLabel} color={MODE_COLOR[mode]} hoverColor={COLOR.bright} onClick={onCycleMode} />
      )}
      <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
        {" · "}
      </text>
      {onModelClick === undefined ? (
        <text fg={modelColor ?? COLOR.text} bg={SURFACE.raised} selectable={false}>
          {model}
        </text>
      ) : (
        <HoverText text={model} color={modelColor ?? COLOR.text} hoverColor={COLOR.bright} onClick={onModelClick} />
      )}
      {effort === null || effort === undefined || effort.length === 0 ? null : onEffortClick === undefined ? (
        <text fg={COLOR.warn} bg={SURFACE.raised} selectable={false}>
          {` · ${effort}`}
        </text>
      ) : (
        <HoverText text={` · ${effort}`} color={COLOR.warn} hoverColor={COLOR.bright} onClick={onEffortClick} />
      )}
    </box>
  );
  const spacer = <box style={{ height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} />;
  const topRow = (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
      {selectorsRow}
      {topRightKept.length === 0 ? null : segmentRow(topRightKept)}
    </box>
  );
  const bottomRow = (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
      {segmentRow([...(attachSegment === null ? [] : [attachSegment]), ...(permissionSegment === null ? [] : [permissionSegment]), ...bottomShown.filter((segment) => segment.group === "metric")])}
      {segmentRow(bottomShown.filter((segment) => segment.group === "action"))}
    </box>
  );
  const hintShown = !external && hideHint !== true && statusHint.length > 0;

  // Focused border breathes while a turn runs — subtle glow, static
  // otherwise. Gated internally so idle composers never re-render.
  const borderTick = useAnimTick(running && focused, 400);
  const frameBorderColor =
    running && focused ? pulseColor(borderTick, MODE_COLOR[mode], MODE_PULSE[mode], 2400) : focused ? MODE_COLOR[mode] : SURFACE.border;

  return (
    // Stacked above its siblings (tasks panel, banners, attachment strip):
    // the popovers it floats over them (skills list, context card) are its
    // own children, and a child's zIndex only orders it among its siblings.
    <box style={{ width, flexDirection: "column", flexShrink: 0, marginTop: flushTop === true ? 0 : 1, zIndex: 20 }}>
      {!menuShown ? null : (
        // The overflow only, stacked just above the footer row and over the
        // draft, right-aligned under the "more" control that opened it: a
        // real card (full rounded frame) rather than a bare left-border
        // strip, so it reads as a menu instead of stray text. Compact —
        // one row per segment, no header or gaps — so it fits above the
        // footer even in short frames.
        <box
          style={{ position: "absolute", right: 1, bottom: 3, flexDirection: "column", zIndex: 24, paddingLeft: 2, paddingRight: 2 }}
          borderStyle="rounded"
          borderColor={SURFACE.borderFocus}
          backgroundColor={SURFACE.raised}
        >
          {overflow.map((segment) => (
            <box
              key={segment.key}
              style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "flex-start" }}
              backgroundColor={SURFACE.raised}
              onMouseDown={() => setMoreOpen(false)}
            >
              {segment.render(SURFACE.raised)}
            </box>
          ))}
        </box>
      )}
      {skillTrigger === null ? null : (
        // Floats just above the composer's own top edge, live over whatever
        // the textarea is doing underneath it.
        <SkillPicker
          matches={skillMatches}
          query={skillTrigger.query}
          activeIndex={safeSkillIndex}
          marqueeTick={skillMarqueeTick}
          width={width}
          rows={skillPopupRows}
          hasCatalog={skills !== undefined && skills.length > 0}
          scrollRef={skillScrollRef}
          onPick={insertSkill}
          onHover={(index) => {
            skillNavSourceRef.current = "mouse";
            setSkillIndex(index);
          }}
        />
      )}
      <box
        border={["left"]}
        borderStyle="heavy"
        borderColor={frameBorderColor}
        style={{
          flexDirection: "column",
          backgroundColor: SURFACE.raised,
          // No right padding here: the draft's column keeps its own, and the
          // scrollbar strip sits flush against the card's right edge.
          paddingLeft: 2,
          paddingTop: 1,
            paddingBottom: 1,
        }}
        onMouseDown={onFocus}
        selectable={false}
      >
        {notice === undefined ? null : (
          // The card's own status header: the pane's surface stops at the
          // card, so a notice here needs no slab behind it — the hairline
          // below is what keeps it off the draft.
          <box
            border={["bottom"]}
            borderColor={SURFACE.border}
            style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1, paddingRight: 1, backgroundColor: SURFACE.raised }}
          >
            {notice}
          </box>
        )}
        {external ? (
          // The draft lives in `$EDITOR`: the textarea and every footer
          // toggleable (model, effort, permission, context, copy,
          // external, stop) hide behind one centered italic notice.
          // minHeight matches the resting composer (textarea min +
          // spacer + footer) so the layout doesn't jump when the editor
          // opens or closes.
          <box
            style={{
              minHeight: MIN_COMPOSER_LINES + 3,
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: SURFACE.raised,
            }}
          >
            <text
              fg={COLOR.dim}
              bg={SURFACE.raised}
              attributes={TextAttributes.ITALIC}
              selectable={false}
            >
              {tr("app.editing_in_external_editor_da08")}
            </text>
          </box>
        ) : (
          // The scrollbar strip runs down the card's right edge beside the
          // draft, starting at the draft's first row: content keeps its own
          // right inset inside the column, the strip sits flush outside it.
          <box style={{ flexDirection: "row", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
            <box style={{ flexDirection: "column", flexGrow: 1, paddingRight: 1 }}>
        {topRow}
        {spacer}
        <textarea
          ref={areaRef}
          focused={focused && !external}
          placeholder={offeredSuggestion === null ? placeholder : suggestionPlaceholder(offeredSuggestion, width)}
          textColor={COLOR.text}
          backgroundColor={SURFACE.raised}
          focusedBackgroundColor={SURFACE.raised}
          focusedTextColor={COLOR.bright}
          placeholderColor={COLOR.faint}
          wrapMode="word"
          syntaxStyle={imageTokenStyle()}
          keyBindings={COMPOSER_KEY_BINDINGS}
          style={{ minHeight: MIN_COMPOSER_LINES - 1, maxHeight: MAX_COMPOSER_LINES, backgroundColor: SURFACE.raised }}
          onContentChange={handleContentChange}
          onMouseMove={(event: MouseEvent) => previewTokenAt(event.x, event.y)}
          onMouseDown={(event: MouseEvent) => openTokenAt(event.x, event.y)}
          onMouseOut={hidePreview}
          onMouseScroll={hidePreview}
          showCursor={!previewVisible}
          onPaste={(event: PasteEvent) => {
            const node = areaRef.current;
            if (node === null || onClaimPaste === undefined) return;
            const text = stripAnsiSequences(decodePasteBytes(event.bytes)).replace(/\r\n?/g, "\n");
            const names = onClaimPaste(text);
            if (names === null) return;
            // Our own insert: the tokens are pinned to their images before
            // the attachments land, so none is placed a second time.
            event.preventDefault();
            const relabeled = relabelImageTokens(text, names, [...tokens.current.values()].map((token) => token.label));
            const start = node.cursorOffset;
            node.insertText(relabeled.text);
            for (const span of relabeled.spans) markToken(node, span.name, span.label, start + span.start);
          }}
          onSubmit={() => {
            if (!external) onSubmit();
          }}
          onKeyDown={(key: KeyEvent) => {
            if (skillTrigger !== null) {
              if (key.name === "escape") {
                key.preventDefault();
                setSkillTrigger(null);
                return;
              }
              if (skillMatches.length > 0 && (key.name === "up" || key.name === "down")) {
                key.preventDefault();
                skillNavSourceRef.current = "keyboard";
                setSkillIndex((current) => {
                  const base = current < 0 ? 0 : current;
                  return key.name === "up"
                    ? (base - 1 + skillMatches.length) % skillMatches.length
                    : (base + 1) % skillMatches.length;
                });
                return;
              }
              if (skillMatches.length > 0 && (key.name === "return" || key.name === "kpenter" || key.name === "tab")) {
                key.preventDefault();
                const picked = skillMatches[safeSkillIndex];
                if (picked !== undefined) insertSkill(picked);
                return;
              }
            }
            if (key.name === "escape") {
              if (moreOpen) {
                setMoreOpen(false);
                return;
              }
              onEscape();
              return;
            }
            // Shift+Tab cycles the thread's mode.
            if (key.name === "tab" && key.shift === true && onCycleMode !== undefined) {
              key.preventDefault();
              onCycleMode();
              return;
            }
            // Tab while a turn runs queues the draft behind it.
            if (key.name === "tab" && key.shift !== true && running && onQueue !== undefined && (areaRef.current?.plainText ?? "").trim().length > 0) {
              key.preventDefault();
              onQueue();
              return;
            }
            // Tab takes the suggestion into the (empty) draft, to send or edit.
            if (key.name === "tab" && key.shift !== true && offeredSuggestion !== null) {
              key.preventDefault();
              areaRef.current?.setText(offeredSuggestion);
              if (areaRef.current) areaRef.current.cursorOffset = offeredSuggestion.length;
              localRef.current = offeredSuggestion;
              onInput(offeredSuggestion);
              return;
            }
            // Alt+E opens the draft externally. `meta` is Alt; ctrl+E stays
            // as the textarea's own Emacs line-end binding.
            if ((key.name === "e" || key.name === "E") && key.meta === true && key.ctrl !== true) {
              onExternalEditClick?.();
            }
          }}
        />
        {spacer}
        {bottomRow}
            </box>
            <ComposerScrollbar areaRef={areaRef} />
          </box>
        )}
      </box>
      {!hintShown ? null : (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "flex-end" }}>
          <text fg={COLOR.faint}>{truncate(statusHint, Math.max(0, hintRoom))}</text>
        </box>
      )}
    </box>
  );
}
