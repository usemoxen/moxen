use crate::{
    catalog::{CatalogState, Selection},
    experience::{self, Memory, Panel, Update, list, string},
    language::{message as t, tr},
    settings::SettingKind,
    theme::{self, TypeScale, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::sync::Arc;

const STEPS: [(&str, &str); 6] = [
    ("guide.welcome", "guide.welcomeBody"),
    ("guide.appearance", "guide.appearanceBody"),
    ("guide.provider", "guide.providerBody"),
    ("guide.memory", "guide.memoryBody"),
    ("guide.tools", "guide.toolsBody"),
    ("guide.project", "guide.projectBody"),
];

impl Workspace {
    pub fn open_experience(&mut self, panel: Panel, window: &mut Window, cx: &mut Context<Self>) {
        self.palette_open = false;
        self.experience_ui.panel = Some(panel);
        self.experience_ui.history = false;
        self.experience_ui.confirm_rollback = false;
        match panel {
            Panel::Guide => {
                self.experience_ui.step = 0;
                self.experience_ui.folder = false;
                self.experience_ui.guide_started = Some(std::time::Instant::now());
                self.source.read_settings();
                self.source.read_diagnosis();
                self.source.read_provider_accounts();
            }
            Panel::Releases => self.experience_ui.release = 0,
            Panel::Problems => self.source.read_records(),
            Panel::Doctor => self.source.read_diagnosis(),
            Panel::Update => self.source.read_updates(),
        }
        window.focus(&self.experience_focus, cx);
        cx.notify();
    }

    pub fn close_experience(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.source.experience_saving() {
            return;
        }
        if self.experience_ui.history {
            self.experience_ui.history = false;
        } else if self.experience_ui.folder {
            self.experience_ui.folder = false;
            window.focus(&self.experience_focus, cx);
        } else {
            self.experience_ui.panel = None;
            window.focus(&self.sidebar_focus, cx);
        }
        cx.notify();
    }

    pub fn sync_experience(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.experience_ui.panel == Some(Panel::Guide)
            && !self.settings_open
            && let Some(Err(message)) = self.source.take_settings_write()
        {
            self.problem = Some(message);
        }
        let snapshot = self.source.experience();
        if let Some(Ok(snapshot)) = snapshot.as_deref() {
            if !self.experience_ui.offered {
                self.experience_ui.offered = true;
                if !experience::completed(snapshot)
                    && !self.settings_open
                    && self.experience_ui.panel.is_none()
                {
                    self.open_experience(Panel::Guide, window, cx);
                }
            }
            if !self.source.experience_saving() {
                self.experience_ui.memory = None;
                if std::mem::take(&mut self.experience_ui.finish) && experience::completed(snapshot)
                {
                    self.experience_ui.panel = None;
                    self.creating = true;
                    if self.new_project_id().is_none() {
                        self.new_scratch = true;
                    }
                    window.focus(&self.new_composer.read(cx).focus.clone(), cx);
                }
                if let Some(version) = self.experience_ui.mark_release.take()
                    && experience::seen(snapshot, &version)
                {
                    self.close_experience(window, cx);
                }
            }
        }
        if self.experience_ui.panel == Some(Panel::Problems) && self.source.records().is_empty() {
            self.close_experience(window, cx);
        }
    }

    fn browse_release(&mut self, delta: i32) {
        let snapshot = self.source.experience();
        let Some(Ok(snapshot)) = snapshot.as_deref() else {
            return;
        };
        let max = list(snapshot, "releases").len().saturating_sub(1);
        self.experience_ui.release = self
            .experience_ui
            .release
            .saturating_add_signed(delta as isize)
            .min(max);
    }

    fn mark_release(&mut self) {
        if self.source.experience_saving() {
            return;
        }
        let snapshot = self.source.experience();
        let Some(Ok(snapshot)) = snapshot.as_deref() else {
            return;
        };
        if let Some(release) = list(snapshot, "releases").get(self.experience_ui.release) {
            let version = string(release, "version");
            self.experience_ui.mark_release = Some(version.to_owned());
            self.source
                .update_experience(json!({"seenRelease":version}));
        }
    }

    fn guide_next(&mut self) {
        if self.source.experience_saving() {
            return;
        }
        if self.experience_ui.step + 1 == STEPS.len() {
            self.experience_ui.finish = true;
            self.source
                .update_experience(json!({"completeOnboarding":true}));
        } else {
            self.experience_ui.step += 1;
            self.experience_ui.folder = false;
            if self.experience_ui.step == 2 {
                self.source.read_diagnosis();
                self.source.read_provider_accounts();
            }
            if self.experience_ui.step == 3 {
                self.source.read_embeddings();
            }
        }
    }

    fn guide_settings(&mut self, section: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_settings(window, cx);
        self.settings_entry = match section {
            "provider:harness" => Some("providers.harness.profiles".into()),
            "provider:acp" => Some("providers.acp.agents".into()),
            "mcp" => Some("mcpServers".into()),
            _ => None,
        };
        self.settings_item = None;
        let group = match section {
            "provider:harness" => Some("Model servers"),
            "provider:acp" => Some("ACP agents"),
            _ => None,
        };
        self.select_settings_section(section, group);
    }

    pub fn add_guide_folder(&mut self, path: &str, cx: &mut Context<Self>) {
        let path = path.trim();
        let windows = path.as_bytes().get(1) == Some(&b':')
            && matches!(path.as_bytes().get(2), Some(b'\\' | b'/'));
        if path.is_empty()
            || !(std::path::Path::new(path).is_absolute()
                || path.starts_with('/')
                || path.starts_with("\\\\")
                || windows)
        {
            self.problem = Some(t("thread.enterServerPath").into());
            cx.notify();
            return;
        }
        self.source.add_guide_project(path.into());
        self.experience_ui.folder = false;
        cx.notify();
    }

    pub fn guide_motion(&self) -> String {
        self.source
            .settings()
            .as_deref()
            .and_then(|result| result.as_ref().ok())
            .and_then(|settings| settings.find("ui.backdrop"))
            .map_or_else(|| "animated".into(), |view| view.value.wire())
    }
}

pub fn panel_title(panel: Panel) -> &'static str {
    match panel {
        Panel::Guide => t("guide.open"),
        Panel::Releases => t("guide.changelog"),
        Panel::Problems => t("problems.modalTitle"),
        Panel::Doctor => {
            if crate::language::spanish() {
                "Diagnóstico"
            } else {
                "Doctor"
            }
        }
        Panel::Update => t("update.title"),
    }
}

fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    primary: bool,
    click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .when(!primary, |button| button.plain_control())
        .flex_shrink_0()
        .px(px(10.))
        .h(px(30.))
        .flex()
        .items_center()
        .rounded(px(theme::px_token("radius", "radius-md")))
        .border_1()
        .border_color(color(if primary { "live" } else { "rule" }))
        .text_color(color(if primary { "on-live" } else { "ink" }))
        .bg(color(if primary { "live" } else { "raised" }))
        .when(primary, |button| {
            button
                .cursor_pointer()
                .focusable()
                .tab_index(0)
                .hover(|style| style.bg(color("live").opacity(0.9)))
                .active(|style| style.bg(color("live").opacity(0.78)))
                .focus_visible(|style| {
                    let mut ring = theme::focus_ring();
                    ring[0].color = color("on-live");
                    style.shadow(ring)
                })
        })
        .child(label.into())
        .on_click(click)
}

