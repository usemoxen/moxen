import { TextAttributes } from "@opentui/core";
import { useState } from "react";

import type { ClientApi, ResearchRole } from "../../../server/api.js";
import type { ModelSelection } from "../../../core/types.js";
import { useAnimTick } from "../../hooks/useAnimTick.js";
import { useHover } from "../../hooks/useHover.js";
import { t, type MessageKey } from "../../i18n/index.js";
import { turnModelSelection } from "../../model/display.js";
import {
  columnWidths, ROLES, runElapsedMs, SLIVER_WIDTH, type AgentRef, type AgentState, type RunAgent, type RunPhase, type RunSummary,
} from "../../model/researchrun.js";
import { formatDuration } from "../../model/turns.js";
import { COLOR, SPINNER, SURFACE } from "../../theme.js";
import { OverflowText } from "../../ui/overflowtext.js";
import { Timeline } from "../timeline/timeline.js";
import type { ResearchRunViewApi } from "./useResearchRunView.js";
import { useRoleTranscript } from "./useRoleTranscript.js";

const PHASE_KEY: Readonly<Record<RunPhase, MessageKey>> = {
  planning: "run.phase.planning",
  researching: "run.phase.researching",
  reviewing: "run.phase.reviewing",
  finalizing: "run.phase.finalizing",
  finished: "run.phase.finished",
  failed: "run.phase.failed",
  stopped: "run.phase.stopped",
};

const STATE_KEY: Readonly<Record<AgentState, MessageKey>> = {
  waiting: "run.state.waiting",
  working: "run.state.working",
  done: "run.state.done",
  failed: "run.state.failed",
  stopped: "run.state.stopped",
};

const ROLE_KEY: Readonly<Record<ResearchRole, MessageKey>> = {
  researcher: "run.role.researchers",
  critic: "run.role.critics",
  finalizer: "run.role.finalizer",
};

const WAITING_KEY: Readonly<Record<ResearchRole, MessageKey>> = {
  researcher: "run.waiting.researcher",
  critic: "run.waiting.critic",
  finalizer: "run.waiting.finalizer",
};

/** What a slot nothing was started in says once the run is over. */
const NEVER_KEY: Readonly<Record<ResearchRole, MessageKey>> = {
  researcher: "run.never.researcher",
  critic: "run.never.critic",
  finalizer: "run.never.finalizer",
};

/** One of the five states as a glyph: the spinner turns while it works. */
export function stateGlyph(state: AgentState, tick: number): { glyph: string; color: string } {
  switch (state) {
    case "working":
      return { glyph: SPINNER[Math.floor(tick / 400) % SPINNER.length] ?? "◐", color: COLOR.accent };
    case "done":
      return { glyph: "✓", color: COLOR.added };
    case "failed":
      return { glyph: "✗", color: COLOR.danger };
    case "stopped":
      return { glyph: "■", color: COLOR.dim };
    default:
      return { glyph: "○", color: COLOR.faint };
  }
}

/** "Researcher 3", "Critic 1 · Evidence", "Finalizer": what a column and the roster call an agent. */
export function agentTitle(agent: RunAgent, summary: RunSummary): string {
  if (agent.role === "finalizer") return t("run.agent.finalizer");
  if (agent.role === "researcher") return t("run.agent.researcher", { n: agent.index });
  const lens = agent.lens === null ? "" : ` · ${t(agent.lens === "all" ? "run.lens.all" : (`run.lens.${agent.lens}` as MessageKey))}`;
  return summary.agents.critic.length === 1 ? `${t("run.agent.critic")}${lens}` : `${t("run.agent.criticN", { n: agent.index })}${lens}`;
}

function RosterGlyph({ agent, picked, focused, tick, onPick }: { agent: RunAgent; picked: boolean; focused: boolean; tick: number; onPick: () => void }) {
  const { hovered, handlers } = useHover();
  const { glyph, color } = stateGlyph(agent.state, tick);
  return (
    <text
      fg={picked ? COLOR.bright : color}
      bg={picked ? (focused ? SURFACE.hover : SURFACE.user) : hovered ? SURFACE.hover : SURFACE.base}
      attributes={picked ? TextAttributes.BOLD : TextAttributes.NONE}
      selectable={false}
      onMouseDown={onPick}
      {...handlers}
    >
      {` ${glyph} `}
    </text>
  );
}

