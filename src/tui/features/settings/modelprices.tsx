import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { type MessageKey, t } from "../../i18n/index.js";
import {
  formatUsdPerMillion,
  hasCustomPrices,
  hasShippedPrices,
  parseUsdInput,
  type ModelPriceEntry,
  type ModelPriceField,
  type ModelPriceValues,
} from "../../model/settings.js";
import { COLOR, SURFACE } from "../../theme.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { TextField } from "./textfield.js";

/** The four token-price fields of a model's page, top to bottom. */
const FIELDS: readonly {
  readonly field: ModelPriceField;
  readonly label: MessageKey;
  readonly tokens: MessageKey;
}[] = [
  { field: "input", label: "mp.field.input", tokens: "mp.tokens.input" },
  { field: "output", label: "mp.field.output", tokens: "mp.tokens.output" },
  { field: "cacheRead", label: "mp.field.cacheRead", tokens: "mp.tokens.cacheRead" },
  { field: "cacheWrite", label: "mp.field.cacheWrite", tokens: "mp.tokens.cacheWrite" },
];

/**
 * A provider's models, each with its own token prices (USD per million tokens)
 * over Moxen's shipped list. The list shows each model's effective prices;
 * enter opens a model's page of four numeric fields (input, output, cache read,
 * cache write), enter on a field edits a single USD/1M number, and `d` resets
 * a field (or on the list, all custom prices for that model).
 */
export function ModelPricesEditor({
  title,
  description,
  models,
  width,
  catalogReady,
  onChange,
  onExit,
}: {
  title: string;
  description: string;
  models: readonly ModelPriceEntry[];
  width: number;
  /** False while the provider catalog is still loading, so an empty list is not read as "no models". */
  catalogReady: boolean;
  /** Set one price field for a model (USD/1M), or null to remove the custom override. */
  onChange: (field: ModelPriceField, slug: string, value: number | null) => void;
  onExit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  /** The model whose page is open, and the field the cursor is on there. */
  const [page, setPage] = useState<{ slug: string; field: number } | null>(null);
  /** The field currently open in the single-line USD input. */
  const [editing, setEditing] = useState<ModelPriceField | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const at = Math.min(cursor, Math.max(0, models.length - 1));
  const open = page === null ? undefined : models.find((model) => model.slug === page.slug);
  const editingSpec = editing === null ? undefined : FIELDS.find((entry) => entry.field === editing);

  const clearField = (model: ModelPriceEntry | undefined, field: ModelPriceField) => {
    if (model === undefined || model.custom[field] === null) return;
    onChange(field, model.slug, null);
  };

  const clearModel = (model: ModelPriceEntry | undefined) => {
    if (model === undefined) return;
    for (const { field } of FIELDS) if (model.custom[field] !== null) onChange(field, model.slug, null);
  };

  useKeyboard((key) => {
    const escape = key.name === "escape" || key.name === "esc";
    // While the numeric input is open, TextField owns typing; only Escape cancels back to the model page.
    if (editing !== null) {
      if (escape) {
        key.preventDefault();
        setEditing(null);
        setEditError(null);
      }
      return;
    }
    key.preventDefault();
    const enter = key.name === "return" || key.name === "enter";
    const clearKey = !key.ctrl && !key.meta && (key.name === "d" || key.name === "backspace" || key.name === "delete");
    const up = key.name === "up" || (key.name === "k" && !key.ctrl);
    const down = key.name === "down" || (key.name === "j" && !key.ctrl);
    if (page !== null && open !== undefined) {
      if (escape || key.name === "left") return setPage(null);
      if (down) return setPage({ ...page, field: Math.min(page.field + 1, FIELDS.length - 1) });
      if (up) return setPage({ ...page, field: Math.max(page.field - 1, 0) });
      if (enter || key.name === "space" || key.name === "right") {
        setEditError(null);
        setEditing(FIELDS[page.field]!.field);
        return;
      }
      if (clearKey) return clearField(open, FIELDS[page.field]!.field);
      return;
    }
    if (escape || key.name === "left") return onExit();
    if (down) return setCursor(Math.min(at + 1, Math.max(0, models.length - 1)));
    if (up) return setCursor(Math.max(at - 1, 0));
    if ((enter || key.name === "space" || key.name === "right") && models[at] !== undefined) {
      setPage({ slug: models[at]!.slug, field: 0 });
      return;
    }
    if (clearKey) return clearModel(models[at]);
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(`price-model-${at}`), 0);
    return () => clearTimeout(timer);
  }, [at, page === null]);

  const footer = (text: string) => (
    <box style={{ flexDirection: "row", flexShrink: 0, height: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
      <OverflowText fg={COLOR.faint} bg={SURFACE.raised} selectable={false} width={width}>{text}</OverflowText>
    </box>
  );

  // Level 3: editing one numeric USD/1M price field.
  if (editing !== null && open !== undefined && editingSpec !== undefined) {
    const custom = open.custom[editing];
    const shipped = open.shipped[editing];
    const fallback = shipped !== null
      ? t("mp.fallbackShipped", { price: formatUsdPerMillion(shipped) })
      : t("mp.unpriced");
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <Back onBack={() => { setEditing(null); setEditError(null); }} />
        <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
          <OverflowText fg={COLOR.bright} bg={SURFACE.raised} selectable={false} width={width}>{`${t(editingSpec.label)}: ${open.name}`}</OverflowText>
          <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>
            {t("mp.editHelp", { tokens: t(editingSpec.tokens), slug: open.slug })}
          </text>
        </box>
        <TextField
          id={`price-edit-${editing}`}
          initial={custom === null ? "" : String(custom)}
          placeholder={shipped === null ? "2" : String(shipped)}
          fallback={fallback}
          width={width}
          onSubmit={(raw) => {
            const parsed = parseUsdInput(raw);
            if (!parsed.ok) {
              setEditError(t("mp.invalidPrice"));
              return;
            }
            setEditError(null);
            onChange(editing, open.slug, parsed.value);
            setEditing(null);
          }}
        />
        {editError === null ? null : (
          <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word" selectable={false} style={{ marginTop: 1 }}>{editError}</text>
        )}
      </box>
    );
  }

  // Level 2: one model's four price fields.
  if (page !== null && open !== undefined) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <Back onBack={() => setPage(null)} />
        <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
          <OverflowText fg={COLOR.bright} bg={SURFACE.raised} selectable={false} width={width}>{`${title}: ${open.name}`}</OverflowText>
          <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{t("mp.modelPage", { slug: open.slug })}</text>
        </box>
        <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
          {FIELDS.map((entry, index) => {
            const custom = open.custom[entry.field];
            const shipped = open.shipped[entry.field];
            const shown = custom !== null
              ? t("mp.perMillion", { price: formatUsdPerMillion(custom) })
              : shipped !== null
                ? t("mp.shippedValue", { price: formatUsdPerMillion(shipped) })
                : t("mp.unpricedCap");
            return (
              <Row
                key={entry.field}
                id={`price-model-field-${index}`}
                label={t(entry.label)}
                right={shown}
                set={custom !== null}
                active={index === page.field}
                width={width}
                onPress={() => {
                  setPage({ ...page, field: index });
                  setEditError(null);
                  setEditing(entry.field);
                }}
              />
            );
          })}
        </scrollbox>
        {footer(t("mp.footerModel"))}
      </box>
    );
  }

  // Level 1: list of models for this provider.
  const set = models.filter(hasCustomPrices).length;
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
            id={`price-model-${index}`}
            label={model.name}
            right={priceSummary(model)}
            set={hasCustomPrices(model)}
            active={index === at}
            width={width}
            onPress={() => {
              setCursor(index);
              setPage({ slug: model.slug, field: 0 });
            }}
          />
        ))}
      </scrollbox>
      {footer(models.length === 0 ? t("ho.escBack") : t("mp.footerList", { set, total: models.length }))}
    </box>
  );
}

