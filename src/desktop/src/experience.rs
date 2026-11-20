use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Panel {
    Guide,
    Releases,
    Problems,
    Doctor,
    Update,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Memory {
    Off,
    Plain,
    Embeddings,
}

impl Memory {
    pub fn writes(self) -> [(&'static str, &'static str); 2] {
        match self {
            Self::Off => [("memoryEmbeddings", "false"), ("memory", "false")],
            Self::Plain => [("memoryEmbeddings", "false"), ("memory", "true")],
            Self::Embeddings => [("memory", "true"), ("memoryEmbeddings", "true")],
        }
    }
}

#[derive(Default)]
pub struct Ui {
    pub panel: Option<Panel>,
    pub offered: bool,
    pub step: usize,
    pub release: usize,
    pub history: bool,
    pub dismissed_problems: Vec<String>,
    pub finish: bool,
    pub mark_release: Option<String>,
    pub provider: Option<String>,
    pub folder: bool,
    pub memory: Option<Memory>,
    pub guide_started: Option<std::time::Instant>,
    pub confirm_rollback: bool,
}

pub fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map_or(&[], Vec::as_slice)
}

pub fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

pub fn completed(value: &Value) -> bool {
    value["onboardingCompleted"] == true
}

pub fn seen(value: &Value, version: &str) -> bool {
    list(value, "seenReleases")
        .iter()
        .any(|item| item == version)
}

