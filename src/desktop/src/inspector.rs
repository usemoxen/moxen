use crate::ui::{self, Control};
use crate::{
    model::Status,
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

const TABS: [(&str, &str); 5] = [
    ("Diff", ""),
    ("Git", ""),
    ("Context", "66%"),
    ("Agents", "5"),
    ("Background", ""),
];
const TASK_TIMES: [&str; 6] = ["42m", "1h 10m", "2h 3m", "38m", "", ""];
/// Task 3 is the running one; those before it are done.
const LIVE_TASK: usize = 3;

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

fn tasks(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let tasks = w.source.inspector(w.selected).tasks;
    let state = |i: usize| match i {
        _ if i < LIVE_TASK => Status::Idle,
        LIVE_TASK => Status::Running,
        _ => Status::Queued,
    };
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
                        .child("Tasks"),
                )
                .child(
                    div()
                        .font_family(theme::MONO)
                        .text_size(px(11.5))
                        .line_height(px(12.))
                        .text_color(color("ink-2"))
                        .child(format!("{LIVE_TASK} of {}", tasks.len())),
                )
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .gap(px(3.))
                        .px(px(4.))
                        .children((0..tasks.len()).map(|i| {
                            div()
                                .flex_1()
                                .h(px(3.))
                                .rounded(px(2.))
                                .bg(color(match state(i) {
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
                .px(px(8.))
                .pb(px(10.))
                .flex()
                .flex_col()
                .gap(px(1.))
                .children(tasks.into_iter().enumerate().map(|(i, t)| {
                    let live = state(i) == Status::Running;
                    div()
                        .flex()
                        .items_start()
                        .gap(px(10.))
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(6.))
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(color(if state(i) == Status::Idle {
                            "ink-2"
                        } else {
                            "ink"
                        }))
                        .when(live, |s| s.bg(color("sunk")))
                        .child(div().pt(px(2.)).child(ui::state(state(i))))
                        .child(div().flex_1().min_w_0().child(t))
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_family(theme::MONO)
                                .text_size(px(11.5))
                                .text_color(color(if live { "live" } else { "ink-2" }))
                                .child(TASK_TIMES.get(i).copied().unwrap_or("")),
                        )
                })),
        )
}

fn tabs(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    div()
        .flex_shrink_0()
        .pt(px(12.))
        .pl(px(16.))
        .pr(px(12.))
        .child(
            div()
                .flex()
                .gap(px(16.))
                .border_b_1()
                .border_color(color("rule"))
                .children(TABS.into_iter().enumerate().map(|(i, (label, fixed))| {
                    // Diff counts the turns that changed files; Git, the open requests.
                    let count = match i {
                        0 => Some(w.source.turn_diffs(w.selected).len()),
                        1 => Some(w.source.git(w.selected).requests.len()),
                        _ => None,
                    }
                    .filter(|n| *n > 0)
                    .map_or_else(|| fixed.to_string(), |n| n.to_string());
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
                        .child(label)
                        .when(!count.is_empty(), |s| {
                            s.child(
                                div()
                                    .font_family(theme::MONO)
                                    .font_weight(FontWeight::NORMAL)
                                    .text_size(px(11.5))
                                    .text_color(color("ink-2"))
                                    .child(count.clone()),
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
    if w.tasks_open {
        pane = pane.child(tasks(w, cx));
    }
    pane = pane.child(tabs(w, cx));
    let body = div()
        .id("inspector-scroll")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll();
    if w.tab == 2 {
        return pane.child(body.child(crate::usage::render()));
    }
    if w.tab > 2 {
        return pane.child(
            body.child(
                div()
                    .px(px(24.))
                    .py(px(48.))
                    .text_center()
                    .text_size(px(13.5))
                    .line_height(px(20.))
                    .text_color(color("ink-2"))
                    .child(if w.tab == 3 {
                        "No agents in this preview."
                    } else {
                        "Nothing is running in the background. Commands the agent leaves running show here, with their output."
                    }),
            ),
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
