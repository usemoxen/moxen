/**
 * read, edit and write. The rules that matter live here and not in the
 * prompt: an edit is only accepted against content the model has actually
 * read and that has not changed since, `old_string` must match exactly once
 * (or `replace_all` is set), and a payload that stands in for code the model
 * did not write ("// ... rest of file") is refused instead of saved.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessTool, ToolContext, ToolResult } from "./types.js";

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_CHARS = 80_000;
const MAX_LIST_ENTRIES = 200;
/** Endpoints refuse pictures much past this, and the base64 text is a third bigger again. */
export const MAX_IMAGE_BYTES = 5_000_000;

const IMAGE_TYPES: Readonly<Record<string, { mime: string; matches: (head: Buffer) => boolean }>> = {
  ".png": { mime: "image/png", matches: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  ".jpg": { mime: "image/jpeg", matches: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  ".jpeg": { mime: "image/jpeg", matches: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  ".gif": { mime: "image/gif", matches: (head) => head.subarray(0, 4).toString("latin1") === "GIF8" },
  ".webp": { mime: "image/webp", matches: (head) => head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" },
};

/** An image file, handed to the model as a picture when it can see one; null when `file` is not an image by name and content. */
function readImage(file: string, buffer: Buffer, context: ToolContext): ToolResult | null {
  const kind = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!kind || !kind.matches(buffer)) return null;
  const size = `${Math.max(1, Math.round(buffer.length / 1024))} KB`;
  if (context.acceptsImages !== true) {
    return { content: `${file} is a ${kind.mime} image (${size}). The current model cannot be shown pictures, so its contents cannot be read here.` };
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return fail(`${file} is a ${size} image, over the ${MAX_IMAGE_BYTES / 1_000_000} MB limit for pictures. Shrink or crop it first, then read it again.`);
  }
  return { content: `${file} is a ${kind.mime} image (${size}); it is attached below.`, images: [{ name: path.basename(file), mimeType: kind.mime, data: buffer.toString("base64") }] };
}

export function resolveToolPath(cwd: string, given: string): string {
  const trimmed = given.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(1));
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

const sha = (buffer: Buffer | string): string => createHash("sha256").update(buffer).digest("hex");

const fail = (content: string): ToolResult => ({ content, isError: true });

function numbered(lines: readonly string[], firstLine: number): string {
  return lines
    .map((line, index) => {
      const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
      return `${String(firstLine + index).padStart(6)}\t${clipped}`;
    })
    .join("\n");
}

const OMISSION =
  /(?:\/\/|#|\/\*|<!--|--|;)\s*(?:\.{3}|…)\s*\(?\s*(?:the\s+)?(?:rest|remaining|existing|unchanged|previous|other|same)\b|\b(?:rest of (?:the )?(?:file|code|function|class|implementation)|existing code|remaining code|unchanged code)\b[^\n]{0,30}\b(?:here|omitted|unchanged|goes)\b/i;

/** A line that stands in for code the model did not write, or null. */
export function findOmissionPlaceholder(text: string): string | null {
  const match = OMISSION.exec(text);
  if (!match) return null;
  const start = text.lastIndexOf("\n", match.index) + 1;
  const end = text.indexOf("\n", match.index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 120);
}

function omissionError(placeholder: string): ToolResult {
  return fail(
    `Not saved: the new content contains a placeholder instead of real code (${JSON.stringify(placeholder)}). ` +
      "Write out the full text you want in the file; to change only part of a file, use edit with an old_string that covers just that part.",
  );
}

/** Why the model may not change `file`, or null when what it read is still what is on disk. */
function staleReadProblem(context: ToolContext, file: string, current: Buffer): string | null {
  const read = context.readState.hashOf(file);
  if (read === undefined) return `You have not read ${file} yet. Read it before changing it.`;
  if (read !== sha(current)) return `${file} has changed since you last read it. Read it again before changing it.`;
  return null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// -- read ---------------------------------------------------------------------

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

export const readTool: HarnessTool<ReadArgs> = {
  readOnly: true,
  definition: {
    name: "read",
    description: [
      "Reads a file from the local filesystem. Each line comes back prefixed with its line number and a tab; that prefix is not part of the file.",
      "",
      "- file_path is an absolute path (a relative one is resolved against the working directory).",
      `- By default it returns up to ${MAX_READ_LINES} lines from the start. For a large file, pass offset (1-based line to start at) and limit instead of reading all of it.`,
      "- If you already know which part of a file you need, read just that part.",
      "- Reading a directory lists its entries. An image file (png, jpg, gif, webp) is shown to you as a picture when the current model can see pictures. Other binary files are not supported.",
      "- You must read a file before you can edit or overwrite it.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the file to read." },
        offset: { type: "integer", description: "1-based line number to start reading from." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["file_path"],
    },
  },
  intent: (args, context) => ({ action: "read", paths: [resolveToolPath(context.cwd, args.file_path)] }),
  async run(args, context) {
    const file = resolveToolPath(context.cwd, args.file_path);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return fail(`${file} does not exist. Check the path, or find the file with glob.`);
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file, { withFileTypes: true });
      const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
      const shown = names.slice(0, MAX_LIST_ENTRIES).join("\n");
      return { content: `${file} is a directory with ${names.length} entries:\n${shown}${names.length > MAX_LIST_ENTRIES ? `\n… ${names.length - MAX_LIST_ENTRIES} more` : ""}` };
    }
    const buffer = await fs.readFile(file);
    const image = readImage(file, buffer, context);
    if (image !== null) return image;
    if (buffer.subarray(0, 8000).includes(0)) return fail(`${file} looks like a binary file, which read does not support.`);
    // The hash covers the whole file even when only part is returned: an edit is checked against what is on disk.
    context.readState.remember(file, sha(buffer));
    const text = buffer.toString("utf8");
    if (text === "") return { content: `${file} is empty.` };
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = Math.max(1, args.offset ?? 1);
    if (start > lines.length) return fail(`offset ${start} is past the end of ${file}, which has ${lines.length} lines.`);
    const wanted = Math.min(Math.max(1, args.limit ?? MAX_READ_LINES), MAX_READ_LINES);
    const picked: string[] = [];
    let chars = 0;
    for (let index = start - 1; index < lines.length && picked.length < wanted; index += 1) {
      const line = lines[index]!;
      chars += Math.min(line.length, MAX_LINE_CHARS) + 8;
      if (chars > MAX_READ_CHARS && picked.length > 0) break;
      picked.push(line);
    }
    const last = start + picked.length - 1;
    const more = last < lines.length ? `\n\n(Showing lines ${start}-${last} of ${lines.length}. Call read again with offset=${last + 1} to continue.)` : "";
    return { content: numbered(picked, start) + more };
  },
};

// -- edit ---------------------------------------------------------------------

interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** `old` as it appears in `content`, tolerating CRLF files and line-number prefixes pasted from a read. */
function locate(content: string, oldString: string, newString: string): { old: string; next: string } | null {
  const prefixed = /^ *\d+\t/;
  const strip = (text: string): string => text.split("\n").map((line) => line.replace(prefixed, "")).join("\n");
  const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");
  const variants: Array<{ old: string; next: string }> = [{ old: oldString, next: newString }];
  if (oldString.split("\n").every((line) => prefixed.test(line))) {
    // Both strings were copied from a read; a new_string without prefixes is already plain.
    variants.push({ old: strip(oldString), next: prefixed.test(newString.split("\n")[0] ?? "") ? strip(newString) : newString });
  }
  const crlfFile = content.includes("\r\n");
  for (const variant of variants) {
    if (content.includes(variant.old)) return variant;
    if (crlfFile && !variant.old.includes("\r\n") && content.includes(crlf(variant.old))) return { old: crlf(variant.old), next: crlf(variant.next) };
  }
  return null;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function snippetAround(content: string, offset: number, length: number): string {
  const lines = content.split("\n");
  const startLine = content.slice(0, offset).split("\n").length;
  const endLine = startLine + content.slice(offset, offset + length).split("\n").length - 1;
  const from = Math.max(1, startLine - 3);
  const to = Math.min(lines.length, endLine + 3);
  return numbered(lines.slice(from - 1, to), from);
}

export const editTool: HarnessTool<EditArgs> = {
  readOnly: false,
  definition: {
    name: "edit",
    description: [
      "Replaces text in an existing file by exact match. To create a new file use write (or edit with an empty old_string on a path that does not exist).",
      "",
      "- Read the file first; the edit is refused if you have not read it or it changed since.",
      "- old_string must be the exact text from the file, including whitespace and indentation, and must occur exactly once: include enough surrounding lines to make it unique, or set replace_all to change every occurrence.",
      "- Do not include the line-number prefix that read adds in old_string or new_string.",
      "- new_string replaces old_string and must be different from it. Write the real code; placeholders such as \"// ... rest of file\" are refused.",
      "- Prefer editing an existing file to creating a new one.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the file to edit." },
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: { type: "string", description: "The text to put in its place." },
        replace_all: { type: "boolean", description: "Replace every occurrence of old_string instead of requiring exactly one." },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  intent: (args, context) => ({ action: "edit", paths: [resolveToolPath(context.cwd, args.file_path)] }),
  async run(args, context) {
    const file = resolveToolPath(context.cwd, args.file_path);
    if (args.old_string === args.new_string) return fail("old_string and new_string are identical, so nothing would change.");
    const placeholder = findOmissionPlaceholder(args.new_string);
    if (placeholder !== null && findOmissionPlaceholder(args.old_string) === null) return omissionError(placeholder);

    if (!(await exists(file))) {
      if (args.old_string !== "") return fail(`${file} does not exist. To create it, use write.`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.new_string, "utf8");
      context.readState.remember(file, sha(args.new_string));
      return { content: `Created ${file}.` };
    }
    const buffer = await fs.readFile(file);
    const stale = staleReadProblem(context, file, buffer);
    if (stale) return fail(stale);
    if (args.old_string === "") return fail("old_string is empty, but the file already exists. Give the text to replace, or use write to replace the whole file.");

    const content = buffer.toString("utf8");
    const found = locate(content, args.old_string, args.new_string);
    if (!found) {
      return fail(
        `old_string was not found in ${file}. It must match the file exactly, including whitespace and indentation. ` +
          "Read the part of the file you are changing again and copy the text from there.",
      );
    }
    const occurrences = countOccurrences(content, found.old);
    if (occurrences > 1 && args.replace_all !== true) {
      return fail(`old_string occurs ${occurrences} times in ${file}. Add surrounding lines to make it unique, or set replace_all to change every occurrence.`);
    }
    const first = content.indexOf(found.old);
    const updated = args.replace_all === true ? content.split(found.old).join(found.next) : content.slice(0, first) + found.next + content.slice(first + found.old.length);
    await fs.writeFile(file, updated, "utf8");
    context.readState.remember(file, sha(updated));
    const where = snippetAround(updated, first, found.next.length);
    const times = args.replace_all === true && occurrences > 1 ? ` (${occurrences} occurrences)` : "";
    return { content: `Edited ${file}${times}. The changed region now reads:\n${where}` };
  },
};

// -- write --------------------------------------------------------------------

interface WriteArgs {
  file_path: string;
  content: string;
}

export const writeTool: HarnessTool<WriteArgs> = {
  readOnly: false,
  definition: {
    name: "write",
    description: [
      "Writes a complete file, creating missing directories. If the file already exists it is overwritten, and you must have read it first.",
      "",
      "- Use it for new files and for rewriting a file entirely. For a change to part of an existing file use edit, which sends only the difference.",
      "- content is the whole file. Do not leave placeholders such as \"// ... rest of file\" for code you did not write; they are refused.",
      "- Do not create documentation files (README, *.md) unless asked.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the file to write." },
        content: { type: "string", description: "The complete contents of the file." },
      },
      required: ["file_path", "content"],
    },
  },
  intent: (args, context) => ({ action: "edit", paths: [resolveToolPath(context.cwd, args.file_path)] }),
  async run(args, context) {
    const file = resolveToolPath(context.cwd, args.file_path);
    let before: Buffer | null = null;
    try {
      before = await fs.readFile(file);
    } catch {
      before = null;
    }
    if (before !== null) {
      const stale = staleReadProblem(context, file, before);
      if (stale) return fail(stale);
    }
    const placeholder = findOmissionPlaceholder(args.content);
    if (placeholder !== null && (before === null || findOmissionPlaceholder(before.toString("utf8")) === null)) return omissionError(placeholder);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, args.content, "utf8");
    context.readState.remember(file, sha(args.content));
    const lines = args.content === "" ? 0 : args.content.split("\n").length - (args.content.endsWith("\n") ? 1 : 0);
    return { content: `${before === null ? "Created" : "Overwrote"} ${file} (${lines} lines).` };
  },
};
