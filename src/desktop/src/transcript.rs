//! A thread's conversation as the desktop draws it: the server's messages and
//! activities (`ThreadEnvelope` over `subscribeThread`) projected into rows.
//!
//! A row is a user message, an assistant message, or one step of the agent's
//! run. A step pairs a tool call's `started` and `completed` activities by
//! `toolCallId`, so a call that is still running reads as one row that then
//! settles. What each tool call becomes follows the TUI's reading of the same
//! payloads (`src/tui/model/activity.ts`, `core/threads/toolactivity.ts`):
//! `command_execution` is a command, `file_change` an edit, `reasoning` a
//! thought, and a `Read` / `Grep` / `Glob` call a read or a search; any other
//! call is a generic tool row.

use crate::{
    live::{ms, parse_iso_ms, text},
    model::{ContinuedKind, Message, TaskNotice},
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// The most an opened step shows, so one huge result cannot stall the window.
const OUTPUT_LINES: usize = 120;
const OUTPUT_CHARS: usize = 8_000;
const SUMMARY_CHARS: usize = 160;

/// What a continue after a usage limit sends once the limit resets
/// (`USAGE_CONTINUE_PROMPT` in `src/core/threads/views.ts`): threads from
/// before the origin tag carry the fixed text.
const USAGE_CONTINUE_PROMPT: &str =
    "The usage limit that stopped the last turn has reset. Continue the task where you left off.";
/// The wrap-up prompt's first line (`WRAP_UP_PROMPT` in
/// `src/core/usage/protection.ts`): a usage-continue carrying it is still
/// under protection, not resuming.
const WRAP_UP_PREFIX: &str = "The provider's shared usage allowance is nearly exhausted.";

/// The tasks a moxen-written "delegated tasks settled" message reports, or
/// None for any other message: the text of a task-notification message is the
/// raw block, and the card reads the notification it carries instead
/// (`taskNotifications` in `src/tui/model/thread.ts`).
pub(crate) fn task_notices(message: &Value) -> Option<Vec<TaskNotice>> {
    if text(message, &["origin"]) != Some("task-notification") {
        return None;
    }
    let tasks = message.get("notification")?.get("tasks")?.as_array()?;
    let words = |task: &Value, key: &str| {
        task.get(key)
            .and_then(Value::as_str)
            .filter(|word| !word.is_empty())
            .map(str::to_string)
    };
    let mut notices = vec![];
    for task in tasks {
        let Some(task_id) = words(task, "taskId") else {
            continue;
        };
        let review = task.get("review");
        notices.push(TaskNotice {
            task_id,
            // The default title of a delegated task, stored with it.
            title: words(task, "title").unwrap_or_else(|| "Delegated task".to_string()),
            status: words(task, "status").unwrap_or_else(|| "completed".to_string()),
            duration_ms: task.get("durationMs").and_then(Value::as_i64),
            model: words(task, "model"),
            branch: words(task, "branch"),
            headline: words(task, "headline"),
            files: task
                .get("filesChanged")
                .and_then(Value::as_i64)
                .map(|changed| {
                    (
                        changed,
                        task.get("additions").and_then(Value::as_i64).unwrap_or(0),
                        task.get("deletions").and_then(Value::as_i64).unwrap_or(0),
                    )
                }),
            verdict: review
                .and_then(|review| review.get("verdict"))
                .and_then(Value::as_str)
                .filter(|verdict| !verdict.is_empty())
                .map(str::to_string),
            review: matches!(review, Some(Value::Object(_))),
            resumes_at: task
                .get("resumesAt")
                .and_then(Value::as_str)
                .filter(|at| !at.is_empty())
                .map(str::to_string),
            cancelled: task.get("cancelled").and_then(Value::as_bool) == Some(true),
            native: task.get("source").and_then(Value::as_str) == Some("native"),
        });
    }
    if notices.is_empty() {
        None
    } else {
        Some(notices)
    }
}

/// The provider's own one-line "limit reached" reply: "You've hit your
/// session limit · resets 4:40am" (`PROVIDER_LIMIT_TEXT` in
/// `src/tui/model/thread.ts`).
fn is_provider_limit(text: &str) -> bool {
    let line = text.trim();
    if line.contains('\n') {
        return false;
    }
    let lower = line.to_lowercase();
    let Some(after_you) = lower
        .strip_prefix("you've ")
        .or_else(|| lower.strip_prefix("you’ve "))
    else {
        return false;
    };
    let Some(after_verb) = after_you
        .strip_prefix("hit your ")
        .or_else(|| after_you.strip_prefix("reached your "))
    else {
        return false;
    };
    after_verb.contains("limit")
}

/// A message plus the id the server gave it: a message's own id, or a tool
/// call's `toolCallId`. Live deltas find their row by it.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub message: Message,
}

/// Turns that never started: still waiting in the queue, or cancelled while
/// they waited (`cancelledBeforeStart` in `src/tui/model/thread.ts`).
fn unstarted_turns(thread: &Value) -> HashSet<&str> {
    let mut waited = HashSet::new();
    let mut promoted = HashSet::new();
    let mut interrupted = HashSet::new();
    let mut unstarted: HashSet<&str> = HashSet::new();
    for activity in thread["activities"].as_array().into_iter().flatten() {
        let Some(turn) = text(activity, &["turnId"]) else {
            continue;
        };
        match text(activity, &["kind"]) {
            Some("turn.queued" | "turn.scheduled") => {
                waited.insert(turn);
            }
            Some("turn.promoted") => {
                promoted.insert(turn);
            }
            Some("turn.interrupted") => {
                interrupted.insert(turn);
                if activity["payload"]["beforeStart"] == true {
                    unstarted.insert(turn);
                }
            }
            _ => {}
        }
    }
    unstarted.extend(
        interrupted
            .into_iter()
            .filter(|turn| waited.contains(turn) && !promoted.contains(turn)),
    );
    for queued in thread["queuedTurns"].as_array().into_iter().flatten() {
        if let Some(turn) = text(queued, &["turnId"]) {
            unstarted.insert(turn);
        }
    }
    unstarted
}

