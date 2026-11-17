use crate::catalog::{Catalog, OptionValue};
use crate::model::*;
use crate::work::{
    self, Agent, Background, BackgroundTask, Delegated, Delegation, InspectorData, Read, View,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Instant;

/// How many threads the fixtures hold.
const FIXTURES: usize = 10;

pub struct MockSource {
    threads: Vec<Thread>,
    messages: Vec<Vec<Message>>,
    running: Vec<Option<usize>>,
    queues: Vec<Vec<String>>,
    opened: Option<ThreadId>,
    added: Option<String>,
    catalog: std::sync::Arc<Catalog>,
    selections: Vec<Selection>,
    /// What each thread waits on the person for, until answered.
    permissions: Vec<Option<Permission>>,
    asks: Vec<Option<Ask>>,
    git: std::sync::Arc<Git>,
    agents: Vec<Agent>,
    background: Vec<BackgroundTask>,
    task_cancelled: bool,
    context: std::sync::Arc<ContextData>,
    limits: std::sync::Arc<LimitsData>,
    protection: std::sync::Arc<ProtectionData>,
    card: Option<std::sync::Arc<CardState>>,
}

/// The `getConfig` answer the fixtures stand in for: the providers the
/// mockups show, a model with no effort options, and one hidden model.
fn fixture_config() -> Value {
    let levels = json!([
        { "id": "low", "label": "Low" },
        { "id": "medium", "label": "Medium", "isDefault": true },
        { "id": "high", "label": "High" },
        { "id": "xhigh", "label": "Extra" },
        { "id": "max", "label": "Max" }
    ]);
    let effort = json!({ "capabilities": { "optionDescriptors": [
        { "id": "effort", "label": "Effort", "type": "select", "options": levels }
    ] } });
    let model = |slug: &str, name: &str, extra: &Value, default: bool| {
        let mut model =
            json!({ "slug": slug, "name": name, "isCustom": false, "isDefault": default });
        if let (Some(model), Some(extra)) = (model.as_object_mut(), extra.as_object()) {
            model.extend(extra.clone());
        }
        model
    };
    let none = json!({});
    json!({
        "providers": [
            {
                "instanceId": "claudeAgent", "driver": "claudeAgent", "displayName": "Claude Code",
                "enabled": true, "installed": true, "status": "Ready", "auth": { "status": "authenticated" },
                "models": [
                    model("fable-5-1", "Fable 5.1", &effort, false),
                    model("opus-5-5", "Opus 5.5", &effort, true),
                    model("sonnet-5-5", "Sonnet 5.5", &effort, false),
                    model("haiku-4-5", "Haiku 4.5", &effort, false),
                    model("opus-4", "Opus 4", &effort, false)
                ]
            },
            {
                "instanceId": "opencode", "driver": "opencode", "displayName": "OpenCode",
                "enabled": true, "installed": true, "status": "Ready", "auth": { "status": "authenticated" },
                "models": [
                    model("space-bunny-free", "Space Bunny Free", &none, true),
                    model("big-pickle", "Big Pickle", &none, false),
                    model("grok-code-fast-1", "Grok Code Fast 1", &none, false)
                ]
            },
            {
                "instanceId": "codex", "driver": "codex", "displayName": "Codex",
                "enabled": true, "installed": true, "status": "Run codex login",
                "auth": { "status": "unauthenticated" },
                "models": [ model("gpt-6-1", "GPT-6.1", &effort, true) ]
            }
        ],
        "settings": { "providerModelPreferences": { "claudeAgent": { "hiddenModels": ["opus-4"] } } }
    })
}
fn opus() -> Selection {
    Selection {
        instance: "claudeAgent".into(),
        model: "opus-5-5".into(),
        options: vec![("effort".into(), OptionValue::Text("medium".into()))],
    }
}
/// The Context tab fixture: the old usage control's numbers, read through
/// the same decoders as the server's answers.
fn fixture_context() -> ContextData {
    let breakdown = crate::usage::Breakdown::from_json(&json!({
        "usedTokens": 663_000, "maxTokens": 1_000_000,
        "autoCompactThreshold": 800_000, "compactsAutomatically": true,
        "categories": [
            {"name": "Tool calls", "tokens": 280_000, "kind": "used"},
            {"name": "System and tools", "tokens": 180_000, "kind": "used"},
            {"name": "Reasoning", "tokens": 120_000, "kind": "used"},
            {"name": "Messages", "tokens": 83_000, "kind": "used"},
        ],
        "tools": [{"name": "Bash", "tokens": 40_000}],
        "estimated": false,
    }));
    ContextData {
        live: true,
        breakdown,
        reading: None,
        error: None,
    }
}

/// The account limits fixture: the old plan-usage numbers.
fn fixture_limits() -> LimitsData {
    LimitsData::from_json(
        &json!({"providers": {"claude": {"checkedAt": "2026-11-16T09:00:00Z", "windows": [
        {"id": "session", "kind": "session", "label": "Session", "usedPercent": 36.0, "resetsAt": null},
        {"id": "weekly", "kind": "weekly", "label": "Weekly", "usedPercent": 43.0, "resetsAt": null},
    ], "unavailable": null}}}),
    )
}

/// A reset a screenshot can read: an ISO instant `hours` from now, in UTC.
fn future_iso(hours: i64) -> String {
    use chrono::{TimeDelta, Utc};
    (Utc::now() + TimeDelta::hours(hours))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// The protection fixture: a forecast that says to wrap up, and one thread
/// waiting on its allowance.
fn fixture_protection() -> ProtectionData {
    ProtectionData::from_json(&json!({
        "forecasts": [{
            "provider": "claude", "windowId": "session", "label": "Session",
            "usedPercent": 97.0, "resetsAt": future_iso(1),
            "remainingWorkMs": 1_800_000, "reservePercent": 3.0,
            "shouldWrap": true, "running": 1,
        }],
        "queue": [{
            "threadId": "held", "title": "Backfill the stats card",
            "provider": "claude", "phase": "waiting",
            "resetsAt": future_iso(2), "order": 1, "handoff": false,
        }],
    }))
}

/// The stats fixture: a week of opus and haiku work.
fn fixture_stats(range: StatsRange) -> StatsState {
    let bucket = |key: &str, tokens: i64, share: f64, cost: f64| {
        json!({"key": key, "usage": {"input": tokens / 2, "cacheRead": tokens / 4, "cacheCreate": 0, "output": tokens / 4, "thinking": 0, "turns": 4},
               "tokens": tokens, "share": share, "sessions": 2, "costUsd": cost, "unpricedTurns": 0})
    };
    let data = StatsData::from_json(
        range,
        &json!({
            "range": range.wire(), "sessions": 3, "messages": 340, "turns": 48,
            "totalTokens": 663_000, "costUsd": 1.5, "unpricedTurns": 1,
            "activeDays": 5, "bestStreak": 3, "peakHour": 9, "favoriteModel": "opus-5-5",
            "byProvider": [bucket("claude", 663_000, 1.0, 1.5)],
            "byModel": [bucket("opus-5-5", 400_000, 0.6, 1.0), bucket("haiku-4-5", 263_000, 0.4, 0.5)],
            "daily": [
                {"day": "2026-11-12", "tokens": 100_000, "byModel": {"opus-5-5": 100_000}, "byProvider": {}},
                {"day": "2026-11-13", "tokens": 200_000, "byModel": {"opus-5-5": 120_000, "haiku-4-5": 80_000}, "byProvider": {}},
                {"day": "2026-11-14", "tokens": 363_000, "byModel": {"opus-5-5": 180_000, "haiku-4-5": 183_000}, "byProvider": {}},
            ],
        }),
    );
    StatsState { data, error: None }
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
                    model: "opus-5-5".into(),
                    started_at: None,
                    runtime_mode: "full-access".into(),
                    interaction_mode: "default".into(),
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
            opened: None,
            added: None,
            catalog: std::sync::Arc::new(
                Catalog::from_config(&fixture_config()).expect("fixture catalog"),
            ),
            selections: vec![opus(); count],
            permissions: vec![None; count],
            asks: vec![None; count],
            git: crate::mock_git::fixture(),
            agents: vec![],
            background: vec![],
            task_cancelled: false,
            context: std::sync::Arc::new(fixture_context()),
            limits: std::sync::Arc::new(fixture_limits()),
            protection: std::sync::Arc::new(fixture_protection()),
            card: None,
        }
    }
    pub fn preview() -> Self {
        let mut source = Self::new();
        source.threads[0].status = Status::Running;
        source.threads[0].started_at = Some(Instant::now());
        source.queues[0].push("Also check Escape returns focus to the model control.".into());
        source.threads[1].depth = 1;
        source.agents = work::agents(&json!({"subagentRows": [
            { "agentId": "explore", "agentType": "Explore", "description": "Trace keyboard focus",
              "running": false, "lastMessage": "The picker restores focus on close." },
            { "agentId": "review", "agentType": "Review", "description": "Review the reconnect path",
              "running": true, "stoppable": true },
        ]}));
        source.background = Background::read(&json!({"live": true, "tasks": [
            { "taskId": "desktop-checks", "description": "Desktop checks", "toolName": "Bash",
              "command": "cargo test" },
            { "taskId": "reconnect-watch", "description": "Watch reconnect events", "toolName": "Monitor",
              "command": "watch reconnect", "stoppable": false },
        ]})).tasks;
        // A tool approval, two questions and a proposed plan, one thread each.
        source.permissions[2] = Some(Permission {
            request: "perm-1".into(),
            tool: "Bash".into(),
            classification: Some("command-execution".into()),
            detail: Some("cargo test --release capture::pipeline".into()),
            description: Some("Run the capture pipeline tests in release mode".into()),
        });
        source.threads[2].status = Status::Running;
        source.threads[2].started_at = Some(Instant::now());
        let choice = |label: &str, description: &str, preview: Option<&str>| Choice {
            label: label.into(),
            description: Some(description.into()),
            value: label.into(),
            preview: preview.map(str::to_string),
        };
        source.asks[3] = Some(Ask {
            request: "ask-1".into(),
            questions: vec![
                Question {
                    id: "scope".into(),
                    header: "Scope".into(),
                    text: "How far should the reconnect check reach?".into(),
                    choices: vec![
                        choice(
                            "Handshake only",
                            "Verify the token once",
                            Some("fn reconnect() {\n    verify(token)?;\n}"),
                        ),
                        choice("Every frame", "Verify each frame header", None),
                    ],
                    multi: false,
                    custom: true,
                },
                Question {
                    id: "platforms".into(),
                    header: "Platforms".into(),
                    text: "Which platforms get a regression test?".into(),
                    choices: vec![
                        choice("macOS", "", None),
                        choice("Windows", "", None),
                        choice("Linux", "", None),
                    ],
                    multi: true,
                    custom: false,
                },
            ],
        });
        source.messages[4].push(Message::Plan {
            text: "1. Add a header scanner that resyncs after a bad frame.\n2. Keep the partial bytes until the next frame starts.\n3. Cover truncated and oversized headers with tests.".into(),
            implemented: false,
            at: "Thu 09:41".into(),
        });
        // The provider stopped at its usage limit: the transcript keeps the
        // record of when it happened and when it lifts.
        source.messages[7].push(Message::UsageLimit {
            label: Some("Session".into()),
            resets_at: Some(future_iso(1)),
            wrap_up: false,
            at: "Thu 09:52".into(),
        });
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
    fn queued(&self, id: ThreadId) -> Vec<Queued> {
        let last = self.queues[id].len().saturating_sub(1);
        self.queues[id]
            .iter()
            .enumerate()
            .map(|(at, text)| Queued {
                key: at.to_string(),
                text: text.clone(),
                held: false,
                scheduled: None,
                earlier: at,
                later: last - at,
            })
            .collect()
    }
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<String> {
        let at: usize = key.parse().ok()?;
        (at < self.queues[id].len()).then(|| self.queues[id].remove(at))
    }
    fn edit_queued(&mut self, id: ThreadId, key: &str, edit: QueueEdit) {
        let Ok(at) = key.parse::<usize>() else { return };
        let queue = &mut self.queues[id];
        match edit {
            QueueEdit::Earlier if at > 0 && at < queue.len() => queue.swap(at, at - 1),
            QueueEdit::Later if at + 1 < queue.len() => queue.swap(at, at + 1),
            QueueEdit::Remove if at < queue.len() => {
                queue.remove(at);
            }
            _ => {}
        }
    }
    fn send_queued_now(&mut self, id: ThreadId, key: &str) -> Option<Reply> {
        let text = self.take_queued(id, key)?;
        self.stop(id);
        self.send_message(id, text, Delivery::Steer)
    }
    fn projects(&self) -> Vec<Project> {
        ["moxen-agent", "moxen-chat"]
            .into_iter()
            .map(|title| Project {
                id: title.into(),
                title: title.into(),
            })
            .collect()
    }
    fn create_thread(&mut self, draft: NewThread) {
        let id = self.threads.len();
        let title: String = draft.text.chars().take(48).collect();
        let selection = draft.model.unwrap_or_else(opus);
        self.threads.push(Thread {
            id,
            title,
            project: draft.project,
            status: Status::Idle,
            activity: "now".into(),
            depth: 0,
            settled: false,
            model: selection.model.clone(),
            started_at: None,
            runtime_mode: draft.runtime_mode.unwrap_or_else(|| "full-access".into()),
            interaction_mode: draft.interaction_mode,
        });
        self.messages.push(vec![
            Message::User { text: draft.text },
            Message::Assistant {
                text: "Started. This is the mock source, so nothing runs.".into(),
                at: "Thu 09:38".into(),
            },
        ]);
        self.running.push(None);
        self.queues.push(vec![]);
        self.selections.push(selection);
        self.opened = Some(id);
    }
    fn order(&self, _: bool) -> Vec<ThreadId> {
        // Threads started here come first, newest first.
        (FIXTURES..self.threads.len())
            .rev()
            .chain(0..FIXTURES)
            .collect()
    }
    fn take_opened(&mut self) -> Option<ThreadId> {
        self.opened.take()
    }
    fn add_project(&mut self, path: String) {
        self.added = Some(path);
    }
    fn take_added(&mut self) -> Option<String> {
        self.added.take()
    }
    fn catalog(&self) -> CatalogState {
        CatalogState::Ready(self.catalog.clone())
    }
    fn selection(&self, id: ThreadId) -> Option<Selection> {
        self.selections.get(id).cloned()
    }
    fn project_selection(&self, _: &str) -> Option<Selection> {
        Some(opus())
    }
    fn set_model(&mut self, id: ThreadId, selection: Selection) {
        self.threads[id].model = selection.model.clone();
        self.selections[id] = selection;
    }
    fn permission(&self, id: ThreadId) -> Option<Permission> {
        self.permissions[id].clone()
    }
    fn ask(&self, id: ThreadId) -> Option<Ask> {
        self.asks[id].clone()
    }
    fn decide(&mut self, id: ThreadId, _: &str, _: Decision) {
        self.permissions[id] = None;
    }
    fn answer(&mut self, id: ThreadId, _: &str, _: Vec<(String, Answer)>) {
        self.asks[id] = None;
    }
    fn dismiss(&mut self, id: ThreadId, _: &str) {
        self.asks[id] = None;
    }
    fn set_modes(&mut self, id: ThreadId, runtime: &str, interaction: &str) {
        self.threads[id].runtime_mode = runtime.into();
        self.threads[id].interaction_mode = interaction.into();
    }
    fn inspector(&self, id: ThreadId) -> Arc<InspectorData> {
        if id != 0 {
            return Arc::default();
        }
        Arc::new(InspectorData {
            tasks: work::checklist(&json!({"activities": [{
                "kind": "turn.plan.updated", "payload": {"plan": [
                    {"step": "Trace the picker event and focus path", "status": "completed"},
                    {"step": "Add keyboard navigation and selection", "status": "completed"},
                    {"step": "Preserve drafts when switching models", "status": "completed"},
                    {"step": "Verify expanded output and focus return", "status": "inProgress"},
                    {"step": "Check the native window at two sizes", "status": "pending"},
                    {"step": "Run the full desktop checks", "status": "pending"},
                ]},
            }]})),
            agents: self.agents.clone(),
            background_count: self.background.len(),
        })
    }
    fn children(&self, id: ThreadId) -> Vec<ThreadId> {
        if id == 0 { vec![1] } else { vec![] }
    }
    fn context(&self, _: ThreadId) -> Option<Arc<ContextData>> {
        Some(self.context.clone())
    }
    fn snapshot_usage(&self, _: ThreadId) -> Option<SnapshotUsage> {
        Some(SnapshotUsage {
            used: 663_000,
            max: Some(1_000_000),
        })
    }
    fn limits(&self) -> Option<Arc<LimitsData>> {
        Some(self.limits.clone())
    }
    fn protection(&self) -> Option<Arc<ProtectionData>> {
        Some(self.protection.clone())
    }
    fn stats(&self, range: StatsRange) -> Option<Arc<StatsState>> {
        Some(Arc::new(fixture_stats(range)))
    }
    fn card(&self, _: StatsRange) -> Option<Arc<CardState>> {
        self.card.clone()
    }
    fn read_card(&mut self, range: StatsRange) {
        let path = std::env::temp_dir().join(format!("moxen-stats-{}.png", range.wire()));
        std::fs::write(&path, b"mock card").ok();
        self.card = Some(Arc::new(CardState {
            path: Some(path.to_string_lossy().into_owned()),
            error: None,
            busy: false,
        }));
    }
    fn delegated(&self, id: ThreadId) -> Option<Delegated> {
        (id == 1).then(|| Delegated {
            parent: Some(0),
            branch: Some("restore-drafts".into()),
            worktree: None,
        })
    }
    fn work(&self, id: ThreadId, read: &Read) -> Option<Arc<Result<View, String>>> {
        let view = match read {
            Read::Delegation if id == 1 => View::Delegation(Delegation {
                active: true,
                notify: true,
                status: self.task_cancelled.then(|| "cancelled".into()),
                summary: None,
            }),
            Read::Background => View::Background(Background {
                live: id == 0,
                partial: false,
                tasks: if id == 0 {
                    self.background.clone()
                } else {
                    vec![]
                },
            }),
            Read::Subagent(agent) if id == 0 && agent == "explore" => View::subagent(&json!({
                "available": true, "messages": [
                    {"id": "prompt", "role": "user", "text": "Trace keyboard focus."},
                    {"id": "reply", "role": "assistant", "text": "The picker restores focus on close."},
                ]
            })),
            Read::Subagent(_) => View::Subagent(None),
            Read::Output(task) if id == 0 && task == "desktop-checks" => View::output(&json!({
                "available": true, "lines": ["running 3 tests", "test picker_restores_focus ... ok"],
            })),
            Read::Output(_) => View::Output(None),
            _ => return None,
        };
        Some(Arc::new(Ok(view)))
    }
    fn stop_background(&mut self, id: ThreadId, task: &str) {
        if id == 0 {
            self.background.retain(|row| row.id != task);
            if let Some(row) = self.agents.iter_mut().find(|row| row.id == task) {
                row.status = Status::Idle;
                row.stoppable = false;
            }
        }
    }
    fn cancel_task(&mut self, id: ThreadId, _: bool) {
        if id == 1 {
            self.task_cancelled = true;
            self.threads[id].status = Status::Idle;
        }
    }
    fn git(&self, _: ThreadId) -> std::sync::Arc<Git> {
        self.git.clone()
    }
    fn open_commit(&mut self, _: ThreadId, sha: &str) {
        let git = std::sync::Arc::make_mut(&mut self.git);
        git.commit = Some(crate::git::OpenCommit {
            sha: sha.to_string(),
            detail: crate::mock_git::detail(sha),
            loading: false,
            runs: None,
        });
    }
    fn close_commit(&mut self, _: ThreadId) {
        std::sync::Arc::make_mut(&mut self.git).commit = None;
    }
    fn create_request(&mut self, _: ThreadId, request: NewRequest) {
        std::sync::Arc::make_mut(&mut self.git).notice = Some(format!(
            "Opened {} (fixture, nothing was sent).",
            request.title
        ));
    }
    fn comment_on_request(&mut self, _: ThreadId, number: i64, _: String) {
        std::sync::Arc::make_mut(&mut self.git).notice = Some(format!("Commented on #{number}."));
    }
    fn merge_request(&mut self, _: ThreadId, number: i64, _: MergeStrategy) {
        std::sync::Arc::make_mut(&mut self.git).notice = Some(format!("Merged #{number}."));
    }
    fn turn_diffs(&self, _: ThreadId) -> Vec<TurnDiff> {
        crate::mock_git::turns()
    }
    fn turn_patch(&self, _: ThreadId, turn: i64) -> Option<Patch> {
        Some(crate::mock_git::patch_of(turn))
    }
    fn tree_patch(&self, _: ThreadId) -> Option<Patch> {
        Some(crate::mock_git::patch())
    }
    fn list_threads(&self) -> Vec<Thread> {
        self.threads.clone()
    }
    fn messages(&self, id: ThreadId) -> std::sync::Arc<Vec<Message>> {
        std::sync::Arc::new(self.messages[id].clone())
    }
    fn send_message(&mut self, id: ThreadId, text: String, _: Delivery) -> Option<Reply> {
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
        let old = source
            .send_message(0, "first".into(), Delivery::Steer)
            .unwrap();
        source.stop(0);
        assert!(source.list_threads()[0].started_at.is_none());
        let new = source
            .send_message(0, "second".into(), Delivery::Steer)
            .unwrap();
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
        let reply = source
            .send_message(0, "hello".into(), Delivery::Steer)
            .unwrap();
        let other = source.messages(2).len();
        assert!(
            source
                .send_message(0, "next".into(), Delivery::Steer)
                .is_none()
        );
        assert_eq!(source.queued(0)[0].text, "next");
        source.stream_word(0, reply.message, "reply", true);
        assert_eq!(source.messages(2).len(), other);
        assert_eq!(source.take_queued(0, "0").as_deref(), Some("next"));
        assert!(source.take_queued(0, "0").is_none());
    }
}
