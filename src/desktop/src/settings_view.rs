//! The settings window: every page the TUI's settings screen has, rendered
//! from the server's settings table (`settings.read`) and written through
//! the server (`settings.set`, `settings.duplicate`, the profile, memory,
//! skill, remote and update commands). Sections, rows, list fields and their
//! editors all come from the snapshot's descriptors — nothing here names a
//! setting key of its own, apart from the remote switch and update buttons,
//! which address the server like any command does.

use crate::{
    model::{Embeddings, HarnessRun, ManagedSkill, MemoryDraft, RemoteState, Snapshot, ThreadId},
    settings::{
        self, DiscoveredModel, FieldKind, ListFieldSchema, ListFieldValue, ListItem, SettingKind,
        SettingValue, section_label,
    },
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

actions!(settings_view, [OpenSettings]);

/// What the window's form bar edits.
#[derive(Clone)]
pub enum SettingsForm {
    /// A top-level setting.
    Scalar {
        key: String,
        title: String,
        secret: bool,
        multiline: bool,
    },
    /// One field of a list entry.
    Field {
        key: String,
        id: String,
        path: String,
        title: String,
        secret: bool,
        multiline: bool,
        previous: String,
    },
    /// The new id a `settings.duplicate` copies under.
    Duplicate { key: String, id: String },
    /// A model added to a Harness profile's nested list.
    AddModel { key: String, profile: String },
    /// A profile pasted as an exported document.
    Import,
    /// A skill copied in from a folder.
    ImportSkill { source: String },
    /// A skill's whole text.
    SkillText {
        source: String,
        folder: String,
        previous: String,
    },
    /// A memory's whole body, replaced in one edit.
    MemoryEdit {
        name: String,
        scope: String,
        old: String,
    },
    /// Text added to the end of a memory.
    MemoryAppend { name: String, scope: String },
}

impl SettingsForm {
    fn title(&self) -> String {
        match self {
            Self::Scalar { title, .. } => title.clone(),
            Self::Field { title, .. } => title.clone(),
            Self::Duplicate { id, .. } => format!("Copy “{id}” under a new name"),
            Self::AddModel { .. } => "Name the model".into(),
            Self::Import => "Import a profile".into(),
            Self::ImportSkill { .. } => "Import a skill".into(),
            Self::SkillText { folder, .. } => format!("Edit {folder}"),
            Self::MemoryEdit { name, .. } => format!("Edit {name}"),
            Self::MemoryAppend { name, .. } => format!("Add to {name}"),
        }
    }

    fn secret(&self) -> bool {
        match self {
            Self::Scalar { secret, .. } | Self::Field { secret, .. } => *secret,
            _ => false,
        }
    }

    fn multiline(&self) -> bool {
        match self {
            Self::Scalar { multiline, .. } | Self::Field { multiline, .. } => *multiline,
            Self::Import
            | Self::ImportSkill { .. }
            | Self::SkillText { .. }
            | Self::MemoryEdit { .. } => true,
            _ => false,
        }
    }
}

/// A destructive or external action, confirmed before it runs.
#[derive(Clone)]
pub enum SettingsConfirm {
    RemoveEntry {
        key: String,
        id: String,
    },
    RemoveModel {
        key: String,
        profile: String,
        model: String,
    },
    DeleteMemory {
        name: String,
        scope: String,
    },
    RemoveSkill {
        source: String,
        folder: String,
    },
    RevokeDevice {
        id: String,
    },
    UpdateProvider {
        provider: String,
    },
    SetupEmbeddings {
        all: bool,
    },
    RebuildEmbeddings {
        all: bool,
    },
    UnloadEmbeddings,
    ImportClaude,
}

/// A memory being written, one field at a time.
#[derive(Clone, Default)]
pub struct MemoryWizard {
    pub step: u8,
    pub name: String,
    pub description: String,
    pub body: String,
    pub type_idx: usize,
    pub scoped: bool,
}

/// A Harness profile being added, one field at a time.
#[derive(Clone, Default)]
pub struct ProfileWizard {
    pub list_key: String,
    pub step: u8,
    pub id: String,
    pub base_url: String,
    pub format_idx: usize,
    pub key_env: String,
}

impl ProfileWizard {
    fn advance(&mut self, text: String) -> Result<(), &'static str> {
        match self.step {
            0 if text.is_empty() => return Err("Type an id."),
            0 => self.id = text.to_lowercase(),
            1 if text.is_empty() => return Err("Type the server's address."),
            1 => self.base_url = text,
            2 => {}
            3 => self.key_env = text,
            _ => unreachable!("the models step saves the profile"),
        }
        self.step += 1;
        Ok(())
    }

    fn discovery_request(&self) -> Option<(&str, &str, Option<String>)> {
        (self.step == 4).then(|| {
            (
                self.base_url.as_str(),
                PROFILE_FORMATS[self.format_idx],
                (!self.key_env.is_empty()).then(|| self.key_env.clone()),
            )
        })
    }
}

/// An MCP server being added: a name, then one line.
#[derive(Clone, Default)]
pub struct McpWizard {
    pub list_key: String,
    pub step: u8,
    pub name: String,
}

pub const MEMORY_TYPES: [(&str, &str); 4] = [
    ("user", "About you"),
    ("feedback", "Corrections"),
    ("project", "Project"),
    ("reference", "Reference"),
];

const PROFILE_FORMATS: [&str; 3] = ["chat", "responses", "anthropic"];

impl Workspace {
    /// The thread the settings managers address, if the sidebar lists one.
    pub fn settings_thread(&self) -> Option<ThreadId> {
        self.source
            .order(false)
            .contains(&self.selected)
            .then_some(self.selected)
    }

