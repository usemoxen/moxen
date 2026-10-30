import type { SceneId } from "../../ui/scenes/catalog.js";
import { SceneBackdrop } from "../../ui/scenes/scenebackdrop.js";
import { LOOP as VOYAGE_SECONDS, destinationIndex } from "../../ui/scenes/astra.js";
import { splashStart } from "../../ui/scenes/haiku.js";
import { COMET_SECONDS, cometStart } from "../../ui/scenes/opus.js";
import { ERUPTION_SECONDS, eruptionStart } from "../../ui/scenes/sol.js";
import { Stage, type GalleryEntry } from "./registry.js";

/**
 * Each model's backdrop at the moments of its loop worth seeing. A scene is a
 * pure function of time, so a moment is just the instant to freeze it at
 * (`SceneBackdrop`'s `at`). Scenes that follow the wall clock (the season,
 * the Moon's phase, the Earth's face) are given a date.
 */
interface Moment {
  name: string;
  at: number;
}

const DAY = 86_400;
const epoch = (year: number, month: number, day: number, hour = 12): number => Date.UTC(year, month, day, hour) / 1000;

/** First slot, from 0, for which `start` has a moment, and the moment's instant. */
function firstSlot(start: (slot: number) => number | null): number {
  for (let slot = 0; slot < 200; slot++) {
    const at = start(slot);
    if (at !== null) return at;
  }
  throw new Error("no slot with a moment");
}

/** A voyage that ends at kind `index` of Astra's destinations. */
function voyageTo(index: number): number {
  for (let voyage = 1; voyage < 500; voyage++) if (destinationIndex(voyage) === index) return voyage;
  throw new Error(`no voyage ends at destination ${index}`);
}

/** New Moon nearest `around`, then each quarter after it (the Moon's own cycle: 29.530588 days). */
function moonPhases(around: number): Moment[] {
  const synodic = 29.530588 * DAY;
  const newMoon = epoch(2000, 0, 6, 18) + 14 * 60;
  const cycle = Math.round((around - newMoon) / synodic);
  const start = newMoon + cycle * synodic;
  return [
    { name: "new", at: start },
    { name: "first-quarter", at: start + synodic / 4 },
    { name: "full", at: start + synodic / 2 },
    { name: "last-quarter", at: start + (3 * synodic) / 4 },
  ];
}

const AUTUMN_DAY = epoch(2026, 9, 15);
const SUMMER_DAY = epoch(2026, 6, 15);
const TODAY = epoch(2026, 9, 29);

const KINDS = ["blue-white-star", "sun", "red-giant", "binary", "pulsar"] as const;

const MOMENTS: Record<SceneId, Moment[]> = {
  haiku: [
    { name: "spring", at: epoch(2026, 3, 15) },
    { name: "summer", at: SUMMER_DAY },
    { name: "autumn", at: AUTUMN_DAY },
    { name: "winter", at: epoch(2026, 0, 15) },
    { name: "splash", at: splashStart(Math.floor(SUMMER_DAY / 24)) + 1.2 },
  ],
  sonnet: [
    { name: "first-line", at: 1.5 },
    { name: "sixth-line", at: 19.5 },
    { name: "volta", at: 40.5 },
  ],
  opus: [
    { name: "galaxy", at: 0 },
    { name: "comet", at: firstSlot(cometStart) + COMET_SECONDS * 0.5 },
  ],
  // The plate settled into the 5: the part of the loop both are known for.
  fable: [{ name: "the-5", at: 23 }],
  mythos: [{ name: "the-5", at: 23 }],
  astra: [
    { name: "cruise", at: 10 },
    { name: "spool-up", at: 26.5 },
    { name: "the-jump", at: 32 },
    { name: "drop-out", at: VOYAGE_SECONDS + 0.4 },
    ...KINDS.map((name, index): Moment => ({ name: `arrive-${name}`, at: voyageTo(index) * VOYAGE_SECONDS + 20 })),
    // A pulsar's beams sweep; a second instant a moment later shows them elsewhere.
    { name: "arrive-pulsar-beams-swept", at: voyageTo(4) * VOYAGE_SECONDS + 20.9 },
  ],
  sol: [
    { name: "the-sun", at: 0 },
    { name: "eruption", at: firstSlot(eruptionStart) + ERUPTION_SECONDS * 0.4 },
  ],
  terra: [
    { name: "day-side", at: TODAY },
    { name: "twelve-hours-later", at: TODAY + 0.5 * DAY },
  ],
  luna: moonPhases(TODAY),
};

export const SCENE_GALLERY: GalleryEntry[] = (Object.keys(MOMENTS) as SceneId[]).flatMap((scene) =>
  MOMENTS[scene].map(
    (moment): GalleryEntry => ({
      id: MOMENTS[scene].length === 1 ? `ui-scene-${scene}` : `ui-scene-${scene}-${moment.name}`,
      group: "scenes",
      title: `Model backdrop: ${scene}, ${moment.name}`,
      width: 80,
      height: 20,
      element: () => (
        <Stage width={80} height={20}>
          <SceneBackdrop scene={scene} width={80} height={20} motion="static" at={moment.at} />
        </Stage>
      ),
    }),
  ),
);
