use crate::ui::{self, Control};
use crate::{
    model::{Thread, ThreadId},
    theme::{self, color},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(sidebar, [PreviousThread, NextThread]);

/// A sidebar row (`.row` in the mockup): 30pt, 13.5px Next, meta in Mono.
fn row(id: impl Into<ElementId>) -> Stateful<Div> {
    div()
        .id(id)
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
    let project = w
        .source
        .project_id(w.selected)
        .or_else(|| threads.get(w.selected).map(|t| t.project.clone()));
    w.source
        .order(w.group != 0)
        .into_iter()
        .filter(|&i| {
            let t = &threads[i];
            let pid = w.source.project_id(i).unwrap_or_else(|| t.project.clone());
            w.source
                .sidebar_section(i)
                .is_some_and(|settled| !settled || w.settled_open)
                && (w.group != 2 || Some(pid) == project)
        })
        .collect()
}

/// Moves the selection `step` rows through what the sidebar lists.
fn step(w: &mut Workspace, step: isize, cx: &mut Context<Workspace>) {
    let threads = w.source.list_threads();
    let listed = visible(w, &threads);
    if listed.is_empty() {
        return;
    }
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
        .flex_col()
        .on_scroll(cx.listener(|this, _: &ScrollEvent, _, cx| {
            // Scrolling moves the rows the tip names by its window Y, so a
            // kept tip would point at another thread's title.
            this.clear_thread_tip();
            cx.notify();
        }));
    let mut projects: Vec<String> = vec![];
    let mut nested: Option<Div> = None;
    for i in visible(w, &threads) {
        let t = &threads[i];
        if t.depth == 0
            && let Some(group) = nested.take()
        {
            rows = rows.child(group);
        }
        // Group headers carry the project id: titles repeat for two checkouts
        // with the same basename, so resolving by title would hit the wrong one.
        let pid = w.source.project_id(i).unwrap_or_else(|| t.project.clone());
        let title = w
            .source
            .projects()
            .into_iter()
            .find(|project| project.id == pid)
            .map(|project| project.title)
            .unwrap_or_else(|| t.project.clone());
        if w.group != 0 && !projects.contains(&pid) {
            let first = projects.is_empty();
            let label = ["label-2", "label-6", "label-4", "label-3"][projects.len() % 4];
            projects.push(pid.clone());
            let count = listed
                .iter()
                .filter(|&&j| {
                    w.source
                        .project_id(j)
                        .unwrap_or_else(|| threads[j].project.clone())
                        == pid
                        && threads[j].depth == 0
                        && w.source.sidebar_section(j) == Some(false)
                })
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
                            .child(badge(&title)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .line_height(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child(title.clone()),
                    )
                    .child(meta(count.to_string()))
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.open_project_menu(&pid, event.position, window, cx);
                        }),
                    ),
            );
        }
        let selected = w.selected == i;
        let menu_open =
            w.thread_popup.is_some() || w.dropdown == Some(crate::workspace::Dropdown::Thread);
        // A click selects the row, which drops its tip; only a truncated
        // title earns one at all.
        let hoverable = row_tip(
            &t.title,
            title_truncated(window, &t.title, &t.activity, t.depth),
            selected,
            menu_open,
        )
        .is_some();
        let thread_row = row(("thread", i)).plain_control();
        let thread_row = if hoverable {
            thread_row
                .on_hover(cx.listener(move |this, hovering, _, cx| {
                    if !hovering && this.thread_tip.is_some_and(|(id, _)| id == i) {
                        this.thread_tip = None;
                        cx.notify();
                    }
                }))
                .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                    let at = Some((i, f32::from(event.position.y)));
                    if this.thread_tip != at {
                        this.thread_tip = at;
                        let threads = this.source.list_threads();
                        this.thread_tip_order = visible(this, &threads);
                        cx.notify();
                    }
                }))
        } else {
            thread_row
        };
        let thread_row = thread_row
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
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    this.open_thread_menu(i, event.position, None, window, cx);
                }),
            )
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
                    row("settled-toggle")
                        .control("Show settled threads")
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
                                .filter(|&&i| {
                                    w.source.sidebar_section(i) == Some(true)
                                        && threads[i].depth == 0
                                })
                                .count()
                                .to_string(),
                        ))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settled_open = !this.settled_open;
                            cx.notify();
                        })),
                )
                .when(!w.source.archived().is_empty(), |s| {
                    s.child(
                        row("archived-toggle")
                            .control("Show archived threads")
                            .child(ui::icon("clock", "ink-2"))
                            .child(div().flex_1().child("Archived"))
                            .child(meta(w.source.archived().len().to_string()))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_thread_form(
                                    crate::thread_actions::Form::Archived,
                                    window,
                                    cx,
                                );
                            })),
                    )
                })
                .child(
                    div()
                        .id("stats")
                        .quiet()
                        .h(px(theme::ROW))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .rounded(px(6.))
                        .text_size(px(13.5))
                        .line_height(px(17.5))
                        .child(ui::icon("circle-gauge", "ink-2"))
                        .child(div().flex_1().child("Stats"))
                        .on_hover(cx.listener(|this, hovering, _, cx| {
                            this.stats_tip = *hovering;
                            cx.notify();
                        }))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.open_stats(cx);
                        })),
                )
                .child(
                    row("settings")
                        .shortcut("Settings", "⌘,")
                        .child(ui::icon("settings", "ink-2"))
                        .child(div().flex_1().child("Settings"))
                        .child(ui::kbd("⌘,"))
                        .on_click(
                            cx.listener(|this, _, window, cx| this.open_settings(window, cx)),
                        ),
                ),
        )
}

