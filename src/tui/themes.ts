/**
 * The colour roles one theme supplies. Everything else the TUI paints
 * (mode accents, diff rows, the code palette) is derived from these in
 * `theme.ts`, so a theme is ~25 hexes rather than a hundred.
 */
export interface ThemeSpec {
  label: string;
  /** Pane surfaces, darkest to lightest on a dark theme. */
  base: string;
  panel: string;
  raised: string;
  hover: string;
  user: string;
  border: string;
  /** Text, strongest to quietest. */
  bright: string;
  text: string;
  dim: string;
  faint: string;
  /** Hues. */
  accent: string;
  green: string;
  blue: string;
  yellow: string;
  red: string;
  purple: string;
  pink: string;
  orange: string;
  cyan: string;
  teal: string;
  comment: string;
  selection: string;
  /** The tool-call grey; falls back to `dim`. */
  tool?: string;
}

export const DEFAULT_THEME = "moxen";

/**
 * Palettes follow each theme's published colours, except where one is too
 * faint to read on its own surfaces (the contrast test in
 * `model/tests/theme.test.ts` is the bar): Latte's yellow, orange, green,
 * cyan, teal and comment are darkened, Nord's red and comment lightened.
 */
export const THEMES = {
  moxen: {
    label: "Moxen",
    base: "#09090b",
    panel: "#0f0f12",
    raised: "#17171b",
    hover: "#202027",
    user: "#14141a",
    border: "#27272a",
    bright: "#eceef2",
    text: "#dcdfe4",
    dim: "#8b8f98",
    faint: "#3f3f46",
    accent: "#7dd3fc",
    green: "#86efac",
    blue: "#93c5fd",
    yellow: "#fbbf24",
    red: "#f87171",
    purple: "#c4b5fd",
    pink: "#e9a8f5",
    orange: "#f78c6c",
    cyan: "#89ddff",
    teal: "#72cdbd",
    comment: "#5f7e97",
    selection: "#1f2937",
    tool: "#a1a1aa",
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    base: "#eff1f5",
    panel: "#e6e9ef",
    raised: "#dce0e8",
    hover: "#ccd0da",
    user: "#e6e9ef",
    border: "#ccd0da",
    bright: "#4c4f69",
    text: "#4c4f69",
    dim: "#6c7086",
    faint: "#acb0be",
    accent: "#1e66f5",
    green: "#398e26",
    blue: "#209fb5",
    yellow: "#ae6f17",
    red: "#d20f39",
    purple: "#8839ef",
    pink: "#ea76cb",
    orange: "#d55409",
    cyan: "#0386b9",
    teal: "#168990",
    comment: "#969aa9",
    selection: "#ccd0da",
    tool: "#7c7f93",
  },
  "catppuccin-frappe": {
    label: "Catppuccin Frappé",
    base: "#303446",
    panel: "#292c3c",
    raised: "#414559",
    hover: "#51576d",
    user: "#292c3c",
    border: "#414559",
    bright: "#c6d0f5",
    text: "#c6d0f5",
    dim: "#a5adce",
    faint: "#626880",
    accent: "#8caaee",
    green: "#a6d189",
    blue: "#85c1dc",
    yellow: "#e5c890",
    red: "#e78284",
    purple: "#ca9ee6",
    pink: "#f4b8e4",
    orange: "#ef9f76",
    cyan: "#99d1db",
    teal: "#81c8be",
    comment: "#737994",
    selection: "#51576d",
    tool: "#838ba7",
  },
  "catppuccin-macchiato": {
    label: "Catppuccin Macchiato",
    base: "#24273a",
    panel: "#1e2030",
    raised: "#363a4f",
    hover: "#494d64",
    user: "#1e2030",
    border: "#363a4f",
    bright: "#cad3f5",
    text: "#cad3f5",
    dim: "#a5adcb",
    faint: "#5b6078",
    accent: "#8aadf4",
    green: "#a6da95",
    blue: "#7dc4e4",
    yellow: "#eed49f",
    red: "#ed8796",
    purple: "#c6a0f6",
    pink: "#f5bde6",
    orange: "#f5a97f",
    cyan: "#91d7e3",
    teal: "#8bd5ca",
    comment: "#6e738d",
    selection: "#494d64",
    tool: "#8087a2",
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    base: "#1e1e2e",
    panel: "#181825",
    raised: "#313244",
    hover: "#45475a",
    user: "#181825",
    border: "#313244",
    bright: "#cdd6f4",
    text: "#cdd6f4",
    dim: "#a6adc8",
    faint: "#585b70",
    accent: "#89b4fa",
    green: "#a6e3a1",
    blue: "#74c7ec",
    yellow: "#f9e2af",
    red: "#f38ba8",
    purple: "#cba6f7",
    pink: "#f5c2e7",
    orange: "#fab387",
    cyan: "#89dceb",
    teal: "#94e2d5",
    comment: "#6c7086",
    selection: "#45475a",
    tool: "#7f849c",
  },
  dracula: {
    label: "Dracula",
    base: "#282a36",
    panel: "#21222c",
    raised: "#343746",
    hover: "#44475a",
    user: "#21222c",
    border: "#44475a",
    bright: "#f8f8f2",
    text: "#f8f8f2",
    dim: "#b6b9cc",
    faint: "#6272a4",
    accent: "#bd93f9",
    green: "#50fa7b",
    blue: "#8be9fd",
    yellow: "#f1fa8c",
    red: "#ff5555",
    purple: "#bd93f9",
    pink: "#ff79c6",
    orange: "#ffb86c",
    cyan: "#8be9fd",
    teal: "#8be9fd",
    comment: "#6272a4",
    selection: "#44475a",
    tool: "#9aa0bd",
  },
  nord: {
    label: "Nord",
    base: "#2e3440",
    panel: "#292e39",
    raised: "#3b4252",
    hover: "#434c5e",
    user: "#292e39",
    border: "#3b4252",
    bright: "#eceff4",
    text: "#e5e9f0",
    dim: "#a3adc0",
    faint: "#4c566a",
    accent: "#88c0d0",
    green: "#a3be8c",
    blue: "#81a1c1",
    yellow: "#ebcb8b",
    red: "#d4737d",
    purple: "#b48ead",
    pink: "#b48ead",
    orange: "#d08770",
    cyan: "#8fbcbb",
    teal: "#8fbcbb",
    comment: "#6b7893",
    selection: "#434c5e",
    tool: "#9099ad",
  },
  gruvbox: {
    label: "Gruvbox",
    base: "#282828",
    panel: "#1d2021",
    raised: "#3c3836",
    hover: "#504945",
    user: "#1d2021",
    border: "#3c3836",
    bright: "#fbf1c7",
    text: "#ebdbb2",
    dim: "#a89984",
    faint: "#665c54",
    accent: "#83a598",
    green: "#b8bb26",
    blue: "#83a598",
    yellow: "#fabd2f",
    red: "#fb4934",
    purple: "#d3869b",
    pink: "#d3869b",
    orange: "#fe8019",
    cyan: "#8ec07c",
    teal: "#8ec07c",
    comment: "#928374",
    selection: "#504945",
    tool: "#928374",
  },
  "tokyo-night": {
    label: "Tokyo Night",
    base: "#1a1b26",
    panel: "#16161e",
    raised: "#292e42",
    hover: "#343b58",
    user: "#16161e",
    border: "#292e42",
    bright: "#c0caf5",
    text: "#a9b1d6",
    dim: "#787c99",
    faint: "#414868",
    accent: "#7aa2f7",
    green: "#9ece6a",
    blue: "#7dcfff",
    yellow: "#e0af68",
    red: "#f7768e",
    purple: "#bb9af7",
    pink: "#bb9af7",
    orange: "#ff9e64",
    cyan: "#7dcfff",
    teal: "#73daca",
    comment: "#565f89",
    selection: "#283457",
    tool: "#737aa2",
  },
} as const satisfies Record<string, ThemeSpec>;

export type ThemeName = keyof typeof THEMES;

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && Object.hasOwn(THEMES, value);
}
