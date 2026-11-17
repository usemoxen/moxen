use crate::{
    model::{Message, Status, ThreadAction, ThreadId},
    theme::color,
    ui::Control,
    workspace::Workspace,
};
use gpui::{prelude::*, *};

actions!(thread_actions, [OpenMenu, RenameThread, ConfirmAction]);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    Rename,
    Regenerate,
    Settle,
    Unsettle,
    Snooze,
    Unsnooze,
    Archive,
    Delete,
    Protect,
    Handover,
    Continue,
    ContinueAtReset,
    CancelContinue,
    Delegate,
    SideQuestion,
}

impl Item {
    pub fn label(self) -> &'static str {
        match self {
            Self::Rename => "Rename thread",
            Self::Regenerate => "Regenerate thread title",
            Self::Settle => "Settle thread family",
            Self::Unsettle => "Unsettle thread family",
            Self::Snooze => "Snooze thread",
            Self::Unsnooze => "Unsnooze thread",
            Self::Archive => "Archive thread",
            Self::Delete => "Delete thread",
            Self::Protect => "Protect thread",
            Self::Handover => "Hand off with a prompt",
            Self::Continue => "Continue in a new thread",
            Self::ContinueAtReset => "Continue at usage reset",
            Self::CancelContinue => "Cancel scheduled continue",
            Self::Delegate => "Delegate a task",
            Self::SideQuestion => "Ask a side question",
        }
    }
}

pub fn items(w: &Workspace, id: ThreadId) -> Vec<Item> {
    if !w.source.order(false).contains(&id) || w.source.action_pending(id) {
        return vec![];
    }
    let thread = &w.source.list_threads()[id];
    let mut items = vec![
        Item::Rename,
        Item::Regenerate,
        if thread.settled {
            Item::Unsettle
        } else {
            Item::Settle
        },
        if w.source.is_snoozed(id) {
            Item::Unsnooze
        } else {
            Item::Snooze
        },
        Item::Archive,
    ];
    if !w.source.is_protected(id) && !thread.settled {
        items.push(Item::Protect);
    }
    if w.source
        .messages(id)
        .iter()
        .any(|m| matches!(m, Message::Assistant { text, .. } if !text.is_empty()))
    {
        items.push(Item::Continue);
    }
    if w.source.can_handover(id) {
        items.push(Item::Handover);
    }
    if w.source.scheduled_continue(id) {
        items.push(Item::CancelContinue);
    } else if w.source.usage_reset(id).is_some() {
        items.push(Item::ContinueAtReset);
    }
    items.extend([Item::Delegate, Item::SideQuestion, Item::Delete]);
    items
}

pub struct Popup {
    pub id: ThreadId,
    pub at: Point<Pixels>,
    pub message: Option<usize>,
}

pub enum Form {
    Item(ThreadId, Item),
    Revert(ThreadId, usize, Option<String>),
    Archived,
    Answer(String),
}

impl Form {
    fn input(&self) -> Option<&'static str> {
        match self {
            Self::Item(_, Item::Rename) => Some("Thread title"),
            Self::Item(_, Item::Handover) => Some("What should the next agent know?"),
            Self::Item(_, Item::Delegate) => Some("What should the agent do?"),
            Self::Item(_, Item::SideQuestion) => Some("Ask without adding to the conversation"),
            _ => None,
        }
    }

    pub fn chooses_model(&self) -> bool {
        matches!(
            self,
            Self::Item(_, Item::Continue | Item::Handover | Item::Delegate)
        )
    }
}

impl Workspace {
    pub fn open_thread_menu(
        &mut self,
        id: ThreadId,
        at: Point<Pixels>,
        message: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.palette_open = false;
        self.picker_open = false;
        self.dropdown = None;
        self.thread_popup = Some(Popup { id, at, message });
        window.focus(&self.thread_action_focus, cx);
        cx.notify();
    }

