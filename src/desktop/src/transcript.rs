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
    model::Message,
};
use serde_json::Value;
use std::collections::HashMap;

/// The most an opened step shows, so one huge result cannot stall the window.
const OUTPUT_LINES: usize = 120;
const OUTPUT_CHARS: usize = 8_000;
const SUMMARY_CHARS: usize = 160;

/// A message plus the id the server gave it: a message's own id, or a tool
/// call's `toolCallId`. Live deltas find their row by it.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub message: Message,
}

/// The conversation of a `ThreadEnvelope`, oldest first.
pub fn project(thread: &Value) -> Vec<Row> {
    // (when, tie-break, row): messages sort before the steps they began.
    let mut rows: Vec<(i64, usize, Row)> = vec![];
    for (n, message) in thread["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let (Some(role), Some(id)) = (text(message, &["role"]), text(message, &["id"])) else {
            continue;
        };
        let body = text(message, &["text"]).unwrap_or_default().to_string();
        let when = ms(message, &["createdAt"]).unwrap_or(0);
        let streaming = message.get("streaming").and_then(Value::as_bool) == Some(true);
        let message = match role {
            "user" => Message::User { text: body },
            // A reply with no text yet is still being written; an empty,
            // finished one (a turn that was all tool calls) has nothing to show.
            "assistant" if !body.is_empty() || streaming => Message::Assistant {
                text: body,
                at: clock(when),
            },
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
        if kind != "reasoning" && !kind.starts_with("tool-call") {
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
            let command = text(input, &["command"]).unwrap_or(tool);
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
                .or_else(|| text(input, &["notebook_path"]))
                .unwrap_or("file");
            let (added, removed, shown) = changed(tool, input);
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
                let path = text(input, &["file_path"]).unwrap_or("file");
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
            "Grep" | "Glob" | "ToolSearch" | "WebSearch" => {
                let what = text(input, &["pattern"])
                    .or_else(|| text(input, &["query"]))
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

/// `mcp__linear__get_issue` reads as `linear · get_issue`; the call's first
/// short string argument follows, as a hint at what it was for.
fn tool_label(tool: &str, input: &Value) -> String {
    let name = match tool
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
    {
        Some((server, name)) => format!("{server} · {name}"),
        None => tool.to_string(),
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

/// How many lines an edit added and removed, and the change as `-`/`+` lines.
fn changed(tool: &str, input: &Value) -> (usize, usize, String) {
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
        "Write" => one("", text(input, &["content"]).unwrap_or_default()),
        "MultiEdit" => {
            for edit in input["edits"].as_array().into_iter().flatten() {
                one(
                    text(edit, &["old_string"]).unwrap_or_default(),
                    text(edit, &["new_string"]).unwrap_or_default(),
                );
            }
        }
        _ => one(
            text(input, &["old_string"]).unwrap_or_default(),
            text(input, &["new_string"])
                .unwrap_or(text(input, &["new_source"]).unwrap_or_default()),
        ),
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

#[cfg(test)]
mod tests {
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
            ("linear · get_issue  MXN-30", "", true)
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
    fn durations_read_like_the_tui() {
        assert_eq!(duration(537), "537ms");
        assert_eq!(duration(2500), "2.5s");
        assert_eq!(duration(45_000), "45s");
        assert_eq!(duration(185_000), "3m 05s");
    }
}