/// The activity stamp's width in a thread row, shaped in Mono 11.5 the same
/// way the title is shaped. A `chars().count()` estimate lands a couple of
/// pixels off either way, which tips rows that fit and misses rows that
/// are cut off.
fn activity_width(window: &Window, activity: &str) -> f32 {
    let mut style = window.text_style();
    style.font_family = theme::MONO.into();
    let run = style.to_run(activity.len());
    f32::from(
        window
            .text_system()
            .shape_line(activity.into(), px(11.5), &[run], None)
            .width(),
    )
}

/// Whether the row's title overflows the truncated label it is drawn in, so
/// hovering the row earns the full title beside it. The label is the sidebar
/// minus its chrome, the state glyph, the gaps and the activity stamp (plus
/// the subthread indent); the title is measured with the window's text
/// system at the row's size.
fn title_truncated(window: &Window, title: &str, activity: &str, depth: usize) -> bool {
    let size = if depth > 0 { 12.5 } else { 13.5 };
    // The row draws the title in the interface font and the stamp in Mono:
    // shape both in those families, or the comparison drifts ~10px from
    // what `.truncate()` lays out. `window.text_style()` is the window
    // default, not the row's style, so set the families explicitly.
    let mut title_style = window.text_style();
    title_style.font_family = theme::FONT.into();
    let title_run = title_style.to_run(title.len());
    let width = f32::from(
        window
            .text_system()
            .shape_line(title.into(), px(size), &[title_run], None)
            .width(),
    );
    let indent = if depth > 0 { 24. } else { 0. };
    width > theme::SIDEBAR - 16. - 20. - 14. - 16. - indent - activity_width(window, activity) - 1.
}

/// Whether the sidebar row shows its full title beside it: never for the
/// selected row (a click would leave the tip lingering over the rows
/// below), while a menu is open, or when the title fits its label — only a
/// truncated title needs the full text.
fn row_tip(title: &str, truncated: bool, selected: bool, menu_open: bool) -> Option<&str> {
    if truncated && !selected && !menu_open {
        Some(title)
    } else {
        None
    }
}

/// Keeps the sidebar row tip only while the listed rows are the ones it was
/// taken against (`order` in `sync_threads`). A delete, collapse, regroup or
/// reorder moves the rows, so the stored window Y would point at another
/// thread's title.
pub fn retain_tip(
    tip: Option<(ThreadId, f32)>,
    listed: &[ThreadId],
    now: &[ThreadId],
) -> Option<(ThreadId, f32)> {
    match tip {
        Some(kept) if listed == now => Some(kept),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{retain_tip, row_tip};

    #[test]
    fn the_tip_shows_a_truncated_title_and_nothing_else() {
        assert_eq!(
            row_tip("a very long thread title", true, false, false),
            Some("a very long thread title")
        );
        assert_eq!(row_tip("short", false, false, false), None);
    }

    #[test]
    fn selecting_the_row_or_opening_a_menu_drops_the_tip() {
        assert_eq!(row_tip("a very long thread title", true, true, false), None);
        assert_eq!(row_tip("a very long thread title", true, false, true), None);
    }

    #[test]
    fn the_tip_clears_whenever_the_listed_rows_change() {
        let tip = Some((3, 240.));
        let listed = vec![0, 1, 2, 3];
        assert_eq!(retain_tip(tip, &listed, &listed), tip);
        // A reorder moves the rows under the stored Y.
        assert_eq!(retain_tip(tip, &listed, &[0, 2, 1, 3]), None);
        // A delete drops the hovered row's place; a collapse or regroup
        // lists fewer rows; a new thread lists more.
        assert_eq!(retain_tip(tip, &listed, &[0, 1, 2]), None);
        assert_eq!(retain_tip(tip, &listed, &[0, 1]), None);
        assert_eq!(retain_tip(tip, &listed, &[0, 1, 2, 3, 4]), None);
        assert_eq!(retain_tip(None, &listed, &listed), None);
    }
}
