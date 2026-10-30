/**
 * The chips a person's message carries: an attached image reads `[Image #N]`
 * in it, an attached file or folder `[📄 name](<path>)`, and the transcript
 * draws both as the filled chips the composer shows rather than as links.
 * Pure, so the splitting is tested without a terminal.
 */

const CHIP = /\[Image #?\d+\]|⟦Image#\d+⟧|\[(?:📄|📁) [^\]\n]+\]\((?:<[^>\n]*>|[^)\s]*)\)/gu;
const PATH_CHIP = /^\[((?:📄|📁) [^\]\n]+)\]\(.*\)$/u;

export type Segment = { text: string; chip: boolean };

/** A line's text and chips in order, a chip as the words it shows (` 📄 name ` padded, `[Image #1]` as it is). */
export function chipSegments(line: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of line.matchAll(CHIP)) {
    if (match.index === undefined) continue;
    if (match.index > last) out.push({ text: line.slice(last, match.index), chip: false });
    const path = PATH_CHIP.exec(match[0]);
    out.push({ text: path === null ? match[0] : ` ${path[1]} `, chip: true });
    last = match.index + match[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), chip: false });
  return out;
}

export type Block = { kind: "markdown"; text: string } | { kind: "chips"; text: string };

/**
 * The message cut into what markdown draws and the paragraphs that hold a
 * chip, which are drawn as styled text so the chips can be filled. A
 * paragraph is a run of lines outside a code fence; the rest stays in one
 * markdown block, so everything but those paragraphs reads as before.
 */
export function splitChipBlocks(text: string): Block[] {
  if (!CHIP.test(text)) {
    CHIP.lastIndex = 0;
    return [{ kind: "markdown", text }];
  }
  CHIP.lastIndex = 0;
  const blocks: Block[] = [];
  const push = (kind: Block["kind"], value: string) => {
    const previous = blocks.at(-1);
    if (kind === "markdown" && previous?.kind === "markdown") previous.text += `\n${value}`;
    else blocks.push({ kind, text: value });
  };
  let fence = false;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join("\n");
    push(chipSegments(joined).some((segment) => segment.chip) ? "chips" : "markdown", joined);
    paragraph = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      if (!fence) flush();
      fence = !fence;
      push("markdown", line);
      continue;
    }
    if (fence) {
      push("markdown", line);
    } else if (line.trim().length === 0) {
      flush();
      push("markdown", line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}
