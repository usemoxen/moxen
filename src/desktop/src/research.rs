//! Research mode: the run-size question (`research.proposals`,
//! `research.proposal.answer`), the run view and role transcripts
//! (`research.run`, `research.role.*`). The decoding follows the server's
//! shapes (`src/core/threads/types.ts`, `src/server/protocol.ts`); the sizes,
//! roster and column rules are the TUI's (`src/tui/model/researchpicker.ts`,
//! `src/tui/model/researchrun.ts`), and the panel and run view say the TUI's
//! words (`src/tui/i18n/en.ts`).

use serde_json::Value;

/// How many researchers a run holds in total: 1 to 8.
pub const MAX_RESEARCHERS: usize = 8;
/// Critics come as one of two choices (never 2).
pub const CRITIC_COUNTS: [usize; 2] = [1, 3];

/// A run's size, as the server and the answer carry it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResearchSize {
    pub researchers: usize,
    pub critics: usize,
}

/// The model one role runs on, when the proposal names it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoleModel {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn decode_size(value: &Value) -> ResearchSize {
    ResearchSize {
        researchers: value["researchers"].as_u64().unwrap_or(1) as usize,
        critics: value["critics"].as_u64().unwrap_or(1) as usize,
    }
}

fn decode_role_model(value: &Value) -> Option<RoleModel> {
    let provider = text(&value["provider"]);
    let model = text(&value["model"]);
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let effort = match text(&value["thinkingEffort"]) {
        "" => None,
        effort => Some(effort.to_string()),
    };
    Some(RoleModel {
        provider: provider.to_string(),
        model: model.to_string(),
        effort,
    })
}

/// The server's run-size question for one thread.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResearchProposal {
    pub id: String,
    pub thread_id: String,
    pub task: String,
    pub size: ResearchSize,
    pub models: [Option<RoleModel>; 3],
    /// The proposal's models object as received, answered back untouched.
    pub models_raw: Option<Value>,
    pub lead_provider: String,
    pub lead_model: String,
}

impl ResearchProposal {
    /// The question the server asked, if it named this thread.
    pub fn decode(value: &Value) -> Option<Self> {
        let id = text(&value["id"]);
        let thread_id = text(&value["threadId"]);
        if id.is_empty() || thread_id.is_empty() {
            return None;
        }
        let models = value["plan"]["models"].clone();
        Some(Self {
            id: id.to_string(),
            thread_id: thread_id.to_string(),
            task: text(&value["task"]).to_string(),
            size: decode_size(&value["plan"]["size"]),
            models: [
                decode_role_model(&models["researcher"]),
                decode_role_model(&models["critic"]),
                decode_role_model(&models["finalizer"]),
            ],
            models_raw: models.is_object().then(|| models.clone()),
            lead_provider: text(&value["leadModel"]["instanceId"]).to_string(),
            lead_model: text(&value["leadModel"]["model"]).to_string(),
        })
    }

    pub fn role_model(&self, role: ResearchRole) -> Option<&RoleModel> {
        self.models[role as usize].as_ref()
    }

    /// The `plan` of a `research.proposal.answer`: the picked size and the
    /// proposal's own models, as the TUI answers it.
    pub fn answer_plan(&self, size: ResearchSize) -> Value {
        let mut plan = serde_json::json!({ "size": { "researchers": size.researchers, "critics": size.critics } });
        if let Some(models) = &self.models_raw {
            plan["models"] = models.clone();
        }
        plan
    }
}

/// The focused row of the size picker.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PickerRow {
    #[default]
    Researchers,
    Critics,
}

/// The picker's state: researchers as a total, critics as one of two
/// choices. Pure, so the keys and clicks it answers can be pinned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickerState {
    pub size: ResearchSize,
    pub row: PickerRow,
}

/// Clamps whatever the proposal suggested to a size the server accepts.
pub fn initial_picker(size: ResearchSize) -> PickerState {
    PickerState {
        size: ResearchSize {
            researchers: size.researchers.clamp(1, MAX_RESEARCHERS),
            critics: if CRITIC_COUNTS.contains(&size.critics) {
                size.critics
            } else if size.critics > 1 {
                3
            } else {
                1
            },
        },
        row: PickerRow::Researchers,
    }
}

