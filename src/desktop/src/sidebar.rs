use crate::theme::TypeScale;
use crate::ui::{self, Control};
use crate::{
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(sidebar, [PreviousThread, NextThread]);
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let threads = w.source.list_threads();
    let mut rows = div()
        .id("thread-scroll")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(8.))
        .pt(px(4.));
    for (i, t) in threads.iter().enumerate() {
        if t.settled && !w.settled_open {
            continue;
        }
        if w.group != 0 && (i == 0 || i == 2) {
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(10.))
                    .pt(px(16.))
                    .pb(px(6.))
                    .child(
                        div()
                            .rounded(px(3.))
                            .px(px(4.))
                            .text_size(px(10.))
                            .font_family(theme::MONO)
                            .bg(color(if i == 0 { "label-2" } else { "label-6" }))
                            .text_color(color("on-ink"))
                            .child(if i == 0 { "T3" } else { "MT" }),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .type_scale("label")
                            .child(t.project.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(11.5))
                            .text_color(color("ink-2"))
                            .child("2"),
                    ),
            );
        }
        if w.group == 2 && t.project != threads[w.selected].project {
            continue;
        }
        rows = rows.child(
            div()
                .id(("thread", i))
                .control(t.title.clone())
                .h(px(if t.depth > 0 { 26. } else { theme::ROW }))
                .ml(px(t.depth as f32 * 23.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(6.))
                .border_l_2()
                .border_color(color(if w.selected == i {
                    "live"
                } else if t.depth > 0 {
                    "rule"
                } else {
                    "ground"
                }))
                .when(w.selected == i, |s| s.bg(color("sunk")))
                .text_size(px(if t.depth > 0 { 12.5 } else { 13.5 }))
                .cursor_pointer()
                .child(
                    div()
                        .text_color(color(t.status.token()))
                        .child(ui::state(t.status)),
                )
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .when(t.depth > 0, |s| s.text_color(color("ink-2")))
                        .child(t.title.clone()),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .text_color(color("ink-2"))
                        .child(t.activity.clone()),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    window.focus(&this.sidebar_focus, cx);
                    this.select(i, cx);
                })),
        );
    }
    div()
        .id("sidebar")
        .key_context("Sidebar")
        .track_focus(&w.sidebar_focus)
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
                .p(px(12.))
                .pb(px(8.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .child(
                            div()
                                .flex_1()
                                .border_1()
                                .border_color(color("rule"))
                                .rounded(px(8.))
                                .bg(color("raised"))
                                .text_size(px(13.))
                                .line_height(px(14.))
                                .px(px(10.))
                                .py(px(2.))
                                .text_color(color("ink-2"))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(ui::icon("search", "ink-2"))
                                .child(div().flex_1().child("Jump to thread or action"))
                                .child(
                                    div()
                                        .px(px(4.))
                                        .rounded(px(3.))
                                        .border_1()
                                        .border_color(color("rule"))
                                        .font_family(theme::MONO)
                                        .text_size(px(10.))
                                        .child("⌘K"),
                                ),
                        )
                        .child(div().w(px(24.)).child(ui::icon("square-pen", "ink-2"))),
                )
                .child(
                    div().flex().rounded(px(8.)).bg(color("sunk")).children(
                        ["All", "Projects", "This project"]
                            .into_iter()
                            .enumerate()
                            .map(|(i, s)| {
                                div()
                                    .id(("group", i))
                                    .control(s)
                                    .flex_1()
                                    .text_center()
                                    .text_size(px(12.))
                                    .rounded(px(6.))
                                    .when(w.group == i, |s| s.bg(color("ground")))
                                    .cursor_pointer()
                                    .child(s)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.group = i;
                                        cx.notify();
                                    }))
                            }),
                    ),
                ),
        )
        .child(rows)
        .child(
            div()
                .border_t_1()
                .border_color(color("rule"))
                .p(px(12.))
                .text_size(px(13.))
                .text_color(color("ink-2"))
                .child(
                    div()
                        .id("settled-toggle")
                        .control("Show settled threads")
                        .flex()
                        .justify_between()
                        .child(ui::icon(
                            if w.settled_open {
                                "chevron-down"
                            } else {
                                "chevron-right"
                            },
                            "ink-2",
                        ))
                        .child("Settled")
                        .child(threads.iter().filter(|t| t.settled).count().to_string())
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settled_open = !this.settled_open;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .pt(px(8.))
                        .flex()
                        .gap(px(8.))
                        .child(ui::icon("settings", "ink-2"))
                        .child("Settings"),
                ),
        )
}
