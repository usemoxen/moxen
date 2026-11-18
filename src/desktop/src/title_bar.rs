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

fn settled_badge_label() -> &'static str {
    if crate::language::spanish() {
        crate::language::message("status.idle")
    } else {
        "Done"
    }
}

pub fn render(w: &Workspace, window: &Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    // A new-thread draft carries no state of its own: while it is active the
    // title bar names only the project and the draft, never the open thread
    // behind it.
    let threads = w.source.list_threads();
    let thread = Workspace::shown_thread(w.creating, w.selected).and_then(|id| threads.get(id));
    let checklist = w.source.inspector(w.selected);
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
        .when(cfg!(target_os = "macos"), |s| {
            s.child(div().w(px(90.)).flex_shrink_0())
        })
        .when_some(w.source.paired_name(), |s, name| {
            s.child(div().text_color(color("live")).child(name))
        })
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
                        .when(thread.is_some_and(|t| t.status == Status::Running), |s| {
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
                        .child(match thread {
                            None => w
                                .new_project_title()
                                .unwrap_or_else(|| crate::language::tr("Project").into_owned()),
                            Some(t) => w.new_project_title().unwrap_or_else(|| {
                                let project = w.source.project_id(t.id);
                                w.thread_project_title(
                                    project.as_deref().unwrap_or(&t.project),
                                    &t.project,
                                )
                            }),
                        }),
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
                            crate::language::message("palette.newThread").into()
                        } else {
                            thread.map(|t| t.title.clone()).unwrap_or_default()
                        }),
                ),
        )
        .child(div().flex_1())
        .when_some(thread, |s, t| {
            s.child(
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
                        format!(
                            "{} · {}m {:02}s",
                            crate::language::tr("Working"),
                            seconds / 60,
                            seconds % 60
                        )
                    } else if t.status == Status::Idle {
                        settled_badge_label().to_owned()
                    } else {
                        crate::language::tr(t.status.label()).into_owned()
                    }),
            )
        })
        .when(!w.creating, |s| {
            s.child(crate::thread_view::actions_chip(w, cx))
        })
        .when(!w.creating && !checklist.tasks.is_empty(), |s| {
            s.child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("tasks-toggle")
                            .track_focus(&w.tips.tasks)
                            .shortcut("Show or hide tasks", crate::primary_key("⌃T", "Ctrl+T"))
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
                            .child(crate::language::tr("Tasks").into_owned())
                            .child(
                                div()
                                    .text_color(color("ink"))
                                    .child(crate::language::of_total(
                                        crate::work::completed(&checklist.tasks),
                                        checklist.tasks.len(),
                                    )),
                            )
                            .on_click(cx.listener(|_, _, window, cx| {
                                window.dispatch_action(Box::new(ToggleTasks), cx);
                            })),
                    )
                    .children(ui::focus_tip(
                        &w.tips.tasks,
                        window,
                        "Show or hide tasks",
                        crate::primary_key("⌃T", "Ctrl+T"),
                        ui::Tip::BelowRight,
                    )),
            )
        })
        .when(!w.creating, |s| {
            s.child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("inspector-toggle")
                            .track_focus(&w.tips.inspector)
                            .shortcut("Inspector", crate::primary_key("⌘I", "Ctrl+I"))
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
                        crate::primary_key("⌘I", "Ctrl+I"),
                        ui::Tip::BelowRight,
                    )),
            )
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_draft_presents_no_thread() {
        // The sidebar, title bar and status line read the draft through
        // `shown_thread`: while the draft is active nothing is selected, so
        // no state chip or usage pill draws for the thread behind it.
        assert_eq!(crate::workspace::Workspace::shown_thread(true, 2), None);
        assert_eq!(crate::workspace::Workspace::shown_thread(false, 2), Some(2));
    }

    #[test]
    fn settled_badge_keeps_the_english_desktop_label() {
        crate::language::apply(Some("en"), None);
        assert_eq!(super::settled_badge_label(), "Done");
        crate::language::apply(Some("es-ES"), None);
        assert_eq!(super::settled_badge_label(), "inactivo");
    }
}
