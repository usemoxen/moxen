use crate::attachments::{Asset, Picture, Prompt, Thumbnail};
use crate::catalog::{Catalog, OptionValue};
use crate::composer_menu::{Destination, Improvement, Inventory};
use crate::model::*;
use crate::settings::MemoryMatch;
use crate::work::{
    self, Agent, Background, BackgroundTask, Delegated, Delegation, InspectorData, Read, View,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

/// How many threads the fixtures hold.
const FIXTURES: usize = 10;

pub struct MockSource {
    threads: Vec<Thread>,
    messages: Vec<Vec<Message>>,
    running: Vec<Option<usize>>,
    queues: Vec<Vec<Prompt>>,
    images: HashMap<Picture, Arc<gpui::Image>>,
    improvement: Option<(Improvement, Option<String>)>,
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
    archived: HashSet<ThreadId>,
    deleted: HashSet<ThreadId>,
    protected: HashSet<ThreadId>,
    settled: Option<ThreadId>,
    side_answers: HashMap<ThreadId, SideAnswer>,
    reverted: Option<(ThreadId, Option<String>)>,
    context: std::sync::Arc<ContextData>,
    limits: std::sync::Arc<LimitsData>,
    protection: std::sync::Arc<ProtectionData>,
    card: Option<std::sync::Arc<CardState>>,
    /// Project ids without their title override (rename keeps the id).
    renamed_projects: HashMap<String, String>,
    /// Project ids the person removed: listed nowhere, their threads stay.
    removed_projects: HashSet<String>,
    /// What the last thread search answered, while the palette shows it.
    search: SearchState,
    /// The run-size questions waiting, by thread.
    proposals: HashMap<ThreadId, ResearchProposal>,
    /// Research runs started here, by lead thread.
    runs: HashMap<ThreadId, RunSummary>,
    /// Role threads' transcripts, by role thread name.
    role_rows: HashMap<String, Vec<Message>>,
    /// A send parked the run-size question (`researchSizePending`).
    research_pending: bool,
    settings: Option<Snapshot>,
    settings_write: Option<Result<(), String>>,
    settings_notice: Option<SettingsNotice>,
    harness_run: Option<HarnessRun>,
    discovered: Option<Discovery>,
    profile_document: Option<(String, String)>,
    memories: Option<MemoryList>,
    memory_details: HashMap<(String, String), MemoryEntry>,
    memory_search: Option<MemorySearch>,
    managed_skills: Option<Vec<ManagedSkill>>,
    skill_texts: HashMap<(String, String), String>,
    embeddings: Option<Embeddings>,
    acp_registry: Option<crate::settings::AcpRegistryCatalog>,
    remote: Option<RemoteState>,
    updates: Option<UpdateState>,
    provider_accounts: Vec<crate::settings::ProviderAccountSummary>,
    experience: Value,
    experience_case: Option<String>,
    diagnosis: Option<Value>,
    records: Vec<crate::experience::Record>,
    app_update: Option<crate::experience::Update>,
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
        "costUsd": 4.64,
        "costByModel": [
            {"model": "claude-opus-5", "costUsd": 11.63},
            {"model": "claude-sonnet-5", "costUsd": 1.44},
        ],
    }));
    ContextData {
        live: true,
        breakdown,
        reading: None,
        cost: crate::usage::ThreadCost::from_json(&json!({
            "totalUsd": 13.07, "pricedTurns": 12, "unpricedTurns": 0,
            "reported": true, "estimated": false,
            "byModel": [
                {"model": "claude-opus-5", "costUsd": 11.63, "turns": 9, "unpricedTurns": 0},
                {"model": "claude-sonnet-5", "costUsd": 1.44, "turns": 3, "unpricedTurns": 0},
            ],
        })),
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

/// An ISO instant `seconds` ago, in UTC: the mock run reads as minutes old,
/// the way the TUI's fixtures do, instead of dating from a fixed day.
fn past_iso(seconds_ago: i64) -> String {
    use chrono::{TimeDelta, Utc};
    (Utc::now() - TimeDelta::seconds(seconds_ago))
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
    .expect("fixture protection")
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
    #[cfg(all(test, feature = "render-harness"))]
    pub fn with_project_title(mut self, id: &str, title: &str) -> Self {
        self.renamed_projects.insert(id.into(), title.into());
        self
    }

    pub fn new() -> Self {
        let fixtures = [
            (
                "Make model selection keyboard accessible",
                "moxen-agent",
                Status::Idle,
                "0s",
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
            Message::User { text: format!("Please investigate: {}. Keep the change focused and verify the result.", t.title), images: vec![] },
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
            images: HashMap::new(),
            improvement: None,
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
            archived: HashSet::new(),
            deleted: HashSet::new(),
            protected: HashSet::new(),
            settled: None,
            side_answers: HashMap::new(),
            reverted: None,
            context: std::sync::Arc::new(fixture_context()),
            limits: std::sync::Arc::new(fixture_limits()),
            protection: std::sync::Arc::new(fixture_protection()),
            card: None,
            renamed_projects: HashMap::new(),
            removed_projects: HashSet::new(),
            search: SearchState::Idle,
            proposals: HashMap::new(),
            runs: HashMap::new(),
            role_rows: HashMap::new(),
            research_pending: false,
            settings: None,
            settings_write: None,
            settings_notice: None,
            harness_run: None,
            discovered: None,
            profile_document: None,
            memories: None,
            memory_details: HashMap::new(),
            memory_search: None,
            managed_skills: None,
            skill_texts: HashMap::new(),
            embeddings: None,
            acp_registry: None,
            remote: None,
            updates: None,
            provider_accounts: vec![
                crate::settings::ProviderAccountSummary {
                    kind: "claude".into(),
                    id: "personal".into(),
                    instance_id: "claude/personal".into(),
                    label: "Personal".into(),
                    enabled: true,
                    home_path: Some("~/.claude-personal".into()),
                    binary_path: None,
                    launch_args: None,
                    env: Default::default(),
                    model: None,
                    thinking_effort: None,
                    email: None,
                    workspace_name: None,
                    plan_type: Some("Claude Pro".into()),
                    signed_in: None,
                    codex_home_path: None,
                    codex_binary_path: None,
                    codex_launch_args: None,
                    codex_verified: false,
                    disabled_reason: None,
                },
                crate::settings::ProviderAccountSummary {
                    kind: "chatgpt".into(),
                    id: "work".into(),
                    instance_id: "chatgpt/work".into(),
                    label: "Work".into(),
                    enabled: true,
                    home_path: None,
                    binary_path: None,
                    launch_args: None,
                    env: Default::default(),
                    model: None,
                    thinking_effort: None,
                    email: Some("dev@example.test".into()),
                    workspace_name: Some("Acme".into()),
                    plan_type: Some("ChatGPT Plus".into()),
                    signed_in: Some(true),
                    codex_home_path: Some("~/.codex-work".into()),
                    codex_binary_path: None,
                    codex_launch_args: None,
                    codex_verified: true,
                    disabled_reason: None,
                },
            ],
            experience: json!({"onboardingCompleted":true,"seenReleases":["0.1.2"],"version":"0.1.5","releases":[
                {"version":"0.1.2","title":{"en":"Make yourself at home","es":"Ponte a gusto"},
                 "highlights":[{"title":{"en":"A place to start","es":"Por dónde empezar"},"body":{"en":"Walk through appearance, models, memory and tools.","es":"Repasa el aspecto, los modelos, la memoria y las herramientas."},"action":"onboarding"}],
                 "sections":[{"title":{"en":"Added","es":"Novedades"},"entries":[{"en":"A full-page getting-started guide.","es":"Una guía a pantalla completa."}]}]}
            ]}),
            experience_case: None,
            diagnosis: None,
            records: Vec::new(),
            app_update: None,
        }
    }
    pub fn preview() -> Self {
        let mut source = Self::new();
        source.threads[0].status = Status::Running;
        source.threads[0].started_at = Some(Instant::now());
        source.queues[0].push("Also check Escape returns focus to the model control.".into());
        source.threads[1].depth = 1;
        // A research run in progress, so the run view and its role
        // transcripts can be checked without answering first.
        source.answer_proposal(
            4,
            "proposal-4",
            Some(ResearchSize {
                researchers: 2,
                critics: 1,
            }),
        );
        // A checkerboard with large cells keeps thumbnail scaling and zoom visible.
        let specimen = |wide: bool| {
            let (width, height) = if wide { (480, 300) } else { (320, 440) };
            let rgba = ::image::RgbImage::from_fn(width, height, |x, y| {
                ::image::Rgb(match ((x / 40 + y / 40) % 2, wide) {
                    (0, true) => [61, 141, 154],
                    (_, true) => [190, 226, 226],
                    (0, false) => [193, 131, 104],
                    _ => [247, 211, 157],
                })
            });
            let mut bytes = std::io::Cursor::new(Vec::new());
            rgba.write_to(&mut bytes, ::image::ImageFormat::Png)
                .expect("mock image");
            Arc::new(gpui::Image::from_bytes(
                gpui::ImageFormat::Png,
                bytes.into_inner(),
            ))
        };
        let images = vec![
            Thumbnail {
                name: "Layout detail.png".into(),
                source: Picture::Stored("layout-detail".into()),
            },
            Thumbnail {
                name: "Portrait crop.png".into(),
                source: Picture::Stored("portrait-crop".into()),
            },
        ];
        for (index, image) in images.iter().enumerate() {
            source
                .images
                .insert(image.source.clone(), specimen(index == 0));
        }
        if let Message::User {
            images: attached, ..
        } = &mut source.messages[2][0]
        {
            *attached = images;
        }
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
        // A delegated task settling reads as its card, never the raw block.
        source.messages[1].push(Message::TaskNotification {
            tasks: vec![TaskNotice {
                task_id: "t9".into(),
                title: "Backfill the stats card".into(),
                status: "completed".into(),
                duration_ms: Some(92_000),
                model: None,
                branch: Some("task/stats".into()),
                headline: Some("The card lands in the modal.".into()),
                files: Some((2, 10, 3)),
                verdict: None,
                review: false,
                resumes_at: None,
                cancelled: false,
                native: false,
            }],
            at: "Thu 09:53".into(),
        });
        source
    }

    pub fn with_experience(mut self, args: impl IntoIterator<Item = String>) -> Self {
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--mock-theme" => {
                    if let Some(value) = args.next() {
                        self.set_setting("ui.theme", &value);
                    }
                }
                "--mock-language" => {
                    if let Some(value) = args.next() {
                        self.set_setting("ui.language", &value);
                    }
                }
                "--mock-experience" => self.experience_case = args.next(),
                _ => {}
            }
        }
        match self.experience_case.as_deref() {
            Some("guide" | "guide-empty") => {
                self.experience["onboardingCompleted"] = false.into();
                if self.experience_case.as_deref() == Some("guide-empty") {
                    self.threads.clear();
                    self.messages.clear();
                    self.running.clear();
                    self.queues.clear();
                    self.selections.clear();
                    self.permissions.clear();
                    self.asks.clear();
                }
            }
            Some("releases") => self.experience["seenReleases"] = json!([]),
            Some("problems") => {
                let file = std::env::temp_dir()
                    .join("moxen-preview")
                    .join("store.json");
                let config = std::env::temp_dir()
                    .join("moxen-preview")
                    .join("config.json");
                self.records = crate::experience::problems(
                    &json!({"problems":[{"id":"record","kind":"ledger","file":file,"line":7,"message":"A timeline record could not be read."}]}),
                    &json!({"path":config,"problems":[{"path":"ui.theme","message":"The theme is not one of the supported choices."}]}),
                );
            }
            Some("update") => {
                self.app_update = Some(crate::experience::Update::Running {
                    command_id: "mock-update".into(),
                    rollback: false,
                    progress: json!({"stage":"downloading","bytes":48,"total":128}),
                });
            }
            _ => {}
        }
        self
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
    fn has_family_work(&self, id: ThreadId) -> bool {
        std::iter::once(id)
            .chain(self.children(id))
            .any(|id| self.threads[id].status == Status::Running || !self.queues[id].is_empty())
    }
    fn take_settled(&mut self) -> Option<ThreadId> {
        self.settled.take()
    }
    fn has_side_answer(&self, id: ThreadId) -> bool {
        self.side_answers.contains_key(&id)
    }
    fn read_side_answer(&mut self, id: ThreadId, only_unread: bool) -> Option<String> {
        self.side_answers.get_mut(&id)?.read(only_unread)
    }
    fn take_reverted(&mut self) -> Option<(ThreadId, Option<String>)> {
        self.reverted.take()
    }
    fn revert_before(&self, _: ThreadId, row: usize) -> Option<usize> {
        (row <= 1).then_some(0)
    }
    fn is_protected(&self, id: ThreadId) -> bool {
        self.protected.contains(&id)
    }
    fn can_handover(&self, _: ThreadId) -> bool {
        true
    }
    fn archived(&self) -> Vec<(String, String)> {
        self.threads
            .iter()
            .filter(|thread| self.archived.contains(&thread.id))
            .map(|thread| (thread.id.to_string(), thread.title.clone()))
            .collect()
    }
    fn restore_thread(&mut self, uuid: &str) {
        if let Ok(id) = uuid.parse::<ThreadId>() {
            self.archived.remove(&id);
        }
    }
    fn thread_action(&mut self, id: ThreadId, action: ThreadAction) {
        match action {
            ThreadAction::Rename(title) => self.threads[id].title = title,
            ThreadAction::RegenerateTitle => {
                self.threads[id].title = "Regenerated mock title".into()
            }
            ThreadAction::Settle { stop } => {
                for member in std::iter::once(id).chain(self.children(id)) {
                    if stop {
                        self.queues[member].clear();
                        self.stop(member);
                        self.permissions[member] = None;
                        self.asks[member] = None;
                    }
                    self.threads[member].settled = true;
                    self.threads[member].status = Status::Idle;
                }
                self.settled = Some(id);
            }
            ThreadAction::Unsettle => {
                for member in std::iter::once(id).chain(self.children(id)) {
                    self.threads[member].settled = false;
                }
            }
            ThreadAction::Snooze(_) => self.threads[id].status = Status::Snoozed,
            ThreadAction::Unsnooze => self.threads[id].status = Status::Idle,
            ThreadAction::Archive => {
                self.archived.insert(id);
            }
            ThreadAction::Delete => {
                self.deleted.insert(id);
            }
            ThreadAction::Protect => {
                self.protected.insert(id);
            }
            ThreadAction::ContinueAtReset | ThreadAction::CancelContinue { .. } => {}
            ThreadAction::SideQuestion(_) => {
                self.side_answers.insert(
                    id,
                    SideAnswer::new("This mock answer was not added to the transcript.".into()),
                );
            }
            ThreadAction::Revert { draft, .. } => {
                self.messages[id].clear();
                self.reverted = Some((id, draft));
            }
            ThreadAction::Continue { selection } => self.create_thread(NewThread {
                project: Some(self.threads[id].project.clone()),
                prompt: format!("Continue {}", self.threads[id].title).into(),
                runtime_mode: Some(self.threads[id].runtime_mode.clone()),
                interaction_mode: self.threads[id].interaction_mode.clone(),
                model: selection,
            }),
            ThreadAction::Handover { prompt, selection }
            | ThreadAction::Delegate {
                task: prompt,
                selection,
            } => self.create_thread(NewThread {
                project: Some(self.threads[id].project.clone()),
                prompt: prompt.into(),
                runtime_mode: Some(self.threads[id].runtime_mode.clone()),
                interaction_mode: self.threads[id].interaction_mode.clone(),
                model: Some(selection),
            }),
        }
    }
    fn queued(&self, id: ThreadId) -> Vec<Queued> {
        let last = self.queues[id].len().saturating_sub(1);
        self.queues[id]
            .iter()
            .enumerate()
            .map(|(at, prompt)| Queued {
                key: at.to_string(),
                text: prompt.text.clone(),
                images: vec![],
                held: false,
                scheduled: None,
                earlier: at,
                later: last - at,
            })
            .collect()
    }
    fn take_queued(&mut self, id: ThreadId, key: &str) -> Option<Prompt> {
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
        if self.experience_case.as_deref() == Some("guide-empty") {
            return Vec::new();
        }
        ["moxen-agent", "moxen-chat"]
            .into_iter()
            .filter(|id| !self.removed_projects.contains(*id))
            .map(|id| Project {
                id: id.into(),
                title: self
                    .renamed_projects
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| id.into()),
            })
            .collect()
    }
    fn project_id(&self, id: ThreadId) -> Option<String> {
        self.threads.get(id).map(|thread| thread.project.clone())
    }
    fn create_thread(&mut self, draft: NewThread) {
        let id = self.threads.len();
        let title: String = draft.prompt.text.chars().take(48).collect();
        let selection = draft.model.unwrap_or_else(opus);
        self.threads.push(Thread {
            id,
            title,
            project: draft
                .project
                .unwrap_or_else(|| crate::language::message("guide.noProjectChoice").into()),
            status: Status::Idle,
            activity: "0s".into(),
            depth: 0,
            settled: false,
            model: selection.model.clone(),
            started_at: None,
            runtime_mode: draft.runtime_mode.unwrap_or_else(|| "full-access".into()),
            interaction_mode: draft.interaction_mode,
        });
        let message = self.user_message(draft.prompt);
        self.messages.push(vec![
            message,
            Message::Assistant {
                text: "Started. This is the mock source, so nothing runs.".into(),
                at: "Thu 09:38".into(),
            },
        ]);
        self.running.push(None);
        self.queues.push(vec![]);
        self.permissions.push(None);
        self.asks.push(None);
        self.selections.push(selection);
        self.opened = Some(id);
        if self.threads[id].interaction_mode == "research"
            || self.threads[id].interaction_mode == "orchestrate"
        {
            // The new thread is asked for its run size once it opens.
            let fixture = self.proposal_fixture(id);
            if let Some(proposal) = fixture {
                self.proposals.insert(id, proposal);
            }
        }
    }
    fn order(&self, _: bool) -> Vec<ThreadId> {
        // Threads started here come first, newest first.
        (FIXTURES..self.threads.len())
            .rev()
            .chain(0..FIXTURES.min(self.threads.len()))
            .filter(|id| !self.archived.contains(id) && !self.deleted.contains(id))
            .collect()
    }
    fn take_opened(&mut self) -> Option<ThreadId> {
        self.opened.take()
    }
    fn add_project(&mut self, path: String) {
        self.added = Some(path);
    }
    fn rename_project(&mut self, id: &str, title: String) {
        // Collapses like the server's `normalizeProjectTitle`.
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if title.is_empty() {
            return;
        }
        let known = self.projects().into_iter().any(|project| project.id == id);
        if !known {
            return;
        }
        // The id stays: threads keep pointing at it, only the title changes.
        self.renamed_projects.insert(id.into(), title);
    }
    fn remove_project(&mut self, id: &str) {
        if ["moxen-agent", "moxen-chat"].contains(&id) {
            self.removed_projects.insert(id.into());
        }
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
            ..SnapshotUsage::default()
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
        let mut threads = self.threads.clone();
        for thread in &mut threads {
            if self.removed_projects.contains(&thread.project) {
                thread.project = "Unknown project".into();
            }
        }
        threads
    }
    fn messages(&self, id: ThreadId) -> std::sync::Arc<Vec<Message>> {
        std::sync::Arc::new(self.messages[id].clone())
    }
    fn send_message(&mut self, id: ThreadId, prompt: Prompt, _: Delivery) -> Option<Reply> {
        if prompt.text.trim().is_empty() && prompt.assets.is_empty() {
            return None;
        }
        let research_once =
            matches!(&prompt.once, Some(mode) if mode == "research" || mode == "orchestrate");
        if (self.threads[id].interaction_mode == "research"
            || self.threads[id].interaction_mode == "orchestrate"
            || research_once)
            && !self.runs.contains_key(&id)
        {
            // The server parked the run-size question: the next send asks for
            // it, and the question shows until it is answered.
            self.research_pending = true;
            self.proposals
                .entry(id)
                .or_insert_with(|| Self::proposal_for(id, self.threads[id].title.clone()));
        }
        if self.threads[id].status == Status::Running {
            self.queues[id].push(prompt);
            return None;
        }
        self.threads[id].status = Status::Running;
        self.threads[id].started_at = Some(Instant::now());
        self.threads[id].activity = "0s".into();
        let message = self.user_message(prompt);
        self.messages[id].push(message);
        let message = self.messages[id].len();
        self.messages[id].push(Message::Assistant {
            text: String::new(),
            at: "Thu 09:38".into(),
        });
        self.running[id] = Some(message);
        Some(Reply { message, words: "The keyboard path is verified. Search receives focus on open, selection preserves the draft, and Escape returns to the trigger. The targeted tests pass; I’m checking the native window next.".split_inclusive(' ').map(str::to_string).collect() })
    }
    fn composer_directory(&self, _: &Destination) -> Option<String> {
        Some("mock-project".into())
    }
    fn skills(
        &self,
        _: &Destination,
        _: Option<&Selection>,
    ) -> Option<Arc<Result<Inventory, String>>> {
        Some(Arc::new(Inventory::decode(&json!({
            "trigger": "/", "skills": [
              {"name":"accessibility", "description":"Check keyboard and screen reader behavior", "enabled":true, "userInvocable":true},
              {"name":"design-review", "description":"Review layout and interaction against the design system", "enabled":true, "userInvocable":true},
              {"name":"xlsx", "displayName":"Spreadsheets", "description":"Read and write spreadsheet files", "enabled":true, "userInvocable":true}
            ],
            "commands": [{"name":"compact", "description":"Summarize the current thread"}]
        }))))
    }
    fn image(&self, picture: &Picture) -> Option<Result<Arc<gpui::Image>, String>> {
        self.images.get(picture).cloned().map(Ok)
    }
    fn improve(&mut self, request: Improvement) {
        let improved = format!(
            "{}. State the expected behavior and verify the result.",
            request.original.trim().trim_end_matches('.')
        );
        self.improvement = Some((request, Some(improved)));
    }
    fn take_improvement(&mut self) -> Option<(Improvement, Option<String>)> {
        self.improvement.take()
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
    fn read_settings(&mut self) {
        if self.settings.is_none() {
            self.settings = Some(crate::mock_settings::snapshot_fixture());
        }
    }
    fn connection(&self) -> Connection {
        match self.experience_case.as_deref() {
            Some("no-server") => Connection::Failed("No Moxen server is running.".into()),
            Some("starting") => Connection::Starting,
            _ => Connection::Live,
        }
    }
    fn retry(&mut self) {
        if self.connection() == Connection::Failed("No Moxen server is running.".into()) {
            self.experience_case = Some("starting".into());
        }
    }
    fn paired_name(&self) -> Option<String> {
        (self.experience_case.as_deref() == Some("paired")).then(|| "Studio Mac".into())
    }
    fn restart_required(&self) -> bool {
        self.experience_case.as_deref() == Some("restart")
    }
    fn experience(&self) -> Option<Arc<Result<Value, String>>> {
        Some(Arc::new(Ok(self.experience.clone())))
    }
    fn update_experience(&mut self, change: Value) {
        if change["completeOnboarding"] == true {
            self.experience["onboardingCompleted"] = true.into();
        }
        if let Some(version) = change["seenRelease"].as_str()
            && !crate::experience::seen(&self.experience, version)
        {
            self.experience["seenReleases"]
                .as_array_mut()
                .unwrap()
                .push(version.into());
        }
    }
    fn set_guide_memory(&mut self, choice: crate::experience::Memory) {
        for (key, value) in choice.writes() {
            self.set_setting(key, value);
        }
    }
    fn records(&self) -> Vec<crate::experience::Record> {
        self.records.clone()
    }
    fn fix_record(&mut self, fix: crate::experience::Fix) {
        self.records
            .retain(|record| record.fix.as_ref() != Some(&fix));
    }
    fn diagnosis(&self) -> Option<Arc<Result<Value, String>>> {
        self.diagnosis.clone().map(|value| Arc::new(Ok(value)))
    }
    fn read_diagnosis(&mut self) {
        self.diagnosis = Some(
            json!({"node":{"ok":true,"version":"1.3.13"}, "git":{"ok":true},
            "providers":{"claude":{"ok":true,"installed":true,"version":"2.1.0"},"opencode":{"ok":false,"installed":false,"login":"Run opencode auth login"},"codex":{"ok":true,"installed":true,"version":"0.120.0"}},
            "store":{"ok":true,"path":std::env::temp_dir().join("moxen-preview")}, "auth":{"ok":false,"providers":[],"types":{}}}),
        );
    }
    fn app_update(&self) -> Option<crate::experience::Update> {
        self.app_update.clone()
    }
    fn settings(&self) -> Option<Arc<Result<Snapshot, String>>> {
        self.settings.clone().map(|snapshot| Arc::new(Ok(snapshot)))
    }
    fn set_setting(&mut self, key: &str, value: &str) {
        self.read_settings();
        if let Some(snapshot) = self.settings.as_mut() {
            crate::mock_settings::apply_set(snapshot, key, value);
        }
        if key == "remote.enabled" {
            self.read_remote();
            if let Some(state) = self.remote.as_mut() {
                state.enabled = value == "true";
                state.listening = if state.enabled {
                    crate::mock_settings::remote_fixture().listening
                } else {
                    vec![]
                };
                state.pairing = None;
            }
        }
        self.settings_write = Some(Ok(()));
    }
    fn duplicate_setting(&mut self, key: &str, id: &str, new_id: &str) {
        self.read_settings();
        if let Some(snapshot) = self.settings.as_mut() {
            crate::mock_settings::duplicate_item(snapshot, key, id, new_id);
        }
        self.settings_write = Some(Ok(()));
    }
    fn take_settings_write(&mut self) -> Option<Result<(), String>> {
        self.settings_write.take()
    }
    fn test_harness(&mut self, profile: &str, _model: Option<String>) {
        self.harness_run = Some(HarnessRun::Done {
            scope: "harness".into(),
            kind: "test".into(),
            name: profile.into(),
            ok: true,
            message: "Answered in 1.2s.".into(),
            tools: vec!["read".into(), "bash".into()],
        });
    }
    fn probe_harness(&mut self, profile: &str, _model: Option<String>) {
        self.harness_run = Some(HarnessRun::Done {
            scope: "harness".into(),
            kind: "probe".into(),
            name: profile.into(),
            ok: true,
            message: "2 checks ran.".into(),
            tools: vec![],
        });
    }
    fn test_mcp(&mut self, name: &str) {
        self.harness_run = Some(HarnessRun::Done {
            scope: "mcp".into(),
            kind: "test".into(),
            name: name.into(),
            ok: true,
            message: "Listed 3 tools.".into(),
            tools: vec!["lookup".into(), "fetch".into(), "search".into()],
        });
    }
    fn harness_run(&self) -> Option<HarnessRun> {
        self.harness_run.clone()
    }
    fn discover_models(
        &mut self,
        _base_url: &str,
        _api_format: &str,
        _api_key_env: Option<String>,
    ) {
        self.discovered = Some(crate::mock_settings::discovery_fixture());
    }
    fn take_discovered(&mut self) -> Option<Discovery> {
        self.discovered.take()
    }
    fn export_profile(&mut self, profile: &str) {
        self.profile_document = Some((
            profile.into(),
            format!(
                "{{\n  \"id\": \"{profile}\",\n  \"apiFormat\": \"chat\",\n  \"baseUrl\": \"http://localhost:8080\",\n  \"models\": [{{\"id\": \"large\"}}]\n}}"
            ),
        ));
    }
    fn take_profile_document(&mut self) -> Option<(String, String)> {
        self.profile_document.take()
    }
    fn import_profile(&mut self, _text: &str) {
        self.settings_write = Some(Ok(()));
        self.settings_notice = Some(SettingsNotice {
            text: "Imported profile branch.".into(),
            error: false,
        });
    }
    fn clear_settings_transients(&mut self) {
        self.discovered = None;
        self.profile_document = None;
    }
    fn take_settings_notice(&mut self) -> Option<SettingsNotice> {
        self.settings_notice.take()
    }
    fn read_memories(&mut self, _thread: Option<ThreadId>) {
        if self.memories.is_none() {
            self.memories = Some(crate::mock_settings::memory_fixture());
        }
    }
    fn memories(&self) -> Option<Arc<Result<MemoryList, String>>> {
        self.memories.clone().map(|list| Arc::new(Ok(list)))
    }
    fn read_memory(&mut self, _thread: Option<ThreadId>, name: &str, scope: &str) {
        self.read_memories(None);
        if let Some(entry) = self
            .memories
            .clone()
            .unwrap_or_else(crate::mock_settings::memory_fixture)
            .memories
            .into_iter()
            .find(|entry| entry.name == name && entry.scope == scope)
        {
            self.memory_details
                .insert((name.into(), scope.into()), entry);
        }
    }
    fn memory_detail(&self, name: &str, scope: &str) -> Option<Arc<Result<MemoryEntry, String>>> {
        self.memory_details
            .get(&(name.to_string(), scope.to_string()))
            .cloned()
            .map(|entry| Arc::new(Ok(entry)))
    }
    fn search_memories(&mut self, _thread: Option<ThreadId>, query: &str) {
        self.read_memories(None);
        let needle = query.to_lowercase();
        let matches: Vec<MemoryMatch> = self
            .memories
            .clone()
            .map(|list| list.memories)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| {
                entry.name.to_lowercase().contains(&needle)
                    || entry.description.to_lowercase().contains(&needle)
            })
            .map(|entry| MemoryMatch {
                name: entry.name,
                description: entry.description,
                scope: entry.scope,
                excerpt: "…matches here…".into(),
            })
            .collect();
        self.memory_search = Some(MemorySearch {
            total: matches.len(),
            matches,
        });
    }
    fn memory_search(&self) -> Option<Arc<Result<MemorySearch, String>>> {
        self.memory_search
            .clone()
            .map(|search| Arc::new(Ok(search)))
    }
    fn save_memory(&mut self, _thread: Option<ThreadId>, draft: MemoryDraft) {
        self.read_memories(None);
        if let Some(list) = self.memories.as_mut() {
            let entry = MemoryEntry {
                name: draft.name,
                description: draft.description,
                memory_type: draft.memory_type,
                scope: draft.scope,
                body: Some(draft.body),
            };
            if let Some(at) = list
                .memories
                .iter()
                .position(|old| old.name == entry.name && old.scope == entry.scope)
            {
                list.memories[at] = entry;
            } else {
                list.memories.push(entry);
            }
        }
    }
    fn delete_memory(&mut self, _thread: Option<ThreadId>, name: &str, scope: &str) {
        self.read_memories(None);
        if let Some(list) = self.memories.as_mut() {
            list.memories
                .retain(|entry| !(entry.name == name && entry.scope == scope));
        }
        self.memory_details
            .remove(&(name.to_string(), scope.to_string()));
    }
    fn edit_memory(
        &mut self,
        _thread: Option<ThreadId>,
        name: &str,
        scope: &str,
        old: &str,
        new: &str,
        _description: Option<String>,
    ) {
        self.read_memories(None);
        if let Some(list) = self.memories.as_mut()
            && let Some(entry) = list
                .memories
                .iter_mut()
                .find(|entry| entry.name == name && entry.scope == scope)
        {
            let body = entry.body.clone().unwrap_or_default();
            entry.body = Some(if body.contains(old) {
                body.replacen(old, new, 1)
            } else {
                new.into()
            });
        }
        self.memory_details
            .remove(&(name.to_string(), scope.to_string()));
    }
    fn append_memory(&mut self, _thread: Option<ThreadId>, name: &str, scope: &str, text: &str) {
        self.read_memories(None);
        if let Some(list) = self.memories.as_mut()
            && let Some(entry) = list
                .memories
                .iter_mut()
                .find(|entry| entry.name == name && entry.scope == scope)
        {
            let body = entry.body.clone().unwrap_or_default();
            entry.body = Some(if body.is_empty() {
                text.into()
            } else {
                format!("{body}\n{text}")
            });
        }
    }
    fn import_claude_memory(&mut self, _thread: Option<ThreadId>) {
        self.settings_notice = Some(SettingsNotice {
            text: "Imported CLAUDE.md.".into(),
            error: false,
        });
    }
    fn read_embeddings(&mut self) {
        if self.embeddings.is_none() {
            self.embeddings = Some(crate::mock_settings::embeddings_fixture());
        }
    }
    fn embeddings(&self) -> Option<Arc<Result<Embeddings, String>>> {
        self.embeddings.clone().map(|state| Arc::new(Ok(state)))
    }
    fn read_acp_registry(&mut self, _force_refresh: bool) {
        if self.acp_registry.is_none() {
            self.acp_registry = Some(crate::settings::AcpRegistryCatalog {
                source: "cache".into(),
                agents: vec![
                    crate::settings::AcpRegistryPreset {
                        id: "cline".into(),
                        name: "Cline".into(),
                        description: "Autonomous coding agent via ACP".into(),
                        version: Some("1.0.0".into()),
                        command: Some("npx".into()),
                        args: vec!["-y".into(), "cline".into(), "--acp".into()],
                        env: vec![],
                        available: true,
                        note: None,
                    },
                    crate::settings::AcpRegistryPreset {
                        id: "goose".into(),
                        name: "Goose".into(),
                        description: "Open-source developer agent".into(),
                        version: Some("1.2.0".into()),
                        command: Some("goose".into()),
                        args: vec!["acp".into()],
                        env: vec![],
                        available: false,
                        note: Some("Goose binary is not installed on PATH.".into()),
                    },
                ],
            });
        }
    }
    fn acp_registry(&self) -> Option<Arc<Result<crate::settings::AcpRegistryCatalog, String>>> {
        self.acp_registry.clone().map(|cat| Arc::new(Ok(cat)))
    }
    fn setup_embeddings(&mut self, _all: bool) {
        self.read_embeddings();
        self.settings_notice = Some(SettingsNotice {
            text: "Indexed 2 memories.".into(),
            error: false,
        });
    }
    fn rebuild_embeddings(&mut self, _all: bool) {
        self.read_embeddings();
        self.settings_notice = Some(SettingsNotice {
            text: "Indexed 2 memories.".into(),
            error: false,
        });
    }
    fn unload_embeddings(&mut self) {
        self.embeddings = Some(Embeddings {
            phase: "idle".into(),
            state: "stopped".into(),
            message: Some("Unloaded.".into()),
            percent: None,
            busy: false,
            indexed: 0,
        });
    }
    fn read_managed_skills(&mut self, _thread: Option<ThreadId>) {
        if self.managed_skills.is_none() {
            let (skills, texts) = crate::mock_settings::skill_fixture();
            for (source, folder, text) in texts {
                self.skill_texts.insert((source, folder), text);
            }
            self.managed_skills = Some(skills);
        }
    }
    fn managed_skills(&self) -> Option<Arc<Result<Vec<ManagedSkill>, String>>> {
        self.managed_skills
            .clone()
            .map(|skills| Arc::new(Ok(skills)))
    }
    fn read_skill_text(&mut self, _thread: Option<ThreadId>, _source: &str, _folder: &str) {}
    fn skill_text(&self, source: &str, folder: &str) -> Option<Arc<Result<String, String>>> {
        self.skill_texts
            .get(&(source.to_string(), folder.to_string()))
            .cloned()
            .map(|text| Arc::new(Ok(text)))
    }
    fn save_skill(
        &mut self,
        _thread: Option<ThreadId>,
        source: &str,
        folder: &str,
        text: &str,
        _previous: &str,
    ) {
        self.skill_texts
            .insert((source.into(), folder.into()), text.into());
    }
    fn set_skill_enabled(
        &mut self,
        _thread: Option<ThreadId>,
        source: &str,
        folder: &str,
        enabled: bool,
    ) {
        self.read_managed_skills(None);
        if let Some(skills) = self.managed_skills.as_mut()
            && let Some(skill) = skills
                .iter_mut()
                .find(|skill| skill.source == source && skill.folder == folder)
        {
            skill.enabled = enabled;
        }
    }
    fn set_skill_providers(
        &mut self,
        _thread: Option<ThreadId>,
        source: &str,
        folder: &str,
        providers: Vec<String>,
    ) {
        self.read_managed_skills(None);
        if let Some(skills) = self.managed_skills.as_mut()
            && let Some(skill) = skills
                .iter_mut()
                .find(|skill| skill.source == source && skill.folder == folder)
        {
            skill.providers = providers;
        }
    }
    fn remove_skill(&mut self, _thread: Option<ThreadId>, source: &str, folder: &str) {
        self.read_managed_skills(None);
        if let Some(skills) = self.managed_skills.as_mut() {
            skills.retain(|skill| !(skill.source == source && skill.folder == folder));
        }
        self.skill_texts
            .remove(&(source.to_string(), folder.to_string()));
    }
    fn import_skill(&mut self, _thread: Option<ThreadId>, source: &str, from: &str) {
        self.read_managed_skills(None);
        let folder = from.rsplit('/').next().unwrap_or(from).to_string();
        if let Some(skills) = self.managed_skills.as_mut() {
            skills.push(ManagedSkill {
                source: source.into(),
                folder: folder.clone(),
                name: folder.clone(),
                description: "Imported here.".into(),
                path: from.into(),
                enabled: true,
                editable: true,
                providers: vec![],
            });
        }
        self.skill_texts
            .insert((source.into(), folder), "# Imported\n".into());
    }
    fn read_remote(&mut self) {
        if self.remote.is_none() {
            self.remote = Some(crate::mock_settings::remote_fixture());
        }
    }
    fn remote(&self) -> Option<Arc<Result<RemoteState, String>>> {
        self.remote.clone().map(|state| Arc::new(Ok(state)))
    }
    fn pair_remote(&mut self) {
        self.read_remote();
        if let Some(state) = self.remote.as_mut() {
            state.pairing = Some(crate::settings::Pairing {
                code: "ABCD-EFGH".into(),
                addresses: vec!["192.168.1.2:47317".into()],
            });
        }
    }
    fn cancel_pairing(&mut self) {
        if let Some(state) = self.remote.as_mut() {
            state.pairing = None;
        }
    }
    fn revoke_device(&mut self, device_id: &str) {
        self.read_remote();
        if let Some(state) = self.remote.as_mut() {
            state.devices.retain(|device| device.id != device_id);
        }
    }
    fn read_updates(&mut self) {
        if self.updates.is_none() {
            self.updates = Some(crate::mock_settings::updates_fixture());
        }
    }
    fn updates(&self) -> Option<Arc<Result<UpdateState, String>>> {
        self.updates.clone().map(|state| Arc::new(Ok(state)))
    }
    fn update_provider(&mut self, _provider: &str) {
        self.settings_notice = Some(SettingsNotice {
            text: "Already current.".into(),
            error: false,
        });
    }
    fn update_all_providers(&mut self) {
        self.settings_notice = Some(SettingsNotice {
            text: "All providers are up to date.".into(),
            error: false,
        });
    }
    fn read_provider_accounts(&mut self) {}
    fn provider_accounts(
        &self,
    ) -> Option<Arc<Result<Vec<crate::settings::ProviderAccountSummary>, String>>> {
        Some(Arc::new(Ok(self.provider_accounts.clone())))
    }
    fn save_provider_account(&mut self, payload: serde_json::Value) {
        let Some(kind) = payload.get("kind").and_then(serde_json::Value::as_str) else {
            return;
        };
        let Some(id) = payload.get("id").and_then(serde_json::Value::as_str) else {
            return;
        };
        let id = id.trim().to_lowercase();
        let instance_id = format!("{kind}/{id}");
        let str_opt = |k: &str| {
            payload
                .get(k)
                .and_then(serde_json::Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        if let Some(existing) = self
            .provider_accounts
            .iter_mut()
            .find(|a| a.instance_id == instance_id)
        {
            if payload.get("label").is_some() {
                existing.label = str_opt("label").unwrap_or_else(|| existing.id.clone());
            }
            if payload.get("homePath").is_some() {
                existing.home_path = str_opt("homePath");
            }
            if payload.get("binaryPath").is_some() {
                existing.binary_path = str_opt("binaryPath");
            }
            if payload.get("launchArgs").is_some() {
                existing.launch_args = str_opt("launchArgs");
            }
            if payload.get("model").is_some() {
                existing.model = str_opt("model");
            }
            if payload.get("thinkingEffort").is_some() {
                existing.thinking_effort = str_opt("thinkingEffort");
            }
            if payload.get("codexHomePath").is_some() {
                existing.codex_home_path = str_opt("codexHomePath");
            }
            if payload.get("codexBinaryPath").is_some() {
                existing.codex_binary_path = str_opt("codexBinaryPath");
            }
            if payload.get("codexLaunchArgs").is_some() {
                existing.codex_launch_args = str_opt("codexLaunchArgs");
            }
            if let Some(env_val) = payload.get("env") {
                existing.env = env_val
                    .as_object()
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default();
            }
        } else {
            self.provider_accounts
                .push(crate::settings::ProviderAccountSummary {
                    kind: kind.to_string(),
                    id: id.clone(),
                    instance_id: instance_id.clone(),
                    label: str_opt("label").unwrap_or_else(|| id.clone()),
                    enabled: true,
                    home_path: str_opt("homePath"),
                    binary_path: str_opt("binaryPath"),
                    launch_args: str_opt("launchArgs"),
                    env: Default::default(),
                    model: str_opt("model"),
                    thinking_effort: str_opt("thinkingEffort"),
                    email: None,
                    workspace_name: None,
                    plan_type: None,
                    signed_in: if kind == "chatgpt" { Some(false) } else { None },
                    codex_home_path: str_opt("codexHomePath"),
                    codex_binary_path: str_opt("codexBinaryPath"),
                    codex_launch_args: str_opt("codexLaunchArgs"),
                    codex_verified: false,
                    disabled_reason: None,
                });
        }
        self.settings_notice = Some(SettingsNotice {
            text: format!("Saved {instance_id}."),
            error: false,
        });
    }
    fn toggle_provider_account(&mut self, kind: &str, id: &str, enabled: bool) {
        let target = format!("{kind}/{id}");
        if let Some(account) = self
            .provider_accounts
            .iter_mut()
            .find(|a| a.instance_id == target)
        {
            account.enabled = enabled;
        }
    }
    fn remove_provider_account(&mut self, kind: &str, id: &str) {
        let target = format!("{kind}/{id}");
        self.provider_accounts.retain(|a| a.instance_id != target);
        self.settings_notice = Some(SettingsNotice {
            text: format!("Removed {target}."),
            error: false,
        });
    }
    fn start_chatgpt_login(&mut self, account_id: &str, _label: Option<&str>) {
        let target = format!("chatgpt/{}", account_id.trim().to_lowercase());
        if let Some(account) = self
            .provider_accounts
            .iter_mut()
            .find(|a| a.instance_id == target)
        {
            account.signed_in = Some(true);
            if account.email.is_none() {
                account.email = Some("dev@example.test".into());
            }
        }
        self.settings_notice = Some(SettingsNotice {
            text: format!("Signed in {target}."),
            error: false,
        });
    }
    fn logout_chatgpt(&mut self, account_id: &str) {
        let target = format!("chatgpt/{}", account_id.trim().to_lowercase());
        if let Some(account) = self
            .provider_accounts
            .iter_mut()
            .find(|a| a.instance_id == target)
        {
            account.signed_in = Some(false);
            account.codex_verified = false;
        }
        self.settings_notice = Some(SettingsNotice {
            text: format!("Signed out {target}."),
            error: false,
        });
    }
    fn pair_chatgpt_codex(&mut self, account_id: &str, _confirm_workspace: bool) {
        let target = format!("chatgpt/{}", account_id.trim().to_lowercase());
        if let Some(account) = self
            .provider_accounts
            .iter_mut()
            .find(|a| a.instance_id == target)
        {
            account.codex_verified = true;
        }
        self.settings_notice = Some(SettingsNotice {
            text: format!("Verified Codex companion for {target}."),
            error: false,
        });
    }
    fn start_provider_account_login(&mut self, kind: &str, id: &str) {
        let slug = id.trim().to_lowercase();
        let target = format!("{kind}/{slug}");
        if let Some(account) = self
            .provider_accounts
            .iter_mut()
            .find(|a| a.instance_id == target)
        {
            if kind == "chatgpt" {
                if account.codex_home_path.is_none() && slug != "default" {
                    account.codex_home_path = Some(format!("~/.moxen/accounts/chatgpt/{slug}"));
                }
                account.codex_verified = true;
            } else if account.home_path.is_none() && slug != "default" {
                account.home_path = Some(format!("~/.moxen/accounts/{kind}/{slug}"));
            }
        }
        self.settings_notice = Some(SettingsNotice {
            text: if kind == "chatgpt" {
                format!("Signed in and verified Codex companion for {target}.")
            } else {
                format!("Signed in {target}.")
            },
            error: false,
        });
    }
    fn apply_update(&mut self) {
        self.settings_notice = Some(SettingsNotice {
            text: "Updated to 0.3.0.".into(),
            error: false,
        });
        if let Some(state) = self.updates.as_mut() {
            state.status = Some("up-to-date".into());
            state.current = state.latest.clone();
        }
    }
    fn rollback_update(&mut self) {
        self.settings_notice = Some(SettingsNotice {
            text: "Rolled back.".into(),
            error: false,
        });
    }
    fn search_threads(&mut self, query: &str) {
        let query = query.trim().to_string();
        if query.is_empty() {
            self.search = SearchState::Idle;
            return;
        }
        let terms: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let holds = |text: &str| {
            let lower = text.to_lowercase();
            terms.iter().all(|term| lower.contains(term))
        };
        let mut threads = vec![];
        for (id, thread) in self.threads.iter().enumerate() {
            if self.deleted.contains(&id) {
                continue;
            }
            let user_text = self.messages[id].iter().find_map(|message| match message {
                Message::User { text, .. } => Some(text.clone()),
                _ => None,
            });
            let mut hits = vec![];
            if holds(&thread.title) {
                hits.push(SearchHit {
                    kind: "title".into(),
                    snippet: thread.title.clone(),
                    source: String::new(),
                });
            }
            if let Some(text) = user_text
                && holds(&text)
            {
                let snippet: String = text.chars().take(140).collect();
                hits.push(SearchHit {
                    kind: "message".into(),
                    snippet,
                    source: "user".into(),
                });
            }
            if hits.is_empty() {
                continue;
            }
            threads.push(SearchResult {
                uuid: format!("mock-{id}"),
                project_id: thread.project.clone(),
                title: thread.title.clone(),
                settled: thread.settled,
                hit_count: hits.len(),
                hits,
            });
        }
        // Active threads first, then settled ones, like the server.
        threads.sort_by_key(|row| row.settled);
        self.search = SearchState::Done(SearchResults {
            query,
            total: threads.len(),
            threads,
        });
    }
    fn search_state(&self) -> SearchState {
        self.search.clone()
    }
    fn thread_at_uuid(&self, uuid: &str) -> Option<ThreadId> {
        uuid.strip_prefix("mock-")?
            .parse::<ThreadId>()
            .ok()
            .filter(|id| self.threads.get(*id).is_some())
    }
    fn watch_research(&mut self, _thread: Option<ThreadId>) {}
    fn proposal(&self, id: ThreadId) -> Option<ResearchProposal> {
        if let Some(proposal) = self.proposals.get(&id) {
            return Some(proposal.clone());
        }
        self.proposal_fixture(id)
    }
    fn answer_proposal(&mut self, id: ThreadId, _proposal: &str, size: Option<ResearchSize>) {
        self.proposals.remove(&id);
        let Some(size) = size else {
            return;
        };
        let lead = format!("mock-{id}");
        // Started roles only: the researchers reported and the critic is
        // reviewing; the finalizer has no thread yet.
        let roles: Vec<serde_json::Value> = (0..size.researchers)
            .map(|at| {
                serde_json::json!({"threadId": format!("{lead}-researcher-{at}"),
                    "role": "researcher", "question": "Survey the area"})
            })
            .chain((0..size.critics).map(|at| {
                serde_json::json!({"threadId": format!("{lead}-critic-{at}"),
                    "role": "critic", "question": "Review the reports"})
            }))
            .collect();
        let run = serde_json::json!({
            "leadThreadId": lead, "state": "running",
            "size": {"researchers": size.researchers, "critics": size.critics},
            "models": {
                "researcher": {"provider": "claudeAgent", "model": "opus-5-5", "thinkingEffort": "medium"},
                "critic": {"provider": "claudeAgent", "model": "opus-5-5", "thinkingEffort": "high"},
                "finalizer": {"provider": "claudeAgent", "model": "opus-5-5", "thinkingEffort": "medium"}
            },
            "createdAt": past_iso(252), "updatedAt": past_iso(5),
            "roles": roles,
        });
        let titles = |uuid: &str| {
            uuid.strip_prefix(&format!("{lead}-"))
                .map(|role| format!("{} report", role.replace('-', " ")))
        };
        let rows: Vec<crate::research::RoleRow> = roles
            .iter()
            .map(|role| crate::research::RoleRow {
                thread_id: role["threadId"].as_str().unwrap_or_default().to_string(),
                role: match role["role"].as_str().unwrap_or_default() {
                    "critic" => "critic",
                    "finalizer" => "finalizer",
                    _ => "researcher",
                },
                question: role["question"].as_str().unwrap_or_default().to_string(),
                // The first researcher already reported; the critic is
                // reviewing it.
                session: if role["role"] == "researcher"
                    && role["threadId"] == format!("{lead}-researcher-0")
                {
                    "idle"
                } else {
                    "running"
                }
                .to_string(),
                turn: if role["role"] == "researcher" {
                    "completed"
                } else {
                    "running"
                }
                .to_string(),
            })
            .collect();
        if let Some(summary) =
            crate::research::summarize_run(&run, &self.threads[id].title, rows, &titles)
        {
            self.runs.insert(id, summary);
        }
        self.role_rows.insert(
            format!("{lead}-researcher-0"),
            Self::role_transcript(
                "Survey how the picker keeps focus while it lists.",
                "Traced the event from the control to its view state. Drafts survive switching threads; checking the keyboard path next.",
                vec![
                    Self::tool_call(
                        "read-1",
                        "2026-11-16T10:00:10Z",
                        "2026-11-16T10:00:11Z",
                        json!({"itemType": "tool_call", "status": "completed",
                            "toolCallId": "read-1", "title": "Read",
                            "data": {"tool": "Read",
                                "state": {
                                    "input": {"file_path": "src/model_picker.rs"},
                                    "output": Self::numbered_lines(30),
                                }}}),
                    ),
                    Self::tool_call(
                        "command-1",
                        "2026-11-16T10:00:20Z",
                        "2026-11-16T10:00:23.400Z",
                        json!({"itemType": "command_execution", "status": "completed",
                            "toolCallId": "command-1", "title": "Bash",
                            "data": {"tool": "Bash",
                                "state": {
                                    "input": {"command": "cargo test model_picker", "workdir": "/repo"},
                                    "output": "running 3 tests\ntest opens_with_search_focus ... ok\ntest escape_restores_trigger ... ok\ntest selection_preserves_draft ... ok\n\n3 passed; 0 failed",
                                    "metadata": {"exit": 0},
                                }}}),
                    ),
                ],
            ),
        );
        self.role_rows.insert(
            format!("{lead}-researcher-1"),
            Self::role_transcript(
                "Survey the reconnect path for lost drafts.",
                "Reading the reconnect path in three threads, looking for the place a draft is dropped.",
                vec![
                    vec![
                    json!({"id": "thought-1", "kind": "reasoning", "tone": "info",
                        "createdAt": "2026-11-16T10:01:00Z", "turnId": "t", "summary": "",
                        "payload": {"itemType": "reasoning", "status": "inProgress",
                            "toolCallId": "thought-1",
                            "text": "Trace the send path first, then the reconnect handler."}}),
                    ],
                ],
            ),
        );
        self.role_rows.insert(
            format!("{lead}-critic-0"),
            Self::role_transcript(
                "Review the survey for gaps.",
                "The evidence holds for the common path; the empty list still needs a look.",
                vec![Self::tool_call(
                    "read-2",
                    "2026-11-16T10:00:40Z",
                    "2026-11-16T10:00:41Z",
                    json!({"itemType": "tool_call", "status": "completed",
                    "toolCallId": "read-2", "title": "Read",
                    "data": {"tool": "Read",
                        "state": {
                            "input": {"file_path": "research/report-2.md"},
                            "output": Self::numbered_lines(12),
                        }}}),
                )],
            ),
        );
    }
    fn read_run(&mut self, _id: ThreadId) {}
    fn leads_run(&self, id: ThreadId) -> bool {
        self.runs.contains_key(&id)
    }
    fn run_summary(&self, id: ThreadId) -> Option<RunSummary> {
        self.runs.get(&id).cloned()
    }
    fn role_messages(&self, thread: &str) -> Option<Arc<Vec<Message>>> {
        self.role_rows.get(thread).cloned().map(Arc::new)
    }
    fn take_research_pending(&mut self) -> bool {
        std::mem::take(&mut self.research_pending)
    }
}

impl MockSource {
    /// The run-size question a research-mode thread is asked, until it
    /// answers or starts its run.
    fn proposal_fixture(&self, id: ThreadId) -> Option<ResearchProposal> {
        let thread = self.threads.get(id)?;
        if self.runs.contains_key(&id)
            || (thread.interaction_mode != "research" && thread.interaction_mode != "orchestrate")
        {
            return None;
        }
        Some(Self::proposal_for(id, thread.title.clone()))
    }

    fn proposal_for(id: ThreadId, task: String) -> ResearchProposal {
        ResearchProposal {
            id: format!("proposal-{id}"),
            thread_id: format!("mock-{id}"),
            task,
            size: ResearchSize {
                researchers: 2,
                critics: 1,
            },
            models: [
                Some(crate::research::RoleModel {
                    provider: "claudeAgent".into(),
                    model: "opus-5-5".into(),
                    effort: Some("medium".into()),
                }),
                Some(crate::research::RoleModel {
                    provider: "claudeAgent".into(),
                    model: "opus-5-5".into(),
                    effort: Some("high".into()),
                }),
                Some(crate::research::RoleModel {
                    provider: "claudeAgent".into(),
                    model: "opus-5-5".into(),
                    effort: Some("medium".into()),
                }),
            ],
            models_raw: None,
            lead_provider: "claudeAgent".into(),
            lead_model: "opus-5-5".into(),
        }
    }
    /// A role thread's transcript the way the live source reads one: the
    /// server's messages and tool calls projected by `transcript::project`,
    /// so the run view's columns draw the same steps with times as the thread
    /// view. Each call is its own group of activities, oldest first.
    fn role_transcript(question: &str, reply: &str, calls: Vec<Vec<Value>>) -> Vec<Message> {
        let thread = json!({
            "messages": [
                {"id": "m-user", "role": "user", "text": question,
                    "createdAt": "2026-11-16T10:00:00Z"},
                {"id": "m-reply", "role": "assistant", "text": reply, "streaming": false,
                    "createdAt": "2026-11-16T10:02:00Z"},
            ],
            "activities": calls.into_iter().flatten().collect::<Vec<_>>(),
        });
        crate::transcript::project(&thread)
            .into_iter()
            .map(|row| row.message)
            .collect()
    }

    /// One finished tool call of a mock role transcript: its started and
    /// completed halves, so the projected step reads with its time.
    fn tool_call(id: &str, started: &str, completed: &str, payload: Value) -> Vec<Value> {
        let mut running = payload.clone();
        running["status"] = Value::from("inProgress");
        let mut done = payload;
        done["status"] = Value::from("completed");
        vec![
            json!({"id": format!("{id}-started"), "kind": "tool-call.started", "tone": "info",
                "createdAt": started, "turnId": "t", "summary": "",
                "payload": running}),
            json!({"id": format!("{id}-completed"), "kind": "tool-call.completed", "tone": "info",
                "createdAt": completed, "turnId": "t", "summary": "",
                "payload": done}),
        ]
    }

    /// Numbered lines of filler output, so a mock read step counts its lines.
    fn numbered_lines(lines: usize) -> String {
        (1..=lines)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn user_message(&mut self, prompt: Prompt) -> Message {
        let text = prompt.wire()["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let images = prompt
            .assets
            .into_iter()
            .filter_map(|asset| {
                let Asset::Image { name, image } = asset else {
                    return None;
                };
                let source = Picture::Stored(image.id.to_string());
                self.images.insert(source.clone(), image);
                Some(Thumbnail { name, source })
            })
            .collect();
        Message::User { text, images }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_preview_shows_a_research_run_with_role_transcripts() {
        use crate::model::ThreadSource;
        let source = MockSource::preview();
        let summary = source.run_summary(4).expect("run");
        assert_eq!(summary.phase(), crate::model::RunPhase::Reviewing);
        assert_eq!(summary.agents[0].len(), 2);
        // The run carries each role's model, as a `research.run` answer does.
        assert_eq!(
            summary.models[0].as_ref().map(|model| model.effort.clone()),
            Some(Some("medium".to_string()))
        );
        assert_eq!(
            summary.models[1].as_ref().map(|model| model.effort.clone()),
            Some(Some("high".to_string()))
        );
        let rows = source
            .role_messages("mock-4-researcher-0")
            .expect("role transcript");
        // The prompt, the steps with their times, and the reply: the same
        // projection the thread view draws.
        assert!(matches!(&rows[0], Message::User { .. }));
        assert!(
            matches!(&rows[1], Message::Tool { name, meta, .. } if name == "read" && meta == "30 lines")
        );
        assert!(
            matches!(&rows[2], Message::Tool { name, meta, .. } if name == "command" && meta == "3.4s")
        );
        assert!(
            matches!(&rows[3], Message::Assistant { text, .. } if text.contains("Traced the event"))
        );
    }
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
        assert_eq!(
            source
                .take_queued(0, "0")
                .map(|prompt| prompt.text)
                .as_deref(),
            Some("next")
        );
        assert!(source.take_queued(0, "0").is_none());
    }
}
