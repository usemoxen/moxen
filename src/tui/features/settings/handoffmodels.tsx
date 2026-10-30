import { type MessageKey, currentLanguage, t, tx } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import {
  HANDOFF_MODE_CHOICES,
  handoffStops,
  handoffTokensLabel,
  hasOverrides,
  type ModelCompactionChoices,
  type ModelOverrideEntry,
  type ModelOverrideField,
} from "../../model/settings.js";
import { sliderLayout } from "../../model/slider.js";
import { Slider, SliderDefault } from "../../ui/slider.js";


/** The four fields of a model's page, top to bottom. */
const FIELDS: readonly { readonly field: ModelOverrideField; readonly label: MessageKey; readonly size: boolean }[] = [
  { field: "handoff", label: "ho.field.handoff", size: false },
  { field: "handoffAt", label: "ho.field.handoffAt", size: true },
  { field: "compaction", label: "ho.field.compaction", size: false },
  { field: "compactAt", label: "ho.field.compactAt", size: true },
];

/**
 * A provider's models, each with its own long-thread choices: whether and
 * where it is handed off, and who compacts it and where. The list shows what
 * each model has of its own; enter opens a model's page of four fields, each
 * a choice list or a size slider, and `d` takes an override away (on the
 * list, all of a model's). A choice is applied at once; every other model's
 * overrides stay as they were.
 */
