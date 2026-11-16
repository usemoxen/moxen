use crate::theme::TypeScale;
use crate::ui::{self, Control};
use crate::{
    model::Message,
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = w.selected;
    let can_send = !w.composers[id].read(cx).text().trim().is_empty();
    let thread = w.source.list_threads()[id].clone();
    let messages = w.source.messages(id);
    let entity = cx.entity();
    let state = w.lists[id].clone();
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .bg(color("raised"))
        .child(
            div().flex_1().min_h_0().overflow_hidden().child(
                list(state, move |index, _, cx| {
                    let folded = entity.read(cx).folded.contains(&id);
                    if folded && index > 2 && matches!(messages[index], Message::Tool { .. }) {
                        return div().into_any_element();
                    }
                    let open = entity.read(cx).expanded.contains(&(id, index));
                    let body = match messages[index].clone() {
                        Message::User { text } => div()
                            .flex()
                            .flex_col()
                            .items_end()
                            .gap(px(8.))
                            .child(
                                div()
                                    .max_w(px(594.))
                                    .px(px(14.))
                                    .py(px(10.))
                                    .rounded(px(18.))
                                    .bg(color("sunk"))
                                    .child(text),
                            )
                            .into_any_element(),
                        Message::Assistant(text) => div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .gap(px(8.))
                                    .text_size(px(13.5))
                                    .child(
                                        div()
                                            .text_color(color("provider-claude"))
                                            .child(thread.model.clone()),
                                    )
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .text_size(px(12.))
                                            .text_color(color("ink-2"))
                                            .child("Thu 09:38"),
                                    ),
                            )
                            .child(if text.is_empty() {
                                "Thinking…".into()
                            } else {
                                text
                            })
                            .into_any_element(),
                        Message::Tool {
                            name,
                            summary,
                            output,
                        } => div()
                            .when(index == 2, |s| {
                                let target = entity.clone();
                                s.child(
                                    div()
                                        .id("run-summary")
                                        .control("Fold or expand the run")
                                        .text_size(px(12.5))
                                        .font_family(theme::MONO)
                                        .text_color(color("ink-2"))
                                        .cursor_pointer()
                                        .py(px(8.))
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(ui::icon(
                                            if folded {
                                                "chevron-right"
                                            } else {
                                                "chevron-down"
                                            },
                                            "ink-2",
                                        ))
                                        .child("Ran 3 commands, read 3 files, edited 1 file")
                                        .on_click(move |_, _, cx| {
                                            target.update(cx, |this, cx| {
                                                if !this.folded.remove(&id) {
                                                    this.folded.insert(id);
                                                }
                                                this.lists[id].splice(2..11, 9);
                                                cx.notify();
                                            })
                                        }),
                                )
                            })
                            .when(!folded, |s| {
                                s.child(crate::steps::render(
                                    name,
                                    summary,
                                    output,
                                    id,
                                    index,
                                    entity.clone(),
                                    open,
                                ))
                            })
                            .into_any_element(),
                    };
                    div()
                        .w_full()
                        .px(px(28.))
                        .py(px(if index < 2 { 11. } else { 0. }))
                        .flex()
                        .justify_center()
                        .child(div().w_full().max_w(px(theme::READING)).child(body))
                        .into_any_element()
                })
                .size_full(),
            ),
        )
        .child(
            div()
                .px(px(28.))
                .pb(px(18.))
                .pt(px(6.))
                .flex()
                .justify_center()
                .child(
                    div()
                        .w_full()
                        .max_w(px(theme::READING))
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .when(!w.source.queued(id).is_empty(), |s| {
                            s.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .px(px(10.))
                                    .py(px(6.))
                                    .rounded(px(8.))
                                    .bg(color("sunk"))
                                    .text_size(px(12.))
                                    .child(
                                        div()
                                            .flex_1()
                                            .truncate()
                                            .child(w.source.queued(id)[0].clone()),
                                    )
                                    .child(
                                        div()
                                            .id("edit-queued")
                                            .control("Edit queued message")
                                            .px(px(6.))
                                            .rounded(px(4.))
                                            .child("Edit")
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                if let Some(text) =
                                                    this.source.take_queued(this.selected)
                                                {
                                                    this.composers[this.selected]
                                                        .update(cx, |c, cx| c.set_text(text, cx));
                                                    window.focus(
                                                        &this.composers[this.selected]
                                                            .read(cx)
                                                            .focus
                                                            .clone(),
                                                        cx,
                                                    );
                                                    cx.notify();
                                                }
                                            })),
                                    )
                                    .child(
                                        div()
                                            .id("send-queued")
                                            .control("Stop this turn and send queued message")
                                            .px(px(6.))
                                            .rounded(px(4.))
                                            .child("Send now")
                                            .on_click(
                                                cx.listener(|this, _, _, cx| this.send_queued(cx)),
                                            ),
                                    ),
                            )
                        })
                        .child(
                            div()
                                .border_1()
                                .border_color(color(
                                    if thread.status == crate::model::Status::Running {
                                        "live"
                                    } else {
                                        "edge"
                                    },
                                ))
                                .rounded(px(10.))
                                .bg(color("ground"))
                                .px(px(12.))
                                .py(px(10.))
                                .flex()
                                .flex_col()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(4.))
                                        .items_center()
                                        .child(
                                            div()
                                                .id("model-pill")
                                                .control("Choose model and effort")
                                                .track_focus(&w.model_focus)
                                                .h(px(28.))
                                                .px(px(10.))
                                                .flex()
                                                .gap(px(8.))
                                                .items_center()
                                                .rounded(px(14.))
                                                .bg(color("sunk"))
                                                .text_size(px(13.))
                                                .cursor_pointer()
                                                .child(
                                                    div()
                                                        .text_color(color(if w.model < 4 {
                                                            "provider-claude"
                                                        } else {
                                                            "provider-opencode"
                                                        }))
                                                        .type_scale("label")
                                                        .child(
                                                            crate::model_picker::MODELS[w.model].0,
                                                        ),
                                                )
                                                .child(div().text_color(color("effort")).child(
                                                    ["Low", "Medium", "High", "Extra", "Max"]
                                                        [w.effort],
                                                ))
                                                .child(ui::icon("chevron-down", "ink-2"))
                                                .on_click(cx.listener(|this, _, window, cx| this.toggle_picker(window,cx))),
                                        )
                                        .child(
                                            div()
                                                .id("access").disabled("Access is fixed for this preview")
                                                .text_size(px(12.5))
                                                .text_color(color("ink-2"))
                                                .child("Full access"),
                                        ),
                                )
                                .child(w.composers[id].clone())
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .child(
                                            div()
                                                .id("attach").disabled("Attachments are unavailable in this preview")
                                                .child(ui::icon("paperclip", "ink-2")),
                                        )
                                        .child(
                                            div()
                                                .flex()
                                                .gap(px(8.))
                                                .child(
                                                    div()
                                                        .id("stop")
                                                        .when(thread.status == crate::model::Status::Running, |s| s.control("Stop reply · Escape"))
                                                        .when(thread.status != crate::model::Status::Running, |s| s.disabled("No reply is running"))
                                                        .size(px(30.))
                                                        .border_1()
                                                        .border_color(color("edge"))
                                                        .rounded(px(8.))
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .child(ui::icon("square", "ink-2"))
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.stop(cx)
                                                        })),
                                                )
                                                .child(
                                                    div()
                                                        .id("send")
                                                        .when(can_send, |s| s.control("Send · Enter; queues while working"))
                                                        .when(!can_send, |s| s.disabled("Write a message to send · Enter"))
                                                        .size(px(30.))
                                                        .rounded(px(8.))
                                                        .bg(color(
                                                            if w.composers[id]
                                                                .read(cx)
                                                                .text()
                                                                .is_empty()
                                                            {
                                                                "sunk"
                                                            } else {
                                                                "ink"
                                                            },
                                                        ))
                                                        .text_color(color(
                                                            if w.composers[id]
                                                                .read(cx)
                                                                .text()
                                                                .is_empty()
                                                            {
                                                                "ink-2"
                                                            } else {
                                                                "on-ink"
                                                            },
                                                        ))
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .child(ui::icon("arrow-up", if can_send { "on-ink" } else { "ink-2" }))
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                window.focus(
                                                                    &this.composers[this.selected]
                                                                        .read(cx)
                                                                        .focus
                                                                        .clone(),
                                                                    cx,
                                                                );
                                                                window.dispatch_action(
                                                                    Box::new(crate::composer::Send),
                                                                    cx,
                                                                );
                                                            },
                                                        )),
                                                ),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .justify_between()
                                .font_family(theme::MONO)
                                .text_size(px(11.5))
                                .text_color(color("ink-2"))
                                .child(
                                    div()
                                        .id("branch")
                                        .control("Open Git")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.tab = 1;
                                            this.inspector_open = true;
                                            cx.notify();
                                        }))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .child(ui::icon("git-branch", "ink-2"))
                                        .child("picker-focus")
                                        .child(
                                            div().text_color(color("effort")).child("10 changed"),
                                        ),
                                )
                                .child(
                                    div()
                                        .id("usage")
                                        .control("Open context and plan usage")
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .child(crate::usage::meter(34., 4.))
                                        .child("66% 663k / 1m")
                                        .child(
                                            div()
                                                .text_color(color("context-tools"))
                                                .child("5h 36%"),
                                        )
                                        .child(
                                            div()
                                                .text_color(color("context-system"))
                                                .child("wk 43%"),
                                        )
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.tab = 2;
                                            this.inspector_open = true;
                                            cx.notify();
                                        })),
                                ),
                        ),
                ),
        )
        .when(w.picker_open, |s| {
            s.child(crate::model_picker::render(w, cx))
        })
}
