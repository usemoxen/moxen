use crate::{
    model::{Status, ThreadId},
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
    Experience(crate::experience::Panel),
}

fn matches(w: &Workspace, query: &str) -> Vec<(String, Pick)> {
    let query = query.to_lowercase();
    let mut rows = vec![];
    if !w.creating {
        rows.extend(
            thread_actions::items(w, w.selected)
                .into_iter()
                .map(|item| (item.label().to_string(), Pick::Action(item))),
        );
    }
    if !w.source.archived().is_empty() {
        rows.push(("Restore archived thread".into(), Pick::Archived));
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
        (
            threads[id].title.clone(),
            Pick::Thread(id, threads[id].status),
        )
    }));
    rows.into_iter()
        .filter(|(label, _)| label.to_lowercase().contains(&query))
        .collect()
}

fn pick(w: &mut Workspace, choice: &Pick, window: &mut Window, cx: &mut Context<Workspace>) {
    match *choice {
        Pick::Action(item) => w.pick_thread_action(w.selected, item, window, cx),
        Pick::Archived => w.open_thread_form(Form::Archived, window, cx),
        Pick::Experience(panel) => w.open_experience(panel, window, cx),
        Pick::Thread(id, _) => {
            w.palette_open = false;
            w.select(id, cx);
            window.focus(&w.sidebar_focus, cx);
        }
    }
}

pub fn pick_first(
    w: &mut Workspace,
    query: &str,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    if let Some((_, choice)) = matches(w, query).first() {
        pick(w, choice, window, cx);
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
                .children(rows.into_iter().enumerate().map(|(at, (label, choice))| {
                    div()
                        .id(("palette-item", at))
                        .control(label.clone())
                        .px(px(8.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(13.))
                        .when_some(
                            match &choice {
                                Pick::Thread(_, status) => Some(*status),
                                _ => None,
                            },
                            |s, status| s.child(ui::state(status)),
                        )
                        .child(label)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            pick(this, &choice, window, cx);
                        }))
                })),
        )
        .with_animation("palette-reveal", ui::expand(), |s, v| s.opacity(v))
}
