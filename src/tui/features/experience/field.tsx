import { FrameBufferRenderable, RGBA, type FrameBufferOptions, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { extend } from "@opentui/react";
import { isTerminalVisible, subscribeTerminalVisibility } from "../../hooks/useTerminalVisible.js";
import { COLOR, SURFACE } from "../../theme.js";

interface FieldOptions extends FrameBufferOptions {
  motion?: "animated" | "static";
  base?: string;
  ink?: string;
  stage?: number;
}
const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);

/** A loom of six travelling threads, drawn on its own clock, outside React. */
class WelcomeField extends FrameBufferRenderable {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unwatch: (() => void) | null = null;
  private moving = false;
  private dirty = true;
  private time = 12;
  private baseRgb = rgb(SURFACE.base);
  private inkRgb = rgb(COLOR.accent);
  private page = 0;
  private readonly fg = RGBA.fromValues(0, 0, 0, 1);
  private readonly bg = RGBA.fromValues(0, 0, 0, 1);

  constructor(ctx: RenderContext, options: FieldOptions) {
    super(ctx, options);
    this.selectable = false;
    this.base = options.base ?? SURFACE.base;
    this.ink = options.ink ?? COLOR.accent;
    this.stage = options.stage ?? 0;
    this.unwatch = subscribeTerminalVisibility(() => this.clock());
    this.motion = options.motion ?? "animated";
  }
  set base(value: string) { this.baseRgb = rgb(value); this.dirty = true; this.requestRender(); }
  set ink(value: string) { this.inkRgb = rgb(value); this.dirty = true; this.requestRender(); }
  set stage(value: number) { this.page = value; this.dirty = true; this.requestRender(); }
  set motion(value: "animated" | "static") { this.moving = value === "animated"; this.time = 12; this.dirty = true; this.clock(); }
  private clock() {
    if (this.moving && isTerminalVisible() && !this.isDestroyed) {
      this.timer ??= setInterval(() => { this.time += 0.1; this.dirty = true; this.requestRender(); }, 100);
    } else if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }
  protected override onResize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    super.onResize(width, height);
    this.dirty = true;
  }
  protected override renderSelf(buffer: OptimizedBuffer) {
    if (this.dirty) {
      const width = this.frameBuffer.width;
      const height = this.frameBuffer.height;
      for (let x = 0; x < width; x++) {
        const u = x / Math.max(1, width - 1);
        // Only the step's own thread carries light and a travelling pulse; the
        // others hold a steady, quiet line, so a step change is legible.
        const curves = Array.from({ length: 6 }, (_, i) => {
          const active = i === this.page;
          return {
            y: height * (0.1 + i * 0.145 + this.page * 0.02 + Math.sin(u * 4 + i * 0.6 + this.time * 0.06 + this.page * 0.7) * 0.05),
            gain: active ? 0.5 : 0.08,
            pulse: active ? Math.exp(-Math.pow((u - ((this.time * 0.15) % 1)) * 10, 2)) : 0,
          };
        });
        for (let y = 0; y < height; y++) {
          const light = (at: number) => curves.reduce((sum, curve) => sum + Math.exp(-Math.pow((at - curve.y) * 2, 2)) * curve.gain * (0.6 + curve.pulse), 0);
          const top = Math.min(0.65, light(y));
          const bottom = Math.min(0.65, light(y + 0.5));
          for (const [channel, index] of [["r", 0], ["g", 1], ["b", 2]] as const) {
            const base = this.baseRgb[index]!;
            const ink = this.inkRgb[index]!;
            this.fg[channel] = base + (ink - base) * top;
            this.bg[channel] = base + (ink - base) * bottom;
          }
          this.frameBuffer.setCell(x, y, "▀", this.fg, this.bg);
        }
      }
      this.dirty = false;
    }
    super.renderSelf(buffer);
  }
  protected override destroySelf() {
    if (this.timer !== null) clearInterval(this.timer);
    this.unwatch?.();
    super.destroySelf();
  }
}
declare module "@opentui/react" { interface OpenTUIComponents { welcomeField: typeof WelcomeField } }
extend({ welcomeField: WelcomeField });

export function ExperienceField({ width, height, stage, motion, ink }: { width: number; height: number; stage: number; motion: "animated" | "static" | "off"; ink?: string }) {
  if (motion === "off") return null;
  return <welcomeField id="experience-field" width={width} height={height} stage={stage} motion={motion} base={SURFACE.base} ink={ink ?? COLOR.accent} position="absolute" left={0} top={0} />;
}