/// A guide step control: a click runs `action`, and so does Enter while the
/// control is focused — mirroring the TUI, where Enter runs the focused
/// control. The panel's own Enter handler stays out of the way unless the
/// footer Continue/Start or the panel itself is focused (see
/// `guide_enter_advances`).
fn guide_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    primary: bool,
    cx: &mut Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + Clone + 'static,
) -> Stateful<Div> {
    let click = action.clone();
    let press = action;
    button(
        id,
        label,
        primary,
        cx.listener(move |w, _, window, cx| click(w, window, cx)),
    )
    .on_key_down(cx.listener(move |w, event: &KeyDownEvent, window, cx| {
        if event.keystroke.key == "enter" && !event.keystroke.modifiers.modified() {
            press(w, window, cx);
            cx.stop_propagation();
        }
    }))
}

/// Whether Enter on the guide step advances: only from the footer
/// Continue/Start or when nothing in the step holds focus. A focused step
/// control activates itself instead (see `guide_button`), so the panel must
/// not advance first on key-down.
fn guide_enter_advances(next_focused: bool, panel_focused: bool) -> bool {
    next_focused || panel_focused
}

fn row() -> Div {
    div().flex().items_center().gap(px(8.))
}
fn column() -> Div {
    div().flex().flex_col().gap(px(10.))
}
fn detail(text: impl Into<SharedString>) -> Div {
    div().text_color(color("ink-2")).child(text.into())
}

pub fn notices(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    let problems = w.source.records();
    let ids = problems
        .iter()
        .map(|row| row.key.clone())
        .collect::<Vec<_>>();
    let snapshot = w.source.experience();
    let unread = snapshot.as_deref().is_some_and(|snapshot| {
        snapshot
            .as_ref()
            .is_ok_and(|s| experience::completed(s) && experience::unread(s))
    });
    let mut bar = div();
    if !ids.is_empty() && ids != w.experience_ui.dismissed_problems {
        let title = t(if ids.len() == 1 {
            "problems.title.one"
        } else {
            "problems.title.other"
        })
        .replace("{count}", &ids.len().to_string());
        bar = bar.child(
            row()
                .px(px(18.))
                .py(px(4.))
                .bg(color("sunk"))
                .child(
                    div()
                        .text_color(color("held"))
                        .font_weight(FontWeight::BOLD)
                        .child(title),
                )
                .child(detail(problems[0].message.clone()).flex_1().truncate())
                .child(button(
                    "problems-detail",
                    t("problems.details"),
                    false,
                    cx.listener(|w, _, window, cx| w.open_experience(Panel::Problems, window, cx)),
                ))
                .child(button(
                    "problems-dismiss",
                    t("action.dismiss"),
                    false,
                    cx.listener(move |w, _, _, cx| {
                        w.experience_ui.dismissed_problems.clone_from(&ids);
                        cx.notify();
                    }),
                )),
        );
    }
    if unread {
        bar = bar.child(
            row()
                .px(px(18.))
                .py(px(4.))
                .bg(color("sunk"))
                .child(detail(t("guide.newRelease")).flex_1())
                .child(button(
                    "release-notice",
                    t("guide.openRelease"),
                    false,
                    cx.listener(|w, _, window, cx| w.open_experience(Panel::Releases, window, cx)),
                )),
        );
    }
    if w.source.restart_required() {
        bar = bar.child(
            row()
                .px(px(18.))
                .py(px(4.))
                .bg(color("sunk"))
                .child(
                    div()
                        .text_color(color("held"))
                        .flex_1()
                        .child(t("update.beforeInstall")),
                )
                .child(button(
                    "restart-notice",
                    t("update.title"),
                    false,
                    cx.listener(|w, _, window, cx| w.open_experience(Panel::Update, window, cx)),
                )),
        );
    }
    bar
}

