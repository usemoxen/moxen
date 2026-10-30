/**
 * The `moxen-ui` block a reply can carry: a fenced block of JSON that lays
 * images (and a little text) out as rows, columns and grids. The model fills
 * in this schema and nothing in it is evaluated. Pure and total, so the
 * TUI and the desktop app read the same blocks and a bad one never throws.
 *
 * A block that is not valid, not understood (a newer `v`, an unknown node
 * type) or over a cap is not a block: `splitUiBlocks` leaves its fence in
 * the markdown, where it reads as the code it is. A fence still open (a
 * reply that is streaming) stays code the same way until it closes.
 *
 * Unknown *fields* are ignored, so a later version can add a field without
 * breaking a client that has not learned it. The pixel cap lives where an
 * image's size is known (the layout), not here.
 */

export const UI_BLOCK_LANGUAGE = "moxen-ui";
export const UI_BLOCK_VERSION = 1;

/** What a block may hold, so a reply cannot ask the client to draw without limit. */
export const UI_BLOCK_LIMITS = {
  /** Characters of JSON. */
  bytes: 16_000,
  /** Containers inside containers; the root is depth 1. */
  depth: 4,
  nodes: 40,
  images: 8,
  /** Children of one container. */
  children: 12,
  /** Columns of a grid. */
  columns: 6,
  /** Image operations on one image (what they are is `image operations`' to say). */
  ops: 8,
  /** Characters of one text, caption, alt or path. */
  text: 2_000,
} as const;

/** An image operation as the block carries it: validated only as far as its name; the layout owns the rest. */
export type UiOp = { op: string } & Record<string, unknown>;

interface UiBase {
  /** The share of a row's or column's space this child takes (default 1). */
  weight?: number;
  /** How many columns of a grid this child covers (default 1). */
  span?: number;
}

export type UiNode =
  | (UiBase & { type: "row" | "column"; gap: number; children: UiNode[] })
  | (UiBase & { type: "grid"; columns: number; gap: number; children: UiNode[] })
  | (UiBase & { type: "image"; src: string; alt: string; caption?: string; ops: UiOp[] })
  | (UiBase & { type: "text" | "caption"; text: string });

export interface UiBlock {
  v: typeof UI_BLOCK_VERSION;
  root: UiNode;
}

export type UiSegment = { kind: "markdown"; text: string } | { kind: "ui"; block: UiBlock };

/** True for a path on this machine: not a URL (`https:`, `data:`, `moxen-context:`) whose bytes are not the server's to read. */
export function isLocalPath(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//iu.test(target) && !/^(?:data|moxen-context|mailto):/iu.test(target);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Reject extends Error {}

function reject(): never {
  throw new Reject();
}

interface Count {
  nodes: number;
  images: number;
}

function text(value: unknown, required: boolean): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > UI_BLOCK_LIMITS.text) reject();
  return value;
}

function whole(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) reject();
  return value;
}

function node(value: unknown, depth: number, count: Count): UiNode {
  if (!isRecord(value)) reject();
  if (++count.nodes > UI_BLOCK_LIMITS.nodes) reject();
  const base: UiBase = {};
  if (value.weight !== undefined) {
    if (typeof value.weight !== "number" || !(value.weight > 0) || value.weight > 12) reject();
    base.weight = value.weight;
  }
  if (value.span !== undefined) base.span = whole(value.span, 1, UI_BLOCK_LIMITS.columns, 1);
  switch (value.type) {
    case "row":
    case "column":
      return { ...base, type: value.type, gap: whole(value.gap, 0, 4, 1), children: children(value, depth, count) };
    case "grid": {
      const columns = whole(value.columns, 1, UI_BLOCK_LIMITS.columns, 2);
      const built = children(value, depth, count);
      if (built.some((child) => (child.span ?? 1) > columns)) reject();
      return { ...base, type: "grid", columns, gap: whole(value.gap, 0, 4, 1), children: built };
    }
    case "image": {
      if (++count.images > UI_BLOCK_LIMITS.images) reject();
      const src = text(value.src, true);
      if (src.trim().length === 0 || !isLocalPath(src)) reject();
      const caption = value.caption === undefined ? undefined : text(value.caption, true);
      return { ...base, type: "image", src, alt: text(value.alt, false), ...(caption === undefined ? {} : { caption }), ops: ops(value.ops) };
    }
    case "text":
    case "caption":
      return { ...base, type: value.type, text: text(value.text, true) };
    default:
      return reject();
  }
}

function children(parent: Record<string, unknown>, depth: number, count: Count): UiNode[] {
  if (depth >= UI_BLOCK_LIMITS.depth) reject();
  const list = parent.children;
  if (!Array.isArray(list) || list.length === 0 || list.length > UI_BLOCK_LIMITS.children) reject();
  return list.map((child) => node(child, depth + 1, count));
}

function ops(value: unknown): UiOp[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > UI_BLOCK_LIMITS.ops) reject();
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.op !== "string" || entry.op.length === 0) reject();
    return entry as UiOp;
  });
}

/** The block a JSON text describes, or null when it is not valid, not understood or over a cap. Never throws. */
export function parseUiBlock(json: string): UiBlock | null {
  if (json.length > UI_BLOCK_LIMITS.bytes) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || value.v !== UI_BLOCK_VERSION) return null;
    const count: Count = { nodes: 0, images: 0 };
    return { v: UI_BLOCK_VERSION, root: node(value.root, 1, count) };
  } catch {
    return null;
  }
}

const OPENING = new RegExp(`^\\s{0,3}(\`{3,}|~{3,})\\s*${UI_BLOCK_LANGUAGE}\\s*$`, "u");
const ANY_OPENING = /^\s{0,3}(`{3,}|~{3,})/u;

/** The line that ends a fence opened with `fence`: the same character, at least as many. */
const fenceCloser = (fence: string): RegExp => new RegExp(`^\\s{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`, "u");

/**
 * A reply cut into its markdown and its `moxen-ui` blocks, in order. Only a
 * block at the top level counts (one inside another code fence is an example
 * the model is showing). A block that does not parse, or whose fence never
 * closes, stays in the markdown as it was written.
 */
export function splitUiBlocks(source: string): UiSegment[] {
  if (!source.includes(UI_BLOCK_LANGUAGE)) return [{ kind: "markdown", text: source }];
  const lines = source.split("\n");
  const segments: UiSegment[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) segments.push({ kind: "markdown", text: pending.join("\n") });
    pending = [];
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    const fence = ANY_OPENING.exec(line)?.[1];
    if (fence === undefined) {
      pending.push(line);
      at++;
      continue;
    }
    const closer = fenceCloser(fence);
    let end = at + 1;
    while (end < lines.length && !closer.test(lines[end]!)) end++;
    const closed = end < lines.length;
    const block = closed && OPENING.test(line) ? parseUiBlock(lines.slice(at + 1, end).join("\n")) : null;
    if (block !== null) {
      flush();
      segments.push({ kind: "ui", block });
    } else {
      // Code: another language's fence, a block that is not valid, or one still open. A moxen-ui line inside it is not a block.
      pending.push(...lines.slice(at, closed ? end + 1 : lines.length));
    }
    at = closed ? end + 1 : lines.length;
  }
  flush();
  return segments;
}