    pub fn pick_thread_action(
        &mut self,
        id: ThreadId,
        item: Item,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.thread_popup = None;
        self.palette_open = false;
        self.dropdown = None;
        self.picker_open = false;
        if item == Item::SideQuestion {
            self.select(id, cx);
        }
        let immediate = match item {
            Item::Regenerate => Some(ThreadAction::RegenerateTitle),
            Item::Settle if !self.source.has_family_work(id) => {
                Some(ThreadAction::Settle { stop: false })
            }
            Item::Unsettle => Some(ThreadAction::Unsettle),
            Item::Unsnooze => Some(ThreadAction::Unsnooze),
            Item::Archive => Some(ThreadAction::Archive),
            Item::Protect => Some(ThreadAction::Protect),
            Item::ContinueAtReset => Some(ThreadAction::ContinueAtReset),
            Item::CancelContinue if self.source.delegated(id).is_none() => {
                Some(ThreadAction::CancelContinue {
                    notify_parent: true,
                })
            }
            _ => None,
        };
        if let Some(action) = immediate {
            self.source.thread_action(id, action);
            window.focus(&self.sidebar_focus, cx);
            cx.notify();
        } else {
            self.open_thread_form(Form::Item(id, item), window, cx);
        }
    }

    pub fn open_thread_form(&mut self, form: Form, window: &mut Window, cx: &mut Context<Self>) {
        self.thread_popup = None;
        self.palette_open = false;
        self.picker_open = false;
        self.dropdown = None;
        self.action_model = None;
        self.problem = None;
        if form.chooses_model()
            && let Form::Item(id, _) = &form
        {
            self.action_model = self.source.selection(*id);
            self.source.refresh_catalog();
            self.search.update(cx, |input, cx| {
                input.placeholder = "Search models";
                input.set_text(String::new(), cx);
            });
        }
        if let Some(placeholder) = form.input() {
            let title = match form {
                Form::Item(id, Item::Rename) => self.source.list_threads()[id].title.clone(),
                _ => String::new(),
            };
            self.action_input.update(cx, |input, cx| {
                input.placeholder = placeholder;
                input.set_text(title, cx);
            });
            window.focus(&self.action_input.read(cx).focus.clone(), cx);
        } else {
            window.focus(&self.thread_action_focus, cx);
        }
        self.thread_form = Some(form);
        cx.notify();
    }

    pub fn close_thread_action(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.thread_popup = None;
        self.thread_form = None;
        self.action_model = None;
        window.focus(&self.sidebar_focus, cx);
        cx.notify();
    }

    pub fn submit_thread_action(
        &mut self,
        submitted: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = submitted
            .unwrap_or_else(|| self.action_input.read(cx).text())
            .trim();
        let Some(Form::Item(id, item)) = self.thread_form else {
            return;
        };
        if self.source.action_pending(id) {
            return;
        }
        let action = match item {
            Item::Rename => {
                let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if title.is_empty() || title == self.source.list_threads()[id].title {
                    self.close_thread_action(window, cx);
                    return;
                }
                ThreadAction::Rename(title)
            }
            Item::Settle => ThreadAction::Settle { stop: true },
            Item::Delete => ThreadAction::Delete,
            Item::Continue => ThreadAction::Continue {
                selection: self.action_model.clone(),
            },
            Item::Handover | Item::Delegate if !text.is_empty() => {
                let Some(selection) = self.action_model.clone() else {
                    return;
                };
                if item == Item::Handover {
                    ThreadAction::Handover {
                        prompt: text.to_string(),
                        selection,
                    }
                } else {
                    ThreadAction::Delegate {
                        task: text.to_string(),
                        selection,
                    }
                }
            }
            Item::SideQuestion if !text.is_empty() => ThreadAction::SideQuestion(text.to_string()),
            _ => return,
        };
        self.source.thread_action(id, action);
        if !matches!(item, Item::Continue | Item::Handover | Item::Delegate) {
            self.close_thread_action(window, cx);
        } else if let Some(text) = submitted {
            // The input clears itself on Enter. Preserve it if the command is refused.
            self.action_input
                .update(cx, |input, cx| input.set_text(text.to_string(), cx));
        }
        cx.notify();
    }

