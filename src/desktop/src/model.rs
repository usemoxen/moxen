pub type ThreadId = usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    Idle,
    Error,
}
impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Idle => "idle",
            Self::Error => "error",
        }
    }
    pub fn token(self) -> &'static str {
        match self {
            Self::Running => "live",
            Self::Idle => "ink-2",
            Self::Error => "broken",
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
}
#[derive(Clone)]
pub enum Message {
    User(String),
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

pub trait ThreadSource {
    fn list_threads(&self) -> Vec<Thread>;
    fn messages(&self, id: ThreadId) -> Vec<Message>;
    fn send_message(&mut self, id: ThreadId, text: String) -> Option<Reply>;
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool);
}
