//! The mock server's settings answers: a representative slice of the real
//! table (`ui.theme`, `remote.enabled`, one Harness profile, one MCP server,
//! memory switches) plus small memory, skill, remote and update fixtures.
//! Keys and field paths are the server's own; the window renders whatever
//! this holds, never a list of its own.

use crate::settings::{
    Discovery, Embeddings, ListFieldValue, ListItem, ManagedSkill, MemoryEntry, MemoryList,
    RemoteDevice, RemoteState, SettingValue, Snapshot, UpdateState,
};
use serde_json::{Value, json};

/// A slice of the real settings table, as `settings.read` answers it.
pub fn snapshot_fixture() -> Snapshot {
    Snapshot::from_json(&json!({
        "path": "/home/demo/.moxen/config.json",
        "exists": true,
        "settings": [
            {"descriptor": {"key": "ui.theme", "label": "Theme", "description": "The look of the app.",
                "section": "interface", "group": "Looks",
                "kind": {"type": "enum", "choices": [
                    {"value": "auto", "label": "Auto"},
                    {"value": "dark", "label": "Dark"},
                    {"value": "light", "label": "Light"}]}},
             "value": "dark", "explicit": true,
             "effective": {"value": "dark", "label": "Dark"}},
            {"descriptor": {"key": "ui.usageRefreshSeconds", "label": "Usage refresh", "description": "How often usage is re-read, in seconds.",
                "section": "interface", "group": "Looks",
                "kind": {"type": "integer", "min": 5, "max": 600, "unit": "s"}},
             "value": 30, "explicit": false,
             "effective": {"value": 30, "label": "30s", "origin": "the default"}},
            {"descriptor": {"key": "remote.enabled", "label": "Remote access", "description": "Reach this machine's server from another one.",
                "section": "general",
                "kind": {"type": "boolean"}},
             "value": false, "explicit": false},
            {"descriptor": {"key": "memory", "label": "Memory", "description": "Moxen keeps per-project and global memories.",
                "section": "memory",
                "kind": {"type": "boolean"}},
             "value": true, "explicit": true},
            {"descriptor": {"key": "providers.harness.profiles", "label": "Profiles", "description": "The endpoints the Moxen Harness talks to.",
                "section": "provider:harness", "group": "Model servers",
                "kind": {"type": "list", "noun": "profile", "actions": ["duplicate", "test", "probe", "transfer"], "fields": [
                    {"path": "label", "label": "Name", "description": "How the profile is called.", "group": "Endpoint", "kind": {"type": "string"}},
                    {"path": "apiFormat", "label": "API format", "description": "Which API the server speaks.", "group": "Endpoint",
                     "kind": {"type": "enum", "choices": [
                         {"value": "chat", "label": "Chat Completions"},
                         {"value": "responses", "label": "OpenAI Responses"},
                         {"value": "anthropic", "label": "Anthropic Messages"}]}},
                    {"path": "baseUrl", "label": "Base URL", "description": "The server's address.", "group": "Endpoint", "kind": {"type": "string", "placeholder": "http://localhost:8080"}},
                    {"path": "apiKey", "label": "API key", "description": "Typed once and kept in the OS keychain; never on screen.", "group": "Endpoint", "kind": {"type": "secret"}},
                    {"path": "apiKeyEnv", "label": "API key variable", "description": "The NAME of an environment variable that holds the key.", "group": "Endpoint", "kind": {"type": "string", "placeholder": "MY_API_KEY"}},
                    {"path": "slots", "label": "Requests at once", "description": "Requests this server runs at the same time.", "group": "Endpoint", "kind": {"type": "integer"}}]}},
             "value": "", "explicit": true,
             "items": [{
                 "id": "office", "title": "office", "summary": "chat · http://localhost:8080",
                 "status": null,
                 "fields": [
                     {"path": "label", "value": "Office", "explicit": true},
                     {"path": "apiFormat", "value": "chat", "explicit": true},
                     {"path": "baseUrl", "value": "http://localhost:8080", "explicit": true},
                     {"path": "apiKey", "value": "keychain:providers.harness.profiles[office].apiKey", "explicit": true},
                     {"path": "apiKeyEnv", "value": "", "explicit": false},
                     {"path": "slots", "value": 4, "explicit": false,
                      "effective": {"value": 4, "label": "4", "origin": "the Moxen Harness's own Requests at once"}}],
                 "resolved": [
                     {"label": "large", "value": "ready", "origin": "the last probe"},
                     {"label": "small", "value": "not probed", "origin": "no probe yet"}]}]},
            {"descriptor": {"key": "mcp.servers", "label": "Servers", "description": "Programs and HTTP endpoints that add tools.",
                "section": "mcp",
                "kind": {"type": "list", "noun": "server", "actions": ["test", "duplicate"], "fields": [
                    {"path": "type", "label": "Kind", "description": "A program Moxen starts or a server it connects to.", "group": "Connection",
                     "kind": {"type": "enum", "choices": [
                         {"value": "stdio", "label": "Program"},
                         {"value": "http", "label": "HTTP"}]}},
                    {"path": "command", "label": "Command", "description": "The program to start.", "group": "Connection", "kind": {"type": "string", "placeholder": "npx"}},
                    {"path": "url", "label": "URL", "description": "The server's address, for an HTTP server.", "group": "Connection", "kind": {"type": "string"}},
                    {"path": "env", "label": "Environment", "description": "Variables the program starts with. Values are never shown.", "group": "Connection", "kind": {"type": "pairs", "secret": true}},
                    {"path": "disabled", "label": "Switched off", "description": "Keep the server but give it to no one.", "group": "Who gets it", "kind": {"type": "boolean"}}]}},
             "value": "", "explicit": true,
             "items": [{
                 "id": "search", "title": "search", "summary": "program · bunx mcp-search",
                 "status": null,
                 "fields": [
                     {"path": "type", "value": "stdio", "explicit": true},
                     {"path": "command", "value": "bunx mcp-search", "explicit": true},
                     {"path": "url", "value": "", "explicit": false},
                     {"path": "env", "value": "TOKEN=<hidden>", "explicit": true},
                     {"path": "disabled", "value": false, "explicit": false}],
                 "resolved": [
                     {"label": "Claude Code", "value": "Gets it", "origin": "the tab"},
                     {"label": "OpenCode", "value": "Gets it", "origin": "the tab"}]}]},
        ],
    }))
    .expect("mock settings fixture")
}

