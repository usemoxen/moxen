import { afterEach, describe, expect, test } from "vitest";

import { en } from "../en.js";
import { es } from "../es.js";
import { APPLIES_AT_TEXT, SECTION_LABEL, SETTINGS } from "../../../core/configschema.js";
import { applyLanguage, currentLanguage, hasSourceText, resolveLanguage, t, translate, tx } from "../index.js";
import { MCP_PRESETS, PROVIDER_PRESETS } from "../../../core/providers/harness/presets.js";
import { parseScheduleInput } from "../../model/schedule.js";
import { localizeSnapshot } from "../settingsview.js";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

afterEach(() => {
  applyLanguage("en");
});

describe("catalogs", () => {
  test("every language has exactly the English keys, with the same placeholders", () => {
    const table = es as Readonly<Record<string, string>>;
    expect(Object.keys(table).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) expect(placeholders(table[key]!)).toEqual(placeholders(text));
  });
});

describe("resolveLanguage", () => {
  test("an explicit setting wins over the environment", () => {
    expect(resolveLanguage("en", { LANG: "es_ES.UTF-8" })).toBe("en");
    expect(resolveLanguage("es-ES", { LANG: "en_US.UTF-8" })).toBe("es-ES");
  });

  test("auto reads LC_ALL, then LC_MESSAGES, then LANG", () => {
    expect(resolveLanguage("auto", { LC_ALL: "es_MX.UTF-8", LANG: "en_US.UTF-8" })).toBe("es-ES");
    expect(resolveLanguage("auto", { LC_MESSAGES: "en_GB", LANG: "es_ES" })).toBe("en");
    expect(resolveLanguage("auto", { LANG: "es_ES.UTF-8" })).toBe("es-ES");
  });

  test("auto skips the C locale and an unsupported language", () => {
    expect(resolveLanguage("auto", { LC_ALL: "C", LANG: "es_ES.UTF-8" })).toBe("es-ES");
    expect(resolveLanguage("auto", { LANG: "fr_FR.UTF-8" })).toBe("en");
  });
});

describe("t", () => {
  test("reads the current language and fills placeholders", () => {
    expect(t("quit.openThread", { title: "x" })).toBe("Open thread: x");
    expect(applyLanguage("es-ES")).toBe(true);
    expect(currentLanguage()).toBe("es-ES");
    expect(t("quit.openThread", { title: "x" })).toBe("Hilo abierto: x");
    expect(applyLanguage("es-ES")).toBe(false);
  });
});

describe("translate", () => {
  const rules = new Intl.PluralRules("es-ES");

  test("picks the plural form by count and falls back to .other", () => {
    const table = { "files.one": "{count} archivo", "files.other": "{count} archivos" };
    expect(translate([table], rules, "files", { count: 1 })).toBe("1 archivo");
    expect(translate([table], rules, "files", { count: 3 })).toBe("3 archivos");
    expect(translate([{ "files.other": "{count} archivos" }], rules, "files", { count: 1 })).toBe("1 archivos");
  });

  test("falls back to the next catalog, then to the key, and leaves unknown placeholders", () => {
    expect(translate([{}, { a: "x {n}" }], rules, "a", { n: 2 })).toBe("x 2");
    expect(translate([{}], rules, "missing")).toBe("missing");
    expect(translate([{ a: "{n} {m}" }], rules, "a", { n: 1 })).toBe("1 {m}");
  });
});

describe("settings table", () => {
  test("every setting the page offers has a Spanish label, description, group and choice", () => {
    const missing: string[] = [];
    const need = (text: string | undefined): void => {
      if (text !== undefined && text !== "" && !hasSourceText("es-ES", text)) missing.push(text);
    };
    for (const setting of SETTINGS) {
      if (setting.hidden === true) continue;
      need(setting.label);
      need(setting.description);
      need(setting.group);
      if (setting.kind.type === "enum") for (const choice of setting.kind.choices) (need(choice.label), need(choice.description));
    }
    for (const label of Object.values(SECTION_LABEL)) need(label);
    for (const entry of Object.values(APPLIES_AT_TEXT)) (need(entry.tag), need(entry.sentence));
    expect(missing).toEqual([]);
  });

  test("the model-server and MCP editors, and their presets, have Spanish words too", () => {
    const words = new Set(["label", "description", "group", "groupDescription", "placeholder", "hint", "needs", "noun", "title", "short", "low", "high"]);
    const missing = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string" && words.has(key)) {
          if (!hasSourceText("es-ES", entry)) missing.add(entry);
        } else walk(entry);
      }
    };
    for (const setting of SETTINGS) if (setting.kind.type === "list") walk(setting.kind);
    walk(PROVIDER_PRESETS);
    walk(MCP_PRESETS);
    expect([...missing]).toEqual([]);
  });

  test("localizing a snapshot changes what is shown, not keys or values", () => {
    applyLanguage("es-ES");
    const theme = SETTINGS.find((setting) => setting.key === "ui.theme")!;
    const snapshot = localizeSnapshot({ path: "/x", exists: true, settings: [{ descriptor: theme, value: "dracula", explicit: true }] })!;
    const view = snapshot.settings[0]!;
    expect(view.descriptor.label).toBe("Tema");
    expect(view.descriptor.key).toBe("ui.theme");
    expect(view.value).toBe("dracula");
    expect(view.descriptor.kind.type === "enum" && view.descriptor.kind.choices.map((choice) => choice.value)).toEqual(theme.kind.type === "enum" ? theme.kind.choices.map((choice) => choice.value) : []);
    applyLanguage("en");
    expect(localizeSnapshot({ path: "/x", exists: true, settings: [{ descriptor: theme, value: "dracula", explicit: true }] })!.settings[0]!.descriptor.label).toBe("Theme");
  });
});

describe("tx patterns", () => {
  test("a sentence core builds around a name or a count still has its Spanish form", () => {
    applyLanguage("es-ES");
    expect(tx("from 'Compaction' on the Claude Code tab")).toBe("de «Compactación» en la pestaña Claude Code");
    expect(tx("from ui.autoHandoff in the config file")).toBe("de ui.autoHandoff en el archivo de configuración");
    expect(tx("Brave Search is not added, or is off for this provider")).toBe("Brave Search no está añadido, o está desactivado para este proveedor");
    expect(tx("something Moxen never said")).toBe("something Moxen never said");
    applyLanguage("en");
    expect(tx("from 'Compaction' on the Claude Code tab")).toBe("from 'Compaction' on the Claude Code tab");
  });
});

describe("scheduling in Spanish", () => {
  test("the Spanish words the page prints are accepted as they were typed in English", () => {
    const now = new Date(2026, 8, 27, 10, 0);
    const same = (spanish: string, english: string): void => expect(parseScheduleInput(spanish, now).at?.getTime()).toBe(parseScheduleInput(english, now).at?.getTime());
    same("mañana 09:00", "tomorrow 09:00");
    same("hoy 18:30", "today 18:30");
    same("en 30m", "in 30m");
    same("en 2 horas", "in 2h");
    same("ahora", "now");
  });
});
