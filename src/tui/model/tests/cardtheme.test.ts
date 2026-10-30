import { afterEach, describe, expect, it } from "vitest";

import { cardPalette } from "../cardtheme.js";
import { THEME_NAMES } from "../../themes.js";
import { SURFACE, applyTheme } from "../../theme.js";

const HEX = /^#[0-9a-f]{6}$/iu;

afterEach(() => applyTheme("moxen"));

describe("the stats card's palette", () => {
  it("is the current theme's, as #rrggbb, for every theme", () => {
    for (const name of THEME_NAMES) {
      applyTheme(name);
      const palette = cardPalette();
      const colours = [palette.background, palette.text, palette.dim, palette.empty, palette.muted, ...palette.levels];
      expect(colours.every((colour) => HEX.test(colour)), name).toBe(true);
      expect(palette.levels).toHaveLength(4);
      expect(palette.background).toBe(SURFACE.base);
    }
  });

  it("changes with the theme, and its levels step from the quietest colour towards the accent", () => {
    applyTheme(THEME_NAMES[0]);
    const first = cardPalette();
    applyTheme(THEME_NAMES.find((name) => cardPalette().background !== first.background) ?? THEME_NAMES[1]);
    expect(cardPalette().background).not.toBe(first.background);
    expect(new Set(first.levels).size).toBe(4);
  });
});
