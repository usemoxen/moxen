use crate::ui::{self, Control};
use crate::{
    model::Status,
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(title_bar, [ToggleInspector, ToggleTasks]);

/// The Agent mark at the mockup's `size 16`: 16pt tall, its 3.84 × 2.84
/// viewBox keeps the width. The head is the square at (2.772, −0.228),
/// 0.456 wide, in a viewBox that starts at −0.42.
const MARK_H: f32 = 16.;
const MARK_SCALE: f32 = MARK_H / 2.84;

pub fn render(w: &Workspace, window: &Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let t = &w.source.list_threads()[w.selected];
    // Tasks and the inspector are fixtures until the server feeds them.
    let preview = w.source.preview();
    let head = |at: f32| (at + 0.42) * MARK_SCALE;
    div()
        .h(px(44.))
        .flex_shrink_0()
        .pl(px(16.))
        .pr(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_b_1()
        .border_color(color("rule"))
        .bg(color("ground"))
        .font_family(theme::FONT)
        // Room for the native traffic lights.
        .child(div().w(px(90.)).flex_shrink_0())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .child(
                    div()
                        .relative()
                        .flex_shrink_0()
                        .w(px(3.84 * MARK_SCALE))
                        .h(px(MARK_H))
                        .child(
                            svg()
                                .path("agent-mark")
                                .size_full()
                                .text_color(color("ink")),
                        )
                        .when(t.status == Status::Running && !w.creating, |s| {
                            s.child(
                                div()
                                    .absolute()
                                    .left(px(head(2.772) - 0.25))
                                    .top(px(head(-0.228) - 0.25))
                                    .size(px(0.456 * MARK_SCALE + 0.5))
                                    .bg(color("live")),
                            )
                        }),
                )
                .child(
                    div()
                        .pl(px(2.))
                        .flex_shrink_0()
                        .text_size(px(14.))
                        .line_height(px(18.))
                        .text_color(color("ink-2"))
                        .child(w.new_project_title().unwrap_or_else(|| t.project.clone())),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(color("ink-2"))
                        .opacity(0.6)
                        .child("/"),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(14.))
                        .line_height(px(18.))
                        .font_weight(FontWeight::BOLD)
                        .child(if w.creating {
                            "New thread".to_string()
                        } else {
                            t.title.clone()
                        }),
                ),
        )
        .child(div().flex_1())
        .child(
            div()
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(8.))
                .font_family(theme::MONO)
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(color(t.status.token()))
                .child(ui::state(t.status))
                .child(if t.status == Status::Running {
                    let seconds = t.started_at.map_or(0, |start| start.elapsed().as_secs());
                    format!("Working · {}m {:02}s", seconds / 60, seconds % 60)
                } else {
                    t.status.label().to_string()
                }),
        )
        .when(preview, |s| {
            s.child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("tasks-toggle")
                            .track_focus(&w.tips.tasks)
                            .shortcut("Show or hide tasks", "⌃T")
                            .flex_shrink_0()
                            .h(px(28.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(6.))
                            .when(w.inspector_open && w.tasks_open, |s| s.bg(color("sunk")))
                            .font_family(theme::MONO)
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(color("ink-2"))
                            .child("Tasks")
                            .child(div().text_color(color("ink")).child("3/6"))
                            .on_click(cx.listener(|_, _, window, cx| {
                                window.dispatch_action(Box::new(ToggleTasks), cx);
                            })),
                    )
                    .children(ui::focus_tip(
                        &w.tips.tasks,
                        window,
                        "Show or hide tasks",
                        "⌃T",
                        ui::Tip::BelowRight,
                    )),
            )
        })
        .when(preview, |s| {
            s.child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("inspector-toggle")
                            .track_focus(&w.tips.inspector)
                            .shortcut("Inspector", "⌘I")
                            .flex_shrink_0()
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .child(ui::icon("panel-right", "ink-2"))
                            .on_click(cx.listener(|_, _, window, cx| {
                                window.dispatch_action(Box::new(ToggleInspector), cx);
                            })),
                    )
                    .children(ui::focus_tip(
                        &w.tips.inspector,
                        window,
                        "Inspector",
                        "⌘I",
                        ui::Tip::BelowRight,
                    )),
            )
        })
}