    /// Opens the window and reads what its tabs show.
    pub fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.thread_popup = None;
        self.thread_form = None;
        self.palette_open = false;
        self.picker_open = false;
        self.dropdown = None;
        self.settings_open = true;
        self.settings_error = None;
        self.source.read_settings();
        self.source.read_remote();
        self.source.read_updates();
        self.source.read_memories(self.settings_thread());
        self.source.read_managed_skills(self.settings_thread());
        self.source.read_embeddings();
        window.focus(&self.settings_focus, cx);
        cx.notify();
    }

    pub fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_open = false;
        self.settings_rail_tip = None;
        self.settings_form = None;
        self.settings_form_saving = false;
        self.settings_confirm = None;
        self.settings_error = None;
        self.settings_memory_new = None;
        self.settings_profile_new = None;
        self.settings_mcp_new = None;
        self.clear_settings_transients();
        let focus = if self.experience_ui.panel.is_some() {
            &self.experience_focus
        } else {
            &self.sidebar_focus
        };
        window.focus(focus, cx);
        cx.notify();
    }

    /// Escape with the window open: the form or wizard first, then the window.
    pub fn close_settings_over(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings_form.is_some()
            || self.settings_confirm.is_some()
            || self.settings_memory_new.is_some()
            || self.settings_profile_new.is_some()
            || self.settings_mcp_new.is_some()
            || self.settings_export.is_some()
        {
            self.settings_form = None;
            self.settings_form_saving = false;
            self.settings_confirm = None;
            self.settings_error = None;
            self.settings_memory_new = None;
            self.settings_profile_new = None;
            self.settings_mcp_new = None;
            self.clear_settings_transients();
            window.focus(&self.settings_focus, cx);
            cx.notify();
        } else {
            self.close_settings(window, cx);
        }
    }

    fn clear_settings_transients(&mut self) {
        self.settings_export = None;
        self.settings_discovered = None;
        self.source.clear_settings_transients();
    }

    fn sync_settings(&mut self, cx: &mut Context<Self>) {
        if let Some(result) = self.source.take_settings_write() {
            if self.settings_form_saving {
                match result {
                    Ok(()) => {
                        self.settings_form = None;
                        if let Some(wizard) = self.settings_profile_new.take() {
                            self.settings_item = Some(wizard.id);
                        }
                    }
                    Err(message) => self.settings_error = Some(message),
                }
            } else if let Err(message) = result {
                self.settings_notice = Some((message, true));
            }
            self.settings_form_saving = false;
        }
        if let Some(notice) = self.source.take_settings_notice() {
            self.settings_notice = Some((notice.text, notice.error));
        }
        if let Some(document) = self.source.take_profile_document() {
            self.settings_export = Some(document);
        }
        if let Some(found) = self.source.take_discovered()
            && self
                .settings_profile_new
                .as_ref()
                .is_some_and(|wizard| wizard.step == 4)
        {
            self.settings_input.update(cx, |input, cx| {
                if input.text().is_empty() {
                    input.set_text(discovered_ids(&found), cx);
                }
            });
            self.settings_discovered = Some(found);
        }
    }

    fn tabs(&self, snapshot: &Snapshot) -> Vec<(String, String)> {
        let mut tabs: Vec<(String, String)> = snapshot
            .sections()
            .into_iter()
            .map(|section| {
                (
                    section.to_string(),
                    crate::language::tr(section_label(section)).into_owned(),
                )
            })
            .collect();
        tabs.push((
            "remote".into(),
            crate::language::tr("Remote access").into_owned(),
        ));
        tabs.push((
            "updates".into(),
            crate::language::tr("Updates").into_owned(),
        ));
        tabs
    }

    fn open_settings_form(&mut self, form: SettingsForm, initial: &str, cx: &mut Context<Self>) {
        let secret = form.secret();
        let multiline = form.multiline();
        self.settings_confirm = None;
        self.settings_error = None;
        self.settings_memory_new = None;
        self.settings_profile_new = None;
        self.settings_mcp_new = None;
        self.settings_input.update(cx, |input, cx| {
            input.masked = secret;
            input.height = if multiline { 120. } else { 44. };
            input.placeholder = if secret {
                "Type a new key — characters are hidden"
            } else {
                match &form {
                    SettingsForm::Import => "Paste the exported JSON document",
                    SettingsForm::ImportSkill { .. } => "The folder to copy in",
                    _ => "",
                }
            };
            input.set_text(initial.into(), cx);
        });
        self.settings_form = Some(form);
        self.settings_form_saving = false;
        cx.notify();
    }

    /// Cycles an enum through its choices, or a boolean through Default/On/Off.
    pub fn cycle_setting(&mut self, key: &str, cx: &mut Context<Self>) {
        let next = self
            .source
            .settings()
            .as_ref()
            .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
            .and_then(|snapshot| snapshot.find(key))
            .and_then(|view| match &view.kind {
                SettingKind::Enum(choices) => {
                    let current = match &view.value {
                        SettingValue::Text(text) => {
                            choices.iter().position(|choice| &choice.value == text)
                        }
                        _ => None,
                    };
                    choices
                        .get(current.map_or(0, |at| (at + 1) % choices.len().max(1)))
                        .map(|choice| choice.value.clone())
                }
                SettingKind::Boolean => Some(match &view.value {
                    SettingValue::Unset => "true".into(),
                    SettingValue::Flag(true) => "false".into(),
                    SettingValue::Flag(false) => String::new(),
                    SettingValue::Text(_) | SettingValue::Number(_) => "true".into(),
                }),
                _ => None,
            });
        if let Some(next) = next {
            self.settings_error = None;
            self.source.set_setting(key, &next);
            cx.notify();
        }
    }

    /// Cycles a list field: enums and efforts through their choices, booleans
    /// through Default/On/Off.
    pub fn cycle_field(&mut self, key: &str, id: &str, path: &str, cx: &mut Context<Self>) {
        let next = self
            .source
            .settings()
            .as_ref()
            .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
            .and_then(|snapshot| snapshot.find(key))
            .and_then(|view| {
                let schema = view.field_schema(path)?;
                let item = view.items.iter().find(|item| item.id == id)?;
                let field = item.fields.iter().find(|field| field.path == path)?;
                match &schema.kind {
                    crate::settings::FieldKind::Enum(choices) => {
                        let current = match &field.value {
                            SettingValue::Text(text) => {
                                choices.iter().position(|choice| &choice.value == text)
                            }
                            _ => None,
                        };
                        choices
                            .get(current.map_or(0, |at| (at + 1) % choices.len().max(1)))
                            .map(|choice| choice.value.clone())
                    }
                    crate::settings::FieldKind::Effort => {
                        let current = match &field.value {
                            SettingValue::Text(text) => field
                                .choices
                                .iter()
                                .position(|choice| &choice.value == text),
                            _ => None,
                        };
                        field
                            .choices
                            .get(current.map_or(0, |at| (at + 1) % field.choices.len().max(1)))
                            .map(|choice| choice.value.clone())
                    }
                    crate::settings::FieldKind::Boolean => Some(match &field.value {
                        SettingValue::Unset => "true".into(),
                        SettingValue::Flag(true) => "false".into(),
                        SettingValue::Flag(false) => String::new(),
                        SettingValue::Text(_) | SettingValue::Number(_) => "true".into(),
                    }),
                    _ => None,
                }
            });
        if let Some(next) = next {
            self.settings_error = None;
            self.source
                .set_setting(&format!("{key}[{id}].{path}"), &next);
            cx.notify();
        }
    }

    /// Submits the form bar's text: validated like the server will, then sent.
    pub fn submit_settings_text(
        &mut self,
        text: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.settings_saving().is_some() {
            return;
        }
        if self.settings_form.is_none() {
            self.submit_wizard_text(text, cx);
            return;
        }
        let Some(form) = self.settings_form.clone() else {
            return;
        };
        let text = text.trim().to_string();
        match form {
            SettingsForm::Scalar { key, .. } => {
                let kind = self
                    .source
                    .settings()
                    .as_ref()
                    .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
                    .and_then(|snapshot| snapshot.find(&key))
                    .map(|view| view.kind.clone());
                match kind {
                    None => return,
                    Some(kind) => match settings::normalize_setting_value(&kind, &text) {
                        Err(message) => self.settings_error = Some(message),
                        Ok(value) => {
                            self.source.set_setting(&key, &value);
                            self.settings_form_saving = true;
                        }
                    },
                }
            }
            SettingsForm::Field { key, id, path, .. } => {
                let kind = self
                    .source
                    .settings()
                    .as_ref()
                    .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
                    .and_then(|snapshot| snapshot.find(&key))
                    .and_then(|view| view.field_schema(&path).map(|schema| schema.kind.clone()));
                match kind {
                    None => return,
                    Some(kind) => match settings::normalize_field_value(&kind, &text) {
                        Err(message) => self.settings_error = Some(message),
                        Ok(value) => {
                            // A secret pair line of `KEY=<hidden>` keeps the stored value.
                            self.source
                                .set_setting(&format!("{key}[{id}].{path}"), &value);
                            self.settings_form_saving = true;
                        }
                    },
                }
            }
            SettingsForm::Duplicate { key, id } => {
                if text.is_empty() {
                    self.settings_error = Some("Type a name.".into());
                } else {
                    // Copying is non-destructive: it runs at once.
                    self.source.duplicate_setting(&key, &id, &text);
                    self.settings_form_saving = true;
                    self.settings_item = Some(text);
                }
            }
            SettingsForm::AddModel { key, profile } => {
                if text.is_empty() {
                    self.settings_error = Some("Type a model name.".into());
                } else {
                    let model = text.trim();
                    self.source
                        .set_setting(&format!("{key}[{profile}].models[{model}]"), "{}");
                    self.settings_form_saving = true;
                }
            }
            SettingsForm::Import => {
                if text.is_empty() {
                    self.settings_error = Some("Paste an exported profile.".into());
                } else {
                    self.source.import_profile(&text);
                    self.settings_form_saving = true;
                }
            }
            SettingsForm::ImportSkill { source } => {
                if text.is_empty() {
                    self.settings_error = Some("Type the folder to copy in.".into());
                } else {
                    self.source
                        .import_skill(self.settings_thread(), &source, &text);
                    self.settings_form = None;
                }
            }
            SettingsForm::SkillText {
                source,
                folder,
                previous,
            } => {
                let thread = self.settings_thread();
                self.source
                    .save_skill(thread, &source, &folder, &text, &previous);
                self.settings_form = None;
                // The saved text answers again below.
                self.source.read_skill_text(thread, &source, &folder);
            }
            SettingsForm::MemoryEdit { name, scope, old } => {
                let thread = self.settings_thread();
                if text == old {
                    self.settings_form = None;
                } else {
                    self.source
                        .edit_memory(thread, &name, &scope, &old, &text, None);
                    self.settings_form = None;
                    self.source.read_memory(thread, &name, &scope);
                }
            }
            SettingsForm::MemoryAppend { name, scope } => {
                if text.is_empty() {
                    self.settings_error = Some("Type the text to add.".into());
                } else {
                    let thread = self.settings_thread();
                    self.source.append_memory(thread, &name, &scope, &text);
                    self.settings_form = None;
                    self.source.read_memory(thread, &name, &scope);
                }
            }
        }
        cx.notify();
    }

    fn confirm_settings(
        &mut self,
        title: String,
        detail: String,
        action: SettingsConfirm,
        cx: &mut Context<Self>,
    ) {
        self.settings_form = None;
        self.settings_error = None;
        self.settings_confirm = Some((title, detail, action));
        cx.notify();
    }

    pub fn submit_settings_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((_, _, action)) = self.settings_confirm.clone() else {
            return;
        };
        let thread = self.settings_thread();
        match action {
            SettingsConfirm::RemoveEntry { key, id } => {
                self.source.set_setting(&format!("{key}[{id}]"), "");
            }
            SettingsConfirm::RemoveModel {
                key,
                profile,
                model,
            } => {
                self.source
                    .set_setting(&format!("{key}[{profile}].models[{model}]"), "");
            }
            SettingsConfirm::DeleteMemory { name, scope } => {
                self.source.delete_memory(thread, &name, &scope);
                self.settings_memory = None;
            }
            SettingsConfirm::RemoveSkill { source, folder } => {
                self.source.remove_skill(thread, &source, &folder);
                self.settings_skill = None;
            }
            SettingsConfirm::RevokeDevice { id } => self.source.revoke_device(&id),
            SettingsConfirm::UpdateProvider { provider } => self.source.update_provider(&provider),
            SettingsConfirm::SetupEmbeddings { all } => self.source.setup_embeddings(all),
            SettingsConfirm::RebuildEmbeddings { all } => self.source.rebuild_embeddings(all),
            SettingsConfirm::UnloadEmbeddings => self.source.unload_embeddings(),
            SettingsConfirm::ImportClaude => self.source.import_claude_memory(thread),
        }
        self.settings_confirm = None;
        window.focus(&self.settings_focus, cx);
        cx.notify();
    }

    pub fn submit_memory_search(&mut self, text: String, cx: &mut Context<Self>) {
        let query = text.trim().to_string();
        if query.is_empty() {
            return;
        }
        self.source.search_memories(self.settings_thread(), &query);
        cx.notify();
    }
}

/// The window itself: a dimmed overlay with a centred panel, like the TUI's
/// settings page over the transcript.
pub fn render(
    w: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    if !w.settings_open {
        return div().into_any_element();
    }
    w.sync_settings(cx);
    let snapshot = w.source.settings();
    let tabs = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
        .map(|snapshot| w.tabs(snapshot))
        .unwrap_or_default();
    if w.settings_tab >= tabs.len() {
        w.settings_tab = 0;
    }
    let tab = tabs
        .get(w.settings_tab)
        .map(|(id, _)| id.clone())
        .unwrap_or_default();
    let mut panel = div()
        .id("settings-panel")
        .track_focus(&w.settings_focus)
        // A press outside the panel dismisses it; clicks inside never reach
        // here, because GPUI delivers a press to every element under it.
        .on_mouse_down_out(cx.listener(|this, _, window, cx| this.close_settings(window, cx)))
        .w(px(960.))
        .h(px(620.))
        .flex()
        .flex_col()
        .rounded(px(12.))
        .bg(color("raised"))
        .shadow(theme::float_shadow())
        .text_size(px(theme::UI))
        .line_height(px(theme::UI_LINE))
        .text_color(color("ink"))
        .child(header(w, snapshot.as_ref(), cx))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(rail(w, &tabs, window, cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(body(w, &tab, window, cx)),
                ),
        );
    panel = panel
        .when_some(w.settings_notice.clone(), |s, (text, error)| {
            s.child(panel_notice(text, error))
        })
        .when_some(w.settings_form.clone(), |s, form| {
            s.child(form_bar(w, &form, cx))
        })
        .when_some(w.settings_confirm.clone(), |s, (title, detail, _)| {
            s.child(confirm_bar(w, &title, &detail, cx))
        })
        .when_some(w.settings_memory_new.clone(), |s, wizard| {
            s.child(memory_wizard_bar(w, &wizard, cx))
        })
        .when_some(w.settings_profile_new.clone(), |s, wizard| {
            s.child(profile_wizard_bar(w, &wizard, cx))
        })
        .when_some(w.settings_mcp_new.clone(), |s, wizard| {
            s.child(mcp_wizard_bar(w, &wizard, cx))
        })
        .when_some(w.settings_export.clone(), |s, (profile, text)| {
            s.child(export_view(w, &profile, &text, cx))
        });
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .absolute()
                .inset_0()
                .id("settings-backdrop")
                .occlude()
                .bg(black().opacity(0.22)),
        )
        .child(panel)
        .into_any_element()
}

fn header(
    _w: &Workspace,
    snapshot: Option<&std::sync::Arc<Result<Snapshot, String>>>,
    cx: &mut Context<Workspace>,
) -> Div {
    let path = snapshot
        .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
        .map(|snapshot| snapshot.path.clone())
        .unwrap_or_default();
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(16.))
        .pt(px(14.))
        .pb(px(10.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(px(15.))
                        .child(crate::language::message("settings.title")),
                )
                .when(!path.is_empty(), |s| {
                    s.child(
                        div()
                            .font_family(theme::MONO)
                            .text_size(px(11.5))
                            .text_color(color("ink-2"))
                            .child(path),
                    )
                }),
        )
        .child(
            div()
                .id("settings-close")
                .control("Close settings")
                .size(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .child(ui::icon("x", "ink-2"))
                .on_click(cx.listener(|this, _, window, cx| this.close_settings(window, cx))),
        )
}