/// The conversation of a `ThreadEnvelope`, oldest first.
pub fn project(thread: &Value) -> Vec<Row> {
    // (when, tie-break, row): messages sort before the steps they began.
    let mut rows: Vec<(i64, usize, Row)> = vec![];
    let unstarted = unstarted_turns(thread);
    // Turns a usage limit stopped: the provider's own "limit reached" reply
    // says what the turn's usage-limit notice already shows, better.
    let limited: HashSet<&str> = thread["activities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|activity| {
            matches!(
                text(activity, &["kind"]),
                Some("usage.limit" | "usage.wrap-up")
            )
        })
        .filter_map(|activity| text(activity, &["turnId"]))
        .collect();
    for (n, message) in thread["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let (Some(role), Some(id)) = (text(message, &["role"]), text(message, &["id"])) else {
            continue;
        };
        // A message that has not run yet waits in the queue strip, and one taken
        // back before it ran is gone.
        if role == "user" && text(message, &["turnId"]).is_some_and(|turn| unstarted.contains(turn))
        {
            continue;
        }
        let body = text(message, &["text"]).unwrap_or_default().to_string();
        let when = ms(message, &["createdAt"]).unwrap_or(0);
        let streaming = message.get("streaming").and_then(Value::as_bool) == Some(true);
        let message = match role {
            // Moxen's own blocks render as cards and quiet lines, never as
            // the raw text the stored message carries — and control input is
            // not a prompt at all (`src/tui/features/timeline/timeline.tsx`).
            "user" => match text(message, &["origin"]) {
                Some("question-answer") => continue,
                Some("task-notification") => match task_notices(message) {
                    Some(tasks) => Message::TaskNotification {
                        tasks,
                        at: clock(when),
                    },
                    None => {
                        // The Git tab's ask to open a request is a short
                        // line, not the instructions.
                        let body = crate::git::open_request_summary(&body).unwrap_or(body);
                        let (text, images) = crate::attachments::user_images(message, &body);
                        Message::User { text, images }
                    }
                },
                Some("usage-protection") => Message::UsageProtection { at: clock(when) },
                Some("usage-continue") if body.starts_with(WRAP_UP_PREFIX) => {
                    Message::UsageProtection { at: clock(when) }
                }
                Some("usage-continue") => Message::Continued {
                    kind: ContinuedKind::UsageReset,
                    at: clock(when),
                },
                Some("background-notification") => Message::Continued {
                    kind: ContinuedKind::Background,
                    at: clock(when),
                },
                Some("handoff-summary") => Message::Continued {
                    kind: ContinuedKind::Handoff,
                    at: clock(when),
                },
                // A continue from before the origin tag: the fixed text.
                _ if body == USAGE_CONTINUE_PROMPT => Message::Continued {
                    kind: ContinuedKind::UsageReset,
                    at: clock(when),
                },
                // The Git tab's ask to open a request is a short line, not the instructions.
                _ => {
                    let body = crate::git::open_request_summary(&body).unwrap_or(body);
                    let (text, images) = crate::attachments::user_images(message, &body);
                    Message::User { text, images }
                }
            },
            // A reply with no text yet is still being written; an empty,
            // finished one (a turn that was all tool calls) has nothing to show.
            "assistant" if !body.is_empty() || streaming => {
                if text(message, &["turnId"]).is_some_and(|turn| limited.contains(turn))
                    && is_provider_limit(&body)
                {
                    continue;
                }
                Message::Assistant {
                    text: body,
                    at: clock(when),
                }
            }
            _ => continue,
        };
        rows.push((
            when,
            n,
            Row {
                key: id.to_string(),
                message,
            },
        ));
    }
    // A plan proposed for approval stands in for the reply that turn never wrote.
    for (n, plan) in thread["proposedPlans"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let (Some(id), Some(body)) = (text(plan, &["id"]), text(plan, &["planMarkdown"])) else {
            continue;
        };
        let when = ms(plan, &["createdAt"]).unwrap_or(0);
        rows.push((
            when,
            500_000 + n,
            Row {
                key: id.to_string(),
                message: Message::Plan {
                    text: body.to_string(),
                    implemented: text(plan, &["implementedAt"]).is_some(),
                    at: clock(when),
                },
            },
        ));
    }
    let activities: Vec<&Value> = thread["activities"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let mut by_call: HashMap<&str, Call> = HashMap::new();
    let mut order: Vec<&str> = vec![];
    for (n, activity) in activities.iter().enumerate() {
        let kind = text(activity, &["kind"]).unwrap_or_default();
        let when = ms(activity, &["createdAt"]).unwrap_or(0);
        if text(activity, &["tone"]) == Some("error") && !kind.starts_with("tool-call") {
            rows.push((
                when,
                1_000_000 + n,
                Row {
                    key: text(activity, &["id"]).unwrap_or_default().to_string(),
                    message: step(
                        "error",
                        clip(text(activity, &["summary"]).unwrap_or("Error")),
                        String::new(),
                        String::new(),
                        true,
                        false,
                    ),
                },
            ));
            continue;
        }
        if kind == "instructions.updated" {
            // Moxen's acknowledgement that this turn carried new runtime
            // instructions: its own system card showing structured changes,
            // never the instructions' text.
            let changes = activity
                .get("payload")
                .and_then(|payload| payload.get("changes"))
                .and_then(parse_instructions_update_changes);
            rows.push((
                when,
                1_000_000 + n,
                Row {
                    key: text(activity, &["id"]).unwrap_or_default().to_string(),
                    message: Message::InstructionsUpdated {
                        changes,
                        at: clock(when),
                    },
                },
            ));
            continue;
        }
        if kind != "reasoning" && !kind.starts_with("tool-call") {
            // The provider stopped the turn at its usage limit, or is wrapping
            // up before it does: the record of when it happened and when it
            // lifts, as the TUI's usage-limit line shows it.
            if matches!(kind, "usage.limit" | "usage.wrap-up") {
                let payload = activity.get("payload");
                rows.push((
                    when,
                    1_000_000 + n,
                    Row {
                        key: text(activity, &["id"]).unwrap_or_default().to_string(),
                        message: Message::UsageLimit {
                            label: payload
                                .and_then(|payload| text(payload, &["label"]))
                                .map(str::to_string),
                            resets_at: payload
                                .and_then(|payload| text(payload, &["resetsAt"]))
                                .map(str::to_string),
                            wrap_up: kind == "usage.wrap-up",
                            at: clock(when),
                        },
                    },
                ));
            }
            continue;
        }
        let Some(payload) = activity.get("payload") else {
            continue;
        };
        let Some(call) = text(payload, &["toolCallId"]) else {
            continue;
        };
        let entry = by_call.entry(call).or_insert_with(|| {
            order.push(call);
            Call {
                started: when,
                latest: payload,
                latest_at: when,
                n,
            }
        });
        // Activities arrive oldest first; the last one is the call's state.
        entry.latest = payload;
        entry.latest_at = when;
    }
    for call in order {
        let c = &by_call[call];
        rows.push((
            c.started,
            1_000_000 + c.n,
            Row {
                key: call.to_string(),
                message: call_step(c),
            },
        ));
    }
    rows.sort_by_key(|(when, n, _)| (*when, *n));
    rows.into_iter().map(|(_, _, row)| row).collect()
}

