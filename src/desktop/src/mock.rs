use crate::model::*;
use std::time::Instant;

pub struct MockSource {
    threads: Vec<Thread>,
    messages: Vec<Vec<Message>>,
    running: Vec<Option<usize>>,
    queues: Vec<Vec<String>>,
}
impl MockSource {
    pub fn new() -> Self {
        let fixtures = [
            (
                "Make model selection keyboard accessible",
                "moxen-agent",
                Status::Idle,
                "now",
                0,
                false,
            ),
            (
                "Restore drafts after reconnecting",
                "moxen-agent",
                Status::Queued,
                "2h",
                0,
                false,
            ),
            (
                "Screen-sharing capture pipeline",
                "moxen-chat",
                Status::Held,
                "1d",
                0,
                false,
            ),
            (
                "Verify authentication on reconnect",
                "moxen-chat",
                Status::Held,
                "1d",
                1,
                false,
            ),
            (
                "Recover partial frame headers",
                "moxen-chat",
                Status::Idle,
                "2d",
                1,
                false,
            ),
            (
                "Test session isolation",
                "moxen-chat",
                Status::Idle,
                "2d",
                1,
                false,
            ),
            (
                "Validate the Windows encoder",
                "moxen-chat",
                Status::Idle,
                "3d",
                1,
                false,
            ),
            (
                "Retain the final reply at usage limits",
                "moxen-chat",
                Status::Error,
                "3d",
                0,
                false,
            ),
            (
                "Sync the desktop design tokens",
                "moxen-agent",
                Status::Idle,
                "4d",
                0,
                true,
            ),
            (
                "Show tool names in context usage",
                "moxen-agent",
                Status::Idle,
                "4d",
                0,
                true,
            ),
        ];
        let threads: Vec<_> = fixtures
            .into_iter()
            .enumerate()
            .map(
                |(id, (title, project, status, activity, depth, settled))| Thread {
                    id,
                    title: title.into(),
                    project: project.into(),
                    status,
                    activity: activity.into(),
                    depth,
                    settled,
                    model: "Claude Opus 5.5".into(),
                    started_at: None,
                },
            )
            .collect();
        let messages = threads.iter().map(|t| vec![
            Message::User { text: format!("Please investigate: {}. Keep the change focused and verify the result.", t.title) },
            Message::Assistant{ text: "I traced the event from the control to its view state. The state updates correctly; I’m checking the layout and keyboard path before changing the presentation.".into(), at: "Thu 09:38".into() },
            tool("read", "src/model_picker.rs", "124 lines · src/model_picker.rs\n\nfn open_picker(&mut self) {\n    self.picker_open = true;\n    self.search.focus();\n}"),
            tool("thought", "Keep focus inside the picker until a selection is made.", "Opening a picker should put focus in search. Escape returns focus to the trigger; choosing a model should preserve the draft and effort. I’ll verify each path independently."),
            tool("command", "cargo test model_picker", "running 3 tests\ntest opens_with_search_focus ... ok\ntest escape_restores_trigger ... ok\ntest selection_preserves_draft ... ok\n\n3 passed; 0 failed"),
            tool("read", "src/composer.rs", "406 lines · src/composer.rs\nThe composer owns its input handler and retains the draft per thread."),
            tool("edit", "src/model_picker.rs", "- self.picker_open = true;\n+ self.open_picker(window, cx);"),
            tool("command", "cargo clippy -- -D warnings", "Checking moxen-desktop\nFinished dev profile in 2.8s"),
            tool("thought", "Verify the expanded output without moving the reading position.", "The selected thread owns its scroll state. Expanding a step should not move the composer or reset the reading position."),
            tool("read", "src/workspace.rs", "267 lines · src/workspace.rs\nPer-thread state retains drafts, expanded steps and scroll positions."),
            tool("command", "cargo build", "Compiling moxen-desktop\nFinished dev profile in 3.4s"),
        ]).collect();
        let count = threads.len();
        Self {
            threads,
            messages,
            running: vec![None; count],
            queues: vec![vec![]; count],
        }
    }
    pub fn preview() -> Self {
        let mut source = Self::new();
        source.threads[0].status = Status::Running;
        source.threads[0].started_at = Some(Instant::now());
        source.queues[0].push("Also check Escape returns focus to the model control.".into());
        source
    }
}
fn tool(name: &str, summary: &str, output: &str) -> Message {
    let meta = match name {
        "thought" => "6s",
        "command" => "3.4s",
        "edit" => "+5 −1",
        _ => output
            .lines()
            .next()
            .and_then(|line| line.split(" · ").next())
            .unwrap_or("551 lines"),
    };
    Message::Tool {
        name: name.into(),
        summary: summary.into(),
        output: output.into(),
        meta: meta.into(),
        failed: false,
        running: false,
    }
}
impl ThreadSource for MockSource {
    fn file_diff(&self, _: ThreadId, file: usize) -> Vec<DiffLine> {
        let files = [
            vec![
                ("", "1", "+", "#[test]"),
                ("", "2", "+", "fn escape_restores_trigger() {"),
                ("", "3", "+", "    let mut picker = Picker::new();"),
                ("", "4", "+", "    picker.open();"),
                ("", "5", "+", "    picker.dismiss();"),
                ("", "6", "+", "    assert!(picker.trigger_focused());"),
                ("", "7", "+", "}"),
            ],
            vec![
                ("26", "26", " ", "fn open_picker(&mut self) {"),
                ("27", "", "-", "    self.picker_open = true;"),
                ("", "27", "+", "    self.open_picker(window, cx);"),
                ("", "28", "+", "    self.search.focus(window, cx);"),
                ("28", "29", " ", "}"),
            ],
            vec![
                ("8", "8", " ", "struct Workspace {"),
                ("", "9", "+", "    model_focus: FocusHandle,"),
                ("9", "10", " ", "    selected: ThreadId,"),
                ("10", "11", " ", "}"),
            ],
        ];
        files
            .into_iter()
            .nth(file)
            .unwrap_or_default()
            .into_iter()
            .map(|(old, new, sign, text)| DiffLine {
                old,
                new,
                sign,
                text,
            })
            .collect()
    }
    fn queued(&self, id: ThreadId) -> &[String] {
        &self.queues[id]
    }
    fn take_queued(&mut self, id: ThreadId) -> Option<String> {
        if self.queues[id].is_empty() {
            None
        } else {
            Some(self.queues[id].remove(0))
        }
    }
    fn inspector(&self, _: ThreadId) -> InspectorData {
        InspectorData {
            tasks: ["Trace the picker event and focus path", "Add keyboard navigation and selection", "Preserve drafts when switching models", "Verify expanded output and focus return", "Check the native window at two sizes", "Run the full desktop checks"].into_iter().map(str::to_string).collect(),
            subject: "Keep model selection in the keyboard flow".into(),
            author: "Aaron Mompié · 12 minutes ago".into(),
            message: "Focus search when the picker opens, return to the trigger on Escape, and preserve the thread’s draft when choosing a model. The selection and focus-return paths have regression tests.".into(),
            files: [("tests/picker.rs", "+42 −0"), ("model_picker.rs", "+18 −6"), ("workspace.rs", "+8 −3")].into_iter().map(|(f,d)|(f.into(),d.into())).collect(),
        }
    }
    fn list_threads(&self) -> Vec<Thread> {
        self.threads.clone()
    }
    fn messages(&self, id: ThreadId) -> std::sync::Arc<Vec<Message>> {
        std::sync::Arc::new(self.messages[id].clone())
    }
    fn send_message(&mut self, id: ThreadId, text: String) -> Option<Reply> {
        if text.trim().is_empty() {
            return None;
        }
        if self.threads[id].status == Status::Running {
            self.queues[id].push(text);
            return None;
        }
        self.threads[id].status = Status::Running;
        self.threads[id].started_at = Some(Instant::now());
        self.threads[id].activity = "now".into();
        self.messages[id].push(Message::User { text });
        let message = self.messages[id].len();
        self.messages[id].push(Message::Assistant {
            text: String::new(),
            at: "Thu 09:38".into(),
        });
        self.running[id] = Some(message);
        Some(Reply { message, words: "The keyboard path is verified. Search receives focus on open, selection preserves the draft, and Escape returns to the trigger. The targeted tests pass; I’m checking the native window next.".split_inclusive(' ').map(str::to_string).collect() })
    }
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool) {
        if self.running[id] != Some(message) {
            return;
        }
        if let Message::Assistant { text, .. } = &mut self.messages[id][message] {
            text.push_str(word);
        }
        if finished {
            self.threads[id].status = Status::Idle;
            self.threads[id].started_at = None;
            self.running[id] = None;
        }
    }
    fn stop(&mut self, id: ThreadId) {
        self.running[id] = None;
        self.threads[id].status = Status::Idle;
        self.threads[id].started_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopped_reply_cannot_mutate_a_new_turn() {
        let mut source = MockSource::new();
        let old = source.send_message(0, "first".into()).unwrap();
        source.stop(0);
        assert!(source.list_threads()[0].started_at.is_none());
        let new = source.send_message(0, "second".into()).unwrap();
        source.stream_word(0, old.message, "stale", true);
        assert_eq!(source.list_threads()[0].status, Status::Running);
        assert!(source.list_threads()[0].started_at.is_some());
        assert!(
            matches!(&source.messages(0)[old.message],Message::Assistant{text: s, ..} if s.is_empty())
        );
        source.stream_word(0, new.message, "new", true);
        assert!(
            matches!(&source.messages(0)[new.message],Message::Assistant{text: s, ..} if s=="new")
        );
    }
    #[test]
    fn running_send_queues_without_mutating_another_thread() {
        let mut source = MockSource::new();
        let reply = source.send_message(0, "hello".into()).unwrap();
        let other = source.messages(2).len();
        assert!(source.send_message(0, "next".into()).is_none());
        assert_eq!(source.queued(0), &["next"]);
        source.stream_word(0, reply.message, "reply", true);
        assert_eq!(source.messages(2).len(), other);
        assert_eq!(source.take_queued(0).as_deref(), Some("next"));
        assert!(source.take_queued(0).is_none());
    }
}
