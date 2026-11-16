use crate::ui::{self, Control};
use crate::{
    model::{Message, Status},
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

/// Space between turns in the transcript (the mockup's column gap).
const TURN_GAP: f32 = 22.;

/// "Ran 3 commands, read 3 files, edited 1 file": the folded run's summary.
pub fn run_summary(messages: &[Message]) -> String {
    let count = |kind: &str| {
        messages
            .iter()
            .filter(|m| matches!(m, Message::Tool { name, .. } if name == kind))
            .count()
    };
    let plural =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut parts = vec![];
    let (ran, read, edited) = (count("command"), count("read"), count("edit"));
    if ran > 0 {
        parts.push(format!("ran {}", plural(ran, "command", "commands")));
    }
    if read > 0 {
        parts.push(format!("read {}", plural(read, "file", "files")));
    }
    if edited > 0 {
        parts.push(format!("edited {}", plural(edited, "file", "files")));
    }
    let mut text = parts.join(", ");
    if let Some(first) = text.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    text
}

pub fn render(w: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = w.selected;
    let draft_empty = w.composers[id].read(cx).text().trim().is_empty();
    let thread = w.source.list_threads()[id].clone();
    let running = thread.status == Status::Running;
    let messages = w.source.messages(id);
    let summary: SharedString = run_summary(&messages).into();
    let last_reply = messages
        .iter()
        .rposition(|m| matches!(m, Message::Assistant(_)));
    let entity = cx.entity();
    let state = w.lists[id].clone();
    let model = thread.model.clone();
    let started = thread.started_at;
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
                list(state, move |index, window, cx| {
                    let this = entity.read(cx);
                    let folded = this.folded.contains(&id);
                    if folded && index > 2 && matches!(messages[index], Message::Tool { .. }) {
                        return div().into_any_element();
                    }
                    let shown = ui::progress(this.unfolded_at.get(&id).copied(), 150, window);
                    let open = this
                        .expanded
                        .get(&(id, index))
                        .map(|at| ui::progress(Some(*at), 150, window));
                    let body = match messages[index].clone() {
                        Message::User { text } => div()
                            .flex()
                            .flex_col()
                            .items_end()
                            .child(
                                div()
                                    .max_w(relative(0.82))
                                    .px(px(14.))
                                    .py(px(10.))
                                    .rounded(px(14.))
                                    .bg(color("sunk"))
                                    .text_size(px(theme::BODY))
                                    .line_height(px(theme::BODY * 1.55))
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
                                    .items_baseline()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.5))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(color("provider-claude"))
                                            .child(model.clone()),
                                    )
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .text_size(px(12.))
                                            .text_color(color("ink-2"))
                                            .child("Thu 09:38"),
                                    )
                                    .when(running && Some(index) == last_reply, |s| {
                                        let seconds =
                                            started.map_or(0, |start| start.elapsed().as_secs());
                                        s.child(div().flex_1()).child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(6.))
                                                .font_family(theme::MONO)
                                                .text_size(px(12.))
                                                .text_color(color("live"))
                                                .child(ui::state(Status::Running))
                                                .child(format!(
                                                    "working · {}m {:02}s",
                                                    seconds / 60,
                                                    seconds % 60
                                                )),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(theme::BODY))
                                    .line_height(px(theme::LINE))
                                    .when(text.is_empty(), |s| s.text_color(color("ink-2")))
                                    .child(if text.is_empty() {
                                        "Thinking…".into()
                                    } else {
                                        text
                                    }),
                            )
                            .into_any_element(),
                        Message::Tool {
                            name,
                            summary: target,
                            output,
                        } => div()
                            .when(index == 2, |s| {
                                let fold = entity.clone();
                                s.pt(px(10.))
                                    .child(
                                        div()
                                            .id("run-summary")
                                            .quiet()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .py(px(4.))
                                            .mx(px(-4.))
                                            .px(px(4.))
                                            .rounded(px(4.))
                                            .text_size(px(12.5))
                                            .text_color(color("ink-2"))
                                            .child(ui::icon(
                                                if folded {
                                                    "chevron-right"
                                                } else {
                                                    "chevron-down"
                                                },
                                                "ink-2",
                                            ))
                                            .child(summary.clone())
                                            .on_click(move |_, _, cx| {
                                                fold.update(cx, |this, cx| {
                                                    if !this.folded.remove(&id) {
                                                        this.folded.insert(id);
                                                        this.unfolded_at.remove(&id);
                                                    } else {
                                                        this.unfolded_at
                                                            .insert(id, std::time::Instant::now());
                                                    }
                                                    this.lists[id].splice(2..11, 9);
                                                    cx.notify();
                                                })
                                            }),
                                    )
                                    .when(!folded, |s| s.child(div().h(px(6.))))
                            })
                            .when(!folded, |s| {
                                s.child(crate::steps::render(
                                    crate::steps::Step {
                                        name,
                                        summary: target,
                                        output,
                                        id,
                                        index,
                                        shown: if index == 2 { 1. } else { shown },
                                        open,
                                    },
                                    entity.clone(),
                                ))
                            })
                            .into_any_element(),
                    };
                    let tool = matches!(messages[index], Message::Tool { .. });
                    div()
                        .w_full()
                        .px(px(28.))
                        .pt(px(if index == 0 {
                            28.
                        } else if tool {
                            0.
                        } else {
                            TURN_GAP
                        }))
                        .when(index + 1 == messages.len(), |s| s.pb(px(24.)))
                        .flex()
                        .justify_center()
                        .child(div().w_full().max_w(px(theme::READING)).child(body))
                        .into_any_element()
                })
                .size_full(),
            ),
        )
        .child(composer(w, &thread, draft_empty, window, cx))
}