/// Left or right on the focused row: researchers step by one, critics jump
/// between their two choices.
pub fn step_picker(mut state: PickerState, direction: i32) -> PickerState {
    match state.row {
        PickerRow::Researchers => {
            let next = state.size.researchers as i32 + direction;
            state.size.researchers = next.clamp(1, MAX_RESEARCHERS as i32) as usize;
        }
        PickerRow::Critics => {
            let at = CRITIC_COUNTS
                .iter()
                .position(|count| *count == state.size.critics)
                .unwrap_or(0) as i32;
            let next = (at + direction).clamp(0, CRITIC_COUNTS.len() as i32 - 1) as usize;
            state.size.critics = CRITIC_COUNTS[next];
        }
    }
    state
}

pub fn set_researchers(mut state: PickerState, researchers: usize) -> PickerState {
    state.row = PickerRow::Researchers;
    state.size.researchers = researchers.clamp(1, MAX_RESEARCHERS);
    state
}

pub fn set_critics(mut state: PickerState, critics: usize) -> PickerState {
    if CRITIC_COUNTS.contains(&critics) {
        state.row = PickerRow::Critics;
        state.size.critics = critics;
    }
    state
}

pub fn move_row(mut state: PickerState, direction: i32) -> PickerState {
    state.row = match (state.row, direction < 0) {
        (PickerRow::Researchers, false) | (PickerRow::Critics, true) => PickerRow::Critics,
        _ => PickerRow::Researchers,
    };
    state
}

/// Threads the run opens: the lead, every researcher and critic, and one
/// finalizer.
pub fn thread_count(size: ResearchSize) -> usize {
    1 + size.researchers + size.critics + 1
}

/// One role of a run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ResearchRole {
    #[default]
    Researcher,
    Critic,
    Finalizer,
}

pub const ROLES: [ResearchRole; 3] = [
    ResearchRole::Researcher,
    ResearchRole::Critic,
    ResearchRole::Finalizer,
];

impl ResearchRole {
    pub fn label(self) -> &'static str {
        match self {
            Self::Researcher => crate::language::message("run.role.researchers"),
            Self::Critic => crate::language::message("run.role.critics"),
            Self::Finalizer => crate::language::message("run.role.finalizer"),
        }
    }
}

/// What one agent of the roster is doing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AgentState {
    #[default]
    Waiting,
    Working,
    Done,
    Failed,
    Stopped,
}

impl AgentState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Waiting => crate::language::message("run.state.waiting"),
            Self::Working => crate::language::message("run.state.working"),
            Self::Done => crate::language::message("run.state.done"),
            Self::Failed => crate::language::message("run.state.failed"),
            Self::Stopped => crate::language::message("run.state.stopped"),
        }
    }

    /// The state glyph, as the TUI's run view draws it (the spinner turns
    /// while it works; the view picks the frame).
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Working => "◐",
            Self::Done => "✓",
            Self::Failed => "✗",
            Self::Stopped => "■",
            Self::Waiting => "○",
        }
    }
}

/// One agent in a column: the thread it runs in, once started.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunAgent {
    pub role: ResearchRole,
    /// 1-based place among its role's agents.
    pub index: usize,
    /// Null for a slot of the chosen size that has not started yet.
    pub thread_id: Option<String>,
    pub title: String,
    pub state: AgentState,
    pub question: Option<String>,
    /// A critic's review: all three when the run has one critic, else its own.
    pub lens: Option<String>,
}

/// What the run is doing, as the header says it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RunPhase {
    #[default]
    Planning,
    Researching,
    Reviewing,
    Finalizing,
    Finished,
    Failed,
    Stopped,
}

