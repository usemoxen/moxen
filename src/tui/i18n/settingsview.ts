import type { ListFieldView, ListItemView, SettingDescriptor, SettingEffective, SettingKind, SettingView } from "../../core/configschema.js";
import type { SettingsSnapshot } from "../../server/protocol.js";
import { tx } from "./index.js";

function localizeKind(kind: SettingKind): SettingKind {
  if (kind.type !== "enum") return kind;
  return { ...kind, choices: kind.choices.map((choice) => ({ ...choice, label: tx(choice.label), ...(choice.description === undefined ? {} : { description: tx(choice.description) }) })) };
}

function localizeDescriptor(descriptor: SettingDescriptor): SettingDescriptor {
  return {
    ...descriptor,
    label: tx(descriptor.label),
    description: tx(descriptor.description),
    ...(descriptor.group === undefined ? {} : { group: tx(descriptor.group) }),
    kind: localizeKind(descriptor.kind),
  };
}

const localizeEffective = (effective: SettingEffective): SettingEffective => ({ ...effective, label: tx(effective.label), ...(effective.origin === undefined ? {} : { origin: tx(effective.origin) }) });

/** An item's summary is `a · b · c`: each part is its own sentence, and some carry a name or a count. */
const localizeParts = (text: string): string => text.split(" · ").map(tx).join(" · ");

function localizeField(field: ListFieldView): ListFieldView {
  return {
    ...field,
    ...(field.effective === undefined ? {} : { effective: { ...field.effective, origin: tx(field.effective.origin) } }),
    ...(field.items === undefined ? {} : { items: field.items.map(localizeItem) }),
  };
}

function localizeItem(item: ListItemView): ListItemView {
  return {
    ...item,
    summary: localizeParts(item.summary),
    status: item.status === null ? null : tx(item.status),
    fields: item.fields.map(localizeField),
    resolved: item.resolved.map((row) => ({ ...row, value: tx(row.value), origin: tx(row.origin) })),
  };
}

function localizeView(view: SettingView): SettingView {
  return {
    ...view,
    descriptor: localizeDescriptor(view.descriptor),
    ...(view.unavailable === undefined ? {} : { unavailable: tx(view.unavailable) }),
    ...(view.inForce === undefined ? {} : { inForce: tx(view.inForce) }),
    ...(view.effective === undefined ? {} : { effective: localizeEffective(view.effective) }),
    ...(view.order === undefined ? {} : { order: view.order.map((entry) => ({ ...entry, label: tx(entry.label), locked: entry.locked === null ? null : tx(entry.locked) })) }),
    ...(view.items === undefined ? {} : { items: view.items.map(localizeItem) }),
  };
}

/**
 * The snapshot with each setting's words in the current language, for the
 * settings page to draw. Values, keys and choice values are untouched, so
 * nothing that is written back changes; only what is shown does.
 */
export function localizeSnapshot(snapshot: SettingsSnapshot | null): SettingsSnapshot | null {
  if (snapshot === null) return null;
  return { ...snapshot, settings: snapshot.settings.map(localizeView) };
}
