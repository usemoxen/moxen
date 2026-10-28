import { FrameBufferRenderable, RGBA, type FrameBufferOptions, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { extend } from "@opentui/react";

import { SURFACE } from "../../theme.js";
import { createScene, type SceneId } from "./catalog.js";
import { createGridScene } from "./grid.js";
import { journeyBetween, journeyFrames, type Journey } from "./journey.js";
import {
  applyWell,
  blendFrames,
  clearFrame,
  composeCells,
  createCells,
  createFrame,
  type Cells,
  type Frame,
  type Pointer,
  type SceneEngine,
  type SceneWindow,
} from "./raster.js";

/**
 * The new-thread view's backdrop as one native renderable: the model's
 * scene, or the monitoring field (`"grid"`) for a model without one. A
 * scene paints light into a `Frame`, `composeCells` folds it into
 * half-blocks, and the result lives in this renderable's own
 * `OptimizedBuffer`. Every other render (a keystroke, a toast) only blits
 * that buffer — repainting happens on the scene clock alone, and React
 * never re-renders for motion.
 *
 * Switching models eases between backdrops: the new one blooms out from
 * the centre while the old one is still painted beneath it (`BLOOM_S`).
 * Between the OpenAI scenes — places in one neighbourhood of space — the
 * camera travels instead (`journey.ts`): a hop, a cruise or a warp jump.
 * Both scenes are painted for the length of the transition, then the old
 * one is let go.
 */

export type BackdropScene = SceneId | "grid";

/** The shared clock's period; each engine repaints on its own `frameMs` within it. */
const CLOCK_MS = 50;
/** `ui.backdrop: static` shows this instant (the grid's static frame is frame 0 too). */
const STATIC_T = 0;
const BLOOM_S = 1.4;

/** Pointer envelope (seconds): ease in, hold while moving, ease out. */
const POINTER_RISE = 0.35;
const POINTER_HOLD = 1.2;
const POINTER_FALL = 0.8;

const players = new Set<ModelSceneRenderable>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Wall-clock seconds: every engine paints a pure function of this, and the
 * grid engine's drifter frame must match the sidebar's `useAnimTick`
 * (`Date.now()`), so the two halves of the monitoring field stay one swarm.
 */
const seconds = (): number => Date.now() / 1000;

const pointer = { x: 0, y: 0, lastMove: -Infinity, since: -Infinity, smoothX: 0, smoothY: 0 };

/** Field pixel position of a screen cell's centre. */
function notePointer(cellX: number, cellY: number): void {
  const now = seconds();
  const x = cellX + 0.5;
  const y = cellY * 2 + 1;
  if (now - pointer.lastMove > POINTER_HOLD + POINTER_FALL) {
    // A fresh appearance starts where the pointer is, not where it left.
    pointer.since = now;
    pointer.smoothX = x;
    pointer.smoothY = y;
  }
  pointer.x = x;
  pointer.y = y;
  pointer.lastMove = now;
}

/** The pointer for this tick: it trails the cursor a little, like mass would. */
function pointerAt(now: number): Pointer | null {
  const idle = now - pointer.lastMove;
  if (idle > POINTER_HOLD + POINTER_FALL) return null;
  const rise = Math.min(1, (now - pointer.since) / POINTER_RISE);
  const fall = idle <= POINTER_HOLD ? 1 : 1 - (idle - POINTER_HOLD) / POINTER_FALL;
  pointer.smoothX += (pointer.x - pointer.smoothX) * 0.35;
  pointer.smoothY += (pointer.y - pointer.smoothY) * 0.35;
  const ease = (v: number) => v * v * (3 - 2 * v);
  return { x: pointer.smoothX, y: pointer.smoothY, strength: ease(rise) * ease(Math.max(0, fall)) };
}

/** One clock for every mounted pane: same `t`, same pointer, one render request. */
function tick(): void {
  const t = seconds();
  const at = pointerAt(t);
  let dirty: ModelSceneRenderable | null = null;
  for (const player of players) {
    if (player.advance(t, at)) dirty ??= player;
  }
  dirty?.requestRender();
}

function join(player: ModelSceneRenderable): void {
  players.add(player);
  timer ??= setInterval(tick, CLOCK_MS);
}

function leave(player: ModelSceneRenderable): void {
  players.delete(player);
  if (players.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function hexTriplet(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(clean.slice(i, i + 2), 16) / 255) as [number, number, number];
}

interface Layer {
  id: BackdropScene;
  engine: SceneEngine;
}

export interface ModelSceneOptions extends FrameBufferOptions {
  scene?: BackdropScene;
  motion?: "animated" | "static";
  /** Light gain: 1 for the empty creating view. */
  intensity?: number;
  /** The pane's own surface colour — light adds onto it. */
  base?: string;
  /** Darken an ellipse at the centre so overlaid text keeps its contrast. */
  well?: boolean;
}

export class ModelSceneRenderable extends FrameBufferRenderable {
  private layer: Layer | null = null;
  /** The backdrop being eased out, while a transition runs. */
  private leaving: Layer | null = null;
  private transitionStart = 0;
  /** How the running transition travels, or null for a bloom. */
  private journey: Journey | null = null;
  private transitionSeconds = BLOOM_S;
  private motionMode: "animated" | "static" = "animated";
  private gain = 1;
  private baseHex: string = SURFACE.base;
  private baseRgb: [number, number, number] = hexTriplet(SURFACE.base);
  private wellOn = false;
  private frame: Frame = createFrame(0, 0);
  private frameFrom: Frame = createFrame(0, 0);
  private frameTo: Frame = createFrame(0, 0);
  private cells: Cells = createCells(0, 0);
  private readonly fg = RGBA.fromValues(0, 0, 0, 1);
  private readonly bg = RGBA.fromValues(0, 0, 0, 1);
  private t = STATIC_T;
  private pointer: Pointer | null = null;
  private stale = true;
  private paintedKey = "";
  private lastFrameIndex = "";

  constructor(ctx: RenderContext, options: ModelSceneOptions) {
    super(ctx, { ...options, width: Math.max(1, options.width), height: Math.max(1, options.height) });
    this.selectable = false;
    this.onMouseMove = (event) => {
      if (this.motionMode === "animated") notePointer(event.x, event.y);
    };
    if (options.motion !== undefined) this.motionMode = options.motion;
    if (options.intensity !== undefined) this.intensity = options.intensity;
    if (options.base !== undefined) this.base = options.base;
    if (options.well !== undefined) this.well = options.well;
    this.syncClock();
    // Opening the view on a model with a scene blooms it in from the grid.
    if (options.scene !== undefined && options.scene !== "grid" && this.motionMode === "animated") {
      this.layer = this.layerFor("grid");
    }
    this.scene = options.scene ?? "grid";
  }

  private layerFor(id: BackdropScene): Layer {
    return { id, engine: id === "grid" ? createGridScene(this.baseHex) : createScene(id) };
  }

  /** 0..1 through the running transition; 1 when none runs. */
  private progress(): number {
    if (this.leaving === null) return 1;
    return Math.min(1, (this.t - this.transitionStart) / this.transitionSeconds);
  }

  set scene(id: BackdropScene) {
    if (this.layer?.id === id) return;
    const animated = this.motionMode === "animated" && this.layer !== null;
    if (!animated) {
      this.layer = this.layerFor(id);
      this.leaving = null;
    } else if (this.leaving?.id === id) {
      // Switching back mid-bloom reverses it from where it stands.
      // A journey turns round mid-flight the same way, heading back.
      const p = this.progress();
      [this.layer, this.leaving] = [this.leaving, this.layer];
      this.journey = journeyBetween(this.leaving!.id, this.layer!.id);
      this.transitionSeconds = this.journey?.seconds ?? BLOOM_S;
      this.transitionStart = this.t - (1 - p) * this.transitionSeconds;
    } else {
      this.leaving = this.layer;
      this.layer = this.layerFor(id);
      this.journey = journeyBetween(this.leaving!.id, id);
      this.transitionSeconds = this.journey?.seconds ?? BLOOM_S;
      this.transitionStart = this.t;
    }
    this.stale = true;
  }

  set motion(mode: "animated" | "static") {
    if (mode === this.motionMode) return;
    this.motionMode = mode;
    this.leaving = null;
    this.syncClock();
  }

  set intensity(value: number) {
    this.gain = value;
    this.stale = true;
  }

  set base(hex: string) {
    if (hex === this.baseHex) return;
    this.baseHex = hex;
    this.baseRgb = hexTriplet(hex);
    if (this.layer?.id === "grid") this.layer = this.layerFor("grid");
    this.stale = true;
  }

  set well(on: boolean) {
    this.wellOn = on;
    this.stale = true;
  }

  private syncClock(): void {
    if (this.isDestroyed) return;
    if (this.motionMode === "animated") {
      join(this);
      this.t = seconds();
    } else {
      leave(this);
      this.t = STATIC_T;
      this.pointer = null;
    }
    this.stale = true;
  }

  /**
   * Called by the shared clock. Returns whether this pane needs a repaint:
   * always mid-transition, otherwise only when one of its engines reaches
   * a new frame — the grid changes every 150 ms, a scene every 50.
   */
  advance(t: number, at: Pointer | null): boolean {
    this.t = t;
    this.pointer = at;
    if (this.leaving !== null && this.progress() >= 1) this.leaving = null;
    const index = [this.layer, this.leaving]
      .map((layer) => (layer === null ? "" : Math.floor((t * 1000) / layer.engine.frameMs)))
      .join(":");
    const moving = this.leaving !== null || index !== this.lastFrameIndex || at !== null;
    this.lastFrameIndex = index;
    if (moving) this.stale = true;
    return moving;
  }

  protected override onResize(width: number, height: number): void {
    // Yoga can hand a collapsing pane 0×0; the native buffer refuses that.
    if (width <= 0 || height <= 0) return;
    super.onResize(width, height);
    this.stale = true;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return;
    const width = this.frameBuffer.width;
    const height = this.frameBuffer.height;
    // The field is the terminal: this pane's window starts at its own
    // screen position, so a moved or resized pane repaints itself.
    const key = `${this.x},${this.y},${width},${height},${this.ctx.width},${this.ctx.height}`;
    if (this.layer !== null && (this.stale || key !== this.paintedKey)) {
      this.paint(width, height);
      this.paintedKey = key;
      this.stale = false;
    }
    super.renderSelf(buffer);
  }

  private paint(width: number, height: number): void {
    if (this.frame.width !== width || this.frame.height !== height) {
      this.frame = createFrame(width, height);
      this.frameFrom = createFrame(width, height);
      this.frameTo = createFrame(width, height);
      this.cells = createCells(width, height);
    }
    const win: SceneWindow = { x: this.x, y: this.y, width, height, fieldWidth: this.ctx.width, fieldHeight: this.ctx.height };
    const p = this.progress();
    if (this.leaving !== null && p < 1) {
      clearFrame(this.frameFrom);
      clearFrame(this.frameTo);
      this.leaving.engine.paint(this.frameFrom, win, this.t, this.pointer);
      this.layer!.engine.paint(this.frameTo, win, this.t, this.pointer);
      if (this.journey !== null) {
        // The scenery travels, the composer does not: the well goes on after.
        journeyFrames(this.frameFrom, this.frameTo, this.frame, p, this.journey);
        this.applyWellTo(this.frame, this.layer!.id);
      } else {
        this.applyWellTo(this.frameFrom, this.leaving.id);
        this.applyWellTo(this.frameTo, this.layer!.id);
        blendFrames(this.frameFrom, this.frameTo, this.frame, p);
      }
    } else {
      clearFrame(this.frame);
      this.layer!.engine.paint(this.frame, win, this.t, this.pointer);
      this.applyWellTo(this.frame, this.layer!.id);
    }
    composeCells(this.frame, this.baseRgb, this.gain, this.cells);
    const { ch, fg, bg } = this.cells;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const o = i * 3;
        this.fg.r = fg[o]!;
        this.fg.g = fg[o + 1]!;
        this.fg.b = fg[o + 2]!;
        this.bg.r = bg[o]!;
        this.bg.g = bg[o + 1]!;
        this.bg.b = bg[o + 2]!;
        this.frameBuffer.setCell(x, y, ch[i]!, this.fg, this.bg);
      }
    }
  }

  /** Per layer, before blending: the monitoring field is already faint, so only scenes get the well. */
  private applyWellTo(frame: Frame, id: BackdropScene): void {
    if (!this.wellOn || id === "grid") return;
    // Sized to the whole foreground column — the title above the card, the
    // card, and the hint below it: a well that stopped at the card left the
    // hint over raw scenery, unreadable on a bright frame.
    applyWell(frame, frame.width / 2, frame.height / 2, Math.min(58, frame.width * 0.5), Math.min(20, frame.height * 0.48), 0.3);
  }

  protected override destroySelf(): void {
    leave(this);
    super.destroySelf();
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    modelScene: typeof ModelSceneRenderable;
  }
}

extend({ modelScene: ModelSceneRenderable });

/**
 * The new-thread view's backdrop. Placed absolutely (content-box relative)
 * like `MonitoringBackdrop`; unmounting is what stops it — the clock runs
 * only while a pane shows it.
 */
export function SceneBackdrop({
  scene,
  width,
  height,
  left = 0,
  top = 0,
  intensity = 1,
  base = SURFACE.base,
  well = false,
  motion = "animated",
}: {
  scene: BackdropScene;
  width: number;
  height: number;
  left?: number;
  top?: number;
  intensity?: number;
  base?: string;
  well?: boolean;
  motion?: "animated" | "static";
}) {
  if (width <= 0 || height <= 0) return null;
  return (
    <modelScene
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      scene={scene}
      intensity={intensity}
      base={base}
      well={well}
      motion={motion}
    />
  );
}