fn composer(
    w: &Workspace,
    thread: &crate::model::Thread,
    draft_empty: bool,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let id = w.selected;
    let running = thread.status == Status::Running;
    div()
        .flex_shrink_0()
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
                    s.child(queued(w.source.queued(id)[0].clone(), cx))
                })
                .child(
                    div()
                        .relative()
                        .border(px(theme::px_token("stroke", "stroke-rule")))
                        .border_color(color(if running { "live" } else { "edge" }))
                        .rounded(px(theme::px_token("radius", "radius-lg")))
                        .bg(color("ground"))
                        .pt(px(10.))
                        .pb(px(10.))
                        .pl(px(14.))
                        .pr(px(12.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .ml(px(-6.))
                                .flex()
                                .gap(px(4.))
                                .items_center()
                                .child(model_pill(w, cx))
                                .child(
                                    div()
                                        .id("access")
                                        .inert("Access is fixed in this preview")
                                        .h(px(28.))
                                        .px(px(8.))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .rounded(px(14.))
                                        .text_size(px(12.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(color("ink-2"))
                                        .child("Full access")
                                        .child(ui::icon("chevron-down", "ink-2")),
                                ),
                        )
                        .child(w.composers[id].clone())
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .id("attach")
                                        .inert("Attachments are unavailable in this preview")
                                        .ml(px(-6.))
                                        .size(px(28.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(6.))
                                        .child(ui::icon("paperclip", "ink-2")),
                                )
                                .child(div().flex_1())
                                .when(running, |s| {
                                    s.child(
                                        div()
                                            .relative()
                                            .children(ui::focus_tip(
                                                &w.tips.stop,
                                                window,
                                                "Stop",
                                                "esc",
                                                ui::Tip::AboveRight,
                                            ))
                                            .child(
                                                div()
                                                    .id("stop")
                                                    .track_focus(&w.tips.stop)
                                                    .shortcut("Stop", "esc")
                                                    .size(px(30.))
                                                    .border(px(theme::px_token(
                                                        "stroke",
                                                        "stroke-rule",
                                                    )))
                                                    .border_color(color("edge"))
                                                    .rounded(px(theme::px_token(
                                                        "radius",
                                                        "radius-md",
                                                    )))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    // A filled stop square, not an outlined one.
                                                    .child(
                                                        div()
                                                            .size(px(9.))
                                                            .rounded(px(2.))
                                                            .bg(color("ink")),
                                                    )
                                                    .on_click(
                                                        cx.listener(|this, _, _, cx| this.stop(cx)),
                                                    ),
                                            ),
                                    )
                                })
                                .child(
                                    div()
                                        .relative()
                                        .children(ui::focus_tip(
                                            &w.tips.send,
                                            window,
                                            if running {
                                                "Queue for after this turn"
                                            } else {
                                                "Send"
                                            },
                                            "↵",
                                            ui::Tip::AboveRight,
                                        ))
                                        .child(
                                            div()
                                                .id("send")
                                                .track_focus(&w.tips.send)
                                                .when(!draft_empty, |s| {
                                                    s.shortcut(
                                                        if running {
                                                            "Queue for after this turn"
                                                        } else {
                                                            "Send"
                                                        },
                                                        "↵",
                                                    )
                                                })
                                                .when(draft_empty, |s| {
                                                    s.cursor(CursorStyle::Arrow)
                                                        .opacity(0.35)
                                                        .tooltip(|_, cx| {
                                                            cx.new(|_| {
                                                                ui::Tooltip(
                                                                    "Write a message to send"
                                                                        .into(),
                                                                    Some("↵"),
                                                                )
                                                            })
                                                            .into()
                                                        })
                                                })
                                                .size(px(30.))
                                                .rounded(px(theme::px_token("radius", "radius-md")))
                                                .bg(color("ink"))
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .child(ui::icon("arrow-up", "on-ink"))
                                                .on_click(cx.listener(|this, _, window, cx| {
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
                                                })),
                                        ),
                                ),
                        )
                        .when(w.picker_open, |s| {
                            s.child(crate::model_picker::render(w, window, cx))
                        }),
                )
                .child(status_line(cx)),
        )
}