pub fn render(w: &Workspace, panel: Panel, window: &Window, cx: &mut Context<Workspace>) -> Div {
    let title = if panel == Panel::Guide {
        t(STEPS[w.experience_ui.step].0)
    } else if panel == Panel::Releases && w.experience_ui.history {
        t("guide.releaseHistory")
    } else {
        panel_title(panel)
    };
    let width = (f32::from(window.viewport_size().width) - 56.).clamp(360., 820.);
    let height = (f32::from(window.viewport_size().height) - 100.)
        .clamp(300., if panel == Panel::Guide { 600. } else { 540. });
    let (body, footer) = match panel {
        Panel::Guide => guide(w, cx),
        Panel::Releases => releases(w, cx),
        Panel::Problems => (records(w, cx), row()),
        Panel::Doctor => (
            doctor(w),
            row().child(button(
                "doctor-refresh",
                tr("Refresh").into_owned(),
                false,
                cx.listener(|w, _, _, cx| {
                    w.source.read_diagnosis();
                    cx.notify();
                }),
            )),
        ),
        Panel::Update => update(w, cx),
    };
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(color("ground").opacity(0.68))
        .when(panel == Panel::Guide && w.guide_motion() != "off", |s| {
            s.child(guide_field(w))
        })
        .child(
            column()
                .id("experience-panel")
                .track_focus(&w.experience_focus)
                .occlude()
                .w(px(width))
                .h(px(height))
                .p(px(22.))
                .rounded(px(theme::px_token("radius", "radius-lg")))
                .bg(color("raised"))
                .shadow(theme::float_shadow())
                .on_key_down(cx.listener(move |w, event: &KeyDownEvent, window, cx| {
                    if w.settings_open || w.experience_ui.folder || w.source.experience_saving() {
                        return;
                    }
                    match (panel, event.keystroke.key.as_str()) {
                        (Panel::Guide, "[") => {
                            w.experience_ui.step = w.experience_ui.step.saturating_sub(1)
                        }
                        (Panel::Guide, "]") if w.experience_ui.step + 1 < STEPS.len() => {
                            w.guide_next()
                        }
                        (Panel::Guide, "down") => window.focus_next(cx),
                        (Panel::Guide, "up") => window.focus_prev(cx),
                        (Panel::Releases, "left") if !w.experience_ui.history => {
                            w.browse_release(-1)
                        }
                        (Panel::Releases, "right") if !w.experience_ui.history => {
                            w.browse_release(1)
                        }
                        (Panel::Releases, "h") => {
                            w.experience_ui.history = !w.experience_ui.history
                        }
                        (Panel::Releases, "up") if w.experience_ui.history => w.browse_release(-1),
                        (Panel::Releases, "down") if w.experience_ui.history => w.browse_release(1),
                        (Panel::Releases, "enter") if w.experience_focus.is_focused(window) => {
                            if w.experience_ui.history {
                                w.experience_ui.history = false;
                            } else {
                                w.mark_release();
                            }
                        }
                        (Panel::Guide, "enter") => {
                            // The TUI runs the focused control on Enter: a
                            // focused step control activates itself (see
                            // `guide_button`), so Enter advances only from
                            // the footer Continue/Start or when nothing in
                            // the step holds focus. Advancing moves focus to
                            // the panel, so the focused Continue does not
                            // also click itself on key-up.
                            if guide_enter_advances(
                                w.guide_next_focus.is_focused(window),
                                w.experience_focus.is_focused(window),
                            ) {
                                w.guide_next();
                                window.focus(&w.experience_focus, cx);
                            }
                        }
                        (Panel::Update, "c") => w.source.check_app_update(),
                        (Panel::Update, "u") if w.can_update(false) => w.source.apply_update(),
                        (Panel::Update, "r") if w.can_update(true) => w.confirm_rollback(),
                        _ => return,
                    }
                    cx.notify();
                    cx.stop_propagation();
                }))
                .child(
                    row()
                        .justify_between()
                        .child(div().type_scale("title").child(title))
                        .child(button(
                            "experience-close",
                            if panel == Panel::Guide {
                                t("guide.later")
                            } else {
                                crate::language::desktop("Close", "Cerrar")
                            },
                            false,
                            cx.listener(|w, _, window, cx| w.close_experience(window, cx)),
                        )),
                )
                .child(
                    column()
                        .id("experience-body")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .py(px(6.))
                        .child(body),
                )
                .when_some(w.problem.clone(), |s, error| {
                    s.child(div().text_color(color("broken")).child(error))
                })
                .child(
                    footer
                        .flex_shrink_0()
                        .pt(px(8.))
                        .border_t_1()
                        .border_color(color("rule")),
                ),
        )
}

fn guide_field(w: &Workspace) -> Div {
    let step = w.experience_ui.step;
    let phase = if w.guide_motion() == "animated" {
        w.experience_ui
            .guide_started
            .map_or(0., |at| at.elapsed().as_secs_f32())
    } else {
        12.
    };
    let tint = color(["live", "label-2", "label-1", "label-4", "added", "label-6"][step]);
    div().absolute().inset_0().child(
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                let width = f32::from(bounds.size.width);
                let height = f32::from(bounds.size.height);
                let segments = 144;
                let stride = width / segments as f32;
                let pulse = (phase * 0.15).fract();
                for line in 0..STEPS.len() {
                    for part in 0..segments {
                        let u = part as f32 / segments as f32;
                        let y = height
                            * (0.1
                                + line as f32 * 0.145
                                + step as f32 * 0.02
                                + (u * 4. + line as f32 * 0.6 + phase * 0.06 + step as f32 * 0.7)
                                    .sin()
                                    * 0.05);
                        let gain = if line == step {
                            0.3 + (-((u - pulse) * 10.).powi(2)).exp() * 0.28
                        } else {
                            0.10
                        };
                        window.paint_quad(fill(
                            Bounds::new(
                                bounds.origin + point(px(u * width), px(y)),
                                size(px(stride), px(2.)),
                            ),
                            tint.opacity(gain),
                        ));
                    }
                }
            },
        )
        .size_full(),
    )
}

