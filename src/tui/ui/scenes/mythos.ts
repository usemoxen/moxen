import { createPlateScene, type Layout, type RGB, type Species } from "./lepidoptera.js";
import { noise } from "./raster.js";
import type { SceneEngine } from "./raster.js";

/**
 * Mythos 5.1 — the same model as Fable without its guardrails, so the
 * same plate, unpinned and at night.
 *
 * The specimens are the moths of myth and omen: the luna moth, the
 * atlas, the death's-head hawkmoth with a skull on its back, emperor
 * moths staring out of their eyespots, the rosy maple, pale ghost moths.
 * They glow, each in a halo, shedding luminous scale-dust as they fly.
 * They still gather into the 5, but restlessly — hovering, fanning — and
 * while it holds, faint threads of light join neighbour to neighbour
 * like a constellation.
 *
 * No guardrails for the lamp either: under the pointer, everything comes
 * to the light, not only the moths.
 */

const SPECIES: readonly Species[] = [
  {
    // Luna moth: pale green, a purple-brown leading edge, eyespots, long tails.
    size: 11,
    moth: true,
    tail: 0.55,
    glow: [0.5, 1.0, 0.62],
    paint: (u, v, fore) => {
      if (fore && v < -0.36) return [0.46, 0.3, 0.4];
      if (Math.hypot(u - (fore ? 0.55 : 0.45), v - (fore ? -0.1 : 0.32)) < 0.08) return [0.9, 0.78, 0.42];
      return [0.62, 0.92, 0.62];
    },
  },
  {
    // Atlas moth: rust, with pale windows and a pale band toward the margin.
    size: 13,
    moth: true,
    glow: [1.0, 0.55, 0.3],
    paint: (u, v, fore) => {
      if (Math.hypot(u - 0.5, v - (fore ? -0.12 : 0.3)) < 0.07) return [0.96, 0.92, 0.86];
      if (u > 0.78 && u < 0.86) return [0.86, 0.72, 0.56];
      return [0.6, 0.27, 0.14];
    },
  },
  {
    // Death's-head hawkmoth: dark mottled forewings, yellow hindwings banded black — and the skull.
    size: 10,
    moth: true,
    narrow: true,
    glow: [1.0, 0.82, 0.3],
    body: (v) => (v > -0.42 && v < -0.12 ? [0.9, 0.82, 0.5] : v > 0.1 && Math.sin(v * 30) > 0 ? [0.8, 0.65, 0.2] : [0.12, 0.1, 0.08]),
    paint: (u, v, fore) => {
      if (fore) return Math.sin(u * 11 + v * 7) > 0.6 ? [0.4, 0.34, 0.26] : [0.2, 0.17, 0.13];
      return Math.abs(Math.sin(u * 8)) < 0.25 ? [0.12, 0.1, 0.08] : [0.95, 0.76, 0.22];
    },
  },
  {
    // Emperor moth: grey-brown, an eyespot staring from every wing.
    size: 9,
    moth: true,
    glow: [0.95, 0.72, 0.52],
    paint: (u, v, fore) => {
      const d = Math.hypot(u - (fore ? 0.55 : 0.42), v - (fore ? -0.15 : 0.35));
      if (d < 0.05) return [0.95, 0.95, 0.9];
      if (d < 0.1) return [0.08, 0.06, 0.06];
      if (d < 0.14) return [0.92, 0.55, 0.2];
      return [0.56, 0.49, 0.43];
    },
  },
  {
    // Rosy maple moth: pink, banded with butter yellow.
    size: 5.5,
    moth: true,
    glow: [1.0, 0.5, 0.72],
    paint: (_u, v) => (Math.abs(v + 0.05) < 0.14 ? [0.98, 0.86, 0.38] : [0.96, 0.46, 0.62]),
  },
  {
    // Ghost moth: narrow, silver-white.
    size: 7,
    moth: true,
    narrow: true,
    glow: [0.78, 0.84, 1.0],
    paint: () => [0.9, 0.92, 0.96],
  },
];

const SEED = 0x3770;

/** Night: deep blue-black, a slow mist, a violet hush behind where the 5 forms. */
function night(x: number, y: number, t: number, g: Layout, out: Float32Array, o: number): void {
  const mist = Math.max(0, noise(x * 0.04 + t * 0.03, y * 0.05 - t * 0.01) - 0.45) * 0.09;
  const hush = Math.exp(-Math.pow((x - (g.left + g.width / 2)) / (g.width * 0.9), 2) - Math.pow((y - (g.top + g.height / 2)) / (g.height * 0.7), 2)) * 0.06;
  out[o] = 0.012 + mist * 0.5 + hush * 0.55;
  out[o + 1] = 0.015 + mist * 0.7 + hush * 0.4;
  out[o + 2] = 0.04 + mist * 1.0 + hush * 1.0;
}

export function createMythosScene(): SceneEngine {
  return createPlateScene({
    seed: SEED,
    species: SPECIES,
    count: 24,
    ground: night,
    glow: 1,
    lamp: "all",
    lampLight: [1.0, 0.78, 0.48],
    numbers: false,
    threads: true,
    restless: 1.6,
    fan: [0.55, 0.45],
  });
}