    pub fn snooze_for(
        &mut self,
        id: ThreadId,
        hours: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let until = (chrono::Utc::now() + chrono::TimeDelta::hours(hours))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.source.thread_action(id, ThreadAction::Snooze(until));
        self.close_thread_action(window, cx);
    }
}

pub fn popup(
    w: &Workspace,
    popup: &Popup,
    window: &Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let id = popup.id;
    let mut menu = crate::thread_view::menu_surface("thread-context");
    let viewport = window.viewport_size();
    let mut count = 0usize;
    if let Some(index) = popup.message {
        if let Some(message) = w.source.messages(id).get(index)
            && let Message::User { text } | Message::Assistant { text, .. } = message
        {
            let copy = text.clone();
            let draft = matches!(message, Message::User { .. }).then(|| copy.clone());
            count += 1;
            menu = menu.child(
                crate::thread_view::menu_row("copy-message", "Copy message".into(), false)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                        this.close_thread_action(window, cx);
                    })),
            );
            if w.source.list_threads()[id].status != Status::Running
                && let Some(turn) = w.source.revert_before(id, index)
            {
                count += 1;
                menu = menu.child(
                    crate::thread_view::menu_row(
                        "revert-message",
                        "Revert to before this turn…".into(),
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_thread_form(Form::Revert(id, turn, draft.clone()), window, cx);
                    })),
                );
            }
        }
    } else {
        for item in items(w, id) {
            count += 1;
            menu = menu.child(
                crate::thread_view::menu_row(
                    ("thread-context-item", count),
                    item.label().into(),
                    false,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.pick_thread_action(id, item, window, cx)
                })),
            );
        }
    }
    div()
        .absolute()
        .inset_0()
        .track_focus(&w.thread_action_focus)
        .child(
            div()
                .absolute()
                .inset_0()
                .id("thread-menu-backdrop")
                .occlude()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, window, cx| this.close_thread_action(window, cx)),
                ),
        )
        .child(
            menu.absolute()
                .left(popup.at.x.min((viewport.width - px(246.)).max(px(0.))))
                .top(
                    popup
                        .at
                        .y
                        .min((viewport.height - px(32. * count as f32 + 12.)).max(px(0.))),
                )
                .w(px(240.)),
        )
}

