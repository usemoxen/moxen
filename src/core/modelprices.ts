/**
 * The per-model token prices a provider can carry
 * (`providers.<kind>.model{Input,Output,CacheRead,CacheWrite}Prices`):
 * model slug -> USD per million tokens.
 *
 * The file keeps an object; `config set` and the settings page take the same
 * thing as text, one `slug=price` per line or comma-separated, because a
 * slug may hold dots and slashes and so cannot be a dotted key. Prices are
 * non-negative numbers; zero is a free model, not an unpriced one.
 */
import { CliError } from "./errors.js";

function parsePrice(text: string, label: string): number {
  if (text.trim() === "") {
    throw new CliError("INVALID_CONFIG", `${label} must be a price in USD per million tokens, zero or more.`);
  }
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new CliError("INVALID_CONFIG", `${label} must be a price in USD per million tokens, zero or more.`);
  }
  return value;
}

/** `slug=price` pairs from text; empty text is no prices. */
export function parsePriceMap(text: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(/[\n,]/)) {
    const entry = part.trim();
    if (entry === "") continue;
    const at = entry.lastIndexOf("=");
    const slug = at < 0 ? "" : entry.slice(0, at).trim();
    if (slug === "") throw new CliError("INVALID_CONFIG", `${label} takes model=price pairs, for example gpt-6.1-sol=2.`);
    out[slug] = parsePrice(entry.slice(at + 1), `${label}: ${slug}`);
  }
  return out;
}

/** A value from the file (an object, or the same text `config set` takes) as a clean map; undefined when it holds nothing. */
export function normalizePriceMap(raw: unknown, label: string): Record<string, number> | undefined {
  let map: Record<string, number>;
  if (typeof raw === "string") map = parsePriceMap(raw, label);
  else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    map = {};
    for (const [slug, price] of Object.entries(raw)) {
      if (typeof price !== "number" && typeof price !== "string") throw new CliError("INVALID_CONFIG", `${label}: ${slug} must be a price in USD per million tokens, zero or more.`);
      map[slug] = parsePrice(String(price), `${label}: ${slug}`);
    }
  } else throw new CliError("INVALID_CONFIG", `${label} must be an object of model slug to price.`);
  return Object.keys(map).length > 0 ? map : undefined;
}

/** The text form: `slug=price`, comma-separated. */
export function formatPriceMap(map: Readonly<Record<string, number>>): string {
  return Object.entries(map).map(([slug, price]) => `${slug}=${price}`).join(", ");
}
