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
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Running => "◐",
            Self::Idle => "✓",
            Self::Error => "×",
            Self::Held => "●",
            Self::Queued => "○",
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
}
#[derive(Clone)]
pub enum Message {
    User {
        text: String,
        preview: bool,
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

pub trait ThreadSource {
    fn inspector(&self, id: ThreadId) -> InspectorData;
    fn list_threads(&self) -> Vec<Thread>;
    fn messages(&self, id: ThreadId) -> Vec<Message>;
    fn send_message(&mut self, id: ThreadId, text: String) -> Option<Reply>;
    fn stop(&mut self, id: ThreadId);
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool);
}