const RAIL_WIDTH: f32 = 190.;
const RAIL_GUTTER: f32 = 8.;
const RAIL_ITEM_PADDING: f32 = 10.;

fn rail_tip_left(text_width: f32) -> Option<f32> {
    let item_width = RAIL_WIDTH - 2. * RAIL_GUTTER;
    (text_width > item_width - 2. * RAIL_ITEM_PADDING).then_some(item_width + RAIL_GUTTER)
}

fn rail(
    w: &Workspace,
    tabs: &[(String, String)],
    window: &Window,
    cx: &mut Context<Workspace>,
) -> Div {
    div()
        .w(px(RAIL_WIDTH))
        .flex_shrink_0()
        .py(px(4.))
        .px(px(RAIL_GUTTER))
        .flex()
        .flex_col()
        .children(tabs.iter().enumerate().map(|(at, (_, label))| {
            let selected = w.settings_tab == at;
            let mut run = window.text_style().to_run(label.len());
            run.font.family = theme::FONT.into();
            let width = window
                .text_system()
                .shape_line(label.clone().into(), px(theme::UI), &[run], None)
                .width();
            let tip_left = rail_tip_left(f32::from(width));
            div()
                .id(("settings-tab", at))
                .plain_control()
                .relative()
                .h(px(theme::ROW))
                .px(px(RAIL_ITEM_PADDING))
                .flex()
                .items_center()
                .rounded(px(6.))
                .when(selected, |s| s.bg(color("sunk")).text_color(color("ink")))
                .when(!selected, |s| s.text_color(color("ink-2")))
                .child(div().flex_1().min_w_0().truncate().child(label.clone()))
                .when_some(tip_left, |row, left| {
                    row.on_hover(cx.listener(move |this, hovering, _, cx| {
                        if *hovering {
                            this.settings_rail_tip = Some(at);
                        } else if this.settings_rail_tip == Some(at) {
                            this.settings_rail_tip = None;
                        }
                        cx.notify();
                    }))
                    .when(w.settings_rail_tip == Some(at), |row| {
                        row.child(
                            deferred(
                                div()
                                    .absolute()
                                    .left(px(left))
                                    .top_0()
                                    .child(ui::Tooltip(label.clone().into(), None).body()),
                            )
                            .with_priority(1),
                        )
                    })
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.settings_tab = at;
                    this.settings_entry = None;
                    this.settings_item = None;
                    this.settings_skill = None;
                    this.settings_memory = None;
                    this.settings_error = None;
                    this.settings_notice = None;
                    cx.notify();
                }))
        }))
}

fn body(w: &Workspace, tab: &str, window: &Window, cx: &mut Context<Workspace>) -> AnyElement {
    let content: AnyElement = match tab {
        "remote" => remote_tab(w, cx),
        "updates" => updates_tab(w, cx),
        _ => section_tab(w, tab, window, cx),
    };
    div()
        .id("settings-content")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(16.))
        .py(px(8.))
        .pb(px(16.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(content)
        .into_any_element()
}

fn section_tab(
    w: &Workspace,
    tab: &str,
    _window: &Window,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let snapshot = w.source.settings();
    let Some(snapshot) = snapshot.as_ref() else {
        return loading("Reading settings…").into_any_element();
    };
    let snapshot = match snapshot.as_ref() {
        Ok(snapshot) => snapshot,
        Err(message) => return error_row(message, w, cx).into_any_element(),
    };
    let views: Vec<&crate::settings::SettingView> = snapshot
        .settings
        .iter()
        .filter(|view| view.section == tab)
        .collect();
    if views.is_empty() && tab != "skills" {
        return loading("Nothing here.").into_any_element();
    }
    let mut out = div().flex().flex_col().gap(px(4.));
    let mut group = String::new();
    for view in views {
        if view.group.as_deref() != Some(group.as_str()) && view.group.is_some() {
            group = view.group.clone().unwrap_or_default();
            out = out.child(group_heading(&group));
        }
        if view.key == "remote.enabled" {
            out = out.child(match w.source.remote().as_deref() {
                Some(Ok(state)) => remote_status_row(w, state, cx),
                Some(Err(message)) => error_row(message, w, cx),
                None => loading("Reading remote access…"),
            });
        } else {
            out = out.child(setting_row(w, view, cx));
        }
        if view.key == "providers.harness.profiles" || view.key == "mcp.servers" {
            out = out.child(list_block(w, view, cx));
        }
    }
    if tab == "memory" {
        out = out.child(memory_manager(w, cx));
    }
    if tab == "skills" {
        out = out.child(skills_manager(w, cx));
    }
    out.into_any_element()
}

fn group_heading(group: &str) -> Div {
    div()
        .pt(px(10.))
        .pb(px(2.))
        .child(ui::caps(&crate::language::tr(group)))
}

fn loading(text: &str) -> Div {
    div()
        .py(px(12.))
        .text_color(color("ink-2"))
        .child(crate::language::tr(text).into_owned())
}

fn error_row(message: &str, w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .py(px(12.))
        .child(div().text_color(color("broken")).child(message.to_string()))
        .child(
            div()
                .id("settings-retry")
                .control("Read settings again")
                .child("Try again")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.source.read_settings();
                    cx.notify();
                })),
        )
        .when(w.source.settings_saving().is_some(), |s| {
            s.child(
                div()
                    .text_color(color("ink-2"))
                    .child(crate::language::message("guide.saving")),
            )
        })
}

/// One row of a section: label, description, value and where it comes from.
fn setting_row(
    w: &Workspace,
    view: &crate::settings::SettingView,
    cx: &mut Context<Workspace>,
) -> Div {
    let key = view.key.clone();
    let pending = w.source.settings_saving().as_deref() == Some(key.as_str());
    let mut row = div().flex().flex_col().py(px(6.));
    let control: AnyElement = match &view.kind {
        SettingKind::Enum(_) | SettingKind::Boolean => {
            let label = if pending {
                crate::language::message("guide.saving").to_owned()
            } else {
                setting_row_value(view)
            };
            div()
                .id(format!("settings-cycle-{key}"))
                .control(format!("Change {}", view.label))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .text_color(color(if pending { "ink-2" } else { "live" }))
                        .child(label),
                )
                .child(ui::icon("chevron-right", "ink-2"))
                .on_click(cx.listener(move |this, _, _, cx| this.cycle_setting(&key, cx)))
                .into_any_element()
        }
        SettingKind::Secret
        | SettingKind::Text { .. }
        | SettingKind::Integer { .. }
        | SettingKind::Duration
        | SettingKind::Line
        | SettingKind::Other(_) => {
            let label = setting_row_value(view);
            div()
                .id(format!("settings-edit-{key}"))
                .control(format!("Edit {}", view.label))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(12.5))
                        .text_color(color("ink-2"))
                        .child(label),
                )
                .child(ui::icon("pencil", "ink-2"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_scalar_form(&key, cx);
                }))
                .into_any_element()
        }
        SettingKind::List(_) => div().into_any_element(),
    };
    row = row.child(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .flex_1()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(setting_label(view)),
            )
            .child(control),
    );
    row.child(
        div()
            .text_color(color("ink-2"))
            .text_size(px(12.5))
            .line_height(px(16.))
            .child(crate::language::tr(&view.description).into_owned()),
    )
}

fn setting_label(view: &crate::settings::SettingView) -> String {
    crate::language::tr(&view.label).into_owned()
}

fn setting_row_value(view: &crate::settings::SettingView) -> String {
    if let (SettingKind::Enum(choices), SettingValue::Text(value)) = (&view.kind, &view.value)
        && let Some(choice) = choices.iter().find(|choice| choice.value == *value)
    {
        return crate::language::tr(&choice.label).into_owned();
    }
    settings::display_value(view)
}

fn sub_line(text: &str) -> Div {
    div()
        .text_color(color("ink-2"))
        .font_family(theme::MONO)
        .text_size(px(11.5))
        .child(text.to_string())
}

/// A list setting's entries: Harness profiles, MCP servers.
fn list_block(
    w: &Workspace,
    view: &crate::settings::SettingView,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let key = view.key.clone();
    let open = w.settings_entry.as_deref() == Some(key.as_str());
    if !open {
        let count = view.items.len();
        let noun = match &view.kind {
            SettingKind::List(schema) => schema.noun.clone(),
            _ => "entry".into(),
        };
        let label = if count == 0 {
            format!("Show {noun}s")
        } else {
            format!("{} — {count}", crate::language::tr(&view.label))
        };
        return div()
            .id(format!("settings-entries-{key}"))
            .control(format!("Show the {noun}s"))
            .h(px(theme::ROW))
            .px(px(10.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .child(div().flex_1().truncate().child(label))
            .child(ui::icon("chevron-right", "ink-2"))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.settings_entry = Some(key.clone());
                this.settings_item = None;
                cx.notify();
            }))
            .into_any_element();
    }
    let mut flat: Vec<AnyElement> = vec![];
    for item in &view.items {
        flat.push(entry_row(w, view, item, cx).into_any_element());
        if w.settings_item.as_deref() == Some(item.id.as_str()) {
            flat.push(entry_detail(w, view, item, cx).into_any_element());
        }
    }
    flat.push(
        div()
            .flex()
            .gap(px(8.))
            .pt(px(4.))
            .children(add_buttons(w, view, cx))
            .into_any_element(),
    );
    div().flex().flex_col().children(flat).into_any_element()
}

fn entry_row(
    w: &Workspace,
    view: &crate::settings::SettingView,
    item: &ListItem,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    let key = view.key.clone();
    let id = item.id.clone();
    let open = w.settings_item.as_deref() == Some(id.as_str());
    div()
        .id(format!("settings-entry-{key}-{id}"))
        .control(format!("Open {}", item.title))
        .py(px(6.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(item.title.clone()),
                )
                .when(open, |s| s.child(ui::icon("chevron-down", "ink-2")))
                .when(!open, |s| s.child(ui::icon("chevron-right", "ink-2"))),
        )
        .child(
            div()
                .text_color(color("ink-2"))
                .font_family(theme::MONO)
                .text_size(px(12.))
                .child(item.summary.clone()),
        )
        .when_some(item.status.clone(), |s, status| {
            s.child(
                div()
                    .text_color(color("broken"))
                    .text_size(px(12.5))
                    .child(status),
            )
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            this.settings_item = if this.settings_item.as_deref() == Some(id.as_str()) {
                None
            } else {
                Some(id.clone())
            };
            cx.notify();
        }))
}