struct Call<'a> {
    started: i64,
    latest: &'a Value,
    latest_at: i64,
    n: usize,
}

fn step(
    name: &str,
    summary: String,
    output: String,
    meta: String,
    failed: bool,
    running: bool,
) -> Message {
    Message::Tool {
        name: name.into(),
        summary,
        output,
        meta,
        failed,
        running,
    }
}

fn call_step(call: &Call) -> Message {
    let p = call.latest;
    let status = text(p, &["status"]).unwrap_or_default();
    let running = status == "inProgress";
    let failed = status == "failed";
    let took = (!running && call.latest_at > call.started).then(|| call.latest_at - call.started);
    let elapsed = |fallback: Option<i64>| took.or(fallback).map(duration).unwrap_or_default();
    let input = p.pointer("/data/state/input").unwrap_or(&Value::Null);
    let output = text(p, &["data", "state", "output"])
        .or_else(|| text(p, &["detail"]))
        .unwrap_or_default();
    let tool = text(p, &["data", "tool"])
        .or_else(|| text(p, &["title"]))
        .unwrap_or("tool");
    let meta = |value: String| if running { String::new() } else { value };
    match text(p, &["itemType"]).unwrap_or_default() {
        "reasoning" => {
            let body = text(p, &["text"]).unwrap_or_default();
            let first = body.lines().map(str::trim).find(|l| !l.is_empty());
            step(
                "thought",
                clip(first.unwrap_or("Thinking")),
                cap(body),
                meta(elapsed(p.get("durationMs").and_then(Value::as_i64))),
                failed,
                running,
            )
        }
        "command_execution" => {
            if let Some(mcp_tool) = acp_mcp_tool(p, input) {
                let args = input.get("Arguments").unwrap_or(input);
                return step(
                    "tool",
                    clip(&tool_label(&mcp_tool, args)),
                    cap(&format!("{}\n\n{output}", compact(args))),
                    meta(elapsed(None)),
                    failed,
                    running,
                );
            }
            let command = text(input, &["command"])
                .or_else(|| text(input, &["CommandLine"]))
                .or_else(|| text(p, &["title"]))
                .unwrap_or(tool);
            let first = command
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or(command);
            step(
                "command",
                clip(first.trim()),
                cap(output),
                meta(elapsed(None)),
                failed,
                running,
            )
        }
        "file_change" => {
            let path = text(input, &["file_path"])
                .or_else(|| text(input, &["filePath"]))
                .or_else(|| text(input, &["path"]))
                .or_else(|| text(input, &["Path"]))
                .or_else(|| text(input, &["TargetFile"]))
                .or_else(|| text(input, &["notebook_path"]))
                .or_else(|| p.pointer("/data/files/0/path").and_then(Value::as_str))
                .unwrap_or("file");
            let (added, removed, shown) = changed(tool, input, p);
            step(
                "edit",
                short_path(path),
                if shown.is_empty() {
                    cap(output)
                } else {
                    cap(&shown)
                },
                meta(format!("+{added} −{removed}")),
                failed,
                running,
            )
        }
        _ => match tool {
            "Read" => {
                let path = text(input, &["file_path"])
                    .or_else(|| text(input, &["filePath"]))
                    .or_else(|| text(input, &["path"]))
                    .or_else(|| text(input, &["Path"]))
                    .or_else(|| text(input, &["TargetFile"]))
                    .or_else(|| p.pointer("/data/files/0/path").and_then(Value::as_str))
                    .unwrap_or("file");
                let lines = output.lines().count();
                let header = format!("{lines} lines · {path}");
                step(
                    "read",
                    short_path(path),
                    cap(&format!("{header}\n{output}")),
                    meta(format!("{lines} lines")),
                    failed,
                    running,
                )
            }
            "List" => {
                let path = text(input, &["DirectoryPath"])
                    .or_else(|| text(input, &["directoryPath"]))
                    .or_else(|| text(input, &["path"]))
                    .or_else(|| text(input, &["Path"]))
                    .or_else(|| text(input, &["file_path"]))
                    .or_else(|| p.pointer("/data/files/0/path").and_then(Value::as_str))
                    .or_else(|| {
                        text(p, &["title"]).map(|t| t.strip_prefix("Directory ").unwrap_or(t))
                    })
                    .unwrap_or(".");
                let entries = output.lines().filter(|l| !l.trim().is_empty()).count();
                step(
                    "read",
                    clip(&format!("List {}", short_path(path))),
                    cap(output),
                    meta(if entries > 0 {
                        format!("{entries} entries")
                    } else {
                        elapsed(None)
                    }),
                    failed,
                    running,
                )
            }
            "WebFetch" => {
                let url = text(input, &["url"])
                    .or_else(|| text(input, &["Url"]))
                    .or_else(|| text(input, &["URL"]))
                    .or_else(|| text(p, &["title"]).map(|t| t.strip_prefix("URL ").unwrap_or(t)))
                    .unwrap_or_default();
                step(
                    "search",
                    clip(&format!("WebFetch {url}")),
                    cap(output),
                    meta(elapsed(None)),
                    failed,
                    running,
                )
            }
            "Agent" => {
                let role = text(input, &["subagent_type"])
                    .or_else(|| text(input, &["Role"]))
                    .or_else(|| text(input, &["role"]))
                    .or_else(|| text(input, &["TypeName"]))
                    .or_else(|| {
                        text(p, &["title"]).filter(|t| *t != "Agent" && *t != "Run invoke_subagent")
                    });
                let prompt = text(input, &["description"])
                    .or_else(|| text(input, &["Prompt"]))
                    .or_else(|| text(input, &["prompt"]));
                let summary = match (role, prompt) {
                    (Some(r), Some(p)) => format!("Agent · {r}  {p}"),
                    (Some(r), None) => format!("Agent · {r}"),
                    (None, Some(p)) => format!("Delegating to subagent  {p}"),
                    (None, None) => "Delegating to subagent".to_string(),
                };
                let body = if output.is_empty() {
                    compact(input)
                } else {
                    output.to_string()
                };
                step(
                    "tool",
                    clip(&summary),
                    cap(&body),
                    meta(elapsed(None)),
                    failed,
                    running,
                )
            }
            "Grep" | "Glob" | "ToolSearch" | "WebSearch" => {
                let what = text(input, &["pattern"])
                    .or_else(|| text(input, &["Pattern"]))
                    .or_else(|| text(input, &["query"]))
                    .or_else(|| text(input, &["Query"]))
                    .unwrap_or_default();
                step(
                    "search",
                    clip(&format!("{tool} {what}")),
                    cap(output),
                    meta(elapsed(None)),
                    failed,
                    running,
                )
            }
            _ => step(
                "tool",
                clip(&tool_label(tool, input)),
                cap(&format!("{}\n\n{output}", compact(input))),
                meta(elapsed(None)),
                failed,
                running,
            ),
        },
    }
}

