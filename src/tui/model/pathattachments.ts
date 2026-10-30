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
}

/** A path as a person would write it in a prompt: quoted when a space or a quote would otherwise split or end it. */
export function quotePath(value: string): string {
  return /[\s"'`]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

/** The prompt with the attached paths after it, one per line, kind first. Empty list: the prompt as it was. */
export function promptWithPaths(prompt: string, items: readonly PathAttachment[]): string {
  if (items.length === 0) return prompt;
  const lines = items.map((item) => `- ${item.kind}: ${quotePath(item.path)}`);
  return `${prompt}${prompt.length === 0 ? "" : "\n\n"}Attached paths:\n${lines.join("\n")}`;
}

export function pathIcon(kind: PathKind): string {
  return kind === "folder" ? "📁" : "📄";
}

/** What a chip calls an attachment: its last path segment (a drive root or `/` has none, so it reads whole). */
export function pathLabel(item: PathAttachment): string {
  return path.basename(item.path) || item.path;
}

/** `incoming` added to `current`, a path already attached left where it was. */
export function addPaths(current: readonly PathAttachment[], incoming: readonly PathAttachment[]): PathAttachment[] {
  const seen = new Set(current.map((item) => item.path));
  const added: PathAttachment[] = [];
  for (const item of incoming) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    added.push(item);
  }
  return [...current, ...added];
}
