pub use crate::catalog::{CatalogState, Selection};
pub use crate::git::{Git, Patch, TurnDiff};
pub use crate::research::{
    AgentRef, AgentState, PickerRow, PickerState, ResearchProposal, ResearchRole, ResearchSize,
    RoleModel, RunAgent, RunPhase, RunSummary,
};
pub use crate::research::{
    ROLES, default_agent_index, focus_role_of, initial_picker, move_row, run_elapsed_ms,
    set_critics, set_researchers, step_agent, step_picker, step_role, thread_count,
};
pub use crate::search::{SearchHit, SearchResult, SearchResults, SearchState};
pub use crate::settings::{
    Discovery, Embeddings, HarnessRun, ManagedSkill, MemoryDraft, MemoryEntry, MemoryList,
    MemorySearch, RemoteState, SettingsNotice, Snapshot, UpdateState,
};
pub use crate::stats::{CardState, StatsData, StatsRange, StatsState};
pub use crate::usage::{ContextData, Hold, LimitsData, ProtectionData, QueueMove, SnapshotUsage};
use crate::work::{Delegated, InspectorData, Read, View};
use crate::{
    attachments::{Picture, Prompt, Thumbnail},
    composer_menu::{Destination, Improvement, Inventory},
};
use std::sync::Arc;

pub type ThreadId = usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    Idle,
    Error,
    Held,
    Queued,
    Snoozed,
}
impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "Working",
            Self::Idle => "Done",
            Self::Error => "Stuck",
            Self::Held => "Your turn",
            Self::Queued => "Up next",
            Self::Snoozed => "Snoozed",
        }
    }
    pub fn token(self) -> &'static str {
        match self {
            Self::Running => "live",
            Self::Idle => "ink-2",
            Self::Error => "broken",
            Self::Held => "held",
            Self::Queued => "ink-2",
            Self::Snoozed => "ink-2",
        }
    }
    pub fn icon(self) -> &'static str {
        match self {
            Self::Running => "state-running",
            Self::Idle => "check",
            Self::Error => "x",
            Self::Held => "state-held",
            Self::Queued => "circle",
            Self::Snoozed => "clock",
        }
    }
}
#[derive(Clone)]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub model: String,
    pub status: Status,
    pub activity: String,
    pub project: String,
    pub depth: usize,
    pub settled: bool,
    pub started_at: Option<std::time::Instant>,
    /// What the agent may do without asking: `approval-required`,
    /// `auto-accept-edits`, `auto` or `full-access`.
    pub runtime_mode: String,
    /// `default`, `research`, `orchestrate` or `review`.
    pub interaction_mode: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    User {
        text: String,
        images: Vec<Thumbnail>,
    },
    Assistant {
        text: String,
        /// When it was written, as the header shows it ("Thu 09:38").
        at: String,
    },
    /// One step of the agent's run: a command, a read, an edit, a thought or
    /// another tool call.
    Tool {
        /// `command`, `read`, `edit`, `thought` or `tool`.
        name: String,
        summary: String,
        output: String,
        /// The right-hand column: how long it took, lines read, or lines changed.
        meta: String,
        failed: bool,
        running: bool,
    },
    /// A plan the agent proposed, to read before it starts work.
    Plan {
        /// The plan as markdown.
        text: String,
        /// Work on it has begun.
        implemented: bool,
        /// When it was proposed, as the header shows it.
        at: String,
    },
    /// The provider stopped the turn at its usage limit, or is wrapping up
    /// before it does: the record of when it happened and when it lifts.
    UsageLimit {
        /// The window the provider stopped on ("Session", say); none names no window.
        label: Option<String>,
        /// When the window resets, as the server wrote it; none resets when allowed.
        resets_at: Option<String>,
        /// Still finishing the step rather than stopped.
        wrap_up: bool,
        /// When it happened, as the header shows it.
        at: String,
    },
    /// Moxen's own "delegated tasks settled" card: never the raw block the
    /// stored message carries (`origin: task-notification`).
    TaskNotification {
        tasks: Vec<TaskNotice>,
        /// When it landed, as the header shows it.
        at: String,
    },
    /// Shared usage is nearly exhausted: the wrap-up notice, never the
    /// maintenance prompt itself.
    UsageProtection {
        /// When it landed, as the header shows it.
        at: String,
    },
    /// Recovery reads as a quiet line; the model's maintenance instructions
    /// stay private.
    Continued {
        kind: ContinuedKind,
        /// When it landed, as the header shows it.
        at: String,
    },
}