fn acp_mcp_tool(p: &Value, input: &Value) -> Option<String> {
    let server = text(input, &["ServerName"]).or_else(|| text(input, &["serverName"]));
    let tool = text(input, &["ToolName"])
        .or_else(|| text(input, &["toolName"]))
        .or_else(|| {
            text(p, &["title"])
                .and_then(|t| t.strip_prefix("MCP Tool "))
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })?;
    Some(format!("mcp__{}__{tool}", server.unwrap_or("mcp")))
}

fn friendly_tool_title(clean: &str) -> Option<&'static str> {
    match clean.to_ascii_lowercase().as_str() {
        "toolsearch" => Some("Searching for tools"),
        "notebookedit" => Some("Editing notebook"),
        "bashoutput" => Some("Checking background output"),
        "killshell" => Some("Stopping background shell"),
        "slashcommand" => Some("Running command"),
        "enterplanmode" => Some("Entering plan mode"),
        "exitplanmode" => Some("Exiting plan mode"),
        "agent" | "invokesubagent" | "invoke_subagent" => Some("Delegating to subagent"),
        "schedulewakeup" | "schedule" => Some("Scheduling wakeup"),
        "listagents" => Some("Listing agents"),
        "sendmessage" | "send_message" => Some("Messaging agent"),
        "reportfindings" => Some("Reporting findings"),
        "enterworktree" => Some("Entering worktree"),
        "exitworktree" => Some("Exiting worktree"),
        "designsync" => Some("Syncing design"),
        "croncreate" => Some("Scheduling cron job"),
        "cronlist" => Some("Listing cron jobs"),
        "crondelete" => Some("Deleting cron job"),
        "remotetrigger" => Some("Triggering remote job"),
        "pushnotification" => Some("Sending notification"),
        "monitor" => Some("Monitoring process"),
        "taskoutput" => Some("Checking task output"),
        "taskstop" => Some("Stopping task"),
        "managetask" | "manage_task" => Some("Managing background task"),
        "definesubagent" | "define_subagent" => Some("Defining subagent"),
        "managesubagents" | "manage_subagents" => Some("Managing subagents"),
        "runworkflow" | "run_workflow" => Some("Running workflow"),
        "swarm" => Some("Managing swarm"),
        "askquestion" | "ask_question" => Some("Asking question"),
        _ => None,
    }
}

/// `mcp__linear__get_issue` reads as `Linear · Get issue`; the call's first
/// short string argument follows, as a hint at what it was for.
fn tool_label(tool: &str, input: &Value) -> String {
    let clean = tool.trim().strip_prefix("Run ").unwrap_or(tool.trim());
    if clean == "manage_task" {
        let action = text(input, &["Action"])
            .or_else(|| text(input, &["action"]))
            .unwrap_or("status");
        let task = text(input, &["TaskId"])
            .or_else(|| text(input, &["taskId"]))
            .and_then(|id| id.rsplit('/').next())
            .unwrap_or("task");
        return match action {
            "kill" => format!("Stopping {task}"),
            "list" => "Listing background tasks".to_string(),
            "send_input" => format!("Sending input to {task}"),
            _ => format!("Checking output of {task}"),
        };
    }
    let name = if let Some(friendly) = friendly_tool_title(clean) {
        friendly.to_string()
    } else {
        crate::usage::pretty_tool_name(clean)
    };
    let hint = input.as_object().and_then(|fields| {
        fields.values().find_map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.len() <= 60 && !s.contains('\n'))
        })
    });
    match hint {
        Some(hint) => format!("{name}  {hint}"),
        None => name,
    }
}

fn unified_diff_counts(diff: &str) -> (usize, usize) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") || line.starts_with("@@") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

