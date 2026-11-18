//! Wire views for the Tasks, Agents and Background inspector.

use crate::{
    live::{ms, text},
    model::{Status, ThreadId},
    transcript::{self, Row},
};
use serde_json::Value;

pub struct Step {
    pub title: String,
    pub status: Status,
}

pub fn checklist(thread: &Value) -> Vec<Step> {
    thread["activities"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter(|row| row["kind"] == "turn.plan.updated")
        .map(|row| {
            row["payload"]["plan"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|step| {
                    Some(Step {
                        title: text(step, &["step"]).filter(|s| !s.is_empty())?.into(),
                        status: match text(step, &["status"]) {
                            Some("completed") => Status::Idle,
                            Some("inProgress" | "in_progress") => Status::Running,
                            _ => Status::Queued,
                        },
                    })
                })
                .collect::<Vec<_>>()
        })
        .find(|steps| !steps.is_empty())
        .unwrap_or_default()
}

pub fn completed(steps: &[Step]) -> usize {
    steps.iter().filter(|s| s.status == Status::Idle).count()
}

#[derive(Clone)]
pub struct Agent {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: Status,
    pub started: Option<i64>,
    pub last_message: Option<String>,
    pub stoppable: bool,
}

pub fn agents(thread: &Value) -> Vec<Agent> {
    let mut agents: Vec<_> = thread["subagentRows"]
        .as_array()
        .or_else(|| thread["nativeSubagents"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let kind = text(row, &["agentType"]).unwrap_or("Subagent");
            let status = match text(row, &["status"]) {
                Some("running") => Status::Running,
                Some("failed") => Status::Error,
                _ if row["running"] == true => Status::Running,
                _ => Status::Idle,
            };
            Some(Agent {
                id: text(row, &["agentId"])?.into(),
                title: text(row, &["description"]).unwrap_or(kind).into(),
                kind: kind.into(),
                status,
                started: ms(row, &["at"]).or_else(|| ms(row, &["startedAt"])),
                last_message: text(row, &["lastMessage"]).map(str::to_string),
                stoppable: row["stoppable"] == true,
            })
        })
        .collect();
    agents.sort_by_key(|row| std::cmp::Reverse(row.started));
    agents
}

#[derive(Default)]
pub struct InspectorData {
    pub tasks: Vec<Step>,
    pub agents: Vec<Agent>,
    pub background_count: usize,
}

pub fn background_count(thread: &Value) -> usize {
    thread["activities"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|row| row["kind"] == "background.tasks")
        .and_then(|row| row["payload"]["tasks"].as_array())
        .map_or(0, |tasks| {
            tasks
                .iter()
                .filter(|task| task["taskId"].is_string())
                .count()
        })
}

#[derive(Clone)]
pub struct Delegated {
    /// The parent may have been archived since delegating the task.
    pub parent: Option<ThreadId>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
}

pub struct Delegation {
    pub notify: bool,
    pub active: bool,
    pub status: Option<String>,
    pub summary: Option<String>,
}

impl Delegation {
    pub fn read(link: &Value, status: &Value) -> Self {
        Self {
            notify: link["notify"] == true,
            active: !link.is_null(),
            status: text(status, &["task", "status"]).map(str::to_string),
            summary: text(status, &["task", "summary"]).map(str::to_string),
        }
    }
}

#[derive(Clone)]
pub struct BackgroundTask {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
    pub command: Option<String>,
    pub started: Option<i64>,
    pub stoppable: bool,
}

pub struct Background {
    pub live: bool,
    pub partial: bool,
    pub tasks: Vec<BackgroundTask>,
}

impl Background {
    pub fn read(value: &Value) -> Self {
        let mut tasks: Vec<_> = value["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let id = text(row, &["taskId"])?;
                let command = text(row, &["command"]).map(str::to_string);
                let kind = match (text(row, &["toolName"]), text(row, &["taskType"])) {
                    (Some("Bash"), _) => "Shell",
                    (Some("Monitor"), _) => "Monitor",
                    (Some("Agent" | "Task"), _) | (_, Some("local_agent" | "remote_agent")) => {
                        "Agent"
                    }
                    (_, Some("local_bash")) => "Shell",
                    _ => "Task",
                };
                Some(BackgroundTask {
                    id: id.into(),
                    title: text(row, &["description"])
                        .filter(|s| !s.is_empty())
                        .or(command.as_deref())
                        .unwrap_or(id)
                        .into(),
                    kind,
                    command,
                    started: ms(row, &["startedAt"]),
                    stoppable: row["stoppable"] != false,
                })
            })
            .collect();
        tasks.sort_by_key(|task| match task.kind {
            "Shell" => 0,
            "Monitor" => 1,
            "Agent" => 2,
            _ => 3,
        });
        Self {
            live: value["live"] == true,
            partial: value["partial"] == true,
            tasks,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Read {
    Delegation,
    Background,
    Subagent(String),
    Output(String),
}

pub enum View {
    Delegation(Delegation),
    Background(Background),
    Subagent(Option<Vec<Row>>),
    Output(Option<String>),
}

impl View {
    pub fn subagent(value: &Value) -> Self {
        Self::Subagent((value["available"] == true).then(|| transcript::project(value)))
    }

    pub fn output(value: &Value) -> Self {
        Self::Output((value["available"] == true).then(|| {
            value["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{Background, Delegation, agents, background_count, checklist, completed};
    use crate::model::Status;
    use serde_json::{Value, json};

    #[test]
    fn checklist_takes_the_latest_nonempty_plan_and_counts_out_of_order_completions() {
        let thread = json!({"activities": [
            {"kind": "turn.plan.updated", "payload": {"plan": [{"step": "Old", "status": "completed"}]}},
            {"kind": "turn.plan.updated", "payload": {"plan": [
                {"step": "Native in progress", "status": "inProgress"},
                {"step": "Completed", "status": "completed"},
                {"step": "MCP in progress", "status": "in_progress"},
                {"step": "Pending"},
                {"step": "", "status": "completed"},
            ]}},
            {"kind": "turn.plan.updated", "payload": {"plan": []}},
        ]});
        let steps = checklist(&thread);
        assert_eq!(
            steps
                .iter()
                .map(|step| (step.title.as_str(), step.status))
                .collect::<Vec<_>>(),
            [
                ("Native in progress", Status::Running),
                ("Completed", Status::Idle),
                ("MCP in progress", Status::Running),
                ("Pending", Status::Queued),
            ],
        );
        assert_eq!(completed(&steps), 1);
    }

    #[test]
    fn subagent_snapshot_rows_take_precedence_and_only_explicitly_allow_stop() {
        let thread = json!({
            "subagentRows": [
                {"agentId": "older", "agentType": "Explore", "at": "2026-11-17T10:00:00Z",
                 "running": true, "stoppable": false},
                {"agentId": "newer", "agentType": "Review", "at": "2026-11-17T10:01:00Z",
                 "description": "Check focus", "running": true, "stoppable": true},
                {"agentId": "finished", "agentType": "Review", "at": "2026-11-17T09:59:00Z",
                 "running": false, "lastMessage": "Checked"},
            ],
            "nativeSubagents": [{"agentId": "fallback", "agentType": "Explore", "status": "running"}],
        });
        let rows = agents(&thread);
        assert_eq!(
            rows.iter()
                .map(|row| (row.id.as_str(), row.status, row.stoppable))
                .collect::<Vec<_>>(),
            [
                ("newer", Status::Running, true),
                ("older", Status::Running, false),
                ("finished", Status::Idle, false),
            ],
        );
        assert_eq!(rows[0].title, "Check focus");
        assert_eq!(rows[2].last_message.as_deref(), Some("Checked"));
        let fallback = agents(&json!({"nativeSubagents": thread["nativeSubagents"]}));
        assert_eq!(fallback[0].id, "fallback");
        assert!(!fallback[0].stoppable);
    }

    #[test]
    fn delegated_status_survives_without_a_live_parent_link() {
        let status = json!({"task": {"status": "cancelled", "summary": "Stopped before it ran"}});
        let delegation = Delegation::read(&Value::Null, &status);
        assert!(!delegation.active && !delegation.notify);
        assert_eq!(delegation.status.as_deref(), Some("cancelled"));
        assert_eq!(delegation.summary.as_deref(), Some("Stopped before it ran"));
        let link = json!({"parentThreadId": "parent", "notify": true});
        let delegation = Delegation::read(&link, &Value::Null);
        assert!(delegation.active && delegation.notify);
    }

    #[test]
    fn background_jobs_keep_group_order_and_explicit_stop_limits() {
        let background = Background::read(&json!({
            "live": true, "partial": true,
            "tasks": [
                {"taskId": "agent", "taskType": "local_agent"},
                {"taskId": "monitor", "taskType": "local_bash", "toolName": "Monitor", "stoppable": false},
                {"taskId": "shell", "toolName": "Bash", "command": "cargo test"},
                {"description": "No ID"},
            ],
        }));
        assert!(background.live && background.partial);
        assert_eq!(
            background
                .tasks
                .iter()
                .map(|task| (task.id.as_str(), task.kind, task.stoppable))
                .collect::<Vec<_>>(),
            [
                ("shell", "Shell", true),
                ("monitor", "Monitor", false),
                ("agent", "Agent", true)
            ],
        );
        assert_eq!(background.tasks[0].title, "cargo test");
        assert_eq!(background.tasks[0].command.as_deref(), Some("cargo test"));
    }

    #[test]
    fn empty_latest_background_snapshot_clears_the_count() {
        let thread = json!({"activities": [
            {"kind": "background.tasks", "payload": {"tasks": [{"taskId": "shell"}]}},
            {"kind": "background.tasks", "payload": {"tasks": []}},
        ]});
        assert_eq!(background_count(&thread), 0);
    }
}
