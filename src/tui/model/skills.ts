import { plainSkill, type SkillInventory, type SkillSummary } from "../../core/catalog/summary.js";

export interface SkillTrigger {
  /** Offset of the leading `/` in the full draft text (always 0: the picker opens on a message's first character). */
  start: number;
  /** Characters typed after it, lowercased for matching. */
  query: string;
}

/**
 * Detects a skill token being typed at the cursor, slash-picker style: `/`
 * opens the picker, and only as the very first character of the message — a
 * `/` anywhere else (a path, a fraction, a URL) is text. A pick inserts
 * `/name`, the same token the picker opened on.
 *
 * Every character between the `/` and the cursor must be word-ish with no
 * whitespace in between: the moment a space is typed the token is done and
 * the picker closes.
 */
export function detectSkillTrigger(text: string, cursorOffset: number): SkillTrigger | null {
  const offset = Math.max(0, Math.min(cursorOffset, text.length));
  let i = offset;
  while (i > 0 && /[\w.:-]/.test(text[i - 1]!)) i -= 1;
  if (i !== 1 || text[0] !== "/") return null;
  return { start: 0, query: text.slice(1, offset).toLowerCase() };
}

/** What Moxen itself runs from the composer, whichever provider the thread is on. */
const MOXEN_COMMANDS: readonly SkillSummary[] = [
  plainSkill("compact", "Summarize the conversation to free up context"),
  plainSkill("btw", "Ask a side question without adding it to the thread", { shortDescription: "<question>  Ask a side question without adding it to the thread" }),
  plainSkill("research", "Research mode: researcher agents, a critic and one final report (again: back to Build)"),
  plainSkill("orchestrate", "Orchestrate mode: tasks delegated to the model that fits each (again: back to Build)"),
];

/**
 * Everything the `/` picker lists, in the order it reads best: Moxen's own
 * commands, then the provider's slash commands, then its skills. A name
 * offered twice is listed once, first source winning — a provider's own
 * `compact` would only be the command Moxen already runs for it. Undefined
 * while the provider has not answered, which keeps the picker closed.
 */
export function pickerEntries(inventory: Pick<SkillInventory, "skills" | "commands"> | undefined): SkillSummary[] | undefined {
  if (inventory === undefined) return undefined;
  const commands = inventory.commands.map((command) =>
    plainSkill(command.name, command.description, command.argumentHint === null ? {} : { shortDescription: `${command.argumentHint}  ${command.description ?? ""}`.trim() }),
  );
  const seen = new Set<string>();
  return [...MOXEN_COMMANDS, ...commands, ...inventory.skills].filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
}

/**
 * Skills the picker may offer: enabled, and not marked agent-only
 * (`userInvocable: false`). A query matches the name, display name or
 * description as a substring, and what you most likely meant comes first:
 * a name that starts with it, then one that contains it, then a description
 * that does. Within a rank the provider's own order stands.
 */
export function filterSkills(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const invocable = skills.filter((skill) => skill.enabled && skill.userInvocable);
  if (query.length === 0) return invocable;
  const rank = (skill: SkillSummary): number => {
    const names = [skill.name, skill.displayName ?? skill.name].map((name) => name.toLowerCase());
    if (names.some((name) => name.startsWith(query))) return 0;
    if (names.some((name) => name.includes(query))) return 1;
    return (skill.shortDescription ?? skill.description ?? "").toLowerCase().includes(query) ? 2 : 3;
  };
  return invocable
    .map((skill, index) => ({ skill, index, rank: rank(skill) }))
    .filter((entry) => entry.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.skill);
}

/** Where the typed query sits in a skill's name, for highlighting: `[start, end)`, or null when it matched elsewhere (the description). */
export function matchRange(label: string, query: string): [number, number] | null {
  if (query.length === 0) return null;
  const start = label.toLowerCase().indexOf(query);
  return start < 0 ? null : [start, start + query.length];
}

/**
 * A `width`-wide sliding window over `text`, advancing one column per `tick`
 * — the marquee for a skill description too long to fit its row. Loops with
 * a `   •   ` gap instead of snapping back, so the wrap reads as continuous
 * scroll rather than a jump cut. Returns `text` unchanged when it already fits.
 */
export function marqueeWindow(text: string, width: number, tick: number): string {
  if (text.length <= width || width <= 0) return text;
  const loop = `${text}   •   `;
  const doubled = loop + loop;
  const offset = ((tick % loop.length) + loop.length) % loop.length;
  return doubled.slice(offset, offset + width);
}

/**
 * The command a draft opens with, when it names one the picker knows: `[0, end)`
 * in the text, so the composer can colour it. An unknown `/word` is plain text
 * (a path, a typo), which is the point — the colour says "this will be taken as
 * a command".
 */
export function leadingCommandRange(text: string, known: ReadonlySet<string>): [number, number] | null {
  const match = /^\/([\w.:-]+)(?=\s|$)/u.exec(text);
  return match !== null && known.has(match[1]!) ? [0, match[0].length] : null;
}

/**
 * Replaces the `/query` token with the skill as `/skill-name `, and reports
 * where the cursor lands after it.
 */
export function insertSkillMention(text: string, trigger: SkillTrigger, skillName: string): { text: string; cursorOffset: number } {
  const tokenEnd = trigger.start + 1 + trigger.query.length;
  const before = text.slice(0, trigger.start);
  const after = text.slice(tokenEnd);
  const inserted = `/${skillName} `;
  return { text: `${before}${inserted}${after}`, cursorOffset: before.length + inserted.length };
}
