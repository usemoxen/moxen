//! The window's title bar: the app mark and name on the left, the current
//! date on the right.

use crate::format;
use crate::language::message;
use crate::shell::FinancesApp;
use crate::theme::{self, color};
use gpui::{prelude::*, *};

/// The Finances mark: a `tile` with the euro sign in `tile-ink`.
fn mark() -> Div {
    div()
        .size(px(22.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(theme::radius("radius-sm")))
        .bg(color("tile"))
        .font_family(theme::MONO)
        .font_weight(FontWeight::BOLD)
        .text_size(px(13.))
        .text_color(color("tile-ink"))
        .child("€")
}

pub fn render(app: &FinancesApp, _cx: &mut Context<FinancesApp>) -> impl IntoElement {
    div()
        .h(px(44.))
        .flex_shrink_0()
        .pl(px(16.))
        .pr(px(12.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_b_1()
        .border_color(color("rule"))
        .bg(color("ground"))
        // Room for the native traffic lights.
        .when(cfg!(target_os = "macos"), |s| {
            s.child(div().w(px(78.)).flex_shrink_0())
        })
        .child(mark())
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(18.))
                .font_weight(FontWeight::BOLD)
                .child(message("app.title")),
        )
        .child(div().flex_1())
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(color("ink-2"))
                .child(format::long_date(app.data.today())),
        )
}
