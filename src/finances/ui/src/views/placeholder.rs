//! A labelled placeholder for the pages whose data has not landed yet.

use crate::language::message;
use crate::shell::Page;
use crate::theme::{TypeScale, color};
use gpui::{prelude::*, *};

pub fn render(page: Page) -> impl IntoElement {
    div()
        .id(page.id())
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .child(
            div()
                .type_scale("display")
                .text_color(color("ink"))
                .child(message(page.nav_key())),
        )
        .child(
            div()
                .text_size(px(15.))
                .line_height(px(22.))
                .text_color(color("ink-2"))
                .child(message("placeholder.body")),
        )
}