impl RunPhase {
    pub fn label(self) -> &'static str {
        match self {
            Self::Planning => crate::language::message("run.phase.planning"),
            Self::Researching => crate::language::message("run.phase.researching"),
            Self::Reviewing => crate::language::message("run.phase.reviewing"),
            Self::Finalizing => crate::language::message("run.phase.finalizing"),
            Self::Finished => crate::language::message("run.phase.finished"),
            Self::Failed => crate::language::message("run.phase.failed"),
            Self::Stopped => crate::language::message("run.phase.stopped"),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunSummary {
    pub lead_thread_id: String,
    pub title: String,
    pub state: String,
    pub ended: bool,
    pub created_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    pub size: ResearchSize,
    /// The user-approved model each role runs on, as the run record carries
    /// it (`models` on a `research.run` answer). A role the plan leaves to
    /// the lead's model has none.
    pub models: [Option<RoleModel>; 3],
    pub agents: [Vec<RunAgent>; 3],
}

impl RunSummary {
    pub fn phase(&self) -> RunPhase {
        if self.ended {
            return match self.state.as_str() {
                "failed" => RunPhase::Failed,
                "interrupted" => RunPhase::Stopped,
                _ => RunPhase::Finished,
            };
        }
        let started = |role: ResearchRole| {
            self.agents[role as usize]
                .iter()
                .any(|agent| agent.state != AgentState::Waiting)
        };
        if started(ResearchRole::Finalizer) {
            RunPhase::Finalizing
        } else if started(ResearchRole::Critic) {
            RunPhase::Reviewing
        } else if started(ResearchRole::Researcher) {
            RunPhase::Researching
        } else {
            RunPhase::Planning
        }
    }
}

/// A reference to one agent in the roster, by role and 0-based place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentRef {
    pub role: ResearchRole,
    pub index: usize,
}

fn agent_state_of(session: &str, turn: &str) -> AgentState {
    if session.is_empty() {
        return AgentState::Working;
    }
    // The TUI treats a role thread with a session but no latest turn as
    // working (`agentStateOf` returns "working" when `!turn`).
    if turn.is_empty() {
        return AgentState::Working;
    }
    match session {
        "running" | "starting" => AgentState::Working,
        _ => match turn {
            "running" => AgentState::Working,
            "completed" => AgentState::Done,
            "error" => AgentState::Failed,
            _ => AgentState::Stopped,
        },
    }
}

fn lens_of(critics: usize, index: usize) -> String {
    if critics == 1 {
        return "all three reviews".to_string();
    }
    ["Evidence", "Risks", "Alternatives"][index % 3].to_string()
}

fn slots_for(role: ResearchRole, size: ResearchSize, started: usize, ended: bool) -> usize {
    if ended {
        return started.max(1);
    }
    match role {
        ResearchRole::Finalizer => started.max(1),
        ResearchRole::Researcher => started.max(size.researchers.max(1)),
        ResearchRole::Critic => started.max(size.critics.max(1)),
    }
}

/// A role thread of a `research.run` answer: its id, role, question and the
/// thread's own state.
pub struct RoleRow {
    pub thread_id: String,
    pub role: &'static str,
    pub question: String,
    pub session: String,
    pub turn: String,
}

fn agent_title(role: ResearchRole, index: usize, critics: usize) -> String {
    match role {
        ResearchRole::Finalizer => "Finalizer".to_string(),
        ResearchRole::Researcher => format!("Researcher {}", index + 1),
        ResearchRole::Critic => {
            if critics == 1 {
                "Critic".to_string()
            } else {
                format!("Critic {}", index + 1)
            }
        }
    }
}

/// Projects a `research.run` answer into what the run view draws: the run
/// record's roles and chosen size, in roster order.
pub fn summarize_run(
    run: &Value,
    lead_title: &str,
    roles: impl IntoIterator<Item = RoleRow>,
    titles: &dyn Fn(&str) -> Option<String>,
) -> Option<RunSummary> {
    let lead_thread_id = text(&run["leadThreadId"]);
    if lead_thread_id.is_empty() {
        return None;
    }
    let size = decode_size(&run["size"]);
    let state = text(&run["state"]);
    let ended = run["endedAt"].is_string() || state != "running";
    let started: Vec<RoleRow> = roles.into_iter().collect();
    let critics = size.critics.max(1);
    let mut agents: [Vec<RunAgent>; 3] = [vec![], vec![], vec![]];
    for (at, role) in ROLES.iter().enumerate() {
        let role_name = match role {
            ResearchRole::Researcher => "researcher",
            ResearchRole::Critic => "critic",
            ResearchRole::Finalizer => "finalizer",
        };
        let entries: Vec<&RoleRow> = started.iter().filter(|row| row.role == role_name).collect();
        let slots = slots_for(*role, size, entries.len(), ended);
        agents[at] = (0..slots)
            .map(|index| {
                let entry = entries.get(index);
                let title = entry
                    .and_then(|row| titles(&row.thread_id))
                    .unwrap_or_default();
                RunAgent {
                    role: *role,
                    index: index + 1,
                    thread_id: entry.map(|row| row.thread_id.clone()),
                    title: if title.is_empty() {
                        agent_title(*role, index, critics)
                    } else {
                        title
                    },
                    state: match entry {
                        Some(row) => agent_state_of(&row.session, &row.turn),
                        None => AgentState::Waiting,
                    },
                    question: entry.map(|row| row.question.clone()),
                    lens: (*role == ResearchRole::Critic).then(|| lens_of(critics, index)),
                }
            })
            .collect();
    }
    Some(RunSummary {
        lead_thread_id: lead_thread_id.to_string(),
        title: lead_title.to_string(),
        state: state.to_string(),
        ended,
        created_at: text(&run["createdAt"]).to_string(),
        updated_at: text(&run["updatedAt"]).to_string(),
        ended_at: match text(&run["endedAt"]) {
            "" => None,
            at => Some(at.to_string()),
        },
        size,
        models: [
            decode_role_model(&run["models"]["researcher"]),
            decode_role_model(&run["models"]["critic"]),
            decode_role_model(&run["models"]["finalizer"]),
        ],
        agents,
    })
}

/// How long the run has been going, or took, in milliseconds. Frozen once it
/// ended.
pub fn run_elapsed_ms(summary: &RunSummary, now_ms: i64) -> i64 {
    let start = crate::live::parse_iso_ms(&summary.created_at).unwrap_or(now_ms);
    let end = if summary.ended {
        summary
            .ended_at
            .as_deref()
            .and_then(crate::live::parse_iso_ms)
            .unwrap_or_else(|| crate::live::parse_iso_ms(&summary.updated_at).unwrap_or(now_ms))
    } else {
        now_ms
    };
    (end - start).max(0)
}

/// The agent a column shows before anyone picked one: the one at work, else
/// the last one to finish, else the first slot.
pub fn default_agent_index(summary: &RunSummary, role: ResearchRole) -> usize {
    let list = &summary.agents[role as usize];
    if let Some(working) = list
        .iter()
        .position(|agent| agent.state == AgentState::Working)
    {
        return working;
    }
    for (at, agent) in list.iter().enumerate().rev() {
        if agent.state != AgentState::Waiting {
            return at;
        }
    }
    0
}

/// The role the phase is about: the column that is wide.
pub fn focus_role_of(summary: &RunSummary) -> ResearchRole {
    match summary.phase() {
        RunPhase::Planning | RunPhase::Researching => ResearchRole::Researcher,
        RunPhase::Reviewing => ResearchRole::Critic,
        RunPhase::Finalizing => ResearchRole::Finalizer,
        _ => {
            if summary.agents[ResearchRole::Finalizer as usize]
                .iter()
                .any(|agent| agent.state != AgentState::Waiting)
            {
                ResearchRole::Finalizer
            } else if summary.agents[ResearchRole::Critic as usize]
                .iter()
                .any(|agent| agent.state != AgentState::Waiting)
            {
                ResearchRole::Critic
            } else {
                ResearchRole::Researcher
            }
        }
    }
}

/// The roster as one row: researchers, then critics, then the finalizer.
pub fn roster_of(summary: &RunSummary) -> Vec<AgentRef> {
    ROLES
        .iter()
        .flat_map(|role| {
            (0..summary.agents[*role as usize].len()).map(|index| AgentRef { role: *role, index })
        })
        .collect()
}

/// One step through the roster, wrapping at the ends.
pub fn step_agent(summary: &RunSummary, from: AgentRef, direction: i32) -> AgentRef {
    let roster = roster_of(summary);
    if roster.is_empty() {
        return from;
    }
    let at = roster.iter().position(|entry| *entry == from).unwrap_or(0) as i32;
    roster[((at + direction).rem_euclid(roster.len() as i32)) as usize]
}

/// The role to step to from `role`, wrapping: the view's Tab.
pub fn step_role(role: ResearchRole, direction: i32) -> ResearchRole {
    let at = ROLES.iter().position(|entry| *entry == role).unwrap_or(0) as i32;
    ROLES[(at + direction).rem_euclid(ROLES.len() as i32) as usize]
}

/// Below this width the run view shows one column at a time under a switcher.
pub const NARROW_BELOW: f32 = 480.0;

#[cfg(test)]
mod tests {
    // Not a glob: `gpui::test` would shadow `#[test]`.
    use super::{
        AgentRef, MAX_RESEARCHERS, PickerRow, ResearchRole, ResearchSize, RunSummary,
        agent_state_of, focus_role_of, initial_picker, lens_of, move_row, set_critics,
        set_researchers, step_agent, step_picker, step_role, summarize_run, thread_count,
    };
    use serde_json::json;