/// Buttons under an open list: what the schema's `actions` allow, plus add.
fn add_buttons(
    _w: &Workspace,
    view: &crate::settings::SettingView,
    cx: &mut Context<Workspace>,
) -> Vec<AnyElement> {
    let key = view.key.clone();
    let mut buttons: Vec<AnyElement> = vec![];
    if key == "providers.harness.profiles" {
        let add = key.clone();
        buttons.push(
            small_button(
                ("settings-add-profile", 0),
                "Add profile…",
                "Add a Harness profile",
                cx.listener(move |this, _, window, cx| {
                    this.settings_profile_new = Some(ProfileWizard {
                        list_key: add.clone(),
                        ..Default::default()
                    });
                    this.settings_form = None;
                    this.settings_form_saving = false;
                    this.settings_error = None;
                    this.clear_settings_transients();
                    this.settings_input.update(cx, |input, cx| {
                        input.masked = false;
                        input.height = 44.;
                        input.placeholder = "";
                        input.set_text(String::new(), cx);
                        window.focus(&input.focus, cx);
                    });
                    cx.notify();
                }),
            )
            .into_any_element(),
        );
        buttons.push(
            small_button(
                ("settings-import-profile", 0),
                "Import…",
                "Add a profile from exported text",
                cx.listener(move |this, _, _, cx| {
                    this.open_settings_form(SettingsForm::Import, "", cx);
                }),
            )
            .into_any_element(),
        );
    }
    if key == "mcp.servers" {
        let add = key.clone();
        buttons.push(
            small_button(
                ("settings-add-mcp", 0),
                "Add server…",
                "Add an MCP server",
                cx.listener(move |this, _, _, cx| {
                    this.settings_mcp_new = Some(McpWizard {
                        list_key: add.clone(),
                        ..Default::default()
                    });
                    this.settings_form = None;
                    this.settings_error = None;
                    cx.notify();
                }),
            )
            .into_any_element(),
        );
    }
    buttons
}

fn small_button(
    id: (&'static str, usize),
    label: &str,
    tip: &str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .control(crate::language::tr(tip).into_owned())
        .h(px(28.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .border_1()
        .border_color(color("rule"))
        .text_color(color("ink-2"))
        .child(
            div()
                .flex()
                .items_center()
                .child(crate::language::tr(label).into_owned()),
        )
        .on_click(on_click)
}

/// One entry's fields, grouped like the schema says, with its probe and test answers.
fn entry_detail(
    w: &Workspace,
    view: &crate::settings::SettingView,
    item: &ListItem,
    cx: &mut Context<Workspace>,
) -> Div {
    let schema_fields = match &view.kind {
        SettingKind::List(schema) => schema.fields.clone(),
        _ => vec![],
    };
    let key = view.key.clone();
    let id = item.id.clone();
    let mut out = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .ml(px(8.))
        .pl(px(10.))
        .border_l_1()
        .border_color(color("rule"));
    let mut group = String::new();
    for schema in schema_fields.iter().filter(|schema| !schema.hidden) {
        let Some(field) = item.fields.iter().find(|field| field.path == schema.path) else {
            continue;
        };
        if !item.shows(schema) {
            continue;
        }
        if schema.group != group {
            group = schema.group.clone();
            if !group.is_empty() {
                let heading = crate::language::tr(&group).into_owned();
                out = out.child(div().pt(px(6.)).child(ui::caps(&heading)));
            }
        }
        out = out.child(field_row(w, view, schema, field, item, cx));
        if matches!(schema.kind, FieldKind::NestedList { .. }) {
            out = out.child(nested_block(w, &key, &id, schema, field, cx));
        }
    }
    if !item.resolved.is_empty() {
        out = out.child(
            div()
                .pt(px(6.))
                .child(ui::caps(crate::language::message("settings.inForce"))),
        );
        for row in &item.resolved {
            let (label, value) = resolved_row_text(row);
            out = out.child(
                div()
                    .flex()
                    .gap(px(8.))
                    .text_size(px(12.5))
                    .child(
                        div()
                            .w(px(120.))
                            .flex_shrink_0()
                            .text_color(color("ink-2"))
                            .child(label),
                    )
                    .child(div().flex_1().child(value)),
            );
        }
    }
    out = out.child(
        div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .pt(px(8.))
            .children(run_buttons(w, view, &id, cx)),
    );
    // The last test or probe of this entry, while it runs and after.
    if let Some(run) = w.source.harness_run() {
        let scope = if view.key == "mcp.servers" {
            "mcp"
        } else {
            "harness"
        };
        if run.matches(scope, &id) {
            out = out.child(run_line(&run));
        }
    }
    out
}

fn resolved_row_text(row: &settings::ResolvedRow) -> (String, String) {
    (
        crate::language::tr(&row.label).into_owned(),
        format!("{} — {}", row.value, crate::language::tr(&row.origin)),
    )
}

fn field_default_line(effective: &settings::ListEffective) -> String {
    let default = crate::language::message("settings.default");
    let origin = crate::language::tr(&effective.origin);
    if effective.value == SettingValue::Unset {
        format!("{default}: {origin}")
    } else {
        let value = settings::display_scalar(&effective.value);
        format!("{default}: {value}, {origin}")
    }
}

fn field_row(
    _w: &Workspace,
    view: &crate::settings::SettingView,
    schema: &ListFieldSchema,
    field: &ListFieldValue,
    item: &ListItem,
    cx: &mut Context<Workspace>,
) -> Div {
    let key = view.key.clone();
    let id = item.id.clone();
    let path = schema.path.clone();
    let title = schema.label.clone();
    let control: AnyElement = match &schema.kind {
        FieldKind::Enum(_) | FieldKind::Boolean | FieldKind::Effort => {
            let label = settings::display_field(field, Some(schema));
            div()
                .id(format!("settings-field-cycle-{key}-{id}-{path}"))
                .control(format!("Change {}", crate::language::tr(&schema.label)))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(div().text_color(color("live")).child(label))
                .child(ui::icon("chevron-right", "ink-2"))
                .on_click(cx.listener(move |this, _, _, cx| this.cycle_field(&key, &id, &path, cx)))
                .into_any_element()
        }
        FieldKind::NestedList { .. } => div()
            .text_color(color("ink-2"))
            .child("Below")
            .into_any_element(),
        _ => {
            let shown = settings::display_field(field, Some(schema));
            div()
                .id(format!("settings-field-edit-{key}-{id}-{path}"))
                .control(format!("Edit {}", crate::language::tr(&schema.label)))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(12.5))
                        .text_color(color("ink-2"))
                        .child(shown),
                )
                .child(ui::icon("pencil", "ink-2"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_field_form(&key, &id, &path, &title, cx);
                }))
                .into_any_element()
        }
    };
    div()
        .flex()
        .flex_col()
        .py(px(4.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .child(crate::language::tr(&schema.label).into_owned()),
                )
                .child(control),
        )
        .child(
            div()
                .text_color(color("ink-2"))
                .text_size(px(12.5))
                .line_height(px(16.))
                .child(crate::language::tr(&schema.description).into_owned()),
        )
        .when_some(field.effective.as_ref(), |s, effective| {
            s.child(sub_line(&field_default_line(effective)))
        })
}

fn nested_block(
    _w: &Workspace,
    key: &str,
    id: &str,
    schema: &ListFieldSchema,
    field: &ListFieldValue,
    cx: &mut Context<Workspace>,
) -> Div {
    let key = key.to_string();
    let id = id.to_string();
    let add = (key.clone(), id.clone());
    let mut out = div().flex().flex_col().gap(px(2.)).ml(px(8.));
    for nested in &field.items {
        let title = nested
            .fields
            .iter()
            .find(|entry| entry.path == "id")
            .map_or_else(
                || nested.id.clone(),
                |entry| settings::display_field(entry, nested_schema(schema, "id")),
            );
        let remove = (key.clone(), id.clone(), nested.id.clone());
        out = out.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(12.5))
                .child(div().flex_1().font_family(theme::MONO).child(title))
                .child(
                    div()
                        .id(format!(
                            "settings-remove-model-{}-{}-{}",
                            remove.0, remove.1, remove.2
                        ))
                        .control(format!("Remove {}", nested.id))
                        .text_color(color("ink-2"))
                        .child("Remove")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.confirm_settings(
                                format!("Remove “{}”?", remove.2),
                                "The entry keeps anything the model does not decide.".into(),
                                SettingsConfirm::RemoveModel {
                                    key: remove.0.clone(),
                                    profile: remove.1.clone(),
                                    model: remove.2.clone(),
                                },
                                cx,
                            );
                        })),
                ),
        );
    }
    out = out.child(
        div()
            .id(format!("settings-add-model-{}-{}", add.0, add.1))
            .control("Add a model")
            .text_color(color("ink-2"))
            .text_size(px(12.5))
            .child("+ Add model")
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open_settings_form(
                    SettingsForm::AddModel {
                        key: add.0.clone(),
                        profile: add.1.clone(),
                    },
                    "",
                    cx,
                );
            })),
    );
    out
}

fn nested_schema<'a>(schema: &'a ListFieldSchema, path: &str) -> Option<&'a ListFieldSchema> {
    match &schema.kind {
        FieldKind::NestedList { fields, .. } => fields.iter().find(|field| field.path == path),
        _ => None,
    }
}

/// Test, probe, duplicate, export and remove for one entry.
fn run_buttons(
    _w: &Workspace,
    view: &crate::settings::SettingView,
    id: &str,
    cx: &mut Context<Workspace>,
) -> Vec<AnyElement> {
    let key = view.key.clone();
    let id = id.to_string();
    let is_mcp = key == "mcp.servers";
    let mut buttons: Vec<AnyElement> = vec![];
    if !is_mcp {
        let run_id = id.clone();
        buttons.push(
            small_button(
                ("settings-test", 0),
                "Test",
                "One tiny request to the endpoint",
                cx.listener(move |this, _, _, cx| {
                    this.source.test_harness(&run_id, None);
                    cx.notify();
                }),
            )
            .into_any_element(),
        );
        let run_id = id.clone();
        buttons.push(
            small_button(
                ("settings-probe", 0),
                "Probe",
                "Run the probe battery; writes its findings",
                cx.listener(move |this, _, _, cx| {
                    this.source.probe_harness(&run_id, None);
                    cx.notify();
                }),
            )
            .into_any_element(),
        );
        let export_id = id.clone();
        buttons.push(
            small_button(
                ("settings-export", 0),
                "Export",
                "Share as a JSON document",
                cx.listener(move |this, _, _, cx| {
                    this.source.export_profile(&export_id);
                    cx.notify();
                }),
            )
            .into_any_element(),
        );
    } else {
        let run_id = id.clone();
        buttons.push(
            small_button(
                ("settings-test-mcp", 0),
                "Test",
                "Start the server and list its tools",
                cx.listener(move |this, _, _, cx| {
                    this.source.test_mcp(&run_id);
                    cx.notify();
                }),
            )
            .into_any_element(),
        );
    }
    let (duplicate_key, duplicate_id) = (key.clone(), id.clone());
    buttons.push(
        small_button(
            ("settings-duplicate", 0),
            "Duplicate",
            "Copy under a new name",
            cx.listener(move |this, _, _, cx| {
                this.open_settings_form(
                    SettingsForm::Duplicate {
                        key: duplicate_key.clone(),
                        id: duplicate_id.clone(),
                    },
                    &duplicate_id,
                    cx,
                );
            }),
        )
        .into_any_element(),
    );
    let (remove_key, remove_id) = (key.clone(), id.clone());
    buttons.push(
        small_button(
            ("settings-remove", 0),
            "Remove",
            "Delete this entry",
            cx.listener(move |this, _, _, cx| {
                this.confirm_settings(
                    format!("Remove “{}”?", remove_id),
                    "This cannot be undone.".into(),
                    SettingsConfirm::RemoveEntry {
                        key: remove_key.clone(),
                        id: remove_id.clone(),
                    },
                    cx,
                );
            }),
        )
        .into_any_element(),
    );
    buttons
}