fn model_pill(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let provider = if w.model < 4 {
        "provider-claude"
    } else {
        "provider-opencode"
    };
    div()
        .id("model-pill")
        .shortcut("Model and effort", "⌘M")
        .track_focus(&w.model_focus)
        .h(px(28.))
        .px(px(10.))
        .flex()
        .gap(px(8.))
        .items_center()
        .rounded(px(14.))
        .when(w.picker_open, |s| s.bg(color("sunk")))
        .child(div().size(px(8.)).rounded(px(2.)).bg(color(provider)))
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color(provider))
                .child(crate::model_picker::MODELS[w.model].0),
        )
        .child(
            div()
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(color("effort"))
                .child(crate::model_picker::EFFORTS[w.effort]),
        )
        .child(ui::icon("chevron-down", "ink-2"))
        .on_click(cx.listener(|this, _, window, cx| this.toggle_picker(window, cx)))
}

fn queued(text: String, cx: &mut Context<Workspace>) -> impl IntoElement {
    let chip = |id: &'static str, tooltip: &'static str, label: &'static str| {
        div()
            .id(id)
            .control(tooltip)
            .h(px(22.))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .text_size(px(12.5))
            .font_weight(FontWeight::MEDIUM)
            .text_color(color("ink-2"))
            .child(label)
    };
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(12.))
        .py(px(6.))
        .rounded(px(theme::px_token("radius", "radius-md")))
        .bg(color("sunk"))
        .text_size(px(13.))
        .child(ui::state(Status::Queued))
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(11.5))
                .text_color(color("ink-2"))
                .child("queued"),
        )
        .child(div().flex_1().min_w_0().truncate().child(text))
        .child(
            chip("edit-queued", "Edit queued message", "Edit").on_click(cx.listener(
                |this, _, window, cx| {
                    if let Some(text) = this.source.take_queued(this.selected) {
                        this.composers[this.selected].update(cx, |c, cx| c.set_text(text, cx));
                        window.focus(&this.composers[this.selected].read(cx).focus.clone(), cx);
                        cx.notify();
                    }
                },
            )),
        )
        .child(
            chip(
                "send-queued",
                "Stop this turn and send the queued message",
                "Send now",
            )
            .on_click(cx.listener(|this, _, _, cx| this.send_queued(cx))),
        )
}

fn status_line(cx: &mut Context<Workspace>) -> impl IntoElement {
    let chip = |id: &'static str, tooltip: &'static str| {
        div()
            .id(id)
            .control(tooltip)
            .h(px(28.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(6.))
    };
    div()
        .mx(px(-6.))
        .flex()
        .items_center()
        .gap(px(4.))
        .font_family(theme::MONO)
        .text_size(px(12.))
        .text_color(color("ink-2"))
        .child(
            chip("branch", "Open Git")
                .child(ui::icon("git-branch", "ink-2"))
                .child(div().text_color(color("ink")).child("picker-focus"))
                .child(div().text_color(color("effort")).child("10 changed"))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.tab = 1;
                    this.set_inspector(true);
                    cx.notify();
                })),
        )
        .child(div().flex_1())
        .child(
            chip("usage", "Context and plan usage")
                .child(crate::usage::meter(40., 5.))
                .child(div().text_color(color("ink")).child("66%"))
                .child("663k / 1m")
                .child(div().w(px(1.)).h(px(12.)).mx(px(4.)).bg(color("rule")))
                .child("5h")
                .child(div().text_color(color("context-tools")).child("36%"))
                .child("wk")
                .child(div().text_color(color("context-tools")).child("43%"))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.tab = 2;
                    this.set_inspector(true);
                    cx.notify();
                })),
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn run_summary_counts_each_kind() {
        let source = crate::mock::MockSource::preview();
        use crate::model::ThreadSource;
        assert_eq!(
            super::run_summary(&source.messages(0)),
            "Ran 3 commands, read 3 files, edited 1 file"
        );
    }
}