fn guide(w: &Workspace, cx: &mut Context<Workspace>) -> (Div, Div) {
    let step = w.experience_ui.step;
    let saving = w.source.experience_saving();
    let mut body = column().child(detail(t(STEPS[step].1)));
    match step {
        0 => {
            body = body
                .child(
                    div()
                        .max_w(px(550.))
                        .whitespace_normal()
                        .child(t("guide.welcomeDetail")),
                )
                .child(
                    column().children(
                        [
                            ("guide.previewAppearance", "live"),
                            ("guide.previewMemory", "label-4"),
                            ("guide.previewTools", "added"),
                        ]
                        .into_iter()
                        .map(|(key, token)| {
                            row()
                                .child(div().text_color(color(token)).child("✦"))
                                .child(t(key))
                        }),
                    ),
                )
        }
        1 => {
            if let Some(Ok(settings)) = w.source.settings().as_deref() {
                for key in ["ui.theme", "ui.backdrop", "ui.language"] {
                    let Some(setting) = settings.find(key) else {
                        continue;
                    };
                    let SettingKind::Enum(choices) = &setting.kind else {
                        continue;
                    };
                    let chosen = setting.value.wire();
                    let values = Arc::new(
                        choices
                            .iter()
                            .map(|choice| choice.value.clone())
                            .collect::<Vec<_>>(),
                    );
                    body = body.child(
                        column()
                            .child(
                                div()
                                    .font_weight(FontWeight::BOLD)
                                    .child(tr(&setting.label).into_owned()),
                            )
                            .child(row().flex_wrap().children(choices.iter().map(|choice| {
                                let value = choice.value.clone();
                                let values = values.clone();
                                guide_button(
                                    format!("guide-{key}-{value}"),
                                    tr(&choice.label).into_owned(),
                                    chosen == value,
                                    cx,
                                    move |w, _, cx| {
                                        if !w.source.experience_saving() {
                                            w.source.set_setting(key, &value);
                                            cx.notify();
                                        }
                                    },
                                )
                                .on_key_down(cx.listener(
                                    move |w, event: &KeyDownEvent, _, cx| {
                                        let delta = match event.keystroke.key.as_str() {
                                            "left" => -1,
                                            "right" => 1,
                                            _ => return,
                                        };
                                        if w.source.experience_saving() {
                                            return;
                                        }
                                        let setting = w.source.settings();
                                        let current = setting
                                            .as_deref()
                                            .and_then(|snapshot| snapshot.as_ref().ok())
                                            .and_then(|snapshot| snapshot.find(key))
                                            .map(|view| view.value.wire());
                                        let index = values
                                            .iter()
                                            .position(|value| Some(value) == current.as_ref())
                                            .unwrap_or(0);
                                        let next = (index as isize + delta)
                                            .rem_euclid(values.len() as isize)
                                            as usize;
                                        w.source.set_setting(key, &values[next]);
                                        cx.notify();
                                        cx.stop_propagation();
                                    },
                                ))
                            }))),
                    );
                }
            }
            body = body.child(detail(t("guide.selectControl")));
        }
        2 => body = body.child(model_choices(w, cx)),
        3 => {
            for (index, (label, explanation, choice)) in [
                ("guide.memoryOff", "guide.memoryOffBody", Memory::Off),
                ("guide.memoryPlain", "guide.memoryPlainBody", Memory::Plain),
                (
                    "guide.embeddingsShort",
                    "guide.memoryEmbeddingsBody",
                    Memory::Embeddings,
                ),
            ]
            .into_iter()
            .enumerate()
            {
                body = body.child(
                    row()
                        .child(guide_button(
                            ("guide-memory", index),
                            t(label),
                            memory_mode(w) == choice,
                            cx,
                            move |w, _, cx| {
                                if !w.source.experience_saving() {
                                    w.experience_ui.memory = Some(choice);
                                    w.source.set_guide_memory(choice);
                                    w.source.read_embeddings();
                                    cx.notify();
                                }
                            },
                        ))
                        .child(
                            detail(t(explanation))
                                .flex_1()
                                .min_w_0()
                                .whitespace_normal(),
                        ),
                );
            }
            if let Some(Ok(state)) = w.source.embeddings().as_deref()
                && (memory_mode(w) == Memory::Embeddings || state.busy || state.state == "failed")
            {
                let phase = match state.phase.as_str() {
                    "installing" => "memory.phase.installing",
                    "downloading" => "memory.phase.downloading",
                    "validating" => "memory.phase.validating",
                    "indexing" => "memory.phase.indexing",
                    _ => "memory.phase.idle",
                };
                let line = if state.busy || saving {
                    t(phase).to_owned()
                } else {
                    state.line()
                };
                body = body.child(
                    column()
                        .p(px(12.))
                        .bg(color("sunk"))
                        .child(div().font_weight(FontWeight::BOLD).child(t("memory.title")))
                        .child(
                            row()
                                .child(detail(line))
                                .when_some(state.percent, |s, percent| {
                                    s.child(detail(format!("{percent:.0}%")))
                                }),
                        )
                        .when(state.busy || saving, |s| {
                            s.child(row().child(guide_button(
                                "guide-memory-cancel",
                                t("memory.cancel"),
                                false,
                                cx,
                                |w, _, cx| {
                                    w.source.unload_embeddings();
                                    cx.notify();
                                },
                            )))
                        }),
                );
            }
            body = body.child(detail(t("guide.memoryControl")));
        }
        4 => {
            body = body.child(detail(t("guide.mcpExamples")));
            if let Some(Ok(settings)) = w.source.settings().as_deref()
                && let Some(view) = settings.find("mcpServers")
            {
                for item in &view.items {
                    let id = item.id.clone();
                    body = body.child(
                        row()
                            .child(guide_button(
                                format!("guide-mcp-{id}"),
                                id.clone(),
                                false,
                                cx,
                                move |w, window, cx| {
                                    w.guide_settings("mcp", window, cx);
                                    w.settings_item = Some(id.clone());
                                },
                            ))
                            .child(detail(t("guide.connectedConfig"))),
                    );
                }
            }
            body = body
                .child(row().child(guide_button(
                    "guide-mcp",
                    t("guide.addMcp"),
                    false,
                    cx,
                    |w, window, cx| w.guide_settings("mcp", window, cx),
                )))
                .child(detail(t("guide.optionalTools")))
        }
        _ => {
            body = body
                .child(detail(t("guide.chooseProject")))
                .child(
                    row()
                        .flex_wrap()
                        .child(guide_button(
                            "guide-scratch",
                            t("guide.noProjectChoice"),
                            w.new_scratch,
                            cx,
                            |w, _, cx| {
                                w.new_project = None;
                                w.new_scratch = true;
                                cx.notify();
                            },
                        ))
                        .children(w.source.projects().into_iter().map(|project| {
                            let chosen =
                                w.new_project.as_deref() == Some(&project.id) && !w.new_scratch;
                            guide_button(
                                format!("guide-project-{}", project.id),
                                project.title,
                                chosen,
                                cx,
                                move |w, _, cx| {
                                    w.new_project = Some(project.id.clone());
                                    w.new_scratch = false;
                                    cx.notify();
                                },
                            )
                        })),
                )
                .child(detail(t("guide.scratchProject")))
                .child(row().child(guide_button(
                    "guide-folder",
                    t("guide.addFolder"),
                    false,
                    cx,
                    |w, window, cx| {
                        if w.source.paired_name().is_some() {
                            w.experience_ui.folder = true;
                            window.focus(&w.guide_folder.read(cx).focus.clone(), cx);
                        } else {
                            let picked = cx.prompt_for_paths(PathPromptOptions {
                                files: false,
                                directories: true,
                                multiple: false,
                                prompt: Some(t("guide.addFolder").into()),
                            });
                            cx.spawn(async move |this, cx| {
                                if let Ok(Ok(Some(paths))) = picked.await
                                    && let Some(path) = paths.first()
                                {
                                    this.update(cx, |w, cx| {
                                        w.add_guide_folder(&path.to_string_lossy(), cx)
                                    })
                                    .ok();
                                }
                            })
                            .detach();
                            // The picker answers later: leave the step, so the
                            // focused button does not also click itself on key-up.
                            window.focus(&w.experience_focus, cx);
                        }
                        cx.notify();
                    },
                )))
                .when(w.experience_ui.folder, |s| s.child(w.guide_folder.clone()))
                .child(detail(
                    t("guide.readySummary")
                        .replace(
                            "{model}",
                            w.new_model
                                .as_ref()
                                .map_or(t("guide.noModel"), |model| model.model.as_str()),
                        )
                        .replace(
                            "{memory}",
                            t(match memory_mode(w) {
                                Memory::Off => "guide.memoryOff",
                                Memory::Plain => "guide.memoryPlain",
                                Memory::Embeddings => "guide.embeddingsShort",
                            }),
                        ),
                ));
        }
    }
    let progress = t("guide.progress")
        .replace("{n}", &(step + 1).to_string())
        .replace("{total}", &STEPS.len().to_string());
    let footer = row()
        .child(detail(progress).flex_1())
        .when(step > 0, |s| {
            s.child(guide_button(
                "guide-back",
                t("guide.back"),
                false,
                cx,
                |w, window, cx| {
                    if !w.source.experience_saving() {
                        w.experience_ui.step = w.experience_ui.step.saturating_sub(1);
                        w.experience_ui.folder = false;
                        window.focus(&w.experience_focus, cx);
                        cx.notify();
                    }
                },
            ))
        })
        .child(
            button(
                "guide-next",
                t(if saving {
                    "guide.saving"
                } else if step + 1 == STEPS.len() {
                    "guide.finish"
                } else {
                    "guide.next"
                }),
                true,
                cx.listener(|w, _, _, cx| {
                    w.guide_next();
                    cx.notify();
                }),
            )
            .track_focus(&w.guide_next_focus),
        );
    (body, footer)
}

