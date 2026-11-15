use crate::model::*;

pub struct MockSource {
    threads: Vec<Thread>,
    messages: Vec<Vec<Message>>,
    running: Vec<Option<usize>>,
}
impl MockSource {
    pub fn new() -> Self {
        let titles = [
            "TUI desktop app feature parity in Zed GPUI",
            "Settings page: tabbed layout",
            "SCContentSharingPicker NVENC testing status",
            "SFU auth against real stack",
            "frameFormat.ts header resync",
            "Resume isolation test",
            "NVENC probe Windows exe",
            "Hit limits, last message visible",
            "Add desktop design and design-sync setup",
            "Context tab: real tool names",
        ];
        let threads = titles
            .iter()
            .enumerate()
            .map(|(id, title)| Thread {
                id,
                title: title.to_string(),
                model: "Claude Opus 5.5".into(),
                status: match id {
                    1 => Status::Queued,
                    2 | 3 => Status::Held,
                    7 => Status::Error,
                    _ => Status::Idle,
                },
                activity: if id == 0 {
                    "now"
                } else if id == 1 {
                    "2h"
                } else {
                    "4d"
                }
                .into(),
                project: if id < 2 { "t3code-cli" } else { "moxen-chat" }.into(),
                depth: usize::from((3..7).contains(&id)),
                settled: id >= 8,
            })
            .collect();
        let messages = titles.iter().map(|title| vec![
            Message::User { text: if *title == titles[0] { "The chip shows hover but no picker appears. Check the click handler, then drive it with ⌘K and look at it.".into() } else {title.to_string()}, preview: *title == titles[0] },
            Message::Assistant("It builds. Relaunching against the demo server and driving it with keystrokes, ⌘K for the palette, to check it visually.".into()),
            Message::Tool { name: "read".into(), summary: "src/pickers.rs".into(), output: "551 lines · src/pickers.rs\n\nimpl ModelPicker {\n    fn toggle(&mut self) {\n        self.open = !self.open;\n    }\n}".into() },
            Message::Tool { name: "thought".into(), summary: "The picker state flips, so the click arrives. Something is eating the render.".into(), output: "The picker state flips, so the click arrives. Something is eating the render. The overlay is a child of a clipped container. Build, then check the overlay outside the clip.".into() },
            Message::Tool { name: "command".into(), summary: "cargo build -p moxen-desktop 2>&1 | tail -3".into(), output: "Compiling moxen-desktop\nFinished dev profile in 3.4s".into() },
            Message::Tool { name: "read".into(), summary: "src/composer.rs".into(), output: "120 lines · src/composer.rs".into() },
            Message::Tool { name: "command".into(), summary: "bun desktop/scripts/demo-server.ts /tmp/mxdemo.sock".into(), output: "Mock demo server running".into() },
            Message::Tool { name: "thought".into(), summary: "Quick check of the palette actions before clicking.".into(), output: "Quick check of the palette actions before clicking.".into() },
            Message::Tool { name: "command".into(), summary: "python3 - <<'EOF'  19 lines".into(), output: "Updated palette presentation.".into() },
            Message::Tool { name: "read".into(), summary: "src/app.rs".into(), output: "340–420 · src/app.rs".into() },
            Message::Tool { name: "command".into(), summary: "screencapture -l 3188 -o /tmp/mx-app.png".into(), output: "No output. Exit 0.".into() },
        ]).collect();
        Self {
            threads,
            messages,
            running: vec![None; 10],
        }
    }
    pub fn preview() -> Self {
        let mut source = Self::new();
        source.threads[0].status = Status::Running;
        source
    }
}
impl ThreadSource for MockSource {
    fn inspector(&self, _: ThreadId) -> InspectorData {
        InspectorData {
            tasks: ["Move TUI projections behind the server","Rust moxen-client crate: wire, handshake, subscriptions","GPUI shell on gpui-kit: window, theme, sidebar, timeline","Interaction: composer, pickers, answer panel, queue, palette actions","Side panel tabs, Git tab, settings, background, subagent view","Parity verification and packaging"].into_iter().map(str::to_string).collect(),
            subject: "Move the OpenCode driver to the v2 server API".into(),
            author: "Aaron Mompié   Thu 1 Oct 2026, 04:49 · 6 days ago".into(),
            message: "OpenCode v2 breaks v1's API: events are a tagged union with direct payloads, text deltas, tools arrive as session.tool.*, questions are forms, history is a flat timeline. translate.ts maps v2 onto the vocabulary the driver and TUI already read, tested.".into(),
            files: [("tests/v2.test.ts","+1144 −0"),("tests/driver.test.ts","+751 −42"),("driver.ts","+672 −120"),("translate.ts","+384 −92")].into_iter().map(|(f,d)|(f.into(),d.into())).collect(),
        }
    }
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
        self.messages[id].push(Message::User {
            text,
            preview: false,
        });
        let message = self.messages[id].len();
        self.messages[id].push(Message::Assistant(String::new()));
        self.running[id] = Some(message);
        Some(Reply { message, words: "The mock reply is now complete. Each word arrived on a background timer, while the UI stayed responsive. This conversation belongs to its original thread even if you switch away during streaming. No server or provider was contacted.".split_inclusive(' ').map(str::to_string).collect() })
    }
    fn stream_word(&mut self, id: ThreadId, message: usize, word: &str, finished: bool) {
        if self.running[id] != Some(message) {
            return;
        }
        if let Message::Assistant(text) = &mut self.messages[id][message] {
            text.push_str(word);
        }
        if finished {
            self.threads[id].status = Status::Idle;
            self.running[id] = None;
        }
    }
    fn stop(&mut self, id: ThreadId) {
        self.running[id] = None;
        self.threads[id].status = Status::Idle;
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
        let new = source.send_message(0, "second".into()).unwrap();
        source.stream_word(0, old.message, "stale", true);
        assert_eq!(source.list_threads()[0].status, Status::Running);
        assert!(matches!(&source.messages(0)[old.message],Message::Assistant(s) if s.is_empty()));
        source.stream_word(0, new.message, "new", true);
        assert!(matches!(&source.messages(0)[new.message],Message::Assistant(s) if s=="new"));
    }
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
