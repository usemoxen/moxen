use crate::model::*;

pub struct MockSource {
    threads: Vec<Thread>,
    messages: Vec<Vec<Message>>,
}
impl MockSource {
    pub fn new() -> Self {
        let titles = [
            "Build the desktop workspace",
            "Investigate slow startup",
            "Review the transport boundary",
            "Fix Windows path handling",
            "Add thread search",
            "Polish the composer",
            "Audit provider usage",
            "Update the contributor guide",
        ];
        let threads = titles
            .iter()
            .enumerate()
            .map(|(id, title)| Thread {
                id,
                title: title.to_string(),
                model: if id % 3 == 1 {
                    "claude · opus 5.5"
                } else {
                    "codex · gpt-6.1-sol"
                }
                .into(),
                status: match id {
                    1 => Status::Running,
                    3 => Status::Error,
                    _ => Status::Idle,
                },
                activity: format!("{}m ago", id * 7 + 3),
            })
            .collect();
        let messages = titles.iter().map(|title| vec![
            Message::User(format!("{title}. Start by reading the relevant code and explain the approach.")),
            Message::Assistant("I’ll inspect the existing structure first, then make the smallest change that fits the project. The server boundary stays separate from the client.".into()),
            Message::Tool { name: "read_file".into(), summary: "Read the workspace and contribution guide".into(), output: "src/server/api.ts\n  query(request): Promise<Response>\n  dispatch(command): Promise<void>\n\nThe client uses a typed boundary. No provider credentials cross into the UI.\nRead 2 files · 142 lines · 0.2s".into() },
            Message::Assistant("The architecture is clear: keep the UI focused on presentation and put data access behind a replaceable source. I’ll preserve thread identity through asynchronous work, so changing the selection cannot redirect a reply.".into()),
            Message::Tool { name: "run_command".into(), summary: "cargo test · check the thread lifecycle".into(), output: "running 2 tests\ntest switching_threads_preserves_reply ... ok\ntest duplicate_send_is_rejected ... ok\n\ntest result: ok. 2 passed; 0 failed".into() },
            Message::Assistant("Ready for the next step. You can expand either tool row to inspect its output, or send a follow-up below.".into()),
        ]).collect();
        Self { threads, messages }
    }
}
impl ThreadSource for MockSource {
    fn list_threads(&self) -> Vec<Thread> {
        self.threads.clone()
    }
    fn messages(&self, id: ThreadId) -> Vec<Message> {
        self.messages[id].clone()
    }
    fn send_message(&mut self, id: ThreadId, text: String) -> Option<Reply> {
        if self.threads[id].status == Status::Running || text.trim().is_empty() {
            return None;
        }
        self.threads[id].status = Status::Running;
        self.threads[id].activity = "just now".into();
        self.messages[id].push(Message::User(text));
        let message = self.messages[id].len();
        self.messages[id].push(Message::Assistant(String::new()));
        Some(Reply { message, words: "The mock reply is now complete. Each word arrived on a background timer, while the UI stayed responsive. This conversation belongs to its original thread even if you switch away during streaming. No server or provider was contacted.".split_inclusive(' ').map(str::to_string).collect() })
    }
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool) {
        if let Message::Assistant(text) = &mut self.messages[id][message] {
            text.push_str(word);
        }
        if finished {
            self.threads[id].status = Status::Idle;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switching_threads_preserves_reply_and_rejects_duplicate_send() {
        let mut source = MockSource::new();
        let reply = source.send_message(0, "hello".into()).unwrap();
        assert!(source.send_message(0, "duplicate".into()).is_none());
        let other = source.messages(2).len();
        source.stream_word(0, reply.message, "reply", true);
        assert_eq!(source.messages(2).len(), other);
        assert!(
            matches!(&source.messages(0)[reply.message], Message::Assistant(s) if s == "reply")
        );
        assert_eq!(source.list_threads()[0].status, Status::Idle);
    }
}