fn memory_mode(w: &Workspace) -> Memory {
    if let Some(choice) = w.experience_ui.memory {
        return choice;
    }
    if let Some(Ok(settings)) = w.source.settings().as_deref() {
        let reading = |key| settings.find(key).map(|view| view.value.wire());
        if reading("memory").as_deref() == Some("false") {
            return Memory::Off;
        }
        if reading("memoryEmbeddings").as_deref() == Some("true") {
            return Memory::Embeddings;
        }
    }
    Memory::Plain
}

fn guide_cli_status(diagnosis: Option<&Value>, key: &str) -> String {
    let Some(entry) = diagnosis.and_then(|d| d.get("providers")).and_then(|p| p.get(key)) else {
        return t("guide.cliNotInstalledHint").into();
    };
    if entry.get("installed").and_then(Value::as_bool) != Some(true) {
        return t("guide.cliNotInstalledHint").into();
    }
    let version = string(entry, "version");
    if version.is_empty() {
        t("guide.cliInstalledReady").into()
    } else {
        t("guide.cliInstalledVersion").replace("{version}", version)
    }
}

fn model_choices(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    let catalog = w.source.catalog();
    let diagnosis = w.source.diagnosis();
    let diag_val = diagnosis.as_deref().and_then(|res| res.as_ref().ok());
    let accounts: Vec<crate::settings::ProviderAccountSummary> = match w.source.provider_accounts().as_deref() {
        Some(Ok(list)) => list.clone(),
        _ => vec![],
    };
    let opencode_enabled = w
        .source
        .settings()
        .as_deref()
        .and_then(|res| res.as_ref().ok())
        .and_then(|snap| snap.find("providers.opencode.enabled"))
        .is_some_and(|view| view.value == crate::settings::SettingValue::Flag(true));
    let vibe_enabled = w
        .source
        .settings()
        .as_deref()
        .and_then(|res| res.as_ref().ok())
        .and_then(|snap| snap.find("providers.vibe.enabled"))
        .is_some_and(|view| view.value == crate::settings::SettingValue::Flag(true));

    let has_providers = matches!(catalog, CatalogState::Ready(ref cat) if !cat.providers.is_empty());
    let claude_added = accounts.iter().any(|a| a.kind == "claude")
        || matches!(catalog, CatalogState::Ready(ref cat) if cat.providers.iter().any(|p| p.driver == "claudeAgent"));
    let chatgpt_account = accounts.iter().find(|a| a.kind == "chatgpt" && a.signed_in == Some(true));
    let chatgpt_added = chatgpt_account.is_some()
        || matches!(catalog, CatalogState::Ready(ref cat) if cat.providers.iter().any(|p| p.driver == "chatgpt" && p.enabled));
    let opencode_added = opencode_enabled
        || matches!(catalog, CatalogState::Ready(ref cat) if cat.providers.iter().any(|p| p.driver == "opencode"));
    let antigravity_added = accounts.iter().any(|a| a.kind == "antigravity")
        || matches!(catalog, CatalogState::Ready(ref cat) if cat.providers.iter().any(|p| p.driver == "antigravity"));
    let vibe_added = vibe_enabled
        || matches!(catalog, CatalogState::Ready(ref cat) if cat.providers.iter().any(|p| p.driver == "vibe"));

    let mut setup_row = |id: &'static str, label: String, added: bool, note: String, action: Box<dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)>| {
        let action = Arc::new(action);
        let run = action.clone();
        row()
            .child(guide_button(
                id,
                label,
                added,
                cx,
                move |w, window, cx| run(w, window, cx),
            ))
            .child(detail(note).flex_1().min_w_0().whitespace_normal())
    };

    let setup_card = column()
        .p(px(12.))
        .gap(px(6.))
        .bg(color("sunk"))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .child(ui::caps(t("guide.setupHeading")))
        .child(setup_row(
            "guide-setup-claude",
            t("guide.addClaude").into(),
            claude_added,
            if claude_added {
                t("guide.providerAdded").into()
            } else {
                guide_cli_status(diag_val, "claude")
            },
            Box::new(move |w, _, cx| {
                if !claude_added {
                    w.source.save_provider_account(json!({
                        "kind": "claude",
                        "id": "default",
                        "label": "Default",
                    }));
                    w.experience_ui.provider = Some("claude/default".into());
                    w.source.refresh_catalog();
                    cx.notify();
                }
            }),
        ))
        .child(setup_row(
            "guide-setup-chatgpt",
            t("guide.signInChatGpt").into(),
            chatgpt_added,
            if let Some(email) = chatgpt_account.and_then(|a| a.email.as_deref()) {
                t("settings.providers.authenticatedAs").replace("{email}", email)
            } else if chatgpt_added {
                t("guide.providerAdded").into()
            } else {
                t("guide.chatGptDetail").into()
            },
            Box::new(move |w, _, cx| {
                if !chatgpt_added {
                    w.source.start_chatgpt_login("default", Some("Default"));
                    w.experience_ui.provider = Some("chatgpt/default".into());
                    cx.notify();
                }
            }),
        ))
        .child(setup_row(
            "guide-setup-opencode",
            t("guide.enableOpencode").into(),
            opencode_added,
            if opencode_added {
                t("guide.providerEnabled").into()
            } else {
                guide_cli_status(diag_val, "opencode")
            },
            Box::new(move |w, _, cx| {
                if !opencode_added {
                    w.source.set_setting("providers.opencode.enabled", "true");
                    w.source.refresh_catalog();
                    cx.notify();
                }
            }),
        ))
        .child(setup_row(
            "guide-setup-antigravity",
            t("guide.addAntigravity").into(),
            antigravity_added,
            if antigravity_added {
                t("guide.providerAdded").into()
            } else {
                guide_cli_status(diag_val, "antigravity")
            },
            Box::new(move |w, _, cx| {
                if !antigravity_added {
                    w.source.save_provider_account(json!({
                        "kind": "antigravity",
                        "id": "default",
                        "label": "Default",
                    }));
                    w.experience_ui.provider = Some("antigravity/default".into());
                    w.source.refresh_catalog();
                    cx.notify();
                }
            }),
        ))
        .child(setup_row(
            "guide-setup-vibe",
            t("guide.enableVibe").into(),
            vibe_added,
            if vibe_added {
                t("guide.providerEnabled").into()
            } else {
                guide_cli_status(diag_val, "vibe")
            },
            Box::new(move |w, _, cx| {
                if !vibe_added {
                    w.source.set_setting("providers.vibe.enabled", "true");
                    w.experience_ui.provider = Some("vibe".into());
                    w.source.refresh_catalog();
                    cx.notify();
                }
            }),
        ));

    let input = |composer| {
        div()
            .rounded(px(theme::px_token("radius", "radius-md")))
            .bg(color("sunk"))
            .child(composer)
    };
    let mut provider_pane = column()
        .w(px(236.))
        .flex_shrink_0()
        .child(ui::caps(t("guide.providersLabel")))
        .child(input(w.guide_provider_filter.clone()));
    let mut model_pane = column()
        .flex_1()
        .min_w_0()
        .child(ui::caps(t("guide.modelsNav")))
        .child(input(w.guide_model_filter.clone()));
    let mut status = None;
    if let CatalogState::Ready(catalog) = catalog {
        let query = w.guide_provider_filter.read(cx).text().to_lowercase();
        let filter_models = w.guide_model_filter.read(cx).text().to_lowercase();
        let selected = w
            .experience_ui
            .provider
            .as_deref()
            .or_else(|| w.new_model.as_ref().map(|model| model.instance.as_str()));
        let provider = selected
            .and_then(|instance| catalog.provider(instance))
            .or_else(|| {
                catalog
                    .providers
                    .iter()
                    .find(|provider| provider.enabled && provider.installed)
            })
            .or_else(|| catalog.providers.first());
        let providers = catalog
            .providers
            .iter()
            .filter(|provider| {
                provider.name.to_lowercase().contains(&query)
                    || provider.instance.to_lowercase().contains(&query)
            })
            .collect::<Vec<_>>();
        if providers.is_empty() {
            provider_pane = provider_pane.child(detail(t("guide.noProvidersMatch")));
        }
        provider_pane = provider_pane.children(providers.iter().map(|candidate| {
            let id = candidate.instance.clone();
            guide_button(
                format!("guide-provider-{id}"),
                candidate.name.clone(),
                provider.is_some_and(|provider| provider.instance == id),
                cx,
                move |w, _, cx| {
                    w.experience_ui.provider = Some(id.clone());
                    w.guide_model_filter
                        .update(cx, |input, cx| input.set_text(String::new(), cx));
                    cx.notify();
                },
            )
        }));
        if let Some(provider) = provider {
            status = Some(provider.status.clone().unwrap_or_else(|| {
                t(if provider.installed {
                    "guide.cliDetected"
                } else {
                    "guide.cliMissing"
                })
                .into()
            }));
            let models = provider
                .models
                .iter()
                .filter(|model| {
                    (!model.hidden
                        || w.new_model.as_ref().is_some_and(|selected| {
                            selected.instance == provider.instance && selected.model == model.slug
                        }))
                        && (model.name.to_lowercase().contains(&filter_models)
                            || model.slug.to_lowercase().contains(&filter_models))
                })
                .collect::<Vec<_>>();
            if models.is_empty() {
                model_pane = model_pane.child(detail(t("guide.noModelsMatch")));
            }
            let ready = provider.installed && provider.enabled;
            model_pane = model_pane.child(row().flex_wrap().children(
                models.into_iter().enumerate().map(|(i, model)| {
                    let selection = Selection {
                        instance: provider.instance.clone(),
                        model: model.slug.clone(),
                        options: vec![],
                    };
                    let picked = w
                        .new_model
                        .as_ref()
                        .is_some_and(|selected| selected.same_as(&selection));
                    guide_button(
                        ("guide-model", i),
                        model.name.clone(),
                        picked,
                        cx,
                        move |w, _, cx| {
                            if ready {
                                w.new_model = Some(selection.clone());
                                cx.notify();
                            }
                        },
                    )
                }),
            ));
        }
    }
    let mut out = column().child(setup_card);
    if has_providers {
        out = out.child(row().items_start().child(provider_pane).child(model_pane));
    } else {
        out = out.child(detail(t("guide.noProvidersYet")));
    }
    out.child(
        row()
            .flex_wrap()
            .when(has_providers, |r| {
                r.child(guide_button(
                    "guide-provider-refresh",
                    t("guide.refreshProviders"),
                    false,
                    cx,
                    |w, _, cx| {
                        w.source.refresh_catalog();
                        cx.notify();
                    },
                ))
            })
            .child(guide_button(
                "guide-harness",
                t("guide.addModelServer"),
                false,
                cx,
                |w, window, cx| w.guide_settings("provider:harness", window, cx),
            ))
            .child(guide_button(
                "guide-acp",
                t("guide.addAcpAgent"),
                false,
                cx,
                |w, window, cx| w.guide_settings("provider:acp", window, cx),
            )),
    )
    .when_some(status, |s, status| s.child(detail(status)))
    .child(detail(t("guide.loginHint")))
}

