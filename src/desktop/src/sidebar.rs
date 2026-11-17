use crate::ui::{self, Control};
use crate::{
    model::{Thread, ThreadId},
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(sidebar, [PreviousThread, NextThread]);

/// A sidebar row (`.row` in the mockup): 30pt, 13.5px Next, meta in Mono.
fn row(id: impl Into<ElementId>, tooltip: impl Into<SharedString>) -> Stateful<Div> {
    div()
        .id(id)
        .control(tooltip)
        .h(px(theme::ROW))
        .flex_shrink_0()
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(6.))
        .text_size(px(13.5))
        .line_height(px(17.5))
}
fn meta(text: impl Into<SharedString>) -> Div {
    div()
        .flex_shrink_0()
        .font_family(theme::MONO)
        .text_size(px(11.5))
        .text_color(color("ink-2"))
        .child(text.into())
}

/// Two letters for a project's badge: the initials of its first two words,
/// or for a one-word name the TUI's chip (`projectBadge`).
fn badge(project: &str) -> String {
    let words: Vec<char> = project
        .split(['-', '_', ' '])
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect();
    if words.len() == 2 {
        words.into_iter().collect::<String>().to_uppercase()
    } else {
        crate::live::project_badge(project)
    }
}

/// The threads the sidebar lists, in order: grouped or flat, without settled
/// ones while that section is closed, and in "This project" only the
/// selected thread's project.
pub fn visible(w: &Workspace, threads: &[Thread]) -> Vec<ThreadId> {
    let project = threads.get(w.selected).map(|t| t.project.as_str());
    w.source
        .order(w.group != 0)
        .into_iter()
        .filter(|&i| {
            let t = &threads[i];
            (!t.settled || w.settled_open) && (w.group != 2 || Some(t.project.as_str()) == project)
        })
        .collect()
}

/// Moves the selection `step` rows through what the sidebar lists.
fn step(w: &mut Workspace, step: isize, cx: &mut Context<Workspace>) {
    let threads = w.source.list_threads();
    let listed = visible(w, &threads);
    let at = listed.iter().position(|&i| i == w.selected).unwrap_or(0) as isize;
    if let Some(&next) = listed.get((at + step).clamp(0, listed.len() as isize - 1) as usize) {
        w.select(next, cx);
    }
}

