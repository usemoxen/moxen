import { SyntaxStyle } from "@opentui/core";
import { DEFAULT_THEME, THEMES, isThemeName, type ThemeName, type ThemeSpec } from "./themes.js";

/*
 * The palettes below are plain objects that `applyTheme` rewrites in place.
 * Components read them while rendering, so a theme change shows on the next
 * draw without anything being re-imported. Never copy a value out at module
 * load (`const X = COLOR.accent`): it would keep the old theme's colour.
 */

/**
 * One quiet scale per theme: panes separate by a few lightness steps on the
 * same hue, so chrome never bands into stripes. Colour carries meaning, not
 * chrome.
 */
export const SURFACE = {
  base: "",
  panel: "",
  raised: "",
  /** Button hover fill — one step above `raised`, for text buttons that
      signal hover with a background instead of a tone/underline change. */
  hover: "",
  user: "",
  agent: "",
  border: "",
  borderFocus: "",
};

/** One palette for every pane so chrome stays quiet and colour carries meaning. */
export const COLOR = {
  text: "",
  bright: "",
  dim: "",
  faint: "",
  rule: "",
  accent: "",
  user: "",
  agent: "",
  tool: "",
  command: "",
  warn: "",
  danger: "",
  diff: "",
  added: "",
  removed: "",
  selectionBg: "",
};

/**
 * A thread's mode, on the composer's left edge and in its footer. Amber
 * (running, warnings) and green (the user's messages) already mean something,
 * so no mode takes them. Build's restrained teal, Research's cool lavender,
 * and Orchestrate's orchid stay distinct; blue remains the app's structural
 * focus colour instead of competing with Build in the composer.
 */
export const MODE_COLOR = { default: "", research: "", orchestrate: "" };

/** The other end of each mode's running pulse (`pulseColor` from `MODE_COLOR`). */
export const MODE_PULSE = { default: "", research: "", orchestrate: "" };

/**
 * Tree-sitter highlight-group palette for code grammars (`keyword`,
 * `string`, `function`, …). `SyntaxStyle.create()` registers no token
 * styles, which paints every token the same default colour —
 * `MARKDOWN_SYNTAX_TOKENS` below merges this table in so fenced code and
 * diffs share one code palette, while `markup.*` entries cover markdown.
 * Consumed only via `markdownSyntaxStyle()` (every `<code>`/`<diff>`/
 * `<markdown>` renderable); never passed to a renderable directly, or
 * markdown files render all-white (no `markup.*` groups).
 */
export type SyntaxToken = { fg: string; italic?: boolean; bold?: boolean };
export const CODE_SYNTAX_TOKENS: Record<string, SyntaxToken> = {};

/** Row-background palette for `<diff>` renderables — shared by the full-file
    `diffpanel.tsx` view and the inline per-edit diff in `timeline.tsx` so a
    change reads the same color whether it's in the side panel or the chat. */
export const DIFF_BG = { added: "", removed: "", addedLineNumber: "", removedLineNumber: "" };

export const STATUS_COLOR: Record<string, string> = {};

function codeTokens(t: ThemeSpec): Record<string, SyntaxToken> {
  return {
    default: { fg: t.text },
    keyword: { fg: t.purple, italic: true },
    "keyword.import": { fg: t.purple },
    "keyword.return": { fg: t.purple, italic: true },
    "keyword.function": { fg: t.accent },
    "keyword.operator": { fg: t.cyan },
    "keyword.type": { fg: t.yellow, bold: true },
    string: { fg: t.green },
    "string.special": { fg: t.green },
    comment: { fg: t.comment, italic: true },
    number: { fg: t.orange },
    boolean: { fg: t.orange },
    constant: { fg: t.orange },
    function: { fg: t.accent },
    "function.call": { fg: t.accent },
    "function.method": { fg: t.accent },
    constructor: { fg: t.accent },
    type: { fg: t.yellow },
    class: { fg: t.yellow },
    module: { fg: t.yellow },
    variable: { fg: t.text },
    "variable.parameter": { fg: t.orange },
    "variable.member": { fg: t.accent },
    property: { fg: t.teal },
    operator: { fg: t.cyan },
    punctuation: { fg: t.cyan },
    "punctuation.bracket": { fg: t.cyan },
    "punctuation.delimiter": { fg: t.cyan },
    bracket: { fg: t.cyan },
    tag: { fg: t.red },
    "tag.attribute": { fg: t.yellow },
    label: { fg: t.purple },
  };
}