/** One role's label and its glyphs: clicking a glyph shows that agent in its column. */
function RosterGroup({ summary, role, picked, focused, tick, onPick, onFocus }: {
  summary: RunSummary; role: ResearchRole; picked: AgentRef; focused: boolean; tick: number; onPick: (ref: AgentRef) => void; onFocus: () => void;
}) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, height: 1 }}>
      <text
        fg={focused ? COLOR.bright : hovered ? COLOR.text : COLOR.dim}
        attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
        selectable={false}
        onMouseDown={onFocus}
        {...handlers}
      >
        {t(ROLE_KEY[role])}
      </text>
      {summary.agents[role].map((agent, index) => (
        <RosterGlyph key={index} agent={agent} picked={picked.index === index} focused={focused} tick={tick} onPick={() => onPick({ role, index })} />
      ))}
    </box>
  );
}

/** A column with nothing started in it: a frame holding the words for what it waits on. */
function QuietColumn({ title, state, text, width, focused, onFocus }: { title: string; state: string; text: string; width: number; focused: boolean; onFocus: () => void }) {
  return (
    <box
      style={{ flexDirection: "column", flexGrow: 1, width, borderStyle: "rounded", backgroundColor: SURFACE.base, paddingLeft: width <= SLIVER_WIDTH ? 0 : 1, paddingRight: width <= SLIVER_WIDTH ? 0 : 1 }}
      borderColor={focused ? SURFACE.borderFocus : SURFACE.border}
      title={` ${title} `}
      titleColor={focused ? COLOR.bright : COLOR.dim}
      bottomTitle={` ${state} `}
      bottomTitleAlignment="right"
      onMouseDown={onFocus}
    >
      <text fg={COLOR.dim} wrapMode="word" selectable={false}>{text}</text>
    </box>
  );
}

function AgentColumn({
  client, summary, agent, width, focused, now, scrollRef, labelFor, homeDir, tick, onFocus,
}: {
  client: ClientApi;
  summary: RunSummary;
  agent: RunAgent;
  width: number;
  focused: boolean;
  now: number;
  scrollRef: ResearchRunViewApi["scrollRefs"][ResearchRole];
  labelFor: (selection: ModelSelection | undefined) => { name: string; color: string | null };
  homeDir: string | undefined;
  tick: number;
  onFocus: () => void;
}) {
  const sliver = width <= SLIVER_WIDTH;
  const { state, groups } = useRoleTranscript(client, sliver ? null : agent.threadId);
  const [expandedWork, setExpandedWork] = useState<ReadonlyMap<string, boolean>>(new Map());
  const { glyph } = stateGlyph(agent.state, tick);
  const title = `${agentTitle(agent, summary)} ${glyph}`;
  if (sliver || agent.threadId === null) {
    return (
      <QuietColumn
        title={sliver ? t(ROLE_KEY[agent.role]) : title}
        state={t(STATE_KEY[agent.state])}
        text={agent.threadId === null ? t((summary.ended ? NEVER_KEY : WAITING_KEY)[agent.role]) : (agent.question ?? "")}
        width={width}
        focused={focused}
        onFocus={onFocus}
      />
    );
  }
  const thread = state.thread ?? agent.thread;
  const modelName = labelFor(thread?.modelSelection).name;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, width }}>
      <Timeline
        groups={groups}
        title={title}
        subtitle={`${t(STATE_KEY[agent.state])} · ${modelName}`}
        modelForTurn={(turnId) => {
          const selection = turnModelSelection({ modelSelection: thread?.modelSelection, turnModelSelections: thread?.turnModelSelections }, turnId);
          return { ...labelFor(selection), ...(selection ? { provider: selection.instanceId } : {}) };
        }}
        usagePauseForTurn={(turnId) => thread?.turnUsagePauses?.[turnId]}
        modelLabel={(reference) => {
          const slash = reference.indexOf("/");
          return slash < 0 ? { name: reference, color: null } : labelFor({ instanceId: reference.slice(0, slash), model: reference.slice(slash + 1) });
        }}
        homeDir={homeDir}
        expandedTurn={null}
        expandedWork={expandedWork}
        onToggleWork={(id, expand) => setExpandedWork((current) => new Map(current).set(id, expand))}
        scrollRef={scrollRef}
        focused={focused}
        onFocus={onFocus}
        onOpenDiff={() => undefined}
        onOpenMessageActions={() => undefined}
        onOpenUrl={() => undefined}
        width={Math.max(10, width - 2)}
        sessionStatus={state.session?.status ?? (agent.state === "working" ? "running" : "idle")}
        now={now}
        turnStartedAt={thread?.latestTurn?.startedAt ?? thread?.latestTurn?.requestedAt ?? null}
        turnFileDiffs={new Map()}
        gitFiles={[]}
        titleReserve={4}
      />
    </box>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <text
      fg={active ? COLOR.bright : hovered ? COLOR.text : COLOR.dim}
      bg={active ? SURFACE.user : hovered ? SURFACE.hover : SURFACE.base}
      attributes={active ? TextAttributes.BOLD : TextAttributes.NONE}
      selectable={false}
      onMouseDown={onClick}
      {...handlers}
    >
      {label}
    </text>
  );
}