fn run_line(run: &HarnessRun) -> Div {
    match run {
        HarnessRun::Running { kind, .. } => div()
            .text_color(color("ink-2"))
            .child(format!("{}…", capitalize(kind))),
        HarnessRun::Done {
            message, tools, ok, ..
        } => {
            let mut line = div().flex().flex_col().gap(px(2.));
            line = line.child(
                div()
                    .text_color(color(if *ok { "live" } else { "broken" }))
                    .child(message.clone()),
            );
            if !tools.is_empty() {
                line = line.child(sub_line(&format!("Tools: {}", tools.join(", "))));
            }
            line
        }
        HarnessRun::Failed { message, .. } => {
            div().text_color(color("broken")).child(message.clone())
        }
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

impl Workspace {
    fn open_scalar_form(&mut self, key: &str, cx: &mut Context<Self>) {
        let view = self
            .source
            .settings()
            .as_ref()
            .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
            .and_then(|snapshot| snapshot.find(key))
            .cloned();
        let Some(view) = view else { return };
        let secret = view.kind.is_secret();
        let multiline = matches!(view.kind, SettingKind::Text { multiline: true });
        // A stored key is never typed back: the form starts empty.
        let initial = if secret {
            String::new()
        } else {
            view.value.wire()
        };
        self.open_settings_form(
            SettingsForm::Scalar {
                key: key.into(),
                title: view.label.clone(),
                secret,
                multiline,
            },
            &initial,
            cx,
        );
    }

    fn open_field_form(
        &mut self,
        key: &str,
        id: &str,
        path: &str,
        title: &str,
        cx: &mut Context<Self>,
    ) {
        let field = self
            .source
            .settings()
            .as_ref()
            .and_then(|snapshot| snapshot.as_ref().as_ref().ok())
            .and_then(|snapshot| snapshot.find(key))
            .and_then(|view| {
                let schema = view.field_schema(path)?.clone();
                let item = view.items.iter().find(|item| item.id == id)?;
                let field = item.fields.iter().find(|field| field.path == path)?.clone();
                Some((schema, field))
            });
        let Some((schema, field)) = field else { return };
        let secret = schema.kind.is_secret();
        let multiline = matches!(schema.kind, FieldKind::Text)
            || matches!(schema.kind, FieldKind::Pairs { .. });
        // Secret pairs prefill the hint, not the input: `KEY=<hidden>` lines
        // keep the stored value, an empty answer clears the field.
        let (initial, previous) = if secret {
            (
                String::new(),
                settings::display_field(&field, Some(&schema)),
            )
        } else {
            (field.value.wire(), String::new())
        };
        self.open_settings_form(
            SettingsForm::Field {
                key: key.into(),
                id: id.into(),
                path: path.into(),
                title: title.into(),
                secret,
                multiline,
                previous,
            },
            &initial,
            cx,
        );
    }

    fn submit_wizard_text(&mut self, text: String, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if self.settings_memory_new.is_some() {
            self.submit_memory_wizard(text, cx);
        } else if self.settings_profile_new.is_some() {
            self.submit_profile_wizard(text, cx);
        } else if self.settings_mcp_new.is_some() {
            self.submit_mcp_wizard(text, cx);
        }
    }

    fn submit_memory_wizard(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(mut wizard) = self.settings_memory_new.clone() else {
            return;
        };
        match wizard.step {
            0 => {
                if text.is_empty() {
                    self.settings_error = Some("Type a name.".into());
                    return;
                }
                wizard.name = text;
                wizard.step = 1;
            }
            1 => {
                wizard.description = text;
                wizard.step = 2;
                self.settings_input.update(cx, |input, cx| {
                    input.height = 120.;
                    input.set_text(String::new(), cx);
                });
            }
            _ => {
                if text.is_empty() {
                    self.settings_error = Some("Type the memory.".into());
                    return;
                }
                wizard.body = text;
                let memory_type = MEMORY_TYPES[wizard.type_idx].0.to_string();
                let scope = if wizard.scoped {
                    "project".to_string()
                } else {
                    "global".to_string()
                };
                let thread = self.settings_thread();
                self.source.save_memory(
                    if wizard.scoped { thread } else { None },
                    MemoryDraft {
                        name: wizard.name.clone(),
                        description: wizard.description.clone(),
                        memory_type,
                        body: wizard.body.clone(),
                        scope,
                    },
                );
                self.settings_memory_new = None;
                self.settings_error = None;
                cx.notify();
                return;
            }
        }
        self.settings_error = None;
        self.settings_memory_new = Some(wizard);
        self.settings_input
            .update(cx, |input, cx| input.set_text(String::new(), cx));
        cx.notify();
    }

    fn submit_profile_wizard(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(mut wizard) = self.settings_profile_new.clone() else {
            return;
        };
        match wizard.step {
            0..=3 => {
                if let Err(message) = wizard.advance(text) {
                    self.settings_error = Some(message.into());
                    return;
                }
                if let Some((url, format, key)) = wizard.discovery_request() {
                    self.settings_discovered = None;
                    self.source.discover_models(url, format, key);
                }
            }
            _ => {
                let models = wizard_models(&text, self.settings_discovered.as_ref());
                match settings::profile_document(
                    &wizard.base_url,
                    PROFILE_FORMATS[wizard.format_idx],
                    &wizard.key_env,
                    &models,
                ) {
                    Err(message) => {
                        self.settings_error = Some(message);
                        return;
                    }
                    Ok(document) => {
                        let key = wizard.list_key.clone();
                        let id = wizard.id.clone();
                        self.source.set_setting(&format!("{key}[{id}]"), &document);
                        self.settings_error = None;
                        self.settings_form_saving = true;
                        cx.notify();
                        return;
                    }
                }
            }
        }
        self.settings_error = None;
        self.settings_profile_new = Some(wizard);
        self.settings_input
            .update(cx, |input, cx| input.set_text(String::new(), cx));
        cx.notify();
    }

    fn submit_mcp_wizard(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(mut wizard) = self.settings_mcp_new.clone() else {
            return;
        };
        match wizard.step {
            0 => {
                if text.is_empty() {
                    self.settings_error = Some("Type a name.".into());
                    return;
                }
                wizard.name = text.to_lowercase();
                wizard.step = 1;
            }
            _ => match settings::mcp_document(&text) {
                Err(message) => {
                    self.settings_error = Some(message);
                    return;
                }
                Ok(document) => {
                    let key = wizard.list_key.clone();
                    let name = wizard.name.clone();
                    self.source
                        .set_setting(&format!("{key}[{name}]"), &document);
                    self.settings_mcp_new = None;
                    self.settings_error = None;
                    self.settings_item = Some(name);
                    cx.notify();
                    return;
                }
            },
        }
        self.settings_error = None;
        self.settings_mcp_new = Some(wizard);
        self.settings_input
            .update(cx, |input, cx| input.set_text(String::new(), cx));
        cx.notify();
    }
}

fn panel_notice(text: String, error: bool) -> Div {
    div()
        .mx(px(16.))
        .mb(px(8.))
        .px(px(10.))
        .py(px(6.))
        .rounded(px(6.))
        .bg(color("sunk"))
        .text_size(px(12.5))
        .text_color(color(if error { "broken" } else { "ink-2" }))
        .child(text)
}

/// The form bar pinned under the panel: title, input, error and actions.
fn form_bar(w: &Workspace, form: &SettingsForm, cx: &mut Context<Workspace>) -> Div {
    let mut bar = div()
        .border_t_1()
        .border_color(color("rule"))
        .px(px(16.))
        .pt(px(10.))
        .pb(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(crate::language::tr(&form.title()).into_owned()),
        );
    if let SettingsForm::Field { previous, .. } = form
        && !previous.is_empty()
    {
        bar = bar.child(sub_line(&format!("Saved now: {previous}")));
    }
    if form.secret() {
        bar = bar.child(sub_line("Characters are hidden while typing."));
    }
    bar = bar.child(w.settings_input.clone());
    if let Some(error) = &w.settings_error {
        bar = bar.child(div().text_color(color("broken")).child(error.clone()));
    }
    bar.child(
        div()
            .flex()
            .gap(px(8.))
            .child(small_button(
                ("settings-save", 0),
                if w.settings_form_saving {
                    "Saving…"
                } else {
                    "Save"
                },
                "Write the value through the server",
                cx.listener(move |this, _, window, cx| {
                    let text = this.settings_input.read(cx).text().to_string();
                    this.submit_settings_text(text, window, cx);
                }),
            ))
            .child(small_button(
                ("settings-cancel", 0),
                "Cancel",
                "Close without saving",
                cx.listener(move |this, _, window, cx| this.close_settings_over(window, cx)),
            )),
    )
    .track_focus(&w.settings_focus)
    .key_context("SettingsForm")
}

fn confirm_bar(w: &Workspace, title: &str, detail: &str, cx: &mut Context<Workspace>) -> Div {
    div()
        .border_t_1()
        .border_color(color("rule"))
        .px(px(16.))
        .pt(px(10.))
        .pb(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color("broken"))
                .child(title.to_string()),
        )
        .when(!detail.is_empty(), |s| {
            s.child(
                div()
                    .text_color(color("ink-2"))
                    .text_size(px(12.5))
                    .child(detail.to_string()),
            )
        })
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(small_button(
                    ("settings-confirm", 0),
                    "Confirm",
                    title,
                    cx.listener(move |this, _, window, cx| {
                        this.submit_settings_confirm(window, cx)
                    }),
                ))
                .child(small_button(
                    ("settings-confirm-cancel", 0),
                    "Cancel",
                    "Close without doing it",
                    cx.listener(move |this, _, window, cx| this.close_settings_over(window, cx)),
                )),
        )
        .track_focus(&w.settings_focus)
        .key_context("SettingsForm")
}

