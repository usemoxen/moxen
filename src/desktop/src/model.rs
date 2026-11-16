pub use crate::catalog::{CatalogState, Selection};

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
}
pub struct Reply {
    pub message: usize,
    pub words: Vec<String>,
}
pub struct InspectorData {
    pub tasks: Vec<String>,
    pub subject: String,
    pub author: String,
    pub message: String,
    pub files: Vec<(String, String)>,
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
    fn file_diff(&self, id: ThreadId, file: usize) -> Vec<DiffLine>;
    fn queued(&self, id: ThreadId) -> Vec<Queued>;
    /// Takes a waiting message back and returns its text, to edit it.
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<String>;
    fn edit_queued(&mut self, id: ThreadId, key: &str, edit: QueueEdit);
    /// Stops the running turn so the waiting message goes next.
    fn send_queued_now(&mut self, id: ThreadId, key: &str) -> Option<Reply>;
    fn inspector(&self, id: ThreadId) -> InspectorData;
    fn list_threads(&self) -> Vec<Thread>;
    fn messages(&self, id: ThreadId) -> std::sync::Arc<Vec<Message>>;
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

pub struct DiffLine {
    pub old: &'static str,
    pub new: &'static str,
    pub sign: &'static str,
    pub text: &'static str,
}
