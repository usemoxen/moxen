import { runWalkthrough } from "./render-check/walkthrough.js";

/**
 * Snapshot harness: drives the app with a mock client, scripts input,
 * captures char frames. No live terminal needed. The scripted walkthrough
 * lives in `render-check/walkthrough.tsx`; `bun src/tui/render-check.tsx`
 * runs it.
 */
await runWalkthrough();

process.exit(0);
