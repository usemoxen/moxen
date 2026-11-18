use crate::ui::{self, Control};
use crate::{
    model::Status,
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

const TABS: [&str; 5] = ["Diff", "Git", "Context", "Agents", "Background"];

/// The `.ib` icon button: 28pt square, 6pt corners.
fn icon_button(id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
}

/// `Delta`: added and removed line counts in Mono.
pub fn delta(text: &str) -> Div {
    let (added, removed) = text.split_once(' ').unwrap_or((text, ""));
    div()
        .flex_shrink_0()
        .flex()
        .gap(px(6.))
        .font_family(theme::MONO)
        .text_size(px(12.))
        .child(div().text_color(color("added")).child(added.to_string()))
        .child(div().text_color(color("broken")).child(removed.to_string()))
}

fn tasks(
    id: crate::model::ThreadId,
    tasks: &[crate::work::Step],
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let done = crate::work::completed(tasks);
    div()
        .flex_shrink_0()
        .border_b_1()
        .border_color(color("rule"))
        .child(
            div()
                .id("tasks-header")
                .shortcut("Hide tasks", "⌃T")
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(16.))
                .pt(px(12.))
                .pb(px(10.))
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(13.))
                        .font_weight(FontWeight::BOLD)
                        .child(crate::language::tr("Tasks").into_owned()),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(12.))
                        .text_color(color("ink-2"))
                        .child(format!("{done} of {}", tasks.len())),
                )
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .gap(px(3.))
                        .px(px(4.))
                        .children(tasks.iter().map(|step| {
                            div()
                                .flex_1()
                                .h(px(3.))
                                .rounded(px(2.))
                                .bg(color(match step.status {
                                    Status::Idle => "ink-2",
                                    Status::Running => "live",
                                    _ => "rule",
                                }))
                        })),
                )
                .on_click(cx.listener(|_, _, window, cx| {
                    window.dispatch_action(Box::new(crate::title_bar::ToggleTasks), cx)
                })),
        )
        .child(
            div()
                .id(("checklist", id))
                .max_h(px(224.))
                .overflow_y_scroll()
                .px(px(8.))
                .pb(px(10.))
                .flex()
                .flex_col()
                .gap(px(1.))
                .children(tasks.iter().map(|step| {
                    let live = step.status == Status::Running;
                    div()
                        .flex()
                        .items_start()
                        .gap(px(10.))
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(6.))
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(color(if step.status == Status::Idle {
                            "ink-2"
                        } else {
                            "ink"
                        }))
                        .when(live, |s| s.bg(color("sunk")))
                        .child(div().pt(px(2.)).child(ui::state(step.status)))
                        .child(div().flex_1().min_w_0().child(step.title.clone()))
                })),
        )
}

fn tabs(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let info = w.source.delegated(w.selected).is_some();
    div()
        .flex_shrink_0()
        .pt(px(12.))
        .pl(px(16.))
        .pr(px(12.))
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(16.))
                .border_b_1()
                .border_color(color("rule"))
                .children(TABS.into_iter().enumerate().map(|(i, label)| {
                    let count = match i {
                        0 => w.source.turn_diffs(w.selected).len(),
                        1 => w.source.git(w.selected).requests.len(),
                        3 if !info => crate::work_view::agent_count(w),
                        4 => crate::work_view::background_count(w),
                        _ => 0,
                    };
                    let label = if i == 3 && info { "Info" } else { label };
                    let on = w.tab == i;
                    div()
                        .id(("tab", i))
                        .quiet()
                        .pb(px(8.))
                        .mb(px(-1.))
                        .flex()
                        .gap(px(5.))
                        .items_baseline()
                        .border_b_2()
                        .border_color(if on {
                            color("ink")
                        } else {
                            gpui::transparent_black()
                        })
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .text_color(color(if on { "ink" } else { "ink-2" }))
                        .when(on, |s| s.font_weight(FontWeight::SEMIBOLD))
                        .child(crate::language::tr(label).into_owned())
                        .when(count > 0, |s| {
                            s.child(
                                div()
                                    .font_family(theme::MONO)
                                    .font_weight(FontWeight::NORMAL)
                                    .text_size(px(11.5))
                                    .text_color(color("ink-2"))
                                    .child(count.to_string()),
                            )
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.tab = i;
                            cx.notify();
                        }))
                })),
        )
}

pub fn render(w: &Workspace, width: f32, cx: &mut Context<Workspace>) -> impl IntoElement {
    let mut pane = div()
        .id("inspector")
        .relative()
        .w(px(width))
        .h_full()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .bg(color("ground"))
        .border_l_1()
        .border_color(color("rule"))
        .child(
            div()
                .id("inspector-resize")
                .absolute()
                .left(px(-3.))
                .top_0()
                .w(px(6.))
                .h_full()
                .cursor(CursorStyle::ResizeLeftRight)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _, _| this.resizing_inspector = true),
                ),
        );
    let checklist = w.source.inspector(w.selected);
    if !w.creating && w.tasks_open && !checklist.tasks.is_empty() {
        pane = pane.child(tasks(w.selected, &checklist.tasks, cx));
    }
    pane = pane.child(tabs(w, cx));
    let body = div()
        .id(("inspector-scroll", w.tab))
        .flex_1()
        .min_h_0()
        .overflow_y_scroll();
    if w.tab == 2 {
        return pane.child(body.child(if w.source.preview() {
            crate::usage::render().into_any_element()
        } else {
            crate::work_view::notice("Context usage is not available here yet.").into_any_element()
        }));
    }
    if w.tab > 2 {
        return pane.child(
            body.track_focus(&w.work_focus)
                .child(crate::work_view::render(w, cx)),
        );
    }
    if w.tab == 0 {
        return pane.child(body.child(crate::git_view::diff_tab(w, cx)));
    }
    let git = w.source.git(w.selected);
    if let Some(commit) = &git.commit {
        return pane
            .child(crate::git_view::commit_header(commit, cx).child(widen(cx)))
            .child(body.child(crate::git_view::commit_tab(w, commit, cx)));
    }
    pane.child(body.child(crate::git_view::git_tab(w, cx)))
        .children(crate::git_view::footer(w))
}

/// The button that widens the pane for reading a patch, and narrows it again.
fn widen(cx: &mut Context<Workspace>) -> Stateful<Div> {
    icon_button("widen-diff")
        .control("Widen")
        .child(ui::icon("maximize", "ink-2"))
        .on_click(cx.listener(|this, _, _, cx| {
            this.inspector_width = if this.inspector_width > theme::INSPECTOR {
                theme::INSPECTOR
            } else {
                620.
            };
            cx.notify();
        }))
}