fn words(value: &Value) -> String {
    value[if crate::language::spanish() {
        "es"
    } else {
        "en"
    }]
    .as_str()
    .or_else(|| value["en"].as_str())
    .unwrap_or_default()
    .into()
}

fn releases(w: &Workspace, cx: &mut Context<Workspace>) -> (Div, Div) {
    let snapshot = w.source.experience();
    let mut body = column();
    let footer = row()
        .child(detail(t("guide.changelogKeys")).flex_1())
        .child(button(
            "release-history",
            t("guide.releaseHistory"),
            false,
            cx.listener(|w, _, _, cx| {
                w.experience_ui.history = !w.experience_ui.history;
                cx.notify();
            }),
        ))
        .child(button(
            "release-later",
            t("guide.later"),
            false,
            cx.listener(|w, _, window, cx| w.close_experience(window, cx)),
        ))
        .child(button(
            "release-read",
            t("guide.markRead"),
            true,
            cx.listener(|w, _, _, cx| {
                w.mark_release();
                cx.notify();
            }),
        ));
    let Some(Ok(snapshot)) = snapshot.as_deref() else {
        return (
            body.child(t("guide.unavailable")).when_some(
                snapshot.as_deref().and_then(|answer| answer.as_ref().err()),
                |s, error| s.child(detail(error.clone())),
            ),
            footer,
        );
    };
    let entries = list(snapshot, "releases");
    if w.experience_ui.history {
        body = body.children(entries.iter().enumerate().map(|(index, release)| {
            let version = string(release, "version");
            let status = if experience::seen(snapshot, version) {
                t("guide.read")
            } else {
                t("guide.unread")
            };
            button(
                ("release-choice", index),
                format!("{version} · {} · {status}", words(&release["title"])),
                w.experience_ui.release == index,
                cx.listener(move |w, _, _, cx| {
                    w.experience_ui.release = index;
                    w.experience_ui.history = false;
                    cx.notify();
                }),
            )
        }));
    } else if let Some(entry) = entries.get(w.experience_ui.release) {
        let version = string(entry, "version");
        let status = if experience::seen(snapshot, version) {
            t("guide.read")
        } else {
            t("guide.unread")
        };
        let position = t("guide.releasePosition")
            .replace("{n}", &(w.experience_ui.release + 1).to_string())
            .replace("{total}", &entries.len().to_string());
        body = body
            .child(
                row()
                    .child(button(
                        "release-prev",
                        "←",
                        false,
                        cx.listener(|w, _, _, cx| {
                            w.browse_release(-1);
                            cx.notify();
                        }),
                    ))
                    .child(detail(format!("{version} · {status} · {position}")))
                    .child(button(
                        "release-next",
                        "→",
                        false,
                        cx.listener(|w, _, _, cx| {
                            w.browse_release(1);
                            cx.notify();
                        }),
                    )),
            )
            .child(
                div()
                    .font_weight(FontWeight::BOLD)
                    .text_size(px(20.))
                    .child(words(&entry["title"])),
            );
        for (index, highlight) in list(entry, "highlights").iter().enumerate() {
            let route = match string(highlight, "action") {
                "onboarding" => Some(None),
                "memory" => Some(Some("memory")),
                "mcp" => Some(Some("mcp")),
                _ => None,
            };
            body = body.child(
                column()
                    .gap(px(4.))
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .child(words(&highlight["title"])),
                    )
                    .child(detail(words(&highlight["body"])))
                    .when_some(route, |s, route| {
                        s.child(row().child(button(
                            ("release-try", index),
                            t("guide.tryFeature"),
                            false,
                            cx.listener(move |w, _, window, cx| {
                                if let Some(section) = route {
                                    w.guide_settings(section, window, cx);
                                } else {
                                    w.open_experience(Panel::Guide, window, cx);
                                }
                            }),
                        )))
                    }),
            );
        }
        if !list(entry, "sections").is_empty() {
            body = body.child(ui::caps(t("guide.allChangesHeading")));
            for section in list(entry, "sections") {
                body = body.child(
                    column()
                        .gap(px(4.))
                        .child(
                            div()
                                .font_weight(FontWeight::BOLD)
                                .child(words(&section["title"])),
                        )
                        .children(
                            list(section, "entries")
                                .iter()
                                .map(|entry| detail(format!("• {}", words(entry)))),
                        ),
                );
            }
        }
    } else {
        body = body.child(t("guide.unavailable"));
    }
    (body, footer)
}