export function HandoffModelsEditor({
  title,
  description,
  models,
  compaction,
  width,
  catalogReady,
  onChange,
  onExit,
}: {
  title: string;
  description: string;
  models: readonly ModelOverrideEntry[];
  compaction: ModelCompactionChoices;
  width: number;
  /** False while the provider catalog is still loading, so an empty list is not read as "no models". */
  catalogReady: boolean;
  /** Set one of a model's fields, or null to remove it (it then follows the provider). */
  onChange: (field: ModelOverrideField, slug: string, value: string | number | null) => void;
  onExit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  /** The model whose page is open, and the field the cursor is on there. */
  const [page, setPage] = useState<{ slug: string; field: number } | null>(null);
  /** The field being chosen on that page, and the stop or choice the cursor is over. */
  const [choosing, setChoosing] = useState<{ field: ModelOverrideField; index: number } | null>(null);
  const at = Math.min(cursor, Math.max(0, models.length - 1));
  const open = page === null ? undefined : models.find((model) => model.slug === page.slug);
  const spec = choosing === null ? undefined : FIELDS.find((entry) => entry.field === choosing.field);

  const modeChoices = (field: ModelOverrideField) => (field === "handoff" ? HANDOFF_MODE_CHOICES : compaction.choices);
  const sizeOf = (model: ModelOverrideEntry, field: ModelOverrideField): number | null => (field === "handoffAt" ? model.handoffAt : field === "compactAt" ? model.compactAt : null);
  const stops = open !== undefined && spec?.size === true ? handoffStops(sizeOf(open, spec.field)) : [];
  const labels = stops.map(handoffTokensLabel);
  const track = sliderLayout(labels, width - 2).fits;
  // The choice list: following the provider first, then the choices.
  const options = spec !== undefined && !spec.size ? [{ value: null as string | null, label: t("ho.follow") }, ...modeChoices(spec.field).map((choice) => ({ value: choice.value as string | null, label: tx(choice.label) }))] : [];

  const fieldOpenable = (field: ModelOverrideField) => field !== "compaction" || compaction.unavailable === null;
  const openField = (model: ModelOverrideEntry, index: number) => {
    const entry = FIELDS[index];
    if (entry === undefined || !fieldOpenable(entry.field)) return;
    if (entry.size) {
      const size = sizeOf(model, entry.field);
      const list = handoffStops(size);
      // Nothing set opens on 200K, a middling window, rather than at an end.
      setChoosing({ field: entry.field, index: Math.max(0, size === null ? list.indexOf(200_000) : list.indexOf(size)) });
    } else {
      const held = model[entry.field] as string | null;
      const list: Array<string | null> = [null, ...modeChoices(entry.field).map((choice) => choice.value)];
      setChoosing({ field: entry.field, index: Math.max(0, list.indexOf(held)) });
    }
  };
  const pick = (index: number) => {
    if (open === undefined || spec === undefined) return;
    if (spec.size) {
      if (stops[index] === undefined) return;
      onChange(spec.field, open.slug, stops[index]!);
    } else {
      const choice = options[index];
      if (choice === undefined) return;
      onChange(spec.field, open.slug, choice.value);
    }
    setChoosing(null);
  };
  const clearField = (model: ModelOverrideEntry | undefined, field: ModelOverrideField) => {
    if (model === undefined || model[field] === null) return;
    onChange(field, model.slug, null);
    setChoosing(null);
  };
  const clearModel = (model: ModelOverrideEntry | undefined) => {
    if (model === undefined) return;
    for (const { field } of FIELDS) if (model[field] !== null) onChange(field, model.slug, null);
  };

  useKeyboard((key) => {
    // Claimed, so the page behind does not also read this esc or arrow.
    key.preventDefault();
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    const clearKey = !key.ctrl && !key.meta && (key.name === "d" || key.name === "backspace" || key.name === "delete");
    const up = key.name === "up" || (key.name === "k" && !key.ctrl);
    const down = key.name === "down" || (key.name === "j" && !key.ctrl);
    if (choosing !== null && open !== undefined && spec !== undefined) {
      const last = (spec.size ? stops.length : options.length) - 1;
      if (escape) return setChoosing(null);
      if (clearKey) return clearField(open, spec.field);
      if (enter || key.name === "space") return pick(choosing.index);
      if (key.name === "home") return setChoosing({ ...choosing, index: 0 });
      if (key.name === "end") return setChoosing({ ...choosing, index: last });
      const back = spec.size && track ? key.name === "left" || (key.name === "h" && !key.ctrl) : up;
      const forward = spec.size && track ? key.name === "right" || (key.name === "l" && !key.ctrl) : down;
      if (back) return setChoosing({ ...choosing, index: Math.max(0, choosing.index - 1) });
      if (forward) return setChoosing({ ...choosing, index: Math.min(last, choosing.index + 1) });
      return;
    }
    if (page !== null && open !== undefined) {
      if (escape || key.name === "left") return setPage(null);
      if (down) return setPage({ ...page, field: Math.min(page.field + 1, FIELDS.length - 1) });
      if (up) return setPage({ ...page, field: Math.max(page.field - 1, 0) });
      if (enter || key.name === "space" || key.name === "right") return openField(open, page.field);
      if (clearKey) return clearField(open, FIELDS[page.field]!.field);
      return;
    }
    if (escape || key.name === "left") return onExit();
    if (down) return setCursor(Math.min(at + 1, Math.max(0, models.length - 1)));
    if (up) return setCursor(Math.max(at - 1, 0));
    if ((enter || key.name === "space" || key.name === "right") && models[at] !== undefined) return setPage({ slug: models[at]!.slug, field: 0 });
    if (clearKey) return clearModel(models[at]);
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(choosing !== null ? `handoff-stop-${choosing.index}` : `handoff-model-${at}`), 0);
    return () => clearTimeout(timer);
  }, [at, page === null, choosing?.index]);

  const footer = (text: string) => (
    <box style={{ flexDirection: "row", flexShrink: 0, height: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
      <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(text, width)}</text>
    </box>
  );

  // A field being chosen: a size slider, or the choice list.
  if (choosing !== null && open !== undefined && spec !== undefined) {
    const held = open[spec.field];
    const verb = spec.field === "handoffAt" ? t("ho.handedOff") : t("ho.compacted");
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <Back onBack={() => setChoosing(null)} />
        <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{truncate(`${t(spec.label)}: ${open.name}`, width)}</text>
          <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
            {spec.size ? t("ho.sizeHelp", { slug: open.slug, verb }) : t("ho.modeHelp", { label: t(spec.label), slug: open.slug })}
          </text>
        </box>
        {spec.size && track ? (
          <Slider
            idPrefix="handoff-stop"
            stops={labels}
            active={choosing.index}
            chosen={held === null ? -1 : stops.indexOf(held as number)}
            width={width - 2}
            ends={{ low: t("ho.earlier"), high: t("ho.later") }}
            caption={t("ho.tokens", { count: stops[choosing.index]!.toLocaleString(currentLanguage()) })}
            onMove={(index) => setChoosing({ ...choosing, index })}
            onPick={pick}
          />
        ) : (
          <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
            {(spec.size ? labels : options.map((option) => option.label)).map((label, index) => (
              <StopRow
                key={label}
                id={`handoff-stop-${index}`}
                label={label}
                active={index === choosing.index}
                chosen={spec.size ? stops[index] === held : options[index]!.value === held}
                width={width}
                onPress={() => pick(index)}
              />
            ))}
          </scrollbox>
        )}
        {spec.size ? <SliderDefault id="handoff-stop-reset" unset={held === null} defaultLabel="the provider setting" onReset={() => clearField(open, spec.field)} /> : null}
        {footer(t("ho.footerChoose", { move: spec.size && track ? t("ho.moveLR") : t("ho.moveUD") }))}
      </box>
    );
  }

  // A model's page: its four fields.
  if (page !== null && open !== undefined) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <Back onBack={() => setPage(null)} />
        <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{truncate(`${title}: ${open.name}`, width)}</text>
          <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("ho.modelPage", { slug: open.slug })}</text>
        </box>
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
          {FIELDS.map((entry, index) => {
            const held = open[entry.field];
            const locked = !fieldOpenable(entry.field);
            const shown = locked ? t("ho.notOffered") : held === null ? t("ho.follow") : entry.size ? handoffTokensLabel(held as number) : (modeChoices(entry.field).find((choice) => choice.value === held)?.label === undefined ? String(held) : tx(modeChoices(entry.field).find((choice) => choice.value === held)!.label));
            return (
              <Row
                key={entry.field}
                id={`handoff-model-field-${index}`}
                label={t(entry.label)}
                right={shown}
                set={held !== null && !locked}
                active={index === page.field}
                width={width}
                onPress={() => {
                  setPage({ ...page, field: index });
                  openField(open, index);
                }}
              />
            );
          })}
          {compaction.unavailable === null ? null : (
            <text fg={COLOR.faint} bg={SURFACE.raised} wrapMode="word" selectable={false} style={{ marginTop: 1 }}>{compaction.unavailable}</text>
          )}
        </scrollbox>
        {footer(t("ho.footerModel"))}
      </box>
    );
  }

  const set = models.filter(hasOverrides).length;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <Back onBack={onExit} />
      <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{title}</text>
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{description}</text>
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
        {models.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{catalogReady ? t("ho.noModels") : t("settings.loadingCatalog")}</text> : null}
        {models.map((model, index) => (
          <Row
            key={model.slug}
            id={`handoff-model-${index}`}
            label={model.name}
            right={summary(model, compaction)}
            set={hasOverrides(model)}
            active={index === at}
            width={width}
            onPress={() => {
              setCursor(index);
              setPage({ slug: model.slug, field: 0 });
            }}
          />
        ))}
      </scrollbox>
      {footer(models.length === 0 ? t("ho.escBack") : t("ho.footerList", { set, total: models.length }))}
    </box>
  );
}