    fn summary_for_test() -> RunSummary {
        let run = json!({
            "leadThreadId": "lead", "state": "running",
            "size": { "researchers": 2, "critics": 3 },
            "createdAt": "2026-11-16T10:00:00Z", "updatedAt": "2026-11-16T10:01:00Z",
            "roles": [
                {"threadId": "r1", "role": "researcher", "question": "Survey"},
                {"threadId": "c1", "role": "critic", "question": "Review"},
            ],
        });
        summarize_run(
            &run,
            "Lead",
            vec![
                super::RoleRow {
                    thread_id: "r1".into(),
                    role: "researcher",
                    question: "Survey".into(),
                    session: "idle".into(),
                    turn: "completed".into(),
                },
                super::RoleRow {
                    thread_id: "c1".into(),
                    role: "critic",
                    question: "Review".into(),
                    session: "running".into(),
                    turn: "running".into(),
                },
            ],
            &|_| None,
        )
        .expect("summary")
    }

    #[test]
    fn clamps_the_proposal_to_a_size_the_server_accepts() {
        let clamped = initial_picker(ResearchSize {
            researchers: 99,
            critics: 2,
        });
        assert_eq!(
            clamped.size,
            ResearchSize {
                researchers: MAX_RESEARCHERS,
                critics: 3
            }
        );
        assert_eq!(clamped.row, PickerRow::Researchers);
    }

