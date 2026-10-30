import { t as tr } from "../../i18n/index.js";
import type { RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { bold, fg, t, underline } from "@opentui/core";

import type { SkillSummary } from "../../../core/catalog/summary.js";
import { marqueeWindow, matchRange } from "../../model/skills.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";

/** Rows visible at once before the list scrolls (wheel, not the arrow keys alone). */
export const SKILL_POPUP_ROWS = 8;

/** The popup's chrome around its rows: the header line. */
export const SKILL_POPUP_CHROME_ROWS = 1;

const MARKER_WIDTH = 2;
const GAP = "  ";
/** The name column never takes more than this share of a row, so a long name cannot crowd the description out. */
const NAME_SHARE = 0.45;
const MIN_NAME_COLUMN = 8;

/**
 * The slash picker above the composer: what the provider calls each skill,
 * what it does, and where the typed query landed.
 *
 * Names sit in one aligned column and descriptions start at one position, so
 * the list scans as a table instead of a ragged line of words. The query is
 * picked out in each name, the selected row says so with a marker as well as
 * a tint (colour alone is easy to lose), and the header carries the position
 * and the keys the picker answers to. The selected row's description scrolls
 * through the rest of itself; every other stays still.
 */
export function SkillPicker({
  matches,
  query,
  activeIndex,
  marqueeTick,
  width,
  rows,
  hasCatalog,
  scrollRef,
  onPick,
  onHover,
}: {
  matches: readonly SkillSummary[];
  /** What follows the `/`, lowercased — highlighted where it sits in each name. */
  query: string;
  /** The highlighted row, or -1 with no matches. */
  activeIndex: number;
  marqueeTick: number;
  width: number;
  /** Rows of the list shown at once (`min(SKILL_POPUP_ROWS, matches)`). */
  rows: number;
  /** Whether the provider offered any skill at all — tells "nothing here" from "nothing matches". */
  hasCatalog: boolean;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onPick: (skill: SkillSummary) => void;
  onHover: (index: number) => void;
}) {
  const rowWidth = Math.max(12, width - 3);
  const labelOf = (skill: SkillSummary) => `/${skill.displayName ?? skill.name}`;
  const longest = matches.reduce((max, skill) => Math.max(max, labelOf(skill).length), 0);
  const nameColumn = Math.max(MIN_NAME_COLUMN, Math.min(longest, Math.floor((rowWidth - MARKER_WIDTH) * NAME_SHARE)));
  const descriptionWidth = rowWidth - MARKER_WIDTH - nameColumn - GAP.length;

  return (
    <box
      style={{
        position: "absolute",
        left: 0,
        top: -(rows + SKILL_POPUP_CHROME_ROWS),
        width,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        zIndex: 25,
      }}
      border={["left"]}
      borderStyle="heavy"
      borderColor={SURFACE.borderFocus}
      backgroundColor={SURFACE.raised}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between", marginBottom: 0 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
          {matches.length === 0 ? tr("composer.commands_skills_ff16") : tr("composer.commandsAt", { at: activeIndex + 1, total: matches.length })}
        </text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>
          {width >= 56 ? tr("composer.move_insert_esc_close_2746") : tr("composer.insert_esc_ce90")}
        </text>
      </box>
      {matches.length === 0 ? (
        <box style={{ flexDirection: "column", flexShrink: 0 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>
            {hasCatalog ? truncate(tr("composer.nothingMatches", { query }), rowWidth) : tr("composer.no_commands_or_skills_b3e6")}
          </text>
        </box>
      ) : (
        // Fixed-height scrollbox: a wheel over the popup scrolls the list
        // itself instead of leaking through to the chat underneath. Every match
        // renders; the box clips to `rows`. Scrollable content hugs its own
        // size rather than stretching, so each row carries an explicit width.
        <scrollbox ref={scrollRef} style={{ height: rows, flexShrink: 0 }} stickyStart="top">
          {matches.map((skill, index) => {
            const active = index === activeIndex;
            const bg = active ? COLOR.selectionBg : SURFACE.raised;
            const shown = truncate(labelOf(skill), nameColumn);
            // Offsets in the label are one past the name's: the slash leads it.
            const range = matchRange(skill.displayName ?? skill.name, query);
            const from = range === null ? shown.length : Math.min(range[0] + 1, shown.length);
            const to = range === null ? shown.length : Math.min(range[1] + 1, shown.length);
            const description = skill.shortDescription ?? skill.description ?? "";
            const text =
              description.length === 0 || descriptionWidth < 8
                ? null
                : active
                  ? marqueeWindow(description, descriptionWidth, marqueeTick)
                  : truncate(description, descriptionWidth);
            // One styled text per row, not a row of neighbouring texts: separate
            // nodes shifted the columns by a cell wherever a style changed.
            const name = (value: string) => (active ? bold(fg(COLOR.bright)(value)) : fg(COLOR.text)(value));
            const slash = shown.slice(0, Math.min(1, from));
            const label = t`${fg(COLOR.accent)(active ? "▸ " : "  ")}${fg(COLOR.command)(slash)}${name(shown.slice(slash.length, from))}${underline(bold(fg(COLOR.accent)(shown.slice(from, to))))}${name(shown.slice(to))}${" ".repeat(Math.max(0, nameColumn - shown.length))}${fg(active ? COLOR.text : COLOR.dim)(text === null ? "" : `${GAP}${text}`)}`;
            return (
              <box
                key={skill.name}
                style={{ width: rowWidth, flexDirection: "row", height: 1, flexShrink: 0 }}
                backgroundColor={bg}
                onMouseDown={() => onPick(skill)}
                onMouseOver={() => onHover(index)}
              >
                <text bg={bg} content={label} selectable={false} />
              </box>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
}
