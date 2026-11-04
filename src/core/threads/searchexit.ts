/**
 * Whether a shell command's exit code 1 only means "the search found nothing".
 *
 * Display only: the Harness shell tool still reports a non-zero exit as an
 * error to the model, and this decides how the user's transcript labels it.
 * The rule is deliberately narrow. Anything it cannot be sure of answers
 * false, and the row keeps showing as failed: a false "failed" costs a second
 * look, a false "no matches" hides a real failure.
 *
 * Exit 1 is the search's own answer only when the search is the last command
 * of a plain `;` / newline list, so that nothing else could have produced the
 * status: `grep x; false`, `rg x || true`, `a && rg x` (a may be what failed),
 * `rg x | cat`, `rg x &`, and any command that quotes a construct this does
 * not parse (subshells, groups, substitutions, heredocs, `if`/`while`,
 * `exit`, `set`, `trap`, …) all stay failed. POSIX shell syntax only: the
 * PowerShell tool never reaches this.
 */

const SEARCHES: ReadonlySet<string> = new Set(["rg", "grep", "egrep", "fgrep"]);
/** Commands that can end or change how a list runs, so the last command's status may not be the one that came back. */
const CONTROL: ReadonlySet<string> = new Set([
  "exit", "return", "set", "trap", "exec", "shopt", "eval", "source", ".", "break", "continue",
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc",
]);

interface Segment {
  /** What joined this command to the one before it. */
  readonly after: string | null;
  readonly words: string[];
}

/** Split a command line into simple commands, or null when it holds anything this does not read. */
function split(command: string): { segments: Segment[]; trailing: string | null } | null {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let joiner: string | null = null;
  const endWord = (): void => {
    if (word !== null) words.push(word);
    word = null;
  };
  let broken = false;
  const endSegment = (next: string): void => {
    endWord();
    if (words.length > 0) {
      segments.push({ after: joiner, words });
      words = [];
      joiner = next;
    } else if (next !== ";") {
      broken = true; // an operator with no command before it
    }
    // A `;` or newline after nothing (a blank line, or after `&&`) changes no joiner.
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      word = (word ?? "") + command.slice(i + 1, close);
      i = close;
    } else if (ch === '"') {
      let text = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j += 1) {
        const inner = command[j]!;
        if (inner === "`" || (inner === "$" && command[j + 1] === "(")) return null;
        if (inner === "\\" && j + 1 < command.length) {
          j += 1;
          text += command[j]!;
        } else text += inner;
      }
      if (j >= command.length) return null;
      word = (word ?? "") + text;
      i = j;
    } else if (ch === "\\") {
      if (next === undefined) return null;
      if (next !== "\n") word = (word ?? "") + next;
      i += 1;
    } else if (ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "#") {
      return null;
    } else if (ch === "$" && (next === "(" || next === "{")) {
      return null;
    } else if (ch === "<" && next === "<") {
      return null;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
    } else if (ch === "\n") {
      endSegment(";");
    } else if (ch === ";") {
      if (next === ";") return null;
      endSegment(";");
    } else if (ch === "&" && (next === ">" || command[i - 1] === ">" || command[i - 1] === "<")) {
      word = (word ?? "") + ch; // a redirection (`2>&1`, `&>file`), not a job operator
    } else if (ch === "&") {
      if (next === "&") {
        i += 1;
        endSegment("&&");
      } else endSegment("&");
    } else if (ch === "|") {
      if (next === "|") {
        i += 1;
        endSegment("||");
      } else endSegment("|");
    } else {
      word = (word ?? "") + ch;
    }
  }
  endWord();
  if (broken) return null;
  if (words.length > 0) segments.push({ after: joiner, words });
  return { segments, trailing: words.length > 0 || joiner === ";" || joiner === null ? null : joiner };
}

/** The command word of a simple command, past any leading `NAME=value` assignments. */
function commandWord(words: readonly string[]): { index: number; name: string } | null {
  const index = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
  return index < 0 ? null : { index, name: words[index]! };
}

export function endsInSearch(command: string): boolean {
  const parsed = split(command);
  if (parsed === null || parsed.segments.length === 0 || parsed.trailing !== null) return false;
  for (const segment of parsed.segments) {
    const word = commandWord(segment.words);
    if (word !== null && CONTROL.has(word.name)) return false;
  }
  const last = parsed.segments[parsed.segments.length - 1]!;
  if (last.after !== null && last.after !== ";") return false;
  const word = commandWord(last.words);
  if (word === null) return false;
  const program = word.name.split(/[\\/]/u).pop() ?? "";
  if (!SEARCHES.has(program)) return false;
  // Searches whose exit 1 means something else (files listed, files without a match, inverted across grep versions).
  for (const arg of last.words.slice(word.index + 1)) {
    if (arg === "--files" || arg.startsWith("--files-") || arg === "--files-without-match") return false;
    if (/^-[A-Za-z]*L/u.test(arg)) return false;
  }
  return true;
}

/** The Harness shell tool's `[exit code N]` line, at the very end of its result. */
export function harnessExitCode(output: string): number | null {
  const match = /(?:^|\n)\[exit code (\d+)\]$/u.exec(output);
  return match === null ? null : Number(match[1]);
}

/** True for a Harness shell result that failed only because the last command, a search, found nothing. */
export function isNoMatches(command: string, output: string): boolean {
  return harnessExitCode(output) === 1 && endsInSearch(command);
}