fn records(w: &Workspace, cx: &mut Context<Workspace>) -> Div {
    column().children(
        w.source
            .records()
            .into_iter()
            .enumerate()
            .map(|(index, record)| {
                let file = record.file;
                column()
                    .p(px(12.))
                    .gap(px(6.))
                    .bg(color("sunk"))
                    .rounded(px(theme::px_token("radius", "radius-md")))
                    .child(div().font_weight(FontWeight::BOLD).child(record.message))
                    .child(detail(record.location).font_family(theme::MONO))
                    .child(
                        row()
                            .when_some(record.fix, |s, fix| {
                                s.child(button(
                                    ("problem-fix", index),
                                    t(fix.label()),
                                    false,
                                    cx.listener(move |w, _, _, cx| {
                                        w.source.fix_record(fix.clone());
                                        cx.notify();
                                    }),
                                ))
                            })
                            .child(button(
                                ("problem-copy", index),
                                t("problems.copyPath"),
                                false,
                                move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(file.clone()))
                                },
                            )),
                    )
            }),
    )
}

fn doctor(w: &Workspace) -> Div {
    let diagnosis = w.source.diagnosis();
    let Some(diagnosis) = diagnosis.as_deref() else {
        return column().child(detail(tr("Loading…").into_owned()));
    };
    let diagnosis = match diagnosis {
        Ok(value) => value,
        Err(error) => return column().child(detail(error.clone())),
    };
    let line = |label: &str, value: &Value, message: &str| {
        row()
            .child(
                div()
                    .w(px(16.))
                    .text_color(color(if value["ok"] == true { "added" } else { "held" }))
                    .child(if value["ok"] == true { "✓" } else { "!" }),
            )
            .child(
                div()
                    .w(px(150.))
                    .font_weight(FontWeight::BOLD)
                    .child(label.to_owned()),
            )
            .child(detail(message.to_owned()))
    };
    let mut out = column()
        .child(line(
            &tr("Runtime"),
            &diagnosis["node"],
            string(&diagnosis["node"], "version"),
        ))
        .child(line(&tr("Git"), &diagnosis["git"], ""));
    for (id, label) in [
        ("claude", "Claude Code"),
        ("opencode", "OpenCode"),
        ("codex", "Codex"),
        ("antigravity", "Antigravity"),
        ("vibe", "Mistral Vibe"),
    ] {
        let provider = &diagnosis["providers"][id];
        if !provider.is_null() {
            let status = provider["version"]
                .as_str()
                .unwrap_or_else(|| string(provider, "login"));
            out = out.child(line(label, provider, status));
        }
    }
    out.child(line(
        &tr("Store"),
        &diagnosis["store"],
        string(&diagnosis["store"], "path"),
    ))
    .child(line(
        &tr("Authentication"),
        &diagnosis["auth"],
        string(&diagnosis["auth"], "path"),
    ))
}

