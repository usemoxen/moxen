import { describe, expect, it } from "vitest";

import { buildMonitoringGrid } from "../../backdrop.js";
import { createScene, sceneForModel, type SceneId } from "../catalog.js";
import { createGridScene } from "../grid.js";
import { seasonAt } from "../haiku.js";
import { journeyBetween, journeyFrames } from "../journey.js";
import { landAt, moonPhase, subsolarPoint, SYNODIC_DAYS } from "../sky.js";
import { createFrame, type Frame, type Pointer, type SceneWindow } from "../raster.js";

function paint(scene: SceneId, win: SceneWindow, t: number, pointer: Pointer | null): Frame {
  const frame = createFrame(win.width, win.height);
  createScene(scene).paint(frame, win, t, pointer);
  return frame;
}

describe("model scenes", () => {
  it.each([
    ["Claude Opus 5", "opus"],
    ["claude-opus-5-5", "opus"],
    ["anthropic/claude-opus-4-5", "opus"],
    ["GPT-6.1 Sol", "sol"],
    ["gpt-6.1-sol", "sol"],
    ["Claude Sonnet 5", "sonnet"],
    ["claude-sonnet-5-5", "sonnet"],
    ["Claude Haiku 5.5", "haiku"],
    ["Claude Fable 5.1", "fable"],
    ["Claude Mythos 5.1", "mythos"],
    ["GPT-6 Astra", "astra"],
    ["GPT-6 Terra", "terra"],
    ["GPT-6 Luna", "luna"],
    ["GPT-5 Codex", null],
    ["Console 2", null],
    ["Opusculum 2", null],
    ["-", null],
    [null, null],
  ])("matches %s to its scene by family word", (model, scene) => {
    expect(sceneForModel(model)).toBe(scene);
  });

  it.each([
    // Opus at t=15 has a comet in flight; the pointer sits on the seam.
    ["opus", 15, { x: 40, y: 20, strength: 1 }],
    // Haiku in autumn (October 2026): the branch and its falling leaves cross the seam.
    ["haiku", 1791500000, { x: 40, y: 50, strength: 1 }],
    // Fable with the 5 formed, and moths circling a pointer on the seam.
    ["fable", 36 * 1000 + 22, { x: 40, y: 30, strength: 1 }],
    // Mythos with the 5 formed: halos, scale-dust and threads, everything swarming a lamp on the seam.
    ["mythos", 36 * 1000 + 22, { x: 40, y: 30, strength: 1 }],
    // Sonnet's ribbon crosses the seam mid-recitation; the pointer presses its strings there.
    ["sonnet", 13.8, { x: 40, y: 22, strength: 1 }],
    // Astra mid-jump: streaks and the tunnel cross the seam, the pointer steering from it.
    ["astra", 36 * 1000 + 32, { x: 40, y: 20, strength: 1 }],
    // Terra and Luna, the pointer as the Sun on the seam.
    ["terra", 1791500000, { x: 40, y: 20, strength: 1 }],
    ["luna", 1791500000, { x: 40, y: 20, strength: 1 }],
    // Sol's Sun rises across the seam; the pointer puts a planet there.
    ["sol", 1000, { x: 40, y: 44, strength: 1 }],
  ] as const)("paints the same %s field from two adjacent windows as from one", (scene, t, pointer) => {
    // Every scene paints a window onto one field (the terminal): anything
    // computed in window-local coordinates shows as a seam the moment a
    // pane is not at the origin. Transients and the pointer are covered,
    // not just the slow layers — a star lensed in from beyond a window's
    // edge once went missing exactly here.
    const field = { fieldWidth: 90, fieldHeight: 30 };
    const whole = paint(scene, { x: 0, y: 0, width: 90, height: 30, ...field }, t, pointer);
    const left = paint(scene, { x: 0, y: 0, width: 40, height: 30, ...field }, t, pointer);
    const right = paint(scene, { x: 40, y: 0, width: 50, height: 30, ...field }, t, pointer);
    let lit = 0;
    for (let py = 0; py < 60; py++) {
      for (let px = 0; px < 90; px++) {
        const side = px < 40 ? left : right;
        const local = ((py * side.width) + (px < 40 ? px : px - 40)) * 3;
        const global = (py * 90 + px) * 3;
        for (let k = 0; k < 3; k++) {
          expect(side.light[local + k]).toBeCloseTo(whole.light[global + k]!, 5);
        }
        if (whole.light[global]! > 0.05) lit++;
      }
    }
    expect(lit).toBeGreaterThan(500);
    for (let cy = 0; cy < 30; cy++) {
      for (let cx = 0; cx < 90; cx++) {
        const side = cx < 40 ? left : right;
        expect(side.glyph[cy * side.width + (cx < 40 ? cx : cx - 40)]).toBe(whole.glyph[cy * 90 + cx]);
      }
    }
  });

  it.each([
    [2026, 11, "winter"],
    [2026, 1, "winter"],
    [2026, 2, "spring"],
    [2026, 5, "summer"],
    [2026, 8, "autumn"],
  ] as const)("gives Haiku's kigo for %i-%i as %s", (year, month, season) => {
    // Haiku's season word follows the calendar: December belongs to the
    // winter that starts the next year, not to autumn.
    expect(seasonAt(new Date(year, month, 15).getTime() / 1000)).toBe(season);
  });

  it.each([
    ["Madrid", 40.4, -3.7, 1],
    ["the mid-Atlantic", 30, -40, 0],
    ["the Sahara", 23, 10, 1],
    ["the central Pacific", 0, -150, 0],
    ["Australia", -25, 134, 1],
    // Eurasia's outline crosses the antimeridian; rasterised naively, Siberia came out as sea.
    ["Siberia", 65, 120, 1],
    // Antarctica circles the pole, so its outline only closes through it.
    ["the South Pole", -89, 0, 1],
  ] as const)("knows %s is %s on Terra's land mask", (_place, lat, lon, land) => {
    expect(Math.round(landAt(lat, lon))).toBe(land);
  });

  it("puts the Moon at new for the 8 April 2024 total solar eclipse", () => {
    // An eclipse of the Sun happens only at new Moon: a fixed point to check the phase clock against.
    const age = (moonPhase(Date.UTC(2024, 3, 8, 18, 21) / 1000) / (2 * Math.PI)) * SYNODIC_DAYS;
    expect(Math.min(age, SYNODIC_DAYS - age)).toBeLessThan(0.75);
  });

  it("puts the Sun over the equator and the prime meridian at noon UTC on the March equinox", () => {
    const { lat, lon } = subsolarPoint(Date.UTC(2026, 2, 20, 12, 0) / 1000);
    expect(Math.abs(lat)).toBeLessThan(1.5);
    expect(Math.abs(lon)).toBeLessThan(0.5);
  });

  it.each([
    ["terra", "luna", "hop"],
    ["luna", "terra", "hop"],
    ["sol", "terra", "cruise"],
    ["luna", "sol", "cruise"],
    ["astra", "sol", "warp"],
    ["terra", "astra", "warp"],
    ["opus", "sonnet", null],
    ["sol", "opus", null],
    ["grid", "luna", null],
  ] as const)("travels from %s to %s by %s", (from, to, kind) => {
    // The OpenAI scenes are places in one neighbourhood: switching between
    // them is a journey whose kind follows the distance; anything else blooms.
    expect(journeyBetween(from, to)?.kind ?? null).toBe(kind);
  });

  it.each([
    ["terra", "luna"],
    ["sol", "terra"],
    ["luna", "astra"],
  ] as const)("starts the %s→%s journey on the old scene and ends it on the new one", (from, to) => {
    // A transition that is not exactly its endpoints at p = 0 and p = 1
    // pops visibly the moment it begins or hands over to the plain scene.
    const win = { x: 44, y: 0, width: 60, height: 20, fieldWidth: 104, fieldHeight: 20 };
    const a = paint(from, win, 1791500000, null);
    const b = paint(to, win, 1791500000, null);
    const journey = journeyBetween(from, to)!;
    const out = createFrame(win.width, win.height);
    journeyFrames(a, b, out, 0, journey);
    expect(Array.from(out.light)).toEqual(Array.from(a.light));
    journeyFrames(a, b, out, 1, journey);
    expect(Array.from(out.light)).toEqual(Array.from(b.light));
    // And halfway it is neither.
    journeyFrames(a, b, out, 0.5, journey);
    expect(Array.from(out.light)).not.toEqual(Array.from(a.light));
    expect(Array.from(out.light)).not.toEqual(Array.from(b.light));
  });

  it("keeps the new-thread grid on the sidebar's lattice", () => {
    // The sidebar still draws MonitoringBackdrop; the creating pane now
    // paints the same field as a scene engine. Off by one and the two
    // lattices stop lining up at the pane border.
    const win = { x: 33, y: 0, width: 60, height: 20, fieldWidth: 93, fieldHeight: 20 };
    const frame = createFrame(win.width, win.height);
    createGridScene().paint(frame, win, 0, null);
    const expected = buildMonitoringGrid(win.width, win.height, win.x, win.y);
    for (let y = 0; y < win.height; y++) {
      for (let x = 0; x < win.width; x++) {
        const glyph = frame.glyph[y * win.width + x];
        if (expected[y]![x] === "·") expect(glyph === "·" || glyph === "•" || glyph === "+").toBe(true);
        else if (glyph === "·") throw new Error(`lattice dot off the sidebar's grid at ${x},${y}`);
      }
    }
  });
});
