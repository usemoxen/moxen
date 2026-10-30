import { en, type Catalog } from "./en.js";
import { es } from "./es.js";
import { settingsEs } from "./settings.es.js";

export type Language = "en" | "es-ES";
export type LanguageSetting = Language | "auto";

/** A message key, plural categories (`.one`, `.other`, …) left off. */
export type MessageKey = keyof typeof en extends infer K ? (K extends `${infer Base}.${PluralCategory}` ? Base : K) : never;
type PluralCategory = Intl.LDMLPluralRule;

const CATALOGS: Record<Language, Catalog> = { en, "es-ES": es };
const FALLBACK: Language = "en";

let current: Language = FALLBACK;
let plurals = new Intl.PluralRules(FALLBACK);

/**
 * The language a `ui.language` setting means. `auto` reads the locale the
 * terminal sets (`LC_ALL`, then `LC_MESSAGES`, then `LANG`), then the one the
 * runtime reports, which is what a platform without those variables has.
 */
export function resolveLanguage(setting: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): Language {
  if (setting === "en" || setting === "es-ES") return setting;
  const candidates = [env.LC_ALL, env.LC_MESSAGES, env.LANG, systemLocale()];
  for (const raw of candidates) {
    const tag = raw?.split(".")[0]?.replace("_", "-").toLowerCase();
    if (tag === undefined || tag === "" || tag === "c" || tag === "posix") continue;
    return tag === "es" || tag.startsWith("es-") ? "es-ES" : FALLBACK;
  }
  return FALLBACK;
}

function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Sets the language every `t()` call reads, like `applyTheme` does for the
 * palettes: the app calls it while rendering, before any child draws, so it
 * is a no-op while the language is unchanged. Returns whether it changed.
 */
export function applyLanguage(setting: string | undefined): boolean {
  const next = resolveLanguage(setting);
  if (next === current) return false;
  current = next;
  plurals = new Intl.PluralRules(next);
  return true;
}

export function currentLanguage(): Language {
  return current;
}

type Params = Readonly<Record<string, string | number>>;

/**
 * The message for `key` in the current language, `{name}` placeholders
 * filled from `params`. A numeric `count` picks the plural form. A key the
 * language lacks falls back to English, and an unknown key to the key itself,
 * so a gap shows up on screen rather than throwing.
 */
export function t(key: MessageKey, params?: Params): string {
  return translate([CATALOGS[current], CATALOGS[FALLBACK]], plurals, key, params);
}

/** `t` over explicit catalogs (first match wins) and plural rules, so the lookup can be tested on its own. */
export function translate(catalogs: readonly Readonly<Record<string, string | undefined>>[], rules: Intl.PluralRules, key: string, params?: Params): string {
  const count = params?.count;
  for (const table of catalogs) {
    const plural = typeof count === "number" ? (table[`${key}.${rules.select(count)}`] ?? table[`${key}.other`]) : undefined;
    const template = plural ?? table[key];
    if (template !== undefined) return params === undefined ? template : fill(template, params);
  }
  return key;
}

function fill(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

interface SourceTable {
  readonly exact: Readonly<Record<string, string>>;
  readonly patterns: readonly { readonly regex: RegExp; readonly names: readonly string[]; readonly template: string }[];
}

/** A table's `{name}` entries become patterns, so prose core builds around a name or a number still has a Spanish form. */
function compile(table: Readonly<Record<string, string>>): SourceTable {
  const exact: Record<string, string> = {};
  const patterns: { regex: RegExp; names: string[]; template: string }[] = [];
  for (const [english, translated] of Object.entries(table)) {
    if (!/\{\w+\}/.test(english)) {
      exact[english] = translated;
      continue;
    }
    const names: string[] = [];
    const source = english
      .split(/\{(\w+)\}/)
      .map((part, at) => {
        if (at % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(part);
        return "(.+?)";
      })
      .join("");
    patterns.push({ regex: new RegExp(`^${source}$`), names, template: translated });
  }
  return { exact, patterns };
}

const SOURCE_TEXT: Readonly<Record<Language, SourceTable>> = { en: { exact: {}, patterns: [] }, "es-ES": compile(settingsEs) };

/**
 * Text whose English lives outside the TUI (the settings table in core, which
 * the CLI shares) in the current language: looked up by the English itself,
 * then against the `{name}` patterns, whose captured parts are translated in
 * turn. Left as it is when the language is English or the text is not listed.
 */
export function tx(english: string): string {
  return translateSource(SOURCE_TEXT[current], english);
}

function translateSource(table: SourceTable, english: string): string {
  const exact = table.exact[english];
  if (exact !== undefined) return exact;
  for (const { regex, names, template } of table.patterns) {
    const match = regex.exec(english);
    if (match === null) continue;
    const parts: Record<string, string> = {};
    names.forEach((name, at) => (parts[name] = translateSource(table, match[at + 1]!)));
    return fill(template, parts);
  }
  return english;
}

/** Whether `tx` knows a Spanish form for `english`; for the test that every setting the page offers has one. */
export function hasSourceText(language: Language, english: string): boolean {
  return english in SOURCE_TEXT[language].exact;
}