fn update(w: &Workspace, cx: &mut Context<Workspace>) -> (Div, Div) {
    let mut body = column();
    let state = w.source.app_update();
    let updates = w.source.updates();
    let check = updates.as_deref().and_then(|result| result.as_ref().ok());
    let remote = w.source.paired_name();
    if let Some(remote) = remote.as_deref() {
        body = body.child(detail(t("update.remoteNote").replace("{server}", remote)));
    }
    if let Some(check) = check {
        if let Some(current) = &check.current {
            let kind = t(if check.install_kind.as_deref() == Some("release") {
                "update.kind.release"
            } else {
                "update.kind.source"
            });
            body = body.child(detail(format!(
                "{}: {current} · {kind}",
                t("update.installed")
            )));
        }
        if let Some(latest) = &check.latest {
            body = body.child(detail(format!("{}: {latest}", t("update.available"))));
        }
    }
    let mut footer = row();
    match state {
        Some(Update::Running {
            rollback, progress, ..
        }) => {
            body = body.child(t(if rollback {
                "update.runningRollback"
            } else {
                "update.running"
            }));
            let stages: &[(&str, &str)] = if rollback {
                &[
                    ("testing", "update.stage.testing"),
                    ("switching", "update.stage.switching"),
                ]
            } else {
                &[
                    ("checking", "update.stage.checking"),
                    ("downloading", "update.stage.downloading"),
                    ("verifying", "update.stage.verifying"),
                    ("unpacking", "update.stage.unpacking"),
                    ("testing", "update.stage.testing"),
                    ("switching", "update.stage.switching"),
                ]
            };
            let stage = string(&progress, "stage");
            let index = stages
                .iter()
                .position(|(name, _)| *name == stage)
                .unwrap_or(if stage == "done" { stages.len() } else { 0 });
            body = body
                .children(stages.iter().enumerate().map(|(at, (_, label))| {
                    let (mark, tone) = if at < index {
                        ("✓", "added")
                    } else if at == index {
                        ("●", "live")
                    } else {
                        ("○", "ink-2")
                    };
                    row()
                        .child(div().w(px(16.)).text_color(color(tone)).child(mark))
                        .child(detail(t(label)))
                }))
                .when_some(
                    progress["bytes"]
                        .as_u64()
                        .zip(progress["total"].as_u64())
                        .filter(|(_, total)| *total > 0),
                    |s, (bytes, total)| {
                        let share = (bytes as f32 / total as f32).clamp(0., 1.);
                        s.child(
                            div()
                                .h(px(6.))
                                .w_full()
                                .rounded(px(3.))
                                .bg(color("sunk"))
                                .child(
                                    div()
                                        .h_full()
                                        .w(relative(share))
                                        .rounded(px(3.))
                                        .bg(color("live")),
                                ),
                        )
                    },
                )
                .child(detail(t("update.keepsGoing")));
        }
        Some(Update::Finished { rollback, result }) => {
            let current = string(&result, "version");
            let unchanged = string(&result, "action") == "already-current";
            let key = if unchanged {
                "update.alreadyCurrent"
            } else if rollback {
                "update.rolledBack"
            } else {
                "update.installedNow"
            };
            body = body
                .child(
                    t(key)
                        .replace("{version}", current)
                        .replace("{from}", string(&result, "from")),
                )
                .when(!unchanged, |s| s.child(detail(t("update.restartNote"))))
                .children(
                    list(&result, "warnings")
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|warning| detail(t("update.warning").replace("{warning}", warning))),
                );
        }
        Some(Update::Failed { message, .. }) => {
            body = body
                .child(div().text_color(color("broken")).child(message.clone()))
                .child(detail(t("update.untouched")))
        }
        Some(Update::Lost) => {
            body = body
                .child(t("update.lost"))
                .child(detail(t("update.lostHint")))
        }
        None => {
            let line = match check.and_then(|check| check.status.as_deref()) {
                Some("up-to-date") => t("update.upToDate").into(),
                Some("available") => t("update.availableNow").into(),
                Some("no-release") => t("update.noRelease").into(),
                Some(_) => t("update.unavailable").replace(
                    "{reason}",
                    check
                        .and_then(|check| check.reason.as_deref())
                        .unwrap_or_else(|| t("update.unknownReason")),
                ),
                None => updates
                    .as_deref()
                    .and_then(|result| result.as_ref().err())
                    .map_or_else(
                        || t("update.checking").into(),
                        |error| t("update.unreachable").replace("{message}", error),
                    ),
            };
            body = body.child(line);
            if let Some(check) = check
                && check.status.as_deref() == Some("available")
            {
                if !check.updatable && remote.is_none() {
                    body = body.child(detail(t(
                        if check.install_kind.as_deref() == Some("source") {
                            "update.sourceNote"
                        } else {
                            "update.noArchive"
                        },
                    )));
                }
                if let Some(notes) = &check.release_notes {
                    body = body
                        .child(ui::caps(t("update.notes")))
                        .child(detail(notes.clone()));
                }
            }
        }
    }
    let running = matches!(w.source.app_update(), Some(Update::Running { .. }));
    if !running {
        footer = footer.child(button(
            "update-check",
            t("update.check"),
            false,
            cx.listener(|w, _, _, cx| {
                w.source.check_app_update();
                cx.notify();
            }),
        ));
        if let Some(check) = check
            && (w.can_update(true) || w.can_update(false))
        {
            body = body.child(detail(t("update.beforeInstall")));
            if w.can_update(false)
                && let Some(latest) = &check.latest
            {
                footer = footer.child(button(
                    "update-install",
                    t("update.install").replace("{version}", latest),
                    true,
                    cx.listener(|w, _, _, cx| {
                        w.source.apply_update();
                        cx.notify();
                    }),
                ));
            }
            body = body.when(w.experience_ui.confirm_rollback, |s| {
                s.child(detail(t("update.rollbackConfirm")))
            });
            footer = footer.when(w.can_update(true), |s| {
                s.child(button(
                    "update-rollback",
                    t(if w.experience_ui.confirm_rollback {
                        "update.rollbackSure"
                    } else {
                        "update.rollback"
                    }),
                    false,
                    cx.listener(|w, _, _, cx| {
                        w.confirm_rollback();
                        cx.notify();
                    }),
                ))
            });
        }
    }
    (body, footer)
}

impl Workspace {
    fn can_update(&self, rollback: bool) -> bool {
        let updates = self.source.updates();
        let check = updates.as_deref().and_then(|result| result.as_ref().ok());
        crate::experience::can_update(
            self.source.paired_name().is_some(),
            check.and_then(|check| check.install_kind.as_deref()),
            check.is_some_and(|check| check.updatable),
            check.is_some_and(|check| check.status.as_deref() == Some("available")),
            self.source.app_update().as_ref(),
            rollback,
        )
    }

    fn confirm_rollback(&mut self) {
        if !self.can_update(true) {
            return;
        }
        if std::mem::replace(&mut self.experience_ui.confirm_rollback, true) {
            self.source.rollback_update();
            self.experience_ui.confirm_rollback = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{guide_cli_status, guide_enter_advances};
    use serde_json::json;

    #[test]
    fn enter_on_a_focused_guide_control_does_not_advance() {
        // A focused step control activates itself; only the footer
        // Continue/Start or the panel itself advances the guide.
        assert!(!guide_enter_advances(false, false));
        assert!(guide_enter_advances(true, false));
        assert!(guide_enter_advances(false, true));
        assert!(guide_enter_advances(true, true));
    }

    #[test]
    fn guide_cli_status_reports_detected_version_or_missing_hint() {
        let diag = json!({
            "providers": {
                "claude": { "installed": true, "version": "2.1.330" },
                "opencode": { "installed": false, "version": null },
            }
        });
        assert!(guide_cli_status(Some(&diag), "claude").contains("2.1.330"));
        assert!(guide_cli_status(Some(&diag), "opencode").contains("not installed"));
        assert!(guide_cli_status(None, "antigravity").contains("not installed"));
    }
}