let currentTheme: ThemeName = DEFAULT_THEME;

/** The theme the palettes currently hold. */
export function activeTheme(): ThemeName {
  return currentTheme;
}

/**
 * Rewrites every palette in place for `name` (an unknown name falls back to
 * the default) and drops the cached markdown style. Returns whether anything
 * changed, so a caller can skip a redraw.
 */
export function applyTheme(name: string | undefined): boolean {
  const next: ThemeName = isThemeName(name) ? name : DEFAULT_THEME;
  if (next === currentTheme && SURFACE.base !== "") return false;
  currentTheme = next;
  const t: ThemeSpec = THEMES[next];
  Object.assign(SURFACE, {
    base: t.base,
    panel: t.panel,
    raised: t.raised,
    hover: t.hover,
    user: t.user,
    agent: t.panel,
    border: t.border,
    borderFocus: t.accent,
  });
  Object.assign(COLOR, {
    text: t.text,
    bright: t.bright,
    dim: t.dim,
    faint: t.faint,
    rule: t.border,
    accent: t.accent,
    user: t.green,
    agent: t.blue,
    tool: t.tool ?? t.dim,
    command: t.green,
    warn: t.yellow,
    danger: t.red,
    diff: t.purple,
    added: t.green,
    removed: t.red,
    selectionBg: t.selection,
  });
  Object.assign(MODE_COLOR, { default: t.teal, research: t.purple, orchestrate: t.pink });
  Object.assign(MODE_PULSE, {
    default: lerpColor(t.teal, t.bright, 0.7),
    research: lerpColor(t.purple, t.bright, 0.7),
    orchestrate: lerpColor(t.pink, t.bright, 0.7),
  });
  Object.assign(DIFF_BG, {
    added: lerpColor(t.base, t.green, 0.14),
    removed: lerpColor(t.base, t.red, 0.14),
    addedLineNumber: lerpColor(t.base, t.green, 0.2),
    removedLineNumber: lerpColor(t.base, t.red, 0.2),
  });
  for (const key of Object.keys(CODE_SYNTAX_TOKENS)) delete CODE_SYNTAX_TOKENS[key];
  Object.assign(CODE_SYNTAX_TOKENS, codeTokens(t));
  for (const key of Object.keys(STATUS_COLOR)) delete STATUS_COLOR[key];
  Object.assign(STATUS_COLOR, {
    running: t.accent,
    blocked: t.red,
    active: t.yellow,
    snoozed: t.purple,
    settled: t.dim,
  });
  cachedMarkdownStyle = null;
  return true;
}

/**
 * Best-effort brand-color approximations — the provider catalog carries no
 * color of its own (`ProviderSummary.driver` is a free-form string), so this
 * is a client-side guess keyed by substring match, same idea as the sidebar's
 * hashed project badge colors. Cosmetic; retune the hexes freely.
 */
const PROVIDER_COLOR_BY_KEYWORD: readonly [keyword: string, color: string][] = [
  ["claude", "#DE7356"],
  ["openai", "#74AA9C"],
  ["opencode", "#8B5CF6"],
];

/** Matches on `driver`/`instanceId`/model slug — whatever names the provider. */
export function providerColor(...candidates: readonly (string | null | undefined)[]): string | null {
  const haystack = candidates.filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
  for (const [keyword, color] of PROVIDER_COLOR_BY_KEYWORD) {
    if (haystack.includes(keyword)) return color;
  }
  return null;
}

/** Filled bar marking the focused pane or the open thread. */
export const MARKER = "▌";

/** Shared "thinking" spinner frames — one per second, so the terminal title
    and the chat pane's live indicator stay in visual sync. */
export const SPINNER = ["◐", "◓", "◑", "◒"];

/**
 * Lively braille spinner for in-pane live indicators (10 frames at ~100ms).
 * The terminal title keeps `SPINNER` — titles update on the 1s `now` tick,
 * so braille there would just alias.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** Left text padded so `right` sits flush against the far edge of `width`. */
export function spread(left: string, right: string, width: number): string {
  const trimmed = truncate(left, Math.max(0, width - right.length - 1));
  const gap = Math.max(1, width - trimmed.length - right.length);
  return `${trimmed}${" ".repeat(gap)}${right}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function toHex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
}

/** Linear-interpolates between two hex colors at `t` (0..1). */
export function lerpColor(from: string, to: string, t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const [fr, fg, fb] = hexToRgb(from);
  const [tr, tg, tb] = hexToRgb(to);
  return `#${toHex(fr + (tr - fr) * clamped)}${toHex(fg + (tg - fg) * clamped)}${toHex(fb + (tb - fb) * clamped)}`;
}

