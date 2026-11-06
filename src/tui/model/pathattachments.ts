/**
 * Files and folders attached to a message: nothing is uploaded, the prompt
 * carries their absolute paths (the agent reads the disk itself). The pure
 * parts: how a path reads in the prompt, and the chip that shows it.
 */
import path from "node:path";

export type PathKind = "file" | "folder";

export interface PathAttachment {
  /** Absolute. */
  path: string;
  kind: PathKind;
  /**
   * What the draft shows for it, ` 📄 name ` with a space of padding each side so the chip's fill has
   * gutters: unique among the draft's attachments, since the message is put together by it.
   */
  label: string;
}

/** A path as a person would write it in a prompt: quoted when a space or a quote would otherwise split or end it. */
export function quotePath(value: string): string {
  return /[\s"'`]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

/** A link destination: angle-bracketed when the path has a space or a parenthesis, which would end it. */
function linkDestination(value: string): string {
  return /[\s()<>]/u.test(value) ? `<${value}>` : value;
}

/**
 * The draft as the agent gets it: each attachment's chip replaced, where it
 * stands, by a link whose text is the chip and whose target is the absolute
 * path: "Look at 📄 a.py" reads "Look at [📄 a.py](/home/me/a.py)". The agent
 * reads the path; the transcript draws the chip (`model/messagechips.ts`).
 */
export function promptWithPaths(prompt: string, items: readonly PathAttachment[]): string {
  let out = prompt;
  // Longest label first: ` 📄 a.py ` is the start of ` 📄 a.py (2) `.
  for (const item of [...items].sort((a, b) => b.label.length - a.label.length)) {
    const bare = item.label.trim();
    const at = lastChipOccurrence(out, bare);
    if (at === -1) continue;
    // The padding is the chip's own: a fully padded chip gives one space
    // each side back (as before), while a chip first or last in the draft
    // lost its outer space to the trim before sending and keeps what is there.
    const padded = at > 0 && out[at - 1] === " " && at + bare.length < out.length && out[at + bare.length] === " ";
    const start = padded ? at - 1 : at;
    const end = padded ? at + bare.length + 1 : at + bare.length;
    out = `${out.slice(0, start)}[${bare}](${linkDestination(item.path)})${out.slice(end)}`;
  }
  return out;
}

/**
 * Where the chip stands: the last `bare` occurrence with a word edge each
 * side (the draft's start or end, or a space) — text the person typed
 * earlier that merely looks like the chip reads as an earlier occurrence,
 * so from the end the chip wins. An already-placed link never qualifies:
 * its text opens with `[`, not an edge.
 */
function lastChipOccurrence(out: string, bare: string): number {
  let at = out.length;
  for (;;) {
    const found = out.lastIndexOf(bare, at);
    if (found === -1) return -1;
    const before = found === 0 ? "" : out[found - 1];
    const after = found + bare.length >= out.length ? "" : out[found + bare.length];
    if ((before === "" || before === " ") && (after === "" || after === " ")) return found;
    if (found === 0) return -1;
    at = found - 1;
  }
}

export function pathIcon(kind: PathKind): string {
  return kind === "folder" ? "📁" : "📄";
}

/** What a chip calls an attachment: its last path segment (a drive root or `/` has none, so it reads whole). */
export function pathLabel(item: Pick<PathAttachment, "path">): string {
  return path.basename(item.path) || item.path;
}

/**
 * The picked paths attached to `current`, each with its label (`📄 name`, with
 * ` (2)` and so on when that name is taken). A path already attached stays as it was.
 */
export function addPaths(current: readonly PathAttachment[], incoming: readonly Omit<PathAttachment, "label">[]): PathAttachment[] {
  const out = [...current];
  for (const item of incoming) {
    if (out.some((existing) => existing.path === item.path)) continue;
    const base = `${pathIcon(item.kind)} ${pathLabel(item)}`;
    let label = ` ${base} `;
    for (let counter = 2; out.some((existing) => existing.label === label); counter += 1) label = ` ${base} (${counter}) `;
    out.push({ ...item, label });
  }
  return out;
}