pub fn render(w: &Workspace, window: &Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let threads = w.source.list_threads();
    let listed = w.source.order(false);
    let mut rows = div()
        .id("thread-scroll")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(8.))
        .pt(px(4.))
        .pb(px(12.))
        .flex()
        .flex_col();
    let mut projects: Vec<&str> = vec![];
    let mut nested: Option<Div> = None;
    for i in visible(w, &threads) {
        let t = &threads[i];
        if t.depth == 0
            && let Some(group) = nested.take()
        {
            rows = rows.child(group);
        }
        if w.group != 0 && !projects.contains(&t.project.as_str()) {
            let first = projects.is_empty();
            let label = ["label-2", "label-6", "label-4", "label-3"][projects.len() % 4];
            projects.push(&t.project);
            let count = listed
                .iter()
                .map(|&o| &threads[o])
                .filter(|o| o.project == t.project && o.depth == 0 && !o.settled)
                .count();
            rows = rows.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(10.))
                    .pt(px(if first { 10. } else { 16. }))
                    .pb(px(6.))
                    .child(
                        div()
                            .px(px(4.))
                            .py(px(3.))
                            .rounded(px(theme::px_token("radius", "radius-xs")))
                            .bg(color(label))
                            .font_family(theme::MONO)
                            .text_size(px(10.))
                            .line_height(px(10.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(color("on-ink"))
                            .child(badge(&t.project)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .line_height(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child(t.project.clone()),
                    )
                    .child(meta(count.to_string())),
            );
        }
        let selected = w.selected == i;
        let thread_row = row(("thread", i), t.title.clone())
            .when(t.depth > 0, |s| {
                s.h(px(26.)).text_size(px(12.5)).text_color(color("ink-2"))
            })
            .when(selected, |s| {
                s.bg(color("sunk")).shadow(vec![BoxShadow {
                    inset: true,
                    color: color("live"),
                    offset: point(px(2.), px(0.)),
                    blur_radius: px(0.),
                    spread_radius: px(0.),
                }])
            })
            .child(ui::state(t.status))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .when(selected, |s| s.text_color(color("ink")))
                    .child(t.title.clone()),
            )
            .child(meta(t.activity.clone()))
            .on_click(cx.listener(move |this, _, window, cx| {
                window.focus(&this.sidebar_focus, cx);
                this.select(i, cx);
            }));
        if t.depth > 0 {
            // Subthreads hang off a hairline under their parent; no tree lines.
            let group = nested.take().unwrap_or_else(|| {
                div()
                    .ml(px(17.))
                    .pl(px(6.))
                    .border_l_1()
                    .border_color(color("rule"))
                    .flex()
                    .flex_col()
            });
            nested = Some(group.child(thread_row));
        } else {
            rows = rows.child(thread_row);
        }
    }
    if let Some(group) = nested {
        rows = rows.child(group);
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
        .on_action(cx.listener(|this, _: &PreviousThread, _, cx| step(this, -1, cx)))
        .on_action(cx.listener(|this, _: &NextThread, _, cx| step(this, 1, cx)))
        .child(
            div()
                .pt(px(12.))
                .px(px(12.))
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
                                .id("jump-search")
                                .track_focus(&w.tips.jump)
                                .shortcut("Jump to thread or action", "⌘K")
                                .on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.open_palette(window, cx)
                                    }),
                                )
                                .flex_1()
                                .min_w_0()
                                .h(px(30.))
                                .pl(px(10.))
                                .pr(px(6.))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .border_1()
                                .border_color(color("rule"))
                                .rounded(px(theme::px_token("radius", "radius-md")))
                                .bg(color("raised"))
                                .text_size(px(13.))
                                .text_color(color("ink-2"))
                                .child(ui::icon("search", "ink-2"))
                                .child(div().flex_1().min_w_0().truncate().child("Jump to thread…"))
                                .child(ui::kbd("⌘K"))
                                .children(ui::focus_tip(
                                    &w.tips.jump,
                                    window,
                                    "Jump to thread or action",
                                    "⌘K",
                                    ui::Tip::BelowLeft,
                                )),
                        )
                        .child(
                            div()
                                .id("new-thread")
                                .control("New thread in this project")
                                .size(px(30.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(6.))
                                .child(ui::icon("square-pen", "ink-2"))
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.new_thread(window, cx)),
                                ),
                        ),
                )
                .child(ui::segmented(
                    "group",
                    &["All", "Projects", "This project"],
                    w.group,
                    11.,
                    cx,
                    |this, i| this.group = i,
                )),
        )
        .child(rows)
        .child(
            div()
                .border_t_1()
                .border_color(color("rule"))
                .p(px(8.))
                .flex()
                .flex_col()
                .text_color(color("ink-2"))
                .child(
                    row("settled-toggle", "Show settled threads")
                        .child(
                            div()
                                .size(px(14.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(ui::icon(
                                    if w.settled_open {
                                        "chevron-down"
                                    } else {
                                        "chevron-right"
                                    },
                                    "ink-2",
                                )),
                        )
                        .child(div().flex_1().child("Settled"))
                        .child(meta(
                            listed
                                .iter()
                                .filter(|&&i| threads[i].settled)
                                .count()
                                .to_string(),
                        ))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settled_open = !this.settled_open;
                            cx.notify();
                        })),
                )
                .child(
                    row("stats", "Usage across every thread and provider")
                        .child(ui::icon("circle-gauge", "ink-2"))
                        .child(div().flex_1().child("Stats"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.open_stats(cx);
                        })),
                )
                .child(
                    row("settings", "Settings are unavailable in this preview")
                        .cursor(CursorStyle::Arrow)
                        .child(ui::icon("settings", "ink-2"))
                        .child(div().flex_1().child("Settings"))
                        .child(ui::kbd("⌘,")),
                ),
        )
}