/**
 * The ground the model scenes paint on. Scenes add light onto it, so on a
 * light theme (where light on light is just white) they keep a night ground
 * taken from the theme's own text colour instead of its surface.
 */
export function sceneBase(): string {
  const [r, g, b] = hexToRgb(SURFACE.base);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.5 ? lerpColor(COLOR.text, "#000000", 0.72) : SURFACE.base;
}

/**
 * A slow gray-to-vivid-to-gray pulse so a "working" indicator reads as
 * actively alive rather than a static label. `now`/`startedAt` drive the
 * phase so the color advances on the same tick that already redraws the
 * elapsed clock — no extra timer.
 */
export function pulseColor(elapsedMs: number, from: string, to: string, periodMs = 4000): string {
  const phase = (elapsedMs % periodMs) / periodMs;
  const triangle = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return lerpColor(from, to, triangle);
}

/**
 * `SyntaxStyle.create()` registers no token styles, which paints every
 * markdown construct — headings, lists, bold, links, code — in the same
 * default colour. These names are the `<markdown>` renderable's fixed
 * vocabulary (marked.js token groups for inline styles, tree-sitter capture
 * groups from `@opentui/core/assets/markdown/highlights.scm` for block-level
 * ones like headings/lists/quotes); an explicit table is required per level
 * since the renderable's group-name fallback only strips to the first
 * dot-segment (`markup.heading.3` → `markup`, not `markup.heading`).
 *
 * Fenced code blocks render through a nested `CodeRenderable` that reuses
 * this same `syntaxStyle` but highlights with language-grammar groups
 * (`keyword`, `string`, `function`, ...) instead of `markup.*` ones — the
 * spread of `CODE_SYNTAX_TOKENS` above keeps those vivid. `<diff>`
 * renderables (`diffpanel.tsx`, inline file rows in `timeline.tsx`) take
 * this same style so `md`/`mdx` hunks highlight via `markup.*` instead of
 * falling back to all-white default text.
 */
function markdownSyntaxTokens() {
  return {
    ...CODE_SYNTAX_TOKENS,
    default: { fg: COLOR.text },
    conceal: { fg: COLOR.faint },
    "markup.heading": { fg: COLOR.bright, bold: true },
    "markup.heading.1": { fg: COLOR.accent, bold: true, underline: true },
    "markup.heading.2": { fg: COLOR.accent, bold: true },
    "markup.heading.3": { fg: COLOR.bright, bold: true },
    "markup.heading.4": { fg: COLOR.text, bold: true },
    "markup.heading.5": { fg: COLOR.dim, bold: true },
    "markup.heading.6": { fg: COLOR.dim, italic: true },
    "markup.strong": { fg: COLOR.bright, bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { fg: COLOR.dim, dim: true },
    "markup.raw": { fg: COLOR.command },
    "markup.raw.block": { fg: COLOR.command },
    "markup.link": { fg: COLOR.dim },
    "markup.link.label": { fg: COLOR.accent, underline: true },
    "markup.link.url": { fg: COLOR.dim },
    "markup.list": { fg: COLOR.accent },
    "markup.list.checked": { fg: COLOR.added },
    "markup.list.unchecked": { fg: COLOR.dim },
    "markup.quote": { fg: COLOR.dim, italic: true },
    // Shared by markdown's own decoration marks (table pipes, `hr`) *and*
    // code's template-literal interpolation braces (`${...}`) — one group
    // name, two contexts; `dim` reads fine as de-emphasis in both rather than
    // vanishing against the panel background like `faint` did for `${}`.
    "punctuation.special": { fg: COLOR.dim },
    label: { fg: COLOR.dim },
    "keyword.directive": { fg: COLOR.warn },
    "string.escape": { fg: COLOR.dim },
  };
}

let cachedMarkdownStyle: SyntaxStyle | null = null;

/** The shared style every `<markdown>` renderable takes (messages, plans, question previews). */
export function markdownSyntaxStyle(): SyntaxStyle {
  cachedMarkdownStyle ??= SyntaxStyle.fromStyles(markdownSyntaxTokens());
  return cachedMarkdownStyle;
}

applyTheme(DEFAULT_THEME);
