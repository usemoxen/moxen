//! The mock server's settings answers: a representative slice of the real
//! table plus small memory, skill, remote and update fixtures.
//! Keys and field paths are the server's own; the window renders whatever
//! this holds, never a list of its own.

use crate::settings::{
    Discovery, Embeddings, ListFieldValue, ListItem, ManagedSkill, MemoryEntry, MemoryList,
    RemoteDevice, RemoteState, SettingValue, Snapshot, UpdateState,
};
use serde_json::{Value, json};

/// A slice of the real settings table, as `settings.read` answers it.
pub fn snapshot_fixture() -> Snapshot {
    let mut settings = json!([
            {"descriptor": {"key": "projectPolicy", "label": "Unknown folders",
                "description": "What happens when a prompt names a folder that is not a project yet.",
                "section": "general", "defaultValue": "create", "kind": {"type": "enum", "choices": [
                    {"value": "create", "label": "Create the project", "description": "Register the folder and carry on."},
                    {"value": "existing", "label": "Require an existing project", "description": "Refuse rather than register anything."}]}},
             "value": "create", "explicit": false},
            {"descriptor": {"key": "workspaceMode", "label": "Workspace root",
                "description": "Whether a project's root is the enclosing git repository or the folder itself.",
                "section": "general", "defaultValue": "repo", "kind": {"type": "enum", "choices": [
                    {"value": "repo", "label": "Repository root", "description": "Walk up to the git root."},
                    {"value": "folder", "label": "The folder itself", "description": "Take the path as given."}]}},
             "value": "repo", "explicit": false},
            {"descriptor": {"key": "updates.checkLatest", "label": "Check for newer versions",
                "description": "When the settings page opens, ask the npm registry which Claude Code and OpenCode releases are newest, so it can say whether an update is available. Nothing else is sent. Off, the page shows installed versions only.",
                "section": "general", "defaultValue": true, "kind": {"type": "boolean"}},
             "value": true, "explicit": false},
            {"descriptor": {"key": "model", "label": "Model",
                "description": "The model a new thread on the Provider above starts with. A model belongs to one provider, so this applies only to threads on that provider, and a provider's own 'Model' wins over it.",
                "section": "defaults", "kind": {"type": "string", "placeholder": "the provider's own default", "source": "model"}},
             "explicit": false},
            {"descriptor": {"key": "thinkingEffort", "label": "Effort",
                "description": "The reasoning effort a new thread starts at, for models that take one. A provider's own 'Effort' wins over this.",
                "section": "defaults", "kind": {"type": "string", "source": "effort"}},
             "explicit": false},
            {"descriptor": {"key": "sessionTtl", "label": "Idle session lifetime",
                "description": "How long a provider session stays warm with nothing happening on it: no turn, no background task, nothing waiting on you. Past it the session is ended, and the next message resumes it, at the cost of a restart and reading the prompt cache afresh. Each provider can set its own.",
                "section": "sessions", "defaultValue": "1h", "appliesAt": "next-session",
                "kind": {"type": "duration", "presets": ["2m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "8h", "24h"]}},
             "value": "1h", "explicit": false},
            {"descriptor": {"key": "usageContinuation", "label": "After usage wrap-up",
                "description": "Continue in the original thread or hand off to a fresh thread.",
                "section": "sessions", "defaultValue": "same-thread", "kind": {"type": "enum", "choices": [
                    {"value": "same-thread", "label": "Same thread"}, {"value": "handoff", "label": "New thread"}]}},
             "value": "same-thread", "explicit": false},
            {"descriptor": {"key": "longThreads.handoffAt", "label": "Hand off at",
                "description": "Where a thread is handed off: a share of the model's window or a size.",
                "section": "long-threads", "kind": {"type": "line", "presets": ["40%", "50%", "60%", "70%", "80%", "90%", "8K", "16K", "24K", "32K", "64K", "128K", "256K", "512K", "1M"]}},
             "explicit": false, "effective": {"value": "50%", "label": "50% of the window"}},
            {"descriptor": {"key": "instructions", "label": "Extra instructions",
                "description": "Appended to every provider session's system prompt. Each provider's 'Provider instructions' come after these, and a project's moxen.json after that.",
                "section": "agent", "kind": {"type": "string", "placeholder": "Appended to every session", "multiline": true}},
             "explicit": false},
            {"descriptor": {"key": "branchPruneDays", "label": "Delete finished worktree branches after",
                "description": "Days after a thread is archived or deleted before its merged branch is deleted. 0 keeps every branch.",
                "section": "git", "defaultValue": 14, "kind": {"type": "integer", "min": 0, "max": 365, "unit": "d"}},
             "value": 14, "explicit": false},
            {"descriptor": {"key": "git.autoFetch", "label": "Fetch before listing",
                "description": "Run git fetch before reading history, so remote branches are current.",
                "section": "git", "kind": {"type": "boolean"}},
             "value": false, "explicit": false},
            {"descriptor": {"key": "providers.claude.binaryPath", "label": "Claude executable",
                "description": "The Claude binary to spawn.", "section": "provider:claude",
                "group": "Setup", "kind": {"type": "string", "placeholder": "claude"}},
             "value": "claude", "explicit": false},
            {"descriptor": {"key": "providers.codex.binaryPath", "label": "Executable",
                "description": "The Codex executable to run.", "section": "provider:codex",
                "group": "Runtime", "defaultValue": "codex", "appliesAt": "server-restart", "kind": {"type": "string"}},
             "value": "codex", "explicit": false},
            {"descriptor": {"key": "providers.antigravity.binaryPath", "label": "Executable",
                "description": "The Antigravity (agy) executable to run.", "section": "provider:antigravity",
                "group": "Runtime", "defaultValue": "agy", "appliesAt": "server-restart", "kind": {"type": "string"}},
             "value": "agy", "explicit": false},
            {"descriptor": {"key": "providers.opencode.moxenPrompt", "label": "Moxen's system prompt",
                "description": "Replace the base system prompt OpenCode picks with Moxen's.",
                "section": "provider:opencode", "group": "Prompt", "kind": {"type": "boolean"}},
             "value": true, "explicit": false},
            {"descriptor": {"key": "providers.harness.model", "label": "Model",
                "description": "The model a new Moxen Harness thread starts with, when neither the request nor the project names one.",
                "section": "provider:harness", "group": "Defaults", "kind": {"type": "string", "source": "model", "providerKind": "harness"}},
             "explicit": false},
            {"descriptor": {"key": "providers.harness.memory", "label": "Memory",
                "description": "Let Moxen Harness threads use Moxen's shared project and global memory. The global and project memory switches still apply.",
                "section": "provider:harness", "group": "Tools", "appliesAt": "next-session", "kind": {"type": "boolean"}},
             "explicit": false, "effective": {"value": true, "label": "On"}},
            {"descriptor": {"key": "providers.harness.keepRecentTokens", "label": "Kept word for word",
                "description": "How much of the newest conversation stays as it was when older history is summarised, in tokens.",
                "section": "provider:harness", "group": "Long threads", "defaultValue": 16384, "kind": {"type": "integer", "min": 2000, "max": 100000}},
             "value": 16384, "explicit": false},
            {"descriptor": {"key": "providers.harness.slots", "label": "Requests at once",
                "description": "How many requests a model server takes at the same time, for profiles that do not say.",
                "section": "provider:harness", "group": "Sessions",
                "kind": {"type": "integer", "min": 1, "max": 64}},
             "explicit": false, "effective": {"label": "No limit"}},
            {"descriptor": {"key": "providers.harness.modelInputPrices", "label": "Input price",
                "description": "What one million input tokens cost on Moxen Harness models, as model=USD pairs (opencode-go/muse-spark-1.3-contributor=2). Beats the shipped price for those models. A model with no price anywhere stays unpriced.",
                "section": "provider:harness", "group": "Model prices", "kind": {"type": "string", "multiline": true}},
             "explicit": false},
    ]);
    let mut additional = json!([
            {"descriptor": {"key": "ui.theme", "label": "Theme", "description": "The colours of the interface.",
                "section": "interface", "defaultValue": "moxen",
                "kind": {"type": "enum", "choices": [
                    {"value": "moxen", "label": "Moxen"},
                    {"value": "catppuccin-latte", "label": "Catppuccin Latte"},
                    {"value": "catppuccin-frappe", "label": "Catppuccin Frappé"},
                    {"value": "catppuccin-macchiato", "label": "Catppuccin Macchiato"},
                    {"value": "catppuccin-mocha", "label": "Catppuccin Mocha"},
                    {"value": "dracula", "label": "Dracula"},
                    {"value": "nord", "label": "Nord"},
                    {"value": "gruvbox", "label": "Gruvbox"},
                    {"value": "tokyo-night", "label": "Tokyo Night"}]}},
             "value": "moxen", "explicit": false},
            {"descriptor": {"key": "ui.language", "label": "Language", "description": "The language of the interface.",
                "section": "interface", "defaultValue": "auto", "kind": {"type": "enum", "choices": [
                    {"value": "auto", "label": "Auto"}, {"value": "en", "label": "English"},
                    {"value": "es-ES", "label": "Español (España)"}]}}, "value": "auto", "explicit": false},
            {"descriptor": {"key": "ui.backdrop", "label": "Backdrop", "description": "The animated field behind the thread list and the new-thread view.",
                "section": "interface", "defaultValue": "animated", "kind": {"type": "enum", "choices": [
                    {"value": "animated", "label": "Animated"}, {"value": "static", "label": "Static"},
                    {"value": "off", "label": "Off"}]}}, "value": "animated", "explicit": false},
            {"descriptor": {"key": "ui.hideBinaryDiffs", "label": "Hide binary files in diffs",
                "description": "Leave images, archives and other binary files out of the Diff panel, which can only say that they changed. Ignored files are never in a diff.",
                "section": "interface", "defaultValue": true, "kind": {"type": "boolean"}},
             "value": true, "explicit": false},
            {"descriptor": {"key": "ui.usageRefreshSeconds", "label": "Usage refresh", "description": "How often plan usage windows are re-read.",
                "section": "interface",
                "kind": {"type": "integer", "min": 5, "max": 3600, "unit": "s"}},
             "value": 20, "explicit": false},
            {"descriptor": {"key": "remote.enabled", "label": "Remote access", "description": "Reach this machine's server from another one.",
                "section": "general", "group": "Remote access",
                "kind": {"type": "boolean"}},
             "value": true, "explicit": true},
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
                    {"path": "slots", "label": "Requests at once", "description": "Requests this server runs at the same time.", "group": "Endpoint", "kind": {"type": "integer", "min": 1}}]}},
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
                      "effective": {"value": 4, "origin": "the Moxen Harness's own Requests at once"}}],
                 "resolved": [
                     {"label": "large", "value": "ready", "origin": "the last probe"},
                     {"label": "small", "value": "not probed", "origin": "no probe yet"}]}]},
            {"descriptor": {"key": "mcpServers", "label": "Servers", "description": "MCP servers every thread can use. A project's moxen.json can add to or remove from this list.",
                "section": "mcp", "appliesAt": "next-session",
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
    ]);
    settings
        .as_array_mut()
        .expect("mock settings array")
        .append(
            additional
                .as_array_mut()
                .expect("extra mock settings array"),
        );
    Snapshot::from_json(&json!({
        "path": "/home/demo/.moxen/config.json",
        "exists": true,
        "settings": settings,
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
        phase: "idle".into(),
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
        install_kind: Some("release".into()),
        release_notes: None,
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

#[cfg(test)]
mod tests {
    use super::snapshot_fixture;
    use crate::settings::SettingKind;

    #[test]
    fn mock_settings_offer_representative_rows_from_the_server_sections() {
        let snapshot = snapshot_fixture();
        for (section, key) in [
            ("general", "projectPolicy"),
            ("defaults", "model"),
            ("sessions", "sessionTtl"),
            ("agent", "instructions"),
            ("git", "branchPruneDays"),
            ("provider:claude", "providers.claude.binaryPath"),
            ("provider:codex", "providers.codex.binaryPath"),
            ("provider:opencode", "providers.opencode.moxenPrompt"),
            ("provider:harness", "providers.harness.slots"),
        ] {
            assert_eq!(snapshot.find(key).unwrap().section, section);
        }
        assert!(matches!(
            snapshot.find("git.autoFetch").unwrap().kind,
            SettingKind::Boolean
        ));
        assert!(matches!(
            snapshot.find("branchPruneDays").unwrap().kind,
            SettingKind::Integer {
                min: 0.,
                max: 365.,
                ..
            }
        ));
        assert!(matches!(
            snapshot.find("instructions").unwrap().kind,
            SettingKind::Text {
                multiline: true,
                ..
            }
        ));
    }
}
