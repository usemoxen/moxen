import { noise, smoothstep } from "./raster.js";

/** A folded curtain, sampled along the horizon and in pixels above it.
 * Field coordinates keep its fine rays continuous across pane boundaries.
 * Green gathers at the lower hem; violet fades out above it. */
export function aurora(along: number, height: number, t: number): number {
  if (height < 0 || height > 12) return 0;
  const fold = noise(along * 0.12 + t * 0.08, 19) * 2.8
    + Math.sin(along * 0.19 - t * 0.22) * 0.7;
  const hem = 1.1 + fold;
  const above = height - hem;
  const curtain = smoothstep(-0.8, 0.4, above) * Math.exp(-Math.max(0, above) / 2.1);
  const rays = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(along * 2.3 + fold * 2 + t * 0.45), 2);
  const patches = smoothstep(0.28, 0.72, noise(along * 0.09 - t * 0.035, 71));
  return curtain * rays * patches;
}