/** What a model has of its own, short: "hand off off · compact at 400K"; nothing of its own follows the provider. */
function summary(model: ModelOverrideEntry, compaction: ModelCompactionChoices): string {
  const parts: string[] = [];
  const handoff = HANDOFF_MODE_CHOICES.find((choice) => choice.value === model.handoff)?.label;
  if (handoff !== undefined) parts.push(t("ho.handOff", { mode: tx(handoff).toLowerCase() }));
  if (model.handoffAt !== null) parts.push(t("ho.handOffAt", { size: handoffTokensLabel(model.handoffAt) }));
  const compact = compaction.choices.find((choice) => choice.value === model.compaction)?.label;
  if (compact !== undefined) parts.push(t("ho.compaction", { mode: compact }));
  if (model.compactAt !== null) parts.push(t("ho.compactAt", { size: handoffTokensLabel(model.compactAt) }));
  return parts.length === 0 ? t("ho.usesProvider") : parts.join(" · ");
}

function Back({ onBack }: { onBack: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} onMouseDown={onBack} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.accent} bg={SURFACE.raised} selectable={false}>{t("ui.back")}</text>
    </box>
  );
}

function Row({ id, label, right, set, active, width, onPress }: { id: string; label: string; right: string; set: boolean; active: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const left = `${active ? "▌ " : "  "}${label}`;
  // The name keeps its room; what the model has of its own is the one shortened.
  const rightWidth = Math.max(0, Math.min(right.length, width - 6 - Math.min(left.length, Math.floor(width / 2))));
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(left, Math.max(8, width - rightWidth - 5))}</text>
      <text fg={set ? COLOR.accent : COLOR.dim} bg={bg} selectable={false}>{truncate(right, rightWidth)}</text>
    </box>
  );
}

function StopRow({ id, label, active, chosen, width, onPress }: { id: string; label: string; active: boolean; chosen: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1 }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={active ? COLOR.bright : chosen ? COLOR.accent : COLOR.text} bg={bg} selectable={false}>{truncate(`${active ? "▌ " : "  "}${label}${chosen ? "  ✓" : ""}`, width - 2)}</text>
    </box>
  );
}
