//! What a thread waits on the person for, read from its activities: a tool
//! approval (`permission.requested`) or the agent's questions
//! (`user-input.requested`), each open until a matching `.resolved` activity
//! with the same `requestId` arrives. Mirrors `pendingPermissionRequests` and
//! `pendingUserInputRequests` in `src/tui/model/thread.ts`.

use crate::{
    live::text,
    model::{Ask, Choice, Permission, Question},
};
use serde_json::Value;
use std::collections::HashSet;

fn request_id(activity: &Value) -> Option<&str> {
    text(activity, &["payload", "requestId"]).filter(|id| !id.is_empty())
}

/// Tool approvals still open, oldest first.
pub fn permissions(thread: &Value) -> Vec<Permission> {
    let activities = thread["activities"].as_array().into_iter().flatten();
    let mut resolved = HashSet::new();
    let mut requested = vec![];
    for activity in activities {
        let Some(request) = request_id(activity) else {
            continue;
        };
        match text(activity, &["kind"]) {
            Some("permission.resolved") => {
                resolved.insert(request);
            }
            Some("permission.requested") => {
                let field = |name: &str| text(activity, &["payload", name]).map(str::to_string);
                requested.push(Permission {
                    request: request.to_string(),
                    tool: field("toolName").unwrap_or_else(|| "a tool".into()),
                    classification: field("classification"),
                    detail: field("detail"),
                    description: field("description"),
                });
            }
            _ => {}
        }
    }
    requested
        .into_iter()
        .filter(|permission| !resolved.contains(permission.request.as_str()))
        .collect()
}

fn question(raw: &Value) -> Option<Question> {
    let id = text(raw, &["id"])?;
    let (header, body) = (text(raw, &["header"])?, text(raw, &["question"])?);
    let choices = raw["options"]
        .as_array()?
        .iter()
        .filter_map(|option| {
            let label = text(option, &["label"])?;
            let own = |name: &str| text(option, &[name]).map(str::to_string);
            Some(Choice {
                label: label.to_string(),
                description: own("description"),
                value: own("value").unwrap_or_else(|| label.to_string()),
                preview: own("preview"),
            })
        })
        .collect();
    Some(Question {
        id: id.to_string(),
        header: header.to_string(),
        text: body.to_string(),
        choices,
        multi: raw["multiSelect"] == true,
        custom: raw["allowCustomAnswer"] != false,
    })
}

/// Questions still open, oldest first.
pub fn asks(thread: &Value) -> Vec<Ask> {
    let activities = thread["activities"].as_array().into_iter().flatten();
    let mut resolved = HashSet::new();
    let mut requested = vec![];
    for activity in activities {
        let Some(request) = request_id(activity) else {
            continue;
        };
        match text(activity, &["kind"]) {
            Some("user-input.resolved") => {
                resolved.insert(request);
            }
            Some("user-input.requested") => {
                let questions: Vec<Question> = activity["payload"]["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(question)
                    .collect();
                if !questions.is_empty() {
                    requested.push(Ask {
                        request: request.to_string(),
                        questions,
                    });
                }
            }
            _ => {}
        }
    }
    requested
        .into_iter()
        .filter(|ask| !resolved.contains(ask.request.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn activity(kind: &str, payload: Value) -> Value {
        json!({ "kind": kind, "payload": payload })
    }

    #[test]
    fn an_approval_stays_open_until_its_resolution() {
        let thread = json!({ "activities": [
            activity("permission.requested", json!({
                "requestId": "p1", "toolName": "Bash",
                "classification": "command-execution", "detail": "rm -rf build"
            })),
            activity("permission.requested", json!({ "requestId": "p2" })),
            activity("permission.resolved", json!({ "requestId": "p1" })),
        ]});
        let open = permissions(&thread);
        assert_eq!(open.len(), 1);
        // A request that names no tool still reads as one.
        assert_eq!(
            (open[0].request.as_str(), open[0].tool.as_str()),
            ("p2", "a tool")
        );
    }

    #[test]
    fn questions_read_their_options_and_skip_malformed_ones() {
        let thread = json!({ "activities": [
            activity("user-input.requested", json!({
                "requestId": "q1",
                "questions": [
                    { "id": "a", "header": "Scope", "question": "Which?", "multiSelect": true,
                      "allowCustomAnswer": false,
                      "options": [
                        { "label": "Small", "description": "just it", "preview": "# hi" },
                        { "label": "Big", "value": "big" },
                        { "description": "no label" }
                      ] },
                    { "id": "b", "header": "No options list", "question": "?" }
                ]
            })),
            activity("user-input.requested", json!({ "requestId": "q2", "questions": [] })),
        ]});
        let open = asks(&thread);
        assert_eq!(open.len(), 1, "an empty request is not shown");
        let question = &open[0].questions[0];
        assert_eq!(open[0].questions.len(), 1);
        assert!(question.multi && !question.custom);
        assert_eq!(question.choices.len(), 2);
        // The label stands in for a value the agent did not give.
        assert_eq!(question.choices[0].value, "Small");
        assert_eq!(question.choices[1].value, "big");
        assert_eq!(question.choices[0].preview.as_deref(), Some("# hi"));
    }

    #[test]
    fn an_answered_question_is_no_longer_open() {
        let thread = json!({ "activities": [
            activity("user-input.requested", json!({
                "requestId": "q1",
                "questions": [{ "id": "a", "header": "h", "question": "?", "options": [] }]
            })),
            activity("user-input.resolved", json!({ "requestId": "q1" })),
        ]});
        assert!(asks(&thread).is_empty());
    }
}
