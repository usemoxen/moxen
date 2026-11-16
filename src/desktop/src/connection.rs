//! What the window shows while there are no threads to list: connecting to
//! the Moxen server, a server that cannot be reached, or an account with no
//! threads yet.

use crate::{
    model::Connection,
    theme::{self, color},
    ui::{self, Control},
    workspace::Workspace,
};
use gpui::{prelude::*, *};

pub fn render(w: &Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let (title, detail, retry): (&str, String, bool) = match w.source.connection() {
        Connection::Connecting => ("Connecting to the Moxen server…", String::new(), false),
        Connection::Failed(why) => (
            "The Moxen server is not available",
            format!("{why} Start it with moxen server start, then try again."),
            true,
        ),
        Connection::Live => (
            "No threads yet",
            "Threads you start from the Moxen CLI or TUI appear here. This window cannot start one yet."
                .into(),
            false,
        ),
    };
    div()
        .size_full()
        .bg(color("ground"))
        .font_family(theme::FONT)
        .text_size(px(theme::UI))
        .line_height(px(theme::UI_LINE))
        .text_color(color("ink"))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .child(
            div()
                .text_size(px(theme::BODY))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .when(!detail.is_empty(), |s| {
            s.child(
                div()
                    .max_w(px(420.))
                    .text_center()
                    .text_color(color("ink-2"))
                    .child(detail),
            )
        })
        .when(retry, |s| {
            s.child(
                div()
                    .id("retry")
                    .control("Try connecting again")
                    .h(px(30.))
                    .px(px(14.))
                    .flex()
                    .items_center()
                    .rounded(px(theme::px_token("radius", "radius-md")))
                    .border_1()
                    .border_color(color("rule"))
                    .bg(color("raised"))
                    .font_weight(FontWeight::MEDIUM)
                    .child("Retry")
                    .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
            )
        })
        .when(
            !retry && w.source.connection() == Connection::Connecting,
            |s| s.child(ui::icon("state-running", "live")),
        )
}
