//! The settings surface, decoded from the server's settings table.
//!
//! The server owns every setting (`core/configschema.ts`): `settings.read`
//! answers with each descriptor and its current value, and the window renders
//! from that answer — never from a key list of its own. Scalar edits go back
//! through `settings.set`, list entries through structured keys on the same
//! command (`key[<id>].<field>`), entry copies through `settings.duplicate`.
//! Harness probes, MCP tests, skills, memory, remote access and updates ride
//! on their own queries and commands; their answers are decoded here too.
//!
//! Secrets never come back in the clear: a secret setting reads as a keychain
//! reference (or unset), and secret pair values as `KEY=<hidden>`. Display
//! helpers below keep it that way — they name a stored key, never its value.

use serde_json::Value;

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn boolean(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

/// The sections a settings page shows, in the server table's own order
/// (`SETTING_SECTIONS` in `core/configschema.ts`). The labels are display
/// words, like the TUI's `SECTION_LABEL`; anything the snapshot carries that
/// is not listed here renders at the end, so a newer server's section still
/// shows up.
pub const SETTING_SECTIONS: [(&str, &str); 15] = [
    ("general", "General"),
    ("defaults", "Defaults"),
    ("sessions", "Sessions"),
    ("long-threads", "Long threads"),
    ("agent", "Agent context"),
    ("memory", "Memory"),
    ("interface", "Interface"),
    ("git", "Git and forges"),
    ("provider:claude", "Claude Code"),
    ("provider:opencode", "OpenCode"),
    ("provider:codex", "Codex"),
    ("provider:acp", "ACP"),
    ("provider:harness", "Moxen Harness"),
    ("mcp", "MCP servers"),
    ("skills", "Skills"),
];

pub fn section_label(section: &str) -> &str {
    SETTING_SECTIONS
        .iter()
        .find(|(id, _)| *id == section)
        .map_or(section, |(_, label)| label)
}

pub fn section_order(section: &str) -> usize {
    SETTING_SECTIONS
        .iter()
        .position(|(id, _)| *id == section)
        .unwrap_or(SETTING_SECTIONS.len())
}

/// The value the server reports for one setting.
#[derive(Clone, Debug, PartialEq)]
pub enum SettingValue {
    Text(String),
    Number(f64),
    Flag(bool),
    Unset,
}

impl SettingValue {
    pub fn from_json(value: &Value) -> Self {
        if let Some(text) = value.as_str() {
            if text.is_empty() {
                Self::Unset
            } else {
                Self::Text(text.into())
            }
        } else if let Some(number) = value.as_f64() {
            Self::Number(number)
        } else if let Some(flag) = value.as_bool() {
            Self::Flag(flag)
        } else {
            Self::Unset
        }
    }

    /// The value as `settings.set` takes it: an empty string resets to default.
    pub fn wire(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Number(number) => {
                if number.fract() == 0. && number.abs() < 1e15 {
                    format!("{}", *number as i64)
                } else {
                    format!("{number}")
                }
            }
            Self::Flag(flag) => flag.to_string(),
            Self::Unset => String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

fn choices(value: &Value) -> Vec<Choice> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|choice| {
            if boolean(choice, "hidden") == Some(true) {
                return None;
            }
            Some(Choice {
                value: text(choice, "value")?,
                label: text(choice, "label").unwrap_or_default(),
                description: text(choice, "description"),
            })
        })
        .collect()
}

/// One setting's editor kind, as its descriptor's `kind` says.
#[derive(Clone, Debug, PartialEq)]
pub enum SettingKind {
    Enum(Vec<Choice>),
    Boolean,
    Secret,
    Text {
        multiline: bool,
    },
    Catalog {
        source: CatalogSource,
        provider_kind: Option<String>,
        provider_key: Option<String>,
        provider_kinds: Vec<String>,
    },
    Integer {
        min: f64,
        max: f64,
        unit: Option<String>,
    },
    Duration(Vec<String>),
    Line(Vec<String>),
    List(ListSchema),
    /// A kind this client does not edit (a web order, a model map): drawn
    /// read-only from the snapshot's own words.
    Other(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CatalogSource {
    Provider,
    Model,
    Effort,
}

impl SettingKind {
    fn from_json(kind: &Value) -> Self {
        let typed = kind.get("type").and_then(Value::as_str).unwrap_or_default();
        match typed {
            "enum" => Self::Enum(choices(&kind["choices"])),
            "boolean" => Self::Boolean,
            "secret" => Self::Secret,
            "string" => match kind["source"].as_str() {
                Some("provider" | "model" | "effort") => Self::Catalog {
                    source: match kind["source"].as_str() {
                        Some("provider") => CatalogSource::Provider,
                        Some("model") => CatalogSource::Model,
                        _ => CatalogSource::Effort,
                    },
                    provider_kind: text(kind, "providerKind"),
                    provider_key: text(kind, "providerKey"),
                    provider_kinds: strings(&kind["providerKinds"]),
                },
                _ => Self::Text {
                    multiline: boolean(kind, "multiline").unwrap_or(false),
                },
            },
            "integer" => Self::Integer {
                min: number(kind, "min").unwrap_or(f64::MIN),
                max: number(kind, "max").unwrap_or(f64::MAX),
                unit: text(kind, "unit"),
            },
            "duration" => Self::Duration(strings(&kind["presets"])),
            "line" => Self::Line(strings(&kind["presets"])),
            "list" => Self::List(ListSchema::from_json(kind)),
            other => Self::Other(other.into()),
        }
    }

    /// Whether the kind can hold a credential: its value is never shown.
    pub fn is_secret(&self) -> bool {
        matches!(self, Self::Secret)
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// The schema of a list setting (`providers.harness.profiles`, `mcpServers`),
/// as the descriptor carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct ListSchema {
    pub noun: String,
    pub actions: Vec<String>,
    pub fields: Vec<ListFieldSchema>,
}

impl ListSchema {
    fn from_json(kind: &Value) -> Self {
        Self {
            noun: text(kind, "noun").unwrap_or_else(|| "entry".into()),
            actions: kind
                .get("actions")
                .and_then(Value::as_array)
                .map(|actions| {
                    actions
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            fields: kind
                .get("fields")
                .and_then(Value::as_array)
                .map(|fields| {
                    fields
                        .iter()
                        .filter_map(ListFieldSchema::from_json)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// One field of a list schema: where it draws its label and editor from.
#[derive(Clone, Debug, PartialEq)]
pub struct ListFieldSchema {
    pub path: String,
    pub label: String,
    pub description: String,
    pub group: String,
    pub hidden: bool,
    pub kind: FieldKind,
    pub visible_when: Option<(String, Vec<String>)>,
}

impl ListFieldSchema {
    fn from_json(field: &Value) -> Option<Self> {
        Some(Self {
            path: text(field, "path")?,
            label: text(field, "label").unwrap_or_default(),
            description: text(field, "description").unwrap_or_default(),
            group: text(field, "group").unwrap_or_default(),
            hidden: boolean(field, "hidden").unwrap_or(false),
            kind: FieldKind::from_json(field.get("kind")?),
            visible_when: field.get("visibleWhen").and_then(|rule| {
                Some((
                    text(rule, "path")?,
                    rule.get("in")?
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                ))
            }),
        })
    }
}

/// A list field's editor kind, including any bounds the server describes.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldKind {
    Text,
    Integer {
        min: Option<f64>,
        max: Option<f64>,
    },
    Number {
        min: Option<f64>,
        max: Option<f64>,
    },
    Boolean,
    Secret,
    Enum(Vec<Choice>),
    Words,
    Pairs {
        secret: bool,
    },
    NestedList {
        noun: String,
        fields: Vec<ListFieldSchema>,
    },
    Effort,
    Other(String),
}

impl FieldKind {
    fn from_json(kind: &Value) -> Self {
        match kind.get("type").and_then(Value::as_str).unwrap_or_default() {
            "string" => Self::Text,
            "integer" => Self::Integer {
                min: number(kind, "min"),
                max: number(kind, "max"),
            },
            "number" => Self::Number {
                min: number(kind, "min"),
                max: number(kind, "max"),
            },
            "boolean" => Self::Boolean,
            "secret" => Self::Secret,
            "enum" => Self::Enum(choices(&kind["choices"])),
            "words" => Self::Words,
            "pairs" => Self::Pairs {
                secret: boolean(kind, "secret").unwrap_or(false),
            },
            "list" => Self::NestedList {
                noun: text(kind, "noun").unwrap_or_else(|| "entry".into()),
                fields: kind
                    .get("fields")
                    .and_then(Value::as_array)
                    .map(|fields| {
                        fields
                            .iter()
                            .filter_map(ListFieldSchema::from_json)
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            "effort" => Self::Effort,
            other => Self::Other(other.into()),
        }
    }

    pub fn is_secret(&self) -> bool {
        matches!(self, Self::Secret | Self::Pairs { secret: true })
    }
}

/// What applies while a setting is unset, in the page's own words.
#[derive(Clone, Debug, PartialEq)]
pub struct Effective {
    pub value: SettingValue,
    pub label: String,
    pub origin: Option<String>,
}

impl Effective {
    fn from_json(value: &Value) -> Option<Self> {
        let value = value.get("effective")?;
        if value.is_null() {
            return None;
        }
        Some(Self {
            value: SettingValue::from_json(&value["value"]),
            label: text(value, "label").unwrap_or_default(),
            origin: text(value, "origin"),
        })
    }
}

/// One row of a settings page.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingView {
    pub key: String,
    pub label: String,
    pub description: String,
    pub section: String,
    pub group: Option<String>,
    pub kind: SettingKind,
    pub default: SettingValue,
    pub applies_at: Option<&'static str>,
    pub hidden: bool,
    visible_when: Option<(String, Vec<String>)>,
    pub value: SettingValue,
    pub explicit: bool,
    pub unavailable: Option<String>,
    pub effective: Option<Effective>,
    pub in_force: Option<String>,
    pub items: Vec<ListItem>,
}

impl SettingView {
    fn from_json(view: &Value) -> Option<Self> {
        let descriptor = view.get("descriptor")?;
        Some(Self {
            key: text(descriptor, "key")?,
            label: text(descriptor, "label").unwrap_or_default(),
            description: text(descriptor, "description").unwrap_or_default(),
            section: text(descriptor, "section").unwrap_or_else(|| "general".into()),
            group: text(descriptor, "group"),
            kind: SettingKind::from_json(descriptor.get("kind")?),
            default: SettingValue::from_json(&descriptor["defaultValue"]),
            applies_at: match descriptor["appliesAt"].as_str() {
                Some("next-session") => Some("next session"),
                Some("provider-restart") => Some("restarts OpenCode"),
                Some("server-restart") => Some("next server start"),
                _ => None,
            },
            hidden: boolean(descriptor, "hidden").unwrap_or(false),
            visible_when: text(&descriptor["visibleWhen"], "key")
                .map(|key| (key, strings(&descriptor["visibleWhen"]["in"]))),
            value: view
                .get("value")
                .map_or(SettingValue::Unset, SettingValue::from_json),
            explicit: boolean(view, "explicit").unwrap_or(false),
            unavailable: text(view, "unavailable"),
            effective: Effective::from_json(view),
            in_force: text(view, "inForce"),
            items: view
                .get("items")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(ListItem::from_json).collect())
                .unwrap_or_default(),
        })
    }

    /// The schema field for a list entry's value row, if the setting is a list.
    pub fn field_schema(&self, path: &str) -> Option<&ListFieldSchema> {
        match &self.kind {
            SettingKind::List(schema) => schema.fields.iter().find(|field| field.path == path),
            _ => None,
        }
    }

    pub fn visible(&self, snapshot: &Snapshot) -> bool {
        !self.hidden
            && self.visible_when.as_ref().is_none_or(|(key, allowed)| {
                let value = snapshot
                    .find(key)
                    .map_or(String::new(), |view| view.value.wire());
                allowed.contains(&value)
            })
    }
}

/// One entry of a list setting: a Harness profile, an MCP server.
#[derive(Clone, Debug, PartialEq)]
pub struct ListItem {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub status: Option<String>,
    pub fields: Vec<ListFieldValue>,
    pub resolved: Vec<ResolvedRow>,
}

impl ListItem {
    fn from_json(item: &Value) -> Option<Self> {
        Some(Self {
            id: text(item, "id")?,
            title: text(item, "title").unwrap_or_default(),
            summary: text(item, "summary").unwrap_or_default(),
            status: text(item, "status"),
            fields: item
                .get("fields")
                .and_then(Value::as_array)
                .map(|fields| {
                    fields
                        .iter()
                        .filter_map(ListFieldValue::from_json)
                        .collect()
                })
                .unwrap_or_default(),
            resolved: item
                .get("resolved")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(ResolvedRow::from_json).collect())
                .unwrap_or_default(),
        })
    }

    /// The entry's value at a schema path (`visibleWhen` reads through this).
    /// Nested list fields read as the ids they hold.
    pub fn lookup(&self, path: &str) -> String {
        self.fields
            .iter()
            .find(|field| field.path == path)
            .map_or(String::new(), |field| match &field.value {
                SettingValue::Text(text) => text.clone(),
                SettingValue::Number(number) => SettingValue::Number(*number).wire(),
                SettingValue::Flag(flag) => flag.to_string(),
                SettingValue::Unset => String::new(),
            })
    }

    /// Whether a schema field shows for this entry (`visibleWhen`).
    pub fn shows(&self, schema: &ListFieldSchema) -> bool {
        match &schema.visible_when {
            None => true,
            Some((path, within)) => within.iter().any(|each| *each == self.lookup(path)),
        }
    }
}

/// One entry field's value, joined to its schema by path.
#[derive(Clone, Debug, PartialEq)]
pub struct ListFieldValue {
    pub path: String,
    pub value: SettingValue,
    pub explicit: bool,
    pub effective: Option<ListEffective>,
    pub choices: Vec<Choice>,
    pub items: Vec<ListItem>,
}

impl ListFieldValue {
    fn from_json(field: &Value) -> Option<Self> {
        Some(Self {
            path: text(field, "path")?,
            value: field
                .get("value")
                .map_or(SettingValue::Unset, SettingValue::from_json),
            explicit: boolean(field, "explicit").unwrap_or(false),
            effective: field
                .get("effective")
                .filter(|effective| !effective.is_null())
                .map(|effective| ListEffective {
                    value: effective
                        .get("value")
                        .map_or(SettingValue::Unset, SettingValue::from_json),
                    origin: text(effective, "origin").unwrap_or_default(),
                }),
            choices: choices(&field["choices"]),
            items: field
                .get("items")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(ListItem::from_json).collect())
                .unwrap_or_default(),
        })
    }
}

/// What applies to a list field and where it comes from.
#[derive(Clone, Debug, PartialEq)]
pub struct ListEffective {
    pub value: SettingValue,
    pub origin: String,
}

/// A read-only row under an entry: what is in force and why.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedRow {
    pub label: String,
    pub value: String,
    pub origin: String,
}

impl ResolvedRow {
    fn from_json(row: &Value) -> Option<Self> {
        Some(Self {
            label: text(row, "label").unwrap_or_default(),
            value: text(row, "value").unwrap_or_default(),
            origin: text(row, "origin").unwrap_or_default(),
        })
    }
}

/// What `settings.read` (and a successful `settings.set`) answers with.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub path: String,
    pub exists: bool,
    pub settings: Vec<SettingView>,
}

impl Snapshot {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            path: text(value, "path").unwrap_or_default(),
            exists: boolean(value, "exists").unwrap_or(false),
            settings: value
                .get("settings")
                .and_then(Value::as_array)
                .map(|settings| settings.iter().filter_map(SettingView::from_json).collect())
                .unwrap_or_default(),
        })
    }

    pub fn find(&self, key: &str) -> Option<&SettingView> {
        self.settings.iter().find(|view| view.key == key)
    }

    /// The sections the snapshot covers, in page order, skipping empties.
    /// `skills` is always last: it holds the manager even when the table has
    /// no row on it, like the TUI's page.
    pub fn sections(&self) -> Vec<&str> {
        let mut order: Vec<(&str, usize)> = vec![];
        for view in &self.settings {
            if view.hidden
                || view.section == "skills"
                || order.iter().any(|(section, _)| *section == view.section)
            {
                continue;
            }
            order.push((view.section.as_str(), section_order(&view.section)));
        }
        order.sort_by_key(|(_, at)| *at);
        let mut out: Vec<&str> = order.into_iter().map(|(section, _)| section).collect();
        if !out.contains(&"skills") {
            out.push("skills");
        }
        out
    }
}

/// The value as the row draws it. A secret is never its value: only whether
/// one is stored. Secret pair lines (`KEY=<hidden>`) pass through opaquely —
/// the names are the server's, the values never leave it.
pub fn display_value(view: &SettingView) -> String {
    if view.kind.is_secret() {
        return display_secret(&view.value, view.explicit);
    }
    display_scalar(&view.value)
}

/// A list field's value as its row draws it. A scalar secret names storage;
/// secret pairs show one `KEY=<hidden>` line per key — the names are the
/// server's, and anything after the `=` is masked here no matter what the
/// server sent, so a value can never leak through the display.
pub fn display_field(field: &ListFieldValue, schema: Option<&ListFieldSchema>) -> String {
    use crate::language::message;
    if let Some(schema) = schema {
        match &schema.kind {
            FieldKind::Secret => return display_secret(&field.value, field.explicit),
            FieldKind::Pairs { secret: true } => {
                return match &field.value {
                    SettingValue::Unset => message("settings.default").into(),
                    SettingValue::Text(text) if text.trim().is_empty() => {
                        message("settings.default").into()
                    }
                    SettingValue::Text(text) => mask_pairs(text),
                    _ => "Saved".into(),
                };
            }
            _ => {}
        }
    }
    if matches!(&field.value, SettingValue::Text(text) if text.is_empty()) {
        return message("settings.default").into();
    }
    display_scalar(&field.value)
}

pub fn display_scalar(value: &SettingValue) -> String {
    use crate::language::message;
    match value {
        SettingValue::Unset => message("settings.default").into(),
        SettingValue::Flag(true) => message("settings.on").into(),
        SettingValue::Flag(false) => message("settings.off").into(),
        _ => value.wire(),
    }
}

fn display_secret(value: &SettingValue, explicit: bool) -> String {
    if *value == SettingValue::Unset && !explicit {
        if crate::language::spanish() {
            crate::language::message("settings.noKey").into()
        } else {
            "Not set".into()
        }
    } else {
        crate::language::message("settings.keySaved").into()
    }
}

/// One `KEY=<hidden>` line per key, whatever the value held.
pub fn mask_pairs(text: &str) -> String {
    text.lines()
        .map(|line| match line.split_once('=') {
            Some((key, _)) => format!("{key}=<hidden>"),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Checks typed text the way the server will: an empty string resets to the
/// default. Returns the text to send. The server still validates on the way
/// in; this only catches what is obviously wrong before a round trip.
pub fn normalize_setting_value(kind: &SettingKind, text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    match kind {
        SettingKind::Enum(choices) => choices
            .iter()
            .any(|choice| choice.value == trimmed)
            .then(|| trimmed.to_string())
            .ok_or_else(|| "Pick one of the offered values.".to_string()),
        SettingKind::Boolean => match trimmed {
            "true" | "false" => Ok(trimmed.into()),
            _ => Err("Use true or false.".into()),
        },
        SettingKind::Integer { min, max, .. } => {
            normalize_number(trimmed, true, Some(*min), Some(*max))
        }
        SettingKind::Secret
        | SettingKind::Text { .. }
        | SettingKind::Catalog { .. }
        | SettingKind::Duration(_)
        | SettingKind::Line(_)
        | SettingKind::List(_)
        | SettingKind::Other(_) => Ok(trimmed.into()),
    }
}

fn bound(number: f64) -> String {
    SettingValue::Number(number).wire()
}

fn normalize_number(
    text: &str,
    integer: bool,
    min: Option<f64>,
    max: Option<f64>,
) -> Result<String, String> {
    let value: f64 = text.parse().map_err(|_| "Type a number.".to_string())?;
    if !value.is_finite() {
        return Err("Type a number.".into());
    }
    if integer && value.fract() != 0. {
        return Err("Type a whole number.".into());
    }
    if min.is_some_and(|min| value < min) || max.is_some_and(|max| value > max) {
        return Err(match (min, max) {
            (Some(min), Some(max)) => {
                format!("Type a number from {} to {}.", bound(min), bound(max))
            }
            (Some(min), None) => format!("Type a number of at least {}.", bound(min)),
            (None, Some(max)) => format!("Type a number no greater than {}.", bound(max)),
            (None, None) => unreachable!("checked a bound"),
        });
    }
    Ok(text.into())
}

/// Checks a list field's typed text. Nested lists are edited entry by entry,
/// never as text.
pub fn normalize_field_value(kind: &FieldKind, text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    match kind {
        FieldKind::Enum(choices) => choices
            .iter()
            .any(|choice| choice.value == trimmed)
            .then(|| trimmed.to_string())
            .ok_or_else(|| "Pick one of the offered values.".to_string()),
        FieldKind::Boolean => match trimmed {
            "true" | "false" => Ok(trimmed.into()),
            _ => Err("Use true or false.".into()),
        },
        FieldKind::Integer { min, max } => normalize_number(trimmed, true, *min, *max),
        FieldKind::Number { min, max } => normalize_number(trimmed, false, *min, *max),
        FieldKind::NestedList { .. } | FieldKind::Effort => {
            Err("Change this where its entries are listed.".into())
        }
        FieldKind::Text
        | FieldKind::Words
        | FieldKind::Secret
        | FieldKind::Pairs { .. }
        | FieldKind::Other(_) => Ok(trimmed.into()),
    }
}

/// The guided "add a Harness provider" flow's document: the JSON
/// `settings.set` takes for a new `providers.harness.profiles[<id>]` entry.
/// Only the key's variable NAME is ever stored here, never a key.
pub fn profile_document(
    base_url: &str,
    api_format: &str,
    key_env: &str,
    models: &[DiscoveredModel],
) -> Result<String, String> {
    let base_url = base_url.trim();
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("Type the server's address, starting with http:// or https://.".into());
    }
    if !["chat", "responses", "anthropic"].contains(&api_format) {
        return Err("Pick the chat, responses or anthropic format.".into());
    }
    if models.is_empty() {
        return Err("Add at least one model.".into());
    }
    let mut document = serde_json::Map::new();
    document.insert("apiFormat".into(), Value::String(api_format.into()));
    document.insert("baseUrl".into(), Value::String(base_url.into()));
    let key_env = key_env.trim();
    if !key_env.is_empty() {
        document.insert("apiKeyEnv".into(), Value::String(key_env.into()));
    }
    document.insert(
        "models".into(),
        Value::Array(
            models
                .iter()
                .map(|model| {
                    let mut value = serde_json::json!({"id": model.id});
                    if let Some(tokens) = model.context_window {
                        value["contextWindow"] = tokens.into();
                    }
                    value
                })
                .collect(),
        ),
    );
    Ok(Value::Object(document).to_string())
}

/// An MCP server from one line: an http(s) address, or a command with its
/// arguments. Secrets are added field by field afterwards, never here.
pub fn mcp_document(target: &str) -> Result<String, String> {
    let text = target.trim();
    if text.is_empty() {
        return Err("Type an address or a command.".into());
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        let mut document = serde_json::Map::new();
        document.insert("type".into(), Value::String("http".into()));
        document.insert("url".into(), Value::String(text.into()));
        return Ok(Value::Object(document).to_string());
    }
    let mut words = text.split_whitespace();
    let command = words.next().unwrap_or_default();
    if command.is_empty() {
        return Err("Type an address or a command.".into());
    }
    let mut document = serde_json::Map::new();
    document.insert("type".into(), Value::String("stdio".into()));
    document.insert("command".into(), Value::String(command.into()));
    let args: Vec<Value> = words.map(|word| Value::String(word.into())).collect();
    if !args.is_empty() {
        document.insert("args".into(), Value::Array(args));
    }
    Ok(Value::Object(document).to_string())
}

/// A line the settings window shows after an export or import.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingsNotice {
    pub text: String,
    pub error: bool,
}

/// A memory as the save form holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryDraft {
    pub name: String,
    pub description: String,
    pub memory_type: String,
    pub body: String,
    pub scope: String,
}

/// A harness test or probe, while it runs and after.
#[derive(Clone, Debug, PartialEq)]
pub enum HarnessRun {
    Running {
        scope: String,
        kind: String,
        name: String,
    },
    Done {
        scope: String,
        kind: String,
        name: String,
        ok: bool,
        message: String,
        tools: Vec<String>,
    },
    Failed {
        scope: String,
        kind: String,
        name: String,
        message: String,
    },
}

impl HarnessRun {
    pub fn running(scope: &str, kind: &str, name: &str) -> Self {
        Self::Running {
            scope: scope.into(),
            kind: kind.into(),
            name: name.into(),
        }
    }

    pub fn failed(scope: &str, kind: &str, name: &str, message: String) -> Self {
        Self::Failed {
            scope: scope.into(),
            kind: kind.into(),
            name: name.into(),
            message,
        }
    }

    pub fn matches(&self, scope: &str, name: &str) -> bool {
        match self {
            Self::Running {
                scope: at,
                name: of,
                ..
            }
            | Self::Done {
                scope: at,
                name: of,
                ..
            }
            | Self::Failed {
                scope: at,
                name: of,
                ..
            } => at == scope && of == name,
        }
    }

    /// Reads a `harness.profile.test` / `mcp.server.test` answer.
    pub fn test_done(scope: &str, kind: &str, name: &str, result: &Value) -> Self {
        let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
        Self::Done {
            scope: scope.into(),
            kind: kind.into(),
            name: name.into(),
            ok,
            message: text(result, "message").unwrap_or_default(),
            tools: result
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// Reads a `harness.profile.probe` answer: the battery's own summary.
    pub fn probe_done(profile: &str, result: &Value) -> Self {
        let stopped = text(result, "stopped");
        let notes: Vec<String> = result
            .get("notes")
            .and_then(Value::as_array)
            .map(|notes| {
                notes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let checks = result
            .get("checks")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let message = match (&stopped, notes.is_empty()) {
            (Some(reason), _) => format!("Stopped early: {reason}"),
            (None, false) => notes.join("; "),
            (None, true) => format!("{checks} checks ran."),
        };
        Self::Done {
            scope: "harness".into(),
            kind: "probe".into(),
            name: profile.into(),
            ok: stopped.is_none(),
            message,
            tools: vec![],
        }
    }
}

/// A model id and the context size advertised by its server, if known.
#[derive(Clone, Debug, PartialEq)]
pub struct DiscoveredModel {
    pub id: String,
    pub context_window: Option<u64>,
}

/// A model discovery answer: the host's models, or why it failed.
#[derive(Clone, Debug, PartialEq)]
pub struct Discovery {
    pub host: Option<String>,
    pub models: Vec<DiscoveredModel>,
    pub error: Option<String>,
}

impl Discovery {
    pub fn from_json(result: &Value) -> Self {
        if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Self {
                host: text(result, "host"),
                models: result
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|models| {
                        models
                            .iter()
                            .filter_map(|model| {
                                Some(DiscoveredModel {
                                    id: text(model, "id")?,
                                    context_window: model
                                        .get("contextWindow")
                                        .and_then(Value::as_u64),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                error: None,
            }
        } else {
            Self {
                host: text(result, "host"),
                models: vec![],
                error: Some(text(result, "message").unwrap_or_else(|| "Discovery failed.".into())),
            }
        }
    }
}

/// One memory, with its body once read.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryEntry {
    pub name: String,
    pub description: String,
    pub memory_type: String,
    pub scope: String,
    pub body: Option<String>,
}

impl MemoryEntry {
    pub fn from_json(memory: &Value) -> Option<Self> {
        Some(Self {
            name: text(memory, "name")?,
            description: text(memory, "description").unwrap_or_default(),
            memory_type: text(memory, "type").unwrap_or_else(|| "reference".into()),
            scope: text(memory, "scope").unwrap_or_else(|| "global".into()),
            body: text(memory, "body"),
        })
    }
}

/// What `memory.list` answers with: every memory a thread sees, global first.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryList {
    pub project_id: Option<String>,
    pub memories: Vec<MemoryEntry>,
}

impl MemoryList {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            project_id: text(value, "projectId"),
            memories: value
                .get("memories")
                .and_then(Value::as_array)
                .map(|memories| memories.iter().filter_map(MemoryEntry::from_json).collect())
                .unwrap_or_default(),
        })
    }
}

/// Keyword matches with excerpts.
#[derive(Clone, Debug, PartialEq)]
pub struct MemorySearch {
    pub total: usize,
    pub matches: Vec<MemoryMatch>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MemoryMatch {
    pub name: String,
    pub description: String,
    pub scope: String,
    pub excerpt: String,
}

impl MemorySearch {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            total: value.get("total").and_then(Value::as_u64).unwrap_or(0) as usize,
            matches: value
                .get("memories")
                .and_then(Value::as_array)
                .map(|memories| {
                    memories
                        .iter()
                        .filter_map(|memory| {
                            Some(MemoryMatch {
                                name: text(memory, "name")?,
                                description: text(memory, "description").unwrap_or_default(),
                                scope: text(memory, "scope").unwrap_or_default(),
                                excerpt: text(memory, "excerpt").unwrap_or_default(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

/// The embeddings engine behind semantic memory search.
#[derive(Clone, Debug, PartialEq)]
pub struct Embeddings {
    pub state: String,
    pub phase: String,
    pub message: Option<String>,
    pub percent: Option<f64>,
    pub busy: bool,
    pub indexed: usize,
}

impl Embeddings {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            state: text(value, "state").unwrap_or_else(|| "stopped".into()),
            phase: text(value, "phase").unwrap_or_else(|| "idle".into()),
            message: text(value, "message"),
            percent: number(value, "percent"),
            busy: boolean(value, "busy").unwrap_or(false),
            indexed: value.get("indexed").and_then(Value::as_u64).unwrap_or(0) as usize,
        })
    }

    pub fn line(&self) -> String {
        match self.state.as_str() {
            "ready" => format!("Ready · {} memories indexed", self.indexed),
            "loading" => match self.percent {
                Some(percent) => format!("Loading · {}%", percent.round()),
                None => "Loading…".into(),
            },
            "failed" => format!(
                "Stopped · {}",
                self.message.as_deref().unwrap_or("the engine failed")
            ),
            _ => self.message.clone().unwrap_or_else(|| "Off".into()),
        }
    }
}

/// A skill the manager lists.
#[derive(Clone, Debug, PartialEq)]
pub struct ManagedSkill {
    pub source: String,
    pub folder: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub enabled: bool,
    pub editable: bool,
    pub providers: Vec<String>,
}

impl ManagedSkill {
    pub fn from_json(skill: &Value) -> Option<Self> {
        Some(Self {
            source: text(skill, "source")?,
            folder: text(skill, "folder")?,
            name: text(skill, "name").unwrap_or_default(),
            description: text(skill, "description").unwrap_or_default(),
            path: text(skill, "path").unwrap_or_default(),
            enabled: boolean(skill, "enabled").unwrap_or(true),
            editable: boolean(skill, "editable").unwrap_or(false),
            providers: skill
                .get("providers")
                .and_then(Value::as_array)
                .map(|providers| {
                    providers
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    pub fn provider_on(&self, id: &str) -> bool {
        self.providers.is_empty() || self.providers.iter().any(|provider| provider == id)
    }

    /// Empty is the wire representation of all providers, never of none.
    pub fn toggle_provider(&self, id: &str) -> Option<Vec<String>> {
        let on: Vec<String> = SKILL_PROVIDERS
            .iter()
            .map(|(provider, _)| *provider)
            .filter(|provider| self.provider_on(provider) != (*provider == id))
            .map(str::to_string)
            .collect();
        if on.is_empty() {
            None
        } else if on.len() == SKILL_PROVIDERS.len() {
            Some(vec![])
        } else {
            Some(on)
        }
    }
}

/// A provider a skill can be limited to, in the manager's own words.
pub const SKILL_PROVIDERS: [(&str, &str); 4] = [
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("opencode", "OpenCode"),
    ("harness", "Moxen Harness"),
];

/// One device paired for remote access.
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub connections: usize,
}

impl RemoteDevice {
    fn from_json(device: &Value) -> Option<Self> {
        Some(Self {
            id: text(device, "id")?,
            name: text(device, "name").unwrap_or_default(),
            connections: device
                .get("connections")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
        })
    }
}

/// An open pairing: the code the other machine types.
#[derive(Clone, Debug, PartialEq)]
pub struct Pairing {
    pub code: String,
    pub addresses: Vec<String>,
}

impl Pairing {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            code: text(value, "code")?,
            addresses: value
                .get("addresses")
                .and_then(Value::as_array)
                .map(|addresses| {
                    addresses
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

/// Remote access as the server sees it, with the paired devices.
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteState {
    pub available: bool,
    pub enabled: bool,
    pub listening: Vec<String>,
    pub error: Option<String>,
    pub devices: Vec<RemoteDevice>,
    pub pairing: Option<Pairing>,
}

impl RemoteState {
    pub fn status_from_json(value: &Value) -> Option<Self> {
        let listening: Vec<String> = value
            .get("listening")
            .and_then(Value::as_array)
            .map(|addresses| {
                addresses
                    .iter()
                    .filter_map(|address| {
                        let host = text(address, "host")?;
                        let port = address.get("port").and_then(Value::as_u64)?;
                        Some(format!("{host}:{port}"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            available: boolean(value, "available").unwrap_or(true),
            enabled: boolean(value, "enabled").unwrap_or(false),
            listening,
            error: text(value, "error"),
            devices: vec![],
            pairing: None,
        })
    }

    pub fn with_devices(mut self, value: &Value) -> Self {
        self.devices = value
            .get("devices")
            .and_then(Value::as_array)
            .map(|devices| devices.iter().filter_map(RemoteDevice::from_json).collect())
            .unwrap_or_default();
        self
    }

    /// One line on what is listening, in the TUI's words.
    pub fn line(&self) -> String {
        if !self.available {
            return "Unavailable on this server.".into();
        }
        if !self.enabled {
            return "Off.".into();
        }
        if self.listening.is_empty() {
            return self
                .error
                .clone()
                .unwrap_or_else(|| "On, but nothing is listening.".into());
        }
        format!("Listening on {}.", self.listening.join(", "))
    }
}

/// A provider updater's newest version, and Moxen's own update check.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateState {
    pub providers: Vec<ProviderLatest>,
    pub check_enabled: bool,
    /// Moxen's own status: up-to-date, available, no-release, unavailable.
    pub status: Option<String>,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub reason: Option<String>,
    pub updatable: bool,
    pub install_kind: Option<String>,
    pub release_notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderLatest {
    pub id: String,
    pub latest: Option<String>,
}

impl UpdateState {
    pub fn providers_from_json(value: &Value) -> Vec<ProviderLatest> {
        ["claude", "opencode", "codex"]
            .iter()
            .filter_map(|id| {
                let entry = value.get(id)?;
                if entry.is_null() {
                    return None;
                }
                Some(ProviderLatest {
                    id: id.to_string(),
                    latest: text(entry, "latest"),
                })
            })
            .collect()
    }

    pub fn check_from_json(value: &Value) -> Option<Self> {
        let install = value.get("install")?;
        Some(Self {
            providers: vec![],
            check_enabled: true,
            status: text(value, "status"),
            current: text(install, "version").or_else(|| text(value, "version")),
            latest: value
                .get("latest")
                .and_then(|latest| text(latest, "version")),
            reason: text(value, "reason"),
            updatable: boolean(value, "updatable").unwrap_or(false),
            install_kind: text(install, "kind"),
            release_notes: value
                .get("latest")
                .and_then(|release| text(release, "notes")),
        })
    }

    /// Moxen's own update in one line.
    pub fn line(&self) -> String {
        match self.status.as_deref() {
            Some("up-to-date") => "Moxen is up to date.".into(),
            Some("available") => match (&self.current, &self.latest) {
                (Some(current), Some(latest)) => format!("{current} → {latest} ready."),
                _ => "An update is ready.".into(),
            },
            Some("no-release") => "No release published.".into(),
            _ => self
                .reason
                .clone()
                .unwrap_or_else(|| "Could not check.".into()),
        }
    }
}

/// What a provider updater run reports.
pub fn provider_update_line(result: &Value) -> String {
    let after = text(result, "after");
    let updated = result
        .get("updated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if updated {
        return match after {
            Some(version) => format!("Updated to {version}."),
            None => "Updated.".into(),
        };
    }
    let output = text(result, "output").unwrap_or_default();
    let first = output.lines().next().unwrap_or_default().trim();
    if first.is_empty() {
        "Already current.".into()
    } else {
        first.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DiscoveredModel, Discovery, Embeddings, FieldKind, HarnessRun, ListFieldValue, MemoryList,
        MemorySearch, RemoteState, SettingKind, SettingValue, Snapshot, UpdateState, display_field,
        display_value, mcp_document, normalize_field_value, normalize_setting_value,
        profile_document, provider_update_line, section_label, section_order,
    };
    use serde_json::json;

    fn snapshot() -> Snapshot {
        Snapshot::from_json(&json!({
            "path": "/home/u/.moxen/config.json", "exists": true,
            "settings": [
                {"descriptor": {"key": "ui.theme", "label": "Theme", "description": "The look.",
                    "section": "interface", "group": "Looks", "kind": {"type": "enum", "choices": [
                        {"value": "auto", "label": "Auto"}, {"value": "dark", "label": "Dark"}]}},
                 "value": "dark", "explicit": true,
                 "effective": {"value": "dark", "label": "Dark"}},
                {"descriptor": {"key": "ui.usageRefreshSeconds", "label": "Refresh", "description": "How often.",
                    "section": "interface", "kind": {"type": "integer", "min": 5, "max": 600, "unit": "s"}},
                 "value": 30, "explicit": false},
                {"descriptor": {"key": "providers.harness.apiKey", "label": "Key", "description": "A key.",
                    "section": "provider:harness", "kind": {"type": "secret"}},
                 "value": "keychain:providers.harness.apiKey", "explicit": true},
                {"descriptor": {"key": "providers.harness.apiKey", "label": "Missing", "description": "A key.",
                    "section": "provider:harness", "kind": {"type": "secret"}},
                 "value": "", "explicit": false},
                {"descriptor": {"key": "mcpServers", "label": "Servers", "description": "Servers.",
                    "section": "mcp", "kind": {"type": "list", "noun": "server",
                    "actions": ["test", "duplicate"], "fields": [
                        {"path": "url", "label": "Address", "description": "Where.", "group": "Connect", "kind": {"type": "string"}},
                        {"path": "env", "label": "Secrets", "description": "Keys.", "group": "Connect",
                         "kind": {"type": "pairs", "secret": true}}]}},
                 "value": "", "explicit": false,
                 "items": [{"id": "search", "title": "search", "summary": "http · https://x",
                    "status": null,
                    "fields": [{"path": "url", "value": "https://x", "explicit": true},
                               {"path": "env", "value": "TOKEN=<hidden>", "explicit": true}],
                    "resolved": [{"label": "Claude Code", "value": "Gets it", "origin": "the tab"}]}]},
            ],
        }))
        .expect("fixture snapshot")
    }

    #[test]
    fn sections_follow_the_server_tables_order() {
        assert_eq!(section_label("provider:harness"), "Moxen Harness");
        assert_eq!(section_label("mcp"), "MCP servers");
        assert_eq!(section_label("skills"), "Skills");
        assert!(section_order("general") < section_order("provider:harness"));
        assert!(section_order("provider:harness") < section_order("mcp"));
        assert!(section_order("mcp") < section_order("skills"));
        // Unknown sections render after the known ones, never vanish.
        assert_eq!(section_label("next-thing"), "next-thing");
        assert!(section_order("next-thing") >= 14);
        let snapshot = snapshot();
        assert_eq!(
            snapshot.sections(),
            vec!["interface", "provider:harness", "mcp", "skills"]
        );
        assert_eq!(snapshot.find("ui.theme").expect("theme").label, "Theme");
    }

    #[test]
    fn secret_values_are_named_never_shown() {
        let snapshot = snapshot();
        let stored = snapshot.find("providers.harness.apiKey").expect("key");
        assert_eq!(display_value(stored), "Saved in the keychain");
        let missing = snapshot
            .settings
            .iter()
            .find(|view| view.label == "Missing")
            .expect("missing");
        assert_eq!(display_value(missing), "Not set");
        // The keychain reference itself is never drawn, only the fact one exists.
        assert!(!display_value(stored).contains("providers.harness"));
        let servers = snapshot.find("mcpServers").expect("servers");
        let item = &servers.items[0];
        let env = item
            .fields
            .iter()
            .find(|field| field.path == "env")
            .expect("env");
        let schema = servers.field_schema("env").expect("schema");
        // A secret pair line passes through opaquely: the name, never a value.
        assert_eq!(display_field(env, Some(schema)), "TOKEN=<hidden>");
        // Even a value that arrived in the clear draws masked.
        let hostile = ListFieldValue {
            path: "env".into(),
            value: SettingValue::Text("TOKEN=real-secret".into()),
            explicit: true,
            effective: None,
            choices: vec![],
            items: vec![],
        };
        assert_eq!(
            display_field(&hostile, servers.field_schema("env")),
            "TOKEN=<hidden>"
        );
        let url = item
            .fields
            .iter()
            .find(|field| field.path == "url")
            .expect("url");
        assert_eq!(display_field(url, servers.field_schema("url")), "https://x");
    }

    #[test]
    fn setting_values_validate_like_the_server_will() {
        let kind = SettingKind::Enum(vec![]);
        assert!(normalize_setting_value(&kind, "").is_ok());
        let kind = SettingKind::Integer {
            min: 5.,
            max: 600.,
            unit: None,
        };
        assert_eq!(
            normalize_setting_value(&kind, "30").expect("in range"),
            "30"
        );
        assert_eq!(normalize_setting_value(&kind, "").expect("reset"), "");
        assert!(normalize_setting_value(&kind, "many").is_err());
        assert!(normalize_setting_value(&kind, "4").is_err());
        assert!(normalize_setting_value(&kind, "601").is_err());
        let kind = SettingKind::Boolean;
        assert!(normalize_setting_value(&kind, "true").is_ok());
        assert!(normalize_setting_value(&kind, "yes").is_err());
        // Nested lists are edited entry by entry, never as text.
        assert!(
            normalize_field_value(
                &FieldKind::NestedList {
                    noun: "model".into(),
                    fields: vec![]
                },
                "x"
            )
            .is_err()
        );
        assert!(normalize_field_value(&FieldKind::Text, " anything ").is_ok());
    }

    #[test]
    fn numeric_list_fields_reject_out_of_range_nonfinite_and_fractional_integers() {
        let slots = FieldKind::from_json(&json!({"type":"integer", "min":1}));
        assert_eq!(normalize_field_value(&slots, " 4 ").unwrap(), "4");
        for invalid in ["0", "-1", "1.25", "NaN", "inf"] {
            assert!(normalize_field_value(&slots, invalid).is_err(), "{invalid}");
        }
        let top_p = FieldKind::from_json(&json!({"type":"number", "min":0, "max":1}));
        assert_eq!(normalize_field_value(&top_p, "0.25").unwrap(), "0.25");
        assert_eq!(normalize_field_value(&top_p, " ").unwrap(), "");
        assert!(normalize_field_value(&top_p, "-0.25").is_err());
        assert!(normalize_field_value(&top_p, "1.25").is_err());
    }

    #[test]
    fn skill_provider_toggle_treats_empty_as_all_and_never_sends_none() {
        let mut skill = super::ManagedSkill::from_json(
            &json!({"source":"agents","folder":"review","providers":[]}),
        )
        .unwrap();
        assert!(
            super::SKILL_PROVIDERS
                .iter()
                .all(|(provider, _)| skill.provider_on(provider))
        );
        skill.providers = skill.toggle_provider("codex").unwrap();
        assert_eq!(skill.providers, ["claude", "opencode", "harness"]);
        assert!(!skill.provider_on("codex"));
        assert_eq!(skill.toggle_provider("codex"), Some(vec![]));
        skill.providers = vec!["codex".into()];
        assert!(skill.toggle_provider("codex").is_none());
    }

    #[test]
    fn add_documents_hold_ids_and_names_never_keys() {
        let models = ["large", "small"].map(|id| DiscoveredModel {
            id: id.into(),
            context_window: None,
        });
        let document = profile_document("https://models.example/v1", "chat", "MODELS_KEY", &models)
            .expect("profile");
        assert_eq!(
            document,
            r#"{"apiFormat":"chat","baseUrl":"https://models.example/v1","apiKeyEnv":"MODELS_KEY","models":[{"id":"large"},{"id":"small"}]}"#
        );
        assert!(profile_document("models.example/v1", "chat", "", &models).is_err());
        assert!(profile_document("https://x", "soap", "", &models).is_err());
        assert!(profile_document("https://x", "chat", "", &[]).is_err());
        assert_eq!(
            mcp_document("https://mcp.example/sse").expect("http"),
            r#"{"type":"http","url":"https://mcp.example/sse"}"#
        );
        assert_eq!(
            mcp_document("npx -y server args").expect("stdio"),
            r#"{"type":"stdio","command":"npx","args":["-y","server","args"]}"#
        );
        assert!(mcp_document("   ").is_err());
    }

    #[test]
    fn harness_runs_summarize_tests_and_probes() {
        let run = HarnessRun::test_done(
            "harness",
            "test",
            "office",
            &json!({"ok": true, "message": "Answered in 1.2s.", "tools": ["read", "bash"]}),
        );
        assert!(matches!(run, HarnessRun::Done { ok: true, .. }));
        assert!(run.matches("harness", "office"));
        assert!(!run.matches("mcp", "office"));
        let probe = HarnessRun::probe_done(
            "office",
            &json!({"stopped": null, "notes": ["Single slot."], "checks": []}),
        );
        assert!(matches!(probe, HarnessRun::Done { ok: true, .. }));
        let halted =
            HarnessRun::probe_done("office", &json!({"stopped": "No route.", "notes": []}));
        assert!(matches!(halted, HarnessRun::Done { ok: false, .. }));
    }

    #[test]
    fn memory_and_embeddings_decode() {
        let list = MemoryList::from_json(&json!({
            "projectId": "p", "memories": [
                {"name": "tastes", "description": "Likes.", "type": "user", "scope": "global", "body": "Tea."}],
        }))
        .expect("list");
        assert_eq!(list.memories[0].name, "tastes");
        assert_eq!(list.memories[0].body.as_deref(), Some("Tea."));
        let search = MemorySearch::from_json(&json!({
            "total": 1, "memories": [
                {"name": "tastes", "description": "Likes.", "scope": "global", "excerpt": "…Tea…"}],
        }))
        .expect("search");
        assert_eq!(search.total, 1);
        assert_eq!(search.matches[0].excerpt, "…Tea…");
        let embeddings =
            Embeddings::from_json(&json!({"state": "ready", "busy": false, "indexed": 12}))
                .expect("embeddings");
        assert_eq!(embeddings.line(), "Ready · 12 memories indexed");
        let loading =
            Embeddings::from_json(&json!({"state": "loading", "busy": true, "indexed": 0}))
                .expect("loading");
        assert_eq!(loading.line(), "Loading…");
    }

    #[test]
    fn remote_and_update_states_read_in_plain_words() {
        let remote = RemoteState::status_from_json(&json!({
            "available": true, "enabled": true,
            "listening": [{"host": "192.168.1.2", "port": 47317}],
        }))
        .expect("status")
        .with_devices(&json!({"devices": [{"id": "d1", "name": "Laptop", "connections": 1}]}));
        assert_eq!(remote.line(), "Listening on 192.168.1.2:47317.");
        assert_eq!(remote.devices[0].name, "Laptop");
        let off = RemoteState::status_from_json(&json!({"available": true, "enabled": false}))
            .expect("off");
        assert_eq!(off.line(), "Off.");
        let check = UpdateState::check_from_json(&json!({
            "install": {"version": "0.2.0"}, "status": "available",
            "latest": {"version": "0.3.0"}, "updatable": true,
        }))
        .expect("check");
        assert_eq!(check.line(), "0.2.0 → 0.3.0 ready.");
        assert_eq!(
            UpdateState::providers_from_json(&json!({"claude": {"latest": "2.0.0"}, "codex": {}}))
                [0]
            .latest
            .as_deref(),
            Some("2.0.0")
        );
        assert_eq!(
            provider_update_line(&json!({"updated": true, "after": "2.0.0", "output": ""})),
            "Updated to 2.0.0."
        );
        assert_eq!(
            provider_update_line(&json!({"updated": false, "output": "already current\n"})),
            "already current"
        );
    }

    #[test]
    fn discovery_lists_models_or_says_why_not() {
        let found = Discovery::from_json(&json!({
            "ok": true, "host": "models.example",
            "models": [{"id": "large"}, {"id": "small"}],
        }));
        assert_eq!(
            found
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["large", "small"]
        );
        let failed =
            Discovery::from_json(&json!({"ok": false, "host": null, "message": "No route."}));
        assert_eq!(failed.error.as_deref(), Some("No route."));
        assert!(found.error.is_none());
    }

    #[test]
    fn setting_value_wires_back_to_text() {
        assert_eq!(SettingValue::Text("dark".into()).wire(), "dark");
        assert_eq!(SettingValue::Flag(true).wire(), "true");
        assert_eq!(SettingValue::Number(30.).wire(), "30");
        assert_eq!(SettingValue::Unset.wire(), "");
        assert_eq!(SettingValue::from_json(&json!("")), SettingValue::Unset);
        assert_eq!(SettingValue::from_json(&json!(null)), SettingValue::Unset);
        let field = ListFieldValue::from_json(&json!({"path": "x"})).expect("field");
        assert_eq!(field.value, SettingValue::Unset);
    }
}