/** Compact effective price summary for one model row (`$4 / $20`, `$4 / $20 (shipped)`, or `unpriced`). */
function priceSummary(model: ModelPriceEntry): string {
  const effective: ModelPriceValues = {
    input: model.custom.input ?? model.shipped.input,
    output: model.custom.output ?? model.shipped.output,
    cacheRead: model.custom.cacheRead ?? model.shipped.cacheRead,
    cacheWrite: model.custom.cacheWrite ?? model.shipped.cacheWrite,
  };
  const custom = hasCustomPrices(model);
  if (!custom && !hasShippedPrices(model)) return t("mp.unpriced");
  const core = effective.input !== null && effective.output !== null
    ? `${formatUsdPerMillion(effective.input)} / ${formatUsdPerMillion(effective.output)}`
    : [
        ...(effective.input === null ? [] : [t("mp.inShort", { price: formatUsdPerMillion(effective.input) })]),
        ...(effective.output === null ? [] : [t("mp.outShort", { price: formatUsdPerMillion(effective.output) })]),
        ...(effective.input === null && effective.output === null && effective.cacheRead !== null ? [t("mp.cacheReadShort", { price: formatUsdPerMillion(effective.cacheRead) })] : []),
        ...(effective.input === null && effective.output === null && effective.cacheWrite !== null ? [t("mp.cacheWriteShort", { price: formatUsdPerMillion(effective.cacheWrite) })] : []),
      ].join(" · ");
  return custom ? core : t("mp.shippedSummaryRow", { prices: core });
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
  const rightWidth = Math.max(0, Math.min(right.length, width - 6 - Math.min(left.length, Math.floor(width / 2))));
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <OverflowText fg={active ? COLOR.bright : COLOR.text} bg={bg} selectable={false} width={Math.max(8, width - rightWidth - 5)} prefix={active ? "▌ " : "  "} active={active || hovered}>{label}</OverflowText>
      <OverflowText fg={set ? COLOR.accent : COLOR.dim} bg={bg} selectable={false} width={rightWidth} active={active || hovered}>{right}</OverflowText>
    </box>
  );
}