fn memory_wizard_bar(w: &Workspace, wizard: &MemoryWizard, cx: &mut Context<Workspace>) -> Div {
    let step = match wizard.step {
        0 => "Name the memory".to_string(),
        1 => format!("Describe “{}”", wizard.name),
        _ => format!("Write “{}”", wizard.name),
    };
    let mut bar = wizard_shell(w, &step, true);
    if wizard.step == 2 {
        let type_idx = wizard.type_idx;
        bar = bar.child(div().flex().flex_wrap().gap(px(8.)).children(
            MEMORY_TYPES.iter().enumerate().map(|(at, (_, label))| {
                option_chip(
                    format!("settings-memory-type-{at}"),
                    label.to_string(),
                    at == type_idx,
                    cx.listener(move |this, _, _, cx| {
                        if let Some(wizard) = this.settings_memory_new.clone() {
                            this.settings_memory_new = Some(MemoryWizard {
                                type_idx: at,
                                ..wizard
                            });
                            cx.notify();
                        }
                    }),
                )
            }),
        ));
        let scoped = wizard.scoped;
        let has_thread = w.settings_thread().is_some();
        bar = bar.child(div().flex().gap(px(8.)).children(
            ["global", "project"].iter().enumerate().map(|(at, label)| {
                let on = (at == 1) == scoped;
                option_chip(
                    format!("settings-memory-scope-{at}"),
                    label.to_string(),
                    on,
                    cx.listener(move |this, _, _, cx| {
                        if !has_thread {
                            return;
                        }
                        if let Some(wizard) = this.settings_memory_new.clone() {
                            this.settings_memory_new = Some(MemoryWizard {
                                scoped: at == 1,
                                ..wizard
                            });
                            cx.notify();
                        }
                    }),
                )
            }),
        ));
    }
    bar.child(wizard_input_row("Create", "Create the memory", cx))
}

fn discovered_ids(found: &settings::Discovery) -> String {
    found
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn wizard_models(text: &str, discovery: Option<&settings::Discovery>) -> Vec<DiscoveredModel> {
    text.split([',', ' ', '\n'])
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| DiscoveredModel {
            id: id.into(),
            context_window: discovery.and_then(|found| {
                found
                    .models
                    .iter()
                    .find(|model| model.id == id)?
                    .context_window
            }),
        })
        .collect()
}

fn profile_wizard_bar(w: &Workspace, wizard: &ProfileWizard, cx: &mut Context<Workspace>) -> Div {
    let step = match wizard.step {
        0 => "Name the profile".to_string(),
        1 => format!("“{}” — the server's address", wizard.id),
        2 => "Which API does the server speak?".into(),
        3 => "The NAME of an environment variable holding the key (empty for none)".into(),
        _ => "Which models does it serve? (comma-separated)".into(),
    };
    let mut bar = wizard_shell(w, &step, wizard.step != 2);
    if wizard.step == 2 {
        let format_idx = wizard.format_idx;
        bar = bar.child(
            div().flex().flex_wrap().gap(px(8.)).children(
                ["Chat Completions", "OpenAI Responses", "Anthropic Messages"]
                    .iter()
                    .enumerate()
                    .map(|(at, label)| {
                        option_chip(
                            format!("settings-profile-format-{at}"),
                            label.to_string(),
                            at == format_idx,
                            cx.listener(move |this, _, _, cx| {
                                if let Some(wizard) = this.settings_profile_new.clone() {
                                    this.settings_profile_new = Some(ProfileWizard {
                                        format_idx: at,
                                        ..wizard
                                    });
                                    cx.notify();
                                }
                            }),
                        )
                    }),
            ),
        );
    }
    if wizard.step == 4 {
        if let Some(found) = &w.settings_discovered {
            let hint = match &found.error {
                Some(message) => format!("Discovery failed: {message}"),
                None => format!("Discovered: {}", discovered_ids(found)),
            };
            bar = bar.child(sub_line(&hint));
        } else {
            bar = bar.child(sub_line("Discovering the server's models…"));
        }
    }
    if wizard.step == 4 {
        bar.child(wizard_input_row(
            if w.settings_form_saving {
                "Saving…"
            } else {
                "Create"
            },
            "Save the profile",
            cx,
        ))
    } else {
        bar.child(wizard_input_row("Next", "Go to the next step", cx))
    }
}

fn mcp_wizard_bar(w: &Workspace, wizard: &McpWizard, cx: &mut Context<Workspace>) -> Div {
    let step = if wizard.step == 0 {
        "Name the server".to_string()
    } else {
        format!(
            "“{}” — an http(s) address, or a command with its arguments",
            wizard.name
        )
    };
    wizard_shell(w, &step, true).child(wizard_input_row("Next", "Go to the next step", cx))
}

fn wizard_shell(w: &Workspace, step: &str, with_input: bool) -> Div {
    div()
        .border_t_1()
        .border_color(color("rule"))
        .px(px(16.))
        .pt(px(10.))
        .pb(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(step.to_string()),
        )
        .when(with_input, |bar| bar.child(w.settings_input.clone()))
        .when_some(w.settings_error.clone(), |s, error| {
            s.child(div().text_color(color("broken")).child(error))
        })
}

fn wizard_input_row(label: &str, tip: &str, cx: &mut Context<Workspace>) -> Div {
    div()
        .flex()
        .gap(px(8.))
        .child(small_button(
            ("settings-wizard-next", 0),
            label,
            tip,
            cx.listener(move |this, _, window, cx| {
                let text = this.settings_input.read(cx).text().to_string();
                this.submit_settings_text(text, window, cx);
            }),
        ))
        .child(small_button(
            ("settings-wizard-cancel", 0),
            "Cancel",
            "Close without saving",
            cx.listener(move |this, _, window, cx| this.close_settings_over(window, cx)),
        ))
}

fn option_chip(
    id: String,
    label: String,
    on: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    div()
        .id(id)
        .control(label.clone())
        .h(px(28.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(14.))
        .border_1()
        .border_color(color(if on { "live" } else { "rule" }))
        .text_color(color(if on { "ink" } else { "ink-2" }))
        .child(label)
        .on_click(on_click)
        .into_any_element()
}

fn export_view(w: &Workspace, profile: &str, text: &str, cx: &mut Context<Workspace>) -> Div {
    let text = text.to_string();
    div()
        .border_t_1()
        .border_color(color("rule"))
        .px(px(16.))
        .pt(px(10.))
        .pb(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(format!("Exported “{profile}”")),
        )
        .child(sub_line("No saved key or probe results travel with it."))
        .child(
            div()
                .id("settings-export-text")
                .max_h(px(160.))
                .overflow_y_scroll()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .text_color(color("ink-2"))
                .child(text.clone()),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(small_button(
                    ("settings-copy-export", 0),
                    "Copy",
                    "Copy the document",
                    cx.listener(move |_, _, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                        cx.notify();
                    }),
                ))
                .child(small_button(
                    ("settings-export-close", 0),
                    "Close",
                    "Close the export",
                    cx.listener(move |this, _, window, cx| this.close_settings_over(window, cx)),
                )),
        )
        .track_focus(&w.settings_focus)
}

/// The memory manager: switches, search, list and detail.
fn memory_manager(w: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let mut out = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .pt(px(10.))
        .child(ui::caps("Memory manager"));
    if let Some(embeddings) = w.source.embeddings() {
        match embeddings.as_ref() {
            Ok(state) => {
                out = out.child(embeddings_row(w, state, cx));
            }
            Err(message) => {
                out = out.child(div().text_color(color("broken")).child(message.clone()));
            }
        }
    } else {
        out = out.child(sub_line("Reading the search engine…"));
    }
    out = out.child(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(div().flex_1().child(w.settings_find.clone()))
            .child(small_button(("settings-memory-new", 0), "New", "Save a memory", cx.listener(
                move |this, _, _, cx| {
                    this.settings_memory_new = Some(MemoryWizard::default());
                    this.settings_form = None;
                    this.settings_error = None;
                    this.settings_input.update(cx, |input, cx| {
                        input.masked = false;
                        input.height = 44.;
                        input.placeholder = "";
                        input.set_text(String::new(), cx);
                    });
                    cx.notify();
                },
            )))
            .child(small_button(("settings-memory-import", 0), "Import", "Copy Claude Code's auto memory in", cx.listener(
                move |this, _, _, cx| {
                    this.confirm_settings(
                        "Copy Claude Code's auto memory in?".into(),
                        "Only ever on request; Moxen keeps what it already has under the same name.".into(),
                        SettingsConfirm::ImportClaude,
                        cx,
                    );
                },
            ))),
    );
    if !w.settings_find.read(cx).text().trim().is_empty() {
        match w.source.memory_search() {
            None => {
                out = out.child(sub_line("Searching…"));
            }
            Some(search) => match search.as_ref() {
                Err(message) => {
                    out = out.child(div().text_color(color("broken")).child(message.clone()));
                }
                Ok(results) => {
                    if results.matches.is_empty() {
                        out = out.child(sub_line("Nothing matches."));
                    }
                    for hit in &results.matches {
                        out = out.child(memory_row(w, &hit.name, &hit.description, &hit.scope, cx));
                    }
                }
            },
        }
        return out.into_any_element();
    }
    match w.source.memories() {
        None => {
            out = out.child(sub_line("Reading memories…"));
        }
        Some(memories) => match memories.as_ref() {
            Err(message) => {
                out = out.child(div().text_color(color("broken")).child(message.clone()));
            }
            Ok(list) => {
                if list.memories.is_empty() {
                    out = out.child(sub_line(crate::language::message("mem.empty")));
                }
                for entry in &list.memories {
                    out = out.child(memory_row(
                        w,
                        &entry.name,
                        &entry.description,
                        &entry.scope,
                        cx,
                    ));
                }
                if let Some((name, scope)) = w.settings_memory.clone() {
                    out = out.child(memory_detail(w, &name, &scope, cx));
                }
            }
        },
    }
    out.into_any_element()
}

fn memory_row(
    w: &Workspace,
    name: &str,
    description: &str,
    scope: &str,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    let (name, scope) = (name.to_string(), scope.to_string());
    let description = description.to_string();
    let open = w
        .settings_memory
        .as_ref()
        .is_some_and(|(open, _)| open == &name);
    div()
        .id(format!("settings-memory-{name}-{scope}"))
        .control(format!("Open {name}"))
        .py(px(5.))
        .flex()
        .flex_col()
        .gap(px(1.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .font_family(theme::MONO)
                        .truncate()
                        .child(name.clone()),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.))
                        .text_color(color("ink-2"))
                        .child(scope.to_string()),
                )
                .child(ui::icon(
                    if open {
                        "chevron-down"
                    } else {
                        "chevron-right"
                    },
                    "ink-2",
                )),
        )
        .child(
            div()
                .text_color(color("ink-2"))
                .text_size(px(12.5))
                .truncate()
                .child(description.to_string()),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.settings_memory = if this
                .settings_memory
                .as_ref()
                .is_some_and(|(open, _)| open == &name)
            {
                None
            } else {
                Some((name.clone(), scope.clone()))
            };
            if let Some((name, scope)) = this.settings_memory.clone() {
                this.source
                    .read_memory(this.settings_thread(), &name, &scope);
            }
            cx.notify();
        }))
}