/// How many lines an edit added and removed, and the change as `-`/`+` lines.
fn changed(tool: &str, input: &Value, payload: &Value) -> (usize, usize, String) {
    let lines = |value: &str| value.lines().count();
    let mut shown = String::new();
    let (mut added, mut removed) = (0, 0);
    let mut one = |old: &str, new: &str| {
        removed += lines(old);
        added += lines(new);
        for line in old.lines() {
            shown.push_str(&format!("- {line}\n"));
        }
        for line in new.lines() {
            shown.push_str(&format!("+ {line}\n"));
        }
    };
    match tool {
        "Write" => one(
            "",
            text(input, &["content"])
                .or_else(|| text(input, &["Content"]))
                .unwrap_or_default(),
        ),
        "MultiEdit" => {
            for edit in input["edits"].as_array().into_iter().flatten() {
                one(
                    text(edit, &["old_string"]).unwrap_or_default(),
                    text(edit, &["new_string"]).unwrap_or_default(),
                );
            }
        }
        _ => {
            let old = text(input, &["old_string"])
                .or_else(|| text(input, &["Target"]))
                .unwrap_or_default();
            let new = text(input, &["new_string"])
                .or_else(|| text(input, &["new_source"]))
                .or_else(|| text(input, &["Replacement"]))
                .or_else(|| text(input, &["Content"]))
                .unwrap_or_default();
            one(old, new);
        }
    }
    if added == 0 && removed == 0 && shown.is_empty() {
        let meta_diff = payload
            .pointer("/data/state/metadata/diff")
            .and_then(Value::as_str)
            .filter(|d| !d.trim().is_empty())
            .map(str::to_string);
        let files_diff = if meta_diff.is_none() {
            let parts: Vec<&str> = payload
                .pointer("/data/files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|f| f.get("diff").and_then(Value::as_str))
                .filter(|d| !d.trim().is_empty())
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        } else {
            None
        };
        if let Some(diff) = meta_diff.or(files_diff) {
            let (a, r) = unified_diff_counts(&diff);
            return (a, r, diff);
        }
    }
    (added, removed, shown)
}

/// `1.2s`, `45s`, `3m 05s` from milliseconds.
pub fn duration(ms: i64) -> String {
    let ms = ms.max(0);
    if ms < 1000 {
        return format!("{ms}ms");
    }
    let seconds = ms as f64 / 1000.;
    if seconds < 10. {
        return format!("{seconds:.1}s");
    }
    let whole = ms / 1000;
    if whole < 60 {
        return format!("{whole}s");
    }
    format!("{}m {:02}s", whole / 60, whole % 60)
}

/// The last three parts of a path: where a file is, without the checkout's prefix.
fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.len() <= 3 {
        return path.to_string();
    }
    format!("…/{}", parts[parts.len() - 3..].join("/"))
}

fn compact(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        value => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}

fn clip(value: &str) -> String {
    let first = value.lines().next().unwrap_or_default().trim();
    if first.chars().count() <= SUMMARY_CHARS {
        return first.to_string();
    }
    let cut: String = first.chars().take(SUMMARY_CHARS).collect();
    format!("{cut}…")
}

