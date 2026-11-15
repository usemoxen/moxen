use crate::{
    theme::{self, color, space},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

actions!(sidebar, [PreviousThread, NextThread]);

pub fn render(workspace: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let threads = workspace.source.list_threads();
    div()
        .id("sidebar")
        .key_context("Sidebar")
        .track_focus(&workspace.sidebar_focus)
        .w(px(theme::SIDEBAR))
        .h_full()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .bg(color("ground"))
        .border_r_1()
        .border_color(color("rule"))
        .on_action(cx.listener(|this, _: &PreviousThread, _, cx| {
            this.select(this.selected.saturating_sub(1), cx)
        }))
        .on_action(cx.listener(|this, _: &NextThread, _, cx| {
            this.select(
                (this.selected + 1).min(this.source.list_threads().len() - 1),
                cx,
            )
        }))
        .child(
            div()
                .p(px(space(5)))
                .text_size(px(theme::BODY))
                .child("Moxen Agent"),
        )
        .child(
            div()
                .px(px(space(4)))
                .pb(px(space(3)))
                .text_size(px(theme::META))
                .text_color(color("ink-2"))
                .child("MOXEN / THREADS"),
        )
        .child(
            uniform_list(
                "threads",
                threads.len(),
                cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                    range
                        .map(|i| {
                            let t = &threads[i];
                            div()
                                .id(i)
                                .h(px(theme::ROW))
                                .px(px(space(3)))
                                .py(px(space(2)))
                                .border_l_2()
                                .border_color(color(if this.selected == i {
                                    "live"
                                } else {
                                    "ground"
                                }))
                                .bg(color(if this.selected == i { "sunk" } else { "ground" }))
                                .hover(|s| s.bg(color("sunk")))
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    window.focus(&this.sidebar_focus, cx);
                                    this.select(i, cx);
                                }))
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(space(2)))
                                        .child(div().text_color(color(t.status.token())).child("●"))
                                        .child(
                                            div()
                                                .flex_1()
                                                .text_size(px(theme::BODY))
                                                .truncate()
                                                .child(t.title.clone()),
                                        ),
                                )
                                .child(
                                    div()
                                        .pl(px(space(4)))
                                        .text_size(px(theme::META))
                                        .text_color(color("ink-2"))
                                        .child(t.model.clone()),
                                )
                                .child(
                                    div()
                                        .pl(px(space(4)))
                                        .text_size(px(theme::META))
                                        .text_color(color("ink-2"))
                                        .child(t.activity.clone()),
                                )
                        })
                        .collect()
                }),
            )
            .flex_1(),
        )
}