/// One settled delegated task, as a task-notification message carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskNotice {
    pub task_id: String,
    /// `Delegated task` when the notice names none.
    pub title: String,
    /// `completed`, `failed`, `cancelled`, `interrupted` or `running`.
    pub status: String,
    pub duration_ms: Option<i64>,
    pub model: Option<String>,
    pub branch: Option<String>,
    pub headline: Option<String>,
    /// Files changed, with additions and deletions.
    pub files: Option<(i64, i64, i64)>,
    pub verdict: Option<String>,
    pub review: bool,
    pub resumes_at: Option<String>,
    pub cancelled: bool,
    /// The provider's own subagent, not a delegated thread.
    pub native: bool,
}

/// What a recovery line says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContinuedKind {
    Handoff,
    Background,
    UsageReset,
}
pub struct Reply {
    pub message: usize,
    pub words: Vec<String>,
}

/// Whether the source has reached the Moxen server. The mock is always live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Connection {
    Connecting,
    Starting,
    Live,
    /// The server could not be reached, or hung up; the text says why.
    Failed(String),
}

/// What a message sent while a turn runs does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Lands at the running turn's next step.
    Steer,
    /// Waits and runs once the turn ends.
    Queue,
}

/// One message waiting for its turn, in the order it will run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Queued {
    /// Names it to the source (a turn id).
    pub key: String,
    pub text: String,
    pub images: Vec<Thumbnail>,
    /// Kept back until released.
    pub held: bool,
    /// When a scheduled send goes out, as the server wrote it.
    pub scheduled: Option<String>,
    /// How many places it can move earlier or later.
    pub earlier: usize,
    pub later: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueEdit {
    Earlier,
    Later,
    Hold,
    Release,
    /// Take it back without sending it.
    Remove,
}

/// A place a thread can be started in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub title: String,
}

/// The first message of a new thread and where and how it runs.
#[derive(Clone, Debug)]
pub struct NewThread {
    pub project: Option<String>,
    pub prompt: Prompt,
    /// `None` leaves it to the server's setting.
    pub runtime_mode: Option<String>,
    pub interaction_mode: String,
    /// The model picked for it; `None` starts it on the project's model, or
    /// the server's default.
    pub model: Option<Selection>,
}

/// Something the source could not do, to tell the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub message: String,
    /// A message that did not go out, to put back where it was written:
    /// the thread's draft, or the new-thread draft when there is none.
    pub unsent: Option<(Option<ThreadId>, Prompt)>,
}

/// How a pull request is merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeStrategy {
    Squash,
    /// A merge commit.
    Merge,
}
impl MergeStrategy {
    /// The value the server's `forge.request.merge` reads.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Squash => "squash",
            Self::Merge => "merge",
        }
    }
}

/// A pull request or merge request to open by hand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRequest {
    pub title: String,
    pub draft: bool,
    /// The branch it merges into; `None` leaves it to the forge's default.
    pub base: Option<String>,
}

/// A tool the running turn is parked on until it is allowed or denied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Permission {
    pub request: String,
    pub tool: String,
    /// `command-execution`, `file-change` or `file-read`: picks the wording.
    pub classification: Option<String>,
    /// The command, path or address the tool would act on.
    pub detail: Option<String>,
    /// The agent's own reason, when the tool carries one.
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Allow, and the same tool for the rest of the session.
    AllowSession,
    Deny,
}
impl Decision {
    /// The value the server's `thread.permission.respond` reads.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Allow => "accept",
            Self::AllowSession => "accept-session",
            Self::Deny => "decline",
        }
    }
}

