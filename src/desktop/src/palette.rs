use crate::{
    model::{SearchState, Status, ThreadId},
    search::hit_meta,
    theme::color,
    thread_actions::{self, Form, Item},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};
actions!(palette, [OpenPalette, Dismiss, NextFocus, PreviousFocus]);

enum Pick {
    Action(Item),
    Archived,
    Thread(ThreadId, Status),
    Found(ThreadId),
    RenameProject(String),
    RemoveProject(String),
    StartResearch,
    SingleResearch,
    Experience(crate::experience::Panel),
}

enum Row {
    Header(String),
    Pick(String, Option<String>, Pick),
    Note(String),
}

fn matches(w: &Workspace, query: &str) -> Vec<Row> {
    let query = query.trim().to_lowercase();
    // The run-size question waits: answering it comes first, as the TUI's
    // modal does.
    let mut answers = vec![];
    if !w.creating
        && let Some(proposal) = w.source.proposal(w.selected)
    {
        answers.push(Row::Pick(
            format!(
                "Start research run ({} researchers, {} critic{})",
                proposal.size.researchers,
                proposal.size.critics,
                if proposal.size.critics == 1 { "" } else { "s" },
            ),
            Some(proposal.task.clone()),
            Pick::StartResearch,
        ));
        answers.push(Row::Pick(
            "Run one researcher instead".into(),
            None,
            Pick::SingleResearch,
        ));
    }
    if query.is_empty() {
        let mut rows = answers;
        rows.extend(actions_and_threads(w, ""));
        return rows;
    }
    let mut rows = vec![];
    // Full-text matches, active threads above settled ones, as the TUI's
    // search picker sections them.
    match w.source.search_state() {
        SearchState::Done(found) => {
            let active: Vec<_> = found
                .active()
                .into_iter()
                .filter_map(|row| {
                    w.source.thread_at_uuid(&row.uuid).map(|id| {
                        let hit = row.hits.first().map(|hit| hit_meta(hit, row.hit_count));
                        (row.title.clone(), hit, Pick::Found(id))
                    })
                })
                .collect();
            let settled: Vec<_> = found
                .settled()
                .into_iter()
                .filter_map(|row| {
                    w.source.thread_at_uuid(&row.uuid).map(|id| {
                        let hit = row.hits.first().map(|hit| hit_meta(hit, row.hit_count));
                        (row.title.clone(), hit, Pick::Found(id))
                    })
                })
                .collect();
            if !active.is_empty() {
                rows.push(Row::Header("Active".into()));
                rows.extend(
                    active
                        .into_iter()
                        .map(|(title, meta, pick)| Row::Pick(title, meta, pick)),
                );
            }
            if !settled.is_empty() {
                rows.push(Row::Header("Settled".into()));
                rows.extend(
                    settled
                        .into_iter()
                        .map(|(title, meta, pick)| Row::Pick(title, meta, pick)),
                );
            }
            if rows.is_empty() {
                rows.push(Row::Note("No thread holds every word.".into()));
            }
        }
        SearchState::Loading(_) => rows.push(Row::Note("Searching…".into())),
        SearchState::Error(message) => rows.push(Row::Note(message)),
        SearchState::Idle => {}
    }
    // Projects holding the query: rename or remove them from here.
    for project in w.source.projects() {
        for (label, rename) in [
            (format!("Rename project “{}”…", project.title), true),
            (format!("Remove project “{}”…", project.title), false),
        ] {
            if !label.to_lowercase().contains(&query) {
                continue;
            }
            let id = project.id.clone();
            rows.push(Row::Pick(
                label,
                None,
                if rename {
                    Pick::RenameProject(id)
                } else {
                    Pick::RemoveProject(id)
                },
            ));
        }
    }
    if rows.is_empty() {
        rows.extend(actions_and_threads(w, &query));
    }
    rows
}

