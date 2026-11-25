/**
 * Guards for the failures weaker models have and stronger ones mostly do not:
 * calling the same tool with the same arguments over and over, repeating one
 * stretch of text or reasoning, and replying with nothing after a tool result.
 * All are the harness's problem to catch, because a prompt asking the model
 * not to is not a guarantee.
 */
import { createHash } from "node:crypto";

/** What the model is allowed to repeat before the harness steps in. A profile can change each. */
export interface LoopGuardSettings {
  /** The same tool call this many times in a row with the same result gets a warning. */
  readonly repeatWarn: number;
  /** …and this many ends the turn. */
  readonly repeatStop: number;
  /** A reply repeating one stretch of text this many times back to back is cut off. */
  readonly textRepeats: number;
  /** Watch for repeated tool calls at all. */
  readonly calls: boolean;
  /** Watch the streamed text and reasoning for a loop at all. */
  readonly text: boolean;
}

export const DEFAULT_LOOP_GUARD: LoopGuardSettings = { repeatWarn: 4, repeatStop: 6, textRepeats: 10, calls: true, text: true };

export type LoopVerdict = "ok" | "warn" | "stop";
export type LoopKind = "none" | "repeat" | "cycle";

const MAX_CYCLE_PERIOD = 6;
const MIN_HISTORY = 64;

interface CallEntry {
  readonly key: string;
  readonly outcome: string;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalArguments(rawArguments: string): string {
  try {
    return JSON.stringify(canonicalizeJson(JSON.parse(rawArguments)));
  } catch {
    return rawArguments.trim();
  }
}

function hashOutcome(result: string, isError: boolean): string {
  return createHash("sha256").update(isError ? "1\u0000" : "0\u0000").update(result).digest("hex");
}

/**
 * Watches completed tool calls and their results within one turn: the same
 * call repeating back to back with the same result, and short rotations of
 * calls (read, edit, read, edit, …) repeating with the same results and no
 * other work in between. Doing different work or getting a different result
 * breaks the streak.
 */
export class LoopGuard {
  readonly #recent: CallEntry[] = [];
  readonly #settings: LoopGuardSettings;
  readonly #historyLimit: number;
  #lastKind: LoopKind = "none";

  constructor(settings: Partial<LoopGuardSettings> = {}) {
    const merged = { ...DEFAULT_LOOP_GUARD, ...settings };
    // A stop that comes before the warning would never be warned about.
    this.#settings = { ...merged, repeatStop: Math.max(merged.repeatStop, merged.repeatWarn) };
    this.#historyLimit = Math.max(MIN_HISTORY, this.#settings.repeatStop * MAX_CYCLE_PERIOD);
  }

  static key(name: string, rawArguments: string): string {
    return `${name}\u0000${canonicalArguments(rawArguments)}`;
  }

  /** Whether the most recent warning or stop came from one repeating call or a multi-call cycle. */
  get lastKind(): LoopKind {
    return this.#lastKind;
  }