pub fn memory_fixture() -> MemoryList {
    MemoryList {
        project_id: Some("moxen-agent".into()),
        memories: vec![
            MemoryEntry {
                name: "tastes".into(),
                description: "How the person likes answers.".into(),
                memory_type: "user".into(),
                scope: "global".into(),
                body: Some("Short answers. No emojis.".into()),
            },
            MemoryEntry {
                name: "repo-map".into(),
                description: "Where things live in this project.".into(),
                memory_type: "project".into(),
                scope: "project".into(),
                body: Some("The desktop app lives in src/desktop/.".into()),
            },
        ],
    }
}

pub fn skill_fixture() -> (Vec<ManagedSkill>, Vec<(String, String, String)>) {
    (
        vec![
            ManagedSkill {
                source: "agents".into(),
                folder: "review".into(),
                name: "review".into(),
                description: "Reviews a change before it lands.".into(),
                path: "/home/demo/.agents/skills/review/SKILL.md".into(),
                enabled: true,
                editable: true,
                providers: vec![],
            },
            ManagedSkill {
                source: "claude".into(),
                folder: "docs".into(),
                name: "docs".into(),
                description: "Writes project docs.".into(),
                path: "/home/demo/.claude/skills/docs/SKILL.md".into(),
                enabled: false,
                editable: false,
                providers: vec!["claude".into()],
            },
        ],
        vec![
            (
                "agents".into(),
                "review".into(),
                "# Review\n\nCheck the diff first.".into(),
            ),
            (
                "claude".into(),
                "docs".into(),
                "# Docs\n\nWrite for the reader.".into(),
            ),
        ],
    )
}

pub fn embeddings_fixture() -> Embeddings {
    Embeddings {
        state: "ready".into(),
        message: None,
        percent: None,
        busy: false,
        indexed: 2,
    }
}