/// One answer the agent offers to a question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    pub description: Option<String>,
    /// What is sent back; the label when the agent gave none.
    pub value: String,
    /// Markdown shown while the choice is highlighted.
    pub preview: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub text: String,
    pub choices: Vec<Choice>,
    pub multi: bool,
    /// Whether the person may write an answer of their own.
    pub custom: bool,
}

/// Questions the agent is waiting on, answered together.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub request: String,
    pub questions: Vec<Question>,
}

/// What was answered to one question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    One(String),
    Many(Vec<String>),
}

pub const RUNTIME_MODES: [(&str, &str); 4] = [
    ("approval-required", "Ask first"),
    ("auto-accept-edits", "Accept edits"),
    ("auto", "Auto"),
    ("full-access", "Full access"),
];
pub const INTERACTION_MODES: [(&str, &str); 4] = [
    ("default", "Build"),
    ("research", "Research"),
    ("orchestrate", "Orchestrate"),
    ("review", "Review"),
];

/// The label for a runtime or interaction mode value.
pub fn mode_label(table: &[(&'static str, &'static str)], value: &str) -> String {
    table
        .iter()
        .find(|(v, _)| *v == value)
        .map_or_else(|| value.to_string(), |(_, label)| label.to_string())
}

pub trait ThreadSource {
    fn thread_action(&mut self, _: ThreadId, _: ThreadAction) {}
    fn action_pending(&self, _: ThreadId) -> bool {
        false
    }
    fn has_family_work(&self, _: ThreadId) -> bool {
        false
    }
    fn take_settled(&mut self) -> Option<ThreadId> {
        None
    }
    fn archived(&self) -> Vec<(String, String)> {
        vec![]
    }
    fn restore_thread(&mut self, _: &str) {}
    fn side_question_pending(&self) -> bool {
        false
    }
    fn has_side_answer(&self, _: ThreadId) -> bool {
        false
    }
    fn read_side_answer(&mut self, _: ThreadId, _only_unread: bool) -> Option<String> {
        None
    }
    fn revert_before(&self, _: ThreadId, _: usize) -> Option<usize> {
        None
    }
    fn take_reverted(&mut self) -> Option<(ThreadId, Option<String>)> {
        None
    }
    fn usage_reset(&self, _: ThreadId) -> Option<String> {
        None
    }
    fn scheduled_continue(&self, _: ThreadId) -> bool {
        false
    }
    fn notifies_parent(&self, _: ThreadId) -> bool {
        false
    }
    fn is_protected(&self, _: ThreadId) -> bool {
        false
    }
    fn is_snoozed(&self, id: ThreadId) -> bool {
        self.list_threads()
            .get(id)
            .is_some_and(|thread| thread.status == Status::Snoozed)
    }
    fn can_handover(&self, _: ThreadId) -> bool {
        false
    }
    /// Thread ids in sidebar order. With `by_project` a project's threads are
    /// contiguous, projects newest first. Gone threads are left out; their ids
    /// stay valid for the life of the source. The mock's fixtures are already
    /// in order.
    fn order(&self, _by_project: bool) -> Vec<ThreadId> {
        (0..self.list_threads().len()).collect()
    }
    /// Whether a row is in the settled section, or absent from the sidebar.
    fn sidebar_section(&self, id: ThreadId) -> Option<bool> {
        self.list_threads().get(id).map(|thread| thread.settled)
    }
    /// Whether the transcript, inspector and status line are fixtures. A live
    /// source leaves out what it cannot yet fill rather than show made-up numbers.
    fn preview(&self) -> bool {
        true
    }
    fn connection(&self) -> Connection {
        Connection::Live
    }
    fn paired_name(&self) -> Option<String> {
        None
    }
    fn client_locale(&self) -> Option<String> {
        None
    }
    fn restart_required(&self) -> bool {
        false
    }
    fn experience(&self) -> Option<Arc<Result<serde_json::Value, String>>> {
        None
    }
    fn update_experience(&mut self, _change: serde_json::Value) {}
    fn experience_saving(&self) -> bool {
        false
    }
    fn set_guide_memory(&mut self, _choice: crate::experience::Memory) {}
    fn add_guide_project(&mut self, path: String) {
        self.add_project(path);
    }
    fn records(&self) -> Vec<crate::experience::Record> {
        Vec::new()
    }
    fn read_records(&mut self) {}
    fn fix_record(&mut self, _fix: crate::experience::Fix) {}
    fn diagnosis(&self) -> Option<Arc<Result<serde_json::Value, String>>> {
        None
    }
    fn read_diagnosis(&mut self) {}
    fn app_update(&self) -> Option<crate::experience::Update> {
        None
    }
    /// Changes whenever the source's data does, so the window knows to redraw.
    fn revision(&self) -> u64 {
        0
    }
    /// Reconnects after a failure.
    fn retry(&mut self) {}
    fn queued(&self, id: ThreadId) -> Vec<Queued>;
    /// Takes a waiting message back and returns its text, to edit it.
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<Prompt>;
    /// The thread the wire id names, for opening a search result.
    fn thread_at_uuid(&self, _uuid: &str) -> Option<ThreadId> {
        None
    }
    fn edit_queued(&mut self, id: ThreadId, key: &str, edit: QueueEdit);
    /// Stops the running turn so the waiting message goes next.
    fn send_queued_now(&mut self, id: ThreadId, key: &str) -> Option<Reply>;
    fn inspector(&self, _: ThreadId) -> Arc<InspectorData> {
        Arc::default()
    }
    fn children(&self, _: ThreadId) -> Vec<ThreadId> {
        vec![]
    }
    fn delegated(&self, _: ThreadId) -> Option<Delegated> {
        None
    }
    fn read_work(&mut self, _: ThreadId, _: Read) {}
    fn work(&self, _: ThreadId, _: &Read) -> Option<Arc<Result<View, String>>> {
        None
    }
    fn stop_background(&mut self, _: ThreadId, _task: &str) {}
    fn cancel_task(&mut self, _: ThreadId, _notify_parent: bool) {}
    fn list_threads(&self) -> Vec<Thread>;
    fn messages(&self, id: ThreadId) -> std::sync::Arc<Vec<Message>>;
    /// What the Git tab shows for a thread: its checkout, branches, history,
    /// and the pull request with its CI.
    fn git(&self, _: ThreadId) -> std::sync::Arc<Git> {
        std::sync::Arc::default()
    }
    /// Reads git and the forge again, for the history of `branch` (the
    /// checked-out one when `None`).
    fn read_git(&mut self, _: ThreadId, _branch: Option<String>) {}
    /// Opens a commit of the history in full.
    fn open_commit(&mut self, _: ThreadId, _sha: &str) {}
    fn close_commit(&mut self, _: ThreadId) {}
    /// Opens a request on the forge. It is visible to others at once, so the
    /// caller confirms with the person first.
    fn create_request(&mut self, _: ThreadId, _: NewRequest) {}
    fn comment_on_request(&mut self, _: ThreadId, _number: i64, _body: String) {}
    fn merge_request(&mut self, _: ThreadId, _number: i64, _: MergeStrategy) {}
    /// The turns of a thread that changed files, oldest first.
    fn turn_diffs(&self, _: ThreadId) -> Vec<TurnDiff> {
        vec![]
    }
    /// What the Context tab and the status line show for a thread: the live
    /// breakdown and the last recorded reading, once read with `read_context`.
    fn context(&self, _: ThreadId) -> Option<Arc<ContextData>> {
        None
    }
    /// Reads the live breakdown and the last recorded reading.
    fn read_context(&mut self, _: ThreadId) {}
    /// The thread's recorded context totals, off its snapshot: what the
    /// status line reads without another query.
    fn snapshot_usage(&self, _: ThreadId) -> Option<SnapshotUsage> {
        None
    }
    /// The account's plan usage (`usage.limits`), once read with `read_limits`.
    fn limits(&self) -> Option<Arc<LimitsData>> {
        None
    }
    /// Reads the account's plan usage.
    fn read_limits(&mut self) {}
    /// Usage protection (`usage.protection`): the forecasts and the recovery
    /// queue, once read with `read_protection`.
    fn protection(&self) -> Option<Arc<ProtectionData>> {
        None
    }
    /// Reads usage protection.
    fn read_protection(&mut self) {}
    /// The open thread's own protection hold, off its snapshot.
    fn hold(&self, _: ThreadId) -> Option<Hold> {
        None
    }
    /// Asks the account to wrap up before its allowance runs out (`usage.wrap`).
    fn wrap_provider(&mut self, _: String) {}
    /// Moves or cancels one recovery-queue entry (`usage.queue`).
    fn queue_protection(&mut self, _: String, _: QueueMove) {}
    /// Usage stats for a range, once read with `read_stats`.
    fn stats(&self, _: StatsRange) -> Option<Arc<StatsState>> {
        None
    }
    /// Reads usage stats for a range.
    fn read_stats(&mut self, _: StatsRange) {}
    /// The shareable PNG card for a range, once read and saved with `read_card`.
    fn card(&self, _: StatsRange) -> Option<Arc<CardState>> {
        None
    }
    /// Reads the card and saves it where the person can find it.
    fn read_card(&mut self, _: StatsRange) {}
    /// One turn's patch, once asked for with `read_turn_patch`.
    fn turn_patch(&self, _: ThreadId, _turn: i64) -> Option<Patch> {
        None
    }
    fn read_turn_patch(&mut self, _: ThreadId, _turn: i64) {}
    /// What is uncommitted in the thread's checkout, once asked for.
    fn tree_patch(&self, _: ThreadId) -> Option<Patch> {
        None
    }
    fn read_tree_patch(&mut self, _: ThreadId) {}
    /// The thread the window is showing: a live source follows its transcript.
    fn focus(&mut self, _id: ThreadId) {}
    /// Sends `text`; `delivery` says what to do when a turn is running. A
    /// source that simulates its reply returns it.
    fn send_message(&mut self, id: ThreadId, prompt: Prompt, delivery: Delivery) -> Option<Reply>;
    fn composer_directory(&self, _: &Destination) -> Option<String> {
        None
    }
    fn read_skills(&mut self, _: &Destination, _: Option<&Selection>) {}
    fn skills(
        &self,
        _: &Destination,
        _: Option<&Selection>,
    ) -> Option<Arc<Result<Inventory, String>>> {
        None
    }
    fn read_image(&mut self, _: &Picture) {}
    fn image(&self, _: &Picture) -> Option<Result<Arc<gpui::Image>, String>> {
        None
    }
    fn improve(&mut self, _: Improvement) {}
    fn take_improvement(&mut self) -> Option<(Improvement, Option<String>)> {
        None
    }
    fn stop(&mut self, id: ThreadId);
    /// Where a new thread can start, newest project first.
    fn projects(&self) -> Vec<Project> {
        vec![]
    }
    /// The connection generation the search answer belongs to: the palette
    /// re-issues its query when it changes, so a reconnect never leaves a
    /// stale error or empty result.
    fn wire_epoch(&self) -> u64 {
        0
    }
    /// The project a thread belongs to, as the server lists it. The sidebar
    /// groups by this id (titles can repeat for two checkouts with the same
    /// basename); the title comes from `projects`.
    fn project_id(&self, id: ThreadId) -> Option<String> {
        let _ = id;
        None
    }
    /// Asks the server for threads holding `query` and reports the answer
    /// through `search_state` (`threads.search`, the TUI picker's semantics).
    fn search_threads(&mut self, _query: &str) {}
    /// What the last search answered, while the palette shows it.
    fn search_state(&self) -> SearchState {
        SearchState::Idle
    }
    /// Renames a project through the server (`project.rename`).
    fn rename_project(&mut self, _id: &str, _title: String) {}
    /// Removes a project through the server (`project.remove`).
    fn remove_project(&mut self, _id: &str) {}
    /// Which thread the server may ask this window for a run size
    /// (`subscribeShell`'s `researchProposals`): the focused thread while it
    /// can start one, none otherwise. Replaces the previous opt-in.
    fn watch_research(&mut self, _thread: Option<ThreadId>) {}
    /// The run-size question waiting for this thread, if the server asked.
    fn proposal(&self, _id: ThreadId) -> Option<ResearchProposal> {
        None
    }
    /// Answers the run-size question: `size` starts the run, `None` runs one
    /// researcher instead (`research.proposal.answer`).
    fn answer_proposal(&mut self, _id: ThreadId, _proposal: &str, _size: Option<ResearchSize>) {}
    /// Whether the thread leads a research run the shell lists.
    fn leads_run(&self, _id: ThreadId) -> bool {
        false
    }
    /// Reads the thread's research run and its role transcripts again.
    fn read_run(&mut self, _id: ThreadId) {}
    /// Holds one subscription per visible role thread while the run view
    /// shows it, with deltas, like the TUI's `useRoleTranscript`. Empty
    /// releases them.
    fn watch_roles(&mut self, _threads: Vec<String>) {}
    /// The thread's research run, once read (`research.run` projected like
    /// the TUI's run view).
    fn run_summary(&self, _id: ThreadId) -> Option<RunSummary> {
        None
    }
    /// One role thread's transcript, while its run view shows it.
    fn role_messages(&self, _thread: &str) -> Option<Arc<Vec<Message>>> {
        None
    }
    /// Whether a send parked the run-size question (`researchSizePending`):
    /// the next send asks for it, as the TUI's toast says.
    fn take_research_pending(&mut self) -> bool {
        false
    }
    /// Starts a thread with its first message; once it is listed,
    /// `take_opened` names it.
    fn create_thread(&mut self, _draft: NewThread) {}
    /// Adds the folder as a project and returns once it is known.
    fn add_project(&mut self, _path: String) {}
    /// The providers, models and efforts on offer.
    fn catalog(&self) -> CatalogState {
        CatalogState::Loading
    }
    /// Asks for the catalog again (a model may have been hidden since).
    fn refresh_catalog(&mut self) {}
    /// The model a thread runs on, once the source knows it.
    fn selection(&self, _id: ThreadId) -> Option<Selection> {
        None
    }
    /// The model a new thread in `project` starts on when none is chosen:
    /// the one its newest thread runs on.
    fn project_selection(&self, _project: &str) -> Option<Selection> {
        None
    }
    /// Changes the model of a thread.
    fn set_model(&mut self, _id: ThreadId, _selection: Selection) {}
    /// Changes how an idle thread runs.
    fn set_modes(&mut self, _id: ThreadId, _runtime: &str, _interaction: &str) {}
    /// The tool approval the thread's turn waits on, oldest first.
    fn permission(&self, _: ThreadId) -> Option<Permission> {
        None
    }
    /// The questions the thread's agent waits on, oldest first.
    fn ask(&self, _: ThreadId) -> Option<Ask> {
        None
    }
    /// Answers a tool approval.
    fn decide(&mut self, _: ThreadId, _request: &str, _: Decision) {}
    /// Answers every question of a request, by question id.
    fn answer(&mut self, _: ThreadId, _request: &str, _: Vec<(String, Answer)>) {}
    /// Closes a request without answering it; the agent is not messaged.
    fn dismiss(&mut self, _: ThreadId, _request: &str) {}
    /// The thread a `create_thread` started, once the source lists it.
    fn take_opened(&mut self) -> Option<ThreadId> {
        None
    }
    /// A project `add_project` made, once the source lists it.
    fn take_added(&mut self) -> Option<String> {
        None
    }
    /// The oldest thing that went wrong since the last call.
    fn take_problem(&mut self) -> Option<Problem> {
        None
    }
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool);

    /// Reads the server's settings table; `settings` holds the answer.
    fn read_settings(&mut self) {}
    /// The settings snapshot, once read: every descriptor and its value.
    fn settings(&self) -> Option<Arc<Result<Snapshot, String>>> {
        None
    }
    /// The key a `settings.set` is writing now, for the row's pending mark.
    fn settings_saving(&self) -> Option<String> {
        None
    }
    fn take_settings_write(&mut self) -> Option<Result<(), String>> {
        None
    }
    fn clear_settings_transients(&mut self) {}
    /// Writes one key through the server; the snapshot refreshes from its answer.
    fn set_setting(&mut self, _key: &str, _value: &str) {}
    /// Copies one list entry under a new id.
    fn duplicate_setting(&mut self, _key: &str, _id: &str, _new_id: &str) {}
    /// One tiny request to a Harness profile's endpoint.
    fn test_harness(&mut self, _profile: &str, _model: Option<String>) {}
    /// The probe battery against one profile's model; the snapshot reloads after.
    fn probe_harness(&mut self, _profile: &str, _model: Option<String>) {}
    /// Starts one MCP server, lists its tools and stops it again.
    fn test_mcp(&mut self, _name: &str) {}
    /// The last harness or MCP test or probe, while it runs and after.
    fn harness_run(&self) -> Option<HarnessRun> {
        None
    }
    /// Which models a server lists, before a profile for it exists.
    fn discover_models(
        &mut self,
        _base_url: &str,
        _api_format: &str,
        _api_key_env: Option<String>,
    ) {
    }
    /// Takes the last discovery answer.
    fn take_discovered(&mut self) -> Option<Discovery> {
        None
    }
    /// Shares one profile as a JSON document (no saved key, no probe results).
    fn export_profile(&mut self, _profile: &str) {}
    /// Takes the last export: the profile and its document.
    fn take_profile_document(&mut self) -> Option<(String, String)> {
        None
    }
    /// Adds a profile from an exported document; renames on a taken id.
    fn import_profile(&mut self, _text: &str) {}
    /// The last export or import, in a line.
    fn take_settings_notice(&mut self) -> Option<SettingsNotice> {
        None
    }
    /// Reads every memory the thread sees, global first.
    fn read_memories(&mut self, _thread: Option<ThreadId>) {}
    fn memories(&self) -> Option<Arc<Result<MemoryList, String>>> {
        None
    }
    /// Reads one memory in full.
    fn read_memory(&mut self, _thread: Option<ThreadId>, _name: &str, _scope: &str) {}
    fn memory_detail(&self, _name: &str, _scope: &str) -> Option<Arc<Result<MemoryEntry, String>>> {
        None
    }
    /// Keyword matches with excerpts.
    fn search_memories(&mut self, _thread: Option<ThreadId>, _query: &str) {}
    fn memory_search(&self) -> Option<Arc<Result<MemorySearch, String>>> {
        None
    }
    fn save_memory(&mut self, _thread: Option<ThreadId>, _draft: MemoryDraft) {}
    fn delete_memory(&mut self, _thread: Option<ThreadId>, _name: &str, _scope: &str) {}
    fn edit_memory(
        &mut self,
        _thread: Option<ThreadId>,
        _name: &str,
        _scope: &str,
        _old: &str,
        _new: &str,
        _description: Option<String>,
    ) {
    }
    fn append_memory(&mut self, _thread: Option<ThreadId>, _name: &str, _scope: &str, _text: &str) {
    }
    /// Copies Claude Code's auto memory for the project into Moxen's.
    fn import_claude_memory(&mut self, _thread: Option<ThreadId>) {}
    /// Reads the embeddings engine behind semantic search.
    fn read_embeddings(&mut self) {}
    fn embeddings(&self) -> Option<Arc<Result<Embeddings, String>>> {
        None
    }
    fn setup_embeddings(&mut self, _all: bool) {}
    fn rebuild_embeddings(&mut self, _all: bool) {}
    fn unload_embeddings(&mut self) {}
    /// Reads the skills under the thread's project (or the user's own).
    fn read_managed_skills(&mut self, _thread: Option<ThreadId>) {}
    fn managed_skills(&self) -> Option<Arc<Result<Vec<ManagedSkill>, String>>> {
        None
    }
    /// Reads one skill's text.
    fn read_skill_text(&mut self, _thread: Option<ThreadId>, _source: &str, _folder: &str) {}
    fn skill_text(&self, _source: &str, _folder: &str) -> Option<Arc<Result<String, String>>> {
        None
    }
    fn save_skill(
        &mut self,
        _thread: Option<ThreadId>,
        _source: &str,
        _folder: &str,
        _text: &str,
        _previous: &str,
    ) {
    }
    fn set_skill_enabled(
        &mut self,
        _thread: Option<ThreadId>,
        _source: &str,
        _folder: &str,
        _enabled: bool,
    ) {
    }
    fn set_skill_providers(
        &mut self,
        _thread: Option<ThreadId>,
        _source: &str,
        _folder: &str,
        _providers: Vec<String>,
    ) {
    }
    fn remove_skill(&mut self, _thread: Option<ThreadId>, _source: &str, _folder: &str) {}
    fn import_skill(&mut self, _thread: Option<ThreadId>, _source: &str, _from: &str) {}
    /// Reads remote access and the paired devices together.
    fn read_remote(&mut self) {}
    fn remote(&self) -> Option<Arc<Result<RemoteState, String>>> {
        None
    }
    /// Starts pairing; the code shows until it is cancelled or expires.
    fn pair_remote(&mut self) {}
    fn cancel_pairing(&mut self) {}
    /// Forgets one paired device.
    fn revoke_device(&mut self, _device_id: &str) {}
    /// Reads the providers' newest versions and Moxen's own update check.
    fn read_updates(&mut self) {}
    fn check_app_update(&mut self) {
        self.read_updates();
    }
    fn updates(&self) -> Option<Arc<Result<UpdateState, String>>> {
        None
    }
    /// Runs a provider CLI's own updater.
    fn update_provider(&mut self, _provider: &str) {}
    /// Downloads, tests and switches to the newest Moxen release.
    fn apply_update(&mut self) {}
    /// Goes back to the version the update replaced.
    fn rollback_update(&mut self) {}
}

pub struct SideAnswer {
    text: String,
    unread: bool,
}

impl SideAnswer {
    pub fn new(text: String) -> Self {
        Self { text, unread: true }
    }

    pub fn read(&mut self, only_unread: bool) -> Option<String> {
        if only_unread && !self.unread {
            return None;
        }
        self.unread = false;
        Some(self.text.clone())
    }
}

/// A side question asked while one is still being answered, in the TUI's
/// words. This is a function (not a constant) so the render edge reads the
/// current language.
pub fn side_question_pending() -> &'static str {
    crate::language::message("app.a_side_question_is_70ee")
}

#[derive(Clone, Debug)]
pub enum ThreadAction {
    Rename(String),
    RegenerateTitle,
    Settle {
        stop: bool,
    },
    Unsettle,
    Snooze(String),
    Unsnooze,
    Archive,
    Delete,
    Protect,
    Handover {
        prompt: String,
        selection: Selection,
    },
    Continue {
        selection: Option<Selection>,
    },
    ContinueAtReset,
    CancelContinue {
        notify_parent: bool,
    },
    Delegate {
        task: String,
        selection: Selection,
    },
    SideQuestion(String),
    Revert {
        turn_count: usize,
        restore_files: bool,
        draft: Option<String>,
    },
}
