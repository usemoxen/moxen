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
}
#[derive(Clone)]
pub enum Message {
    User {
        text: String,
    },
    Assistant(String),
    Tool {
        name: String,
        summary: String,
        output: String,
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
    fn queued(&self, id: ThreadId) -> &[String];
    fn take_queued(&mut self, id: ThreadId) -> Option<String>;
    fn inspector(&self, id: ThreadId) -> InspectorData;
    fn list_threads(&self) -> Vec<Thread>;
    fn messages(&self, id: ThreadId) -> Vec<Message>;
    fn send_message(&mut self, id: ThreadId, text: String) -> Option<Reply>;
    fn stop(&mut self, id: ThreadId);
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool);
}

pub struct DiffLine {
    pub old: &'static str,
    pub new: &'static str,
    pub sign: &'static str,
    pub text: &'static str,
}
