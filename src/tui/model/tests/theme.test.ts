import { afterEach, describe, expect, test } from "vitest";
import { COLOR, DIFF_BG, MODE_COLOR, SURFACE, activeTheme, applyTheme } from "../../theme.js";
import { THEMES, THEME_NAMES } from "../../themes.js";
import { SETTINGS } from "../../../core/configschema.js";

afterEach(() => {
  applyTheme("moxen");
});

describe("themes", () => {
  test("every theme fills every colour with a hex value", () => {
    for (const name of THEME_NAMES) {
      applyTheme(name);
      const all = [...Object.values(SURFACE), ...Object.values(COLOR), ...Object.values(MODE_COLOR), ...Object.values(DIFF_BG)];
      for (const value of all) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("applyTheme rewrites the shared palettes in place and reports changes", () => {
    const colors = COLOR;
    expect(applyTheme("dracula")).toBe(true);
    expect(COLOR).toBe(colors);
    expect(COLOR.accent).toBe(THEMES.dracula.accent);
    expect(applyTheme("dracula")).toBe(false);
  });

  test("an unknown name falls back to the default theme", () => {
    applyTheme("nord");
    applyTheme("no-such-theme");
    expect(activeTheme()).toBe("moxen");
  });

  test("the setting offers exactly the themes that exist", () => {
    const setting = SETTINGS.find((entry) => entry.key === "ui.theme");
    const kind = setting?.kind;
    if (kind?.type !== "enum") throw new Error("ui.theme is not an enum");
    expect(kind.choices.map((choice) => choice.value).sort()).toEqual([...THEME_NAMES].sort());
  });
});

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio, 1 to 21. */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("theme contrast", () => {
  // Body text must read; secondary text and hues carry meaning, so they get a lower floor.
  const floors: ReadonlyArray<readonly [role: keyof (typeof THEMES)["moxen"], floor: number]> = [
    ["text", 4.5],
    ["bright", 4.5],
    ["dim", 3],
    ["accent", 3],
    ["green", 3],
    ["red", 3],
    ["yellow", 3],
    ["purple", 3],
    ["orange", 3],
    ["cyan", 3],
    ["teal", 3],
    ["comment", 2],
  ];
  for (const name of THEME_NAMES) {
    test(`${name} keeps its text readable on every surface`, () => {
      const theme = THEMES[name];
      const problems: string[] = [];
      for (const surface of ["base", "panel", "raised"] as const) {
        for (const [role, floor] of floors) {
          const ratio = contrast(theme[role], theme[surface]);
          if (ratio < floor) problems.push(`${role} on ${surface}: ${ratio.toFixed(2)} < ${floor}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