  /**
   * Record a completed tool call and its result. Only consecutive identical
   * (call, result) repeats or consecutive identical multi-call cycles count:
   * interleaving different work (such as editing files between test runs) or
   * observing a changed result resets the streak.
   */
  observe(name: string, rawArguments: string, result: string, isError = false): LoopVerdict {
    this.#lastKind = "none";
    if (!this.#settings.calls) return "ok";
    const key = LoopGuard.key(name, rawArguments);
    const outcome = hashOutcome(result, isError);
    this.#recent.push({ key, outcome });
    if (this.#recent.length > this.#historyLimit) this.#recent.shift();

    const streak = this.#streak();
    if (streak >= this.#settings.repeatStop) {
      this.#lastKind = "repeat";
      return "stop";
    }

    const cycles = this.#cycles();
    const cyclesWarn = Math.max(2, this.#settings.repeatWarn - 1);
    const cyclesStop = Math.max(cyclesWarn, this.#settings.repeatStop - 1);
    if (cycles >= cyclesStop) {
      this.#lastKind = "cycle";
      return "stop";
    }

    if (streak >= this.#settings.repeatWarn) {
      this.#lastKind = "repeat";
      return "warn";
    }
    if (cycles >= cyclesWarn) {
      this.#lastKind = "cycle";
      return "warn";
    }
    return "ok";
  }

  /** Consecutive identical (call, result) entries at the end of recent history. */
  #streak(): number {
    const last = this.#recent[this.#recent.length - 1];
    if (!last) return 0;
    let count = 0;
    for (let i = this.#recent.length - 1; i >= 0; i -= 1) {
      const entry = this.#recent[i]!;
      if (entry.key !== last.key || entry.outcome !== last.outcome) break;
      count += 1;
    }
    return count;
  }

  /** How many full consecutive times the newest calls have gone round a cycle of 2..MAX_CYCLE_PERIOD calls with identical results. */
  #cycles(): number {
    let best = 0;
    const total = this.#recent.length;
    for (let period = 2; period <= MAX_CYCLE_PERIOD; period += 1) {
      if (total < period * 2) continue;
      const tail = this.#recent.slice(total - period);
      if (new Set(tail.map((entry) => entry.key)).size < 2) continue;
      let length = 0;
      for (let i = total - 1; i >= 0; i -= 1) {
        const current = this.#recent[i]!;
        const expected = this.#recent[total - 1 - ((total - 1 - i) % period)]!;
        if (current.key !== expected.key || current.outcome !== expected.outcome) break;
        length += 1;
      }
      best = Math.max(best, Math.floor(length / period));
    }
    return best;
  }
}

const WINDOW = 50;
/** Minimum total characters of consecutive repetition before cutting off a stream (prevents short tokens or layout rows from tripping). */
const MIN_REPEAT_SPAN = 200;
/** How much of the newest text is searched for repeats. */
const SCAN = 20_000;
/** Maximum prior occurrences of a window to test at one step, keeping worst-case work bounded. */
const MAX_CANDIDATES = 16;

const LETTER_RE = /\p{L}/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/**
 * True when a slice has enough varied wording to be text rather than layout,
 * borders, indentation, or a run of one character/digit (e.g. `---`, `| | |`, `0000`, `0101`).
 */
function hasSubstantiveContent(slice: string): boolean {
  const letters = new Set<string>();
  const alnum = new Set<string>();
  for (const ch of slice.toLowerCase()) {
    if (LETTER_RE.test(ch)) {
      letters.add(ch);
      alnum.add(ch);
      if (letters.size >= 2) return true;
    } else if (ALNUM_RE.test(ch)) {
      alnum.add(ch);
      if (alnum.size >= 4) return true;
    }
  }
  return false;
}

/** Watches the text a model streams for one stretch coming round again and again (a degenerate loop). */
export class RepeatWatch {
  #text = "";
  #checkedAt = 0;
  readonly #limit: number;

  constructor(limit: number = DEFAULT_LOOP_GUARD.textRepeats) {
    this.#limit = Math.max(2, limit);
  }

  /** Feed the next piece of text; true when the stream has gone into a loop. */
  push(piece: string): boolean {
    if (piece === "") return false;
    this.#text += piece;
    if (this.#text.length > SCAN * 2) {
      const drop = this.#text.length - SCAN;
      this.#checkedAt = Math.max(0, this.#checkedAt - drop);
      this.#text = this.#text.slice(drop);
    }
    while (this.#text.length - this.#checkedAt >= WINDOW) {
      this.#checkedAt += WINDOW;
      const end = this.#checkedAt;
      if (end < MIN_REPEAT_SPAN) continue;
      const windowStart = end - WINDOW;
      if (windowStart <= 0) continue;
      const window = this.#text.slice(windowStart, end);
      // A rule of dashes, spaces, table borders, or binary digits is layout, not a loop.
      if (!hasSubstantiveContent(window)) continue;
      let searchFrom = windowStart - 1;
      for (let tries = 0; tries < MAX_CANDIDATES && searchFrom >= 0; tries += 1) {
        const previous = this.#text.lastIndexOf(window, searchFrom);
        if (previous === -1) break;
        // The stretch has to come round at one steady period, back to back: a table whose rows share wording is not a loop.
        const period = windowStart - previous;
        if (period <= 0) break;
        const span = Math.max(MIN_REPEAT_SPAN, period * this.#limit);
        if (span > end) break;
        const start = end - span;
        let steady = true;
        for (let at = start; at < end - period; at += 1) {
          if (this.#text.charCodeAt(at) !== this.#text.charCodeAt(at + period)) {
            steady = false;
            break;
          }
        }
        if (steady) return true;
        searchFrom = previous - 1;
      }
    }
    return false;
  }
}

export const EMPTY_REPLY_REMINDER =
  "Your last reply was empty. After a tool result you must either call another tool or tell the user what you found and what happens next. Do one of those now.";

export const OUTPUT_LIMIT_REMINDER =
  "Your last reply ran out of output space while you were still thinking and produced no answer or tool call. Think less, act in smaller steps, and make a tool call or give the answer now.";

export const LOOP_WARNING =
  "You have made this exact tool call several times in a row with the same result. Repeating it will not change the outcome. Step back, say what you have learned, and try a different approach.";

export const CYCLE_LOOP_WARNING =
  "You have repeated the same sequence of tool calls several times in a row with the same results. Repeating it will not change the outcome. Step back, say what you have learned, and try a different approach.";