/** Row width the roster needs on one line: each label, its glyphs, and the gaps between groups. */
function rosterWidth(summary: RunSummary): number {
  return ROLES.reduce((all, role) => all + t(ROLE_KEY[role]).length + summary.agents[role].length * 3, 0) + (ROLES.length - 1) * 4;
}

/**
 * The research run, in place of the lead's chat: a header, a roster with one
 * glyph per agent, and the researcher, critic and finalizer columns. Wide
 * panes draw all three, sized by the phase; narrow ones draw the focused
 * column under a switcher.
 */
export function ResearchRunView({
  client, summary, view, width, now, labelFor, homeDir, onOpenAgent, onOpenLead,
}: {
  client: ClientApi;
  summary: RunSummary;
  view: ResearchRunViewApi;
  width: number;
  now: number;
  labelFor: (selection: ModelSelection | undefined) => { name: string; color: string | null };
  homeDir: string | undefined;
  onOpenAgent: (agent: RunAgent) => void;
  onOpenLead: () => void;
}) {
  const working = ROLES.some((role) => summary.agents[role].some((agent) => agent.state === "working"));
  const tick = useAnimTick(working, 400);
  // The header's clock runs by the second while the run does; the app's own `now` ticks slowly.
  const clock = Math.max(now, useAnimTick(!summary.ended, 1000));
  const focusRole = view.roleOf(summary);
  const widths = columnWidths(summary, width);
  const phase = t(PHASE_KEY[summary.phase]);
  const elapsed = formatDuration(runElapsedMs(summary, clock));
  const right = `${phase} · ${elapsed}`;
  const title = `${t("run.title")}${summary.title === "" ? "" : ` · ${summary.title}`}`;
  const oneRow = rosterWidth(summary) <= width;
  const groupFor = (role: ResearchRole) => (
    <RosterGroup
      key={role} summary={summary} role={role} picked={view.refOf(summary, role)} focused={focusRole === role} tick={tick}
      onPick={(ref) => view.select(summary, ref)} onFocus={() => view.focusRole(summary, role)}
    />
  );
  const roles = widths === null ? [focusRole] : ROLES;
  const leadHover = useHover();
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <OverflowText fg={COLOR.bright} attributes={TextAttributes.BOLD} selectable={false} width={Math.max(8, width - right.length - 2)}>{title}</OverflowText>
        <text fg={summary.phase === "failed" ? COLOR.danger : summary.ended ? COLOR.added : COLOR.accent} selectable={false}>{right}</text>
      </box>
      {oneRow ? (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1, columnGap: 3 }}>{ROLES.map(groupFor)}</box>
      ) : (
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
          {groupFor("researcher")}
          <box style={{ flexDirection: "row", height: 1, columnGap: 3 }}>{groupFor("critic")}{groupFor("finalizer")}</box>
        </box>
      )}
      {widths === null ? (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }}>
          {ROLES.map((role) => (
            <Chip key={role} label={` ${t(ROLE_KEY[role])} `} active={role === focusRole} onClick={() => view.focusRole(summary, role)} />
          ))}
        </box>
      ) : null}
      <box style={{ flexDirection: "row", flexGrow: 1, marginTop: 1 }}>
        {roles.map((role) => {
          const agent = view.agentOf(summary, role);
          if (agent === null) return null;
          const columnWidth = widths === null ? width : widths[role];
          return (
            <AgentColumn
              key={role}
              client={client}
              summary={summary}
              agent={agent}
              width={columnWidth}
              focused={role === focusRole}
              now={now}
              scrollRef={view.scrollRefs[role]}
              labelFor={labelFor}
              homeDir={homeDir}
              tick={tick}
              onFocus={() => view.focusRole(summary, role)}
            />
          );
        })}
      </box>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <OverflowText fg={COLOR.faint} selectable={false} width={Math.max(8, width - t("run.lead").length - 3)}>{t("run.keys")}</OverflowText>
        <text
          fg={leadHover.hovered ? COLOR.bright : COLOR.accent}
          selectable={false}
          onMouseDown={onOpenLead}
          {...leadHover.handlers}
        >
          {`  ${t("run.lead")}`}
        </text>
      </box>
    </box>
  );
}

