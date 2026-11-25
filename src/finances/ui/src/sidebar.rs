//! The left navigation: grouped pages with an icon and a label, the selected
//! one on a `sunk` row.

use crate::kit;
use crate::language::message;
use crate::shell::{FinancesApp, Page};
use crate::theme::{self, color};
use gpui::{prelude::*, *};

const GROUPS: &[(&str, &[Page])] = &[
    ("group.overview", &[Page::Dashboard]),
    (
        "group.tracking",
        &[
            Page::Subscriptions,
            Page::Movements,
            Page::Projection,
            Page::Calendar,
            Page::Analysis,
        ],
    ),
    ("group.system", &[Page::Settings]),
];

pub fn render(app: &FinancesApp, cx: &mut Context<FinancesApp>) -> impl IntoElement {
    let mut nav = div()
        .id("nav")
        .debug_selector(|| "nav".into())
        .w(px(theme::SIDEBAR))
        .flex_shrink_0()
        .h_full()
        .border_r_1()
        .border_color(color("rule"))
        .bg(color("ground"))
        .flex()
        .flex_col()
        .px(px(8.))
        .py(px(8.));
    for (group_key, pages) in GROUPS {
        nav = nav.child(
            div()
                .px(px(10.))
                .pt(px(10.))
                .pb(px(4.))
                .child(kit::caps(message(group_key))),
        );
        for page in pages.iter().copied() {
            let selected = app.page == page;
            nav = nav.child(
                div()
                    .id((page.id(), 0usize))
                    .h(px(30.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(theme::radius("radius-sm")))
                    .cursor_pointer()
                    .text_size(px(13.5))
                    .line_height(px(17.5))
                    .text_color(color(if selected { "ink" } else { "ink-2" }))
                    .when(selected, |s| s.bg(color("sunk")))
                    .hover(|s| s.bg(color("sunk")))
                    .child(kit::icon(
                        page.icon(),
                        if selected { "ink" } else { "ink-2" },
                        15.,
                    ))
                    .child(message(page.nav_key()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.set_page(page, cx);
                    })),
            );
        }
    }
    nav
}
