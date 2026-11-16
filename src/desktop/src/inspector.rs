use crate::theme::TypeScale;
use crate::ui::{self, Control};
use crate::{
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let data = w.source.inspector(w.selected);
    let mut pane = div()
        .id("inspector-scroll")
        .relative()
        .w(px(w.inspector_width))
        .h_full()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .overflow_y_scroll()
        .line_height(px(18.2))
        .bg(color("ground"))
        .border_l_1()
        .border_color(color("rule"));
    pane = pane.child(
        div()
            .id("inspector-resize")
            .absolute()
            .left_0()
            .top_0()
            .w(px(5.))
            .h_full()
            .cursor(CursorStyle::ResizeLeftRight)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.resizing_inspector = true),
            ),
    );
    if w.tasks_open {
        let tasks = data.tasks;
        pane = pane.child(
            div()
                .p(px(16.))
                .pb(px(8.))
                .flex()
                .gap(px(10.))
                .items_center()
                .text_size(px(13.))
                .child(div().type_scale("title").child("Tasks"))
                .child(
                    div()
                        .text_color(color("ink-2"))
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .child("3 of 6"),
                )
                .child(div().flex_1().flex().gap(px(3.)).children((0..6).map(|i| {
                    div().flex_1().h(px(3.)).bg(color(if i < 3 {
                        "ink-2"
                    } else if i == 3 {
                        "live"
                    } else {
                        "rule"
                    }))
                }))),
        );
        pane = pane.child(div().px(px(8.)).pb(px(12.)).children(
            tasks.into_iter().enumerate().map(|(i, t)| {
                div()
                    .flex()
                    .gap(px(10.))
                    .p(px(8.))
                    .py(px(5.))
                    .rounded(px(6.))
                    .text_size(px(13.))
                    .line_height(px(18.2))
                    .when(i == 3, |s| s.bg(color("sunk")))
                    .child(
                        div()
                            .text_color(color(if i == 3 { "live" } else { "ink-2" }))
                            .child(ui::state(if i < 3 {
                                crate::model::Status::Idle
                            } else if i == 3 {
                                crate::model::Status::Running
                            } else {
                                crate::model::Status::Queued
                            })),
                    )
                    .child(div().flex_1().min_w_0().child(t))
                    .child(
                        div()
                            .flex_shrink_0()
                            .font_family(theme::MONO)
                            .text_size(px(11.5))
                            .text_color(color("ink-2"))
                            .child(["42m", "1h 10m", "2h 3m", "38m", "", ""][i]),
                    )
            }),
        ));
    }
    pane = pane.child(
        div()
            .px(px(16.))
            .border_y_1()
            .border_color(color("rule"))
            .flex()
            .gap(px(16.))
            .children(
                ["Diff 2", "Git", "Context 66%", "Agents 5", "Background"]
                    .into_iter()
                    .enumerate()
                    .map(|(i, t)| {
                        div()
                            .id(("tab", i))
                            .control(t)
                            .py(px(8.))
                            .border_b_2()
                            .border_color(color(if w.tab == i { "ink" } else { "ground" }))
                            .font_family(theme::MONO)
                            .text_size(px(12.))
                            .text_color(color(if w.tab == i { "ink" } else { "ink-2" }))
                            .cursor_pointer()
                            .child(t)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tab = i;
                                cx.notify();
                            }))
                    }),
            ),
    );
    if w.tab == 2 {
        return pane.child(crate::usage::render());
    }
    if w.tab != 1 && w.tab != 0 {
        return pane.child(
            div()
                .p(px(24.))
                .text_color(color("ink-2"))
                .child("Nothing to show yet."),
        );
    }
    pane.child(
        div()
            .p(px(16.))
            .border_b_1()
            .border_color(color("rule"))
            .flex()
            .justify_between()
            .text_size(px(12.))
            .text_color(color("ink-2"))
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(ui::icon("chevron-left", "ink-2"))
                    .child("Commits"),
            )
            .child(
                div()
                    .flex()
                    .gap(px(12.))
                    .child("5a7bee1")
                    .child(ui::icon("copy", "ink-2"))
                    .child(ui::icon("external-link", "ink-2"))
                    .child(ui::icon("maximize", "ink-2")),
            ),
    )
    .child(
        div()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .type_scale("title")
                    .text_size(px(16.))
                    .child(data.subject),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .child(
                        div()
                            .size(px(24.))
                            .rounded_full()
                            .bg(color("sunk"))
                            .border_1()
                            .border_color(color("rule"))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(9.))
                            .type_scale("title")
                            .child("AM"),
                    )
                    .child(data.author),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(chip("opencode-v2"))
                            .child(chip("parent 86553cd")),
                    )
                    .child(div().flex().child(chip("co-authored by Claude Opus 5.5"))),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .line_height(px(22.))
                    .child(data.message),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(color("ink-2"))
                    .child("Show the full message"),
            )
            .child(
                div()
                    .pt(px(8.))
                    .flex()
                    .justify_between()
                    .font_family(theme::MONO)
                    .text_size(px(11.5))
                    .text_color(color("ink-2"))
                    .child("FILES")
                    .child("3 · +68 −9"),
            ),
    )
    .children(
        data.files
            .into_iter()
            .enumerate()
            .map(|(i, (file, delta))| {
                let (added, removed) = delta.split_once(' ').unwrap_or((&delta, ""));
                let open = w.expanded_files.contains(&i);
                div()
                    .child(
                        div()
                            .id(("git-file", i))
                            .control(file.clone())
                            .px(px(16.))
                            .py(px(7.))
                            .flex()
                            .gap(px(8.))
                            .text_size(px(12.5))
                            .font_family(theme::MONO)
                            .items_center()
                            .child(ui::icon(
                                if open {
                                    "chevron-down"
                                } else {
                                    "chevron-right"
                                },
                                "ink-2",
                            ))
                            .child(div().flex_1().truncate().child(format!("src/{file}")))
                            .when(i == 0, |s| s.child(chip("new")))
                            .child(div().text_color(color("added")).child(added.to_string()))
                            .child(div().text_color(color("broken")).child(removed.to_string()))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.expanded_files.remove(&i) {
                                    this.expanded_files.insert(i);
                                }
                                cx.notify();
                            })),
                    )
                    .when(open, |s| s.child(crate::diff::render(i)))
            }),
    )
}
fn chip(label: &'static str) -> impl IntoElement {
    div()
        .px(px(6.))
        .py(px(2.))
        .rounded(px(3.))
        .bg(color("sunk"))
        .font_family(theme::MONO)
        .text_size(px(11.5))
        .line_height(px(14.))
        .text_color(color("ink-2"))
        .child(label)
}