fn memory_detail(w: &Workspace, name: &str, scope: &str, cx: &mut Context<Workspace>) -> Div {
    let mut out = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .ml(px(8.))
        .pl(px(10.))
        .border_l_1()
        .border_color(color("rule"));
    let Some(detail) = w.source.memory_detail(name, scope) else {
        return out.child(sub_line("Reading…"));
    };
    match detail.as_ref() {
        Err(message) => {
            out = out.child(div().text_color(color("broken")).child(message.clone()));
        }
        Ok(entry) => {
            if let Some(body) = &entry.body {
                out = out.child(
                    div()
                        .id("settings-memory-body")
                        .max_h(px(200.))
                        .overflow_y_scroll()
                        .text_color(color("ink-2"))
                        .text_size(px(12.5))
                        .child(body.clone()),
                );
            }
            let (edit_name, edit_scope) = (name.to_string(), scope.to_string());
            let (append_name, append_scope) = (name.to_string(), scope.to_string());
            let (delete_name, delete_scope) = (name.to_string(), scope.to_string());
            out = out.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .child(small_button(
                        ("settings-memory-edit", 0),
                        "Edit",
                        "Replace the whole body",
                        cx.listener(move |this, _, _, cx| {
                            let body = this
                                .source
                                .memory_detail(&edit_name, &edit_scope)
                                .as_ref()
                                .and_then(|detail| detail.as_ref().as_ref().ok())
                                .and_then(|entry| entry.body.clone());
                            match body {
                                Some(body) => this.open_settings_form(
                                    SettingsForm::MemoryEdit {
                                        name: edit_name.clone(),
                                        scope: edit_scope.clone(),
                                        old: body.clone(),
                                    },
                                    &body,
                                    cx,
                                ),
                                None => {
                                    this.source.read_memory(
                                        this.settings_thread(),
                                        &edit_name,
                                        &edit_scope,
                                    );
                                    cx.notify();
                                }
                            }
                        }),
                    ))
                    .child(small_button(
                        ("settings-memory-append", 0),
                        "Append",
                        "Add text at the end",
                        cx.listener(move |this, _, _, cx| {
                            this.open_settings_form(
                                SettingsForm::MemoryAppend {
                                    name: append_name.clone(),
                                    scope: append_scope.clone(),
                                },
                                "",
                                cx,
                            );
                        }),
                    ))
                    .child(small_button(
                        ("settings-memory-delete", 0),
                        "Delete",
                        "Delete this memory",
                        cx.listener(move |this, _, _, cx| {
                            this.confirm_settings(
                                format!("Delete “{}”?", delete_name),
                                "This cannot be undone.".into(),
                                SettingsConfirm::DeleteMemory {
                                    name: delete_name.clone(),
                                    scope: delete_scope.clone(),
                                },
                                cx,
                            );
                        }),
                    )),
            );
        }
    }
    out
}

fn embeddings_row(_w: &Workspace, state: &Embeddings, cx: &mut Context<Workspace>) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .py(px(4.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().flex_1().child("Semantic search"))
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(state.line()),
                ),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .child(small_button(
                    ("settings-embeddings-setup", 0),
                    "Set up",
                    "Index memories for search",
                    cx.listener(move |this, _, _, cx| {
                        this.confirm_settings(
                            "Index memories for search?".into(),
                            "Downloads the engine on first run.".into(),
                            SettingsConfirm::SetupEmbeddings { all: false },
                            cx,
                        );
                    }),
                ))
                .child(small_button(
                    ("settings-embeddings-rebuild", 0),
                    "Rebuild",
                    "Re-index every memory",
                    cx.listener(move |this, _, _, cx| {
                        this.confirm_settings(
                            "Re-index every memory?".into(),
                            "Takes a while on a large store.".into(),
                            SettingsConfirm::RebuildEmbeddings { all: true },
                            cx,
                        );
                    }),
                ))
                .child(small_button(
                    ("settings-embeddings-unload", 0),
                    "Unload",
                    "Stop the engine",
                    cx.listener(move |this, _, _, cx| {
                        this.confirm_settings(
                            "Unload the search engine?".into(),
                            "Semantic search stops until it is set up again.".into(),
                            SettingsConfirm::UnloadEmbeddings,
                            cx,
                        );
                    }),
                )),
        )
        .when(state.busy, |s| {
            s.child(sub_line(&format!(
                "{}…",
                crate::language::capitalized(crate::language::message("run.state.working"))
            )))
        })
}

/// Skills management: the user and project skills, their switches and text.
fn skills_manager(w: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let mut out = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .pt(px(10.))
        .child(ui::caps("Skills manager"));
    match w.source.managed_skills() {
        None => {
            out = out.child(sub_line("Reading skills…"));
        }
        Some(skills) => match skills.as_ref() {
            Err(message) => {
                out = out.child(div().text_color(color("broken")).child(message.clone()));
            }
            Ok(skills) => {
                if skills.is_empty() {
                    out = out.child(sub_line("No skills."));
                }
                for skill in skills {
                    out = out.child(skill_row(w, skill, cx));
                }
                if let Some((source, folder)) = w.settings_skill.clone() {
                    out = out.child(skill_detail(w, &source, &folder, skills, cx));
                }
                out = out.child(
                    div().flex().flex_wrap().gap(px(8.)).pt(px(4.)).children(
                        [("agents", ".agents"), ("claude", "Claude")]
                            .iter()
                            .enumerate()
                            .map(|(at, (source, label))| {
                                let source = source.to_string();
                                let label = label.to_string();
                                small_button(
                                    ("settings-skill-import", at),
                                    &format!("Import into {label}"),
                                    "Copy a folder in as a skill",
                                    cx.listener(move |this, _, _, cx| {
                                        this.open_settings_form(
                                            SettingsForm::ImportSkill {
                                                source: source.clone(),
                                            },
                                            "",
                                            cx,
                                        );
                                    }),
                                )
                                .into_any_element()
                            }),
                    ),
                );
            }
        },
    }
    out.into_any_element()
}

fn skill_row(w: &Workspace, skill: &ManagedSkill, cx: &mut Context<Workspace>) -> Stateful<Div> {
    let (source, folder, enabled) = (skill.source.clone(), skill.folder.clone(), skill.enabled);
    let open = w
        .settings_skill
        .as_ref()
        .is_some_and(|(open_source, open_folder)| {
            open_source == &skill.source && open_folder == &skill.folder
        });
    div()
        .id(format!("settings-skill-{}-{}", skill.source, skill.folder))
        .control(format!("Open {}", skill.name))
        .py(px(5.))
        .flex()
        .flex_col()
        .gap(px(1.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(skill.name.clone()),
                )
                .child(
                    div()
                        .id(format!(
                            "settings-skill-toggle-{}-{}",
                            skill.source, skill.folder
                        ))
                        .control(if enabled {
                            "Switch the skill off"
                        } else {
                            "Switch the skill on"
                        })
                        .text_color(color(if enabled { "live" } else { "ink-2" }))
                        .child(if enabled {
                            crate::language::message("settings.on")
                        } else {
                            crate::language::message("settings.off")
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.source.set_skill_enabled(
                                this.settings_thread(),
                                &source,
                                &folder,
                                !enabled,
                            );
                            cx.notify();
                        })),
                )
                .child(ui::icon(
                    if open {
                        "chevron-down"
                    } else {
                        "chevron-right"
                    },
                    "ink-2",
                )),
        )
        .child(
            div()
                .text_color(color("ink-2"))
                .text_size(px(12.5))
                .truncate()
                .child(format!("{} · {}", skill.description, skill.path)),
        )
        .on_click(cx.listener({
            let (source, folder) = (skill.source.clone(), skill.folder.clone());
            let thread = w.settings_thread();
            move |this, _, _, cx| {
                let key = (source.clone(), folder.clone());
                this.settings_skill = if this.settings_skill.as_ref() == Some(&key) {
                    None
                } else {
                    Some(key)
                };
                if let Some((source, folder)) = this.settings_skill.clone() {
                    this.source.read_skill_text(thread, &source, &folder);
                }
                cx.notify();
            }
        }))
}

fn skill_detail(
    w: &Workspace,
    source: &str,
    folder: &str,
    skills: &[ManagedSkill],
    cx: &mut Context<Workspace>,
) -> Div {
    let mut out = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .ml(px(8.))
        .pl(px(10.))
        .border_l_1()
        .border_color(color("rule"));
    let Some(skill) = skills
        .iter()
        .find(|skill| skill.source == source && skill.folder == folder)
    else {
        return out.child(sub_line("Reading…"));
    };
    out = out.child(sub_line(&format!(
        "{}: {}",
        crate::language::tr("Providers"),
        providers_line(&skill.providers)
    )));
    out = out.child(div().flex().flex_wrap().gap(px(8.)).children(
        crate::settings::SKILL_PROVIDERS.iter().map(|(id, label)| {
            let on = skill.provider_on(id);
            let (toggle_source, toggle_folder) = (skill.source.clone(), skill.folder.clone());
            let providers = skill.toggle_provider(id);
            let editable = skill.editable;
            option_chip(
                format!("settings-skill-provider-{source}-{folder}-{id}"),
                label.to_string(),
                on,
                cx.listener(move |this, _, _, cx| {
                    if !editable {
                        return;
                    }
                    if let Some(providers) = &providers {
                        this.source.set_skill_providers(
                            this.settings_thread(),
                            &toggle_source,
                            &toggle_folder,
                            providers.clone(),
                        );
                        this.settings_notice = None;
                    } else {
                        this.settings_notice =
                            Some(("Keep at least one provider on.".into(), true));
                    }
                    cx.notify();
                }),
            )
        }),
    ));
    match w.source.skill_text(source, folder) {
        None => {
            out = out.child(sub_line("Reading the text…"));
        }
        Some(text) => match text.as_ref() {
            Err(message) => {
                out = out.child(div().text_color(color("broken")).child(message.clone()));
            }
            Ok(text) => {
                out = out.child(
                    div()
                        .id("settings-skill-text")
                        .max_h(px(200.))
                        .overflow_y_scroll()
                        .font_family(theme::MONO)
                        .text_size(px(12.))
                        .text_color(color("ink-2"))
                        .child(text.clone()),
                );
            }
        },
    }
    let (edit_source, edit_folder) = (skill.source.clone(), skill.folder.clone());
    let (remove_source, remove_folder, remove_name) = (
        skill.source.clone(),
        skill.folder.clone(),
        skill.name.clone(),
    );
    let editable = skill.editable;
    out.child(
        div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .when(editable, |s| {
                s.child(small_button(
                    ("settings-skill-edit", 0),
                    "Edit",
                    "Edit the skill's text",
                    cx.listener(move |this, _, _, cx| {
                        let previous = this
                            .source
                            .skill_text(&edit_source, &edit_folder)
                            .as_ref()
                            .and_then(|text| text.as_ref().as_ref().ok())
                            .cloned();
                        match previous {
                            Some(previous) => this.open_settings_form(
                                SettingsForm::SkillText {
                                    source: edit_source.clone(),
                                    folder: edit_folder.clone(),
                                    previous: previous.clone(),
                                },
                                &previous,
                                cx,
                            ),
                            None => {
                                this.source.read_skill_text(
                                    this.settings_thread(),
                                    &edit_source,
                                    &edit_folder,
                                );
                                cx.notify();
                            }
                        }
                    }),
                ))
            })
            .child(small_button(
                ("settings-skill-remove", 0),
                "Remove",
                "Delete this skill",
                cx.listener(move |this, _, _, cx| {
                    this.confirm_settings(
                        format!("Remove “{remove_name}”?"),
                        "This cannot be undone.".into(),
                        SettingsConfirm::RemoveSkill {
                            source: remove_source.clone(),
                            folder: remove_folder.clone(),
                        },
                        cx,
                    );
                }),
            )),
    )
}