pub fn form(
    w: &Workspace,
    form: &Form,
    window: &Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let (title, detail) = match form {
        Form::Item(id, item) => {
            let thread = &w.source.list_threads()[*id];
            let detail = match item {
                Item::Delete => format!("Permanently delete “{}”? This cannot be undone.", thread.title),
                Item::Settle => format!("Stop running and queued work in “{}” and its tasks, then settle the family?", thread.title),
                Item::CancelContinue => "Cancel the scheduled continue. Choose whether to notify the parent thread.".into(),
                Item::Continue => w.source.usage_reset(*id).map_or_else(
                    || "Carry the conversation and tasks into a new thread.".into(),
                    |at| match w.action_model.as_ref().zip(w.source.selection(*id).as_ref()) {
                        Some((choice, current)) if choice.instance != current.instance => "The other provider can continue without waiting for this reset.".into(),
                        _ => format!("Continue on this provider after its usage limit resets ({at})."),
                    }
                ),
                _ => thread.title.clone(),
            };
            (item.label(), detail)
        }
        Form::Revert(_, _, _) => ("Revert conversation", "Remove this turn and all later turns. Choose whether to restore files from the checkpoint too.".into()),
        Form::Archived => ("Archived threads", "Restore a thread to show it in the sidebar again.".into()),
        Form::Answer(answer) => ("Side question", answer.clone()),
    };
    let mut panel = crate::thread_view::menu_surface("thread-action-form")
        .max_w(px(520.))
        .w_full()
        .p(px(16.))
        .gap(px(10.))
        .flex()
        .flex_col()
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(15.))
                .child(title),
        )
        .child(
            div()
                .id("thread-form-detail")
                .max_h(px(260.))
                .overflow_y_scroll()
                .text_color(color("ink-2"))
                .child(detail),
        );
    if let Some(problem) = &w.problem {
        panel = panel.child(div().text_color(color("broken")).child(problem.clone()));
    }
    if form.input().is_some() {
        panel = panel.child(w.action_input.clone());
    }
    if form.chooses_model() {
        panel = panel.child(crate::model_picker::body(
            w,
            div().id("action-model-picker"),
            cx,
        ));
    }
    match form {
        Form::Archived => {
            let archived = w.source.archived();
            panel = panel.child(
                div()
                    .id("archived-threads")
                    .max_h(px(300.))
                    .overflow_y_scroll()
                    .when(archived.is_empty(), |s| s.child("No archived threads"))
                    .children(archived.into_iter().enumerate().map(|(at, (uuid, title))| {
                        crate::thread_view::menu_row(
                            ("restore-thread", at),
                            format!("Restore {title}"),
                            false,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.source.restore_thread(&uuid);
                            cx.notify();
                        }))
                    })),
            );
        }
        Form::Item(id, Item::Snooze) => {
            let id = *id;
            for (hours, label) in [
                (1, "1 hour"),
                (8, "8 hours"),
                (24, "1 day"),
                (168, "1 week"),
            ] {
                panel = panel.child(
                    crate::thread_view::menu_row(
                        ("snooze-for", hours as usize),
                        label.into(),
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.snooze_for(id, hours, window, cx)
                    })),
                );
            }
        }
        Form::Revert(id, turn, draft) => {
            let (id, turn) = (*id, *turn);
            for (files, label) in [
                (false, "Revert conversation only"),
                (true, "Revert conversation and files"),
            ] {
                let draft = draft.clone();
                panel = panel.child(
                    crate::thread_view::menu_row(
                        ("confirm-revert", usize::from(files)),
                        label.into(),
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.source.thread_action(
                            id,
                            ThreadAction::Revert {
                                turn_count: turn,
                                restore_files: files,
                                draft: draft.clone(),
                            },
                        );
                        this.close_thread_action(window, cx);
                    })),
                );
            }
        }
        Form::Item(id, Item::CancelContinue) => {
            let id = *id;
            for (notify_parent, label) in [
                (true, "Cancel and notify parent"),
                (false, "Cancel quietly"),
            ] {
                panel = panel.child(
                    crate::thread_view::menu_row(
                        ("cancel-continue", usize::from(notify_parent)),
                        label.into(),
                        false,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.source
                            .thread_action(id, ThreadAction::CancelContinue { notify_parent });
                        this.close_thread_action(window, cx);
                    })),
                );
            }
        }
        Form::Item(id, item) => {
            let label = match item {
                Item::Rename => "Save title",
                Item::Delete => "Delete permanently",
                Item::Settle => "Stop and settle",
                Item::Continue => "Continue",
                Item::Handover => "Hand off",
                Item::Delegate => "Delegate",
                Item::SideQuestion => "Ask",
                item => item.label(),
            };
            panel = panel.child(if w.source.action_pending(*id) {
                div()
                    .id("confirm-thread-action")
                    .disabled("Waiting for the server")
                    .child("Working…")
            } else {
                crate::thread_view::menu_row("confirm-thread-action", label.into(), false).on_click(
                    cx.listener(|this, _, window, cx| this.submit_thread_action(None, window, cx)),
                )
            });
        }
        Form::Answer(_) => {}
    }
    let _ = window;
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .track_focus(&w.thread_action_focus)
        .key_context("ThreadActionConfirm")
        .child(
            div()
                .absolute()
                .inset_0()
                .id("thread-form-backdrop")
                .occlude()
                .bg(black().opacity(0.22))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, window, cx| this.close_thread_action(window, cx)),
                ),
        )
        .child(
            panel.child(
                div()
                    .id("cancel-thread-action")
                    .control("Close")
                    .px(px(8.))
                    .text_color(color("ink-2"))
                    .child(if matches!(form, Form::Archived | Form::Answer(_)) {
                        "Close"
                    } else {
                        "Cancel"
                    })
                    .on_click(
                        cx.listener(|this, _, window, cx| this.close_thread_action(window, cx)),
                    ),
            ),
        )
}