/// An output limited to what is worth drawing.
fn cap(value: &str) -> String {
    let mut out = String::new();
    for (n, line) in value.lines().enumerate() {
        if n == OUTPUT_LINES || out.len() >= OUTPUT_CHARS {
            out.push('…');
            break;
        }
        let line: String = line.chars().take(400).collect();
        out.push_str(&line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// `Thu 09:38`, in the local time zone.
pub fn clock(ms: i64) -> String {
    use chrono::{DateTime, Local};
    DateTime::from_timestamp_millis(ms)
        .map(|utc| utc.with_timezone(&Local).format("%a %H:%M").to_string())
        .unwrap_or_default()
}

/// Appends a live text delta to the row `key`, or adds an assistant row for it.
pub fn append(rows: &mut Vec<Row>, key: &str, delta: &str, assistant_at: i64) {
    match rows.iter_mut().rev().find(|row| row.key == key) {
        Some(Row {
            message: Message::Assistant { text, .. } | Message::Tool { output: text, .. },
            ..
        }) => text.push_str(delta),
        Some(_) => {}
        None => rows.push(Row {
            key: key.to_string(),
            message: Message::Assistant {
                text: delta.to_string(),
                at: clock(assistant_at),
            },
        }),
    }
}

/// Live reasoning text: the thought's summary follows its first line.
pub fn append_thought(rows: &mut [Row], key: &str, delta: &str) {
    if let Some(Row {
        message: Message::Tool {
            summary, output, ..
        },
        ..
    }) = rows.iter_mut().rev().find(|row| row.key == key)
    {
        output.push_str(delta);
        if summary == "Thinking" {
            let first = output.lines().map(str::trim).find(|l| !l.is_empty());
            if let Some(first) = first {
                *summary = clip(first);
            }
        }
    }
}

/// When a delta's message was created, falling back to now.
pub fn created_ms(message: &Value) -> i64 {
    text(message, &["createdAt"])
        .and_then(parse_iso_ms)
        .unwrap_or_else(crate::live::now_ms)
}

fn parse_instructions_model_ref(value: &Value) -> Option<crate::model::InstructionsModelRef> {
    let model = value.get("model")?.as_str()?.trim();
    if model.is_empty() {
        return None;
    }
    let effort = value
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);
    Some(crate::model::InstructionsModelRef {
        model: model.to_string(),
        effort,
    })
}

fn parse_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_instructions_update_changes(
    value: &Value,
) -> Option<crate::model::InstructionsUpdateChanges> {
    let model = value.get("model").and_then(|model| {
        let from = model.get("from").and_then(parse_instructions_model_ref);
        let to = model.get("to").and_then(parse_instructions_model_ref);
        if from.is_none() && to.is_none() {
            None
        } else {
            Some(crate::model::InstructionsModelChange { from, to })
        }
    });
    let changes = crate::model::InstructionsUpdateChanges {
        model,
        added: parse_string_list(value.get("added")),
        updated: parse_string_list(value.get("updated")),
        removed: parse_string_list(value.get("removed")),
    };
    if changes.is_empty() {
        None
    } else {
        Some(changes)
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_message_that_has_not_run_waits_in_the_queue_not_the_transcript() {
        let thread = json!({
            "messages": [
                {"id": "m1", "role": "user", "text": "ran", "turnId": "t1", "createdAt": "2026-11-16T10:00:00.000Z"},
                {"id": "m2", "role": "user", "text": "waiting", "turnId": "t2", "createdAt": "2026-11-16T10:01:00.000Z"},
                {"id": "m3", "role": "user", "text": "taken back", "turnId": "t3", "createdAt": "2026-11-16T10:02:00.000Z"},
            ],
            "queuedTurns": [{"turnId": "t2", "messageId": "m2", "scheduledFor": null, "scheduleReason": null}],
            "activities": [
                {"id": "a1", "turnId": "t3", "kind": "turn.queued", "tone": "info", "createdAt": "2026-11-16T10:02:00.000Z"},
                {"id": "a2", "turnId": "t3", "kind": "turn.interrupted", "tone": "info", "createdAt": "2026-11-16T10:03:00.000Z"},
            ],
        });
        let rows = project(&thread);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "m1");
    }
    use super::*;
    use serde_json::json;

    fn activity(id: &str, kind: &str, at: &str, payload: Value) -> Value {
        json!({"id": id, "kind": kind, "tone": "info", "createdAt": at, "turnId": "t", "summary": "", "payload": payload})
    }

    fn thread() -> Value {
        json!({
            "messages": [
                {"id": "m2", "role": "assistant", "text": "Done.", "streaming": false, "createdAt": "2026-11-16T10:00:30.000Z"},
                {"id": "m1", "role": "user", "text": "Fix it", "streaming": false, "createdAt": "2026-11-16T10:00:00.000Z"},
                {"id": "m3", "role": "assistant", "text": "", "streaming": false, "createdAt": "2026-11-16T10:00:31.000Z"},
            ],
            "activities": [
                activity("a1", "tool-call.started", "2026-11-16T10:00:10.000Z", json!({"itemType": "command_execution", "status": "inProgress", "toolCallId": "c1", "title": "Bash", "data": {"tool": "Bash", "state": {"input": {"command": "cargo test\nmore"}}}})),
                activity("a2", "tool-call.completed", "2026-11-16T10:00:12.500Z", json!({"itemType": "command_execution", "status": "completed", "toolCallId": "c1", "title": "Bash", "data": {"tool": "Bash", "state": {"input": {"command": "cargo test\nmore"}, "output": "ok\n"}}})),
                activity("a3", "tool-call.started", "2026-11-16T10:00:15.000Z", json!({"itemType": "file_change", "status": "inProgress", "toolCallId": "c2", "title": "Edit", "data": {"tool": "Edit", "state": {"input": {"file_path": "/a/b/c/d/e.rs", "old_string": "x\ny", "new_string": "z"}}}})),
                activity("a4", "tool-call.completed", "2026-11-16T10:00:16.000Z", json!({"itemType": "file_change", "status": "failed", "toolCallId": "c2", "title": "Edit", "data": {"tool": "Edit", "state": {"input": {"file_path": "/a/b/c/d/e.rs", "old_string": "x\ny", "new_string": "z"}}}})),
                activity("a5", "context-window.updated", "2026-11-16T10:00:17.000Z", json!({"usedTokens": 1})),
                activity("a6", "reasoning", "2026-11-16T10:00:20.000Z", json!({"itemType": "reasoning", "status": "completed", "toolCallId": "r1", "text": "I will read it\nthen edit", "durationMs": 537})),
                activity("a7", "tool-call.started", "2026-11-16T10:00:25.000Z", json!({"itemType": "dynamic_tool_call", "status": "inProgress", "toolCallId": "c3", "title": "mcp__linear__get_issue", "data": {"tool": "mcp__linear__get_issue", "state": {"input": {"id": "MXN-30"}}}})),
            ],
        })
    }

    #[test]
    fn reads_messages_and_steps_in_order() {
        let rows = project(&thread());
        let kinds: Vec<String> = rows
            .iter()
            .map(|r| match &r.message {
                Message::User { .. } => "user".into(),
                Message::Assistant { text, .. } => format!("assistant:{text}"),
                Message::Tool { name, .. } => name.clone(),
                Message::Plan { .. } => "plan".into(),
                Message::UsageLimit { .. } => "usage-limit".into(),
                Message::TaskNotification { .. } => "task-notification".into(),
                Message::InstructionsUpdated { .. } => "instructions-updated".into(),
                Message::UsageProtection { .. } => "usage-protection".into(),
                Message::Continued { .. } => "continued".into(),
            })
            .collect();
        // The empty finished reply (m3) and the context update have nothing to show.
        assert_eq!(
            kinds,
            vec![
                "user",
                "command",
                "edit",
                "thought",
                "tool",
                "assistant:Done."
            ]
        );
    }

    #[test]
    fn a_call_is_one_row_that_settles() {
        let rows = project(&thread());
        let Message::Tool {
            summary,
            output,
            meta,
            failed,
            running,
            ..
        } = &rows[1].message
        else {
            panic!("a command")
        };
        assert_eq!(
            (summary.as_str(), output.as_str(), meta.as_str()),
            ("cargo test", "ok", "2.5s")
        );
        assert!(!failed && !running);
        // The edit failed and shows what it tried; the call still running shows no time.
        let Message::Tool {
            summary,
            meta,
            failed,
            ..
        } = &rows[2].message
        else {
            panic!("an edit")
        };
        assert_eq!(
            (summary.as_str(), meta.as_str(), *failed),
            ("…/c/d/e.rs", "+1 −2", true)
        );
        let Message::Tool {
            summary,
            meta,
            running,
            ..
        } = &rows[4].message
        else {
            panic!("a tool")
        };
        assert_eq!(
            (summary.as_str(), meta.as_str(), *running),
            ("Linear · Get issue  MXN-30", "", true)
        );
    }

    #[test]
    fn live_deltas_extend_the_right_row() {
        let mut rows = project(&thread());
        append(&mut rows, "m2", " Really.", 0);
        append(&mut rows, "m9", "New", 0);
        let Message::Assistant { text, .. } = &rows[5].message else {
            panic!("reply")
        };
        assert_eq!(text, "Done. Really.");
        assert!(
            matches!(&rows.last().expect("row").message, Message::Assistant { text, .. } if text == "New")
        );
        append_thought(&mut rows, "r1", " and test");
        let Message::Tool { output, .. } = &rows[3].message else {
            panic!("thought")
        };
        assert!(output.ends_with("then edit and test"));
    }

    #[test]
    fn a_proposed_plan_is_a_row_of_its_own() {
        let mut value = thread();
        value["proposedPlans"] = json!([{
            "id": "plan1", "turnId": "t1", "planMarkdown": "1. Do it",
            "createdAt": "2026-11-16T10:00:03.000Z", "implementedAt": null,
        }]);
        let rows = project(&value);
        let plans: Vec<_> = rows
            .iter()
            .filter_map(|row| match &row.message {
                Message::Plan {
                    text, implemented, ..
                } => Some((row.key.as_str(), text.as_str(), *implemented)),
                _ => None,
            })
            .collect();
        assert_eq!(plans, [("plan1", "1. Do it", false)]);
        value["proposedPlans"][0]["implementedAt"] = json!("2026-11-16T10:05:00.000Z");
        assert!(project(&value).iter().any(|row| matches!(
            row.message,
            Message::Plan {
                implemented: true,
                ..
            }
        )));
    }

    #[test]
    fn durations_read_like_the_tui() {
        assert_eq!(duration(537), "537ms");
        assert_eq!(duration(2500), "2.5s");
        assert_eq!(duration(45_000), "45s");
        assert_eq!(duration(185_000), "3m 05s");
    }

    #[test]
    fn usage_limits_are_rows_of_their_own() {
        let mut value = thread();
        value["activities"] = json!([
            activity(
                "limit",
                "usage.limit",
                "2026-11-16T10:00:28.000Z",
                json!({"label": "Session", "resetsAt": "2026-11-16T11:00:00.000Z"})
            ),
            activity(
                "wrap",
                "usage.wrap-up",
                "2026-11-16T10:00:29.000Z",
                json!({"label": null, "resetsAt": null})
            ),
        ]);
        let rows = project(&value);
        assert_eq!(rows.len(), 4);
        let Message::UsageLimit {
            label,
            resets_at,
            wrap_up,
            ..
        } = &rows[1].message
        else {
            panic!("a usage limit")
        };
        assert_eq!(
            (label.as_deref(), resets_at.as_deref(), *wrap_up),
            (Some("Session"), Some("2026-11-16T11:00:00.000Z"), false)
        );
        let Message::UsageLimit {
            label,
            resets_at,
            wrap_up,
            ..
        } = &rows[2].message
        else {
            panic!("a wrap-up")
        };
        assert_eq!(
            (label.as_deref(), resets_at.as_deref(), *wrap_up),
            (None, None, true)
        );
    }

    #[test]
    fn an_instructions_update_is_a_card_without_the_instructions() {
        let value = json!({
            "messages": [],
            "activities": [
                activity(
                    "iu-legacy",
                    "instructions.updated",
                    "2026-11-16T10:00:28.000Z",
                    json!({"provider": "claude"})
                ),
                activity(
                    "iu-detailed",
                    "instructions.updated",
                    "2026-11-16T10:01:28.000Z",
                    json!({
                        "provider": "codex",
                        "changes": {
                            "model": {
                                "from": {"model": "gpt-6.2-sol", "effort": "medium"},
                                "to": {"model": "gpt-6.2-sol", "effort": "high"}
                            },
                            "added": ["Web"],
                            "updated": ["Memory", "Project instructions"]
                        }
                    })
                ),
            ],
        });
        let rows = project(&value);
        assert_eq!(rows.len(), 2);
        assert!(matches!(
            &rows[0].message,
            Message::InstructionsUpdated { changes: None, .. }
        ));
        let Message::InstructionsUpdated {
            changes: Some(changes),
            ..
        } = &rows[1].message
        else {
            panic!("expected structured instruction changes");
        };
        assert_eq!(
            crate::model::format_instructions_update_detail(Some(changes)),
            "Model: gpt-6.2-sol (medium → high) · Added: Web · Updated: Memory, Project instructions"
        );
        // The card is the whole row: no user bubble and no instruction text.
        assert!(
            !rows
                .iter()
                .any(|row| matches!(&row.message, Message::User { .. }))
        );
    }

    #[test]
    fn moxen_blocks_render_as_cards_and_lines_not_raw_text() {
        let message = |id: &str, role: &str, text: &str, origin: Option<&str>| {
            let mut message = json!({"id": id, "role": role, "text": text, "createdAt": "2026-11-16T10:00:00.000Z"});
            if let Some(origin) = origin {
                message["origin"] = origin.into();
            }
            message
        };
        let value = json!({
            "messages": [
                message("m1", "user", "<task-notification>\nA task settled.\n</task-notification>", Some("task-notification")),
                message("m2", "user", "wrap now", Some("usage-protection")),
                message("m3", "user", "go on", Some("usage-continue")),
                message("m4", "user", "The usage limit that stopped the last turn has reset. Continue the task where you left off.", None),
                message("m5", "user", "done", Some("background-notification")),
                message("m6", "user", "handing off", Some("handoff-summary")),
                message("m7", "user", "> Which?\n\nAll", Some("question-answer")),
                message("m8", "user", "<task-notification>oops</task-notification>", Some("task-notification")),
                {"id": "m9", "role": "assistant", "text": "You've hit your session limit · resets 4:40am", "turnId": "t", "createdAt": "2026-11-16T10:00:30.000Z"},
                {"id": "m10", "role": "assistant", "text": "You've hit your session limit · resets 4:40am", "turnId": "other", "createdAt": "2026-11-16T10:00:31.000Z"},
            ],
            "activities": [
                {"id": "a1", "kind": "usage.limit", "tone": "info", "createdAt": "2026-11-16T10:00:20.000Z", "turnId": "t", "summary": "", "payload": {}},
            ],
        });
        // The notification payload the card reads instead of the raw block.
        let mut value = value;
        value["messages"][0]["notification"] = json!({"tasks": [
            {"taskId": "t1", "title": "Backfill", "status": "completed", "durationMs": 92_000},
        ]});
        let rows = project(&value);
        let kinds: Vec<String> = rows
            .iter()
            .map(|row| match &row.message {
                Message::User { text, .. } => format!("user:{text}"),
                Message::Assistant { text, .. } => format!("assistant:{text}"),
                Message::UsageLimit { .. } => "usage-limit".into(),
                Message::TaskNotification { tasks, .. } => {
                    format!(
                        "notice:{}",
                        tasks
                            .iter()
                            .map(|task| task.title.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
                Message::UsageProtection { .. } => "protection".into(),
                Message::Continued { kind, .. } => format!("continued:{kind:?}"),
                _ => "?".into(),
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "notice:Backfill",
                "protection",
                "continued:UsageReset",
                "continued:UsageReset",
                "continued:Background",
                "continued:Handoff",
                "user:<task-notification>oops</task-notification>",
                "usage-limit",
                "assistant:You've hit your session limit · resets 4:40am",
            ]
        );
        // No raw task-notification block reaches a user bubble, and control
        // input never reaches the transcript.
        assert!(!rows.iter().any(
            |row| matches!(&row.message, Message::User { text, .. } if text.contains("A task settled"))
        ));
        // The card keeps what the notice reported.
        let Message::TaskNotification { tasks, .. } = &rows[0].message else {
            panic!("a task notice")
        };
        assert_eq!(
            (tasks[0].title.as_str(), tasks[0].duration_ms),
            ("Backfill", Some(92_000))
        );
    }

    #[test]
    fn antigravity_read_uses_pascal_case_path_and_files_fallback() {
        let value = json!({
            "messages": [],
            "activities": [
                activity("a1", "tool-call.completed", "2026-11-20T15:37:24.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c1",
                    "title": "File docs/contributing.md",
                    "data": {
                        "tool": "Read",
                        "files": [{"path": "/Users/aaron/repo/docs/contributing.md"}],
                        "state": {"status": "completed", "input": {"Path": "/Users/aaron/repo/docs/contributing.md"}}
                    }
                })),
            ],
        });
        let rows = project(&value);
        let Message::Tool { name, summary, .. } = &rows[0].message else {
            panic!("expected read tool row");
        };
        assert_eq!(name, "read");
        assert_eq!(summary, "…/repo/docs/contributing.md");
    }

    #[test]
    fn antigravity_mcp_and_manage_task_rows_render_as_clean_tool_steps() {
        let value = json!({
            "messages": [],
            "activities": [
                activity("a1", "tool-call.completed", "2026-11-20T17:02:33.000Z", json!({
                    "itemType": "command_execution",
                    "status": "completed",
                    "toolCallId": "c1",
                    "title": "MCP Tool save_comment",
                    "data": {
                        "tool": "Bash",
                        "state": {
                            "status": "completed",
                            "input": {
                                "ServerName": "linear_linear",
                                "ToolName": "save_comment",
                                "Arguments": {"issueId": "MXN-432", "body": "Done"}
                            }
                        }
                    }
                })),
                activity("a2", "tool-call.completed", "2026-11-20T17:02:49.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c2",
                    "title": "Run manage_task",
                    "data": {
                        "tool": "Run manage_task",
                        "state": {
                            "status": "completed",
                            "input": {"Action": "status", "TaskId": "5bffed15/task-339"}
                        }
                    }
                })),
                activity("a3", "tool-call.completed", "2026-11-20T17:02:55.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c3",
                    "title": "Run mcp_linear_get_issue",
                    "data": {
                        "tool": "Run mcp_linear_get_issue",
                        "state": {
                            "status": "completed",
                            "input": {"id": "MXN-432"}
                        }
                    }
                })),
            ],
        });
        let rows = project(&value);
        let summaries: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| match &r.message {
                Message::Tool { name, summary, .. } => (name.as_str(), summary.as_str()),
                _ => panic!("expected tool row"),
            })
            .collect();
        assert_eq!(
            summaries,
            vec![
                ("tool", "Linear · Save comment  MXN-432"),
                ("tool", "Checking output of task-339"),
                ("tool", "Linear · Get issue  MXN-432"),
            ]
        );
    }

    #[test]
    fn antigravity_acp_diffs_list_webfetch_agent_and_friendly_titles_render() {
        let unified = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;";
        let value = json!({
            "messages": [],
            "activities": [
                activity("a1", "tool-call.completed", "2026-11-20T17:10:00.000Z", json!({
                    "itemType": "file_change",
                    "status": "completed",
                    "toolCallId": "c1",
                    "data": {
                        "tool": "Edit",
                        "files": [{"path": "/Users/aaron/repo/src/app.ts", "diff": unified}],
                        "state": {
                            "status": "completed",
                            "input": {"TargetFile": "/Users/aaron/repo/src/app.ts"},
                            "metadata": {"diff": unified}
                        }
                    }
                })),
                activity("a2", "tool-call.completed", "2026-11-20T17:10:01.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c2",
                    "title": "Directory src/core",
                    "data": {
                        "tool": "List",
                        "state": {
                            "status": "completed",
                            "input": {"DirectoryPath": "/Users/aaron/repo/src/core"},
                            "output": "a.ts\nb.ts\n"
                        }
                    }
                })),
                activity("a3", "tool-call.completed", "2026-11-20T17:10:02.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c3",
                    "data": {
                        "tool": "WebFetch",
                        "state": {
                            "status": "completed",
                            "input": {"url": "https://agentclientprotocol.com/spec"}
                        }
                    }
                })),
                activity("a4", "tool-call.completed", "2026-11-20T17:10:03.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c4",
                    "data": {
                        "tool": "Agent",
                        "state": {
                            "status": "completed",
                            "input": {"Role": "Codebase Researcher", "Prompt": "Audit ACP handlers"}
                        }
                    }
                })),
                activity("a5", "tool-call.completed", "2026-11-20T17:10:04.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c5",
                    "data": {
                        "tool": "Run mcp_brave-search_brave_image_search",
                        "state": {
                            "status": "completed",
                            "input": {"query": "acp"}
                        }
                    }
                })),
                activity("a6", "tool-call.completed", "2026-11-20T17:10:05.000Z", json!({
                    "itemType": "dynamic_tool_call",
                    "status": "completed",
                    "toolCallId": "c6",
                    "data": {
                        "tool": "Run schedule",
                        "state": {
                            "status": "completed",
                            "input": {"Prompt": "Check status"}
                        }
                    }
                })),
            ],
        });
        let rows = project(&value);
        assert_eq!(rows.len(), 6);
        let Message::Tool {
            name,
            summary,
            output,
            meta,
            ..
        } = &rows[0].message
        else {
            panic!("expected edit row");
        };
        assert_eq!(name, "edit");
        assert_eq!(summary, "…/repo/src/app.ts");
        assert_eq!(meta, "+2 −1");
        assert!(output.contains("+const c = 4;"));

        let Message::Tool {
            name,
            summary,
            meta,
            ..
        } = &rows[1].message
        else {
            panic!("expected list row");
        };
        assert_eq!(name, "read");
        assert_eq!(summary, "List …/repo/src/core");
        assert_eq!(meta, "2 entries");

        let Message::Tool { name, summary, .. } = &rows[2].message else {
            panic!("expected webfetch row");
        };
        assert_eq!(name, "search");
        assert_eq!(summary, "WebFetch https://agentclientprotocol.com/spec");

        let Message::Tool { name, summary, .. } = &rows[3].message else {
            panic!("expected agent row");
        };
        assert_eq!(name, "tool");
        assert_eq!(summary, "Agent · Codebase Researcher  Audit ACP handlers");

        let Message::Tool { name, summary, .. } = &rows[4].message else {
            panic!("expected hyphenated mcp row");
        };
        assert_eq!(name, "tool");
        assert_eq!(summary, "Brave Search · Brave image search  acp");

        let Message::Tool { name, summary, .. } = &rows[5].message else {
            panic!("expected friendly title row");
        };
        assert_eq!(name, "tool");
        assert_eq!(summary, "Scheduling wakeup  Check status");
    }
}