pub fn unread(value: &Value) -> bool {
    list(value, "releases")
        .iter()
        .any(|release| !seen(value, string(release, "version")))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fix {
    MoveAside(String),
    Reset(String),
    Stop(String, String),
}

impl Fix {
    pub fn label(&self) -> &'static str {
        match self {
            Self::MoveAside(_) => "problems.moveAside",
            Self::Reset(_) => "problems.resetDefault",
            Self::Stop(..) => "problems.stopTurn",
        }
    }

    pub fn payload(&self) -> (&'static str, Value) {
        match self {
            Self::MoveAside(id) => ("store.quarantine", json!({"id": id})),
            Self::Reset(key) => ("settings.set", json!({"key": key, "value": ""})),
            Self::Stop(thread, turn) => (
                "thread.turn.interrupt",
                json!({"threadId": thread, "turnId": turn}),
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub key: String,
    pub message: String,
    pub location: String,
    pub file: String,
    pub fix: Option<Fix>,
}

fn reset_key(path: &str) -> Option<String> {
    if let Some(name) = path.strip_prefix("mcpServers.")
        && !name.is_empty()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    {
        return Some(format!("mcpServers[{name}]"));
    }
    if let Some(id) = path
        .strip_prefix("providers.harness.profiles[")
        .or_else(|| path.strip_prefix("providers.acp.agents["))
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return (!id.is_empty() && !id.contains(']') && !id.bytes().all(|c| c.is_ascii_digit()))
            .then(|| path.into());
    }
    (!path.is_empty()
        && !matches!(path, "providers" | "mcpServers")
        && !path.starts_with("providers."))
    .then(|| path.into())
}

pub fn problems(store: &Value, config: &Value) -> Vec<Record> {
    list(store, "problems")
        .iter()
        .filter_map(|item| {
            let key = item["id"].as_str()?;
            let file = string(item, "file");
            let location = item["line"]
                .as_u64()
                .map_or_else(|| file.to_owned(), |line| format!("{file}:{line}"));
            let fix = if matches!(string(item, "kind"), "turn-status" | "turn-ownerless") {
                item["threadId"]
                    .as_str()
                    .zip(item["turnId"].as_str())
                    .map(|(thread, turn)| Fix::Stop(thread.into(), turn.into()))
            } else {
                Some(Fix::MoveAside(key.into()))
            };
            Some(Record {
                key: key.into(),
                message: string(item, "message").into(),
                location,
                file: file.into(),
                fix,
            })
        })
        .chain(list(config, "problems").iter().filter_map(|item| {
            let path = item["path"].as_str()?;
            Some(Record {
                key: format!("config:{path}"),
                message: string(item, "message").into(),
                location: path.into(),
                file: string(config, "path").into(),
                fix: reset_key(path).map(Fix::Reset),
            })
        }))
        .collect()
}

#[derive(Clone, Debug)]
pub enum Update {
    Running {
        command_id: String,
        rollback: bool,
        progress: Value,
    },
    Finished {
        rollback: bool,
        result: Value,
    },
    Failed {
        code: String,
        message: String,
        rollback: bool,
    },
    Lost,
}

/// What the update panel may offer, following the TUI's screen: installing
/// and rolling back act on this machine's own app folder, so a paired
/// window or a source checkout gets neither. A failed apply can be
/// retried, unless the server is busy with another update; a failed
/// rollback only ever rolls back again.
pub fn can_update(
    paired: bool,
    install_kind: Option<&str>,
    updatable: bool,
    available: bool,
    update: Option<&Update>,
    rollback: bool,
) -> bool {
    if paired || install_kind != Some("release") {
        return false;
    }
    match update {
        Some(Update::Running { .. } | Update::Lost) => false,
        Some(Update::Finished { .. }) => rollback,
        Some(Update::Failed {
            rollback: failed_rollback,
            code,
            ..
        }) => {
            if rollback {
                true
            } else {
                !failed_rollback && updatable && available && code != "SELF_UPDATE_BUSY"
            }
        }
        _ => rollback || (updatable && available),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_offers_follow_the_failed_operation_and_a_busy_server() {
        let ready = |update| can_update(false, Some("release"), true, true, update, false);
        assert!(ready(None));
        assert!(can_update(false, Some("release"), true, true, None, true));
        assert!(!can_update(true, Some("release"), true, true, None, false));
        assert!(!can_update(false, Some("source"), true, true, None, false));
        let failed_apply = Some(&Update::Failed {
            code: "BROKEN".into(),
            message: "No.".into(),
            rollback: false,
        });
        assert!(ready(failed_apply));
        assert!(can_update(
            false,
            Some("release"),
            true,
            true,
            failed_apply,
            true
        ));
        let busy = Some(&Update::Failed {
            code: "SELF_UPDATE_BUSY".into(),
            message: "Another update is running.".into(),
            rollback: false,
        });
        assert!(!ready(busy));
        assert!(can_update(false, Some("release"), true, true, busy, true));
        let failed_rollback = Some(&Update::Failed {
            code: "BROKEN".into(),
            message: "No.".into(),
            rollback: true,
        });
        assert!(!ready(failed_rollback));
        assert!(can_update(
            false,
            Some("release"),
            true,
            true,
            failed_rollback,
            true
        ));
        assert!(!ready(Some(&Update::Lost)));
    }

    #[test]
    fn fixes_preserve_the_location_but_only_target_addressable_records() {
        let data = problems(
            &json!({"problems":[{"id":"bad","file":"store.json","line":7,"kind":"ledger"}, {"id":"stuck","kind":"turn-ownerless","threadId":"t","turnId":"a"}]}),
            &json!({"path":"config.json","problems":[{"path":"mcpServers.linear"},{"path":"providers.harness.profiles[0]"},{"path":"providers.harness.profiles[local]"}]}),
        );
        assert_eq!(data[0].location, "store.json:7");
        assert_eq!(data[0].file, "store.json");
        assert_eq!(
            data.iter()
                .map(|record| record.fix.clone())
                .collect::<Vec<_>>(),
            [
                Some(Fix::MoveAside("bad".into())),
                Some(Fix::Stop("t".into(), "a".into())),
                Some(Fix::Reset("mcpServers[linear]".into())),
                None,
                Some(Fix::Reset("providers.harness.profiles[local]".into())),
            ]
        );
    }
}