/// The thread and action rows for an empty query: what the palette listed
/// before the search.
fn actions_and_threads(w: &Workspace, query: &str) -> Vec<Row> {
    let mut rows = vec![];
    if !w.creating {
        rows.extend(
            thread_actions::items(w, w.selected)
                .into_iter()
                .map(|item| Row::Pick(item.label().into(), None, Pick::Action(item))),
        );
    }
    if !w.source.archived().is_empty() {
        rows.push(Row::Pick(
            "Restore archived thread".into(),
            None,
            Pick::Archived,
        ));
    }
    use crate::experience::Panel;
    for panel in [
        Panel::Guide,
        Panel::Releases,
        Panel::Update,
        Panel::Doctor,
        Panel::Problems,
    ] {
        if panel != Panel::Problems || !w.source.records().is_empty() {
            rows.push((
                crate::experience_view::panel_title(panel).into(),
                Pick::Experience(panel),
            ));
        }
    }
    let threads = w.source.list_threads();
    rows.extend(w.source.order(false).into_iter().map(|id| {
        Row::Pick(
            threads[id].title.clone(),
            None,
            Pick::Thread(id, threads[id].status),
        )
    }));
    if query.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|row| match row {
            Row::Pick(title, _, _) => title.to_lowercase().contains(query),
            _ => true,
        })
        .collect()
}

fn pick(w: &mut Workspace, choice: &Pick, window: &mut Window, cx: &mut Context<Workspace>) {
    match choice {
        Pick::Action(item) => w.pick_thread_action(w.selected, *item, window, cx),
        Pick::Archived => w.open_thread_form(Form::Archived, window, cx),
        Pick::Experience(panel) => w.open_experience(panel, window, cx),
        Pick::Thread(id, _) | Pick::Found(id) => {
            w.palette_open = false;
            w.select(*id, cx);
            window.focus(&w.sidebar_focus, cx);
        }
        Pick::RenameProject(id) => {
            w.palette_open = false;
            w.pick_project_action(id, true, window, cx);
        }
        Pick::RemoveProject(id) => {
            w.palette_open = false;
            w.pick_project_action(id, false, window, cx);
        }
        Pick::StartResearch => {
            w.palette_open = false;
            w.answer_size(w.selected, cx);
        }
        Pick::SingleResearch => {
            w.palette_open = false;
            w.answer_single(w.selected, cx);
        }
    }
}

pub fn pick_first(
    w: &mut Workspace,
    query: &str,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    if let Some(row) = matches(w, query).into_iter().find_map(|row| match row {
        Row::Pick(_, _, pick) => Some(pick),
        _ => None,
    }) {
        pick(w, &row, window, cx);
    }
}

pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let rows = matches(w, w.search.read(cx).text());
    div()
        .absolute()
        .top(px(72.))
        .left(px(300.))
        .w(px(520.))
        .p(px(8.))
        .rounded(px(10.))
        .bg(color("raised"))
        .border_1()
        .border_color(color("rule"))
        .shadow(crate::theme::float_shadow())
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .p(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(ui::icon("search", "ink-2"))
                .child(div().flex_1().child(w.search.clone())),
        )
        .child(
            div()
                .id("palette-results")
                .max_h(px(460.))
                .overflow_y_scroll()
                .children(rows.into_iter().enumerate().map(|(at, row)| {
                    match row {
                        Row::Header(title) => div()
                            .px(px(8.))
                            .pt(px(6.))
                            .text_size(px(12.))
                            .text_color(color("ink-2"))
                            .child(title)
                            .into_any_element(),
                        Row::Note(text) => div()
                            .px(px(8.))
                            .py(px(6.))
                            .text_size(px(13.))
                            .text_color(color("ink-2"))
                            .child(text)
                            .into_any_element(),
                        Row::Pick(label, meta, choice) => {
                            let status = match &choice {
                                Pick::Thread(_, status) => Some(*status),
                                Pick::Found(id) => {
                                    w.source.list_threads().get(*id).map(|t| t.status)
                                }
                                _ => None,
                            };
                            div()
                                .id(("palette-item", at))
                                .control(label.clone())
                                .px(px(8.))
                                .py(px(6.))
                                .rounded(px(6.))
                                .flex()
                                .flex_col()
                                .gap(px(1.))
                                .text_size(px(13.))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .when_some(status, |s, status| s.child(ui::state(status)))
                                        .child(label),
                                )
                                .when_some(meta, |s, meta| {
                                    s.child(
                                        div()
                                            .pl(px(22.))
                                            .text_size(px(12.))
                                            .text_color(color("ink-2"))
                                            .child(meta),
                                    )
                                })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    pick(this, &choice, window, cx);
                                }))
                                .into_any_element()
                        }
                    }
                })),
        )
        .with_animation("palette-reveal", ui::expand(), |s, v| s.opacity(v))
}
