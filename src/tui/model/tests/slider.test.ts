import { describe, expect, it } from "vitest";

import { effortTones, nearestStop, sliderLayout, stopTones } from "../slider.js";
import { sliderChoices } from "../listeditor.js";

describe("sliderLayout", () => {
  it("puts the first label flush left, the last flush right and the rest by position", () => {
    const layout = sliderLayout(["low", "medium", "high", "xhigh", "max"], 60);
    expect(layout.starts[0]).toBe(0);
    expect(layout.starts[4]! + 3).toBe(60);
    expect(layout.fits).toBe(true);
    expect(layout.markers[1]).toBe(layout.starts[1]! + 3);
  });

  it("says when the labels do not fit, so the caller can list them", () => {
    expect(sliderLayout(["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes"], 40).fits).toBe(false);
  });

  it("packs crowded labels instead of giving up, so a narrow pane still gets a slider", () => {
    const labels = ["30s", "1m", "2m", "5m", "10m", "30m", "1h"];
    const layout = sliderLayout(labels, 40);
    expect(layout.fits).toBe(true);
    expect(layout.starts[0]).toBe(0);
    expect(layout.starts[6]! + 2).toBe(40);
    const tight = sliderLayout(["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes", "30 minutes", "1 hour"], 68);
    expect(tight.fits).toBe(true);
    expect(sliderLayout(["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes", "30 minutes", "1 hour"], 67).fits).toBe(false);
  });

  it("finds the stop nearest a click", () => {
    const layout = sliderLayout(["a", "b", "c"], 21);
    expect(nearestStop(layout, 0)).toBe(0);
    expect(nearestStop(layout, 11)).toBe(1);
    expect(nearestStop(layout, 40)).toBe(2);
  });
});

describe("sliderChoices", () => {
  const options = [
    { value: "", label: "Default" },
    { value: "3", label: "3" },
    { value: "4", label: "4" },
    { value: "5", label: "5" },
    { value: "\u0000text", label: "Another value…" },
  ];
  it("takes numbers as stops and keeps the default and typing as actions beside them", () => {
    const slider = sliderChoices(options, 40);
    expect(slider?.stops.map((option) => option.value)).toEqual(["3", "4", "5"]);
    expect(slider?.reset?.label).toBe("Default");
    expect(slider?.custom?.label).toBe("Another value…");
  });
  it("leaves words to a list", () => {
    expect(sliderChoices([{ value: "", label: "Default" }, { value: "a", label: "Adaptive" }, { value: "b", label: "Budget" }], 40)).toBeNull();
  });
});

describe("effortTones", () => {
  it("colours the named levels cool to hot, each its own", () => {
    const tones = effortTones(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(new Set(tones).size).toBe(6);
    expect(effortTones(["max", "low"])).toEqual([tones[4], tones[0]]);
    expect(effortTones(["ultra"])).toEqual([tones[5]]);
  });
  it("spreads unnamed levels along the same ramp by position", () => {
    const tones = effortTones(["a", "b", "c"]);
    expect(tones).toHaveLength(3);
    expect(new Set(tones).size).toBe(3);
  });
});

describe("stopTones", () => {
  it("gives every stop its own colour along one ramp", () => {
    for (const count of [2, 5, 7]) {
      const tones = stopTones(count);
      expect(tones).toHaveLength(count);
      expect(new Set(tones).size).toBe(count);
      expect(tones.every((tone) => /^#[0-9a-f]{6}$/.test(tone))).toBe(true);
    }
  });
});
