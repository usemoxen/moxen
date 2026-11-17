pub use crate::catalog::{CatalogState, Selection};
pub use crate::git::{Git, Patch, TurnDiff};
pub use crate::stats::{CardState, StatsData, StatsRange, StatsState};
pub use crate::usage::{ContextData, Hold, LimitsData, ProtectionData, QueueMove, SnapshotUsage};
use crate::work::{Delegated, InspectorData, Read, View};
use std::sync::Arc;

pub type ThreadId = usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    Idle,
    Error,
    Held,
    Queued,
}
impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "Working",
            Self::Idle => "Done",
            Self::Error => "Stuck",
            Self::Held => "Your turn",
            Self::Queued => "Up next",
        }
    }
    pub fn token(self) -> &'static str {
        match self {
            Self::Running => "live",
            Self::Idle => "ink-2",
            Self::Error => "broken",
            Self::Held => "held",
            Self::Queued => "ink-2",
        }
    }
    pub fn icon(self) -> &'static str {
        match self {
            Self::Running => "state-running",
            Self::Idle => "check",
            Self::Error => "x",
            Self::Held => "state-held",
            Self::Queued => "circle",
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
}
pub struct Reply {
    pub message: usize,
    pub words: Vec<String>,
}

/// Whether the source has reached the Moxen server. The mock is always live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Connection {
    Connecting,
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
    pub project: String,
    pub text: String,
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
    pub unsent: Option<(Option<ThreadId>, String)>,
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
    ("default", "Chat"),
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
    /// Thread ids in sidebar order. With `by_project` a project's threads are
    /// contiguous, projects newest first. Gone threads are left out; their ids
    /// stay valid for the life of the source. The mock's fixtures are already
    /// in order.
    fn order(&self, _by_project: bool) -> Vec<ThreadId> {
        (0..self.list_threads().len()).collect()
    }
    /// Whether the transcript, inspector and status line are fixtures. A live
    /// source leaves out what it cannot yet fill rather than show made-up numbers.
    fn preview(&self) -> bool {
        true
    }
    fn connection(&self) -> Connection {
        Connection::Live
    }
    /// Changes whenever the source's data does, so the window knows to redraw.
    fn revision(&self) -> u64 {
        0
    }
    /// Reconnects after a failure.
    fn retry(&mut self) {}
    fn queued(&self, id: ThreadId) -> Vec<Queued>;
    /// Takes a waiting message back and returns its text, to edit it.
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<String>;
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
    fn send_message(&mut self, id: ThreadId, text: String, delivery: Delivery) -> Option<Reply>;
    fn stop(&mut self, id: ThreadId);
    /// Where a new thread can start, newest project first.
    fn projects(&self) -> Vec<Project> {
        vec![]
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
}