fn providers_line(providers: &[String]) -> String {
    if providers.is_empty() {
        return "Every provider".into();
    }
    providers
        .iter()
        .map(|provider| match provider.as_str() {
            "claude" => "Claude Code",
            "codex" => "Codex",
            "opencode" => "OpenCode",
            "harness" => "Moxen Harness",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Remote access: status, pairing and devices.
fn remote_tab(w: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let mut out = div().flex().flex_col().gap(px(4.));
    let Some(remote) = w.source.remote() else {
        return out
            .child(loading("Reading remote access…"))
            .into_any_element();
    };
    match remote.as_ref() {
        Err(message) => {
            out = out.child(error_row(message, w, cx));
        }
        Ok(state) => {
            out = out.child(remote_status_row(w, state, cx));
            if state.available && state.enabled {
                out = out.child(pairing_block(w, state, cx));
                out = out.child(div().pt(px(6.)).child(ui::caps("Devices")));
                if state.devices.is_empty() {
                    out = out.child(sub_line("No paired devices."));
                }
                for device in &state.devices {
                    out = out.child(device_row(w, device, cx));
                }
            }
        }
    }
    out.into_any_element()
}

fn remote_status_row(w: &Workspace, state: &RemoteState, cx: &mut Context<Workspace>) -> Div {
    let enabled = state.enabled;
    let saving = w.source.settings_saving().as_deref() == Some("remote.enabled");
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .py(px(4.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .when(state.available, |row| {
                    row.child(
                        div()
                            .flex_1()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(crate::language::tr("Remote access").into_owned()),
                    )
                    .child(
                        div()
                            .id("settings-remote-toggle")
                            .control(if enabled {
                                crate::language::message("remote.turn_remote_access_off_bbaa")
                            } else {
                                crate::language::message("remote.turn_remote_access_on_7134")
                            })
                            .text_color(color(if enabled { "live" } else { "ink-2" }))
                            .child(if saving {
                                crate::language::message("guide.saving")
                            } else if enabled {
                                crate::language::message("settings.on")
                            } else {
                                crate::language::message("settings.off")
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.source.set_setting(
                                    "remote.enabled",
                                    if enabled { "false" } else { "true" },
                                );
                                cx.notify();
                            })),
                    )
                }),
        )
        .child(sub_line(&state.line()))
}

fn pairing_block(_w: &Workspace, state: &RemoteState, cx: &mut Context<Workspace>) -> Div {
    match &state.pairing {
        None => div().pt(px(4.)).child(small_button(
            ("settings-pair", 0),
            "Pair a device…",
            "Show a pairing code",
            cx.listener(move |this, _, _, cx| {
                this.source.pair_remote();
                cx.notify();
            }),
        )),
        Some(pairing) => div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .pt(px(4.))
            .child(ui::caps("Pairing code"))
            .child(
                div()
                    .font_family(theme::MONO)
                    .text_size(px(20.))
                    .child(pairing.code.clone()),
            )
            .child(sub_line(&format!(
                "Type it with one of: {}",
                pairing.addresses.join(", ")
            )))
            .child(small_button(
                ("settings-pair-cancel", 0),
                "Cancel",
                "Forget this code",
                cx.listener(move |this, _, _, cx| {
                    this.source.cancel_pairing();
                    cx.notify();
                }),
            )),
    }
}

fn device_row(
    _w: &Workspace,
    device: &crate::settings::RemoteDevice,
    cx: &mut Context<Workspace>,
) -> Div {
    let (id, name) = (device.id.clone(), device.name.clone());
    let connections = if device.connections == 0 {
        "idle".to_string()
    } else {
        format!(
            "{} {}",
            device.connections,
            if device.connections == 1 {
                "connection"
            } else {
                "connections"
            }
        )
    };
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .py(px(4.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().truncate().child(name.clone()))
                .child(sub_line(&connections)),
        )
        .child(
            div()
                .id(format!("settings-revoke-{id}"))
                .control(format!("Forget {name}"))
                .text_color(color("ink-2"))
                .child("Revoke")
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.confirm_settings(
                        format!("Forget “{name}”?"),
                        "The device will have to pair again.".into(),
                        SettingsConfirm::RevokeDevice { id: id.clone() },
                        cx,
                    );
                })),
        )
}

/// Updates: Moxen's own check and the provider updaters.
fn updates_tab(w: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let mut out = div().flex().flex_col().gap(px(4.));
    let Some(updates) = w.source.updates() else {
        return out
            .child(loading("Checking for updates…"))
            .into_any_element();
    };
    match updates.as_ref() {
        Err(message) => {
            out = out.child(error_row(message, w, cx));
        }
        Ok(state) => {
            out = out.child(div().pt(px(2.)).child(ui::caps("Moxen")));
            out = out.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().flex_1().child(state.line()))
                    .child(small_button(
                        ("settings-update-check", 0),
                        "Check",
                        "Ask GitHub again",
                        cx.listener(move |this, _, _, cx| {
                            this.source.read_updates();
                            cx.notify();
                        }),
                    )),
            );
            out = out.child(div().flex().child(small_button(
                ("settings-update-open", 0),
                crate::language::message("update.title"),
                crate::language::message("update.title"),
                cx.listener(|this, _, window, cx| {
                    this.close_settings(window, cx);
                    this.open_experience(crate::experience::Panel::Update, window, cx);
                }),
            )));
            out = out.child(
                div()
                    .pt(px(10.))
                    .child(ui::caps(&crate::language::tr("Providers"))),
            );
            for provider in &state.providers {
                out = out.child(provider_row(w, provider, cx));
            }
        }
    }
    out.into_any_element()
}

fn provider_row(
    _w: &Workspace,
    provider: &crate::settings::ProviderLatest,
    cx: &mut Context<Workspace>,
) -> Div {
    let label = match provider.id.as_str() {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        _ => provider.id.as_str(),
    };
    let newest = provider.latest.clone().unwrap_or_else(|| "unknown".into());
    let (update_id, update_label) = (provider.id.clone(), label.to_string());
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .py(px(4.))
        .child(div().flex_1().child(format!("{label} — newest {newest}")))
        .child(small_button(
            (
                "settings-provider-update",
                provider_index(provider.id.as_str()),
            ),
            "Update",
            "Run the provider's own updater on this machine",
            cx.listener(move |this, _, _, cx| {
                this.confirm_settings(
                    format!("Update {update_label}?"),
                    "Runs the provider's own updater on this machine.".into(),
                    SettingsConfirm::UpdateProvider {
                        provider: update_id.clone(),
                    },
                    cx,
                );
            }),
        ))
}

fn provider_index(id: &str) -> usize {
    match id {
        "claude" => 0,
        "codex" => 1,
        "opencode" => 2,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProfileWizard, RAIL_GUTTER, RAIL_WIDTH, rail_tip_left, setting_label, settings,
        wizard_models,
    };

    #[test]
    fn the_interface_offers_the_same_theme_as_the_tui() {
        let snapshot = crate::mock_settings::snapshot_fixture();
        assert_eq!(setting_label(snapshot.find("ui.theme").unwrap()), "Theme");
    }

    #[test]
    fn spanish_settings_rows_keep_configured_values_and_translate_typed_states() {
        use settings::{ListEffective, ResolvedRow, SettingValue};

        crate::language::apply(Some("es-ES"), None);
        let mut snapshot = crate::mock_settings::snapshot_fixture();
        crate::mock_settings::apply_set(&mut snapshot, "instructions", "Off");
        let instructions = snapshot.find("instructions").unwrap();
        assert_eq!(super::setting_row_value(instructions), "Off");
        assert_eq!(
            super::setting_row_value(snapshot.find("git.autoFetch").unwrap()),
            "Desactivado"
        );
        assert_eq!(
            super::setting_row_value(snapshot.find("updates.checkLatest").unwrap()),
            "Activado"
        );
        assert_eq!(
            super::setting_row_value(snapshot.find("model").unwrap()),
            "Por defecto"
        );
        assert_eq!(
            super::resolved_row_text(&ResolvedRow {
                label: "images".into(),
                value: "Off".into(),
                origin: "your override".into(),
            }),
            ("imágenes".into(), "Off — tu ajuste".into())
        );
        assert_eq!(
            super::field_default_line(&ListEffective {
                value: SettingValue::Text("Off".into()),
                origin: "your override".into(),
            }),
            "Por defecto: Off, tu ajuste"
        );

        let profiles = snapshot.find("providers.harness.profiles").unwrap();
        let item = &profiles.items[0];
        let field = |path| item.fields.iter().find(|field| field.path == path).unwrap();
        assert_eq!(
            super::field_default_line(field("slots").effective.as_ref().unwrap()),
            "Por defecto: 4, las Peticiones simultáneas del propio Moxen Harness"
        );
        let mut url = field("baseUrl").clone();
        url.value = SettingValue::Text("Off".into());
        assert_eq!(
            settings::display_field(&url, profiles.field_schema("baseUrl")),
            "Off"
        );
        assert_eq!(
            settings::display_field(field("apiKey"), profiles.field_schema("apiKey")),
            "Guardada en el llavero"
        );
    }

    #[test]
    fn rail_tip_appears_only_for_clipped_text_and_starts_beyond_the_rail() {
        assert_eq!(rail_tip_left(154.), None);
        assert!(rail_tip_left(154.1).unwrap() + RAIL_GUTTER >= RAIL_WIDTH);
    }

    #[test]
    fn profile_wizard_reaches_key_before_discovering_models() {
        let mut wizard = ProfileWizard::default();
        for (step, input) in ["Office", "https://models.example", "", "MODELS_KEY"]
            .into_iter()
            .enumerate()
        {
            assert_eq!(usize::from(wizard.step), step);
            assert!(wizard.discovery_request().is_none());
            if step == 2 {
                wizard.format_idx = 1;
            }
            wizard.advance(input.into()).expect("valid step");
        }
        assert_eq!(wizard.step, 4);
        assert_eq!(wizard.id, "office");
        assert_eq!(
            wizard.discovery_request(),
            Some((
                "https://models.example",
                "responses",
                Some("MODELS_KEY".into())
            ))
        );
        let found = settings::Discovery::from_json(&serde_json::json!({
            "ok": true, "models": [{"id": "large", "contextWindow": 131072}, {"id":"omitted"}],
        }));
        let models = wizard_models("large, manual", Some(&found));
        let document =
            settings::profile_document(&wizard.base_url, "responses", &wizard.key_env, &models)
                .unwrap();
        let document: serde_json::Value = serde_json::from_str(&document).unwrap();
        assert_eq!(document["apiKeyEnv"], "MODELS_KEY");
        assert_eq!(
            document["models"],
            serde_json::json!([{"id":"large","contextWindow":131072},{"id":"manual"}])
        );
    }
}
