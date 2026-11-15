use crate::{
    model::Message,
    theme::{self, color, space},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

pub fn render(workspace: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = workspace.selected;
    let thread = workspace.source.list_threads()[id].clone();
    let messages = workspace.source.messages(id);
    let entity = cx.entity();
    let state = workspace.lists[id].clone();
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .bg(color("raised"))
        .child(
            div()
                .px(px(space(5)))
                .py(px(space(4)))
                .border_b_1()
                .border_color(color("rule"))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(space(4)))
                .child(div().text_size(px(theme::BODY)).child(thread.title))
                .child(
                    div()
                        .rounded(px(theme::RADIUS))
                        .px(px(space(3)))
                        .py(px(space(1)))
                        .bg(color("sunk"))
                        .text_color(color(thread.status.token()))
                        .text_size(px(theme::META))
                        .child(format!("● {}", thread.status.label())),
                ),
        )
        .child(
            div().flex_1().min_h_0().overflow_hidden().child(
                list(state, move |index, _, cx| {
                    let message = messages[index].clone();
                    let open = entity.read(cx).expanded.contains(&(id, index));
                    let body = match message {
                        Message::User(text) => div()
                            .flex()
                            .justify_end()
                            .child(
                                div()
                                    .max_w(px(theme::READING))
                                    .px(px(space(4)))
                                    .py(px(space(3)))
                                    .rounded(px(theme::RADIUS))
                                    .bg(color("sunk"))
                                    .child(text),
                            )
                            .into_any_element(),
                        Message::Assistant(text) => div()
                            .flex()
                            .flex_col()
                            .gap(px(space(2)))
                            .child(
                                div()
                                    .text_color(color("label-2"))
                                    .text_size(px(theme::META))
                                    .child("Assistant"),
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
                        } => {
                            let target = entity.clone();
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(space(2)))
                                .child(
                                    div()
                                        .id(("tool", index))
                                        .cursor_pointer()
                                        .text_size(px(theme::META))
                                        .text_color(color("tool-read"))
                                        .hover(|s| s.text_color(color("ink")))
                                        .child(format!(
                                            "{}  {} · {}",
                                            if open { "▾" } else { "▸" },
                                            name,
                                            summary
                                        ))
                                        .on_click(move |_, _, cx| {
                                            target.update(cx, |this, cx| {
                                                if !this.expanded.remove(&(id, index)) {
                                                    this.expanded.insert((id, index));
                                                }
                                                this.lists[id].splice(index..index + 1, 1);
                                                cx.notify();
                                            })
                                        }),
                                )
                                .when(open, |s| {
                                    s.child(
                                        div()
                                            .border_l_1()
                                            .border_color(color("rule"))
                                            .pl(px(space(4)))
                                            .text_size(px(theme::META))
                                            .text_color(color("ink-2"))
                                            .child(output),
                                    )
                                })
                                .into_any_element()
                        }
                    };
                    div()
                        .w_full()
                        .px(px(space(6)))
                        .py(px(space(3)))
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
                .px(px(space(6)))
                .py(px(space(4)))
                .flex()
                .justify_center()
                .child(
                    div()
                        .w_full()
                        .max_w(px(theme::READING))
                        .flex()
                        .flex_col()
                        .gap(px(space(2)))
                        .child(
                            div()
                                .text_size(px(theme::META))
                                .text_color(color("ink-2"))
                                .child(format!("{} · mock workspace", thread.model)),
                        )
                        .child(workspace.composers[id].clone())
                        .child(
                            div().flex().justify_end().child(
                                div()
                                    .id("send")
                                    .cursor_pointer()
                                    .rounded(px(theme::RADIUS))
                                    .px(px(space(4)))
                                    .py(px(space(2)))
                                    .bg(color("ink"))
                                    .text_color(color("on-ink"))
                                    .text_size(px(theme::META))
                                    .child("Send ↑")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        window.focus(
                                            &this.composers[this.selected].read(cx).focus.clone(),
                                            cx,
                                        );
                                        window.dispatch_action(Box::new(crate::composer::Send), cx);
                                    })),
                            ),
                        ),
                ),
        )
}
