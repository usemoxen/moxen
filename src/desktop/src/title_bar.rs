use crate::{model::Status, theme::color, workspace::Workspace};
use gpui::{prelude::*, *};
actions!(title_bar, [ToggleInspector, ToggleTasks]);
pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let t = &w.source.list_threads()[w.selected];
    div()
        .h(px(44.))
        .flex_shrink_0()
        .px(px(16.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_b_1()
        .border_color(color("rule"))
        .bg(color("ground"))
        .child(div().w(px(90.)))
        .child(
            div()
                .relative()
                .size(px(20.))
                .child(
                    svg()
                        .path("agent-mark")
                        .size(px(20.))
                        .text_color(color("ink")),
                )
                .when(t.status == Status::Running, |s| {
                    s.child(
                        div()
                            .absolute()
                            .right(px(1.))
                            .top(px(4.))
                            .size(px(3.))
                            .bg(color("live")),
                    )
                }),
        )
        .child(
            div()
                .text_color(color("ink-2"))
                .child(format!("{}  /", t.project)),
        )
        .child(
            div()
                .font_weight(FontWeight::BOLD)
                .truncate()
                .child(t.title.clone()),
        )
        .child(div().flex_1())
        .child(
            div()
                .text_size(px(12.))
                .text_color(color(t.status.token()))
                .child(if t.status == Status::Running {
                    "◐ Working · 4m 12s".to_string()
                } else {
                    format!("{} {}", t.status.glyph(), t.status.label())
                }),
        )
        .child(
            div()
                .id("tasks-toggle")
                .px(px(8.))
                .rounded(px(6.))
                .bg(color("sunk"))
                .text_size(px(12.))
                .cursor_pointer()
                .child("Tasks 3/6")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.tasks_open = !this.tasks_open;
                    this.inspector_open = true;
                    cx.notify();
                })),
        )
        .child(
            div()
                .id("inspector-toggle")
                .px(px(8.))
                .cursor_pointer()
                .child("◫")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.inspector_open = !this.inspector_open;
                    cx.notify();
                })),
        )
}