pub fn remote_fixture() -> RemoteState {
    RemoteState {
        available: true,
        enabled: true,
        listening: vec!["192.168.1.2:47317".into()],
        error: None,
        devices: vec![RemoteDevice {
            id: "d1".into(),
            name: "Laptop".into(),
            connections: 1,
        }],
        pairing: None,
    }
}

pub fn updates_fixture() -> UpdateState {
    UpdateState {
        providers: vec![crate::settings::ProviderLatest {
            id: "claude".into(),
            latest: Some("2.0.0".into()),
        }],
        check_enabled: true,
        status: Some("available".into()),
        current: Some("0.2.0".into()),
        latest: Some("0.3.0".into()),
        reason: None,
        updatable: true,
    }
}

pub fn discovery_fixture() -> Discovery {
    Discovery::from_json(&json!({
        "ok": true, "host": "localhost:8080",
        "models": [{"id": "large", "contextWindow": 131072}, {"id": "small"}],
    }))
}

/// Applies a `settings.set` key to the mock snapshot: a top-level scalar, one
/// list field (`key[id].field`), a whole entry from a JSON document
/// (`key[id]`), or a removal (an empty `key[id]`).
pub fn apply_set(snapshot: &mut Snapshot, key: &str, value: &str) {
    let (head, rest) = match key.split_once('[') {
        None => {
            if let Some(view) = snapshot.settings.iter_mut().find(|view| view.key == key) {
                view.value = scalar(value);
                view.explicit = !value.is_empty();
            }
            return;
        }
        Some((head, rest)) => (head, rest),
    };
    let Some(id) = rest.split(']').next() else {
        return;
    };
    let Some(view) = snapshot.settings.iter_mut().find(|view| view.key == head) else {
        return;
    };
    let after = rest.split(']').nth(1).unwrap_or_default();
    let field = after.strip_prefix('.').unwrap_or_default();
    if field.is_empty() {
        if value.trim().is_empty() {
            view.items.retain(|item| item.id != id);
            return;
        }
        let Ok(document) = serde_json::from_str::<Value>(value) else {
            return;
        };
        let mut item = ListItem {
            id: id.into(),
            title: id.into(),
            summary: "Added here.".into(),
            status: None,
            fields: vec![],
            resolved: vec![],
        };
        if let Some(map) = document.as_object() {
            for (path, entry) in map {
                item.fields.push(ListFieldValue {
                    path: path.clone(),
                    value: scalar(&entry_string(entry)),
                    explicit: true,
                    effective: None,
                    choices: vec![],
                    items: vec![],
                });
            }
        }
        if let Some(existing) = view.items.iter_mut().find(|item| item.id == id) {
            *existing = item;
        } else {
            view.items.push(item);
        }
        return;
    }
    let Some(item) = view.items.iter_mut().find(|item| item.id == id) else {
        return;
    };
    match item.fields.iter_mut().find(|entry| entry.path == field) {
        Some(entry) => {
            entry.value = scalar(value);
            entry.explicit = !value.is_empty();
        }
        None => item.fields.push(ListFieldValue {
            path: field.into(),
            value: scalar(value),
            explicit: !value.is_empty(),
            effective: None,
            choices: vec![],
            items: vec![],
        }),
    }
}

fn scalar(value: &str) -> SettingValue {
    if value.is_empty() {
        SettingValue::Unset
    } else if value == "true" {
        SettingValue::Flag(true)
    } else if value == "false" {
        SettingValue::Flag(false)
    } else if let Ok(number) = value.parse::<f64>() {
        SettingValue::Number(number)
    } else {
        SettingValue::Text(value.into())
    }
}

fn entry_string(entry: &Value) -> String {
    match entry {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => String::new(),
        _ => serde_json::to_string(entry).unwrap_or_default(),
    }
}

/// Copies one list entry under a new id, like `settings.duplicate`.
pub fn duplicate_item(snapshot: &mut Snapshot, key: &str, id: &str, new_id: &str) -> bool {
    let Some(view) = snapshot.settings.iter_mut().find(|view| view.key == key) else {
        return false;
    };
    let Some(at) = view.items.iter().position(|item| item.id == id) else {
        return false;
    };
    let mut copy = view.items[at].clone();
    copy.id = new_id.into();
    copy.title = new_id.into();
    view.items.push(copy);
    true
}