    #[test]
    fn the_picker_steps_researchers_and_jumps_critics() {
        let state = initial_picker(ResearchSize {
            researchers: 2,
            critics: 1,
        });
        let stepped = step_picker(step_picker(state, 1), 1);
        assert_eq!(stepped.size.researchers, 4);
        let critics = step_picker(
            super::PickerState {
                row: PickerRow::Critics,
                ..stepped
            },
            1,
        );
        assert_eq!(critics.size.critics, 3);
        assert_eq!(set_critics(critics, 2).size.critics, 3);
        assert_eq!(set_researchers(critics, 0).size.researchers, 1);
        assert_eq!(move_row(state, 1).row, PickerRow::Critics);
    }

    #[test]
    fn a_run_opens_one_thread_more_than_its_agents() {
        assert_eq!(
            thread_count(ResearchSize {
                researchers: 2,
                critics: 1
            }),
            5
        );
    }

    #[test]
    fn critics_share_one_lens_or_take_one_each() {
        assert_eq!(lens_of(1, 2), "all three reviews");
        assert_eq!(lens_of(3, 3), "Evidence");
    }

    #[test]
    fn stepping_walks_the_roster_and_wraps() {
        let summary = summary_for_test();
        let first = AgentRef {
            role: ResearchRole::Researcher,
            index: 0,
        };
        let last = step_agent(&summary, first, -1);
        assert_eq!(last.role, ResearchRole::Finalizer);
        assert_eq!(step_role(ResearchRole::Critic, 1), ResearchRole::Finalizer);
        assert_eq!(
            step_role(ResearchRole::Researcher, -1),
            ResearchRole::Finalizer
        );
    }

    #[test]
    fn the_phase_names_the_column_in_focus() {
        let summary = summary_for_test();
        assert_eq!(summary.phase(), super::RunPhase::Reviewing);
        assert_eq!(focus_role_of(&summary), ResearchRole::Critic);
    }

    #[test]
    fn the_run_carries_each_role_model() {
        let mut run = serde_json::json!({
            "leadThreadId": "lead", "state": "running",
            "size": { "researchers": 1, "critics": 1 },
            "createdAt": "2026-11-16T10:00:00Z", "updatedAt": "2026-11-16T10:01:00Z",
            "models": {
                "researcher": {"provider": "claude", "model": "opus", "thinkingEffort": "medium"},
                "critic": {"provider": "claude", "model": "opus", "thinkingEffort": "high"},
            },
            "roles": [],
        });
        let summary = summarize_run(&run, "Lead", vec![], &|_| None).expect("summary");
        assert_eq!(
            summary.models[0].as_ref().map(|model| model.effort.clone()),
            Some(Some("medium".to_string()))
        );
        assert_eq!(
            summary.models[1].as_ref().map(|model| model.effort.clone()),
            Some(Some("high".to_string()))
        );
        assert_eq!(summary.models[2], None);
        // A run that names no models leaves every role on the lead's.
        run.as_object_mut().expect("run").remove("models");
        let summary = summarize_run(&run, "Lead", vec![], &|_| None).expect("summary");
        assert_eq!(summary.models, [None, None, None]);
    }

    #[test]
    fn a_role_thread_with_a_session_but_no_turn_is_working() {
        // The TUI's `agentStateOf` returns "working" when there is no latest
        // turn; a session that has started but not yet turned must not read
        // as stopped.
        assert_eq!(agent_state_of("idle", ""), super::AgentState::Working);
    }
}
