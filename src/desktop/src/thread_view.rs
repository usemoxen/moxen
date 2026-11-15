use crate::{
    model::Message,
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let id = w.selected;
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
                        Message::User { text, preview } => div()
                            .flex()
                            .flex_col()
                            .items_end()
                            .gap(px(8.))
                            .when(preview, |s| s.pt(px(17.)))
                            .when(preview, |s| s.child(preview_thumbnail()))
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
                                        .text_size(px(12.5))
                                        .font_family(theme::MONO)
                                        .text_color(color("ink-2"))
                                        .cursor_pointer()
                                        .py(px(8.))
                                        .child(format!(
                                            "{} Ran 4 commands, read 3 files · 38s",
                                            if folded { "▸" } else { "▾" }
                                        ))
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
                                                        .child(format!(
                                                            "▪ {}",
                                                            crate::model_picker::MODELS[w.model].0
                                                        )),
                                                )
                                                .child(div().text_color(color("effort")).child(
                                                    ["Low", "Medium", "High", "Extra", "Max"]
                                                        [w.effort],
                                                ))
                                                .child("⌄")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.picker_open = !this.picker_open;
                                                    cx.notify();
                                                })),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.5))
                                                .text_color(color("ink-2"))
                                                .child("Full access ⌄"),
                                        ),
                                )
                                .child(w.composers[id].clone())
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .child(div().text_color(color("ink-2")).child("📎"))
                                        .child(
                                            div()
                                                .flex()
                                                .gap(px(8.))
                                                .child(
                                                    div()
                                                        .id("stop")
                                                        .size(px(30.))
                                                        .border_1()
                                                        .border_color(color("edge"))
                                                        .rounded(px(8.))
                                                        .text_center()
                                                        .child("▪")
                                                        .cursor_pointer()
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.stop(cx)
                                                        })),
                                                )
                                                .child(
                                                    div()
                                                        .id("send")
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
                                                        .text_center()
                                                        .cursor_pointer()
                                                        .child("↑")
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
                                    div().flex().gap(px(6.)).child("⑂ opencode-v2 ").child(
                                        div().text_color(color("effort")).child("10 changed"),
                                    ),
                                )
                                .child(
                                    div()
                                        .id("usage")
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .child("66% 663k / 1m | 5h 36% wk 43%")
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

fn preview_thumbnail() -> impl IntoElement {
    div()
        .w(px(260.))
        .h(px(160.))
        .rounded(px(14.))
        .bg(color("ground"))
        .flex()
        .overflow_hidden()
        .child(
            div()
                .w(px(64.))
                .border_r_1()
                .border_color(color("rule"))
                .p(px(10.))
                .flex()
                .flex_col()
                .gap(px(7.))
                .children([40., 34., 44.].into_iter().map(|width| {
                    div()
                        .w(px(width))
                        .h(px(5.))
                        .rounded(px(3.))
                        .bg(color("rule"))
                })),
        )
        .child(
            div()
                .flex_1()
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(div().h(px(6.)).bg(color("rule")).rounded(px(3.)))
                .child(
                    div()
                        .w(px(130.))
                        .h(px(6.))
                        .bg(color("rule"))
                        .rounded(px(3.)),
                )
                .child(div().flex_1())
                .child(
                    div()
                        .h(px(50.))
                        .border_1()
                        .border_color(color("live"))
                        .rounded(px(8.))
                        .p(px(10.))
                        .child(
                            div()
                                .w(px(70.))
                                .h(px(12.))
                                .rounded(px(6.))
                                .bg(color("provider-claude")),
                        ),
                ),
        )
}
