import { APPLIES_AT_TEXT, SECTION_LABEL, SETTINGS, SETTING_SECTIONS, type ListField, type ListFieldKind, type SettingKind } from "../configschema.js";
import type { KnowledgePage, KnowledgeSection } from "./types.js";

function kindText(kind: SettingKind | ListFieldKind): string {
  switch (kind.type) {
    case "enum": return `Choices: ${kind.choices.filter((choice) => !choice.hidden).map((choice) => `${choice.value} (${choice.label}${choice.description ? `: ${choice.description}` : ""})`).join("; ")}.`;
    case "integer": return "min" in kind ? `Integer, ${kind.min} to ${kind.max}${kind.unit ? ` ${kind.unit}` : ""}.` : `Integer${kind.unit ? ` (${kind.unit})` : ""}; validated by the owning profile or server.`;
    case "number": return "Number; validated by the owning profile or server.";
    case "secret": return "Secret. The user enters it in masked Settings; never put a value in a model-visible command or file.";
    case "pairs": return `${kind.secret ? "Secret values; use masked Settings. " : ""}KEY=value pairs, one per line.`;
    case "words": return `Words separated by ${kind.separator === "comma" ? "commas" : "spaces (quote arguments containing spaces)"}.`;
    case "effort": return "An effort from this profile's models; inspect live choices.";
    case "string": return `Text.${"source" in kind && kind.source ? ` Choices come from ${kind.source}; inspect the live settings/catalog.` : ""}`;
    case "boolean": return "Boolean: true or false.";
    case "duration": return "Duration text, for example 2m or 45s.";
    case "line": return "A percentage of the context window or a token size, for example 70% or 32K.";
    case "list": return "A structured list addressed by ID, not position. A whole entry takes JSON; a field takes text.";
  }
}

function fieldSections(fields: readonly ListField[], prefix: string): KnowledgeSection[] {
  return fields.filter((field) => !field.hidden).flatMap((field) => {
    const key = `${prefix}.${field.path}`;
    const nested = field.kind.type === "list" ? fieldSections(field.kind.fields, `${key}[<id>]`) : [];
    return [{
      id: key,
      title: `${key} — ${field.label}`,
      text: [
        field.description, kindText(field.kind), field.groupDescription,
        field.unset ? `Unset: ${"text" in field.unset ? field.unset.text : JSON.stringify(field.unset.value) ?? "unset"}.` : undefined,
        field.visibleWhen ? `Shown when ${field.visibleWhen.path} is one of ${JSON.stringify(field.visibleWhen.in)} (empty means unset).` : undefined,
      ].filter(Boolean).join("\n"),
    }, ...nested];
  });
}

/** No live configuration, keychain access or environment-dependent values. */
export function settingsReference(): KnowledgePage[] {
  const pages: KnowledgePage[] = [...SETTING_SECTIONS, "legacy" as const].map((section) => ({
    id: `settings-${section}`, title: section === "legacy" ? "Compatibility settings" : `Settings: ${SECTION_LABEL[section]}`,
    sections: SETTINGS.filter((setting) => section === "legacy" ? setting.hidden : !setting.hidden && setting.section === section).map((setting) => {
      const fallback = setting.fallback;
      return {
        id: setting.key, title: `${setting.key} — ${setting.label}`,
        text: [
          setting.description, kindText(setting.kind),
          setting.hidden ? "Compatibility key; use current settings for new configuration." : undefined,
          setting.defaultValue !== undefined ? `Default: ${JSON.stringify(setting.defaultValue)}.` : "No fixed default in this descriptor.",
          fallback ? "key" in fallback ? `When unset, falls back to ${fallback.key}.` : "resolver" in fallback ? "Fallback depends on configuration; inspect moxen --json config list for what applies." : `When unset: ${fallback.text}.` : undefined,
          setting.appliesAt && setting.appliesAt !== "now" ? APPLIES_AT_TEXT[setting.appliesAt].sentence : "Applies on the next read.",
          setting.envOverride ? `Environment override: ${setting.envOverride}.` : undefined,
          setting.visibleWhen ? `Shown when ${setting.visibleWhen.key} is one of ${JSON.stringify(setting.visibleWhen.in)}.` : undefined,
          setting.kind.type === "list" ? `Field reference: knowledge_read({id: ${JSON.stringify(`fields-${setting.key}`)}}).` : undefined,
        ].filter(Boolean).join("\n"),
      };
    }),
  }));
  for (const setting of SETTINGS) {
    if (setting.kind.type !== "list") continue;
    pages.push({ id: `fields-${setting.key}`, title: `${setting.label}: entry fields`, sections: fieldSections(setting.kind.fields, `${setting.key}[<id>]`) });
  }
  return pages.filter((page) => page.sections.length > 0);
}
