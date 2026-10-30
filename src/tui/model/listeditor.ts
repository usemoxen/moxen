import { numberLabel } from "./numberlabel.js";
import { sliderLayout } from "./slider.js";
import { t, tx } from "../i18n/index.js";
import type { SettingChoice, SettingEnds, ListField, ListFieldView, ListItemView, SettingValue } from "../../core/configschema.js";

/**
 * Rows of the list editor (the harness profile editor), derived from the
 * schema's field table and the server's item view. Pure, so what the editor
 * shows and which control each field gets is tested without a terminal.
 */

export interface EditorOption {
  /** What `settings.set` receives; `""` clears the field. `TEXT_OPTION` asks for typing instead. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** Picked from a list that also offers "type a value" (a number outside the presets). */
export const TEXT_OPTION = "\u0000text";

export type FieldControl =
  | { readonly kind: "pick"; readonly options: readonly EditorOption[]; readonly ends?: SettingEnds }
  | { readonly kind: "text"; readonly multiline: boolean }
  /** A key: typed into a masked input, kept in the OS keychain. */
  | { readonly kind: "secret" }
  /** `NAME=value` pairs edited one at a time (environment, headers); `secret` hides the values. */
  | { readonly kind: "pairs"; readonly secret: boolean };

export type EditorRow =
  | { readonly kind: "heading"; readonly label: string; readonly description?: string }
  | {
      readonly kind: "field";
      readonly path: string;
      readonly label: string;
      readonly description: string;
      readonly control: FieldControl;
      readonly value: SettingValue;
      /** What the row shows on the right. */
      readonly shown: string;
      /** The file holds a value for it. */
      readonly explicit: boolean;
      /** Where the value in force comes from, when it is not this field's own. */
      readonly origin: string | null;
    }
  | { readonly kind: "child"; readonly id: string; readonly path: string; readonly title: string; readonly summary: string; readonly status: string | null }
  | { readonly kind: "addChild"; readonly path: string; readonly noun: string }
  | { readonly kind: "resolved"; readonly label: string; readonly value: string; readonly origin: string };

/** What a slider over a field's choices needs: the stops along the track, and the two actions beside it. */
export interface SliderChoices {
  readonly stops: readonly EditorOption[];
  /** Back to the default (the `""` choice). */
  readonly reset: EditorOption | undefined;
  /** Type a value that is not a stop. */
  readonly custom: EditorOption | undefined;
}

/** Numbers that fit along a track of `width` columns, or null when they are better listed. */
export function sliderChoices(options: readonly EditorOption[], width: number): SliderChoices | null {
  const stops = options.filter((option) => option.value !== "" && option.value !== TEXT_OPTION);
  if (stops.length < 2 || stops.length > 8) return null;
  if (!stops.every((option) => /^[\d.,]+[A-Za-z%]*$/.test(option.label))) return null;
  if (!sliderLayout(stops.map((option) => option.label), width).fits) return null;
  return { stops, reset: options.find((option) => option.value === ""), custom: options.find((option) => option.value === TEXT_OPTION) };
}

/** `choices`: what this item lets the field hold, for a field whose choices depend on the item (`ListFieldView.choices`). */
export function fieldControl(field: ListField, value: SettingValue, choices: readonly SettingChoice[] = []): FieldControl {
  const kind = field.kind;
  const current = value === undefined ? "" : String(value);
  const withCurrent = (options: EditorOption[]): readonly EditorOption[] =>
    current === "" || options.some((entry) => entry.value === current) ? options : [{ value: current, label: current, description: t("settings.setInFile") }, ...options];
  switch (kind.type) {
    case "boolean":
      return { kind: "pick", options: [DEFAULT_OPTION(), { value: "true", label: t("settings.on") }, { value: "false", label: t("settings.off") }] };
    case "enum":
      return { kind: "pick", options: withCurrent([DEFAULT_OPTION(), ...kind.choices.map((choice) => ({ value: choice.value, label: tx(choice.label), ...(choice.description ? { description: tx(choice.description) } : {}) }))]) };
    case "integer":
    case "number": {
      if (kind.presets === undefined) return { kind: "text", multiline: false };
      const unit = kind.type === "integer" ? (kind.unit ?? "") : "";
      return {
        kind: "pick",
        options: withCurrent([
          DEFAULT_OPTION(),
          ...kind.presets.map((preset) => ({ value: String(preset), label: `${numberLabel(preset)}${unit}` })),
          { value: TEXT_OPTION, label: t("settings.anotherValue") },
        ]),
        ...(kind.ends === undefined ? {} : { ends: kind.ends }),
      };
    }
    case "string":
      return { kind: "text", multiline: kind.multiline === true };
    case "secret":
      return { kind: "secret" };
    case "pairs":
      return { kind: "pairs", secret: kind.secret === true };
    case "words":
    case "list":
      return { kind: "text", multiline: false };
    case "effort":
      return { kind: "pick", options: withCurrent([DEFAULT_OPTION(), ...choices.map((choice) => ({ value: choice.value, label: tx(choice.label), ...(choice.description ? { description: tx(choice.description) } : {}) }))]) };
  }
}

const DEFAULT_OPTION = (): EditorOption => ({ value: "", label: t("settings.default"), description: t("settings.notSetHere") });

function shownValue(field: ListField, view: ListFieldView | undefined): { shown: string; origin: string | null } {
  const value = view?.value;
  const effective = view?.effective;
  const kind = field.kind;
  const format = (raw: SettingValue): string => {
    if (raw === undefined) return kind.type === "secret" ? t("settings.noKey") : t("settings.default");
    if (kind.type === "secret") return t("settings.keySaved");
    // A map or a list of words is shown on one line, however many it has.
    if (kind.type === "pairs") return String(raw).split("\n").map((line) => line.split("=")[0]).join(", ");
    if (kind.type === "words") return String(raw);
    if (kind.type === "boolean" || typeof raw === "boolean") return raw ? t("settings.on") : t("settings.off");
    if (kind.type === "enum") return kind.choices.find((choice) => choice.value === String(raw))?.label === undefined ? String(raw) : tx(kind.choices.find((choice) => choice.value === String(raw))!.label);
    if (typeof raw === "number") return `${numberLabel(raw)}${kind.type === "integer" ? (kind.unit ?? "") : ""}`;
    return String(raw);
  };
  if (value !== undefined) return { shown: format(value), origin: null };
  if (effective !== undefined) return { shown: format(effective.value), origin: tx(effective.origin) };
  // What the schema says applies while it is unset, said on the row rather than in the description.
  if (field.unset !== undefined) return "value" in field.unset ? { shown: format(field.unset.value), origin: t("settings.originDefault") } : { shown: t("settings.default"), origin: tx(field.unset.text) };
  return { shown: field.kind.type === "secret" ? t("settings.noKey") : t("settings.default"), origin: null };
}

/** The editor's rows for one item: its fields under headings in the schema's order, nested lists as child rows. */
export function itemRows(fields: readonly ListField[], item: ListItemView): readonly EditorRow[] {
  const rows: EditorRow[] = [];
  let group: string | null = null;
  /** A field's value as `visibleWhen` compares it: what is set, else what applies, else `""` for unset. */
  const held = (path: string): string => {
    const view = item.fields.find((entry) => entry.path === path);
    const value = view?.value ?? view?.effective?.value;
    return value === undefined ? "" : String(value);
  };
  for (const field of fields) {
    if (field.hidden === true) continue;
    if (field.visibleWhen !== undefined && !field.visibleWhen.in.includes(held(field.visibleWhen.path))) continue;
    const view = item.fields.find((entry) => entry.path === field.path);
    if (field.group !== group) {
      group = field.group;
      const description = fields.find((entry) => entry.group === group && entry.groupDescription !== undefined)?.groupDescription;
      rows.push({ kind: "heading", label: tx(group), ...(description !== undefined ? { description: tx(description) } : {}) });
    }
    if (field.kind.type === "list") {
      for (const child of view?.items ?? []) {
        rows.push({ kind: "child", id: child.id, path: field.path, title: child.title, summary: child.summary, status: child.status });
      }
      rows.push({ kind: "addChild", path: field.path, noun: tx(field.kind.noun) });
      continue;
    }
    const { shown, origin } = shownValue(field, view);
    rows.push({
      kind: "field",
      path: field.path,
      label: tx(field.label),
      description: tx(field.description),
      control: fieldControl(field, view?.value, view?.choices),
      value: view?.value,
      shown,
      explicit: view?.explicit === true,
      origin,
    });
  }
  if (item.resolved.length > 0) {
    rows.push({ kind: "heading", label: t("settings.inForce") });
    for (const row of item.resolved) rows.push({ kind: "resolved", label: tx(row.label), value: tx(row.value), origin: tx(row.origin) });
  }
  return rows;
}

/** Rows the cursor can land on. */
export const selectable = (row: EditorRow): boolean => row.kind === "field" || row.kind === "child" || row.kind === "addChild";

/** The names in a field's `NAME=value` lines. */
export function pairNames(value: SettingValue): string[] {
  return value === undefined ? [] : String(value).split("\n").map((line) => line.split("=")[0]!.trim()).filter((name) => name !== "");
}

/** The lines with `name` set to `next` (a new value, or the hidden marker to keep it); empty `next` removes it. Unchanged secret values stay hidden. */
export function withPair(value: SettingValue, name: string, next: string): string {
  const lines = value === undefined ? [] : String(value).split("\n").filter((line) => line.trim() !== "");
  const kept = lines.filter((line) => line.split("=")[0]!.trim() !== name);
  if (next !== "") kept.push(`${name}=${next}`);
  return kept.join("\n");
}
